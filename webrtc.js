// webrtc.js - wraps the WebRTC handshake behind a small, game-agnostic API.
//
// Flow: both browsers open a WebSocket to the signaling server and "join" the
// same room code. The server tells the first one it's "host" and the second
// "guest". The host creates the DataChannel and the SDP offer; the guest
// answers. ICE candidates are exchanged the same way. Once the DataChannel
// reports "open", gameplay messages flow directly between the two browsers -
// the signaling server is no longer involved.
//
// Camera/mic ("see your opponent throw") rides the SAME peer connection. The
// audio and video m-lines are negotiated UP FRONT, during the one and only
// offer/answer exchange, with no track attached to them yet - then
// startMedia() fills them in later with replaceTrack().
//
// That is the whole reason there is no renegotiation code in this file, and
// it's worth spelling out because the obvious implementation is the other
// way round. Adding a track to a live connection fires "negotiationneeded"
// and needs a second offer/answer round. Since either player can switch their
// camera on at any moment, both can fire it at once - "glare" - and untangling
// that correctly means implementing the full perfect-negotiation dance
// (polite/impolite peer, rollback, ignoring incoming offers mid-flight). That
// is a lot of subtle state for a feature whose whole job is showing a face.
//
// replaceTrack(), by contrast, is defined to NOT require renegotiation. Both
// sides start with dormant sendrecv transceivers, so turning a camera on is a
// purely local operation that can happen at any time, in any order, on both
// sides simultaneously, and cannot desync the connection.
//
// The cost, accepted deliberately: every online match negotiates audio and
// video m-lines even when nobody ever turns a camera on. That is a slightly
// longer SDP once per match and nothing else - no media flows, no ports are
// opened (everything is bundled onto the DataChannel's transport), and no
// permission prompt appears, because getUserMedia is never called until a
// player asks for it.

// Modest by default: this is a webcam pointed at someone standing at a board,
// displayed in a tile a couple of hundred pixels wide. Asking for 1080p would
// only spend bandwidth - and on a TURN relay, someone's money - on detail the
// tile cannot show.
const DEFAULT_MEDIA_CONSTRAINTS = {
  audio: { echoCancellation: true, noiseSuppression: true },
  video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 24 } },
};

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

  // The dormant m-lines described above, filled in by startMedia().
  #transceivers = { audio: null, video: null };
  #localStream = null;
  // Built up as tracks arrive. Audio and video land in separate "track"
  // events, so this is created once and added to, rather than replaced -
  // otherwise the <video> element would be re-pointed halfway through and
  // drop whichever track arrived first.
  #remoteStream = null;

  onMessage = null; // (gameMessage: object) => void
  onStatusChange = null; // (status: string) => void
  onRemoteStream = null; // (stream: MediaStream) => void
  onRemoteMediaChange = null; // ({ audio: bool, video: bool }) => void

  constructor(signalingUrl, iceServers = DEFAULT_ICE_SERVERS) {
    this.signalingUrl = signalingUrl;
    this.iceServers = iceServers?.length ? iceServers : DEFAULT_ICE_SERVERS;
  }

  get role() {
    return this.#role;
  }

  get localStream() {
    return this.#localStream;
  }

  get hasLocalMedia() {
    return !!this.#localStream;
  }

  // Turns this player's camera and/or mic on. Safe to call before the peer
  // connection has finished negotiating - the tracks are held and attached as
  // soon as the transceivers exist (see #attachLocalTracks).
  //
  // Throws if the player denies permission or there's no device; the caller is
  // expected to surface that, since a silently dead camera button is worse
  // than an error.
  async startMedia({ audio = true, video = true } = {}) {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error(
        window.isSecureContext
          ? "This browser doesn't support camera/mic access."
          : "Camera and mic need a secure context - this page is on plain HTTP."
      );
    }

    const constraints = {
      audio: audio ? DEFAULT_MEDIA_CONSTRAINTS.audio : false,
      video: video ? DEFAULT_MEDIA_CONSTRAINTS.video : false,
    };
    if (!constraints.audio && !constraints.video) return null;

    const stream = await navigator.mediaDevices.getUserMedia(constraints);

    // Calling startMedia twice (e.g. mic first, then camera) must not leave
    // the first stream's tracks running and orphaned.
    if (this.#localStream) {
      for (const track of this.#localStream.getTracks()) {
        if (stream.getTracks().some((t) => t.kind === track.kind)) {
          track.stop();
          this.#localStream.removeTrack(track);
        }
      }
      for (const track of stream.getTracks()) this.#localStream.addTrack(track);
    } else {
      this.#localStream = stream;
    }

    this.#attachLocalTracks();
    return this.#localStream;
  }

  // Turns everything off and releases the devices, so the browser's
  // camera-in-use indicator actually goes out.
  stopMedia() {
    for (const kind of ["audio", "video"]) {
      this.#transceivers[kind]?.sender?.replaceTrack(null).catch(() => {});
    }
    this.#localStream?.getTracks().forEach((track) => track.stop());
    this.#localStream = null;
    this.#announceMediaState();
  }

  // Mute / camera-off. Deliberately toggles `enabled` rather than dropping the
  // track: `enabled = false` sends silence and black frames (which cost almost
  // nothing, as they compress to nearly nothing) and flips back instantly,
  // whereas replaceTrack(null) would freeze the peer's last frame on screen
  // and make "camera off" look identical to "connection died".
  setMediaEnabled({ audio, video }) {
    if (!this.#localStream) return;
    if (audio !== undefined) {
      this.#localStream.getAudioTracks().forEach((t) => { t.enabled = audio; });
    }
    if (video !== undefined) {
      this.#localStream.getVideoTracks().forEach((t) => { t.enabled = video; });
    }
    this.#announceMediaState();
  }

  // Tells the peer what we're sending, so their tile can say "camera off"
  // instead of showing a black rectangle. Goes over the DataChannel rather
  // than the signaling socket because it's a gameplay-time concern and the
  // channel is already ordered and open.
  #announceMediaState() {
    const state = {
      audio: !!this.#localStream?.getAudioTracks().some((t) => t.enabled),
      video: !!this.#localStream?.getVideoTracks().some((t) => t.enabled),
    };
    if (this.#channel?.readyState === "open") {
      this.#channel.send(JSON.stringify({ type: "media_state", ...state }));
    }
  }

  // Idempotent, and called from both directions - startMedia() may run before
  // or after the transceivers are created, and this way neither order needs a
  // special case.
  #attachLocalTracks() {
    if (!this.#localStream) return;
    for (const kind of ["audio", "video"]) {
      const sender = this.#transceivers[kind]?.sender;
      if (!sender) continue;
      const track = this.#localStream.getTracks().find((t) => t.kind === kind) || null;
      if (track && sender.track !== track) {
        sender.replaceTrack(track).catch((err) => console.warn(`Couldn't send ${kind}`, err));
      }
    }
    this.#announceMediaState();
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
    // Before anything else: closing the peer connection does NOT release the
    // camera. Skip this and the webcam light stays on after the match ends.
    this.#localStream?.getTracks().forEach((track) => track.stop());
    this.#localStream = null;
    this.#remoteStream = null;
    this.#transceivers = { audio: null, video: null };

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

    this.#pc.addEventListener("track", (event) => {
      if (!this.#remoteStream) this.#remoteStream = new MediaStream();
      this.#remoteStream.addTrack(event.track);
      // Fired on every arriving track; the caller just re-points the same
      // <video> at the same stream, which is a no-op after the first time.
      this.onRemoteStream?.(this.#remoteStream);
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
          // Created before the offer, empty. See the note at the top of the
          // file: reserving the m-lines now is what lets a camera be switched
          // on later without a second offer/answer round.
          this.#transceivers.audio = this.#pc.addTransceiver("audio", { direction: "sendrecv" });
          this.#transceivers.video = this.#pc.addTransceiver("video", { direction: "sendrecv" });
          this.#attachLocalTracks();
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

        // setRemoteDescription just created transceivers to match the host's
        // audio/video m-lines, but they default to "recvonly" - the guest
        // would be able to see the host and never be seen back. Flipping them
        // to sendrecv BEFORE createAnswer bakes two-way media into the
        // original answer, which is the whole point: no renegotiation later.
        for (const t of this.#pc.getTransceivers()) {
          const kind = t.receiver?.track?.kind;
          if (kind === "audio" || kind === "video") {
            t.direction = "sendrecv";
            this.#transceivers[kind] = t;
          }
        }
        this.#attachLocalTracks();

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
    this.#channel.addEventListener("open", () => {
      this.#setStatus("connected");
      // A player who switched their camera on while still on the "waiting for
      // opponent" screen already sent a media_state into a closed channel,
      // where it was dropped. Re-announce now that there's someone to hear it.
      this.#announceMediaState();
    });
    this.#channel.addEventListener("close", () => this.#setStatus("disconnected"));
    this.#channel.addEventListener("message", (event) => {
      try {
        const msg = JSON.parse(event.data);
        // Mute/camera state is a transport concern, not a game event - it's
        // handled here so the game controller never has to know the peer
        // protocol carries anything other than darts.
        if (msg.type === "media_state") {
          this.onRemoteMediaChange?.({ audio: !!msg.audio, video: !!msg.video });
          return;
        }
        this.onMessage?.(msg);
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
