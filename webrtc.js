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

// deviceId wins over facingMode when both are given: a specific camera the
// player picked is a stronger statement of intent than "front-ish".
//
// `deviceId` is exact but `facingMode` is only a preference, on purpose. An
// exact facingMode throws OverconstrainedError on any device that doesn't have
// a camera facing that way - which includes most desktops, where asking for
// "environment" would fail outright rather than just handing back the only
// webcam there is.
function videoConstraints({ facingMode, deviceId } = {}) {
  const video = { ...DEFAULT_MEDIA_CONSTRAINTS.video };
  if (deviceId) video.deviceId = { exact: deviceId };
  else if (facingMode) video.facingMode = facingMode;
  return video;
}

function audioConstraints({ deviceId } = {}) {
  const audio = { ...DEFAULT_MEDIA_CONSTRAINTS.audio };
  if (deviceId) audio.deviceId = { exact: deviceId };
  return audio;
}

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
  // Camera-health watchdog state - see #watchLocalVideo.
  #muteTimer = null;
  #recovering = false;
  #switching = false;
  // Built up as tracks arrive. Audio and video land in separate "track"
  // events, so this is created once and added to, rather than replaced -
  // otherwise the <video> element would be re-pointed halfway through and
  // drop whichever track arrived first.
  #remoteStream = null;

  onMessage = null; // (gameMessage: object) => void
  onStatusChange = null; // (status: string) => void
  onRemoteStream = null; // (stream: MediaStream) => void
  onRemoteMediaChange = null; // ({ audio: bool, video: bool }) => void
  onCameraRecovering = null; // (recovering: bool) => void

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
  async startMedia({ audio = true, video = true, facingMode, cameraId, micId } = {}) {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error(
        window.isSecureContext
          ? "This browser doesn't support camera/mic access."
          : "Camera and mic need a secure context - this page is on plain HTTP."
      );
    }

    const constraints = {
      audio: audio ? audioConstraints({ deviceId: micId }) : false,
      video: video ? videoConstraints({ facingMode, deviceId: cameraId }) : false,
    };
    if (!constraints.audio && !constraints.video) return null;

    // Device IDs handed in from saved preferences go stale: browsers reissue
    // them when site permissions are reset, and hardware gets unplugged. They
    // are requested as `exact`, so a dead ID throws rather than degrading, and
    // a remembered camera or mic that no longer exists would break the Start
    // button outright. Retry once with no device preferences at all.
    //
    // Coarser than the pre-match check's recovery, which works out WHICH
    // preference died and keeps the other. That precision is worth having when
    // someone is deliberately setting devices up; here, mid-match, getting a
    // working camera and mic on screen matters more than honouring a
    // preference, and the check is where they'd go to fix it properly.
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (err) {
      const hadPreference = cameraId || micId;
      const stale = err.name === "OverconstrainedError" || err.name === "NotFoundError";
      if (!hadPreference || !stale) throw err;
      if (constraints.audio) constraints.audio = audioConstraints();
      if (constraints.video) constraints.video = videoConstraints({ facingMode });
      stream = await navigator.mediaDevices.getUserMedia(constraints);
    }

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

    this.#watchLocalVideo(this.#localStream.getVideoTracks()[0]);
    this.#attachLocalTracks();
    return this.#localStream;
  }

  // What the camera in use reports about itself, or null if there isn't one.
  // facingMode is absent on most desktop webcams - they genuinely don't know
  // which way they point - so callers must treat null as "unknown", not "front".
  get activeCamera() {
    const track = this.#localStream?.getVideoTracks()[0];
    if (!track) return null;
    const settings = track.getSettings();
    return {
      deviceId: settings.deviceId || null,
      facingMode: settings.facingMode || null,
      label: track.label || "",
    };
  }

  // Cameras this browser will admit to having.
  //
  // Worth knowing: before permission is granted, browsers return entries with
  // blank labels, and some return only one entry however many cameras exist -
  // so calling this before startMedia() will under-report. The UI only calls
  // it after the camera is already running, which is when the list is honest.
  async listCameras() {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((d) => d.kind === "videoinput");
  }

  // Swaps the camera without touching the mic, the connection, or the SDP -
  // the new track goes into the SAME sender via replaceTrack(), the identical
  // no-renegotiation path startMedia() uses. Mute state carries across.
  //
  // Note the ORDER: the old track is stopped BEFORE the new one is requested.
  // That looks backwards - it would be safer to get the new camera working and
  // only then let go of the old one - but a lot of Android hardware refuses to
  // open the back camera while the front one is still held, failing with
  // NotReadableError. Stopping first is the only order that works there.
  //
  // The cost of that order is that a failed request leaves you with no camera
  // at all, so this puts the previous one back before rethrowing.
  async switchCamera({ deviceId, facingMode } = {}) {
    if (!this.#localStream) throw new Error("The camera isn't on yet.");

    // Two camera opens racing each other is exactly the contention that
    // produces NotReadableError, and there are now two callers that can start
    // one: the player pressing Switch camera, and the stall watchdog firing on
    // its own. Without this guard they fight over the same device.
    if (this.#switching) return this.activeCamera;
    this.#switching = true;

    const old = this.#localStream.getVideoTracks()[0];
    const wasEnabled = old ? old.enabled : true;
    const previousId = old ? old.getSettings().deviceId : null;

    if (old) {
      old.stop();
      this.#localStream.removeTrack(old);
    }

    try {
      await this.#addVideoTrack({ deviceId, facingMode }, wasEnabled);
    } catch (err) {
      // Only worth restoring if there's still something to restore into -
      // #localStream going away mid-flight means the match is over, and
      // reopening a camera for it would leak the handle all over again.
      if (previousId && this.#localStream) {
        // Best effort. If even this fails there's nothing sensible left to do,
        // and the original error is the one worth reporting either way.
        try {
          await this.#addVideoTrack({ deviceId: previousId }, wasEnabled);
        } catch { /* fall through to the rethrow */ }
      }
      throw err;
    } finally {
      this.#switching = false;
    }

    return this.activeCamera;
  }

  async #addVideoTrack(spec, enabled = true) {
    const stream = await navigator.mediaDevices.getUserMedia({ video: videoConstraints(spec) });
    const track = stream.getVideoTracks()[0];

    // getUserMedia is slow enough that the world changes underneath it. The
    // match can end, the player can press Stop, or the phone can lock - any of
    // which clears #localStream while this is still waiting on the camera.
    //
    // Adding to it then threw "Cannot read properties of null (reading
    // 'addTrack')", and far worse, left this freshly opened camera running
    // with nothing holding a reference that could ever stop it. That leaked
    // handle is why ONE camera then reports "busy" forever while every other
    // camera on the device still works: the leak is per-device, and each
    // failed retry leaks another handle to the same one.
    if (!this.#localStream) {
      track.stop();
      return null;
    }

    // Switching cameras must not silently un-mute a camera the player had
    // deliberately switched off.
    track.enabled = enabled;
    this.#localStream.addTrack(track);
    this.#watchLocalVideo(track);
    this.#attachLocalTracks();
    return track;
  }

  // Watches the outgoing camera track for the failure mode that matters on
  // phones: the track stays readyState === "live", so nothing looks wrong,
  // but the underlying source stops producing frames. On screen that reads as
  // a stutter and then a permanently black tile.
  //
  // It happens when Android reclaims the camera while the app is backgrounded
  // and doesn't hand it back on return, and when a camera is reopened before
  // the previous handle has finished being torn down - which is exactly the
  // path from the pre-match device check into a match.
  //
  // The manual workaround players find is to switch cameras until they land
  // back on the right one, because that acquires a fresh track. This just does
  // that automatically.
  #watchLocalVideo(track) {
    if (!track) return;
    clearTimeout(this.#muteTimer);

    // A track that ENDS is unambiguous - the source is gone.
    track.addEventListener("ended", () => this.#recoverCamera(), { once: true });

    // A muted track is more delicate. Brief mutes are normal and self-heal
    // (the source blips as the OS juggles it), so tearing the camera down on
    // every one would cause more flicker than it fixes. Only a mute that
    // outlasts the grace period is treated as a dead camera.
    track.addEventListener("mute", () => {
      clearTimeout(this.#muteTimer);
      this.#muteTimer = setTimeout(() => this.#recoverCamera(), 1500);
    });
    track.addEventListener("unmute", () => clearTimeout(this.#muteTimer));
  }

  // True when the camera is nominally on but demonstrably not producing.
  #videoStalled() {
    const track = this.#localStream?.getVideoTracks()[0];
    if (!track) return false;
    return track.readyState === "ended" || track.muted;
  }

  // Reopens the camera currently in use. Goes through switchCamera so it takes
  // the same stop-then-open path (required on Android) and the same
  // replaceTrack hand-off, meaning the peer connection is never renegotiated
  // and the opponent sees nothing but a brief freeze.
  async #recoverCamera() {
    if (this.#recovering || this.#switching || !this.#localStream) return;

    // Never reach for a camera while the page is hidden. On a phone that is
    // precisely when the OS has taken it - so the request either fails with
    // NotReadableError or wins a fight it has no business starting, and either
    // way it burns the one attempt at exactly the wrong moment. The
    // visibilitychange handler retries on the way back in.
    if (document.visibilityState !== "visible") return;

    const track = this.#localStream.getVideoTracks()[0];
    if (!track) return;

    const deviceId = track.getSettings().deviceId || undefined;
    this.#recovering = true;
    this.onCameraRecovering?.(true);
    try {
      await this.switchCamera({ deviceId });
    } catch (err) {
      // A camera released only moments ago is often still busy for a beat.
      // One unhurried retry turns most of those into a success instead of a
      // dead tile the player has to fix by hand.
      if (err.name === "NotReadableError" && this.#localStream) {
        await new Promise((r) => setTimeout(r, 800));
        try {
          await this.switchCamera({ deviceId });
        } catch (retryErr) {
          console.warn("Couldn't recover the camera", retryErr);
        }
      } else {
        // Nothing useful left to do automatically - the manual Switch camera
        // button is still there, and the tile still reads as black.
        console.warn("Couldn't recover the camera", err);
      }
    } finally {
      this.#recovering = false;
      this.onCameraRecovering?.(false);
    }
  }

  // Called when the page comes back to the foreground. Returning from the
  // background is where a camera most often comes back dead, and no event
  // necessarily fires to say so - the track can simply have been muted while
  // the page wasn't running to hear about it.
  async recoverCameraIfStalled() {
    if (document.visibilityState !== "visible") return;
    if (this.#videoStalled()) await this.#recoverCamera();
  }

  // Turns everything off and releases the devices, so the browser's
  // camera-in-use indicator actually goes out.
  stopMedia() {
    clearTimeout(this.#muteTimer);
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
    clearTimeout(this.#muteTimer);
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
