// game.js - 501 scoring, board visualization, and all UI wiring.

import { Granboard, SegmentType, createSegment, SegmentID, applyBullMode } from "./granboard.js";
import { resolveThrow, rulesFor } from "./scoring.js";
import { createQuickEntry } from "./quickentry.js";
import { renderDartboard, moveMarkerTo as moveMarker, hideMarker } from "./dartboard.js";
import {
  renderCricketBoard as renderCricketBoard_, wireCricketBoard,
} from "./cricketboard.js";
import { createMedleyBuilder } from "./medleybuilder.js";
import {
  createMatch, currentGameType, currentLegConfig, recordLegWin, advanceLeg,
  startingPlayerForLeg, matchScoreText, legProgressText, gameLabel, normalizeLeg,
} from "./medley.js";
import {
  createCricketPlayer, resolveCricketThrow, applyCricketResult,
  checkCricketWin, describeCricketResult,
} from "./cricket.js";
import {
  createCountUpPlayer, resolveCountUpThrow, applyCountUpResult,
  checkCountUpWin, isLegComplete, describeCountUpResult, formatAverage,
  DEFAULT_ROUNDS,
} from "./countup.js";
import { createRecorder } from "./matchrecorder.js";
import {
  recordMatch, getState as accountState, subscribe as subscribeToAccount,
} from "./accountstore.js";

const STARTING_SCORE = 501;

const state = {
  gameType: "x01", // "x01" | "cricket" - the CURRENT leg's game
  legConfig: null, // the full leg descriptor (score + rules) - see medley.js
  match: null,     // see medley.js; a single game is a one-leg match
  legOver: false,  // leg decided but match still running - waiting for "Next leg"
  players: [],
  currentPlayerIndex: 0,
  dartsThisTurn: [],
  startOfTurnRemaining: STARTING_SCORE,
  gameOver: false,
  winnerIndex: null,
  throwLog: [], // {playerName, label, value, remainingAfter, bust}
  // Records every dart of the match for history and statistics. Null until a
  // match starts, and deliberately never consulted by any scoring code - it
  // only ever receives what the rules have already decided. See
  // matchrecorder.js.
  recorder: null,
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

// Signing in pre-fills the first seat with the account's display name. That is
// a small convenience and one important correctness detail: it is how the
// recorder knows which of several pass-and-play seats is the account holder,
// and therefore whose statistics these darts belong to. Only ever overwrites
// the untouched default, never something that has been typed.
subscribeToAccount(({ user }) => {
  if (!user) return;
  const first = el.playerInputs.querySelector(".player-input");
  if (!first) return;
  if (first.value === "" || first.value === "Player 1") first.value = user.displayName;
});

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

  const legs = readMedleyLegs();
  state.match = createMatch(legs, names.length);
  state.playerNames = names;

  // Which seat belongs to the person whose account this is. Pass-and-play has
  // no way to know for certain - one device, several players, any of whom
  // might be the account holder - so it goes by name, and falls back to the
  // first seat. Getting it wrong would attribute someone else's darts to your
  // statistics, so the name box is pre-filled with the account's display name
  // (see below) to make the common case correct rather than lucky.
  const myName = accountState().user?.displayName?.trim().toLowerCase();
  const selfSeat = myName
    ? Math.max(0, names.findIndex((n) => n.trim().toLowerCase() === myName))
    : 0;

  state.recorder = createRecorder({
    mode: "local",
    format: legs,
    players: names.map((name, seat) => ({ displayName: name, isSelf: seat === selfSeat })),
  });

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

// ---------- Manual entry ----------
// A first-class way to play, not a fallback: plenty of people score a plain
// steel-tip board this way and never connect anything over Bluetooth. It's
// also what fixes a miss or a misread when there IS a board, but that's the
// secondary use, not the reason it exists.
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
  return {
    ...JSON.parse(JSON.stringify({
      players: state.players,
      currentPlayerIndex: state.currentPlayerIndex,
      dartsThisTurn: state.dartsThisTurn,
      startOfTurnRemaining: state.startOfTurnRemaining,
      gameOver: state.gameOver,
      winnerIndex: state.winnerIndex,
      throwLog: state.throwLog,
    })),
    // Rides along in the same snapshot rather than keeping a second stack, so
    // the record of the match can't drift out of step with the match: one
    // undo, one rewind, always the same one. The recorder only appends, so its
    // half of this is a set of counters rather than a copy - see capture().
    recorder: state.recorder?.capture() ?? null,
  };
}

function restore(snap) {
  const { recorder, ...gameState } = snap;
  Object.assign(state, gameState);
  state.recorder?.restore(recorder);
}

// ---------- Medley builder ----------
// A match is just an ordered list of games. One row is an ordinary single
// game, so there's no "enable medley" switch to find - adding a second leg is
// what turns it into one.
const x01 = (score, rules = "double") => ({ game: "x01", score, rules });
const CRICKET_LEG = { game: "cricket" };

// The Format control - shared with the online panel (see medleybuilder.js).
const medleyBuilder = createMedleyBuilder({
  legs: el.medleyLegs,
  addBtn: el.addLegBtn,
  preset: el.medleyPreset,
  bull: document.getElementById("bull-mode"),
});

function readMedleyLegs() {
  return medleyBuilder.getLegs();
}

// Sets up a fresh leg: new scores, but names and the match tally carry over.
// The throw alternates each leg so the same player isn't always first.
function startLeg(names) {
  state.legConfig = currentLegConfig(state.match);
  state.gameType = state.legConfig.game;

  const start = state.legConfig.score ?? STARTING_SCORE;
  const rules = rulesFor(state.legConfig.rules);

  state.players = names.map((name) => {
    if (state.gameType === "cricket") return createCricketPlayer(name);
    if (state.gameType === "countup") return createCountUpPlayer(name);
    // `opened` tracks the double-in requirement: with a straight in, everyone
    // starts open and it never matters again.
    return { name, remaining: start, opened: rules.in !== "double" };
  });
  state.currentPlayerIndex = startingPlayerForLeg(state.match.currentLeg, names.length);
  state.dartsThisTurn = [];
  state.startOfTurnRemaining = start;
  state.gameOver = false;
  state.legOver = false;
  state.winnerIndex = null;
  state.throwLog = [];

  state.recorder?.startLeg({
    legIndex: state.match.currentLeg,
    game: state.gameType,
    x01Start: state.gameType === "x01" ? start : null,
    rules: state.gameType === "x01" ? (state.legConfig.rules || "double") : null,
    bull: state.legConfig.bull || null,
    rounds: state.legConfig.rounds ?? null,
  });
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

  state.recorder?.endLeg(winnerIndex ?? null);

  // Only a finished match is saved. Abandoning one halfway (New Game) leaves
  // nothing behind on purpose: a half-played leg would drag every average down
  // with darts that were never a real attempt at a checkout.
  if (state.match.over && state.recorder) {
    const document = state.recorder.endMatch({
      winnerSeat: state.match.winnerIndex ?? null,
      drawn: Boolean(state.match.drawn),
    });
    // Stored locally first and uploaded afterwards, so this works signed out
    // and offline - see the queue in accountstore.js.
    recordMatch(document);
    state.recorder = null;
  }
}

function applyHit(rawSegment) {
  if (state.gameOver) return;

  // One transform at the boundary, before any game logic sees the dart, so
  // full-bull applies identically to x01, Cricket and Count Up - and to
  // board hits, dartboard clicks and manual entry alike.
  const segment = applyBullMode(rawSegment, state.legConfig?.bull);

  if (state.gameType === "cricket") return applyCricketHit(segment);
  if (state.gameType === "countup") return applyCountUpHit(segment);

  undoStack.push(snapshot());

  const player = state.players[state.currentPlayerIndex];
  const rules = rulesFor(state.legConfig?.rules);
  // Captured before the throw is applied, because the recorder wants the score
  // this dart was thrown at, not the one it left behind.
  const remainingBefore = player.remaining;
  const { after, isBust, isWin, opened, ignored } = resolveThrow(player.remaining, segment, {
    inRule: rules.in,
    outRule: rules.out,
    opened: player.opened !== false,
  });
  player.opened = opened;

  state.dartsThisTurn.push(segment);
  state.throwLog.unshift({
    playerName: player.name,
    // Double-in: say why a dart scored nothing, rather than silently logging
    // it as if it counted.
    label: ignored ? `${segment.longName} - not in yet` : segment.longName,
    value: ignored ? 0 : segment.value,
    remainingAfter: isBust ? state.startOfTurnRemaining : Math.max(after, 0),
    bust: isBust,
  });

  state.recorder?.dart(state.currentPlayerIndex, segment, {
    remainingBefore,
    remainingAfter: isBust ? state.startOfTurnRemaining : Math.max(after, 0),
    bust: isBust,
    ignored,
    scored: ignored || isBust ? 0 : segment.value,
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
  if (state.gameType === "countup") return applyCountUpTotal(totalValue);

  undoStack.push(snapshot());

  const player = state.players[state.currentPlayerIndex];
  const remainingBefore = player.remaining;
  const segment = {
    value: totalValue,
    type: SegmentType.Double, // see quickentry.js: exact-0 entries assume a valid double-out
    longName: `Turn total: ${totalValue}`,
    shortName: `${totalValue}`,
    ring: "quick",
    section: "Other",
  };
  // A turn total is entered by someone who watched the darts land, so it's
  // taken at face value: it counts as being "in" under double-in rules, and
  // an exact-zero entry is assumed to be a legal finish under whatever the
  // leg's out rule is (see quickentry.js).
  player.opened = true;
  const { after, isBust, isWin } = resolveThrow(player.remaining, segment, {
    inRule: "straight",
    outRule: "straight",
    opened: true,
  });

  state.throwLog.unshift({
    playerName: player.name,
    label: segment.longName,
    value: segment.value,
    remainingAfter: isBust ? state.startOfTurnRemaining : Math.max(after, 0),
    bust: isBust,
  });

  hideMarker(el.dartboardMarker); // no single position to show for a turn total

  state.recorder?.quickTotal(state.currentPlayerIndex, {
    total: totalValue,
    remainingBefore,
    remainingAfter: isBust ? state.startOfTurnRemaining : Math.max(after, 0),
    bust: isBust,
    isCheckout: isWin,
  });

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

  // A Count Up leg can end level, in which case it's credited to nobody.
  if (state.winnerIndex === null || state.winnerIndex === undefined) {
    return `Leg ${match.currentLeg + 1} drawn · ${matchScoreText(match, names)}`;
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
  renderCricketBoard_(el.cricketBoard, state.players, state.currentPlayerIndex);
}

wireCricketBoard(el.cricketBoard, (segment) => {
  if (state.gameType !== "cricket" || state.gameOver) return;
  applyHit(segment);
});

// Count Up is the simplest path in the app: every dart adds its face value,
// there's no bust and nothing to revert. The only real rule is that the leg
// isn't decided until EVERY player has thrown their full allocation of
// rounds, so the winner is checked at the end of a turn rather than after
// each dart.
// Quick Total suits Count Up well - a whole-turn total is exactly what this
// game accumulates, so unlike Cricket there's no reason to hide it.
function applyCountUpTotal(totalValue) {
  undoStack.push(snapshot());

  const player = state.players[state.currentPlayerIndex];
  player.total += Number(totalValue) || 0;
  player.roundsPlayed += 1;

  state.throwLog.unshift({
    playerName: player.name,
    label: `Turn total: ${totalValue}`,
    value: totalValue,
    remainingAfter: player.total,
    bust: false,
  });

  hideMarker(el.dartboardMarker); // no single position for a turn total

  const rounds = state.legConfig.rounds ?? DEFAULT_ROUNDS;
  if (isLegComplete(state.players, rounds)) {
    finishLeg(checkCountUpWin(state.players, rounds));
  } else {
    endTurn();
  }

  render();
}

function applyCountUpHit(segment) {
  undoStack.push(snapshot());

  const player = state.players[state.currentPlayerIndex];
  const result = resolveCountUpThrow(segment);
  applyCountUpResult(player, result);

  state.dartsThisTurn.push(segment);
  state.throwLog.unshift({
    playerName: player.name,
    label: describeCountUpResult(segment, result),
    value: result.points,
    remainingAfter: player.total,
    bust: false,
  });

  state.recorder?.dart(state.currentPlayerIndex, segment, {
    scored: result.points,
    extra: { points: result.points, total: player.total },
  });

  moveMarker(el.dartboardMarker, segment);

  if (state.dartsThisTurn.length >= 3) {
    player.roundsPlayed += 1;
    if (isLegComplete(state.players, state.legConfig.rounds ?? DEFAULT_ROUNDS)) {
      // checkCountUpWin returns null on a tie - finishLeg passes that through
      // to medley.js, which credits the leg to nobody.
      finishLeg(checkCountUpWin(state.players, state.legConfig.rounds ?? DEFAULT_ROUNDS));
    } else {
      endTurn();
    }
  }

  render();
}

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

  // Cricket's per-dart detail: which target, how many marks it was worth, how
  // many of those actually counted, and what it scored. Everything MPR, white
  // horses and hat tricks are computed from later comes from these.
  state.recorder?.dart(state.currentPlayerIndex, segment, {
    scored: result.points,
    extra: {
      target: result.target,
      marks: result.marks,
      marksApplied: result.marksApplied,
      points: result.points,
      justClosed: result.justClosed,
    },
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
  state.recorder?.endTurn();
  state.dartsThisTurn = [];
  state.currentPlayerIndex = (state.currentPlayerIndex + 1) % state.players.length;
  // Cricket players have no `remaining` - there's nothing to revert to,
  // since it has no bust rule.
  if (state.gameType !== "cricket" && state.gameType !== "countup") {
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
  const countup = state.gameType === "countup";
  // x01 counts down to zero; Cricket and Count Up both count up, just from
  // different things.
  const scoreOf = (p) => (cricket ? p.points : countup ? p.total : p.remaining);

  el.playerTabs.innerHTML = "";
  state.players.forEach((p, i) => {
    const tab = document.createElement("div");
    tab.className = "player-tab" + (i === state.currentPlayerIndex ? " active" : "");
    // textContent, not innerHTML: player names are typed by whoever is at the
    // keyboard. Locally that is only ever self-inflicted, but the same habit
    // everywhere is what stops the one place it matters being missed - see the
    // challenge card in lobbyui.js, where the name belongs to someone else.
    const tabName = document.createElement("span");
    tabName.className = "player-tab-name";
    tabName.textContent = p.name;
    const tabScore = document.createElement("span");
    tabScore.className = "player-tab-score";
    tabScore.textContent = scoreOf(p);
    tab.append(tabName, tabScore);
    el.playerTabs.appendChild(tab);
  });

  const current = state.players[state.currentPlayerIndex];
  el.bigScore.textContent = scoreOf(current);

  if (state.gameOver) {
    // Count Up can end level, in which case there's no winner to name.
    el.turnLabel.textContent = state.winnerIndex === null || state.winnerIndex === undefined
      ? "Leg drawn."
      : `${state.players[state.winnerIndex].name} wins the leg! 🎯`;
  } else if (countup) {
    // Rounds remaining and the running average are the two numbers that
    // matter in a practice game, so they go where the turn label sits.
    const rounds = state.legConfig.rounds ?? DEFAULT_ROUNDS;
    const left = Math.max(0, rounds - current.roundsPlayed);
    el.turnLabel.textContent =
      `${current.name}'s turn · round ${Math.min(current.roundsPlayed + 1, rounds)} of ${rounds} · avg ${formatAverage(current)}`;
  } else {
    el.turnLabel.textContent = `${current.name}'s turn`;
  }

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
    for (const value of [entry.playerName, entry.label, entry.bust ? "BUST" : entry.remainingAfter]) {
      const cell = document.createElement("span");
      cell.textContent = value;
      row.appendChild(cell);
    }
    el.throwLog.appendChild(row);
  });

  el.winnerBanner.classList.toggle("hidden", !state.gameOver);
  if (state.gameOver) {
    el.winnerBanner.textContent = winnerBannerText();
  }
}
