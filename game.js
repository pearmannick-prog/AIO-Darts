// game.js - 501 scoring, board visualization, and all UI wiring.

import { SegmentType, createSegment, SegmentID, applyBullMode } from "./granboard.js";
import {
  connectBoard, subscribeToBoard, onBoardStatusChange,
  setExternalSource, deliverExternalSegment,
} from "./boardlink.js";
import { createScorerLink } from "./scorerlink.js";
import { SOURCES as SCORER_SOURCES } from "./dartnotation.js";
import {
  resolveThrow, resolvePartnersThrow, isFrozen, rulesFor,
} from "./scoring.js";
import {
  canPlayTeams, teamOf, teamLabel, freezeInputs, TEAM_COUNT,
} from "./teams.js";
import { createQuickEntry } from "./quickentry.js";
import { renderDartboard, moveMarkerTo as moveMarker, hideMarker } from "./dartboard.js";
import {
  renderCricketBoard as renderCricketBoard_, wireCricketBoard,
} from "./cricketboard.js";
import { createMedleyBuilder, recordFormatUsed } from "./medleybuilder.js";
import { renderCheckoutHint, renderLiveAverage } from "./checkouthint.js";
import { getPref, VISIT_HOLD_MS } from "./prefs.js";
import { cueHit, cueBust, cueCheckout, cueWin, callScore } from "./audio.js";
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
import {
  createBermudaPlayer, bermudaTarget, resolveBermudaThrow, applyBermudaThrow,
  isBermudaRoundOver, endBermudaRound, isBermudaComplete, checkBermudaWin,
  describeBermudaResult, BERMUDA_ROUNDS,
} from "./bermuda.js";
import {
  SKILL_LEVELS, skillFor, throwDart, chooseX01Target, chooseCricketTarget,
  chooseBermudaTarget, chooseCountUpTarget,
} from "./botplayer.js";
import { createRecorder } from "./matchrecorder.js";
import {
  recordMatch, getState as accountState, subscribe as subscribeToAccount,
  getPartner, recordMatchForPartner,
} from "./accountstore.js";

const STARTING_SCORE = 501;

const state = {
  gameType: "x01", // "x01" | "cricket" - the CURRENT leg's game
  legConfig: null, // the full leg descriptor (score + rules) - see medley.js
  match: null,     // see medley.js; a single game is a one-leg match
  legOver: false,  // leg decided but match still running - waiting for "Next leg"
  players: [],
  // Partners play. False for every ordinary match, which is what keeps every
  // path below reading exactly as it did - a singles game is not a team game
  // with one player per team, it simply doesn't take these branches.
  teams: false,
  currentPlayerIndex: 0,
  dartsThisTurn: [],
  startOfTurnRemaining: STARTING_SCORE,
  gameOver: false,
  winnerIndex: null,
  throwLog: [], // {playerName, label, value, remainingAfter, bust}
  // One entry per seat: null for a person, a skill level for a computer.
  bots: [],
  // Which seat is the account holder, and how many rematches deep this is.
  // The latter alternates who throws first between matches.
  selfSeat: 0,
  rematchCount: 0,
  // Records every dart of the match for history and statistics. Null until a
  // match starts, and deliberately never consulted by any scoring code - it
  // only ever receives what the rules have already decided. See
  // matchrecorder.js.
  recorder: null,
};

let undoStack = [];

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
  checkoutHint: document.getElementById("checkout-hint"),
  ocheStat: document.getElementById("oche-stat"),
  undoBtn: document.getElementById("undo-btn"),
  newGameBtn: document.getElementById("new-game-btn"),
  endGameBtn: document.getElementById("end-game-btn"),
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
  rematchBtn: document.getElementById("rematch-btn"),
  scorerHost: document.getElementById("scorer-host"),
  scorerConnect: document.getElementById("scorer-connect"),
  scorerDisconnect: document.getElementById("scorer-disconnect"),
  scorerStatus: document.getElementById("scorer-status"),
  cricketBoard: document.getElementById("cricket-board"),
  winnerBanner: document.getElementById("winner-banner"),
  // Scoped to #local-mode: there are now two boards on the page (local and
  // online), and an unscoped ".dartboard" would silently match whichever
  // appears first in the HTML.
  dartboardEl: document.querySelector("#local-mode .dartboard"),
  teamsSetup: document.getElementById("teams-setup"),
  teamsToggle: document.getElementById("teams-toggle"),
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
  // Each seat can be a person or a computer. "Human" first and selected by
  // default, so adding a player behaves exactly as it always has and the bots
  // are opt-in.
  const skillOptions = SKILL_LEVELS
    .map((s) => `<option value="${s.key}">${s.label} (${s.rank})</option>`)
    .join("");
  row.innerHTML = `
    <input type="text" class="player-input" placeholder="Player ${count}">
    <select class="player-kind" title="Who is playing this seat">
      <option value="human" selected>Human</option>
      ${skillOptions}
    </select>
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
  refreshTeamsSetup(rows);
}

// Partners is only offered at exactly four seats. Adding a fifth player with
// the box already ticked would leave a checked control governing nothing, so
// the toggle is cleared as it is hidden rather than left set and ignored - the
// state on screen is then always the state the match will start with.
function refreshTeamsSetup(rows) {
  if (!el.teamsSetup || !el.teamsToggle) return;
  const eligible = canPlayTeams(rows.length);
  el.teamsSetup.classList.toggle("hidden", !eligible);
  if (!eligible) el.teamsToggle.checked = false;

  // The pairing, shown rather than described. Which seats are partners is the
  // one thing about this that is easy to get wrong at the table, and reading
  // it off the rows beats trusting a sentence about odds and evens.
  const on = eligible && el.teamsToggle.checked;
  rows.forEach((row, i) => {
    let badge = row.querySelector(".player-team");
    if (!on) {
      badge?.remove();
      return;
    }
    if (!badge) {
      badge = document.createElement("span");
      badge.className = "player-team";
      // Before the remove button, so the row reads name - who - which team.
      row.insertBefore(badge, row.querySelector(".player-remove"));
    }
    badge.textContent = teamLabel(i);
  });
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

// Ticking the box only redraws the badges - nothing about the match is decided
// until Start Game reads it.
el.teamsToggle?.addEventListener("change", () => refreshPlayerRows());

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
  // Recorded on START rather than on finish: an abandoned game is still
  // evidence of what you meant to play, and the point of the list is to save
  // you setting it up again.
  recordFormatUsed(legs);

  // Read once, here, rather than from the checkbox again later: the form stays
  // on screen behind the game panel and a rematch replays beginMatch without
  // it, so a match must not be able to change shape halfway through because
  // somebody tidied the setup.
  state.teams = Boolean(el.teamsToggle?.checked) && canPlayTeams(names.length);

  // Every game mode plays in partners now. Cricket, Count Up and Bermuda all
  // share one score per side, and x01 shares one unless the Freeze Rule is on
  // - which is the one variant that needs a score each. A medley may mix them
  // freely, because which model applies is decided per LEG in startLeg rather
  // than once for the match.

  // LEGS ARE WON BY TEAMS. createMatch sizes legsWon at call time, so passing
  // the team count is the whole of what a partners match needs from medley.js
  // - the leg tally, "best of five", the clinch and the draw all then work on
  // teams without knowing that is what they are counting.
  state.match = createMatch(legs, state.teams ? TEAM_COUNT : names.length);
  state.playerNames = names;

  // Which seat belongs to the person whose account this is. Pass-and-play has
  // no way to know for certain - one device, several players, any of whom
  // might be the account holder - so it goes by name, and falls back to the
  // first seat. Getting it wrong would attribute someone else's darts to your
  // statistics, so the name box is pre-filled with the account's display name
  // (see below) to make the common case correct rather than lucky.
  // Which seats are computer players, and how good they are.
  const kinds = [...el.playerInputs.querySelectorAll(".player-kind")].map((s) => s.value);

  const myName = accountState().user?.displayName?.trim().toLowerCase();
  const selfSeat = myName
    ? Math.max(0, names.findIndex((n) => n.trim().toLowerCase() === myName))
    : 0;

  // A bot is never "you", however the seat is named.
  state.bots = kinds.map((kind) => (kind === "human" ? null : skillFor(kind)));
  // Kept so a rematch rebuilds the recorder with the same seat marked as you,
  // rather than re-deriving it from a form that may since have been edited.
  state.selfSeat = selfSeat;

  state.recorder = createRecorder({
    // A match against a computer is practice, and saying so in the record is
    // what lets the statistics count the darts (they are real darts, thrown at
    // a real board) while leaving win-based leaderboards alone. Farming a
    // beginner bot for a hundred wins should not put anyone top of a board.
    mode: state.bots.some(Boolean) ? "practice" : "local",
    format: legs,
    players: names.map((name, seat) => ({
      displayName: name,
      isSelf: seat === selfSeat && !state.bots[seat],
      // Explicit, never re-derived from seat parity. The pairing is worked out
      // once in teams.js from an order the player can see, and every consumer
      // of the record is told the answer rather than being trusted to
      // recompute it - see docs/team-play.md on why a convention in five
      // places is one that drifts. Null in singles, which is the honest
      // representation rather than "team 0".
      team: state.teams ? teamOf(seat) : null,
    })),
  });

  state.rematchCount = 0;
  beginMatch(names, legs);
});

// The part of starting a match that a rematch repeats. Split out so the two
// cannot drift: everything a rematch needs is already in `state` when a match
// ends - the names, the bots, the format - so it replays this rather than
// reading the setup form again.
function beginMatch(names, legs) {
  startLeg(names);
  undoStack = [];

  el.setupPanel.classList.add("hidden");
  el.gamePanel.classList.remove("hidden");
  el.winnerBanner.classList.add("hidden");
  render();
}

// Same players, same format, no setup screen. "New game" is deliberately left
// as the change-the-format path: it returns to setup with the names and the
// format still filled in, so switching to Cricket is two clicks and a rematch
// is none.
el.rematchBtn?.addEventListener("click", () => {
  if (!state.gameOver || state.players.length === 0) return;

  const names = state.playerNames;
  const legs = state.match.legs;

  // Who throws first alternates between rematches. Within a match the leg
  // index already alternates it; across matches nothing did, so the same seat
  // opened every single time - a real advantage in a short format, and free to
  // fix.
  state.rematchCount = (state.rematchCount || 0) + 1;
  state.match = createMatch(legs, names.length);

  // A fresh recorder, because this is a new match rather than a continuation.
  // The finished one has already been saved and cleared by the end of the last
  // leg - see finishMatch.
  state.recorder = createRecorder({
    mode: state.bots.some(Boolean) ? "practice" : "local",
    format: legs,
    players: names.map((name, seat) => ({
      displayName: name,
      isSelf: seat === state.selfSeat && !state.bots[seat],
    })),
  });

  beginMatch(names, legs);
});

el.newGameBtn.addEventListener("click", () => abandonGame());

// End game, behind two taps - the same guard online.js puts on End match, for
// the same reason: a modal is poor on a phone mid-match, but throwing away
// someone's leg on one stray tap is worth guarding against, and the arming
// lapses on its own rather than sitting primed for the rest of the game.
//
// "New game" beside the score does the same thing and keeps its name: it is the
// change-the-format path, reached while thinking about the next match rather
// than about stopping this one.
let endGameArmTimeout = null;

function disarmEndGame() {
  clearTimeout(endGameArmTimeout);
  if (!el.endGameBtn) return;
  el.endGameBtn.dataset.armed = "0";
  el.endGameBtn.textContent = "End game";
  el.endGameBtn.classList.remove("armed");
}

el.endGameBtn?.addEventListener("click", () => {
  if (el.endGameBtn.dataset.armed !== "1") {
    el.endGameBtn.dataset.armed = "1";
    el.endGameBtn.textContent = "Tap again to end";
    el.endGameBtn.classList.add("armed");
    clearTimeout(endGameArmTimeout);
    endGameArmTimeout = setTimeout(disarmEndGame, 4000);
    return;
  }
  disarmEndGame();
  abandonGame();
});

// Leaving the Local Play tab ends the local game, the same way leaving an
// online match ends that. A game running on a tab nobody is looking at is not
// paused, it is abandoned - and leaving it there is what let a dead scoreboard
// sit around looking like a live one that had stopped working.
//
// online.js owns the tabs and announces the change; this module decides what
// leaving means for its own half, so neither has to know about the other.
document.addEventListener("aio-mode-left", (event) => {
  if (event.detail?.from !== "local") return;
  if (state.players.length === 0) return;
  abandonGame();
});

// Answers "is a local game in progress?" for the leave confirmation. online.js
// owns the tabs but must not own this - it asks, and this fills in the answer.
document.addEventListener("aio-query-local-match", (event) => {
  if (!event.detail) return;
  event.detail.active = state.players.length > 0 && !state.gameOver;
});

function abandonGame() {
  cancelBot();
  // However the game ended, the button goes back to saying what it does - a
  // primed "Tap again to end" left over from last time is one tap from
  // throwing away the NEXT match.
  disarmEndGame();
  // An abandoned match is not saved. Half a game would drag every average down
  // with darts that were never a real attempt at a finish - the same rule
  // online.js applies when a match is walked out of.
  state.recorder = null;
  state.players = [];
  state.gameOver = false;
  undoStack = [];
  el.gamePanel.classList.add("hidden");
  el.setupPanel.classList.remove("hidden");
}

// ---------- Bluetooth connection ----------
el.connectBtn.addEventListener("click", async () => {
  if (!navigator.bluetooth) {
    alert("This browser doesn't support Web Bluetooth. Use Chrome or Edge on desktop.");
    return;
  }

  try {
    el.connectionLabel.textContent = "Connecting…";
    // THE board, not this controller's board. boardlink.js owns the connection
    // and routes each dart to whichever mode is playing, so connecting here
    // also connects it for online play - and stays connected when you switch
    // between them. See the note at the top of boardlink.js for why there used
    // to be two of these and why that was the bug.
    await connectBoard();
  } catch (err) {
    console.error(err);
    el.connectionLabel.textContent = "Connection failed";
    alert(`Couldn't connect: ${err.message}`);
  }
});

// ---------- Automatic camera scorer ----------
// An alternative producer for the same input bus the Granboard feeds, so a
// dart seen by a camera is indistinguishable downstream from one felt by a
// board - it lands in whichever mode is playing, gets recorded, and undoes.
//
// Lives in game.js because that is where the header status lives, not because
// it belongs to local play. It does not.
const SCORER_HOST_KEY = "aiodarts-scorer-host";
const SCORER_SOURCE = "opendartboard";

const scorer = createScorerLink({
  source: SCORER_SOURCE,
  onSegment: (segment) => deliverExternalSegment(segment),
  onStatus: ({ status, detail }) => {
    const label = SCORER_SOURCES[SCORER_SOURCE].label;
    // The header says what is attached; boardlink owns that, so the scorer
    // tells it rather than writing the label itself.
    setExternalSource(status === "connected" ? label : null);

    const text = {
      connecting: `Connecting to ${label}…`,
      connected: `Connected to ${label}. Throws will score automatically.`,
      retrying: `Lost the ${label} connection — ${detail}`,
      disconnected: "Not connected.",
      error: detail || "Couldn't connect.",
    }[status] || "";

    if (el.scorerStatus) el.scorerStatus.textContent = text;
    const live = status === "connected" || status === "connecting" || status === "retrying";
    el.scorerConnect?.classList.toggle("hidden", live);
    el.scorerDisconnect?.classList.toggle("hidden", !live);
  },
});

if (el.scorerHost) {
  el.scorerHost.value = localStorage.getItem(SCORER_HOST_KEY) || "";
}

el.scorerConnect?.addEventListener("click", () => {
  const host = el.scorerHost.value.trim();
  // Remembered before connecting rather than after: the commonest reason to
  // come back to this box is that the address was wrong, and losing what you
  // typed on a failed attempt makes correcting it worse.
  localStorage.setItem(SCORER_HOST_KEY, host);
  scorer.connect(host);
});

el.scorerDisconnect?.addEventListener("click", () => scorer.disconnect());

// The header is the one place the board's state is reported, for both modes.
// Driven by boardlink rather than by the click handler, so it is also correct
// when the board drops on its own or was connected from somewhere else.
onBoardStatusChange(({ connected, name }) => {
  el.connectionDot.classList.toggle("connected", connected);
  el.connectionLabel.textContent = connected ? `Connected: ${name}` : "Disconnected";
});

// Local play takes a dart only when no online match wants it - online.js
// registers at a higher priority and answers first. The guard is the same one
// the clickable board uses, so all three input paths agree about when a dart
// means anything.
subscribeToBoard({
  priority: 0,
  wants: () => state.players.length > 0 && !state.gameOver,
  onHit: (segment) => {
    if (segment.id === SegmentID.RESET_BUTTON) {
      // Physical button on the board - confirmed to mean "end my turn now"
      // (useful if you're done before 3 darts register, e.g. a dart bounced
      // out or missed the board entirely).
      endTurnEarly();
      return;
    }
    applyHit(segment);
  },
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
      // Undoing the dart that conceded a leg has to clear the reason as well
      // as the result, or the label keeps saying somebody went out frozen
      // after the throw that did it has been taken back.
      legConceded: state.legConceded,
      // Whose go it is WITHIN each side. Without this an undo that crosses a
      // visit boundary would hand the next dart to the wrong partner - and
      // with a shared total that is invisible, because the score would still
      // be right. See recorderSeat.
      throwerIndexes: state.throwerIndexes,
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
  chips: document.getElementById("format-chips"),
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

  // Who the rules layer plays between. With a shared total that is the two
  // TEAMS, named as pairs - so cricket.js gets a players array of length two
  // and needs no idea that partners exist. Otherwise it is the people, exactly
  // as it always was.
  const shared = isSharedTotal(state.legConfig);
  state.rosters = shared
    ? [0, 1].map((team) => names.filter((_n, seat) => teamOf(seat) === team))
    : names.map((n) => [n]);
  state.throwerIndexes = state.rosters.map(() => 0);
  const seatNames = shared ? state.rosters.map((r) => r.join(" & ")) : names;

  state.players = seatNames.map((name) => {
    if (state.gameType === "cricket") return createCricketPlayer(name);
    if (state.gameType === "countup") return createCountUpPlayer(name);
    if (state.gameType === "bermuda") return createBermudaPlayer(name);
    // `opened` tracks the double-in requirement: with a straight in, everyone
    // starts open and it never matters again.
    return { name, remaining: start, opened: rules.in !== "double" };
  });
  // Offset by the rematch count so the opening throw alternates between
  // MATCHES as well as between legs. Without it the same seat opened every
  // rematch, which is a real advantage in a short format and free to fix.
  // Over the RULES seats, not the people - with a shared total there are two
  // of them, and alternating over four would leave the same side opening two
  // legs running.
  state.currentPlayerIndex = startingPlayerForLeg(
    state.match.currentLeg + (state.rematchCount || 0), state.players.length);
  state.dartsThisTurn = [];
  state.startOfTurnRemaining = start;
  state.gameOver = false;
  state.legOver = false;
  state.winnerIndex = null;
  state.legConceded = false;
  state.throwLog = [];

  state.recorder?.startLeg({
    legIndex: state.match.currentLeg,
    game: state.gameType,
    x01Start: state.gameType === "x01" ? start : null,
    rules: state.gameType === "x01" ? (state.legConfig.rules || "double") : null,
    bull: state.legConfig.bull || null,
    // Fixed by Bermuda's target list rather than chosen, but recorded anyway so
    // a stored match describes itself without knowing the rules module.
    rounds: state.gameType === "bermuda" ? BERMUDA_ROUNDS : (state.legConfig.rounds ?? null),
  });
}

// Called whenever a leg is won. Decides whether that also ends the match.
// gameOver stays true either way so no further darts register until the
// player moves on.
// winnerIndex is a TEAM index in partners play and a seat index otherwise -
// the same number `state.match.legsWon` is indexed by, because createMatch was
// sized with whichever of the two this match counts in. Everything that reads
// state.winnerIndex has to know which, so sideNames() below is the only place
// that turns it back into something to show.
function finishLeg(winnerIndex, { conceded = false, finisherSeat = null } = {}) {
  state.gameOver = true;
  state.winnerIndex = winnerIndex;
  state.legConceded = conceded;
  recordLegWin(state.match, winnerIndex);
  // A one-leg match is over the moment the leg is - nothing to advance to.
  state.legOver = !state.match.over;

  // The match, not the leg. Winning a leg of a best-of-five is not the moment
  // for the sound that means it is finished.
  if (state.match.over) cueWin();

  // The recorder counts SEATS, always - a leg is closed against the person who
  // threw the finishing dart, not against a team. In singles the two numbers
  // are the same one. In partners they are not, so the seat is passed
  // explicitly, and it is null when nobody on the winning side finished
  // anything: a conceded leg was won by the other team without a checkout.
  //
  // That null matters. endLeg marks the open visit as the checkout only when
  // its seat matches, so a frozen player who reached zero and lost is not
  // credited with one - see matchrecorder.js and docs/team-play.md 7a.
  // The seat is who threw the finishing dart - null when nobody did, which is
  // what a conceded leg is - and the team is who the leg belongs to. Both,
  // because they are different questions once teams exist: the seat is what
  // marks a visit as a checkout, the team is what the leg tally counts.
  state.recorder?.endLeg(
    state.teams ? finisherSeat : (winnerIndex ?? null),
    { winnerTeam: state.teams ? winnerIndex : null },
  );

  // Only a finished match is saved. Abandoning one halfway (New Game) leaves
  // nothing behind on purpose: a half-played leg would drag every average down
  // with darts that were never a real attempt at a checkout.
  if (state.match.over && state.recorder) {
    const document = state.recorder.endMatch({
      // In partners the match index counts teams, so it is written as the
      // winning team and the winning SEAT stays null - a pair won it, and
      // naming one of them would be the half-credit this whole pass removed.
      winnerSeat: state.teams ? null : (state.match.winnerIndex ?? null),
      winnerTeam: state.teams ? (state.match.winnerIndex ?? null) : null,
      drawn: Boolean(state.match.drawn),
    });
    // Stored locally first and uploaded afterwards, so this works signed out
    // and offline - see the queue in accountstore.js. Partners matches were
    // held back from this until the statistics understood sides rather than
    // seats; they no longer are (ENGINE_VERSION 9).
    recordMatch(document);
    uploadPartnerCopy(document);
    state.recorder = null;
  }
}

function applyHit(rawSegment) {
  if (state.gameOver) return;

  // A DART THROWN DURING THE HOLD BELONGS TO THE NEXT VISIT, NOT THE ONE THAT
  // JUST ENDED. Without this it was appended to the completed visit, and the
  // damage went well past a cosmetic one: the marks and points were credited to
  // the player who had already finished, so in pass-and-play the next player's
  // darts scored for their opponent. It surfaced as Cricket's MPR reading 12
  // and 15 - marks divided by ROUNDS, and no round can hold more than the nine
  // marks three treble beds are worth - which is the symptom that gives the
  // whole thing away, because x01 has no equivalent ceiling to breach.
  //
  // Committing rather than ignoring, because the hold is a courtesy and not a
  // lock: someone stepping up to the board is the clearest possible statement
  // that the visit is over, and swallowing their dart to protect an undo window
  // they did not ask for is the worse of the two failures. It is exactly what
  // End turn does mid-hold - see endTurnEarly - reached by throwing instead of
  // by pressing it.
  if (hold) {
    clearHold();
    commitTurn();
  }

  // One transform at the boundary, before any game logic sees the dart, so
  // full-bull applies identically to x01, Cricket and Count Up - and to
  // board hits, dartboard clicks and manual entry alike.
  const segment = applyBullMode(rawSegment, state.legConfig?.bull);

  if (state.gameType === "cricket") return applyCricketHit(segment);
  if (state.gameType === "countup") return applyCountUpHit(segment);
  if (state.gameType === "bermuda") return applyBermudaHit(segment);

  undoStack.push(snapshot());

  const player = state.players[state.currentPlayerIndex];
  const rules = rulesFor(state.legConfig?.rules);
  // Captured before the throw is applied, because the recorder wants the score
  // this dart was thrown at, not the one it left behind.
  const remainingBefore = player.remaining;
  const { after, isBust, isWin, opened, ignored, concedes } = resolvePartnersThrow(
    player.remaining, segment, {
      inRule: rules.in,
      outRule: rules.out,
      opened: player.opened !== false,
      // The freeze is asked about only in a partners leg that has it switched
      // on. resolvePartnersThrow with freeze off returns resolveThrow's answer
      // untouched, so an ordinary singles game takes exactly the path it
      // always did rather than a team-shaped one that happens to agree.
      ...freezeOptions(),
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

  state.recorder?.dart(recorderSeat(), segment, {
    remainingBefore,
    remainingAfter: isBust ? state.startOfTurnRemaining : Math.max(after, 0),
    bust: isBust,
    ignored,
    scored: ignored || isBust ? 0 : segment.value,
  });

  moveMarker(el.dartboardMarker, segment);
  cueHit();

  if (isBust) {
    cueBust();
    player.remaining = state.startOfTurnRemaining;
    endTurn({ busted: true });
  } else if (concedes) {
    // Reached zero while frozen, under the "loss" setting: the leg is over and
    // the OTHER team has won it. Deliberately not folded into the bust branch
    // above - a bust restores the score and passes the turn, this ends the leg
    // - and the score is left AT zero rather than restored, because that is
    // what happened and the throw log has to be able to show it.
    player.remaining = after;
    cueBust();
    finishLeg(opposingTeamOf(state.currentPlayerIndex), { conceded: true });
  } else {
    player.remaining = after;
    if (isWin) {
      cueCheckout();
      finishLeg(
        state.teams ? teamOf(state.currentPlayerIndex) : state.currentPlayerIndex,
        { finisherSeat: recorderSeat() },
      );
    } else if (state.dartsThisTurn.length >= 3) {
      endTurn();
    }
  }

  render();
}

// ---------------------------------------------------------------------------
// The two partners models, and the one place they differ
// ---------------------------------------------------------------------------
// SHARED TOTAL: the pair throws into one score, or one set of Cricket marks.
// A rules seat is then a TEAM, and `state.players` has two entries in a
// four-handed game - which is why nothing in cricket.js, scoring.js or
// bermuda.js changes: they are handed two players, exactly as in singles.
//
// The other model is freeze-ON partners x01, where every player carries their
// own remaining and a rules seat is still a person. Which one applies is
// decided by the LEG, not by the match, so a medley can hold both.
//
// This is the two-index split docs/team-play.md 3a warned about, and it is
// live from here down: the rules index is a team, the recorder index is a
// person, and recorderSeat() is the only bridge between them.
function isSharedTotal(legConfig = state.legConfig) {
  if (!state.teams) return false;
  if (legConfig?.game !== "x01") return true;      // Cricket, Count Up, Bermuda
  return !legConfig.freeze;                        // x01 shares unless frozen
}

// The absolute PERSON seat currently at the oche - what the recorder counts.
//
// Seats alternate, 0 and 2 against 1 and 3, the same convention teams.js and
// online.js use, so a doubles match reads back identically however it was
// played. In the shared-total model currentPlayerIndex is a team, so the
// thrower within that team supplies the rest; in every other case a rules seat
// is already a person and this returns it unchanged.
//
// GETTING THIS WRONG IS SILENT. Both partners score into the same total, so a
// dart credited to the wrong one leaves the scoreboard, the leg and the winner
// all correct and only the per-person averages wrong - see 3b.
function recorderSeat(index = state.currentPlayerIndex) {
  if (!isSharedTotal()) return index;
  return index + (state.throwerIndexes?.[index] ?? 0) * 2;
}

// Everyone on one side, in throwing order.
function rosterOf(index) {
  return state.rosters?.[index] ?? [state.players[index]?.name ?? "Player"];
}

function throwerNameOf(index) {
  const names = rosterOf(index);
  return names[(state.throwerIndexes?.[index] ?? 0) % names.length];
}

// The freeze half of a throw's options, or nothing at all when this is not a
// partners leg with the rule switched on.
//
// Kept as one function because the two numbers it produces are the ones the
// rule is easiest to get wrong about - it never reads the thrower's own score
// - so there is exactly one place that derives them, shared with the online
// controller when that arrives. teams.js does the actual pairing arithmetic.
function freezeOptions() {
  // Only the four-score model has a partner score to compare against. With a
  // shared total there is one number per side and the rule cannot be stated,
  // which is exactly why the freeze version keeps separate scores.
  if (!state.teams || !state.legConfig?.freeze || isSharedTotal()) return { freeze: false };
  const remainings = state.players.map((p) => p.remaining);
  return {
    freeze: true,
    frozenFinish: state.legConfig.frozenFinish || "loss",
    ...freezeInputs(remainings, state.currentPlayerIndex),
  };
}

// Is the player at the oche frozen right now? Read by the UI, which warns them
// BEFORE they throw - the reference machines do not, and say so in their own
// documentation, which makes this the cheapest improvement on them available.
function currentlyFrozen() {
  const opts = freezeOptions();
  if (!opts.freeze) return false;
  // isFrozen rather than re-writing `>` here. The comparison is the whole rule
  // and a second copy of it is a second thing to get backwards - which would
  // show as the warning disagreeing with what the throw then does.
  return isFrozen(opts.partnerRemaining, opts.opponentsCombined);
}

// A signed-in partner's own copy of the match, filed under their account.
//
// Their seat is found by NAME, because that is the only thing tying the person
// signed in to a seat at this board - they typed their name into a row, or it
// was filled in for them when they signed in. No match, no upload: crediting
// the wrong seat would put someone else's darts in their record, which is
// worse than not recording theirs.
function uploadPartnerCopy(document) {
  const partner = getPartner();
  if (!partner) return;
  const seat = (state.playerNames ?? [])
    .findIndex((n) => n.trim().toLowerCase() === partner.displayName.trim().toLowerCase());
  if (seat < 0 || seat === state.selfSeat) return;
  recordMatchForPartner(document, seat).catch(() => {});
}

function opposingTeamOf(seat) {
  return (teamOf(seat) + 1) % TEAM_COUNT;
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
  // Bermuda's rounds each have their own target and a miss halves the score, so
  // a bare turn total cannot express what happened.
  if (state.gameType === "bermuda") return;
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
  // The freeze applies to a quick total exactly as it does to a dart: what it
  // governs is reaching zero, and it makes no difference whether the three
  // darts were entered one at a time or added up first. Without this, whole-
  // turn entry would be a way to check out while frozen and get away with it.
  const { after, isBust, isWin, concedes } = resolvePartnersThrow(player.remaining, segment, {
    inRule: "straight",
    outRule: "straight",
    opened: true,
    ...freezeOptions(),
  });

  state.throwLog.unshift({
    playerName: player.name,
    label: segment.longName,
    value: segment.value,
    remainingAfter: isBust ? state.startOfTurnRemaining : Math.max(after, 0),
    bust: isBust,
  });

  hideMarker(el.dartboardMarker); // no single position to show for a turn total

  state.recorder?.quickTotal(recorderSeat(), {
    total: totalValue,
    remainingBefore,
    remainingAfter: isBust ? state.startOfTurnRemaining : Math.max(after, 0),
    bust: isBust,
    isCheckout: isWin,
  });

  if (isBust) {
    player.remaining = state.startOfTurnRemaining;
    endTurn();
  } else if (concedes) {
    player.remaining = after;
    finishLeg(opposingTeamOf(state.currentPlayerIndex), { conceded: true });
  } else {
    player.remaining = after;
    if (isWin) {
      finishLeg(
        state.teams ? teamOf(state.currentPlayerIndex) : state.currentPlayerIndex,
        { finisherSeat: recorderSeat() },
      );
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
// The names of the SIDES this match is scored between, in the order
// `match.legsWon` is indexed. Singles: one per player. Partners: one per team,
// which is both partners' names, because "Team 1 leads 2-1" tells you nothing
// about who is at the board and a scoreboard is read by people who know each
// other's names rather than their seat numbers.
//
// One function, because the leg tally, the match bar and the winner banner
// must all agree about what index 1 refers to - and a second derivation of
// that is how they would stop agreeing.
function sideNames() {
  const names = state.players.map((p) => p.name);
  if (!state.teams) return names;
  // With a shared total the rules seats ARE the sides, and they were named as
  // pairs when the leg was built - so this is already the answer. Rebuilding
  // it by seat parity here would pair up two pair-names and produce
  // "Ann & Cat & Ben & Dan".
  if (isSharedTotal()) return names;
  return Array.from({ length: TEAM_COUNT }, (_, team) =>
    names.filter((_n, seat) => teamOf(seat) === team).join(" & "));
}

function renderMatchBar() {
  if (!el.matchBar) return;
  const match = state.match;
  const multiLeg = match && match.legs.length > 1;

  el.matchBar.classList.toggle("hidden", !multiLeg);
  el.nextLegBtn?.classList.toggle("hidden", !state.legOver);
  // Next leg and Rematch are never both offered: one continues this match,
  // the other starts another, and only one of those is possible at a time.
  el.rematchBtn?.classList.toggle("hidden", !(state.gameOver && state.match?.over));

  if (!multiLeg) return;

  const names = sideNames();
  el.matchBar.querySelector(".match-progress").textContent = legProgressText(match);
  el.matchBar.querySelector(".match-score").textContent = matchScoreText(match, names);
}

// Winner banner has to cover three different endings: leg won with more to
// play, match won, and a drawn match (possible with an even number of legs).
function winnerBannerText() {
  const match = state.match;
  const names = sideNames();
  // A side is one person or two, so the verb has to agree with it. "Ben & Dan
  // wins!" is the kind of thing that makes a scoreboard look unfinished, and
  // the banner is the one line of the match everybody reads.
  const wins = state.teams ? "win" : "wins";
  const takes = state.teams ? "take" : "takes";

  if (match?.over) {
    if (match.drawn) return `Match drawn ${matchScoreText(match, names)}`;
    const winner = names[match.winnerIndex] ?? "Winner";
    return match.legs.length > 1
      ? `🏆 ${winner} ${wins} the match ${matchScoreText(match, names)}`
      : `🏆 ${winner} ${wins}!`;
  }

  // A Count Up leg can end level, in which case it's credited to nobody.
  if (state.winnerIndex === null || state.winnerIndex === undefined) {
    return `Leg ${match.currentLeg + 1} drawn · ${matchScoreText(match, names)}`;
  }
  const legWinner = names[state.winnerIndex] ?? "Winner";
  return `${legWinner} ${takes} leg ${match.currentLeg + 1} · ${matchScoreText(match, names)}`;
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
    finishLeg(checkCountUpWin(state.players, rounds), { finisherSeat: recorderSeat() });
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

  state.recorder?.dart(recorderSeat(), segment, {
    scored: result.points,
    extra: { points: result.points, total: player.total },
  });

  moveMarker(el.dartboardMarker, segment);

  if (state.dartsThisTurn.length >= 3) {
    player.roundsPlayed += 1;
    if (isLegComplete(state.players, state.legConfig.rounds ?? DEFAULT_ROUNDS)) {
      // checkCountUpWin returns null on a tie - finishLeg passes that through
      // to medley.js, which credits the leg to nobody.
      finishLeg(checkCountUpWin(state.players, state.legConfig.rounds ?? DEFAULT_ROUNDS),
        { finisherSeat: recorderSeat() });
    } else {
      endTurn();
    }
  }

  render();
}

// Bermuda Triangle: a fixed target per round, and missing it with all three
// darts halves the score. The halving is decided when the ROUND ends, never a
// dart at a time - "all three missed" is not a fact any single dart knows.
function applyBermudaHit(segment) {
  undoStack.push(snapshot());

  const player = state.players[state.currentPlayerIndex];
  const target = bermudaTarget(player.round);
  const result = resolveBermudaThrow(segment, target);
  applyBermudaThrow(player, result);

  state.dartsThisTurn.push(segment);
  state.throwLog.unshift({
    playerName: player.name,
    label: describeBermudaResult(segment, result, target),
    value: result.points,
    remainingAfter: player.total,
    bust: false,
  });

  state.recorder?.dart(recorderSeat(), segment, {
    scored: result.points,
    extra: { target: target?.label ?? null, hit: result.hit, points: result.points },
  });

  moveMarker(el.dartboardMarker, segment);

  if (isBermudaRoundOver(player)) {
    const round = endBermudaRound(player);
    // A halving is the single most surprising thing that happens in this game,
    // so it is said out loud rather than left as a score that silently dropped.
    if (round.missed && round.lost > 0) {
      state.throwLog.unshift({
        playerName: player.name,
        label: `Missed ${round.target?.label ?? "the target"} - score halved`,
        value: -round.lost,
        remainingAfter: player.total,
        bust: true,
      });
    }

    if (isBermudaComplete(state.players)) {
      finishLeg(checkBermudaWin(state.players), { finisherSeat: recorderSeat() });
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
  state.recorder?.dart(recorderSeat(), segment, {
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
    // currentPlayerIndex is the RULES seat, which with a shared total is
    // already the team - so it serves as the winner either way. The finishing
    // PERSON is separate, and is what marks the closing visit as theirs.
    finishLeg(state.currentPlayerIndex, { finisherSeat: recorderSeat() });
  } else if (state.dartsThisTurn.length >= 3) {
    endTurn();
  }

  render();
}

// ---------- Computer players ----------
// A bot throws through applyHit(), exactly as a Bluetooth board or a click
// does. Nothing downstream is aware it is a bot: undo works, the recorder
// records, the throw log logs. That is the entire integration.
//
// Timers rather than a loop, because a bot that emptied its whole turn into the
// state in one synchronous burst would show the human three darts appearing at
// once with no sense of a turn being taken.
let botTimer = null;

function currentBot() {
  // By person, not by rules seat: with a shared total the rules seat is a
  // team, and two people on one side can be a human and a computer.
  return state.bots[recorderSeat()] ?? null;
}

function cancelBot() {
  clearTimeout(botTimer);
  botTimer = null;
}

// Called after every render. Deciding here rather than at the end of endTurn()
// means it covers every route into a bot's turn - including undo, which can put
// one back on throw.
function maybeThrowForBot() {
  cancelBot();
  const bot = currentBot();
  if (!bot || state.gameOver || state.players.length === 0) return;

  botTimer = setTimeout(() => {
    // The world may have moved while the timer was pending - an undo, a new
    // game, a human taking the seat back.
    if (currentBot() !== bot || state.gameOver) return;

    const player = state.players[state.currentPlayerIndex];
    const dartsLeft = 3 - state.dartsThisTurn.length;

    // Every game mode gets its own answer here. A bot that threw at the treble
    // twenty all game is not a practice opponent in Bermuda - it is a bot that
    // misses the target in twelve of the thirteen rounds and halves its own
    // score doing it.
    let target;
    if (state.gameType === "cricket") {
      target = chooseCricketTarget(player.marks);
    } else if (state.gameType === "x01") {
      target = chooseX01Target(player.remaining, dartsLeft, rulesFor(state.legConfig?.rules).out);
    } else if (state.gameType === "bermuda") {
      target = chooseBermudaTarget(bermudaTarget(player.round));
    } else {
      target = chooseCountUpTarget();
    }

    applyHit(throwDart(target, bot.sigma));
  }, 700);
}

// ---------- The optional hold before the turn passes ----------
//
// The same idea online uses, and OPTIONAL here because the two modes need it
// for different reasons. Online must hold: without it, undoing a dart the
// opponent had already answered would mean rewinding their play too. Local
// play has no such problem - the undo stack survives the end of a visit
// already, so the darts are reachable either way - which leaves the hold
// buying a countdown at the price of a pause. In pass-and-play that price is
// paid every single visit, with the next player stood beside you waiting for
// the darts, so it is off unless asked for.
//
// The duration comes from prefs.js, which both controllers already import -
// game.js and online.js deliberately do not import each other, so that is the
// one place both can see it. Somebody who plays both modes should feel the
// same pause in each.
let hold = null; // { until, timer, ticker }

function clearHold() {
  if (!hold) return;
  clearTimeout(hold.timer);
  clearInterval(hold.ticker);
  hold = null;
}

function holdSecondsLeft() {
  if (!hold) return 0;
  return Math.max(0, Math.ceil((hold.until - Date.now()) / 1000));
}

function endTurn(opts = {}) {
  // A computer opponent never needs a chance to undo, and holding after its
  // visit would add ten seconds to every round of a practice game.
  const thrower = state.bots[state.currentPlayerIndex];
  if (!getPref("localHold") || thrower || state.gameOver) {
    commitTurn(opts);
    return;
  }
  clearHold();
  hold = {
    until: Date.now() + VISIT_HOLD_MS,
    timer: setTimeout(() => { commitTurn(opts); render(); }, VISIT_HOLD_MS),
    // Redraws the countdown. render() is cheap and already runs on every dart.
    ticker: setInterval(() => render(), 1000),
  };
  render();
}

function commitTurn({ busted = false } = {}) {
  // The caller announces the VISIT, so the total is taken before the darts are
  // cleared - and not at all on a bust, where cueBust has already said what
  // happened and a number would be a lie.
  if (!busted) {
    callScore(state.dartsThisTurn.reduce((sum, s) => sum + (s?.value || 0), 0));
  }
  // The seat is passed BEFORE currentPlayerIndex moves below - the visit being
  // closed is the one that has just been thrown, not the one about to start.
  state.recorder?.endTurn(recorderSeat());
  state.dartsThisTurn = [];
  clearHold();
  // The next visit on THIS side belongs to the other partner. Advanced before
  // the side moves on, so it is the side that has just thrown that rotates -
  // together with the line below, that produces the standard A1 B1 A2 B2.
  if (isSharedTotal()) {
    const roster = rosterOf(state.currentPlayerIndex).length || 1;
    state.throwerIndexes[state.currentPlayerIndex] =
      ((state.throwerIndexes[state.currentPlayerIndex] ?? 0) + 1) % roster;
  }
  state.currentPlayerIndex = (state.currentPlayerIndex + 1) % state.players.length;
  // Cricket players have no `remaining` - there's nothing to revert to,
  // since it has no bust rule.
  if (state.gameType !== "cricket" && state.gameType !== "countup"
      && state.gameType !== "bermuda") {
    state.startOfTurnRemaining = state.players[state.currentPlayerIndex].remaining;
  }
}

// Oche view's End turn. An event rather than a shared button, so ocheview.js
// need not know which controller is running - see the matching listener in
// online.js.
document.addEventListener("aio-end-turn", () => {
  if (!state.players.length || state.gameOver) return;
  endTurnEarly();
  render();
});

function endTurnEarly() {
  // Manually finalize the current turn (e.g. via the board's physical
  // button) without waiting for 3 registered darts, and without reverting
  // any score - only a bust does that.
  if (state.gameOver) return;
  // Mid-hold this means "stop waiting, hand over now" - the visit is already
  // complete and its snapshot was taken when its last dart landed, so pushing
  // another would make the first undo do nothing.
  if (hold) {
    clearHold();
    commitTurn();
    render();
    return;
  }
  undoStack.push(snapshot());
  endTurn();
  render();
}

function undo() {
  cancelBot();
  if (undoStack.length === 0) return;
  // The visit is no longer finished, so nothing should still be counting down
  // towards handing it over.
  clearHold();
  restore(undoStack.pop());
  render();
}

el.undoBtn.addEventListener("click", undo);

// ---------- Dartboard visualization ----------
// ---------- Render ----------
function render() {
  const cricket = state.gameType === "cricket";
  const countup = state.gameType === "countup";
  const bermuda = state.gameType === "bermuda";
  // x01 counts down to zero; the rest count up, just from different things.
  const scoreOf = (p) =>
    cricket ? p.points : (countup || bermuda) ? p.total : p.remaining;

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
  renderLiveAverage(el.ocheStat, state.recorder?.liveStats(recorderSeat()));
  renderCheckoutHint(el.checkoutHint, {
    // x01 only: Cricket has no "remaining", Count Up counts upwards, and
    // Bermuda's target is fixed by the round, so there is nothing to suggest.
    on: state.gameType === "x01" && !state.gameOver,
    remaining: current?.remaining,
    dartsLeft: 3 - state.dartsThisTurn.length,
    rules: state.legConfig?.rules,
    bull: state.legConfig?.bull,
  });

  if (state.gameOver) {
    // Count Up can end level, in which case there's no winner to name.
    // sideNames() rather than the player list, because in partners the winner
    // index counts teams - naming players[1] there would credit whoever
    // happens to sit in seat 1 for a leg their whole team won.
    const winner = sideNames()[state.winnerIndex];
    el.turnLabel.textContent = state.winnerIndex === null || state.winnerIndex === undefined
      ? "Leg drawn."
      // A conceded leg says WHY. Nobody watching saw the winning side throw
      // anything, so "X wins the leg" on its own reads as a bug in the app
      // rather than as the rule doing what it says.
      : state.legConceded
        ? `Checked out while frozen - ${winner} ${state.teams ? "take" : "takes"} the leg`
        : `${winner} ${state.teams ? "win" : "wins"} the leg! 🎯`;
  } else if (bermuda) {
    // The current target is the entire state of a Bermuda turn - without it on
    // screen the player has nothing to aim at - so it goes where the turn
    // label sits, with the round number for pacing.
    const target = bermudaTarget(current.round);
    el.turnLabel.textContent =
      `${current.name}'s turn · round ${Math.min(current.round + 1, BERMUDA_ROUNDS)} of ${BERMUDA_ROUNDS}` +
      ` · throw at ${target?.label ?? "-"}`;
  } else if (countup) {
    // Rounds remaining and the running average are the two numbers that
    // matter in a practice game, so they go where the turn label sits.
    const rounds = state.legConfig.rounds ?? DEFAULT_ROUNDS;
    const left = Math.max(0, rounds - current.roundsPlayed);
    el.turnLabel.textContent =
      `${current.name}'s turn · round ${Math.min(current.roundsPlayed + 1, rounds)} of ${rounds} · avg ${formatAverage(current)}`;
  } else if (state.teams) {
    // Partners. With a shared total `current.name` is the PAIR, so the thrower
    // has to be named separately - it is the one thing a doubles scoreboard
    // has to say that a singles one does not, and with both partners throwing
    // into one score nothing else on screen reveals whose go it is.
    el.turnLabel.textContent = isSharedTotal()
      ? `${throwerNameOf(state.currentPlayerIndex)} to throw · ${current.name}`
      : `${current.name}'s turn · ${teamLabel(state.currentPlayerIndex)}`;
  } else {
    el.turnLabel.textContent = `${current.name}'s turn`;
  }

  // FROZEN, SAID OUT LOUD. The reference machines do not do this - their own
  // documentation says spotting it is the player's responsibility - and the
  // penalty for missing it is the worst outcome in the game: reach zero and
  // the leg goes to the opposition. The app already knows all four scores and
  // the predicate is pure, so there is no reason to make anyone track it in
  // their head. Written after the branches above so it wins whatever the turn
  // label wanted to say, the same way the hold does below.
  if (!state.gameOver && currentlyFrozen()) {
    const finish = state.legConfig?.frozenFinish === "bust" ? "busts" : "loses the leg";
    el.turnLabel.textContent = `❄ ${current.name} is FROZEN - going out ${finish}`;
  }

  // The hold, said plainly. A silent pause reads as the app having frozen, and
  // the one thing worth saying - that there is still time to take a dart back -
  // would go unnoticed. Written after the branches above so it wins whatever
  // the game type wanted to say.
  const heldFor = holdSecondsLeft();
  if (heldFor > 0) {
    el.turnLabel.textContent = `Visit over - ${heldFor}s to undo · End turn to skip`;
  }

  renderMatchBar();
  maybeThrowForBot();

  // Cricket gets a marks grid; 501 doesn't. Quick Total is hidden in cricket
  // because a turn total says nothing about which numbers were hit.
  el.cricketBoard?.classList.toggle("hidden", !cricket);
  el.manualSection?.classList.toggle("cricket-mode", cricket);
  // Oche view needs to know Cricket is on the stage: the darts thrown are
  // absolutely positioned there, so they reserve no space, and the mark pad
  // centred itself straight underneath them. The reservation is keyed on this
  // class. online.js has set it since the mode was built; local play never
  // did, so the darts sat on top of the top two rows of the pad - which is
  // where the numbers you have already closed are.
  el.gamePanel?.classList.toggle("cricket-stage", cricket);
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
