// online.js - 1v1 online challenges over WebRTC.
//
// Key idea: both browsers run the exact same deterministic scoring logic
// (resolveThrow from scoring.js). Each side only ever applies hits from its
// OWN physical board locally, and forwards every hit to the peer as a
// message. The peer applies that incoming hit to its model of "the opponent"
// using the identical rules. As long as messages arrive in order (which
// WebRTC DataChannels guarantee by default), both browsers' game state stays
// in lockstep with no need for a rollback/replay system - see the
// architecture notes in the top-level README.

import { Granboard, SegmentID, SegmentType, createSegment, applyBullMode } from "./granboard.js";
import { resolveThrow, rulesFor } from "./scoring.js";
import {
  createCricketPlayer, resolveCricketThrow, applyCricketResult,
  checkCricketWin, describeCricketResult,
} from "./cricket.js";
import {
  createCountUpPlayer, resolveCountUpThrow, applyCountUpResult,
  checkCountUpWin, isLegComplete, describeCountUpResult, formatAverage,
  DEFAULT_ROUNDS,
} from "./countup.js";
import {
  createMatch, currentLegConfig, recordLegWin, advanceLeg,
  startingPlayerForLeg, legProgressText, normalizeLeg, matchScoreText,
} from "./medley.js";
import { renderCricketBoard, wireCricketBoard } from "./cricketboard.js";
import { createMedleyBuilder } from "./medleybuilder.js";
import { createQuickEntry } from "./quickentry.js";
import { renderDartboard, moveMarkerTo, hideMarker } from "./dartboard.js";

const STARTING_SCORE = 501;

let PeerLink; // lazy-imported so a missing webrtc.js doesn't break local mode
let peerLink = null;
let myBoard = null;

const online = {
  active: false,
  role: null, // 'host' | 'guest'
  activeSide: null, // 'me' | 'opp'
  gameOver: false, // the LEG is decided
  legOver: false, // leg decided but the match continues
  iWon: null,
  // The match format is chosen by the host and sent to the guest on connect
  // (see the "match_config" message) - otherwise both sides would guess, and
  // a guest could end up playing 501 while the host played Cricket.
  match: null,
  legConfig: null,
  gameType: "x01",
  // Absolute player indices in the match: host is 0, guest is 1. Both sides
  // need the same numbering so leg tallies and who-throws-first agree.
  myIndex: 0,
  oppIndex: 1,
  me: null,
  opp: null,
  log: [],
};

// ---------- DOM ----------
const el = {
  tabLocal: document.getElementById("tab-local"),
  tabOnline: document.getElementById("tab-online"),
  localMode: document.getElementById("local-mode"),
  onlineMode: document.getElementById("online-mode"),

  signalingUrl: document.getElementById("signaling-url"),
  createBtn: document.getElementById("create-challenge-btn"),
  joinInput: document.getElementById("join-code-input"),
  joinBtn: document.getElementById("join-challenge-btn"),

  setupPanel: document.getElementById("online-setup-panel"),
  waitingPanel: document.getElementById("online-waiting-panel"),
  gamePanel: document.getElementById("online-game-panel"),
  codeDisplay: document.getElementById("challenge-code-display"),
  cancelBtn: document.getElementById("cancel-challenge-btn"),

  statusLabel: document.getElementById("online-status-label"),
  meBox: document.getElementById("online-me-box"),
  oppBox: document.getElementById("online-opp-box"),
  meScore: document.getElementById("online-me-score"),
  oppScore: document.getElementById("online-opp-score"),
  scoreboard: document.getElementById("online-scoreboard"),
  bigScore: document.getElementById("online-big-score"),
  tileMeScore: document.getElementById("online-tile-me-score"),
  tileOppScore: document.getElementById("online-tile-opp-score"),
  remoteTile: document.getElementById("online-remote-tile"),
  turnLabel: document.getElementById("online-turn-label"),
  turnDarts: document.getElementById("online-turn-darts"),
  winnerBanner: document.getElementById("online-winner-banner"),

  connectBtn: document.getElementById("online-connect-btn"),
  connectionDot: document.getElementById("online-connection-dot"),
  connectionLabel: document.getElementById("online-connection-label"),

  videoStrip: document.getElementById("online-video-strip"),
  localVideo: document.getElementById("online-local-video"),
  remoteVideo: document.getElementById("online-remote-video"),
  localPlaceholder: document.getElementById("online-local-placeholder"),
  remotePlaceholder: document.getElementById("online-remote-placeholder"),
  localTile: document.getElementById("online-local-tile"),
  avStartBtn: document.getElementById("online-av-start-btn"),
  avMicBtn: document.getElementById("online-av-mic-btn"),
  avCamBtn: document.getElementById("online-av-cam-btn"),
  avSwapBtn: document.getElementById("online-av-swap-btn"),
  avAddCamBtn: document.getElementById("online-av-add-cam-btn"),
  localTile2: document.getElementById("online-local-tile-2"),
  remoteTile2: document.getElementById("online-remote-tile-2"),
  localVideo2: document.getElementById("online-local-video-2"),
  remoteVideo2: document.getElementById("online-remote-video-2"),
  avViewBtn: document.getElementById("online-av-view-btn"),
  avStopBtn: document.getElementById("online-av-stop-btn"),

  manualSection: document.getElementById("online-manual-section"),
  dartboardEl: document.querySelector("#online-mode .dartboard"),
  dartboardMarker: document.getElementById("online-dartboard-marker"),
  formatSelect: document.getElementById("online-format"),
  medleyLegs: document.getElementById("online-medley-legs"),
  addLegBtn: document.getElementById("online-add-leg-btn"),
  cricketBoard: document.getElementById("online-cricket-board"),
  matchBar: document.getElementById("online-match-bar"),
  nextLegBtn: document.getElementById("online-next-leg-btn"),
  manualPerdart: document.getElementById("online-manual-perdart"),
  manualQuickTotal: document.getElementById("online-manual-quicktotal"),
  manualRing: document.getElementById("online-manual-ring"),
  manualSections: document.getElementById("online-manual-sections"),
  manualBull: document.getElementById("online-manual-bull"),
  manualDblBull: document.getElementById("online-manual-dblbull"),
  manualMiss: document.getElementById("online-manual-miss"),

  throwLog: document.getElementById("online-throw-log"),
  endMatchBtn: document.getElementById("online-end-match-btn"),
  setupNotice: document.getElementById("online-setup-notice"),

  checkPanel: document.querySelector(".device-check"),
  checkPreview: document.querySelector(".device-preview"),
  checkVideo: document.getElementById("device-preview-video"),
  checkPlaceholder: document.getElementById("device-preview-placeholder"),
  checkBtn: document.getElementById("device-check-btn"),
  checkStopBtn: document.getElementById("device-check-stop-btn"),
  checkCameraRow: document.getElementById("device-camera-row"),
  checkCameraSelect: document.getElementById("device-camera-select"),
  checkMicRow: document.getElementById("device-mic-row"),
  checkMicSelect: document.getElementById("device-mic-select"),
  checkLevelRow: document.getElementById("device-level-row"),
  checkMicLevel: document.getElementById("device-mic-level"),
  checkError: document.getElementById("device-check-error"),
};

// ---------- Signaling / ICE configuration ----------
// The signaling WebSocket is served by the SAME origin as this page (see
// server/server.js), so the correct URL can just be derived from
// window.location. That's why there's nothing to configure: whatever
// hostname, port, and scheme the player loaded the page on is already the
// right answer, and because the scheme is derived too (https -> wss), it can
// never be blocked as mixed content.
//
// Priority: an explicit override this browser saved > an explicit
// signalingUrl from the deployment's /config.json (only set if an operator
// deliberately points players at some OTHER server) > this same origin.
function sameOriginSignalingUrl(path = "/signaling") {
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${location.host}${path}`;
}

// ICE servers tell WebRTC how to punch through NAT. STUN (the default) lets
// each browser learn its own public address so the two can connect directly.
// TURN is a relay for networks that refuse direct P2P entirely - it's
// optional, configured server-side, and arrives here via /config.json.
let iceServers = [{ urls: ["stun:stun.l.google.com:19302"] }];

let signalingPath = "/signaling";
const savedUrl = localStorage.getItem("granboard-signaling-url");
el.signalingUrl.value = savedUrl || sameOriginSignalingUrl();
el.signalingUrl.placeholder = sameOriginSignalingUrl();

fetch("./config.json")
  .then((res) => (res.ok ? res.json() : Promise.reject()))
  .then((cfg) => {
    if (Array.isArray(cfg.iceServers) && cfg.iceServers.length) {
      iceServers = cfg.iceServers;
    }
    if (cfg.signalingPath) {
      signalingPath = cfg.signalingPath;
      el.signalingUrl.placeholder = sameOriginSignalingUrl(signalingPath);
    }
    // Only override the field if the deployment named a specific server AND
    // this browser hasn't set its own override.
    if (!savedUrl) {
      el.signalingUrl.value = cfg.signalingUrl || sameOriginSignalingUrl(signalingPath);
    }
  })
  .catch(() => {
    // No config.json (e.g. opening index.html straight off disk) - the
    // same-origin default is already in the field, so there's nothing to do.
  });

// Remembers an override only when the player actually typed something
// different from the derived default, so a saved value from an older version
// can't get stuck overriding a perfectly good same-origin URL forever.
function rememberSignalingOverride() {
  const value = el.signalingUrl.value.trim();
  if (!value || value === sameOriginSignalingUrl(signalingPath)) {
    localStorage.removeItem("granboard-signaling-url");
  } else {
    localStorage.setItem("granboard-signaling-url", value);
  }
}

function currentSignalingUrl() {
  return el.signalingUrl.value.trim() || sameOriginSignalingUrl(signalingPath);
}

// ---------- Tab switching ----------
el.tabLocal.addEventListener("click", () => switchTab("local"));
el.tabOnline.addEventListener("click", () => switchTab("online"));

function switchTab(which) {
  el.tabLocal.classList.toggle("active", which === "local");
  el.tabOnline.classList.toggle("active", which === "online");
  el.localMode.classList.toggle("hidden", which !== "local");
  el.onlineMode.classList.toggle("hidden", which !== "online");
}

// ---------- Manual entry buttons (generated once) ----------
function manualSegmentFromRing(section, ringType) {
  const ringToSlot = { inner: 0, triple: 1, outer: 2, double: 3 };
  return createSegment((section - 1) * 4 + ringToSlot[ringType]);
}

for (let section = 1; section <= 20; section++) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "manual-section-btn";
  btn.textContent = section;
  btn.addEventListener("click", () => {
    onLocalHit(manualSegmentFromRing(section, el.manualRing.value));
  });
  el.manualSections.appendChild(btn);
}
el.manualBull.addEventListener("click", () => onLocalHit(createSegment(SegmentID.BULL)));
el.manualDblBull.addEventListener("click", () => onLocalHit(createSegment(SegmentID.DBL_BULL)));
el.manualMiss.addEventListener("click", () => onLocalHit(createSegment(SegmentID.MISS)));

el.manualSection.querySelectorAll(".entry-mode-tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    const mode = tab.dataset.mode;
    el.manualSection.querySelectorAll(".entry-mode-tab").forEach((t) => t.classList.toggle("active", t === tab));
    el.manualPerdart.classList.toggle("hidden", mode !== "perdart");
    el.manualQuickTotal.classList.toggle("hidden", mode !== "quicktotal");
  });
});

createQuickEntry(el.manualQuickTotal, onLocalQuickTotal);

// ---------- Clickable dartboard ----------
// Same board and same code path as local mode (see dartboard.js) - clicking a
// segment routes through onLocalHit exactly like a real Bluetooth hit or a
// manual-entry button, so turn enforcement, scoring, bust detection, and the
// throw log all behave identically regardless of which input you use.
renderDartboard(el.dartboardEl, (segmentId) => {
  onLocalHit(createSegment(segmentId));
});

// The same Format control as local play - presets plus a fully editable leg
// list, so an online match can be any custom medley too. Only ever read on
// the host side; the guest is told the result over the wire.
const onlineMedleyBuilder = createMedleyBuilder({
  legs: el.medleyLegs,
  addBtn: el.addLegBtn,
  preset: el.formatSelect,
  bull: document.getElementById("online-bull-mode"),
});

function selectedOnlineLegs() {
  return onlineMedleyBuilder.getLegs().map(normalizeLeg);
}

// Same cricket board component as local play, so the two modes can't drift.
wireCricketBoard(el.cricketBoard, (segment) => {
  if (online.gameType !== "cricket") return;
  onLocalHit(segment);
});

el.nextLegBtn?.addEventListener("click", () => {
  if (!online.legOver) return;
  // Tell the opponent first, then advance locally - both sides run the same
  // deterministic step, so neither needs to be sent the resulting state.
  peerLink?.sendGameMessage({ type: "next_leg" });
  advanceLeg(online.match);
  startOnlineLeg();
  el.winnerBanner.classList.add("hidden");
  renderOnline();
});

// ---------- Camera & mic check (before a match) ----------
// Lets someone confirm their gear works without creating a challenge first and
// making an opponent sit waiting while they debug it.
//
// Deliberately does NOT go through PeerLink. There isn't one yet at this point
// in the flow, and coupling a hardware check to a live connection would mean
// the only way to test your camera is to start a match - which is precisely
// the problem this exists to remove.

const CAMERA_PREF_KEY = "granboard-camera-id";
const MIC_PREF_KEY = "granboard-mic-id";

const check = { stream: null, audioCtx: null, analyser: null, raf: null, muteTimer: null, recovering: false };

// Which start-the-check attempt is currently the live one. getUserMedia takes
// long enough that a player can press Create Challenge, collapse the panel, or
// change camera while one is still in flight - and the stream then arrives for
// a check that no longer exists. Assigning it to check.stream at that point
// orphans a running camera that nothing will ever stop, and a leaked handle is
// what makes one specific device report "busy" from then on while every other
// camera keeps working.
let checkRun = 0;

// The preview has exactly the same problem the in-match tile does: on a phone
// the camera track can stay "live" while the source quietly stops producing
// frames, which looks like a stutter and then a black box. See the long note
// on #watchLocalVideo in webrtc.js - this is the same watchdog for the stream
// the check owns, which PeerLink never sees.
function watchCheckVideo(track) {
  if (!track) return;
  clearTimeout(check.muteTimer);
  track.addEventListener("ended", () => recoverCheckCamera(), { once: true });
  track.addEventListener("mute", () => {
    clearTimeout(check.muteTimer);
    check.muteTimer = setTimeout(recoverCheckCamera, 1500);
  });
  track.addEventListener("unmute", () => clearTimeout(check.muteTimer));
}

function checkVideoStalled() {
  const track = check.stream?.getVideoTracks()[0];
  if (!track) return false;
  return track.readyState === "ended" || track.muted;
}

// Reopens whatever camera the preview was already using. Restarting the whole
// check is the right move here rather than a surgical track swap: the preview
// owns its stream outright, so there is nothing to keep in sync.
async function recoverCheckCamera() {
  if (check.recovering || !check.stream) return;
  // Same rule as the in-match watchdog: never reach for a camera while the
  // page is hidden, because that's when the OS has it.
  if (document.visibilityState !== "visible") return;
  const deviceId = check.stream.getVideoTracks()[0]?.getSettings().deviceId || savedCameraId();
  check.recovering = true;
  try {
    await startDeviceCheck(deviceId, savedMicId());
  } finally {
    check.recovering = false;
  }
}

function savedCameraId() {
  return localStorage.getItem(CAMERA_PREF_KEY) || null;
}

function rememberCamera(deviceId) {
  if (deviceId) localStorage.setItem(CAMERA_PREF_KEY, deviceId);
  else localStorage.removeItem(CAMERA_PREF_KEY);
}

// The one rule for self-view mirroring, shared by the pre-match preview and
// the in-match tile so they can't disagree - they did once, and a board that
// flips over the moment the match starts is worse than either choice alone.
//
// Note the default: an UNKNOWN facing mode mirrors. That's every ordinary
// desktop webcam, and those point at a face. Only a camera that explicitly
// says it faces the world is treated as pointing at a board.
function shouldMirror(facingMode) {
  return facingMode !== "environment";
}

function savedMicId() {
  return localStorage.getItem(MIC_PREF_KEY) || null;
}

function rememberMic(deviceId) {
  if (deviceId) localStorage.setItem(MIC_PREF_KEY, deviceId);
  else localStorage.removeItem(MIC_PREF_KEY);
}

// Shared by the check and the in-match Start button, so the same failure
// never gets explained two different ways.
function mediaErrorMessage(err) {
  if (!window.isSecureContext) {
    return "Camera and mic need a secure context - they're blocked because this page is loaded over plain HTTP. " +
      "This works on http://localhost, but NOT on a plain http://<ip-address> address, even on your own network. " +
      "Put the site behind HTTPS to fix this - see the README.";
  }
  if (err.name === "NotAllowedError") {
    return "Camera/mic permission was denied. Allow it in the browser's address-bar icon and try again.";
  }
  if (err.name === "NotFoundError") return "No camera or microphone was found on this device.";
  if (err.name === "NotReadableError") {
    return "The camera is busy - close anything else using it (including other tabs) and try again.";
  }
  return `Couldn't start camera and mic: ${err.message}`;
}

// Remembered device IDs go stale more often than you'd expect: browsers
// reissue them when site permissions are reset, and hardware gets unplugged.
// An `exact` request then throws OverconstrainedError, which would strand
// someone on a dead preference with no obvious way back.
//
// With two preferences in play the error alone doesn't reliably say which one
// died - OverconstrainedError carries a `constraint` field, but what browsers
// put in it isn't consistent enough to branch on. So this walks a ladder,
// dropping one preference at a time, and forgets exactly the ones it had to
// drop. Someone whose webcam was unplugged keeps their chosen mic, and vice
// versa, rather than having both preferences wiped by one dead device.
async function getCheckStream(cameraId, micId) {
  const video = { width: { ideal: 640 }, height: { ideal: 480 } };
  const build = (cam, mic) => ({
    audio: mic ? { deviceId: { exact: mic } } : true,
    video: cam ? { ...video, deviceId: { exact: cam } } : video,
  });

  // Most-preferred first. Duplicates are skipped so a player with no saved
  // preferences makes exactly one request.
  const ladder = [[cameraId, micId], [cameraId, null], [null, micId], [null, null]];
  const seen = new Set();
  let lastErr = null;

  for (const [cam, mic] of ladder) {
    const key = `${cam}|${mic}`;
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      const stream = await navigator.mediaDevices.getUserMedia(build(cam, mic));
      // Whatever had to be given up to get here was pointing at nothing.
      if (cameraId && !cam) rememberCamera(null);
      if (micId && !mic) rememberMic(null);
      return stream;
    } catch (err) {
      lastErr = err;
      // Only a dead device is worth stepping down the ladder for. A denied
      // permission or a missing secure context fails identically every time,
      // and retrying just produces the same refusal three more times.
      if (err.name !== "OverconstrainedError" && err.name !== "NotFoundError") throw err;
    }
  }
  throw lastErr;
}

async function startDeviceCheck(cameraId = savedCameraId(), micId = savedMicId()) {
  // Release whatever the check already holds first - same reason switchCamera
  // does: Android won't hand out the second camera while the first is open.
  stopDeviceCheck({ keepUi: true });
  const myRun = ++checkRun;
  el.checkError.classList.add("hidden");
  el.checkBtn.disabled = true;

  try {
    const stream = await getCheckStream(cameraId, micId);

    // Something superseded this attempt while the camera was opening. Stop
    // what we just acquired rather than leaving it running unreferenced.
    if (myRun !== checkRun) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }

    check.stream = stream;
    el.checkVideo.srcObject = check.stream;
    // The preview is muted, so it never needs the tap-to-play recovery the
    // in-match opponent tile does.
    el.checkVideo.play().catch(() => {});
    // Same mirroring rule as the in-match tile - a rear camera lined up on a
    // board here must not flip when the match starts.
    const videoTrack = check.stream.getVideoTracks()[0];
    const facingMode = videoTrack?.getSettings().facingMode || null;
    el.checkPreview.classList.toggle("unmirrored", !shouldMirror(facingMode));
    watchCheckVideo(videoTrack);
    await populateDeviceLists();
    startMicMeter();
    renderCheck(true);
  } catch (err) {
    console.error(err);
    el.checkError.textContent = mediaErrorMessage(err);
    el.checkError.classList.remove("hidden");
    renderCheck(false);
  } finally {
    el.checkBtn.disabled = false;
  }
}

async function populateDeviceLists() {
  let devices = [];
  try {
    devices = await navigator.mediaDevices.enumerateDevices();
  } catch { /* leave the pickers hidden */ }

  fillDevicePicker(
    el.checkCameraSelect,
    el.checkCameraRow,
    devices.filter((d) => d.kind === "videoinput"),
    check.stream?.getVideoTracks()[0]?.getSettings().deviceId,
    "Camera"
  );
  fillDevicePicker(
    el.checkMicSelect,
    el.checkMicRow,
    devices.filter((d) => d.kind === "audioinput"),
    check.stream?.getAudioTracks()[0]?.getSettings().deviceId,
    "Mic"
  );
}

function fillDevicePicker(select, row, devices, activeId, fallbackLabel) {
  select.innerHTML = "";
  devices.forEach((device, i) => {
    const opt = document.createElement("option");
    opt.value = device.deviceId;
    // Labels are blank until permission is granted - by now it has been, but
    // virtual devices and some browsers still return nothing useful.
    opt.textContent = device.label || `${fallbackLabel} ${i + 1}`;
    opt.selected = device.deviceId === activeId;
    select.appendChild(opt);
  });
  // A picker with one entry can't pick anything.
  row.classList.toggle("hidden", devices.length < 2);
}

function startMicMeter() {
  if (!check.stream?.getAudioTracks().length) return;

  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return;
  check.audioCtx = new Ctx();
  // Audio contexts are commonly created in the "suspended" state, and this one
  // is built AFTER an `await` on getUserMedia - by which point the click that
  // started the check may no longer count as user activation. A suspended
  // context's analyser reads pure silence, so the meter would sit at zero and
  // be indistinguishable from a genuinely dead microphone. Resume explicitly
  // rather than trusting the gesture to have survived.
  if (check.audioCtx.state === "suspended") check.audioCtx.resume().catch(() => {});

  const source = check.audioCtx.createMediaStreamSource(check.stream);
  check.analyser = check.audioCtx.createAnalyser();
  check.analyser.fftSize = 512;
  // NOTE: connected to the analyser and nothing else. Routing this on to
  // audioCtx.destination would play the mic out of the speakers, which is an
  // instant feedback loop - the exact thing the muted preview avoids.
  source.connect(check.analyser);

  const data = new Uint8Array(check.analyser.fftSize);
  const tick = () => {
    check.analyser.getByteTimeDomainData(data);
    // RMS around 128, which is what digital silence reads as.
    let sum = 0;
    for (const v of data) {
      const d = (v - 128) / 128;
      sum += d * d;
    }
    const rms = Math.sqrt(sum / data.length);
    // Scaled hard on purpose: ordinary speech sits near 0.05-0.15 RMS, which
    // at 1:1 would be a bar you can't see moving.
    el.checkMicLevel.style.width = `${Math.min(100, Math.round(rms * 400))}%`;
    check.raf = requestAnimationFrame(tick);
  };
  tick();
}

function stopDeviceCheck({ keepUi = false } = {}) {
  // Invalidates any start that's still waiting on getUserMedia, so its stream
  // gets stopped on arrival instead of quietly holding the camera open.
  checkRun++;
  if (check.raf) cancelAnimationFrame(check.raf);
  check.raf = null;
  clearTimeout(check.muteTimer);
  check.muteTimer = null;
  check.audioCtx?.close().catch(() => {});
  check.audioCtx = null;
  check.analyser = null;
  check.stream?.getTracks().forEach((t) => t.stop());
  check.stream = null;
  el.checkVideo.srcObject = null;
  el.checkMicLevel.style.width = "0%";
  // Back to the mirrored default, so a failed restart can't leave the previous
  // camera's orientation applied to a different camera.
  el.checkPreview.classList.remove("unmirrored");
  if (!keepUi) renderCheck(false);
}

function renderCheck(on) {
  el.checkBtn.classList.toggle("hidden", on);
  el.checkStopBtn.classList.toggle("hidden", !on);
  el.checkPlaceholder.classList.toggle("hidden", on);
  el.checkLevelRow.classList.toggle("hidden", !on);
  // The pickers are driven by how many devices exist, which is only known
  // while the check is running - so stopping hides them outright rather than
  // leaving a stale list on screen.
  if (!on) {
    el.checkCameraRow.classList.add("hidden");
    el.checkMicRow.classList.add("hidden");
  }
}

el.checkBtn.addEventListener("click", () => startDeviceCheck());
el.checkStopBtn.addEventListener("click", () => stopDeviceCheck());

el.checkCameraSelect.addEventListener("change", () => {
  const id = el.checkCameraSelect.value;
  rememberCamera(id);
  startDeviceCheck(id, savedMicId());
});

el.checkMicSelect.addEventListener("change", () => {
  const id = el.checkMicSelect.value;
  rememberMic(id);
  startDeviceCheck(savedCameraId(), id);
});

// Collapsing the section is the natural "I'm done" gesture, and leaving the
// camera live behind a closed panel would leave the webcam light on with
// nothing on screen explaining why.
el.checkPanel.addEventListener("toggle", () => {
  if (!el.checkPanel.open) stopDeviceCheck();
});

// ---------- Create / Join ----------
el.createBtn.addEventListener("click", async () => {
  await ensurePeerLinkLoaded();
  rememberSignalingOverride();
  peerLink = new PeerLink(currentSignalingUrl(), iceServers);
  wirePeerLink();
  resetAv();

  // Hand the devices back before the match asks for them. Android in
  // particular will not open a camera that the check is still holding, and
  // the preview has no reason to keep running once a match is starting.
  stopDeviceCheck();

  // Whatever ended the last match is no longer news.
  el.setupNotice.classList.add("hidden");
  el.setupPanel.classList.add("hidden");
  el.waitingPanel.classList.remove("hidden");

  try {
    const code = await peerLink.createChallenge();
    el.codeDisplay.textContent = code;
  } catch (err) {
    alert(`Couldn't create a challenge: ${err.message}`);
    el.waitingPanel.classList.add("hidden");
    el.setupPanel.classList.remove("hidden");
  }
});

el.joinBtn.addEventListener("click", async () => {
  const code = el.joinInput.value.trim();
  if (!code) return;

  await ensurePeerLinkLoaded();
  rememberSignalingOverride();
  peerLink = new PeerLink(currentSignalingUrl(), iceServers);
  wirePeerLink();
  resetAv();

  // Hand the devices back before the match asks for them. Android in
  // particular will not open a camera that the check is still holding, and
  // the preview has no reason to keep running once a match is starting.
  stopDeviceCheck();

  // Whatever ended the last match is no longer news.
  el.setupNotice.classList.add("hidden");
  el.setupPanel.classList.add("hidden");
  el.waitingPanel.classList.remove("hidden");
  el.codeDisplay.textContent = code.toUpperCase();

  try {
    await peerLink.joinChallenge(code);
  } catch (err) {
    alert(`Couldn't join that challenge: ${err.message}`);
    el.waitingPanel.classList.add("hidden");
    el.setupPanel.classList.remove("hidden");
  }
});

el.cancelBtn.addEventListener("click", () => {
  peerLink?.close();
  peerLink = null;
  resetAv();
  el.waitingPanel.classList.add("hidden");
  el.setupPanel.classList.remove("hidden");
});

// ---------- Ending a match ----------
// A hard stop: drops the peer connection AND releases the camera and mic.
// Those are deliberately one action rather than two - a player who has "left"
// a match while their webcam light is still on has not left in any sense they
// would recognise, and hunting for a second button to make the light go out is
// exactly the moment someone stops trusting the feature.
let endArmTimeout = null;

el.endMatchBtn.addEventListener("click", () => {
  // Two taps, not a confirm() dialog: a modal is poor on a phone mid-match,
  // but ending someone's leg on one stray tap is worth guarding against. The
  // arming lapses on its own so it can't sit primed for the rest of the game.
  if (el.endMatchBtn.dataset.armed !== "1") {
    el.endMatchBtn.dataset.armed = "1";
    el.endMatchBtn.textContent = "Tap again to end";
    el.endMatchBtn.classList.add("armed");
    clearTimeout(endArmTimeout);
    endArmTimeout = setTimeout(disarmEndMatch, 4000);
    return;
  }
  // Tell the opponent BEFORE tearing down - once the connection is closed
  // there's nothing left to send it on, and they'd be left staring at a live
  // scoreboard for a match that no longer exists.
  peerLink?.sendGameMessage({ type: "end_match" });
  teardownMatch("You ended the match.");
});

function disarmEndMatch() {
  clearTimeout(endArmTimeout);
  el.endMatchBtn.dataset.armed = "0";
  el.endMatchBtn.textContent = "End match";
  el.endMatchBtn.classList.remove("armed");
}

function teardownMatch(message) {
  disarmEndMatch();
  // close() stops the local camera and mic tracks as well as the connection -
  // see the comment at the top of webrtc.js's close().
  peerLink?.close();
  peerLink = null;

  online.active = false;
  online.gameOver = false;
  online.legOver = false;
  online.match = null;

  resetAv();

  el.gamePanel.classList.add("hidden");
  el.waitingPanel.classList.add("hidden");
  el.winnerBanner.classList.add("hidden");
  el.setupPanel.classList.remove("hidden");
  el.setupNotice.textContent = message;
  el.setupNotice.classList.remove("hidden");
}

async function ensurePeerLinkLoaded() {
  if (!PeerLink) {
    ({ PeerLink } = await import("./webrtc.js"));
  }
}

function wirePeerLink() {
  peerLink.onRemoteStream = (stream, slot) => {
    // Re-fired per arriving track (audio and video come separately), and it's
    // the same MediaStream object every time, so re-assigning is harmless.
    // Fires immediately on connect for the pre-negotiated m-lines, long before
    // anyone switches a camera on - so this only wires the element up, and
    // deliberately does not touch the "is the opponent sending?" state.
    //
    // Slot 1 is the opponent's second camera; slot 0 carries their main camera
    // AND all of the audio, which is why that element is the one that is never
    // hidden.
    if (slot === 1) el.remoteVideo2.srcObject = stream;
    else el.remoteVideo.srcObject = stream;
    renderAv();
  };

  // A second camera that dies on its own - unplugged, or claimed by another
  // app - just goes away. There's no recovery ladder for it (see
  // startSecondCamera), so the honest thing is to drop the tile and let the
  // button offer to add one again.
  peerLink.onSecondCameraLost = () => {
    av.second = false;
    el.localVideo2.srcObject = null;
    renderAv();
  };

  peerLink.onCameraRecovering = (recovering) => {
    av.recovering = recovering;
    renderAv();
  };

  peerLink.onRemoteMediaChange = ({ audio, video, video2 }) => {
    av.remoteAudio = audio;
    av.remoteVideo = video;
    av.remoteVideo2 = video2;
    // An opponent switching their camera back on is a fresh chance to get
    // playback going, in case it was blocked when the stream first arrived.
    if (video && el.remoteVideo.paused) playRemote();
    renderAv();
  };

  peerLink.onStatusChange = (status) => {
    el.statusLabel.textContent = statusText(status);

    if (status === "connected" && !online.active) {
      // The guest announces itself and the host replies with the format.
      // Doing it in that order removes any race over whether the data
      // channel was open when the config was sent - the host only sends
      // once it has heard from the guest.
      if (peerLink.role === "guest") {
        peerLink.sendGameMessage({ type: "hello" });
      }
    }
    if (status === "disconnected" || status === "room-full") {
      if (online.active) {
        el.statusLabel.textContent = "Opponent disconnected.";
      }
    }
  };

  peerLink.onMessage = (msg) => {
    if (msg.type === "hello") {
      // Only the host answers this, and only once.
      if (peerLink.role !== "host" || online.active) return;
      const legs = selectedOnlineLegs();
      peerLink.sendGameMessage({ type: "match_config", legs });
      startOnlineGame("host", legs);
      renderOnline();
      return;
    }

    if (msg.type === "match_config") {
      if (online.active) return;
      startOnlineGame("guest", msg.legs);
      renderOnline();
      return;
    }

    if (msg.type === "end_match") {
      teardownMatch("Your opponent ended the match.");
      return;
    }

    if (msg.type === "dart") {
      applyThrow("opp", msg.segment);
    } else if (msg.type === "end_turn") {
      if (online.activeSide === "opp") {
        endTurn("opp");
        renderOnline();
      }
    } else if (msg.type === "quick_total") {
      applyQuickTotalThrow("opp", msg.value);
    } else if (msg.type === "next_leg") {
      // Either player can move the match on; both sides advance together.
      if (!online.legOver) return;
      advanceLeg(online.match);
      startOnlineLeg();
      el.winnerBanner.classList.add("hidden");
      renderOnline();
    }
  };
}

function statusText(status) {
  switch (status) {
    case "connecting-to-server": return "Connecting to signaling server…";
    case "waiting-for-opponent": return "Waiting for opponent to join…";
    case "joining": return "Joining challenge…";
    case "connected": return "Connected - good luck!";
    case "disconnected": return "Disconnected.";
    case "room-full": return "That challenge code is already in use.";
    default: return "";
  }
}

// Briefly flashes a message in the status line so an out-of-turn attempt is
// obvious to the person who tried it, instead of a silent console.warn.
let noticeTimeout = null;
function showNotice(message) {
  clearTimeout(noticeTimeout);
  el.statusLabel.textContent = message;
  el.statusLabel.style.color = "#B7302A";
  noticeTimeout = setTimeout(() => {
    el.statusLabel.style.color = "";
    el.statusLabel.textContent = online.gameOver
      ? statusText("connected")
      : online.activeSide === "me" ? "Your turn" : "Opponent's turn";
  }, 2200);
}

// ---------- Game start ----------
// Builds one player's state for a leg. x01 and Cricket keep completely
// different shapes, which is why this is a function rather than a literal.
function buildOnlinePlayer(name, legConfig) {
  if (legConfig.game === "cricket") return createCricketPlayer(name);
  if (legConfig.game === "countup") return createCountUpPlayer(name);
  const rules = rulesFor(legConfig.rules);
  return {
    name,
    remaining: legConfig.score,
    startOfTurn: legConfig.score,
    // Double-in: nothing scores until this player lands a double.
    opened: rules.in !== "double",
    dartsThisTurn: [],
  };
}

function startOnlineGame(role, legs) {
  online.active = true;
  online.role = role;
  online.myIndex = role === "host" ? 0 : 1;
  online.oppIndex = 1 - online.myIndex;
  online.match = createMatch(legs, 2);
  online.log = [];

  startOnlineLeg();

  el.waitingPanel.classList.add("hidden");
  el.gamePanel.classList.remove("hidden");
  el.winnerBanner.classList.add("hidden");
  renderOnline();
}

// Resets scores for a new leg. The match tally and player identities carry
// over; only the leg's own state is rebuilt.
function startOnlineLeg() {
  const leg = normalizeLeg(currentLegConfig(online.match));
  online.legConfig = leg;
  online.gameType = leg.game;

  online.me = buildOnlinePlayer("You", leg);
  online.opp = buildOnlinePlayer("Opponent", leg);
  online.me.dartsThisTurn = [];
  online.opp.dartsThisTurn = [];

  // Throw alternates each leg, and both sides compute it from the same
  // absolute index so they never disagree about whose turn it is.
  const starter = startingPlayerForLeg(online.match.currentLeg, 2);
  online.activeSide = starter === online.myIndex ? "me" : "opp";

  online.gameOver = false;
  online.legOver = false;
  online.iWon = null;
}

// A leg has been won. Both sides run this independently off the same inputs,
// so neither has to be told the result.
// side may be null: a Count Up leg can end level, in which case the leg is
// credited to nobody rather than picking a winner arbitrarily.
function finishOnlineLeg(side) {
  online.gameOver = true;
  online.iWon = side === null ? null : side === "me";
  const winnerIndex = side === null
    ? null
    : (side === "me" ? online.myIndex : online.oppIndex);
  recordLegWin(online.match, winnerIndex);
  online.legOver = !online.match.over;
}

// ---------- My physical board ----------
el.connectBtn.addEventListener("click", async () => {
  if (!navigator.bluetooth) {
    if (!window.isSecureContext) {
      alert(
        "Web Bluetooth needs a secure context - it's blocked because this page is loaded over plain HTTP. " +
        "This works on http://localhost, but NOT on a plain http://<ip-address> address like this one, even on your own network. " +
        "Put the site behind HTTPS (e.g. a reverse proxy with a TLS cert) to fix this - see the README."
      );
    } else {
      alert("This browser doesn't support Web Bluetooth. Use Chrome or Edge on desktop.");
    }
    return;
  }
  try {
    el.connectionLabel.textContent = "Connecting…";
    myBoard = await Granboard.connect();
    el.connectionDot.classList.add("connected");
    el.connectionLabel.textContent = `Connected: ${myBoard.deviceName}`;

    myBoard.segmentHitCallback = (segment) => {
      if (segment.id === SegmentID.RESET_BUTTON) {
        onLocalEndTurn();
        return;
      }
      onLocalHit(segment);
    };
    myBoard.disconnectCallback = () => {
      el.connectionDot.classList.remove("connected");
      el.connectionLabel.textContent = "Disconnected";
    };
  } catch (err) {
    console.error(err);
    el.connectionLabel.textContent = "Connection failed";
    alert(`Couldn't connect: ${err.message}`);
  }
});

// ---------- Camera & mic ----------
// Entirely optional and entirely separate from the game state: nothing here
// touches scoring, and a match plays exactly as before if nobody ever presses
// Start. The transport work lives in webrtc.js (see the long note at the top
// of that file about why turning a camera on needs no renegotiation).
const av = {
  on: false, // this player has granted access and is sending
  mic: true, // ...and hasn't muted it
  cam: true, // ...and hasn't switched the camera off
  // What the PEER says it is sending, from their media_state message.
  //
  // Deliberately not derived from the "track" event: because the audio and
  // video m-lines are negotiated up front (see webrtc.js), `ontrack` fires for
  // both of them the instant the connection opens, on every single match,
  // carrying tracks that are live-but-muted and will stay that way forever if
  // nobody touches a camera. Using that as the signal put an empty pair of
  // black rectangles above the scoreboard for players who never opted in.
  // The peer's own announcement is the only honest source for this.
  remoteAudio: false,
  remoteVideo: false,
  remoteVideo2: false, // ...and their second camera, if they added one
  remoteBlocked: false, // the browser refused to autoplay it (see playRemote)
  second: false, // this player added a second camera (the board view)
  cameras: [], // videoinput devices, only trustworthy after permission
  facingMode: null, // what the active camera says it is: "user"/"environment"/null
  recovering: false, // the camera died and is being reopened
  immersive: false, // a camera is the surface, with the scoring floating on it
  // Which feed gets the big view. Always starts on the opponent - that's the
  // one you're here to watch - and deliberately isn't remembered between
  // matches, so a swap made to aim your own camera doesn't quietly become the
  // way every future match opens.
  stage: "opponent", // whose cameras take the stage: "opponent" | "self"
};

// The stage belongs to a PLAYER, not to a camera: whoever is on it puts all
// of their cameras up there, split 50/50 when they have two - webcam left,
// board right. The other player's cameras go in the corner as thumbnails.
//
// Grouping by player rather than letting any four feeds be arranged freely is
// what keeps the layout legible. The alternative, one stage feed with the
// other three lined up as thumbnails, was tried first and doesn't fit: three
// thumbnails run straight through the score bar, and it splits the opponent's
// two views across two sizes when they are the pair you most want side by side.
const SIDE_FEEDS = {
  opponent: ["opponent", "opponent2"],
  self: ["self", "self2"],
};

const otherSide = (side) => (side === "opponent" ? "self" : "opponent");

el.avViewBtn.addEventListener("click", () => {
  av.stage = otherSide(av.stage);
  renderAv();
});

// A feed is live when there is a picture in it right now - not merely when the
// camera exists. Everything downstream keys off this: whether immersive earns
// its keep, which tiles are on screen, and what the big view can cycle to.
function isFeedLive(feed) {
  switch (feed) {
    // The opponent's tiles are blocked together: remoteBlocked means this
    // browser refused to start playback, which stops both their pictures.
    case "opponent": return av.remoteVideo && !av.remoteBlocked;
    case "opponent2": return av.remoteVideo2 && !av.remoteBlocked;
    // av.cam covers both of ours - "camera off" turns off every camera this
    // player is sending, or it isn't off (see setMediaEnabled in webrtc.js).
    case "self": return av.on && av.cam;
    case "self2": return av.second && av.cam;
    default: return false;
  }
}

// The tile each feed is painted on.
function tileFor(feed) {
  switch (feed) {
    case "opponent": return el.remoteTile;
    case "opponent2": return el.remoteTile2;
    case "self": return el.localTile;
    case "self2": return el.localTile2;
    default: return null;
  }
}

// Re-reads the camera list and the active camera. Called after anything that
// could change either, which includes simply being granted permission - the
// device list is under-reported until then.
async function refreshCameras() {
  if (!peerLink) return;
  try {
    av.cameras = await peerLink.listCameras();
  } catch {
    av.cameras = [];
  }
  av.facingMode = peerLink.activeCamera?.facingMode || null;
  renderAv();
}

// Cameras the MAIN camera is allowed to cycle onto. The one the second camera
// is holding is excluded: switching onto it would either fail as busy or steal
// it, and either way the player would have asked for a swap and lost a feed.
function swappableCameras() {
  const takenId = peerLink?.secondCamera?.deviceId;
  if (!takenId) return av.cameras;
  return av.cameras.filter((d) => d.deviceId !== takenId);
}

// Cycles to the next camera in the list. A cycle rather than a front/back
// toggle because "next" is the only thing that generalises: phones have two,
// desktops often have one, and a laptop with a plugged-in USB webcam has two
// that both report no facingMode at all, which a front/back toggle can't
// express.
el.avSwapBtn.addEventListener("click", async () => {
  const choices = swappableCameras();
  if (!peerLink || choices.length < 2) return;
  el.avSwapBtn.disabled = true;
  try {
    const currentId = peerLink.activeCamera?.deviceId;
    const at = choices.findIndex((d) => d.deviceId === currentId);
    const next = choices[(at + 1) % choices.length];
    await peerLink.switchCamera({ deviceId: next.deviceId });
    // The camera you last chose mid-match is the one to open next time, same
    // as one chosen in the pre-match check - they write the same preference.
    rememberCamera(next.deviceId);
  } catch (err) {
    console.error(err);
    // NotReadableError is the common one on Android: the camera is held by
    // another app, or by another tab of this one.
    alert(
      err.name === "NotReadableError"
        ? "That camera is busy - close anything else using it and try again."
        : `Couldn't switch camera: ${err.message}`
    );
  } finally {
    el.avSwapBtn.disabled = false;
    // Whether it worked or was rolled back, the active camera may have moved.
    await refreshCameras();
  }
});

// Adds (or drops) the second camera - one on you, one on the board.
//
// The device is picked rather than asked for: the second camera is by
// definition the one the main camera isn't using, and on the two-camera
// machines this feature is for, that's the entire choice. A picker would be a
// dialog whose every run had exactly one answer. With three or more cameras it
// takes the first spare one, and Switch camera still moves the main feed
// around underneath it.
//
// Nothing is remembered between matches, matching the big-view toggle: a
// second camera is a piece of staging for tonight's setup, not a preference.
el.avAddCamBtn.addEventListener("click", async () => {
  if (!peerLink) return;

  if (av.second) {
    peerLink.stopSecondCamera();
    el.localVideo2.srcObject = null;
    av.second = false;
    renderAv();
    return;
  }

  const spare = av.cameras.find((d) => d.deviceId !== peerLink.activeCamera?.deviceId);
  if (!spare) return;

  el.avAddCamBtn.disabled = true;
  try {
    await peerLink.startSecondCamera({ deviceId: spare.deviceId });
    el.localVideo2.srcObject = peerLink.secondStream;
    av.second = true;
  } catch (err) {
    console.error(err);
    // The expected failure, not an exotic one: most phones cannot hold two
    // cameras open at once, and this is where they say so. Worth naming the
    // hardware explicitly - "couldn't open camera" would read as a bug in the
    // app rather than a limit of the device.
    alert(
      err.name === "NotReadableError"
        ? "This device can't run two cameras at once - it's a hardware limit, not a setting. Use Switch camera to move the one camera instead."
        : `Couldn't add a second camera: ${err.message}`
    );
  } finally {
    el.avAddCamBtn.disabled = false;
    renderAv();
  }
});

// The opponent's tile carries AUDIO, and browsers refuse to autoplay audible
// media without user activation - so `autoplay` on the element is not enough
// on its own. When that happens the element sits there paused and perfectly
// black while frames decode behind it, which looks exactly like a broken
// connection and is miserable to diagnose.
//
// Note this is asymmetric on purpose: the LOCAL tile is muted (it has to be,
// or it's a feedback loop), and muted video is always allowed to autoplay, so
// only the remote side needs any of this.
//
// Usually the click that joined the challenge is activation enough. When it
// isn't, the tile turns into a tap-to-play button rather than failing silently.
function playRemote() {
  const p = el.remoteVideo.play();
  if (!p) return;
  p.then(() => {
    av.remoteBlocked = false;
    renderAv();
  }).catch(() => {
    av.remoteBlocked = true;
    renderAv();
  });
}

el.remotePlaceholder.addEventListener("click", () => {
  if (av.remoteBlocked && av.remoteVideo) playRemote();
});

el.avStartBtn.addEventListener("click", async () => {
  if (!peerLink) return;
  el.avStartBtn.disabled = true;
  try {
    // Whatever camera the pre-match check settled on is the one to use here -
    // otherwise picking a camera before the match would be quietly discarded
    // the moment it mattered. Falls back to the browser's default when there
    // is no saved preference, or when startMedia rejects a stale ID.
    const stream = await peerLink.startMedia({
      audio: true,
      video: true,
      cameraId: savedCameraId() || undefined,
      micId: savedMicId() || undefined,
    });
    el.localVideo.srcObject = stream;
    av.on = true;
    av.mic = true;
    av.cam = true;
    // Only now is the device list complete enough to decide whether a switch
    // button is worth showing.
    await refreshCameras();
  } catch (err) {
    console.error(err);
    // mediaErrorMessage distinguishes these because they need completely
    // different fixes: "couldn't start camera" alone sends people hunting
    // through browser settings when the real problem is that the page isn't on
    // HTTPS - the same trap as the Bluetooth button above.
    alert(mediaErrorMessage(err));
  } finally {
    el.avStartBtn.disabled = false;
    renderAv();
  }
});

el.avMicBtn.addEventListener("click", () => {
  av.mic = !av.mic;
  peerLink?.setMediaEnabled({ audio: av.mic });
  renderAv();
});

el.avCamBtn.addEventListener("click", () => {
  av.cam = !av.cam;
  peerLink?.setMediaEnabled({ video: av.cam });
  renderAv();
});

el.avStopBtn.addEventListener("click", () => {
  // stopMedia() drops the second camera too, so this has to forget it as well
  // or the button would offer to "remove" a camera that's already gone.
  peerLink?.stopMedia();
  el.localVideo.srcObject = null;
  el.localVideo2.srcObject = null;
  av.on = false;
  av.second = false;
  av.facingMode = null;
  renderAv();
});

// Wipes the A/V half of the UI back to its opening state. Called when a
// challenge ends, so the next one doesn't start out showing a dead tile and a
// Mute button for a stream that no longer exists.
function resetAv() {
  av.on = false;
  av.mic = true;
  av.cam = true;
  av.second = false;
  av.remoteAudio = false;
  av.remoteVideo = false;
  av.remoteVideo2 = false;
  av.remoteBlocked = false;
  av.cameras = [];
  av.facingMode = null;
  av.stage = "opponent";
  el.localVideo.srcObject = null;
  el.remoteVideo.srcObject = null;
  el.localVideo2.srcObject = null;
  el.remoteVideo2.srcObject = null;
  renderAv();
}

// A webcam plugged in (or unplugged) mid-match changes whether switching is
// possible at all, so the button has to keep up.
navigator.mediaDevices?.addEventListener?.("devicechange", () => {
  if (av.on) refreshCameras();
});

// Coming back from the background is the single most likely moment for a
// camera to have quietly died - on a phone the OS reclaims it, and often
// doesn't hand it back. No event necessarily fires to say so, because the
// page wasn't running to hear one, so the state has to be re-checked here
// rather than waited for.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  peerLink?.recoverCameraIfStalled();
  if (checkVideoStalled()) recoverCheckCamera();
});

function renderAv() {
  // The strip earns its space only once there's something in it - an empty
  // pair of black rectangles above the scoreboard would just be clutter for
  // the players who never use this.
  const remoteActive = av.remoteAudio || av.remoteVideo || av.remoteVideo2;
  const anyone = av.on || remoteActive;
  el.videoStrip.classList.toggle("hidden", !anyone);

  // Immersive only earns its keep once there's actually a picture to put
  // behind the scoring. With no video it would be a black slab with the
  // numbers floating on it, which is strictly worse than the plain layout -
  // so the stacked layout stays the default and this is what video turns on.
  // The staged player's cameras can go dark under you - they switch off, or
  // unplug a second camera - and when that happens the stage moves to the other
  // player rather than dropping the whole immersive layout. Falling all the way
  // back to the stacked layout would throw away a perfectly good picture.
  let staged = SIDE_FEEDS[av.stage].filter(isFeedLive);
  if (!staged.length) {
    const swapped = SIDE_FEEDS[otherSide(av.stage)].filter(isFeedLive);
    if (swapped.length) {
      av.stage = otherSide(av.stage);
      staged = swapped;
    }
  }

  // Immersive only earns its keep once there's actually a picture to put behind
  // the scoring. With no video it would be a black slab with the numbers
  // floating on it, which is strictly worse than the plain layout.
  av.immersive = staged.length > 0;
  el.gamePanel.classList.toggle("immersive", av.immersive);
  // Two staged cameras share the stage 50/50; one takes all of it.
  el.gamePanel.classList.toggle("stage-split", staged.length === 2);

  // The other player's cameras, in the corner. Their MAIN tile is there even
  // when it's dark, because it has something to say - "camera off" and "hasn't
  // started one" are different, and worth telling apart. A board camera has no
  // such empty state: not having one is the normal case, so it appears only
  // when there's a picture in it.
  const thumbSide = otherSide(av.stage);
  const thumbs = av.immersive
    ? SIDE_FEEDS[thumbSide].filter((feed, i) => i === 0 || isFeedLive(feed))
    : [];

  // Symmetric by design: the CSS knows only "the big ones" and "the small
  // ones", so swapping sides is a class change rather than a second layout to
  // maintain. Position within each group is carried as an index class, because
  // these are absolutely positioned and so can't line themselves up (see the
  // .as-stage / .as-thumb rules in index.html).
  for (const feed of [...SIDE_FEEDS.opponent, ...SIDE_FEEDS.self]) {
    const tile = tileFor(feed);
    const stageAt = staged.indexOf(feed);
    const thumbAt = thumbs.indexOf(feed);
    tile.classList.toggle("as-stage", stageAt >= 0);
    tile.classList.toggle("as-thumb", thumbAt >= 0);
    tile.classList.remove("stage-0", "stage-1", "thumb-0", "thumb-1");
    if (stageAt >= 0) tile.classList.add(`stage-${stageAt}`);
    if (thumbAt >= 0) tile.classList.add(`thumb-${thumbAt}`);

    // In immersive, a tile with no place on the stage or in the corner has to
    // go: the strip is a plain block there, so anything left over would render
    // as a stray rectangle on top of the stage rather than politely nowhere.
    const isBoard = feed.endsWith("2");
    tile.classList.toggle(
      "hidden",
      av.immersive ? stageAt < 0 && thumbAt < 0 : isBoard && !isFeedLive(feed)
    );
  }

  el.avViewBtn.textContent = av.stage === "self" ? "🖥 Big view: You" : "🖥 Big view: Opponent";
  // Only worth offering when both players have something to put on the stage.
  el.avViewBtn.classList.toggle(
    "hidden",
    !(SIDE_FEEDS.opponent.some(isFeedLive) && SIDE_FEEDS.self.some(isFeedLive))
  );

  // Adding a second camera needs a spare camera to add. On a one-camera
  // machine the button could only ever disappoint, so it isn't there.
  const canAddSecond = av.on && (av.second || av.cameras.length > 1);
  el.avAddCamBtn.classList.toggle("hidden", !canAddSecond);
  el.avAddCamBtn.textContent = av.second ? "✖ Remove 2nd camera" : "➕ Add 2nd camera";
  // The bottom "501 vs 501" bar is the scoreboard restyled, so it stays in
  // immersive; in the plain layout with tiles up top it would just repeat
  // what the tiles already say.
  el.scoreboard.classList.toggle("hidden", anyone && !av.immersive);

  el.avStartBtn.classList.toggle("hidden", av.on);
  el.avMicBtn.classList.toggle("hidden", !av.on);
  el.avCamBtn.classList.toggle("hidden", !av.on);
  // A switch button on a machine with one camera is a button that can only
  // disappoint, so it only exists when there's somewhere to switch to.
  // A camera being used by the second feed isn't somewhere to switch to, so it
  // doesn't count towards whether switching is possible.
  el.avSwapBtn.classList.toggle("hidden", !(av.on && swappableCameras().length > 1));
  el.avStopBtn.classList.toggle("hidden", !av.on);

  el.localTile.classList.toggle("unmirrored", !shouldMirror(av.facingMode));

  el.avMicBtn.textContent = av.mic ? "🎤 Mute" : "🔇 Unmute";
  el.avMicBtn.classList.toggle("off", !av.mic);
  el.avCamBtn.textContent = av.cam ? "📹 Camera off" : "📹 Camera on";
  el.avCamBtn.classList.toggle("off", !av.cam);

  // Recovering outranks everything: the tile is genuinely blank for a moment
  // and saying why beats letting it look like the freeze that prompted it.
  el.localPlaceholder.classList.toggle("hidden", av.on && av.cam && !av.recovering);
  if (av.recovering) el.localPlaceholder.textContent = "Reconnecting camera…";
  else el.localPlaceholder.textContent = av.on ? "Camera off" : "Camera not started";

  // "Camera off", "hasn't started a camera" and "your browser blocked it" are
  // three different states and worth distinguishing - one means the opponent
  // chose privacy, one means they may not have noticed the feature exists, and
  // one is fixable right here by tapping.
  // Order matters: "they aren't sending video" outranks "your browser blocked
  // playback", because when both are true, tapping would play nothing and the
  // prompt would be a lie.
  const blocked = av.remoteVideo && av.remoteBlocked;
  const remoteVisible = av.remoteVideo && !av.remoteBlocked;
  // Switching into or out of immersive changes which score elements are on
  // screen, so the game render has to follow. Safe from recursion:
  // renderOnline never calls back into here.
  if (online.active) renderOnline();

  el.remotePlaceholder.classList.toggle("hidden", remoteVisible);
  el.remotePlaceholder.classList.toggle("tappable", blocked);
  if (blocked) {
    el.remotePlaceholder.textContent = "▶ Tap to play opponent's video";
  } else if (remoteActive) {
    // Sending something (their mic) but no picture - a choice, not an absence.
    el.remotePlaceholder.textContent = "Opponent's camera is off";
  } else {
    el.remotePlaceholder.textContent = "Waiting for opponent's camera…";
  }
}

renderAv();

function onLocalHit(segment) {
  if (!online.active || online.gameOver) return;
  if (online.activeSide !== "me") {
    showNotice("Not your turn yet - wait for the opponent to finish.");
    return;
  }
  peerLink?.sendGameMessage({ type: "dart", segment });
  applyThrow("me", segment);
}

function onLocalEndTurn() {
  // The board's physical button - ends your turn now without waiting for
  // 3 registered darts (e.g. a dart bounced out or missed the board).
  if (!online.active || online.gameOver) return;
  if (online.activeSide !== "me") {
    showNotice("Not your turn yet - wait for the opponent to finish.");
    return;
  }
  peerLink?.sendGameMessage({ type: "end_turn" });
  endTurn("me");
  renderOnline();
}

function onLocalQuickTotal(totalValue) {
  if (!online.active || online.gameOver) return;
  if (online.activeSide !== "me") {
    showNotice("Not your turn yet - wait for the opponent to finish.");
    return;
  }
  peerLink?.sendGameMessage({ type: "quick_total", value: totalValue });
  applyQuickTotalThrow("me", totalValue);
}

// DartConnect-style whole-turn-total entry. Unlike applyThrow, this always
// finalizes the turn immediately regardless of dartsThisTurn count - see
// quickentry.js for the double-out assumption this makes.
function applyQuickTotalThrow(side, totalValue) {
  if (online.gameOver) return;
  // A turn total says nothing about WHICH numbers were hit, so it has no
  // meaning in cricket. The UI hides it there; this guards the message path.
  if (online.gameType === "cricket") return;
  if (online.activeSide !== side) {
    console.warn(`Ignored an out-of-turn '${side}' turn total.`);
    return;
  }

  const s = online[side];
  const segment = {
    value: totalValue,
    type: SegmentType.Double, // exact-0 entries assume a valid finish
    longName: `Turn total: ${totalValue}`,
  };
  // Entered by someone who watched the darts land, so it's taken at face
  // value: it counts as being "in", and an exact zero is assumed legal under
  // whatever the leg's out rule is.
  s.opened = true;
  const { after, isBust, isWin } = resolveThrow(s.remaining, segment, {
    inRule: "straight",
    outRule: "straight",
    opened: true,
  });

  // A whole-turn total has no single board position to point at.
  if (side === "me") hideMarker(el.dartboardMarker);

  online.log.unshift({
    side,
    label: segment.longName,
    remainingAfter: isBust ? s.startOfTurn : Math.max(after, 0),
    bust: isBust,
  });

  if (isBust) {
    s.remaining = s.startOfTurn;
    endTurn(side);
  } else {
    s.remaining = after;
    if (isWin) {
      finishOnlineLeg(side);
    } else {
      endTurn(side);
    }
  }

  renderOnline();
}

function applyThrow(side, rawSegment) {
  if (online.gameOver) return;

  // Applied here rather than in each engine, and BEFORE the turn check, so
  // both browsers transform the dart identically - the peer receives the raw
  // segment and applies the same leg config to it.
  const segment = applyBullMode(rawSegment, online.legConfig?.bull);

  if (online.activeSide !== side) {
    // Out-of-order message (shouldn't normally happen on an ordered
    // DataChannel) - ignore rather than corrupt state.
    console.warn(`Ignored an out-of-turn '${side}' throw.`);
    return;
  }

  if (online.gameType === "cricket") return applyCricketThrowOnline(side, segment);
  if (online.gameType === "countup") return applyCountUpThrowOnline(side, segment);

  const s = online[side];
  const rules = rulesFor(online.legConfig?.rules);
  const { after, isBust, isWin, opened, ignored } = resolveThrow(s.remaining, segment, {
    inRule: rules.in,
    outRule: rules.out,
    opened: s.opened !== false,
  });
  s.opened = opened;

  // The board is this player's own input surface, so the marker tracks THEIR
  // darts only - the opponent's throws still show in the throw log, but
  // putting them on the same board would make it ambiguous whose last dart
  // the marker represents.
  if (side === "me") moveMarkerTo(el.dartboardMarker, segment);

  s.dartsThisTurn.push(segment);
  online.log.unshift({
    side,
    label: ignored ? `${segment.longName} - not in yet` : segment.longName,
    remainingAfter: isBust ? s.startOfTurn : Math.max(after, 0),
    bust: isBust,
  });

  if (isBust) {
    s.remaining = s.startOfTurn;
    endTurn(side);
  } else {
    s.remaining = after;
    if (isWin) {
      finishOnlineLeg(side);
    } else if (s.dartsThisTurn.length >= 3) {
      endTurn(side);
    }
  }

  renderOnline();
}

// Count Up: every dart adds face value, no bust, nothing to revert. The leg
// isn't decided until BOTH players have thrown their full allocation, so the
// check happens when a turn ends rather than after each dart.
function applyCountUpThrowOnline(side, segment) {
  const player = online[side];
  const result = resolveCountUpThrow(segment);
  applyCountUpResult(player, result);

  if (side === "me") moveMarkerTo(el.dartboardMarker, segment);

  player.dartsThisTurn.push(segment);
  online.log.unshift({
    side,
    label: describeCountUpResult(segment, result),
    remainingAfter: player.total,
    bust: false,
  });

  if (player.dartsThisTurn.length >= 3) {
    player.roundsPlayed += 1;
    const rounds = online.legConfig?.rounds ?? DEFAULT_ROUNDS;
    const players = [online.me, online.opp];
    if (isLegComplete(players, rounds)) {
      const winner = checkCountUpWin(players, rounds);
      finishOnlineLeg(winner === null ? null : (winner === 0 ? "me" : "opp"));
    } else {
      endTurn(side);
    }
  }

  renderOnline();
}

// Cricket needs both players' marks to decide whether a number still scores,
// so it's handed the pair with the thrower first. That ordering is safe
// because the rule only ever asks "have the OTHERS closed this?".
function applyCricketThrowOnline(side, segment) {
  const mine = side === "me";
  const players = mine ? [online.me, online.opp] : [online.opp, online.me];
  const player = players[0];

  const result = resolveCricketThrow(players, 0, segment);
  applyCricketResult(player, result);

  if (mine) moveMarkerTo(el.dartboardMarker, segment);

  player.dartsThisTurn.push(segment);
  online.log.unshift({
    side,
    label: describeCricketResult(segment, result),
    remainingAfter: player.points,
    bust: false,
  });

  if (checkCricketWin(players, 0)) {
    finishOnlineLeg(side);
  } else if (player.dartsThisTurn.length >= 3) {
    endTurn(side);
  }

  renderOnline();
}

function endTurn(side) {
  const s = online[side];
  s.dartsThisTurn = [];
  // Cricket has no bust, so there's no start-of-turn value to revert to.
  if (online.gameType !== "cricket" && online.gameType !== "countup") s.startOfTurn = s.remaining;
  online.activeSide = side === "me" ? "opp" : "me";
}

// ---------- Render ----------
function renderOnline() {
  const cricket = online.gameType === "cricket";
  const countup = online.gameType === "countup";

  // Cricket shows marks; x01 shows a remaining score. Only one at a time.
  el.cricketBoard?.classList.toggle("hidden", !cricket);
  el.manualSection?.classList.toggle("cricket-mode", cricket);
  // Cricket's mark pad lives on the stage, and needs a taller one than the
  // single big number x01 shows.
  el.gamePanel.classList.toggle("cricket-stage", cricket);

  if (cricket) {
    // "me" first so the local player always reads on the left, whichever
    // side of the match they are.
    renderCricketBoard(el.cricketBoard, [online.me, online.opp],
      online.activeSide === "me" ? 0 : 1);
    el.meScore.textContent = online.me.points;
    el.oppScore.textContent = online.opp.points;
  } else if (countup) {
    el.meScore.textContent = online.me.total;
    el.oppScore.textContent = online.opp.total;
  } else {
    el.meScore.textContent = online.me.remaining;
    el.oppScore.textContent = online.opp.remaining;
  }

  const myTurn = online.activeSide === "me" && !online.gameOver;
  const theirTurn = online.activeSide === "opp" && !online.gameOver;
  el.meBox.classList.toggle("active-turn", myTurn);
  el.oppBox.classList.toggle("active-turn", theirTurn);

  // The tiles carry the same scores and the same active-turn ring, so they
  // stand in for the scoreboard when the camera is on.
  el.tileMeScore.textContent = el.meScore.textContent;
  el.tileOppScore.textContent = el.oppScore.textContent;
  el.localTile.classList.toggle("active-turn", myTurn);
  el.remoteTile.classList.toggle("active-turn", theirTurn);
  // Both of a player's tiles carry the ring. Whose turn it is belongs to the
  // player, not to one of their cameras, and ringing only the face tile would
  // read as "this camera is active" instead.
  el.localTile2.classList.toggle("active-turn", myTurn);
  el.remoteTile2.classList.toggle("active-turn", theirTurn);

  // The giant central figure: what the player who is throwing has left. It
  // only means anything in x01 - in Cricket the mark pad IS the display, and
  // a points total in 120px type would say almost nothing about the game.
  const showBig = av.immersive && !cricket && !online.gameOver;
  el.bigScore.classList.toggle("hidden", !showBig);
  if (showBig) {
    el.bigScore.textContent = myTurn ? online.me.remaining : online.opp.remaining;
  }

  renderOnlineMatchBar();

  if (online.gameOver) {
    // Count Up can end level - iWon is null in that case.
    el.turnLabel.textContent = online.iWon === null
      ? "Leg drawn."
      : online.iWon ? "You win the leg! 🎯" : "Opponent takes the leg.";
  } else if (countup) {
    // Rounds left and the running average are the numbers that matter in a
    // practice game.
    const rounds = online.legConfig?.rounds ?? DEFAULT_ROUNDS;
    const p = online.activeSide === "me" ? online.me : online.opp;
    const who = online.activeSide === "me" ? "Your turn" : "Opponent's turn";
    el.turnLabel.textContent =
      `${who} · round ${Math.min(p.roundsPlayed + 1, rounds)} of ${rounds} · avg ${formatAverage(p)}`;
  } else {
    el.turnLabel.textContent = online.activeSide === "me" ? "Your turn" : "Opponent's turn";
  }

  el.turnDarts.innerHTML = "";
  const darts = online.activeSide === "me" ? online.me.dartsThisTurn : online.opp.dartsThisTurn;
  for (let i = 0; i < 3; i++) {
    const slot = document.createElement("div");
    slot.className = "dart-slot" + (darts[i] ? " filled" : "");
    slot.textContent = darts[i] ? darts[i].shortName : "-";
    el.turnDarts.appendChild(slot);
  }

  el.throwLog.innerHTML = "";
  online.log.slice(0, 12).forEach((entry) => {
    const row = document.createElement("div");
    row.className = "log-row" + (entry.bust ? " bust" : "");
    row.textContent = `${entry.side === "me" ? "You" : "Opponent"}: ${entry.label} → ${entry.remainingAfter}`;
    el.throwLog.appendChild(row);
  });

  el.winnerBanner.classList.toggle("hidden", !online.gameOver);
  if (online.gameOver) el.winnerBanner.textContent = onlineBannerText();

  // Manual entry stays clickable at all times - a hard CSS block here was
  // indistinguishable from a bug if the visual state ever fell out of sync
  // with the real turn state. Turn enforcement lives in the handlers, which
  // show an on-screen message if you act out of turn.
  const canAct = online.active && !online.gameOver && online.activeSide === "me";
  el.manualSection.style.opacity = canAct ? "1" : "0.7";
}

// Leg progress and the running leg tally. Hidden entirely for a single game,
// so a one-off match looks exactly as it did before medleys existed.
function renderOnlineMatchBar() {
  if (!el.matchBar) return;
  const match = online.match;
  const multiLeg = match && match.legs.length > 1;

  el.matchBar.classList.toggle("hidden", !multiLeg);
  el.nextLegBtn?.classList.toggle("hidden", !online.legOver);
  if (!multiLeg) return;

  // Names are ordered by absolute index (host first), so they're relabelled
  // from each player's own point of view.
  const names = [];
  names[online.myIndex] = "You";
  names[online.oppIndex] = "Opponent";

  el.matchBar.querySelector(".match-progress").textContent = legProgressText(match);
  el.matchBar.querySelector(".match-score").textContent = matchScoreText(match, names);
}

function onlineBannerText() {
  const match = online.match;
  const names = [];
  names[online.myIndex] = "You";
  names[online.oppIndex] = "Opponent";

  if (match?.over) {
    if (match.drawn) return `Match drawn · ${matchScoreText(match, names)}`;
    const iWonMatch = match.winnerIndex === online.myIndex;
    if (match.legs.length > 1) {
      return `${iWonMatch ? "🏆 You win the match" : "Opponent wins the match"} · ${matchScoreText(match, names)}`;
    }
    return iWonMatch ? "🏆 You win!" : "Opponent wins this one.";
  }

  return `${online.iWon ? "You take" : "Opponent takes"} leg ${match.currentLeg + 1} · ${matchScoreText(match, names)}`;
}
