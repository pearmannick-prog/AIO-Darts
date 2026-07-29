// server.js - Granboard online challenge signaling server.
//
// This server does NOT see any game data (scores, dart hits, etc). Its only
// job is to help two browsers find each other and exchange the handful of
// WebRTC handshake messages (offer/answer/ICE candidates) needed to open a
// direct peer-to-peer connection. Once that connection is up, all gameplay
// traffic flows directly between the two browsers and this server is no
// longer involved for that match.
//
// Rooms are just an in-memory Map keyed by a short challenge code, holding
// up to 2 sockets. Nothing is persisted - if this process restarts, any
// in-progress challenge codes are gone (players would just create a new one).

import { WebSocketServer } from "ws";

const PORT = process.env.PORT || 8080;
const rooms = new Map(); // code -> Set<WebSocket>

function send(ws, obj) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

const wss = new WebSocketServer({ port: PORT });

wss.on("connection", (ws) => {
  let joinedCode = null;

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return; // ignore malformed messages
    }

    if (msg.type === "join") {
      const code = String(msg.code || "").toUpperCase().slice(0, 12);
      if (!code) return;

      let room = rooms.get(code);
      if (!room) {
        room = new Set();
        rooms.set(code, room);
      }

      if (room.size >= 2) {
        send(ws, { type: "room-full" });
        return;
      }

      const isHost = room.size === 0;
      room.add(ws);
      joinedCode = code;

      send(ws, { type: "joined", role: isHost ? "host" : "guest" });

      if (!isHost) {
        for (const peer of room) {
          if (peer !== ws) send(peer, { type: "peer-joined" });
        }
      }
      return;
    }

    // Anything else (offer/answer/ice) just gets relayed to the other
    // socket in the same room - this server doesn't need to understand it.
    if (joinedCode) {
      const room = rooms.get(joinedCode);
      if (room) {
        for (const peer of room) {
          if (peer !== ws) send(peer, msg);
        }
      }
    }
  });

  ws.on("close", () => {
    if (!joinedCode) return;
    const room = rooms.get(joinedCode);
    if (!room) return;
    room.delete(ws);
    for (const peer of room) send(peer, { type: "peer-left" });
    if (room.size === 0) rooms.delete(joinedCode);
  });
});

console.log(`Granboard signaling server listening on port ${PORT}`);
