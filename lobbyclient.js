// lobbyclient.js - the browser's connection to the lobby.
//
// State and transport only; lobbyui.js draws it and online.js reacts to a match
// starting. Same split as accountstore/accountui, for the same reason.
//
// The one thing worth understanding here: THIS IS NOT HOW DARTS TRAVEL. The
// lobby socket carries presence, challenges and chat. When a challenge is
// accepted the server sends a `match_ready` with a challenge code, and from
// that point the match runs over the existing peer-to-peer WebRTC path exactly
// as an invite code always has. If this socket dropped mid-match, the match
// would carry on.
//
// It is also entirely optional. No lobby - because the server has accounts
// switched off, because you are signed out, or because the connection failed -
// means the Online Challenge tab works exactly as it did before, with codes.

const listeners = new Set();
const matchReadyHandlers = new Set();

const state = {
  // "off" until something tries to connect, then connecting/open/closed. The UI
  // distinguishes "we haven't tried" from "we tried and it isn't there",
  // because only the second is worth telling anyone about.
  connection: "off",
  players: [],
  count: 0,
  rooms: [],
  room: null,        // the room this player is in, if any
  messages: [],      // chat, newest last
  incoming: [],      // challenges received
  outgoing: [],      // challenges sent
  error: null,
};

let socket = null;
let reconnectTimer = null;
let attempts = 0;
let wanted = false;

export function getLobbyState() {
  return { ...state, players: [...state.players], messages: [...state.messages] };
}

export function subscribeLobby(fn) {
  listeners.add(fn);
  fn(getLobbyState());
  return () => listeners.delete(fn);
}

function notify() {
  const snapshot = getLobbyState();
  for (const fn of listeners) fn(snapshot);
}

// online.js registers here rather than lobbyclient importing it, so the lobby
// knows nothing about how a match is actually played.
export function onMatchReady(fn) {
  matchReadyHandlers.add(fn);
  return () => matchReadyHandlers.delete(fn);
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------
// Derived from window.location, like the signaling socket - so an https page
// gets a wss socket automatically and there is nothing for anyone to configure.
async function lobbyUrl() {
  let path = "/lobby";
  try {
    const config = await fetch("./config.json", { cache: "no-store" }).then((r) => r.json());
    if (config.lobbyPath) path = config.lobbyPath;
  } catch {
    // Same-origin default is right for every normal deployment.
  }
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${location.host}${path}`;
}

export async function connectLobby() {
  wanted = true;
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return;
  }

  state.connection = "connecting";
  state.error = null;
  notify();

  let url;
  try {
    url = await lobbyUrl();
  } catch {
    state.connection = "closed";
    notify();
    return;
  }

  socket = new WebSocket(url);

  socket.addEventListener("open", () => {
    attempts = 0;
    state.connection = "open";
    state.error = null;
    notify();
  });

  socket.addEventListener("message", (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    handle(message);
  });

  socket.addEventListener("close", () => {
    socket = null;
    state.connection = "closed";
    state.players = [];
    state.count = 0;
    notify();
    if (wanted) scheduleReconnect();
  });

  socket.addEventListener("error", () => {
    // The close handler does the work; this only stops an unhandled error.
  });
}

export function disconnectLobby() {
  wanted = false;
  clearTimeout(reconnectTimer);
  if (socket) {
    socket.close();
    socket = null;
  }
  state.connection = "off";
  state.players = [];
  state.room = null;
  state.messages = [];
  state.incoming = [];
  state.outgoing = [];
  notify();
}

// Backs off rather than hammering: a server that is down stays down for a
// while, and a lobby is not worth a request per second to rejoin.
function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  attempts += 1;
  const delay = Math.min(30_000, 1000 * 2 ** Math.min(attempts, 5));
  reconnectTimer = setTimeout(() => {
    if (wanted) connectLobby();
  }, delay);
}

function send(message) {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Incoming messages
// ---------------------------------------------------------------------------
function handle(message) {
  switch (message.type) {
    case "unauthorized":
      // Signed out, or the session expired. Not an error worth shouting about -
      // the invite-code path still works.
      wanted = false;
      state.connection = "unauthorized";
      break;

    case "lobby":
      state.players = message.players ?? [];
      state.count = message.count ?? 0;
      state.rooms = message.rooms ?? [];
      break;

    case "challenge_received":
      state.incoming = [...state.incoming.filter((c) => c.id !== message.challenge.id), message.challenge];
      break;

    case "challenge_sent":
      state.outgoing = [...state.outgoing.filter((c) => c.id !== message.challenge.id), message.challenge];
      break;

    case "challenge_ended":
      state.incoming = state.incoming.filter((c) => c.id !== message.id);
      state.outgoing = state.outgoing.filter((c) => c.id !== message.id);
      break;

    case "match_ready":
      // Both challenges are resolved by this - whichever side we were on.
      state.incoming = [];
      state.outgoing = [];
      notify();
      for (const fn of matchReadyHandlers) {
        try {
          fn(message);
        } catch (err) {
          console.warn("Couldn't start the match from the lobby:", err.message);
        }
      }
      return;

    case "room_joined":
      state.room = message.room;
      state.messages = message.history ?? [];
      break;

    case "room_left":
      state.room = null;
      state.messages = [];
      break;

    case "chat":
      state.messages = [...state.messages.slice(-59), message];
      break;

    case "error":
      state.error = message.message;
      break;

    default:
      return;
  }
  notify();
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------
export function setStatus(status, preferredGame) {
  send({ type: "status", status, preferredGame });
}

export function challengePlayer(toUserId, legs) {
  state.error = null;
  send({ type: "challenge", toUserId, legs });
}

export function respondToChallenge(id, accept) {
  send({ type: "challenge_respond", id, accept });
}

export function cancelChallenge(id) {
  send({ type: "challenge_cancel", id });
}

// Told to the lobby when a match ends so it stops showing you as playing. The
// server treats it as a hint, not as truth - it cannot see the darts, and a
// disconnect resolves the same state anyway.
export function reportMatchOver() {
  send({ type: "match_over" });
}

export function createRoom(name, game) {
  send({ type: "create_room", name, game });
}

export function joinRoom(roomId) {
  send({ type: "join_room", roomId });
}

export function leaveRoom() {
  send({ type: "leave_room" });
}

export function sendChat(text, toUserId = null) {
  send({ type: "chat", text, toUserId });
}
