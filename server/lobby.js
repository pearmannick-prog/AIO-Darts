// lobby.js - presence, challenges, rooms and chat.
//
// This is a real change to a principle CLAUDE.md records as deliberate: the
// signaling server was stateless, relaying offer/answer/ICE between two sockets
// and forgetting the room. A lobby is state - who is here, who asked whom for a
// match, what was said - and that means the server can now be down in a way
// that matters. Worth being clear about what has and has not changed:
//
//   GAMEPLAY IS STILL PEER-TO-PEER. The lobby's entire job is to get two
//   players to agree on a match and hand them a challenge code. From that
//   moment it is out of the way, and the darts flow directly between the two
//   browsers over exactly the WebRTC path invite codes have always used. The
//   server still never sees a dart.
//
//   INVITE CODES STILL WORK, unchanged. They are the only way to play without
//   an account, the way to play someone who isn't in your lobby, and the
//   fallback when this half of the server is unavailable. An accepted challenge
//   simply mints one of those codes and tells both sides - which is why this
//   adds no second connection path to maintain.
//
// It lives on its own WebSocket path (/lobby) rather than sharing /signaling.
// The signaling relay is deliberately dumb and worth keeping that way; mixing a
// stateful protocol into it would mean the code that must never break in a
// match is the same code being changed to add a chat feature.

import { WebSocketServer } from "ws";
import { userForRequest } from "./auth.js";
import { createPresence, STATUS, isChallengeable } from "./presence.js";
import { friendIds, blockedIds, isBlocked } from "./social.js";

// An unanswered challenge expires. Without this the lobby fills with stale
// "pending" rows from people who closed the tab, and a player can be blocked
// from being challenged by someone who left ten minutes ago.
const CHALLENGE_TTL_MS = 60_000;

// Chat is capped rather than validated: length is the only thing a server can
// meaningfully enforce about a message, and a cap stops one client filling
// everyone's memory.
const MAX_CHAT = 300;
const ROOM_HISTORY = 40;

// Built with `noServer` and handed upgrades by server.js rather than attaching
// itself to the HTTP server.
//
// That is not a style choice. A WebSocketServer created with { server, path }
// installs its own 'upgrade' listener and DESTROYS any upgrade whose path it
// doesn't recognise - so two of them on one HTTP server means whichever
// attaches first kills the other's connections. The lobby socket failed with a
// bare "error" in the browser and nothing at all in the server log, because the
// signaling server was hanging up on it before this code ever ran.
//
// One upgrade listener that routes by path is the documented way to share a
// port, and it keeps the two sockets independent.
export function createLobby() {
  const presence = createPresence();
  const wss = new WebSocketServer({ noServer: true });

  // challengeId -> { id, from, to, legs, createdAt, timer }
  const challenges = new Map();
  // roomId -> { id, name, game, createdBy, members:Set<userId>, history:[] }
  const rooms = new Map();

  // Quick Match: userIds waiting to be paired with whoever is next, in arrival
  // order. A Set rather than an array because the commonest operations are
  // "add", "remove on disconnect" and "is this player waiting" - and Sets in JS
  // iterate in insertion order, so first-come-first-served comes free.
  //
  // Deliberately NOT skill-based. Pairing by rating needs ratings, ratings need
  // a lot more matches than this app has seen, and a queue that waits for a
  // good match is a queue nobody comes out of. Two people who both want a game
  // right now is the whole requirement.
  const queue = new Set();

  let nextId = 1;
  const newId = (prefix) => `${prefix}${nextId++}-${Math.random().toString(36).slice(2, 7)}`;

  // -------------------------------------------------------------------------
  // Sending
  // -------------------------------------------------------------------------
  function send(socket, message) {
    if (socket.readyState === socket.OPEN) {
      socket.send(JSON.stringify(message));
    }
  }

  function sendToUser(userId, message) {
    for (const socket of presence.socketsFor(userId)) send(socket, message);
  }

  function broadcast(message) {
    for (const socket of presence.everySocket()) send(socket, message);
  }

  // The lobby as one player sees it. Friends are marked rather than sorted here
  // - the client does the ordering, because it is a presentation choice and
  // this way the server sends one list rather than one per viewer.
  function lobbyFor(userId) {
    const friends = new Set(friendIds(userId));
    // Blocked in either direction means neither sees the other in the list. A
    // blocked player who is still visible and still challengeable is a block
    // that has not done anything.
    const hidden = new Set(blockedIds(userId));
    return presence.all().filter((entry) => !hidden.has(entry.userId)).map((entry) => ({
      userId: entry.userId,
      displayName: entry.displayName,
      hasAvatar: entry.hasAvatar,
      status: entry.status,
      preferredGame: entry.preferredGame,
      roomId: entry.roomId,
      isFriend: friends.has(entry.userId),
      isSelf: entry.userId === userId,
      challengeable: isChallengeable(entry.status) && entry.userId !== userId,
    }));
  }

  function pushLobby(userId) {
    sendToUser(userId, {
      type: "lobby",
      players: lobbyFor(userId),
      count: presence.count(),
      rooms: roomList(),
    });
  }

  // A presence change is interesting to everyone, but each viewer needs their
  // own copy (friend flags, self flag), so this fans out per user rather than
  // broadcasting one payload.
  function pushLobbyToAll() {
    for (const entry of presence.all()) pushLobby(entry.userId);
  }

  presence.onChange(() => pushLobbyToAll());

  // -------------------------------------------------------------------------
  // Rooms
  // -------------------------------------------------------------------------
  // Named places to hang around in - "501 Practice", "Cricket Only", "Blind
  // Draw Night". A room is not a match: it is a group of people who can see
  // each other, chat, and challenge whoever is in there with them. That makes
  // the lobby feel like a venue rather than a queue.
  function roomList() {
    return [...rooms.values()].map((room) => ({
      id: room.id,
      name: room.name,
      game: room.game,
      members: room.members.size,
    }));
  }

  // Takes a player out of whatever room they were in. Split from the presence
  // lookup on purpose: on disconnect the presence entry is already gone, so the
  // caller passes what it was - see the note on presence.detach.
  function releaseRoom(userId, roomId, displayName) {
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;

    room.members.delete(userId);
    // A room nobody is in stops existing, so the list shows places with people
    // in them rather than a graveyard of abandoned names.
    if (room.members.size === 0) {
      rooms.delete(room.id);
    } else {
      roomSystemMessage(room, `${displayName ?? "Someone"} left`);
    }

    // The room list is part of the lobby payload, and it only gets pushed on a
    // PRESENCE change. Without this, someone leaving a room left everyone else
    // looking at the old member count until something unrelated happened to
    // move - which read exactly like the membership never being released.
    pushLobbyToAll();
  }

  function leaveRoom(userId) {
    const entry = presence.get(userId);
    if (!entry?.roomId) return;
    const roomId = entry.roomId;
    presence.update(userId, { roomId: null });
    releaseRoom(userId, roomId, entry.displayName);
  }

  function roomSystemMessage(room, text) {
    const message = { type: "chat", roomId: room.id, system: true, text, at: Date.now() };
    room.history.push(message);
    if (room.history.length > ROOM_HISTORY) room.history.shift();
    for (const memberId of room.members) sendToUser(memberId, message);
  }

  // -------------------------------------------------------------------------
  // Challenges
  // -------------------------------------------------------------------------
  function expireChallenge(id, reason = "expired") {
    const challenge = challenges.get(id);
    if (!challenge) return;
    clearTimeout(challenge.timer);
    challenges.delete(id);
    sendToUser(challenge.from, { type: "challenge_ended", id, reason });
    sendToUser(challenge.to, { type: "challenge_ended", id, reason });
  }

  function pendingBetween(a, b) {
    for (const challenge of challenges.values()) {
      if ((challenge.from === a && challenge.to === b) ||
          (challenge.from === b && challenge.to === a)) {
        return challenge;
      }
    }
    return null;
  }

  // Pairs the two longest-waiting players. Called whenever someone joins the
  // queue, which is the only moment it can become satisfiable.
  function drainQueue() {
    while (queue.size >= 2) {
      const [first, second] = [...queue].slice(0, 2);
      queue.delete(first);
      queue.delete(second);

      // Someone may have gone offline or started a match between joining the
      // queue and being paired. Put the survivor back and stop.
      const a = presence.get(first);
      const b = presence.get(second);
      if (!a || !isChallengeable(a.status)) {
        if (b && isChallengeable(b.status)) queue.add(second);
        continue;
      }
      if (!b || !isChallengeable(b.status)) {
        queue.add(first);
        continue;
      }
      // Pairing two people who have blocked each other would hand the feature
      // the exact match it exists to prevent. Put both back and let the next
      // arrival break the tie.
      if (isBlocked(first, second)) {
        queue.add(first);
        queue.add(second);
        break;
      }

      startMatch(first, second, null);
    }
    pushQueueState();
  }

  function pushQueueState() {
    for (const userId of queue) {
      sendToUser(userId, { type: "queued", waiting: queue.size });
    }
  }

  function leaveQueue(userId) {
    if (queue.delete(userId)) {
      sendToUser(userId, { type: "queue_left" });
      pushQueueState();
    }
  }

  function summarise(challenge) {
    const from = presence.get(challenge.from);
    const to = presence.get(challenge.to);
    return {
      id: challenge.id,
      from: challenge.from,
      fromName: from?.displayName ?? "Someone",
      to: challenge.to,
      toName: to?.displayName ?? "Someone",
      legs: challenge.legs,
      expiresAt: challenge.createdAt + CHALLENGE_TTL_MS,
    };
  }

  // Accepting is where the lobby hands off. A code is minted here and sent to
  // both sides; the host then opens exactly the challenge room an invite code
  // would have opened, and the guest joins it. Everything after this message is
  // the existing peer-to-peer path, untouched.
  // The handoff, shared by accepting a challenge and by Quick Match. A code is
  // minted here and sent to both sides; the host then opens exactly the room an
  // invite code would have opened and the guest joins it. Everything after this
  // message is the existing peer-to-peer path, untouched.
  function startMatch(hostId, guestId, legs) {
    const code = Math.random().toString(36).slice(2, 8).toUpperCase();

    // Neither of them is in a queue or challengeable any more.
    leaveQueue(hostId);
    leaveQueue(guestId);
    presence.update(hostId, { status: STATUS.IN_MATCH });
    presence.update(guestId, { status: STATUS.IN_MATCH });

    const host = presence.get(hostId);
    const guest = presence.get(guestId);

    sendToUser(hostId, {
      type: "match_ready", code, role: "host", legs,
      opponent: { userId: guestId, displayName: guest?.displayName ?? "Opponent" },
    });
    sendToUser(guestId, {
      type: "match_ready", code, role: "guest", legs,
      opponent: { userId: hostId, displayName: host?.displayName ?? "Opponent" },
    });
  }

  function acceptChallenge(challenge) {
    clearTimeout(challenge.timer);
    challenges.delete(challenge.id);
    // The challenger hosts. Arbitrary but fixed, and it matters: host is seat 0
    // on both sides, so the two recordings of the match agree about who is who.
    startMatch(challenge.from, challenge.to, challenge.legs);
  }

  // -------------------------------------------------------------------------
  // Connections
  // -------------------------------------------------------------------------
  wss.on("connection", (socket, req) => {
    // The lobby is for people with accounts - it is a list of who is around,
    // and an anonymous entry in it would be neither identifiable nor
    // challengeable. Guests keep the invite-code path, which needs no account.
    let user = null;
    try {
      user = userForRequest(req);
    } catch {
      user = null;
    }

    if (!user) {
      send(socket, { type: "unauthorized" });
      socket.close();
      return;
    }

    const userId = user.id;
    presence.attach(user, socket);
    pushLobby(userId);

    socket.on("message", (raw) => {
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return; // malformed, ignore
      }

      try {
        handle(userId, socket, message);
      } catch (err) {
        console.warn(`Lobby message ${message?.type} failed:`, err.message);
        send(socket, { type: "error", message: "That didn't work." });
      }
    });

    socket.on("close", () => {
      const { wasLast, entry } = presence.detach(userId, socket);
      // Another tab or device is still connected - they have not left.
      if (!wasLast) return;

      // Anything they had outstanding goes with them, so nobody is left
      // looking at a challenge from someone who has gone.
      for (const challenge of [...challenges.values()]) {
        if (challenge.from === userId || challenge.to === userId) {
          expireChallenge(challenge.id, "left");
        }
      }
      // Uses the entry captured during detach, because presence.get() would
      // now answer null and the room would keep them as a member forever.
      releaseRoom(userId, entry?.roomId, entry?.displayName);
      queue.delete(userId);
    });
  });

  // -------------------------------------------------------------------------
  // The protocol
  // -------------------------------------------------------------------------
  function handle(userId, socket, message) {
    switch (message.type) {
      case "status": {
        const status = Object.values(STATUS).includes(message.status)
          ? message.status
          : STATUS.LOBBY;
        presence.update(userId, {
          status,
          preferredGame: message.preferredGame ?? presence.get(userId)?.preferredGame ?? null,
        });
        return;
      }

      case "challenge": {
        const targetId = Number(message.toUserId);
        const target = presence.get(targetId);
        if (!target) return send(socket, { type: "error", message: "They have gone offline." });
        if (targetId === userId) return;

        if (isBlocked(userId, targetId)) {
          // Deliberately the same wording as an offline player. Confirming a
          // block reliably produces a second account, which is the outcome the
          // feature exists to prevent.
          return send(socket, { type: "error", message: "They have gone offline." });
        }
        if (!isChallengeable(target.status)) {
          return send(socket, { type: "error", message: `${target.displayName} is already playing.` });
        }
        const me = presence.get(userId);
        if (!isChallengeable(me.status)) {
          return send(socket, { type: "error", message: "Finish your match first." });
        }

        // If THEY have already challenged US, this is an acceptance. Two people
        // pressing the same button at the same time should start a match, not
        // deadlock into two pending requests.
        const existing = pendingBetween(userId, targetId);
        if (existing) {
          if (existing.from === targetId) return acceptChallenge(existing);
          return send(socket, { type: "error", message: "You have already asked." });
        }

        const challenge = {
          id: newId("c"),
          from: userId,
          to: targetId,
          legs: Array.isArray(message.legs) && message.legs.length ? message.legs : null,
          createdAt: Date.now(),
        };
        challenge.timer = setTimeout(() => expireChallenge(challenge.id), CHALLENGE_TTL_MS);
        challenges.set(challenge.id, challenge);

        const summary = summarise(challenge);
        sendToUser(targetId, { type: "challenge_received", challenge: summary });
        sendToUser(userId, { type: "challenge_sent", challenge: summary });
        return;
      }

      case "challenge_respond": {
        const challenge = challenges.get(message.id);
        if (!challenge || challenge.to !== userId) return;
        if (message.accept) return acceptChallenge(challenge);
        return expireChallenge(challenge.id, "declined");
      }

      case "challenge_cancel": {
        const challenge = challenges.get(message.id);
        if (!challenge || challenge.from !== userId) return;
        return expireChallenge(challenge.id, "cancelled");
      }

      // Told to us by the client when a match ends, so the lobby stops showing
      // someone as playing. Not authoritative - the darts are peer-to-peer and
      // the server genuinely does not know - which is why leaving a match also
      // resolves itself on disconnect.
      case "match_over": {
        presence.update(userId, { status: STATUS.LOBBY });
        return;
      }

      case "queue": {
        const me = presence.get(userId);
        if (!isChallengeable(me?.status)) {
          return send(socket, { type: "error", message: "Finish your match first." });
        }
        queue.add(userId);
        presence.update(userId, { status: STATUS.LOOKING });
        send(socket, { type: "queued", waiting: queue.size });
        drainQueue();
        return;
      }

      case "queue_leave": {
        leaveQueue(userId);
        presence.update(userId, { status: STATUS.LOBBY });
        return;
      }

      case "create_room": {
        const name = String(message.name ?? "").trim().slice(0, 40);
        if (name.length < 2) return send(socket, { type: "error", message: "Give the room a name." });

        leaveRoom(userId);
        const room = {
          id: newId("r"),
          name,
          game: message.game || null,
          createdBy: userId,
          members: new Set([userId]),
          history: [],
        };
        rooms.set(room.id, room);
        // presence.update pushes the lobby, which is what puts the new room in
        // everyone's list.
        presence.update(userId, { roomId: room.id });
        send(socket, { type: "room_joined", room: { id: room.id, name: room.name, game: room.game }, history: [] });
        return;
      }

      case "join_room": {
        const room = rooms.get(message.roomId);
        if (!room) return send(socket, { type: "error", message: "That room has closed." });

        leaveRoom(userId);
        room.members.add(userId);
        presence.update(userId, { roomId: room.id });
        send(socket, {
          type: "room_joined",
          room: { id: room.id, name: room.name, game: room.game },
          history: room.history,
        });
        roomSystemMessage(room, `${presence.get(userId)?.displayName} joined`);
        return;
      }

      case "leave_room": {
        leaveRoom(userId);
        send(socket, { type: "room_left" });
        return;
      }

      case "chat": {
        const text = String(message.text ?? "").trim().slice(0, MAX_CHAT);
        if (!text) return;
        const me = presence.get(userId);

        // A whisper goes to one person; anything else goes to the room the
        // sender is in. There is deliberately no global channel - a room you
        // chose to enter is a much easier thing to moderate than one everybody
        // is in by default.
        if (message.toUserId) {
          const target = Number(message.toUserId);
          if (!presence.isOnline(target) || isBlocked(userId, target)) {
            return send(socket, { type: "error", message: "They have gone offline." });
          }
          const payload = {
            type: "chat", whisper: true, from: userId, fromName: me.displayName,
            to: target, text, at: Date.now(),
          };
          sendToUser(target, payload);
          send(socket, payload);
          return;
        }

        const room = rooms.get(me?.roomId);
        if (!room) return send(socket, { type: "error", message: "Join a room to chat." });

        const payload = {
          type: "chat", roomId: room.id, from: userId, fromName: me.displayName,
          text, at: Date.now(),
        };
        room.history.push(payload);
        if (room.history.length > ROOM_HISTORY) room.history.shift();

        // Everyone in the room except those blocked in either direction. The
        // history still holds it, so a block does not rewrite what was said -
        // it only decides who has it delivered.
        const hidden = new Set(blockedIds(userId));
        for (const memberId of room.members) {
          if (hidden.has(memberId)) continue;
          sendToUser(memberId, payload);
        }
        return;
      }

      default:
        return;
    }
  }

  // Same reason the signaling socket pings: proxies drop connections they
  // decide are idle, and a lobby socket is idle by nature - it sits quiet
  // between challenges, which is exactly when it must not be dropped.
  const heartbeat = setInterval(() => {
    for (const client of wss.clients) {
      if (client.readyState === client.OPEN) client.ping();
    }
  }, 30_000);
  wss.on("close", () => clearInterval(heartbeat));

  return {
    // Called by server.js's upgrade router when the path is ours.
    handleUpgrade(req, socket, head) {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
    },
    count: () => presence.count(),
    close: () => {
      clearInterval(heartbeat);
      wss.close();
    },
  };
}
