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

import { SegmentID, SegmentType, createSegment, applyBullMode } from "./granboard.js";
import { subscribeToBoard } from "./boardlink.js";
import { resolveThrow, rulesFor } from "./scoring.js";
import {
  createCricketPlayer, resolveCricketThrow, applyCricketResult,
  checkCricketWin, describeCricketResult,
} from "./cricket.js";
import {
  createBermudaPlayer, bermudaTarget, resolveBermudaThrow, applyBermudaThrow,
  isBermudaRoundOver, endBermudaRound, isBermudaComplete, checkBermudaWin,
  describeBermudaResult, BERMUDA_ROUNDS,
} from "./bermuda.js";
import { createRecorder } from "./matchrecorder.js";
import { recordMatch, getState as accountState } from "./accountstore.js";
import { onMatchReady, reportMatchOver, pushMatchState } from "./lobbyclient.js";
import { getPref, setPref, VISIT_HOLD_MS } from "./prefs.js";
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
import { createMedleyBuilder, recordFormatUsed } from "./medleybuilder.js";
import { renderCheckoutHint, renderLiveAverage } from "./checkouthint.js";
import { cueHit, cueBust, cueCheckout, cueWin, callScore } from "./audio.js";
import { createQuickEntry } from "./quickentry.js";
import { renderDartboard, moveMarkerTo, hideMarker } from "./dartboard.js";

const STARTING_SCORE = 501;

let PeerLink; // lazy-imported so a missing webrtc.js doesn't break local mode
let peerLink = null;

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
  // Records every dart for history and statistics. Each side keeps its own
  // record of the match from its own point of view - there is no shared one,
  // because there is no server in the middle of a peer-to-peer match to hold
  // it. See matchrecorder.js.
  recorder: null,
  // The opponent's display name, learned from their `hello`. Until it arrives
  // (and for a signed-out opponent, forever) they are simply "Opponent" - the
  // scoreboard has always said that, and history says the same rather than
  // inventing a name.
  oppName: "Opponent",
  // ---- Local doubles (docs/team-play.md section 0) ----
  // Two people sharing THIS board, against two sharing theirs. Each end of the
  // connection is a pair, so the peer layer does not change at all: it is still
  // one connection between two boards, and a side is still a side.
  //
  // My partner's name, typed on the setup screen, and theirs, learned from
  // their hello/match_config. Null means that end is one person.
  partnerName: null,
  oppPartnerName: null,
  // Partners is on only when BOTH ends are pairs. A 2 v 1 is a real variant
  // (see section 5) but it is not this one, and quietly playing it when only
  // one side filled the box would mean the two ends disagreed about how many
  // seats the match has - which is a desync, not a feature.
  teams: false,
  // The lobby's code for this match, when it started from a challenge. Null for
  // an invite-code match, which nobody can be watching.
  lobbyCode: null,
  // Which absolute seat opens. Flipped by each rematch so the same player
  // does not always throw first; sent with the offer so both sides agree.
  startSeat: 0,
};

// ---------- DOM ----------
const el = {
  tabLocal: document.getElementById("tab-local"),
  tabOnline: document.getElementById("tab-online"),
  tabAccount: document.getElementById("tab-account"),
  localMode: document.getElementById("local-mode"),
  onlineMode: document.getElementById("online-mode"),
  accountMode: document.getElementById("account-mode"),

  signalingUrl: document.getElementById("signaling-url"),
  createBtn: document.getElementById("create-challenge-btn"),
  joinInput: document.getElementById("join-code-input"),
  joinBtn: document.getElementById("join-challenge-btn"),

  setupPanel: document.getElementById("online-setup-panel"),
  waitingPanel: document.getElementById("online-waiting-panel"),
  gamePanel: document.getElementById("online-game-panel"),
  codeDisplay: document.getElementById("challenge-code-display"),
  waitingTitle: document.getElementById("online-waiting-title"),
  waitingNote: document.getElementById("online-waiting-note"),
  cancelBtn: document.getElementById("cancel-challenge-btn"),

  statusLabel: document.getElementById("online-status-label"),
  meBox: document.getElementById("online-me-box"),
  meLabel: document.getElementById("online-me-label"),
  oppLabel: document.getElementById("online-opp-label"),
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
  checkoutHint: document.getElementById("online-checkout-hint"),
  ocheStat: document.getElementById("online-oche-stat"),
  undoBtn: document.getElementById("online-undo-btn"),
  winnerBanner: document.getElementById("online-winner-banner"),


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
  oppMuteBtn: document.getElementById("online-opp-mute-btn"),
  oppHideBtn: document.getElementById("online-opp-hide-btn"),
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
  rematchRow: document.getElementById("online-rematch-row"),
  rematchBtn: document.getElementById("online-rematch-btn"),
  rematchStatus: document.getElementById("online-rematch-status"),
  rematchChoice: document.getElementById("online-rematch-choice"),
  rematchAccept: document.getElementById("online-rematch-accept"),
  rematchDecline: document.getElementById("online-rematch-decline"),
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
  settingsBtn: document.getElementById("settings-btn"),
  settingsOverlay: document.getElementById("settings-overlay"),
  settingsClose: document.getElementById("settings-close"),
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
// Driven by a table rather than a pair of toggles, because there are now three
// top-level modes and accountui.js adds its own behaviour to one of them.
// Anything that wants to switch mode from elsewhere clicks the tab button
// (accountui.js does exactly that) instead of reaching in here - which keeps
// tab state owned by one place, the way it was when there were only two.
const MODES = {
  local: { tab: el.tabLocal, panel: el.localMode },
  online: { tab: el.tabOnline, panel: el.onlineMode },
  account: { tab: el.tabAccount, panel: el.accountMode },
};

for (const [name, { tab }] of Object.entries(MODES)) {
  // The account tab is absent from older cached HTML, and a missing element
  // shouldn't take the whole module down before a match can start.
  tab?.addEventListener("click", () => switchTab(name));
}

// Which mode is showing. Tracked rather than read back off the DOM so that
// "am I leaving a match?" is answered before anything has moved.
let currentMode = Object.entries(MODES)
  .find(([, { tab }]) => tab?.classList.contains("active"))?.[0] || "local";

// Is a local game in progress? Asked rather than inspected, so this module
// never reaches into game.js's state or its DOM - game.js answers by filling
// in the event it is handed. Synchronous because the answer decides whether a
// tab click happens at all.
function localMatchInProgress() {
  const query = new CustomEvent("aio-query-local-match", { detail: { active: false } });
  document.dispatchEvent(query);
  return query.detail.active;
}

// `ask` is false for switches the player has already committed to elsewhere -
// accepting a lobby challenge is itself the decision to leave whatever you
// were doing, and asking again mid-handoff would be a dialog nobody asked for.
function switchTab(which, { ask = true } = {}) {
  if (which === currentMode) return;
  const from = currentMode;

  // LEAVING A MATCH ENDS IT. A match you have walked away from is over in every
  // sense the other player recognises - and leaving it running in a hidden
  // panel is what made a dead local scoreboard look like a broken online one.
  //
  // But it is destructive, and unlike the End Match button - which arms and
  // needs a second tap - a tab is one click away at all times, including the
  // account chip in the header. So it asks first.
  //
  // A modal, despite the End Match button deliberately avoiding one. That
  // choice was about a control you press WHILE SCORING, where a dialog is in
  // the way. This is navigation, where "leave without saving?" is the expected
  // pattern - and it has to be synchronous, because the answer decides whether
  // the tab switch happens at all.
  const leavingOnline = from === "online" && online.active;
  const leavingLocal = from === "local" && localMatchInProgress();

  if (ask && (leavingOnline || leavingLocal)) {
    const message = leavingOnline
      ? "Leaving ends this match for you and your opponent. Leave anyway?"
      : "Leaving ends this game and it won't be saved. Leave anyway?";
    if (!window.confirm(message)) return;
  }

  currentMode = which;

  // Online is torn down here rather than by an event, because teardownMatch
  // must tell the opponent BEFORE the connection closes or there is nothing
  // left to send it on.
  if (leavingOnline) {
    peerLink?.sendGameMessage({ type: "end_match" });
    teardownMatch("You left the match.");
  }

  // Local play is game.js's to end. Announced rather than called, so the two
  // controllers stay independent - the same reason match chrome is a body
  // class rather than a cross-module call.
  document.dispatchEvent(new CustomEvent("aio-mode-left", { detail: { from, to: which } }));

  for (const [name, { tab, panel }] of Object.entries(MODES)) {
    tab?.classList.toggle("active", name === which);
    panel?.classList.toggle("hidden", name !== which);
  }

  // Remembered for the "where I left off" landing option. Written on every
  // switch rather than on unload: there is no reliable unload on mobile, where
  // the app is most often closed by being swiped away.
  setPref("lastTab", which);
}

// ---------- Where the app opens ----------
//
// A player who only ever plays local darts currently walks past a lobby they
// never use, every single launch; someone who mostly reads their statistics
// wants My Darts. One setting, felt every time the app opens.
//
// Two traps, both load-bearing:
//
//   ask:false - switchTab asks before leaving a match in progress. On boot
//               there cannot be one, and a confirm dialog during startup would
//               be baffling.
//   the account tab does not exist yet - it stays hidden until accountui.js has
//               confirmed there is an accounts API behind it, which is a round
//               trip away. Landing on it has to WAIT for that, and give up
//               gracefully when the answer is no: on the Android build, or with
//               ACCOUNTS=off, that tab never appears at all and the preference
//               must not strand anyone on a blank screen.
function applyLandingPreference() {
  const choice = getPref("landing");
  const target = choice === "last" ? getPref("lastTab") : choice;
  if (!target || target === "local") return; // already where we start

  if (target !== "account") {
    switchTab(target, { ask: false });
    return;
  }

  const tab = el.tabAccount;
  if (!tab) return;
  if (!tab.classList.contains("hidden")) {
    switchTab("account", { ask: false });
    return;
  }

  // Wait for the accounts check, but not forever, and never once the player
  // has started doing something - landing is a preference about the FIRST
  // moment, not a licence to move them later.
  const observer = new MutationObserver(() => {
    if (tab.classList.contains("hidden")) return;
    observer.disconnect();
    clearTimeout(giveUp);
    if (currentMode === "local") switchTab("account", { ask: false });
  });
  observer.observe(tab, { attributes: true, attributeFilter: ["class"] });
  const giveUp = setTimeout(() => observer.disconnect(), 5000);
}

applyLandingPreference();

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
  chips: document.getElementById("online-format-chips"),
});

function selectedOnlineLegs() {
  return onlineMedleyBuilder.getLegs().map(normalizeLeg);
}

// Read once, when the match is about to start, rather than watched: the setup
// panel stays in the DOM behind the game and a rematch does not go back to it,
// so a match must not be able to change shape halfway through because somebody
// tidied the form. Same rule game.js follows for its Partners toggle.
const elPartner = document.getElementById("online-partner");

function readPartnerName() {
  online.partnerName = cleanPartnerName(elPartner?.value);
  return online.partnerName;
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
  readPartnerName();
  await ensurePeerLinkLoaded();
  rememberSignalingOverride();
  peerLink = new PeerLink(currentSignalingUrl(), iceServers);
  wirePeerLink();
  resetAv();

  // Hand the devices back before the match asks for them. Android in
  // particular will not open a camera that the check is still holding, and
  // the preview has no reason to keep running once a match is starting.
  stopDeviceCheck();

  // The code doesn't exist until the server mints it, so the panel opens with
  // an empty one and fills it in below.
  showWaitingPanel("create");

  // GETTING TO THE SERVER IS BOUNDED HERE TOO, even though waiting for an
  // opponent is not. The two were conflated, and create was excluded from the
  // watchdog entirely - one phase too early. Waiting indefinitely for a friend
  // to use the code is the feature; waiting indefinitely for the server to
  // answer is a dead end, because PeerLink's socket open has no timeout of its
  // own, so a socket that neither opens nor errors leaves "Connecting to the
  // signaling server…" on screen for as long as the player is willing to look
  // at it. The clock is cancelled the moment the server answers - see
  // onStatusChange.
  startConnectWatchdog();

  try {
    const code = await peerLink.createChallenge();
    el.codeDisplay.textContent = code;
  } catch (err) {
    stopConnectWatchdog();
    alert(`Couldn't create a challenge: ${err.message}`);
    hideWaitingPanel();
    el.setupPanel.classList.remove("hidden");
  }
});

// A match takes over the tab. The lobby list, the room chat and the
// create/join panel all belong to "between matches" - leaving them on screen
// while a match is up is what made an accepted challenge look like it had done
// nothing, because the invite-code panel was still sitting there underneath.
//
// Driven by a class on <body> rather than by reaching into lobbyui.js, so the
// two modules stay independent: online.js says "a match is on" and the styling
// decides what that hides.
function setMatchChrome(active) {
  document.body.classList.toggle("in-match", Boolean(active));
}

// One panel, three situations, and only one of them is "share this".
//
// Every route into a match goes through the same challenge code, deliberately:
// an accepted lobby challenge mints an ordinary invite code and hands it to
// both sides, so there is ONE connection path rather than a lobby-shaped one
// and an invite-shaped one. That is worth keeping - but it is an
// implementation detail, and showing a lobby player a code with "share this
// with the person you're challenging" invites them to do something pointless
// for a match that is already agreed. Worse, it reads as though the match has
// not started, when in fact both sides are already connecting.
//
// So the mechanism stays and the wording adapts:
//   create - the only case where a human needs the code. Show it, say share it.
//   join   - they already have the code; showing it back confirms they typed
//            the right one, but nobody is sharing anything.
//   lobby  - both players are known. The code is noise; name the opponent
//            instead, which is the thing the player actually cares about.
function showWaitingPanel(mode, { code = "", opponent = "" } = {}) {
  const lobby = mode === "lobby";

  el.waitingTitle.textContent = lobby ? "Starting match…" : "Waiting for opponent…";

  if (lobby) {
    // textContent, never innerHTML - a display name is attacker-controlled and
    // this is exactly the sink that made lobbyui.js a stored XSS once already.
    el.waitingNote.textContent = opponent
      ? `Connecting to ${opponent}…`
      : "Connecting…";
  } else if (mode === "join") {
    el.waitingNote.textContent = "Joining challenge:";
  } else {
    el.waitingNote.textContent = "Share this code with the person you're challenging:";
  }

  el.codeDisplay.textContent = lobby ? "" : code;
  el.codeDisplay.classList.toggle("hidden", lobby);

  waitingMode = mode;
  waitingOpponent = opponent;

  el.setupNotice.classList.add("hidden");
  el.setupPanel.classList.add("hidden");
  el.waitingPanel.classList.remove("hidden");
  setMatchChrome(true);
}

// Which situation the waiting panel is currently showing, and who for. Kept
// because the connection status arrives LATER, from the peer link, and has to
// be phrased differently depending on how the match was started.
let waitingMode = null;
let waitingOpponent = "";

function hideWaitingPanel() {
  waitingMode = null;
  waitingOpponent = "";
  // The class, not this function. Calling itself here recursed until the stack
  // blew, which killed startOnlineGame half way through: the match had already
  // begun, but the panel hiding it never ran and the game panel was never
  // shown, so both players sat on "Connected - starting..." watching a match
  // that had in fact started perfectly.
  el.waitingPanel.classList.add("hidden");
}

// Reports which STAGE the connection has reached, on the panel the player is
// actually looking at.
//
// The stage messages used to go to #online-status-label, which lives inside the
// game panel - hidden until the match starts. So they were written on every
// status change and never once seen during the wait they describe, which is the
// only time they mean anything. Waiting looked identical whether the signaling
// socket was still opening or had been open for twenty seconds with nobody on
// the other end.
//
// Create is deliberately left alone: there the instruction to share the code is
// the useful text, and "waiting for opponent" is not news - it is the entire
// expected state, possibly for several minutes.
function updateWaitingNote(status) {
  if (!waitingMode || waitingMode === "create") return;
  const who = waitingOpponent || "the other player";

  switch (status) {
    case "connecting-to-server":
      el.waitingNote.textContent = "Connecting to the signaling server…";
      break;
    case "joining":
      el.waitingNote.textContent = "Joining the match…";
      break;
    case "waiting-for-opponent":
      el.waitingNote.textContent = waitingMode === "lobby"
        ? `Waiting for ${who} to connect…`
        : "Waiting for the host…";
      break;
    case "connected":
      el.waitingNote.textContent = "Connected - starting…";
      break;
    default:
      break;
  }
}

// A match that never connects used to sit on "Waiting for opponent..." forever,
// with no way to tell whether the other side had failed, gone, or never
// arrived. That is the worst possible failure mode: indistinguishable from
// working, and it wastes the other player's time too.
//
// So the wait is bounded - but only where BOTH players are known to be present
// already, which is the lobby handoff and joining a code someone sent you. It
// deliberately does NOT run on Create Challenge: there the whole point is to
// wait while you send the code to a friend, and timing that out after half a
// minute would break the feature rather than diagnose it.
//
// TWO clocks, because "we never reached the server" and "the server was fine
// and nobody came" are different failures with different fixes, and one timer
// covering both blames whichever it was told to.
//
// The first version armed a single 25s clock on the click. That is wrong on a
// host that sleeps: the free tier spins down after about fifteen minutes, so
// the WebSocket upgrade can take most of that budget on its own, and a match
// that was about to connect got killed and reported as the opponent's fault.
//
// So the signaling phase gets its own, longer budget, and reaching the server
// RESTARTS the clock for the peer phase. Time spent waking a container is no
// longer charged to the player who is patiently waiting.
const SIGNALING_TIMEOUT_MS = 45_000;
const PEER_TIMEOUT_MS = 25_000;
let connectTimer = null;

function startConnectWatchdog(phase = "signaling") {
  clearTimeout(connectTimer);
  const signaling = phase === "signaling";

  connectTimer = setTimeout(() => {
    // `online.active` is set the moment the two sides exchange
    // hello/match_config, so its absence is exactly "we never paired".
    if (online.active) return;

    // Hand the tab back so the player can try again rather than being stranded
    // on a code that will never be used. The diagnosis goes in teardown's
    // notice, not the status line - teardownMatch hides the waiting panel the
    // status line lives on, so anything written there is never read.
    const notice = signaling
      ? `Couldn't reach the signaling server (${currentSignalingUrl()}). ` +
        "It may be starting up, or blocked by a network in between - try again."
      : "Reached the server, but the other player never joined. They may have " +
        "closed the app, or their connection couldn't be established.";

    teardownMatch(notice);

    // Tear down first, then find out whether that message was true. The player
    // gets their tab back immediately either way; the wording catches up.
    if (signaling) refineSignalingNotice(notice);
  }, signaling ? SIGNALING_TIMEOUT_MS : PEER_TIMEOUT_MS);
}

function stopConnectWatchdog() {
  clearTimeout(connectTimer);
  connectTimer = null;
}

// "Couldn't reach the signaling server" is a guess, and on a gated test build
// it is the wrong one: the server is up and has refused the socket for want of
// the site password, which the browser reports as an indistinguishable socket
// error. Being told the server is down sends you looking at the server.
//
// /healthz is the one thing the gate NEVER blocks - it exists so Render can
// tell whether the service is alive - which makes it exactly the right probe.
// If it answers, the server is running and the fault is between us and its
// socket, not the server itself.
//
// The teardown has already happened by the time this resolves; all this does is
// replace the text, and only if the player is still looking at the notice it
// wrote. Anything else means they have moved on and the message is stale.
async function refineSignalingNotice(shown) {
  try {
    const res = await fetch("/healthz", { cache: "no-store" });
    if (!res.ok) return;
  } catch {
    // Genuinely unreachable - the original message was right after all.
    return;
  }
  if (el.setupNotice.textContent !== shown) return;
  el.setupNotice.textContent =
    `This server is up, but the signaling socket wouldn't open (${currentSignalingUrl()}). ` +
    "On a test build the usual cause is the site password having lapsed on this device - " +
    "reload the page, enter it again, and try once more.";
}

// ---------- Starting from the lobby ----------
// A challenge was accepted, and the server has minted a code and told both
// sides which end of it they are. From here this is EXACTLY the invite-code
// path: the host opens the room, the guest joins it, and the existing
// hello/match_config handshake does the rest. The lobby is out of the way.
//
// The one thing carried over is the opponent's name, which the lobby already
// knows - so the saved match names them even if the peer's hello is late.
onMatchReady(async ({ code, role, opponent }) => {
  // A lobby challenge reaches the board by the same peer path an invite code
  // does, so it needs the same reading of the setup panel - and the panel is
  // above the lobby precisely so it is filled in before a challenge is sent.
  readPartnerName();
  await ensurePeerLinkLoaded();
  rememberSignalingOverride();
  peerLink = new PeerLink(currentSignalingUrl(), iceServers);
  wirePeerLink();
  resetAv();
  stopDeviceCheck();

  if (opponent?.displayName) setOpponentName(opponent.displayName);
  online.lobbyCode = code;

  // Make sure the tab the match is about to appear on is the one being looked
  // at - a challenge can be accepted from anywhere in the app. No confirm:
  // accepting the challenge was the decision, and a local game left running
  // is ended by the switch exactly as if the tab had been clicked by hand.
  switchTab("online", { ask: false });

  // No code on screen: both players are already known to each other, and the
  // code is only the room they are about to meet in.
  showWaitingPanel("lobby", { opponent: opponent?.displayName || online.oppName });
  startConnectWatchdog();

  try {
    if (role === "host") await peerLink.createChallenge(code);
    else await peerLink.joinChallenge(code);
  } catch (err) {
    stopConnectWatchdog();
    alert(`Couldn't start that match: ${err.message}`);
    hideWaitingPanel();
    el.setupPanel.classList.remove("hidden");
  }
});

el.joinBtn.addEventListener("click", async () => {
  const code = el.joinInput.value.trim();
  if (!code) return;

  readPartnerName();
  await ensurePeerLinkLoaded();
  rememberSignalingOverride();
  peerLink = new PeerLink(currentSignalingUrl(), iceServers);
  wirePeerLink();
  resetAv();

  // Hand the devices back before the match asks for them. Android in
  // particular will not open a camera that the check is still holding, and
  // the preview has no reason to keep running once a match is starting.
  stopDeviceCheck();

  showWaitingPanel("join", { code: code.toUpperCase() });
  // A code you were given is a code whose host is already sitting in the room,
  // so this side has no legitimate reason to wait indefinitely.
  startConnectWatchdog();

  try {
    await peerLink.joinChallenge(code);
  } catch (err) {
    stopConnectWatchdog();
    alert(`Couldn't join that challenge: ${err.message}`);
    hideWaitingPanel();
    el.setupPanel.classList.remove("hidden");
  }
});

el.cancelBtn.addEventListener("click", () => {
  peerLink?.close();
  peerLink = null;
  resetAv();
  // Cancelling leaves the waiting panel without going through teardownMatch, so
  // the watchdog has to be disarmed here too - otherwise it fires later and
  // drops a "couldn't connect" notice on someone who already walked away.
  stopConnectWatchdog();
  stopHello();
  // A cancelled LOBBY match has to be reported, or the server keeps showing you
  // as playing and nobody can challenge you again. Harmless on the invite-code
  // path, where there is no lobbyCode and the server was never told anything.
  if (online.lobbyCode) {
    online.lobbyCode = null;
    reportMatchOver();
  }
  hideWaitingPanel();
  el.setupPanel.classList.remove("hidden");
  setMatchChrome(false);
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

// How long an opponent may be missing before the match is called off.
//
// A judgement, not a constant with a right answer. ICE blips are usually over
// in two or three seconds; a phone changing wifi for mobile data can take ten.
// Past about fifteen the connection has almost never come back, and by then
// both players have walked to the board and back wondering what is happening -
// so this is long enough to survive a handover and short enough that nobody is
// left staring at a frozen scoreboard.
const PEER_LOST_GRACE_MS = 15000;
let peerLostTimer = null;

function startPeerLostGrace() {
  if (peerLostTimer) return; // already counting; a second drop is the same drop
  peerLostTimer = setTimeout(() => {
    peerLostTimer = null;
    if (online.active) teardownMatch("Opponent disconnected. The match has ended.");
  }, PEER_LOST_GRACE_MS);
}

function stopPeerLostGrace() {
  clearTimeout(peerLostTimer);
  peerLostTimer = null;
}

function disarmEndMatch() {
  clearTimeout(endArmTimeout);
  el.endMatchBtn.dataset.armed = "0";
  el.endMatchBtn.textContent = "End match";
  el.endMatchBtn.classList.remove("armed");
}

function teardownMatch(message) {
  disarmEndMatch();
  clearHold();
  // Before anything else: closing the peer link below fires the status handler
  // again, and a timer left running would tear down whatever comes next.
  stopPeerLostGrace();
  // close() stops the local camera and mic tracks as well as the connection -
  // see the comment at the top of webrtc.js's close().
  peerLink?.close();
  peerLink = null;

  online.active = false;
  online.gameOver = false;
  online.legOver = false;
  online.match = null;
  // An abandoned match is not saved. finishOnlineLeg has already saved and
  // cleared this if the match ran to its end, so anything still here is a
  // match someone walked out of - and half a match would drag every average
  // down with darts that were never a real attempt at a finish.
  online.recorder = null;
  online.oppName = "Opponent";
  online.lobbyCode = null;
  online.startSeat = 0;
  resetRematch();
  stopConnectWatchdog();
  stopHello();

  // The lobby cannot see the darts, so it only knows a match is over because
  // it is told. Purely a hint - a disconnect resolves the same state anyway.
  //
  // Wrapped because everything below this line is the part that hands the tab
  // back: hiding the waiting panel, restoring setup, showing why. An optional
  // notification to a server that may not even be connected must never be able
  // to abort that - a throw here would strand the player on whichever panel
  // they were on, which is the same class of failure as the stuck "in match"
  // state and looks identical to the player.
  try {
    reportMatchOver();
  } catch (err) {
    console.warn("Couldn't tell the lobby the match ended.", err);
  }

  resetAv();

  el.rematchRow?.classList.add("hidden");
  el.gamePanel.classList.add("hidden");
  hideWaitingPanel();
  el.winnerBanner.classList.add("hidden");
  el.setupPanel.classList.remove("hidden");
  el.setupNotice.textContent = message;
  el.setupNotice.classList.remove("hidden");
  setMatchChrome(false);
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
    updateWaitingNote(status);

    // Reaching the server ends the signaling phase. What happens next depends
    // on which side you are:
    //
    //   create - the clock STOPS. Waiting here is the feature, and the code may
    //            sit unshared for minutes. But it has to stop rather than never
    //            have been started, or "the server never answered" is a state
    //            with no way out of it - see the note on the create handler.
    //   others - the clock RESTARTS on the peer phase, so a slow container
    //            wake-up isn't charged against the opponent's budget.
    if ((status === "waiting-for-opponent" || status === "joining")
        && waitingMode && !online.active) {
      if (waitingMode === "create") stopConnectWatchdog();
      else startConnectWatchdog("peer");
    }

    if (status === "connected" && !online.active) {
      // The guest announces itself and the host replies with the format.
      // Doing it in that order removes any race over whether the data
      // channel was open when the config was sent - the host only sends
      // once it has heard from the guest.
      if (peerLink.role === "guest") {
        // The name rides along with the greeting that was already being sent,
        // so learning who you are playing costs no extra round trip. It is
        // optional in both directions: a signed-out player simply doesn't have
        // one, and the match plays identically without it.
        sendHelloUntilStarted();
      }
    }
    // A blip. Say so, and start counting - but do NOT end the match, because
    // ICE reports this for a wifi handover that is usually over in seconds.
    if (status === "peer-lost" && online.active) {
      startPeerLostGrace();
    }

    if (status === "peer-recovered") {
      stopPeerLostGrace();
      if (online.active) el.statusLabel.textContent = "Opponent is back.";
    }

    // Terminal. THE MATCH IS OVER, AND SAYING SO IS THE WHOLE FIX.
    //
    // This used to set a label and nothing else, which left the game panel up,
    // online.active true, and - because teardownMatch is what sends
    // reportMatchOver - the lobby showing the player as still playing forever.
    // The match was dead and every part of the app except the label believed it
    // was live, so they could not be challenged again until they toggled
    // "looking for a game" by hand.
    //
    // online.active guards re-entry: teardownMatch closes the peer link, whose
    // channel-close fires this handler again a moment later.
    if (status === "disconnected" || status === "room-full") {
      stopPeerLostGrace();
      if (online.active) {
        // Both sides stay connected after a match ends, so that a rematch is a
        // handshake rather than a reconnection - which means "they left" and
        // "they left mid-leg" are different events and deserve different words.
        // A finished match is already saved; an abandoned one was never going
        // to be.
        teardownMatch(online.gameOver
          ? "Opponent left after the match ended."
          : "Opponent disconnected. The match has ended.");
      }
    }
  };

  peerLink.onMessage = (msg) => {
    if (msg.type === "hello") {
      // Only the host answers this, and only once.
      if (peerLink.role !== "host" || online.active) return;
      setOpponentName(msg.name);
      // Their end's second player, if they have one. Read BEFORE the match is
      // built, because whether this is a doubles match decides how many seats
      // the recorder is given.
      online.oppPartnerName = cleanPartnerName(msg.partner);
      const legs = selectedOnlineLegs();
      // Only the HOST records this. The guest adopts whatever format it is
      // sent, so remembering it would fill their recents with other people's
      // choices rather than their own.
      recordFormatUsed(legs);
      // The host's own name goes back with the config, so both sides end up
      // knowing each other without a message of their own.
      peerLink.sendGameMessage({
        type: "match_config", legs, name: myDisplayName(), partner: online.partnerName,
      });
      startOnlineGame("host", legs);
      renderOnline();
      return;
    }

    if (msg.type === "match_config") {
      if (online.active) return;
      setOpponentName(msg.name);
      online.oppPartnerName = cleanPartnerName(msg.partner);
      startOnlineGame("guest", msg.legs);
      renderOnline();
      return;
    }

    if (msg.type === "end_match") {
      teardownMatch("Your opponent ended the match.");
      return;
    }

    // ---- Rematch ----
    // The only handshake in the protocol besides the opening one, and it is a
    // handshake for the same reason: BOTH sides have to agree before either
    // starts, or one player's scoreboard changes underneath them for a match
    // they never accepted.
    //
    // The offer carries the legs rather than assuming the last ones, which
    // costs nothing now and is what will let "rematch, but Cricket this time"
    // be a picker rather than a protocol change.
    if (msg.type === "rematch_offer") {
      if (!online.gameOver) return;
      rematch.incoming = normalizeLegList(msg.legs);
      rematch.startSeat = Number(msg.startSeat) === 1 ? 1 : 0;
      renderRematch();
      return;
    }

    if (msg.type === "rematch_accept") {
      // Only meaningful to the side that offered, and only once.
      if (!rematch.offered) return;
      const legs = rematch.offered;
      const startSeat = rematch.startSeat;
      resetRematch();
      beginRematch(legs, startSeat);
      return;
    }

    if (msg.type === "rematch_decline") {
      resetRematch();
      rematch.notice = "Opponent declined the rematch.";
      renderRematch();
      return;
    }

    if (msg.type === "dart") {
      applyThrow("opp", msg.segment);
    } else if (msg.type === "end_turn") {
      // They have finished - either their hold ran out or they cut it short.
      // Either way the wait is over and the backstop timer is no longer needed.
      if (hold && hold.side === "opp") {
        commitAndRender("opp", hold.opts);
      } else if (online.activeSide === "opp") {
        commitTurn("opp");
        renderOnline();
      }
    } else if (msg.type === "undo") {
      // They took a dart back. Roll our copy of it back too, or the two
      // scoreboards disagree from here on. An empty stack means the visit has
      // already ended on this side, which is the same "within the visit" rule
      // their own button enforces - so there is nothing to do rather than
      // something to guess at.
      if (!undoStacks.opp.length) return;
      onlineRestore(undoStacks.opp.pop());
      renderOnline();
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

// The whole handshake hangs off ONE message. The guest says hello, the host
// answers with the format, and both start. If that hello is lost - or is sent
// into a channel the other side isn't listening on yet - neither player sees an
// error: they both sit on "Connected - starting..." indefinitely, which is the
// exact failure this is here to stop.
//
// Repeating it is safe by construction. The host ignores a hello once it is
// already active, so a duplicate is a no-op, and if it was never heard the
// first time then a second copy is precisely what is needed. Bounded, because
// past a few seconds the problem is not a lost message and retrying forever
// would just hide it from the watchdog.
const HELLO_RETRIES = 4;
const HELLO_RETRY_MS = 1500;
let helloTimer = null;

function sendHelloUntilStarted(attempt = 0) {
  clearTimeout(helloTimer);
  if (online.active || !peerLink) return;

  peerLink.sendGameMessage({
    type: "hello", name: myDisplayName(), partner: online.partnerName,
  });

  if (attempt < HELLO_RETRIES) {
    helloTimer = setTimeout(() => sendHelloUntilStarted(attempt + 1), HELLO_RETRY_MS);
  }
}

function stopHello() {
  clearTimeout(helloTimer);
  helloTimer = null;
}

// ---------- Settings ----------
// An overlay, not a tab. Switching tabs ends a match, and the two things in
// here - "does my camera work" and "where is my scorer" - are exactly what
// someone reaches for mid-match. A tab would have needed an exemption from a
// rule that is better kept absolute.
//
// It lives in online.js because the device check does, so closing the sheet can
// release the camera with a direct call rather than an event. game.js's scorer
// panel needs nothing on close: a connected scorer should STAY connected, since
// closing a settings sheet is not a request to unplug your hardware.
function openSettings() {
  el.settingsOverlay?.classList.remove("hidden");
}

function closeSettings() {
  el.settingsOverlay?.classList.add("hidden");
  // THE IMPORTANT LINE. The device check holds a live camera and mic; closing
  // the sheet over it without releasing them leaves the webcam light on with
  // nothing on screen explaining why, which is the moment people stop trusting
  // an app with a camera.
  stopDeviceCheck();
}

el.settingsBtn?.addEventListener("click", openSettings);
el.settingsClose?.addEventListener("click", closeSettings);

// Clicking the backdrop closes it; clicking inside the sheet must not.
el.settingsOverlay?.addEventListener("click", (event) => {
  if (event.target === el.settingsOverlay) closeSettings();
});

// Escape closes it, which is what every dialog on the web does and what people
// try first. Ignored when the sheet is already shut so it cannot swallow the
// key from anything else.
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (el.settingsOverlay?.classList.contains("hidden")) return;
  closeSettings();
});

// ---------- Rematch ----------
// Same opponent, same connection, no signaling and no lobby round trip: when a
// match ends both sides are still connected, so a rematch is a handshake rather
// than a reconnection. That is the whole speed of it.
//
// MUTUAL, ALWAYS. One side offers and nothing happens until the other accepts.
// A one-sided rematch would restart the scoreboard of somebody who had already
// walked away, and they would come back to a match in progress they never
// agreed to.
const rematch = {
  offered: null,   // legs THIS side proposed, waiting on an answer
  incoming: null,  // legs the opponent proposed, waiting on ours
  startSeat: 0,    // who throws first, decided by the offerer so both agree
  notice: "",      // a declined offer, or one that outlived its match
};

function resetRematch() {
  rematch.offered = null;
  rematch.incoming = null;
  rematch.notice = "";
}

// Legs arriving from the peer are normalised the same way match_config's are -
// they crossed a wire, so they are input rather than data.
function normalizeLegList(legs) {
  return Array.isArray(legs) && legs.length ? legs.map(normalizeLeg) : null;
}

el.rematchBtn?.addEventListener("click", () => {
  if (!online.gameOver || rematch.offered) return;

  const legs = online.match?.legs;
  if (!legs?.length) return;

  // Who opens alternates every rematch. Decided HERE and sent, rather than
  // computed on both sides from a counter each maintains alone - two counters
  // that must agree are two counters that can disagree.
  rematch.startSeat = online.startSeat === 0 ? 1 : 0;
  rematch.offered = legs;
  rematch.notice = "";
  peerLink?.sendGameMessage({ type: "rematch_offer", legs, startSeat: rematch.startSeat });
  renderRematch();
});

el.rematchAccept?.addEventListener("click", () => {
  if (!rematch.incoming) return;
  const legs = rematch.incoming;
  const startSeat = rematch.startSeat;
  peerLink?.sendGameMessage({ type: "rematch_accept" });
  resetRematch();
  beginRematch(legs, startSeat);
});

el.rematchDecline?.addEventListener("click", () => {
  if (!rematch.incoming) return;
  peerLink?.sendGameMessage({ type: "rematch_decline" });
  resetRematch();
  rematch.notice = "Rematch declined.";
  renderRematch();
});

// Starts the agreed match on this side. Both sides run this from the same two
// values, which is the determinism guarantee doing its usual work - neither is
// told the resulting state.
function beginRematch(legs, startSeat) {
  online.startSeat = startSeat;
  online.recorder = null; // the finished match was saved and cleared already
  startOnlineGame(online.role, legs);
  renderOnline();
  renderRematch();
}

function renderRematch() {
  if (!el.rematchRow) return;

  // Only once the whole match is decided, and only while still connected.
  const available = Boolean(online.active && online.gameOver && online.match?.over);
  el.rematchRow.classList.toggle("hidden", !available);
  if (!available) return;

  const waiting = Boolean(rematch.offered);
  const asked = Boolean(rematch.incoming);

  el.rematchBtn.classList.toggle("hidden", waiting || asked);
  el.rematchBtn.disabled = waiting;
  el.rematchChoice.classList.toggle("hidden", !asked);

  el.rematchStatus.textContent =
    asked ? `${online.oppName} wants a rematch — same format.`
    : waiting ? "Waiting for your opponent to accept…"
    : rematch.notice;
}

function statusText(status) {
  switch (status) {
    case "connecting-to-server": return "Connecting to signaling server…";
    // Naming the server here is what makes a mismatch diagnosable: two players
    // waiting on DIFFERENT signaling servers both see "waiting", and nothing
    // else on screen distinguishes that from simply being early.
    case "waiting-for-opponent": return `Waiting for opponent… (via ${currentSignalingUrl()})`;
    case "joining": return "Joining challenge…";
    case "connected": return "Connected - good luck!";
    case "peer-lost": return "Opponent's connection dropped - waiting…";
    case "peer-recovered": return "Opponent is back.";
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
      : turnText();
  }, 2200);
}

// ---------- Game start ----------
// Builds one player's state for a leg. x01 and Cricket keep completely
// different shapes, which is why this is a function rather than a literal.
// ---------- Who is playing ----------
// The scoreboard deliberately keeps saying "You" and "Opponent" - that is
// unambiguous mid-match in a way that two similar names are not. These are for
// the saved record, where "beat Opponent" would be useless a month later.
function myDisplayName() {
  return accountState().user?.displayName || null;
}

// The recorder stores absolute seats, the game logic thinks in "me"/"opp".
//
// SEATS ALTERNATE, exactly as they do in local doubles (teams.js): one end of
// the connection holds seats 0 and 2, the other 1 and 3. Sharing that
// convention is what lets a doubles match recorded online and one recorded at
// a single board read back identically - and the alternating order is what
// makes the turn sequence A1 B1 A2 B2 come out right from a plain side flip.
//
// In singles the second seat simply never exists and this returns what it
// always did.
function seatOf(side, throwerIndex = throwerIndexOf(side)) {
  const base = side === "me" ? online.myIndex : online.oppIndex;
  return online.teams ? base + throwerIndex * 2 : base;
}

// "Your turn" is not enough in local doubles: both people on this end are
// "you", and the one thing they need to know is which of them is throwing.
// Named rather than positional, because a pair standing at one board decide
// whose go it is by looking at the screen.
function turnText(side = online.activeSide) {
  if (online.teams) return `${throwerName(side)} to throw`;
  return side === "me" ? "Your turn" : "Opponent's turn";
}

function throwerIndexOf(side) {
  return online[side]?.throwerIndex ?? 0;
}

// The names on one end, in throwing order. One entry in singles, two in local
// doubles.
function throwersOf(side) {
  const s = online[side];
  return s?.throwers?.length ? s.throwers : [sideLabel(side)];
}

// Who is AT THE OCHE on that end right now.
function throwerName(side) {
  const names = throwersOf(side);
  return names[throwerIndexOf(side) % names.length];
}

// What to call that end as a whole: one name, or both joined. "Team 1" would
// be worse - a scoreboard is read by people who know each other's names.
function sideName(side) {
  return throwersOf(side).join(" & ");
}

function sideLabel(side) {
  return side === "me" ? (myDisplayName() || "You") : online.oppName;
}

// A partner name off the wire is someone else's typing, so it is bounded and
// trimmed here rather than trusted - the same treatment the opponent's own
// name already gets. Empty means "that end is one person".
function cleanPartnerName(name) {
  const clean = String(name || "").trim().slice(0, 40);
  return clean || null;
}

function setOpponentName(name) {
  const clean = String(name || "").trim().slice(0, 40);
  if (!clean) return;
  online.oppName = clean;
  // The recorder may already exist by the time this arrives on the host side,
  // so the name is applied to it as well as remembered.
  online.recorder?.setPlayerName(online.oppIndex, clean);
}

function buildOnlinePlayer(name, legConfig) {
  if (legConfig.game === "cricket") return createCricketPlayer(name);
  if (legConfig.game === "countup") return createCountUpPlayer(name);
  if (legConfig.game === "bermuda") return createBermudaPlayer(name);
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
  // BOTH ends must be pairs, or this is singles. Checked here, on both sides,
  // off the rosters they have just exchanged - so the two agree without either
  // being told, in the same way they already agree about who throws first.
  online.teams = Boolean(online.partnerName) && Boolean(online.oppPartnerName);

  // Still 2, because a side IS a team here. This is what makes local doubles
  // nearly free online: the leg tally, "best of five", the clinch and the draw
  // have always counted sides, and a side having two people in it changes
  // nothing about any of them.
  online.match = createMatch(legs, 2);
  online.log = [];

  // Seats are absolute and identical on both sides - one end holds 0 and 2,
  // the other 1 and 3 - so the two recordings of the same match agree about
  // who did what. See seatOf.
  const players = [];
  players[online.myIndex] = {
    displayName: myDisplayName() || "Me", isSelf: true,
    team: online.teams ? online.myIndex : null,
  };
  players[online.oppIndex] = {
    displayName: online.oppName, isSelf: false,
    team: online.teams ? online.oppIndex : null,
  };
  if (online.teams) {
    // A partner is NOT "you", however friendly the arrangement: their darts
    // are theirs, and marking the seat isSelf would put them in your averages.
    players[online.myIndex + 2] = {
      displayName: online.partnerName, isSelf: false, team: online.myIndex,
    };
    players[online.oppIndex + 2] = {
      displayName: online.oppPartnerName, isSelf: false, team: online.oppIndex,
    };
  }
  online.recorder = createRecorder({ mode: "online", format: legs, players });

  stopConnectWatchdog();
  stopHello();
  startOnlineLeg();

  hideWaitingPanel();
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

  // The people on each end, and which of them is at the oche. The SCORE stays
  // on the side, which is the whole reason this variant is cheap online: both
  // partners throw into one 501, or one set of Cricket marks, exactly as the
  // side always has. Only "who threw that" gains a second answer.
  //
  // Reset per leg along with everything else, so each leg opens with the same
  // partner throwing on both ends rather than continuing a rotation the other
  // side cannot see.
  online.me.throwers = online.teams
    ? [myDisplayName() || "You", online.partnerName]
    : [myDisplayName() || "You"];
  online.opp.throwers = online.teams
    ? [online.oppName, online.oppPartnerName]
    : [online.oppName];
  online.me.throwerIndex = 0;
  online.opp.throwerIndex = 0;
  // Undo must never reach back into a finished leg - the same rule game.js
  // applies locally, and here it would also be rewinding a leg the other side
  // has already banked.
  undoStacks.me = [];
  undoStacks.opp = [];
  clearHold();

  // Throw alternates each leg, and both sides compute it from the same
  // absolute index so they never disagree about whose turn it is.
  // Offset by whichever seat opens this match, so a rematch alternates the
  // first throw as well as the legs within it. Both sides hold the same
  // startSeat - it came with the offer - so they agree without being told.
  const starter = startingPlayerForLeg(online.match.currentLeg + online.startSeat, 2);
  online.activeSide = starter === online.myIndex ? "me" : "opp";

  online.gameOver = false;
  online.legOver = false;
  online.iWon = null;

  online.recorder?.startLeg({
    legIndex: online.match.currentLeg,
    game: leg.game,
    x01Start: leg.game === "x01" ? leg.score : null,
    rules: leg.game === "x01" ? (leg.rules || "double") : null,
    bull: leg.bull || null,
    // Bermuda's round count is fixed by its target list rather than chosen, but
    // it is still recorded so a stored match describes itself without the
    // reader having to know the rules module.
    rounds: leg.game === "bermuda" ? BERMUDA_ROUNDS : (leg.rounds ?? null),
  });
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

  // The match, not the leg, and only when you won it. A fanfare for losing is
  // not a feature.
  if (online.match.over && online.iWon) cueWin();

  // A side index IS a team index in a doubles match - one end, one team - so
  // the same number serves both, and the seat is who actually checked out.
  // They are different questions and are recorded as such: the seat marks the
  // visit as a checkout, the team is what the leg belongs to.
  online.recorder?.endLeg(
    online.teams ? (side === null ? null : seatOf(side)) : winnerIndex,
    { winnerTeam: online.teams ? winnerIndex : null },
  );
  broadcastMatchState();

  if (online.match.over && online.recorder) {
    const document = online.recorder.endMatch({
      // In doubles the match was won by a pair, so no single seat won it.
      winnerSeat: online.teams ? null : (online.match.winnerIndex ?? null),
      winnerTeam: online.teams ? (online.match.winnerIndex ?? null) : null,
      drawn: Boolean(online.match.drawn),
    });
    recordMatch(document);
    online.recorder = null;
  }
}

// ---------- My physical board ----------
// There is no connect button here any more. The board is connected once, from
// the header, and boardlink.js hands the darts to whichever mode is playing -
// so a board attached during a local game is still attached when a challenge
// starts, and the other way round. Reconnecting between modes was busywork
// caused by there being two connections; now there is one.
//
// Registered ABOVE game.js's subscriber, so a live online match takes the dart.
// The two controllers never have to know about each other: this one simply
// says whether it is playing, and the answer decides.
subscribeToBoard({
  priority: 10,
  wants: () => online.active && !online.gameOver,
  onHit: (segment) => {
    if (segment.id === SegmentID.RESET_BUTTON) {
      // The board's physical button - ends the turn now, without waiting for
      // three darts to register.
      onLocalEndTurn();
      return;
    }
    onLocalHit(segment);
  },
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
  // MY decision about THEIR media, applied entirely on this machine. Named
  // opp* rather than anything with "blocked" in it because av.remoteBlocked
  // above already means "autoplay was refused", and those two states have
  // nothing to do with each other - one is the browser's doing and one is
  // mine. Not persisted: a new opponent starts from scratch.
  oppMuted: false,  // I have silenced their microphone
  oppHidden: false, // I have cut their cameras
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

// Silencing and cutting the opponent's feeds. Both are instant, both are local,
// and neither tells them - see setRemoteEnabled in webrtc.js for why that
// silence is the point rather than an omission.
el.undoBtn?.addEventListener("click", () => undoOwnDart());

// Ending a visit early - a bounce-out, a dart that missed the board entirely.
// The board's physical button already does this; oche view needs a way to say
// it too, and announces rather than calls so ocheview.js stays ignorant of both
// controllers (the same reason "aio-mode-left" is an event).
document.addEventListener("aio-end-turn", () => {
  if (!online.active || online.gameOver) return;
  if (online.activeSide !== "me") return;
  onLocalEndTurn();
});

el.oppMuteBtn?.addEventListener("click", () => {
  av.oppMuted = !av.oppMuted;
  renderAv();
});

el.oppHideBtn?.addEventListener("click", () => {
  av.oppHidden = !av.oppHidden;
  // If their camera was on the stage, blocking it must not leave the stage
  // showing a tile that is no longer allowed on screen.
  if (av.oppHidden && av.stage === "opponent") av.stage = "self";
  renderAv();
});

// A feed is live when there is a picture in it right now - not merely when the
// camera exists. Everything downstream keys off this: whether immersive earns
// its keep, which tiles are on screen, and what the big view can cycle to.
function isFeedLive(feed) {
  switch (feed) {
    // The opponent's tiles are blocked together: remoteBlocked means this
    // browser refused to start playback, which stops both their pictures.
    // oppHidden is my own decision and outranks everything - if I have cut
    // their cameras, no path through this function may put one back on screen.
    case "opponent": return av.remoteVideo && !av.remoteBlocked && !av.oppHidden;
    case "opponent2": return av.remoteVideo2 && !av.remoteBlocked && !av.oppHidden;
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
  // A new opponent is a new decision. Carrying a block over to whoever you
  // played next would silence a stranger who had done nothing.
  av.oppMuted = false;
  av.oppHidden = false;
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
  // Enforced on the tracks themselves, not just in the layout. A hidden
  // <video> still decodes a live picture and a muted one still receives the
  // audio; disabling the receiver's track is what actually stops it. Applied
  // on every render so it survives a reconnect, a camera being switched on, or
  // anything else that hands us new tracks.
  peerLink?.setRemoteEnabled({ audio: !av.oppMuted, video: !av.oppHidden });
  // Belt and braces: the element carries their audio, and muting it costs
  // nothing if the track disable already did the job.
  el.remoteVideo.muted = av.oppMuted;
  el.oppMuteBtn.textContent = av.oppMuted ? "🔇 Opponent muted" : "🔉 Mute opponent";
  el.oppMuteBtn.classList.toggle("off", av.oppMuted);
  el.oppHideBtn.textContent = av.oppHidden ? "🚫 Camera blocked" : "👁 Block camera";
  el.oppHideBtn.classList.toggle("off", av.oppHidden);
  // Only worth offering once there is something of theirs to silence.
  const anyRemote = av.remoteAudio || av.remoteVideo || av.remoteVideo2;
  el.oppMuteBtn.classList.toggle("hidden", !anyRemote && !av.oppMuted);
  el.oppHideBtn.classList.toggle("hidden", !anyRemote && !av.oppHidden);

  const blocked = av.remoteVideo && av.remoteBlocked && !av.oppHidden;
  const remoteVisible = av.remoteVideo && !av.remoteBlocked && !av.oppHidden;
  // Switching into or out of immersive changes which score elements are on
  // screen, so the game render has to follow. Safe from recursion:
  // renderOnline never calls back into here.
  if (online.active) renderOnline();

  el.remotePlaceholder.classList.toggle("hidden", remoteVisible);
  el.remotePlaceholder.classList.toggle("tappable", blocked);
  if (av.oppHidden) {
    // Says whose doing it is. A tile that simply went dark would read as the
    // opponent having turned their camera off, and the way back would not be
    // obvious.
    el.remotePlaceholder.textContent = "You blocked this camera";
  } else if (blocked) {
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
  // THE HOLD IS NOT A GAP TO THROW INTO. Your visit is complete and only the
  // ten-second undo window is still running, so a dart arriving now was being
  // appended to a visit that had already been scored - which credited the marks
  // to the wrong round and pushed Cricket's MPR past the nine marks three treble
  // beds are worth.
  //
  // Refused here rather than started as a new visit, which is where this parts
  // company with local play, and the reason is the board rather than the rule.
  // The rule is the same in both: a dart thrown after the visit belongs to the
  // NEXT one. In pass-and-play the next visit is at this same board, so the
  // dart is the next player's and is applied to them. Online the opponent
  // throws at their own board, so there is no next visit here to give it to and
  // a fourth dart is a stray one - a bounce-out re-thrown, or one knocked out
  // while pulling. Undo is the honest answer to that, and is exactly what the
  // ten seconds are open for.
  //
  // Before the send, so nothing reaches the peer and the two sides cannot
  // disagree about what was thrown. Peer darts are still applied as sent: the
  // thrower decides what counts as their visit, which is what keeps an older
  // build on the other end in step rather than desynced.
  if (hold && hold.side === "me") {
    showNotice("That visit is over - undo a dart, or wait for the handover.");
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
  // Mid-hold this cuts the wait short; otherwise it ends a visit early - a
  // bounce-out, or a dart that missed the board. finishVisitNow sends the
  // message itself, so it must not be sent twice.
  if (hold && hold.side === "me") {
    finishVisitNow();
    return;
  }
  peerLink?.sendGameMessage({ type: "end_turn" });
  commitTurn("me");
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
  // Same for Bermuda: every round has its own target and missing one halves
  // the score, so a bare total cannot express what happened.
  if (online.gameType === "bermuda") return;
  if (online.activeSide !== side) {
    console.warn(`Ignored an out-of-turn '${side}' turn total.`);
    return;
  }

  // A quick total finalises the whole visit in one go, which makes it the
  // easiest thing in the app to mistype - so it is the last thing that should
  // be unundoable. Same window as a dart.
  undoStacks[side === "me" ? "opp" : "me"] = [];
  undoStacks[side].push(onlineSnapshot());

  const s = online[side];
  const remainingBefore = s.remaining;
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

  online.recorder?.quickTotal(seatOf(side), {
    total: totalValue,
    remainingBefore,
    remainingAfter: isBust ? s.startOfTurn : Math.max(after, 0),
    bust: isBust,
    isCheckout: isWin,
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

// ---------- Undo, online ----------
//
// YOUR OWN DARTS, INSIDE THE VISIT YOU ARE THROWING. That limit is not
// timidity, it is what keeps the determinism guarantee intact. Both browsers
// run the same pure rules in lockstep and there is no authoritative server, so
// a dart rolled back on one side alone is simply two different matches from
// then on. Reaching back past the end of a visit - or into darts the opponent
// has already answered - means rewinding THEIR play too, and there is no
// honest way to do that without asking them.
//
// So the rewind is a snapshot, exactly as local play does it, and it is
// mirrored: whoever threw the dart rolls back their own copy and tells the
// peer, who rolls back their copy of the same dart. Two stacks per machine,
// because each side has to be able to service the other's undo:
//
//   undoStacks.me  - my darts, so I can undo them
//   undoStacks.opp - their darts, so I can apply the undo they send me
//
// Both are pushed in the same order for the same dart on both machines, so
// popping one on each keeps them in step.
const undoStacks = { me: [], opp: [] };

function onlineSnapshot() {
  return {
    ...JSON.parse(JSON.stringify({
      me: online.me,
      opp: online.opp,
      log: online.log,
      activeSide: online.activeSide,
      gameOver: online.gameOver,
      legOver: online.legOver,
      iWon: online.iWon,
    })),
    // Rides in the same snapshot rather than a second stack, for the reason
    // game.js gives: one undo, one rewind, always the same one.
    recorder: online.recorder?.capture() ?? null,
  };
}

function onlineRestore(snap) {
  const { recorder, ...rest } = snap;
  Object.assign(online, rest);
  online.recorder?.restore(recorder);
  // The visit is no longer finished, so nothing should still be counting down
  // towards handing it over. Both sides do this, which is what stops the
  // backstop timer on the receiving side from ending a turn that was undone.
  clearHold();
}

function canUndoOwnDart() {
  // An empty stack IS the "within this visit" rule: endTurn clears it, so
  // anything left in it was thrown during the visit still in progress.
  return Boolean(online.active) && !online.gameOver && undoStacks.me.length > 0;
}

function undoOwnDart() {
  if (!canUndoOwnDart()) return;
  onlineRestore(undoStacks.me.pop());
  // Told, not asked. The peer has no say in whether my misread dart counted,
  // and a round trip would leave the two scoreboards disagreeing in between.
  peerLink?.sendGameMessage({ type: "undo" });
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

  // THROWING CLOSES THE OTHER PLAYER'S WINDOW. This is the boundary, rather
  // than the end of their visit: a dart of theirs can be taken back right up
  // until you answer it, which covers the case that actually happens - three
  // darts land, the third was misread, and it is noticed a second later.
  // Once you have thrown, rewinding their dart would mean rewinding yours too,
  // and there is no honest way to do that without asking you.
  undoStacks[side === "me" ? "opp" : "me"] = [];
  // Before anything is mutated, and before the per-game branches below, so
  // every mode is undoable by the same one line rather than each remembering
  // to do it.
  undoStacks[side].push(onlineSnapshot());

  if (online.gameType === "cricket") return applyCricketThrowOnline(side, segment);
  if (online.gameType === "countup") return applyCountUpThrowOnline(side, segment);
  if (online.gameType === "bermuda") return applyBermudaThrowOnline(side, segment);

  const s = online[side];
  const rules = rulesFor(online.legConfig?.rules);
  const remainingBefore = s.remaining;
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

  online.recorder?.dart(seatOf(side), segment, {
    remainingBefore,
    remainingAfter: isBust ? s.startOfTurn : Math.max(after, 0),
    bust: isBust,
    ignored,
    scored: ignored || isBust ? 0 : segment.value,
  });

  // Only your own darts make a noise. A sound for every throw your opponent
  // takes, on a connection where you may also have their microphone open, is
  // a room nobody wants to be in.
  if (side === "me") {
    cueHit();
    if (isBust) cueBust();
    else if (isWin) cueCheckout();
  }

  if (isBust) {
    s.remaining = s.startOfTurn;
    endTurn(side, { busted: true });
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

  online.recorder?.dart(seatOf(side), segment, {
    scored: result.points,
    extra: { points: result.points, total: player.total },
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

// Bermuda Triangle. Each player is independent - there is no interaction
// between the two, unlike Cricket - so this is the simplest of the online
// paths: apply the dart, and when the third one lands, close the round.
//
// The halving happens inside endBermudaRound on BOTH sides from the same
// inputs, which is the whole reason the rules live in a pure module. Neither
// browser tells the other what someone's score became.
function applyBermudaThrowOnline(side, segment) {
  const player = online[side];
  const target = bermudaTarget(player.round);
  const result = resolveBermudaThrow(segment, target);
  applyBermudaThrow(player, result);

  if (side === "me") moveMarkerTo(el.dartboardMarker, segment);

  player.dartsThisTurn.push(segment);
  online.log.unshift({
    side,
    label: describeBermudaResult(segment, result, target),
    remainingAfter: player.total,
    bust: false,
  });

  online.recorder?.dart(seatOf(side), segment, {
    scored: result.points,
    extra: { target: target?.label ?? null, hit: result.hit, points: result.points },
  });

  if (isBermudaRoundOver(player)) {
    const round = endBermudaRound(player);
    if (round.missed && round.lost > 0) {
      online.log.unshift({
        side,
        label: `Missed ${round.target?.label ?? "the target"} - score halved`,
        remainingAfter: player.total,
        bust: true,
      });
    }

    const players = [online.me, online.opp];
    if (isBermudaComplete(players)) {
      // checkBermudaWin returns null on a tie, which finishOnlineLeg passes
      // through to medley.js as a leg credited to nobody.
      const winner = checkBermudaWin(players);
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

  online.recorder?.dart(seatOf(side), segment, {
    scored: result.points,
    extra: {
      target: result.target,
      marks: result.marks,
      marksApplied: result.marksApplied,
      points: result.points,
      justClosed: result.justClosed,
    },
  });

  if (checkCricketWin(players, 0)) {
    finishOnlineLeg(side);
  } else if (player.dartsThisTurn.length >= 3) {
    endTurn(side);
  }

  renderOnline();
}

// A scoreboard snapshot for anyone watching. Sent at the END of a visit rather
// than per dart: a spectator wants the scoreline, and one object a visit is a
// few hundred bytes where relaying every dart would put the server inside the
// match.
//
// Only the HOST sends. Both sides hold identical state - that is the whole
// determinism guarantee - so a second copy would be pure duplication, and
// picking one avoids two writers racing over the same snapshot.
function broadcastMatchState() {
  if (!online.lobbyCode || online.role !== "host") return;

  const score = (p) =>
    online.gameType === "cricket" ? p.points
    : (online.gameType === "countup" || online.gameType === "bermuda") ? p.total
    : p.remaining;

  pushMatchState(online.lobbyCode, {
    game: online.gameType,
    // Absolute seats, so a watcher reads the same order as the players do.
    scores: { [online.myIndex]: score(online.me), [online.oppIndex]: score(online.opp) },
    legsWon: online.match?.legsWon ?? [],
    activeSeat: online.activeSide === "me" ? online.myIndex : online.oppIndex,
    over: Boolean(online.gameOver),
    at: Date.now(),
  });
}

// ---------- The hold before the turn passes ----------
//
// A completed visit does NOT hand over immediately. It sits for ten seconds
// first, during which the darts are still undoable, and either player can cut
// that short with End turn.
//
// This is what makes undo actually reach the case it was built for. A misread
// is noticed as the third dart lands or on the walk to the board - after the
// visit is technically over - and without the hold the only way to allow that
// was to leave the window open until the opponent threw, which raised the
// question of what happens when they already have. The hold removes the
// question entirely: while it is running it is still your turn, so they
// CANNOT have thrown, and there is nothing to reconcile.
//
// BOTH SIDES HOLD, driven by the thrower. Holding unilaterally would be worse
// than not holding at all: the opponent would believe it was their turn, throw
// into a match that still thinks it is yours, and have the dart rejected as
// out of turn. So the thrower owns the clock and announces the end with the
// `end_turn` message that already exists in the protocol; the receiver waits
// for it, with a grace period as a backstop in case it never comes.
// VISIT_HOLD_MS is shared, from prefs.js - the pause should feel the same in
// both modes, and the two controllers cannot import each other.
//
// THIS ONE IS NOT SHARED, deliberately. It is how long a receiver waits for an
// `end_turn` that never arrived - a peer on an older build, or a message lost
// on a channel that should not lose them - so it is protocol tolerance, not
// comfort. Sharing it would mean that shortening the hold to make
// pass-and-play feel snappier also shortened how much of a network hiccup an
// online match can absorb: a correctness change arriving from a cosmetic edit,
// with nothing in the diff to say so. Ending a turn late beats a match that
// sits still forever.
const PEER_HOLD_GRACE_MS = 8000;

let hold = null; // { side, opts, until, timer, ticker }

function clearHold() {
  if (!hold) return;
  clearTimeout(hold.timer);
  clearInterval(hold.ticker);
  hold = null;
}

export function holdSecondsLeft() {
  if (!hold || hold.side !== "me") return 0;
  return Math.max(0, Math.ceil((hold.until - Date.now()) / 1000));
}

function beginHold(side, opts) {
  clearHold();
  const mine = side === "me";
  hold = {
    side,
    opts,
    until: Date.now() + VISIT_HOLD_MS,
    timer: setTimeout(
      () => (mine ? finishVisitNow() : commitAndRender(side, opts)),
      mine ? VISIT_HOLD_MS : VISIT_HOLD_MS + PEER_HOLD_GRACE_MS
    ),
    // Only the thrower counts down on screen; the other side simply has not
    // been handed the turn yet, which is the truth and needs no clock.
    ticker: mine ? setInterval(() => renderOnline(), 1000) : null,
  };
}

function commitAndRender(side, opts) {
  clearHold();
  commitTurn(side, opts);
  renderOnline();
}

// Manual End turn, the board's physical button, or the hold expiring.
function finishVisitNow() {
  if (!hold) return;
  const { side, opts } = hold;
  clearHold();
  if (side === "me") peerLink?.sendGameMessage({ type: "end_turn" });
  commitTurn(side, opts);
  renderOnline();
}

// Every visit-completing path calls this. It starts the hold rather than
// handing over, so no call site has to know the hold exists.
function endTurn(side, opts = {}) {
  beginHold(side, opts);
  renderOnline();
}

function commitTurn(side, { busted = false } = {}) {
  const s = online[side];
  // Your own visit only, and not on a bust - cueBust has already said what
  // happened, and a total would be a lie.
  if (side === "me" && !busted) {
    callScore(s.dartsThisTurn.reduce((sum, d) => sum + (d?.value || 0), 0));
  }
  // Whose visit is ending, so darts that were thrown but never registered are
  // counted against the right player - and so a visit where all three missed is
  // still recorded, which is a visit that leaves nothing at all behind.
  online.recorder?.endTurn(seatOf(side));
  // Deliberately NOT clearing the undo stack here. A misread is usually
  // spotted as the third dart lands or on the walk to the board, which is
  // after the visit has technically ended - locking it at that moment would
  // make the fix unreachable exactly when it is wanted. The window closes when
  // the OPPONENT throws instead; see applyThrow.
  s.dartsThisTurn = [];
  // Cricket has no bust, so there's no start-of-turn value to revert to.
  // Only x01 has a start-of-turn score to revert a bust to.
  if (online.gameType !== "cricket" && online.gameType !== "countup"
      && online.gameType !== "bermuda") {
    s.startOfTurn = s.remaining;
  }
  // The next visit on THIS end belongs to the other partner. Advancing here,
  // beside the side flip, is what produces the standard doubles order
  // A1 B1 A2 B2 - each end simply alternates its own two, and the sides
  // alternate as they always did.
  //
  // Both ends run this for both sides off the same messages, so neither has to
  // be told whose turn it is within the other pair: it is the determinism
  // guarantee doing the same work it already does for the score.
  if (online.teams) {
    s.throwerIndex = (s.throwerIndex + 1) % (s.throwers?.length || 1);
  }
  online.activeSide = side === "me" ? "opp" : "me";
  broadcastMatchState();
}

// ---------- Render ----------
function renderOnline() {
  const cricket = online.gameType === "cricket";
  const countup = online.gameType === "countup";
  const bermuda = online.gameType === "bermuda";

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
  } else if (countup || bermuda) {
    el.meScore.textContent = online.me.total;
    el.oppScore.textContent = online.opp.total;
  } else {
    el.meScore.textContent = online.me.remaining;
    el.oppScore.textContent = online.opp.remaining;
  }

  // In local doubles the score belongs to the PAIR and the turn belongs to one
  // of them, so the label carries both: the pair's names, and who is at the
  // oche. Taken from the reference machines, which name the thrower large over
  // the team small - it is the one piece of information a doubles scoreboard
  // has that a singles one does not, and it costs no layout.
  if (el.meLabel) {
    el.meLabel.textContent = online.teams
      ? `${throwerName("me")} · ${sideName("me")}`
      : "You";
  }
  if (el.oppLabel) {
    el.oppLabel.textContent = online.teams
      ? `${throwerName("opp")} · ${sideName("opp")}`
      : online.oppName;
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
    const thrower = myTurn ? online.me : online.opp;
    // Bermuda and Count Up count up; x01 counts down.
    el.bigScore.textContent = (countup || bermuda) ? thrower.total : thrower.remaining;
  }

  // Only ever for your OWN score. Telling you how your opponent gets out is
  // not help, it is a scoreboard reading their mind, and it would be showing
  // during their visit when you have nothing to throw at anyway.
  // Offered only while there is something to take back. Shown rather than
  // disabled-and-greyed, because a permanently visible undo on a scoreboard
  // invites a tap that does nothing.
  el.undoBtn?.classList.toggle("hidden", !canUndoOwnDart());

  // My own seat only. The opponent's average is not mine to put on screen.
  renderLiveAverage(el.ocheStat, online.recorder?.liveStats(online.myIndex));
  renderCheckoutHint(el.checkoutHint, {
    on: !cricket && !countup && !bermuda && !online.gameOver && myTurn,
    remaining: online.me?.remaining,
    dartsLeft: 3 - (online.me?.dartsThisTurn?.length || 0),
    rules: online.legConfig?.rules,
    bull: online.legConfig?.bull,
  });

  renderOnlineMatchBar();

  if (online.gameOver) {
    // Count Up can end level - iWon is null in that case.
    el.turnLabel.textContent = online.iWon === null
      ? "Leg drawn."
      : online.teams
        ? `${online.iWon ? sideName("me") : sideName("opp")} take the leg`
        : online.iWon ? "You win the leg! 🎯" : "Opponent takes the leg.";
  } else if (bermuda) {
    // The current target is the whole state of a Bermuda turn - without it on
    // screen there is nothing to aim at. Shown for whoever is throwing, since
    // the two players are on their own rounds and can be on different targets.
    const p = online.activeSide === "me" ? online.me : online.opp;
    const who = turnText();
    const target = bermudaTarget(p.round);
    el.turnLabel.textContent =
      `${who} · round ${Math.min(p.round + 1, BERMUDA_ROUNDS)} of ${BERMUDA_ROUNDS}` +
      ` · throw at ${target?.label ?? "-"}`;
  } else if (countup) {
    // Rounds left and the running average are the numbers that matter in a
    // practice game.
    const rounds = online.legConfig?.rounds ?? DEFAULT_ROUNDS;
    const p = online.activeSide === "me" ? online.me : online.opp;
    const who = turnText();
    el.turnLabel.textContent =
      `${who} · round ${Math.min(p.roundsPlayed + 1, rounds)} of ${rounds} · avg ${formatAverage(p)}`;
  } else {
    el.turnLabel.textContent = turnText();
  }

  // The hold, said plainly. Without a countdown a ten second pause reads as
  // the app having frozen, and the whole point of it - that there is still
  // time to take a dart back - would go unnoticed.
  const left = holdSecondsLeft();
  if (left > 0) {
    el.turnLabel.textContent = `Visit over - ${left}s to undo · End turn to skip`;
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
  renderRematch();

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
  // The leg tally is indexed by SIDE, and a side is a pair in local doubles -
  // so it is named as one. "You" stays for singles, where it is still true.
  const names = [];
  names[online.myIndex] = online.teams ? sideName("me") : "You";
  names[online.oppIndex] = online.teams ? sideName("opp") : "Opponent";

  if (match?.over) {
    if (match.drawn) return `Match drawn · ${matchScoreText(match, names)}`;
    const iWonMatch = match.winnerIndex === online.myIndex;
    if (match.legs.length > 1) {
      const who = online.teams
        ? `${names[iWonMatch ? online.myIndex : online.oppIndex]} win the match`
        : (iWonMatch ? "You win the match" : "Opponent wins the match");
      return `${iWonMatch ? "🏆 " : ""}${who} · ${matchScoreText(match, names)}`;
    }
    if (online.teams) {
      return iWonMatch
        ? `🏆 ${names[online.myIndex]} win!`
        : `${names[online.oppIndex]} win this one.`;
    }
    return iWonMatch ? "🏆 You win!" : "Opponent wins this one.";
  }

  const taker = online.teams
    ? `${names[online.iWon ? online.myIndex : online.oppIndex]} take`
    : (online.iWon ? "You take" : "Opponent takes");
  return `${taker} leg ${match.currentLeg + 1} · ${matchScoreText(match, names)}`;
}
