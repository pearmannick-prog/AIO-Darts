// webrtc.js - wraps the WebRTC handshake behind a small, game-agnostic API.
//
// Flow: both browsers open a WebSocket to the signaling server and "join" the
// same room code. The server tells the first one it's "host" and the second
// "guest". The host creates the DataChannel and the SDP offer; the guest
// answers. ICE candidates are exchanged the same way. Once the DataChannel
// reports "open", gameplay messages flow directly between the two browsers -
// the signaling server is no longer involved.

// Fallback only. Normally the caller passes servers in, sourced from the
// deployment's /config.json - that's what allows a self-hosted TURN relay to
// be added later without touching this file.
//
// STUN vs TURN, briefly: STUN just tells a browser what its own public
// address looks like from outside, which is enough for the two peers to
// connect DIRECTLY in most cases. When a network refuses direct P2P outright
// (symmetric NAT, strict corporate firewalls - roughly 10-20% of
// connections), TURN relays the traffic through a server instead. Neither
// replaces the signaling step: something still has to carry the initial
// offer/answer exchange, which is what the WebSocket below is for.
const DEFAULT_ICE_SERVERS = [{ urls: ["stun:stun.l.google.com:19302"] }];

export class PeerLink {
  #ws;
  #pc;
  #channel;
  #role = null;

  onMessage = null; // (gameMessage: object) => void
  onStatusChange = null; // (status: string) => void

  constructor(signalingUrl, iceServers = DEFAULT_ICE_SERVERS) {
    this.signalingUrl = signalingUrl;
    this.iceServers = iceServers?.length ? iceServers : DEFAULT_ICE_SERVERS;
  }

  get role() {
    return this.#role;
  }

  // Generates a short challenge code and opens a room for someone to join.
  async createChallenge() {
    const code = Math.random().toString(36).slice(2, 8).toUpperCase();
    await this.#join(code);
    return code;
  }

  // Joins a challenge someone else created.
  async joinChallenge(code) {
    await this.#join(code.toUpperCase().trim());
  }

  sendGameMessage(obj) {
    if (this.#channel?.readyState === "open") {
      this.#channel.send(JSON.stringify(obj));
    } else {
      console.warn("Tried to send a game message before the peer link was open.");
    }
  }

  close() {
    this.#channel?.close();
    this.#pc?.close();
    this.#ws?.close();
  }

  async #join(code) {
    this.#setStatus("connecting-to-server");

    this.#ws = new WebSocket(this.signalingUrl);

    await new Promise((resolve, reject) => {
      this.#ws.addEventListener("open", () => resolve(), { once: true });
      this.#ws.addEventListener("error", () => reject(new Error("Couldn't reach the signaling server.")), { once: true });
    });

    this.#ws.send(JSON.stringify({ type: "join", code }));

    this.#pc = new RTCPeerConnection({ iceServers: this.iceServers });

    this.#pc.addEventListener("icecandidate", (event) => {
      if (event.candidate) {
        this.#sendSignal({ type: "ice", candidate: event.candidate });
      }
    });

    this.#pc.addEventListener("connectionstatechange", () => {
      const s = this.#pc.connectionState;
      if (s === "failed" || s === "closed") this.#setStatus("disconnected");
      if (s === "disconnected") this.#setStatus("disconnected");
    });

    this.#ws.addEventListener("message", (event) => this.#handleSignal(JSON.parse(event.data)));
  }

  async #handleSignal(msg) {
    switch (msg.type) {
      case "joined": {
        this.#role = msg.role;
        this.#setStatus(this.#role === "host" ? "waiting-for-opponent" : "joining");

        if (this.#role === "host") {
          this.#channel = this.#pc.createDataChannel("granboard");
          this.#wireChannel();
        } else {
          this.#pc.addEventListener("datachannel", (e) => {
            this.#channel = e.channel;
            this.#wireChannel();
          });
        }
        return;
      }

      case "peer-joined": {
        // Only the host initiates the offer.
        if (this.#role !== "host") return;
        const offer = await this.#pc.createOffer();
        await this.#pc.setLocalDescription(offer);
        this.#sendSignal({ type: "offer", sdp: offer });
        return;
      }

      case "offer": {
        await this.#pc.setRemoteDescription(msg.sdp);
        const answer = await this.#pc.createAnswer();
        await this.#pc.setLocalDescription(answer);
        this.#sendSignal({ type: "answer", sdp: answer });
        return;
      }

      case "answer": {
        await this.#pc.setRemoteDescription(msg.sdp);
        return;
      }

      case "ice": {
        try {
          await this.#pc.addIceCandidate(msg.candidate);
        } catch (err) {
          console.warn("Failed to add ICE candidate", err);
        }
        return;
      }

      case "peer-left": {
        this.#setStatus("disconnected");
        return;
      }

      case "room-full": {
        this.#setStatus("room-full");
        return;
      }
    }
  }

  #wireChannel() {
    this.#channel.addEventListener("open", () => this.#setStatus("connected"));
    this.#channel.addEventListener("close", () => this.#setStatus("disconnected"));
    this.#channel.addEventListener("message", (event) => {
      try {
        this.onMessage?.(JSON.parse(event.data));
      } catch (err) {
        console.warn("Received malformed game message", err);
      }
    });
  }

  #sendSignal(msg) {
    if (this.#ws?.readyState === WebSocket.OPEN) {
      this.#ws.send(JSON.stringify(msg));
    }
  }

  #setStatus(status) {
    this.onStatusChange?.(status);
  }
}
