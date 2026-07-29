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

import { Granboard, SegmentID, SegmentType, createSegment } from "./granboard.js";
import { resolveThrow } from "./scoring.js";
import { createQuickEntry } from "./quickentry.js";

const STARTING_SCORE = 501;

let PeerLink; // lazy-imported so a missing webrtc.js doesn't break local mode
let peerLink = null;
let myBoard = null;

const online = {
  active: false,
  role: null, // 'host' | 'guest'
  activeSide: null, // 'me' | 'opp'
  gameOver: false,
  iWon: null,
  me: { remaining: STARTING_SCORE, startOfTurn: STARTING_SCORE, dartsThisTurn: [] },
  opp: { remaining: STARTING_SCORE, startOfTurn: STARTING_SCORE, dartsThisTurn: [] },
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
  turnLabel: document.getElementById("online-turn-label"),
  turnDarts: document.getElementById("online-turn-darts"),
  winnerBanner: document.getElementById("online-winner-banner"),

  connectBtn: document.getElementById("online-connect-btn"),
  connectionDot: document.getElementById("online-connection-dot"),
  connectionLabel: document.getElementById("online-connection-label"),

  manualSection: document.getElementById("online-manual-section"),
  manualPerdart: document.getElementById("online-manual-perdart"),
  manualQuickTotal: document.getElementById("online-manual-quicktotal"),
  manualRing: document.getElementById("online-manual-ring"),
  manualSections: document.getElementById("online-manual-sections"),
  manualBull: document.getElementById("online-manual-bull"),
  manualDblBull: document.getElementById("online-manual-dblbull"),
  manualMiss: document.getElementById("online-manual-miss"),

  throwLog: document.getElementById("online-throw-log"),
};

// Signaling URL priority: the deployment's own config.json (set once via
// SIGNALING_URL in docker-compose.yml - see docker-entrypoint-config.sh)
// wins if present, since that's the correct address for THIS deployment.
// Falls back to whatever this browser last used, then the hardcoded
// localhost default already in the HTML - this keeps local/no-Docker
// testing (start-granboard.bat) working exactly as before.
const savedUrl = localStorage.getItem("granboard-signaling-url");
if (savedUrl) el.signalingUrl.value = savedUrl;

fetch("./config.json")
  .then((res) => (res.ok ? res.json() : Promise.reject()))
  .then(({ signalingUrl }) => {
    if (signalingUrl) el.signalingUrl.value = signalingUrl;
  })
  .catch(() => {
    // No config.json (e.g. running via start-granboard.bat, no Docker) -
    // that's expected, just keep whatever value is already in the field.
  });

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

// ---------- Create / Join ----------
el.createBtn.addEventListener("click", async () => {
  await ensurePeerLinkLoaded();
  localStorage.setItem("granboard-signaling-url", el.signalingUrl.value);
  peerLink = new PeerLink(el.signalingUrl.value);
  wirePeerLink();

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
  localStorage.setItem("granboard-signaling-url", el.signalingUrl.value);
  peerLink = new PeerLink(el.signalingUrl.value);
  wirePeerLink();

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
  el.waitingPanel.classList.add("hidden");
  el.setupPanel.classList.remove("hidden");
});

async function ensurePeerLinkLoaded() {
  if (!PeerLink) {
    ({ PeerLink } = await import("./webrtc.js"));
  }
}

function wirePeerLink() {
  peerLink.onStatusChange = (status) => {
    el.statusLabel.textContent = statusText(status);

    if (status === "connected" && !online.active) {
      startOnlineGame(peerLink.role);
    }
    if (status === "disconnected" || status === "room-full") {
      if (online.active) {
        el.statusLabel.textContent = "Opponent disconnected.";
      }
    }
  };

  peerLink.onMessage = (msg) => {
    if (msg.type === "dart") {
      applyThrow("opp", msg.segment);
    } else if (msg.type === "end_turn") {
      if (online.activeSide === "opp") {
        endTurn("opp");
        renderOnline();
      }
    } else if (msg.type === "quick_total") {
      applyQuickTotalThrow("opp", msg.value);
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

// ---------- Game start ----------
function startOnlineGame(role) {
  online.active = true;
  online.role = role;
  online.activeSide = role === "host" ? "me" : "opp"; // host throws first
  online.gameOver = false;
  online.iWon = null;
  online.me = { remaining: STARTING_SCORE, startOfTurn: STARTING_SCORE, dartsThisTurn: [] };
  online.opp = { remaining: STARTING_SCORE, startOfTurn: STARTING_SCORE, dartsThisTurn: [] };
  online.log = [];

  el.waitingPanel.classList.add("hidden");
  el.gamePanel.classList.remove("hidden");
  el.winnerBanner.classList.add("hidden");
  renderOnline();
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

function onLocalHit(segment) {
  if (!online.active || online.gameOver) return;
  if (online.activeSide !== "me") {
    console.warn("Ignored a hit - it's not your turn.");
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
    console.warn("Ignored end-turn - it's not your turn.");
    return;
  }
  peerLink?.sendGameMessage({ type: "end_turn" });
  endTurn("me");
  renderOnline();
}

function onLocalQuickTotal(totalValue) {
  if (!online.active || online.gameOver) return;
  if (online.activeSide !== "me") {
    console.warn("Ignored a turn total - it's not your turn.");
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
  if (online.activeSide !== side) {
    console.warn(`Ignored an out-of-turn '${side}' turn total.`);
    return;
  }

  const s = online[side];
  const segment = {
    value: totalValue,
    type: SegmentType.Double, // exact-0 entries assume a valid double-out
    longName: `Turn total: ${totalValue}`,
  };
  const { after, isBust, isWin } = resolveThrow(s.remaining, segment);

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
      online.gameOver = true;
      online.iWon = side === "me";
    } else {
      endTurn(side); // always finalizes, regardless of dartsThisTurn count
    }
  }

  renderOnline();
}

// ---------- Shared scoring application ----------
function applyThrow(side, segment) {
  if (online.gameOver) return;
  if (online.activeSide !== side) {
    // Out-of-order message (shouldn't normally happen on an ordered
    // DataChannel) - ignore rather than corrupt state.
    console.warn(`Ignored an out-of-turn '${side}' throw.`);
    return;
  }

  const s = online[side];
  const { after, isBust, isWin } = resolveThrow(s.remaining, segment);

  s.dartsThisTurn.push(segment);
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
      online.gameOver = true;
      online.iWon = side === "me";
    } else if (s.dartsThisTurn.length >= 3) {
      endTurn(side);
    }
  }

  renderOnline();
}

function endTurn(side) {
  const s = online[side];
  s.dartsThisTurn = [];
  s.startOfTurn = s.remaining;
  online.activeSide = side === "me" ? "opp" : "me";
}

// ---------- Render ----------
function renderOnline() {
  el.meScore.textContent = online.me.remaining;
  el.oppScore.textContent = online.opp.remaining;
  el.meBox.classList.toggle("active-turn", online.activeSide === "me" && !online.gameOver);
  el.oppBox.classList.toggle("active-turn", online.activeSide === "opp" && !online.gameOver);

  el.turnLabel.textContent = online.gameOver
    ? (online.iWon ? "You win! 🎯" : "Opponent wins.")
    : online.activeSide === "me" ? "Your turn" : "Opponent's turn";

  const activeSideState = online[online.activeSide] ?? online.me;
  el.turnDarts.innerHTML = "";
  for (let i = 0; i < 3; i++) {
    const dart = activeSideState.dartsThisTurn[i];
    const slot = document.createElement("div");
    slot.className = "dart-slot" + (dart ? " filled" : "");
    slot.textContent = dart ? dart.shortName : "–";
    el.turnDarts.appendChild(slot);
  }

  el.throwLog.innerHTML = "";
  online.log.slice(0, 20).forEach((entry) => {
    const row = document.createElement("div");
    row.className = "log-row" + (entry.bust ? " bust" : "");
    const who = entry.side === "me" ? "You" : "Opponent";
    row.innerHTML = `<span>${who}</span><span>${entry.label}</span><span>${entry.bust ? "BUST" : entry.remainingAfter}</span>`;
    el.throwLog.appendChild(row);
  });

  el.winnerBanner.classList.toggle("hidden", !online.gameOver);
  if (online.gameOver) {
    el.winnerBanner.textContent = online.iWon ? "🏆 You win!" : "Opponent wins this one.";
  }

  // Only let manual entry apply on your own turn.
  const canAct = online.active && !online.gameOver && online.activeSide === "me";
  document.getElementById("online-manual-section").style.opacity = canAct ? "1" : "0.4";
  document.getElementById("online-manual-section").style.pointerEvents = canAct ? "auto" : "none";
}
