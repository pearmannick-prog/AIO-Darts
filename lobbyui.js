// lobbyui.js - drawing the lobby, and turning clicks into lobby messages.
//
// Wiring only; lobbyclient.js owns the connection and the state. The lobby is
// shown INSIDE the Online Challenge tab, above the invite-code panel rather
// than instead of it, which is the whole shape of the feature: the lobby is the
// easy path when you are signed in and someone else is around, and codes remain
// the path that always works.

import {
  subscribeLobby, connectLobby, disconnectLobby, setStatus,
  challengePlayer, respondToChallenge, cancelChallenge,
  createRoom, joinRoom, leaveRoom, sendChat,
} from "./lobbyclient.js";
import { subscribe as subscribeAccount } from "./accountstore.js";
import { gameLabel } from "./medley.js";

const el = {
  panel: document.getElementById("lobby-panel"),
  count: document.getElementById("lobby-count"),
  looking: document.getElementById("lobby-looking"),
  challenges: document.getElementById("lobby-challenges"),
  filter: document.getElementById("lobby-filter"),
  scope: document.getElementById("lobby-scope"),
  players: document.getElementById("lobby-players"),
  rooms: document.getElementById("lobby-rooms"),
  roomName: document.getElementById("room-name"),
  roomCreate: document.getElementById("room-create-btn"),
  roomView: document.getElementById("lobby-room-view"),
  roomTitle: document.getElementById("room-title"),
  chatLog: document.getElementById("chat-log"),
  chatInput: document.getElementById("chat-input"),
  chatSend: document.getElementById("chat-send-btn"),
  roomLeave: document.getElementById("room-leave-btn"),
  message: document.getElementById("lobby-message"),
  // Read, never written, so the challenge carries the format the challenger
  // picked on the panel below rather than a second copy of that control.
  format: document.getElementById("online-format"),
};

let latest = null;

// The format currently selected on the Online Challenge panel. Sent with a
// challenge so the guest's app knows what it is agreeing to - the host still
// sends the authoritative match_config once connected, exactly as before.
function selectedLegs() {
  const value = el.format?.value;
  return value ? [{ preset: value }] : null;
}

function setMessage(text) {
  el.message.textContent = text || "";
  el.message.classList.toggle("error", Boolean(text));
}

function statusLabel(status) {
  switch (status) {
    case "looking": return "Looking for a match";
    case "in_match": return "In a match";
    case "away": return "Away";
    case "lobby": return "In the lobby";
    default: return "Online";
  }
}

function personRow(player) {
  const row = document.createElement("div");
  row.className = "person-row";

  const avatar = document.createElement("div");
  avatar.className = "board-avatar";
  avatar.textContent = (player.displayName || "?").slice(0, 2).toUpperCase();

  const middle = document.createElement("div");
  const name = document.createElement("div");
  name.className = "person-name";
  name.textContent = player.displayName + (player.isSelf ? " (you)" : "");
  if (player.isFriend && !player.isSelf) {
    const tag = document.createElement("span");
    tag.className = "board-you-tag";
    tag.textContent = "friend";
    name.appendChild(tag);
  }

  const sub = document.createElement("div");
  sub.className = "person-sub";
  const dot = document.createElement("span");
  dot.className = `status-dot status-${player.status}`;
  sub.append(dot, document.createTextNode(statusLabel(player.status)));
  middle.append(name, sub);

  const actions = document.createElement("div");
  actions.className = "person-actions";
  if (player.challengeable) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "btn-ink";
    button.textContent = "Challenge";
    button.addEventListener("click", () => {
      setMessage("");
      challengePlayer(player.userId, selectedLegs());
    });
    actions.appendChild(button);
  }

  row.append(avatar, middle, actions);
  return row;
}

function challengeCard(challenge, incoming) {
  const card = document.createElement("div");
  card.className = "challenge-card";

  const text = document.createElement("div");
  text.className = "challenge-text";
  text.innerHTML = incoming
    ? `<strong>${challenge.fromName}</strong> challenged you`
    : `Waiting for <strong>${challenge.toName}</strong>`;

  const actions = document.createElement("div");
  actions.className = "person-actions";

  if (incoming) {
    const accept = document.createElement("button");
    accept.type = "button";
    accept.className = "btn-ink";
    accept.textContent = "Accept";
    accept.addEventListener("click", () => respondToChallenge(challenge.id, true));

    const decline = document.createElement("button");
    decline.type = "button";
    decline.className = "btn-quiet";
    decline.textContent = "Decline";
    decline.addEventListener("click", () => respondToChallenge(challenge.id, false));

    actions.append(accept, decline);
  } else {
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "btn-quiet";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => cancelChallenge(challenge.id));
    actions.appendChild(cancel);
  }

  card.append(text, actions);
  return card;
}

function renderChat(messages) {
  el.chatLog.innerHTML = "";
  if (!messages.length) {
    const empty = document.createElement("div");
    empty.className = "chat-line chat-empty";
    empty.textContent = "Nothing said yet.";
    el.chatLog.appendChild(empty);
    return;
  }

  for (const message of messages) {
    const line = document.createElement("div");
    line.className = `chat-line${message.system ? " system" : ""}${message.whisper ? " whisper" : ""}`;

    if (message.system) {
      line.textContent = message.text;
    } else {
      const who = document.createElement("span");
      who.className = "chat-who";
      who.textContent = `${message.fromName}${message.whisper ? " (whisper)" : ""}: `;
      line.append(who, document.createTextNode(message.text));
    }
    el.chatLog.appendChild(line);
  }
  // Pinned to the newest line, which is the only one anyone is reading.
  el.chatLog.scrollTop = el.chatLog.scrollHeight;
}

function render(state) {
  latest = state;

  // The panel exists only when there is a working lobby to show. Everything
  // else on the tab - creating a code, joining one - works regardless, so a
  // missing lobby costs nothing rather than breaking the screen.
  const show = state.connection === "open";
  el.panel.classList.toggle("hidden", !show);
  if (!show) return;

  el.count.textContent = state.count === 1
    ? "1 player online"
    : `${state.count} players online`;

  setMessage(state.error);

  el.challenges.innerHTML = "";
  for (const challenge of state.incoming) el.challenges.appendChild(challengeCard(challenge, true));
  for (const challenge of state.outgoing) el.challenges.appendChild(challengeCard(challenge, false));

  const term = el.filter.value.trim().toLowerCase();
  const friendsOnly = el.scope.value === "friends";

  // Friends first, then anyone actively looking, then everyone else. The point
  // of a lobby is finding someone to play right now, so the people most likely
  // to say yes are the ones at the top.
  const rank = (p) => (p.isFriend ? 0 : 2) + (p.status === "looking" ? -1 : 0);
  const players = state.players
    .filter((p) => !friendsOnly || p.isFriend || p.isSelf)
    .filter((p) => !term || p.displayName.toLowerCase().includes(term))
    .sort((a, b) => rank(a) - rank(b) || a.displayName.localeCompare(b.displayName));

  el.players.innerHTML = "";
  if (!players.length) {
    const empty = document.createElement("div");
    empty.className = "people-empty";
    empty.textContent = state.count <= 1
      ? "Nobody else is here yet. Send someone a challenge code in the meantime."
      : "No players match that.";
    el.players.appendChild(empty);
  } else {
    for (const player of players) el.players.appendChild(personRow(player));
  }

  el.rooms.innerHTML = "";
  if (!state.rooms.length) {
    const empty = document.createElement("div");
    empty.className = "people-empty";
    empty.textContent = "No rooms open. Create one and people can join you.";
    el.rooms.appendChild(empty);
  } else {
    for (const room of state.rooms) {
      const row = document.createElement("div");
      row.className = "person-row";

      const avatar = document.createElement("div");
      avatar.className = "board-avatar";
      avatar.textContent = room.name.slice(0, 2).toUpperCase();

      const middle = document.createElement("div");
      const name = document.createElement("div");
      name.className = "person-name";
      name.textContent = room.name;
      const sub = document.createElement("div");
      sub.className = "person-sub";
      sub.textContent = `${room.members} in here`;
      middle.append(name, sub);

      const actions = document.createElement("div");
      actions.className = "person-actions";
      if (state.room?.id !== room.id) {
        const join = document.createElement("button");
        join.type = "button";
        join.className = "btn-quiet";
        join.textContent = "Join";
        join.addEventListener("click", () => joinRoom(room.id));
        actions.appendChild(join);
      }

      row.append(avatar, middle, actions);
      el.rooms.appendChild(row);
    }
  }

  el.roomView.classList.toggle("hidden", !state.room);
  if (state.room) {
    el.roomTitle.textContent = state.room.name;
    renderChat(state.messages);
  }
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------
el.looking.addEventListener("change", () => {
  setStatus(el.looking.checked ? "looking" : "lobby");
});

el.filter.addEventListener("input", () => latest && render(latest));
el.scope.addEventListener("change", () => latest && render(latest));

el.roomCreate.addEventListener("click", () => {
  const name = el.roomName.value.trim();
  if (!name) return;
  createRoom(name, el.format?.value || null);
  el.roomName.value = "";
});

el.roomLeave.addEventListener("click", () => leaveRoom());

function submitChat() {
  const text = el.chatInput.value.trim();
  if (!text) return;
  sendChat(text);
  el.chatInput.value = "";
}

el.chatSend.addEventListener("click", submitChat);
el.chatInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") submitChat();
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
subscribeLobby(render);

// The lobby follows the account: it needs a session to authenticate the socket,
// and it should not sit connected for someone who has signed out.
subscribeAccount(({ user, ready }) => {
  if (!ready) return;
  if (user) connectLobby();
  else disconnectLobby();
});
