// game.js - 501 scoring, board visualization, and all UI wiring.

import { Granboard, SegmentType, createSegment, SegmentID } from "./granboard.js";
import { resolveThrow } from "./scoring.js";

const STARTING_SCORE = 501;

// Standard dartboard number order, clockwise starting from the top (20).
const BOARD_ORDER = [20, 1, 18, 4, 13, 6, 10, 15, 2, 17, 3, 19, 7, 16, 8, 11, 14, 9, 12, 5];

const state = {
  players: [],
  currentPlayerIndex: 0,
  dartsThisTurn: [],
  startOfTurnRemaining: STARTING_SCORE,
  gameOver: false,
  winnerIndex: null,
  throwLog: [], // {playerName, label, value, remainingAfter, bust}
};

let undoStack = [];
let board = null;

// ---------- DOM references ----------
const el = {
  setupPanel: document.getElementById("setup-panel"),
  gamePanel: document.getElementById("game-panel"),
  playerInputs: document.getElementById("player-inputs"),
  addPlayerBtn: document.getElementById("add-player-btn"),
  startGameBtn: document.getElementById("start-game-btn"),
  connectBtn: document.getElementById("connect-btn"),
  connectionDot: document.getElementById("connection-dot"),
  connectionLabel: document.getElementById("connection-label"),
  playerTabs: document.getElementById("player-tabs"),
  bigScore: document.getElementById("big-score"),
  turnLabel: document.getElementById("turn-label"),
  turnDarts: document.getElementById("turn-darts"),
  undoBtn: document.getElementById("undo-btn"),
  newGameBtn: document.getElementById("new-game-btn"),
  manualSection: document.getElementById("manual-section"),
  manualRing: document.getElementById("manual-ring"),
  manualMiss: document.getElementById("manual-miss"),
  manualBull: document.getElementById("manual-bull"),
  manualDblBull: document.getElementById("manual-dblbull"),
  throwLog: document.getElementById("throw-log"),
  dartboardMarker: document.getElementById("dartboard-marker"),
  winnerBanner: document.getElementById("winner-banner"),
};

// ---------- Setup screen ----------
function addPlayerRow(name = "") {
  const count = el.playerInputs.children.length + 1;
  const row = document.createElement("input");
  row.type = "text";
  row.className = "player-input";
  row.placeholder = `Player ${count}`;
  row.value = name;
  el.playerInputs.appendChild(row);
}

addPlayerRow("Player 1");
addPlayerRow("Player 2");

el.addPlayerBtn.addEventListener("click", () => addPlayerRow());

el.startGameBtn.addEventListener("click", () => {
  const names = [...el.playerInputs.querySelectorAll(".player-input")]
    .map((input, i) => input.value.trim() || `Player ${i + 1}`);

  state.players = names.map((name) => ({ name, remaining: STARTING_SCORE }));
  state.currentPlayerIndex = 0;
  state.dartsThisTurn = [];
  state.startOfTurnRemaining = STARTING_SCORE;
  state.gameOver = false;
  state.winnerIndex = null;
  state.throwLog = [];
  undoStack = [];

  el.setupPanel.classList.add("hidden");
  el.gamePanel.classList.remove("hidden");
  el.winnerBanner.classList.add("hidden");
  render();
});

el.newGameBtn.addEventListener("click", () => {
  el.gamePanel.classList.add("hidden");
  el.setupPanel.classList.remove("hidden");
});

// ---------- Bluetooth connection ----------
el.connectBtn.addEventListener("click", async () => {
  if (!navigator.bluetooth) {
    alert("This browser doesn't support Web Bluetooth. Use Chrome or Edge on desktop.");
    return;
  }

  try {
    el.connectionLabel.textContent = "Connecting…";
    board = await Granboard.connect();
    el.connectionDot.classList.add("connected");
    el.connectionLabel.textContent = `Connected: ${board.deviceName}`;

    board.segmentHitCallback = (segment) => {
      if (segment.id === SegmentID.RESET_BUTTON) {
        // Physical button on the board - confirmed to mean "end my turn now"
        // (useful if you're done before 3 darts register, e.g. a dart
        // bounced out or missed the board entirely).
        endTurnEarly();
        return;
      }
      applyHit(segment);
    };

    board.disconnectCallback = () => {
      el.connectionDot.classList.remove("connected");
      el.connectionLabel.textContent = "Disconnected";
    };
  } catch (err) {
    console.error(err);
    el.connectionLabel.textContent = "Connection failed";
    alert(`Couldn't connect: ${err.message}`);
  }
});

// ---------- Manual entry (for misses/misreads, or testing without a board) ----------
function manualSegmentFromRing(section, ringType) {
  // Reconstruct the same segmentId numbering scheme used in granboard.js:
  // 4 slots per section in order Single(inner), Triple, Single(outer), Double.
  const ringToSlot = { inner: 0, triple: 1, outer: 2, double: 3 };
  const segmentId = (section - 1) * 4 + ringToSlot[ringType];
  return createSegment(segmentId);
}

const manualSectionsContainer = document.getElementById("manual-sections");
for (let section = 1; section <= 20; section++) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "manual-section-btn";
  btn.textContent = section;
  btn.addEventListener("click", () => {
    const ring = el.manualRing.value;
    applyHit(manualSegmentFromRing(section, ring));
  });
  manualSectionsContainer.appendChild(btn);
}

el.manualBull.addEventListener("click", () => applyHit(createSegment(SegmentID.BULL)));
el.manualDblBull.addEventListener("click", () => applyHit(createSegment(SegmentID.DBL_BULL)));
el.manualMiss.addEventListener("click", () => applyHit(createSegment(SegmentID.MISS)));

// ---------- Core scoring ----------
function snapshot() {
  return JSON.parse(JSON.stringify({
    players: state.players,
    currentPlayerIndex: state.currentPlayerIndex,
    dartsThisTurn: state.dartsThisTurn,
    startOfTurnRemaining: state.startOfTurnRemaining,
    gameOver: state.gameOver,
    winnerIndex: state.winnerIndex,
    throwLog: state.throwLog,
  }));
}

function restore(snap) {
  Object.assign(state, snap);
}

function applyHit(segment) {
  if (state.gameOver) return;

  undoStack.push(snapshot());

  const player = state.players[state.currentPlayerIndex];
  const { after, isBust, isWin } = resolveThrow(player.remaining, segment);

  state.dartsThisTurn.push(segment);
  state.throwLog.unshift({
    playerName: player.name,
    label: segment.longName,
    value: segment.value,
    remainingAfter: isBust ? state.startOfTurnRemaining : Math.max(after, 0),
    bust: isBust,
  });

  moveMarkerTo(segment);

  if (isBust) {
    player.remaining = state.startOfTurnRemaining;
    endTurn();
  } else {
    player.remaining = after;
    if (isWin) {
      state.gameOver = true;
      state.winnerIndex = state.currentPlayerIndex;
    } else if (state.dartsThisTurn.length >= 3) {
      endTurn();
    }
  }

  render();
}

function endTurn() {
  state.dartsThisTurn = [];
  state.currentPlayerIndex = (state.currentPlayerIndex + 1) % state.players.length;
  state.startOfTurnRemaining = state.players[state.currentPlayerIndex].remaining;
}

function endTurnEarly() {
  // Manually finalize the current turn (e.g. via the board's physical
  // button) without waiting for 3 registered darts, and without reverting
  // any score - only a bust does that.
  if (state.gameOver) return;
  undoStack.push(snapshot());
  endTurn();
  render();
}

function undo() {
  if (undoStack.length === 0) return;
  restore(undoStack.pop());
  render();
}

el.undoBtn.addEventListener("click", undo);

// ---------- Dartboard visualization ----------
function moveMarkerTo(segment) {
  if (segment.section === "BULL") {
    positionMarker(0, 0);
    return;
  }
  if (segment.section === "Other" || typeof segment.section !== "number") {
    el.dartboardMarker.classList.add("hidden");
    return;
  }

  const index = BOARD_ORDER.indexOf(segment.section);
  const angleDeg = -90 + index * 18;
  const angleRad = (angleDeg * Math.PI) / 180;

  const ringRadius = { inner: 0.38, triple: 0.62, outer: 0.82, double: 0.97 }[segment.ring] ?? 0.7;
  const x = ringRadius * Math.cos(angleRad);
  const y = ringRadius * Math.sin(angleRad);
  positionMarker(x, y);
}

function positionMarker(x, y) {
  // x, y are in range [-1, 1] relative to the board center.
  el.dartboardMarker.classList.remove("hidden");
  el.dartboardMarker.style.left = `${50 + x * 48}%`;
  el.dartboardMarker.style.top = `${50 + y * 48}%`;
}

// ---------- Render ----------
function render() {
  el.playerTabs.innerHTML = "";
  state.players.forEach((p, i) => {
    const tab = document.createElement("div");
    tab.className = "player-tab" + (i === state.currentPlayerIndex ? " active" : "");
    tab.innerHTML = `<span class="player-tab-name">${p.name}</span><span class="player-tab-score">${p.remaining}</span>`;
    el.playerTabs.appendChild(tab);
  });

  const current = state.players[state.currentPlayerIndex];
  el.bigScore.textContent = current.remaining;
  el.turnLabel.textContent = state.gameOver
    ? `${state.players[state.winnerIndex].name} wins! 🎯`
    : `${current.name}'s turn`;

  el.turnDarts.innerHTML = "";
  for (let i = 0; i < 3; i++) {
    const dart = state.dartsThisTurn[i];
    const slot = document.createElement("div");
    slot.className = "dart-slot" + (dart ? " filled" : "");
    slot.textContent = dart ? dart.shortName : "–";
    el.turnDarts.appendChild(slot);
  }

  el.throwLog.innerHTML = "";
  state.throwLog.slice(0, 20).forEach((entry) => {
    const row = document.createElement("div");
    row.className = "log-row" + (entry.bust ? " bust" : "");
    row.innerHTML = `<span>${entry.playerName}</span><span>${entry.label}</span><span>${entry.bust ? "BUST" : entry.remainingAfter}</span>`;
    el.throwLog.appendChild(row);
  });

  el.winnerBanner.classList.toggle("hidden", !state.gameOver);
  if (state.gameOver) {
    el.winnerBanner.textContent = `🏆 ${state.players[state.winnerIndex].name} wins!`;
  }
}
