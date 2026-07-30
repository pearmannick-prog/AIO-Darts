// game.js - 501 scoring, board visualization, and all UI wiring.

import { Granboard, SegmentType, createSegment, SegmentID } from "./granboard.js";
import { resolveThrow } from "./scoring.js";
import { createQuickEntry } from "./quickentry.js";
import { renderDartboard, moveMarkerTo as moveMarker, hideMarker } from "./dartboard.js";
import {
  createMatch, currentGameType, recordLegWin, advanceLeg,
  startingPlayerForLeg, matchScoreText, legProgressText, gameLabel,
} from "./medley.js";
import {
  CRICKET_TARGETS, createCricketPlayer, resolveCricketThrow, applyCricketResult,
  checkCricketWin, describeCricketResult, markSymbol, targetLabel, isClosedBy,
  isTargetDead,
} from "./cricket.js";

const STARTING_SCORE = 501;

const state = {
  gameType: "501", // "501" | "cricket" - the CURRENT leg's game
  match: null,     // see medley.js; a single game is a one-leg match
  legOver: false,  // leg decided but match still running - waiting for "Next leg"
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
  manualPerdart: document.getElementById("manual-perdart"),
  manualQuickTotal: document.getElementById("manual-quicktotal"),
  manualRing: document.getElementById("manual-ring"),
  manualMiss: document.getElementById("manual-miss"),
  manualBull: document.getElementById("manual-bull"),
  manualDblBull: document.getElementById("manual-dblbull"),
  throwLog: document.getElementById("throw-log"),
  dartboardMarker: document.getElementById("dartboard-marker"),
  medleyLegs: document.getElementById("medley-legs"),
  addLegBtn: document.getElementById("add-leg-btn"),
  medleyPreset: document.getElementById("medley-preset"),
  matchBar: document.getElementById("match-bar"),
  nextLegBtn: document.getElementById("next-leg-btn"),
  cricketBoard: document.getElementById("cricket-board"),
  scoreBlock: document.getElementById("score-block"),
  winnerBanner: document.getElementById("winner-banner"),
  // Scoped to #local-mode: there are now two boards on the page (local and
  // online), and an unscoped ".dartboard" would silently match whichever
  // appears first in the HTML.
  dartboardEl: document.querySelector("#local-mode .dartboard"),
};

// Clicking a segment on the board scores it directly - the same applyHit
// path a real Bluetooth hit or the manual-entry grid uses, so undo, bust
// detection, and the hit marker all work identically either way.
renderDartboard(el.dartboardEl, (segmentId) => {
  if (state.players.length === 0 || state.gameOver) return;
  applyHit(createSegment(segmentId));
});

// ---------- Manual entry mode sub-tabs (Per-Dart vs Quick Total) ----------
el.manualSection.querySelectorAll(".entry-mode-tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    const mode = tab.dataset.mode;
    el.manualSection.querySelectorAll(".entry-mode-tab").forEach((t) => t.classList.toggle("active", t === tab));
    el.manualPerdart.classList.toggle("hidden", mode !== "perdart");
    el.manualQuickTotal.classList.toggle("hidden", mode !== "quicktotal");
  });
});

createQuickEntry(el.manualQuickTotal, applyQuickTotal);

// ---------- Setup screen ----------
// One player is allowed - solo practice is a real use case, and both game
// types support it (cricket keeps scoring with no opponent to close numbers
// out, and a solo medley plays every leg rather than clinching after the
// first). Zero players isn't a game, so removal stops at one.
const MIN_PLAYERS = 1;

function addPlayerRow(name = "") {
  const count = el.playerInputs.children.length + 1;
  const row = document.createElement("div");
  row.className = "player-row";
  // The input keeps the .player-input class it always had, so everything that
  // reads player names by that selector still works unchanged.
  row.innerHTML = `
    <input type="text" class="player-input" placeholder="Player ${count}">
    <button type="button" class="player-remove" title="Remove this player">&times;</button>`;
  row.querySelector(".player-input").value = name;
  el.playerInputs.appendChild(row);
  refreshPlayerRows();
}

// Renumbers the placeholders after a removal - otherwise deleting player 2
// leaves "Player 1" next to "Player 3" - and hides the remove buttons at the
// minimum, the same way the medley builder hides them at one leg.
function refreshPlayerRows() {
  const rows = [...el.playerInputs.querySelectorAll(".player-row")];
  rows.forEach((row, i) => {
    row.querySelector(".player-input").placeholder = `Player ${i + 1}`;
  });
  el.playerInputs.classList.toggle("at-minimum", rows.length <= MIN_PLAYERS);
}

addPlayerRow("Player 1");
addPlayerRow("Player 2");

el.addPlayerBtn.addEventListener("click", () => addPlayerRow());

el.playerInputs.addEventListener("click", (event) => {
  if (!event.target.classList.contains("player-remove")) return;
  if (el.playerInputs.querySelectorAll(".player-row").length <= MIN_PLAYERS) return;
  event.target.closest(".player-row").remove();
  refreshPlayerRows();
});

el.startGameBtn.addEventListener("click", () => {
  const names = [...el.playerInputs.querySelectorAll(".player-input")]
    .map((input, i) => input.value.trim() || `Player ${i + 1}`);

  state.match = createMatch(readMedleyLegs(), names.length);
  state.playerNames = names;
  startLeg(names);
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

// ---------- Medley builder ----------
// A match is just an ordered list of games. One row is an ordinary single
// game, so there's no "enable medley" switch to find - adding a second leg is
// what turns it into one.
const MEDLEY_PRESETS = {
  "single-501": ["501"],
  "single-cricket": ["cricket"],
  bo3: ["501", "cricket", "501"],
  bo5: ["501", "cricket", "501", "cricket", "501"],
};

function renderMedleyBuilder(legs) {
  if (!el.medleyLegs) return;
  el.medleyLegs.innerHTML = legs.map((game, i) => `
    <div class="leg-row">
      <span class="leg-label">Leg ${i + 1}</span>
      <select class="leg-game">
        <option value="501"${game === "501" ? " selected" : ""}>${gameLabel("501")}</option>
        <option value="cricket"${game === "cricket" ? " selected" : ""}>${gameLabel("cricket")}</option>
      </select>
      <button type="button" class="leg-remove" title="Remove this leg">&times;</button>
    </div>`).join("");
  // With one leg there's nothing to remove - hide rather than let someone
  // delete their way to a match with no games in it.
  el.medleyLegs.classList.toggle("single", legs.length <= 1);
}

// Changing a leg's game by hand means the preset no longer describes the
// match, so the dropdown falls back to "Custom" rather than lying.
function markCustomIfNeeded() {
  const legs = readMedleyLegs();
  const match = Object.entries(MEDLEY_PRESETS)
    .find(([, preset]) => preset.length === legs.length && preset.every((g, i) => g === legs[i]));
  if (el.medleyPreset) el.medleyPreset.value = match ? match[0] : "custom";
}

el.medleyPreset?.addEventListener("change", () => {
  const preset = MEDLEY_PRESETS[el.medleyPreset.value];
  if (preset) renderMedleyBuilder(preset);
});

el.addLegBtn?.addEventListener("click", () => {
  const legs = readMedleyLegs();
  // Repeat the pattern rather than always appending 501 - in an alternating
  // medley the next leg is almost always the other game.
  const next = legs.length >= 2 ? legs[legs.length - 2] : (legs[0] === "501" ? "cricket" : "501");
  renderMedleyBuilder([...legs, next]);
  markCustomIfNeeded();
});

el.medleyLegs?.addEventListener("click", (event) => {
  if (!event.target.classList.contains("leg-remove")) return;
  const legs = readMedleyLegs();
  if (legs.length <= 1) return;
  const index = [...el.medleyLegs.querySelectorAll(".leg-row")].indexOf(event.target.closest(".leg-row"));
  legs.splice(index, 1);
  renderMedleyBuilder(legs);
  markCustomIfNeeded();
});

el.medleyLegs?.addEventListener("change", (event) => {
  if (event.target.classList.contains("leg-game")) markCustomIfNeeded();
});

renderMedleyBuilder(["501"]);

// Reads the medley builder into a plain list of game types. One row is a
// normal single game - there's no separate "single vs medley" mode.
function readMedleyLegs() {
  const selects = el.medleyLegs?.querySelectorAll(".leg-game") || [];
  const legs = [...selects].map((sel) => (sel.value === "cricket" ? "cricket" : "501"));
  return legs.length ? legs : ["501"];
}

// Sets up a fresh leg: new scores, but names and the match tally carry over.
// The throw alternates each leg so the same player isn't always first.
function startLeg(names) {
  state.gameType = currentGameType(state.match);
  state.players = state.gameType === "cricket"
    ? names.map((name) => createCricketPlayer(name))
    : names.map((name) => ({ name, remaining: STARTING_SCORE }));
  state.currentPlayerIndex = startingPlayerForLeg(state.match.currentLeg, names.length);
  state.dartsThisTurn = [];
  state.startOfTurnRemaining = STARTING_SCORE;
  state.gameOver = false;
  state.legOver = false;
  state.winnerIndex = null;
  state.throwLog = [];
}

// Called whenever a leg is won. Decides whether that also ends the match.
// gameOver stays true either way so no further darts register until the
// player moves on.
function finishLeg(winnerIndex) {
  state.gameOver = true;
  state.winnerIndex = winnerIndex;
  recordLegWin(state.match, winnerIndex);
  // A one-leg match is over the moment the leg is - nothing to advance to.
  state.legOver = !state.match.over;
}

function applyHit(segment) {
  if (state.gameOver) return;

  if (state.gameType === "cricket") return applyCricketHit(segment);

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

  moveMarker(el.dartboardMarker, segment);

  if (isBust) {
    player.remaining = state.startOfTurnRemaining;
    endTurn();
  } else {
    player.remaining = after;
    if (isWin) {
      finishLeg(state.currentPlayerIndex);
    } else if (state.dartsThisTurn.length >= 3) {
      endTurn();
    }
  }

  render();
}

// DartConnect-style whole-turn-total entry. Unlike applyHit, this always
// finalizes the turn immediately - it represents all of that turn's darts
// collapsed into one number, not a single dart, so there's no "wait for 3"
// step. See quickentry.js for the double-out assumption this makes.
function applyQuickTotal(totalValue) {
  if (state.gameOver) return;
  // A whole-turn total is meaningless in cricket - what matters is WHICH
  // numbers were hit, not what they added up to. The UI hides this mode in
  // cricket; this guard is here in case it's reached another way.
  if (state.gameType === "cricket") return;

  undoStack.push(snapshot());

  const player = state.players[state.currentPlayerIndex];
  const segment = {
    value: totalValue,
    type: SegmentType.Double, // see quickentry.js: exact-0 entries assume a valid double-out
    longName: `Turn total: ${totalValue}`,
    shortName: `${totalValue}`,
    ring: "quick",
    section: "Other",
  };
  const { after, isBust, isWin } = resolveThrow(player.remaining, segment);

  state.throwLog.unshift({
    playerName: player.name,
    label: segment.longName,
    value: segment.value,
    remainingAfter: isBust ? state.startOfTurnRemaining : Math.max(after, 0),
    bust: isBust,
  });

  hideMarker(el.dartboardMarker); // no single position to show for a turn total

  if (isBust) {
    player.remaining = state.startOfTurnRemaining;
    endTurn();
  } else {
    player.remaining = after;
    if (isWin) {
      finishLeg(state.currentPlayerIndex);
    } else {
      endTurn(); // always finalizes, regardless of dartsThisTurn count
    }
  }

  render();
}

// Draws the marks grid the way it's chalked on a real board: a row per
// number, a column per player, slashes building to a circled X. A number
// everyone has closed is greyed out - it's dead and worth nothing, which is
// otherwise easy to miss mid-game.
// Shows which leg is in progress and the running leg tally. Hidden entirely
// for a single game, so a normal one-off match looks exactly as it did before
// medleys existed.
function renderMatchBar() {
  if (!el.matchBar) return;
  const match = state.match;
  const multiLeg = match && match.legs.length > 1;

  el.matchBar.classList.toggle("hidden", !multiLeg);
  el.nextLegBtn?.classList.toggle("hidden", !state.legOver);

  if (!multiLeg) return;

  const names = state.players.map((p) => p.name);
  el.matchBar.querySelector(".match-progress").textContent = legProgressText(match);
  el.matchBar.querySelector(".match-score").textContent = matchScoreText(match, names);
}

// Winner banner has to cover three different endings: leg won with more to
// play, match won, and a drawn match (possible with an even number of legs).
function winnerBannerText() {
  const match = state.match;
  const names = state.players.map((p) => p.name);

  if (match?.over) {
    if (match.drawn) return `Match drawn ${matchScoreText(match, names)}`;
    const winner = names[match.winnerIndex] ?? "Winner";
    return match.legs.length > 1
      ? `🏆 ${winner} wins the match ${matchScoreText(match, names)}`
      : `🏆 ${winner} wins!`;
  }

  const legWinner = names[state.winnerIndex] ?? "Winner";
  return `${legWinner} takes leg ${match.currentLeg + 1} · ${matchScoreText(match, names)}`;
}

el.nextLegBtn?.addEventListener("click", () => {
  if (!state.legOver) return;
  advanceLeg(state.match);
  startLeg(state.playerNames);
  undoStack = []; // undo must not reach back into a finished leg
  el.winnerBanner.classList.add("hidden");
  render();
});

function renderCricketBoard() {
  if (!el.cricketBoard) return;

  // DartConnect-style layout: the targets run down the centre with D and T
  // buttons either side, and each player's marks sit in a flanking column.
  // Players are split around the centre so two players read as the familiar
  // left-vs-right board; three or four still work, just unevenly split.
  const half = Math.ceil(state.players.length / 2);
  const left = state.players.map((p, i) => ({ p, i })).slice(0, half);
  const right = state.players.map((p, i) => ({ p, i })).slice(half);

  const side = (group, cls) => `<div class="ck-side ${cls}">` +
    group.map(({ p, i }) =>
      `<div class="ck-col${i === state.currentPlayerIndex ? " active" : ""}">
         <div class="ck-name">${p.name}</div>
         <div class="ck-points">${p.points}</div>
       </div>`).join("") + `</div>`;

  const marksFor = (group, target) => `<div class="ck-side">` +
    group.map(({ p }) =>
      `<div class="ck-mark${isClosedBy(p, target) ? " closed" : ""}">${markSymbol(p.marks[target] || 0)}</div>`
    ).join("") + `</div>`;

  const rows = CRICKET_TARGETS.map((target) => {
    const dead = isTargetDead(state.players, target);
    // There is no triple bull on a real board, so that button is disabled
    // rather than quietly scoring something wrong.
    const noTriple = target === "BULL";
    return `<div class="ck-row${dead ? " dead" : ""}">
      ${marksFor(left, target)}
      <div class="ck-controls">
        <button type="button" class="ck-mod" data-target="${target}" data-mult="2">D</button>
        <button type="button" class="ck-num" data-target="${target}" data-mult="1">${targetLabel(target)}</button>
        <button type="button" class="ck-mod${noTriple ? " ck-disabled" : ""}" data-target="${target}" data-mult="3"${noTriple ? " disabled" : ""}>T</button>
      </div>
      ${marksFor(right, target)}
    </div>`;
  }).join("");

  el.cricketBoard.innerHTML =
    `<div class="ck-row ck-header">
       ${side(left, "ck-left")}
       <div class="ck-controls"></div>
       ${side(right, "ck-right")}
     </div>` +
    rows +
    `<div class="ck-row ck-footer">
       <div class="ck-side"></div>
       <div class="ck-controls">
         <button type="button" class="ck-miss" data-target="MISS" data-mult="0">Miss</button>
       </div>
       <div class="ck-side"></div>
     </div>`;
}

// One delegated listener rather than rebinding every button on each render -
// the grid is rewritten after every dart.
el.cricketBoard?.addEventListener("click", (event) => {
  const btn = event.target.closest("[data-target]");
  if (!btn || btn.disabled) return;
  if (state.gameType !== "cricket" || state.gameOver) return;

  const target = btn.dataset.target;
  const mult = Number(btn.dataset.mult);

  if (target === "MISS") {
    applyHit(createSegment(SegmentID.MISS));
    return;
  }

  // Rebuild the same segment ID the board or the clickable dartboard would
  // produce, so every input path lands in the identical scoring code.
  if (target === "BULL") {
    applyHit(createSegment(mult === 2 ? SegmentID.DBL_BULL : SegmentID.BULL));
    return;
  }

  const section = Number(target);
  const slot = mult === 3 ? 1 : mult === 2 ? 3 : 0; // triple / double / single
  applyHit(createSegment((section - 1) * 4 + slot));
});

// Cricket's turn structure is simpler than 501's: there's no bust and no
// start-of-turn value to revert to, so a turn is just three darts. All the
// rules live in cricket.js - this only applies the result and advances.
function applyCricketHit(segment) {
  undoStack.push(snapshot());

  const player = state.players[state.currentPlayerIndex];
  const result = resolveCricketThrow(state.players, state.currentPlayerIndex, segment);
  applyCricketResult(player, result);

  state.dartsThisTurn.push(segment);
  state.throwLog.unshift({
    playerName: player.name,
    label: describeCricketResult(segment, result),
    value: result.points,
    remainingAfter: player.points,
    bust: false,
  });

  moveMarker(el.dartboardMarker, segment);

  if (checkCricketWin(state.players, state.currentPlayerIndex)) {
    finishLeg(state.currentPlayerIndex);
  } else if (state.dartsThisTurn.length >= 3) {
    endTurn();
  }

  render();
}

function endTurn() {
  state.dartsThisTurn = [];
  state.currentPlayerIndex = (state.currentPlayerIndex + 1) % state.players.length;
  // Cricket players have no `remaining` - there's nothing to revert to,
  // since it has no bust rule.
  if (state.gameType !== "cricket") {
    state.startOfTurnRemaining = state.players[state.currentPlayerIndex].remaining;
  }
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
// ---------- Render ----------
function render() {
  const cricket = state.gameType === "cricket";

  el.playerTabs.innerHTML = "";
  state.players.forEach((p, i) => {
    const tab = document.createElement("div");
    tab.className = "player-tab" + (i === state.currentPlayerIndex ? " active" : "");
    const score = cricket ? p.points : p.remaining;
    tab.innerHTML = `<span class="player-tab-name">${p.name}</span><span class="player-tab-score">${score}</span>`;
    el.playerTabs.appendChild(tab);
  });

  const current = state.players[state.currentPlayerIndex];
  el.bigScore.textContent = cricket ? current.points : current.remaining;
  el.turnLabel.textContent = state.gameOver
    ? `${state.players[state.winnerIndex].name} wins the leg! 🎯`
    : `${current.name}'s turn`;

  renderMatchBar();

  // Cricket gets a marks grid; 501 doesn't. Quick Total is hidden in cricket
  // because a turn total says nothing about which numbers were hit.
  el.cricketBoard?.classList.toggle("hidden", !cricket);
  el.manualSection?.classList.toggle("cricket-mode", cricket);
  if (cricket) renderCricketBoard();

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
    el.winnerBanner.textContent = winnerBannerText();
  }
}
