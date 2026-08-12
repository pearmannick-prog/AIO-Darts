// medley.js - match structure: a sequence of legs, each with its own game.
//
// A "medley" is a match whose legs aren't all the same game - leg 1 might be
// 501, leg 2 Cricket, leg 3 501 again. A plain single game is just a one-leg
// medley, so there's no separate code path for it: everything below works
// unchanged when legs.length === 1, and the UI simply has nothing extra to
// show.
//
// Pure and side-effect-free, same as scoring.js and cricket.js, so online play
// can reuse it later without a second implementation.

import { rulesLabel } from "./scoring.js";
import { DEFAULT_ROUNDS } from "./countup.js";
import { BERMUDA_ROUNDS } from "./bermuda.js";

// A leg is an object rather than a bare game name, because x01 isn't one game
// - a leg needs to carry its starting score and its in/out rules too:
//   { game: "x01", score: 501, rules: "double" }
//   { game: "cricket" }
// Plain strings are still accepted and normalised, so older callers and saved
// configs keep working.
// Shared so the local setup panel and the online format picker offer exactly
// the same formats - two lists would drift.
export const MATCH_PRESETS = {
  "single-301": [{ game: "x01", score: 301, rules: "double" }],
  "single-501": [{ game: "x01", score: 501, rules: "double" }],
  "single-701": [{ game: "x01", score: 701, rules: "double" }],
  "single-cricket": [{ game: "cricket" }],
  "single-countup": [{ game: "countup", rounds: DEFAULT_ROUNDS }],
  "single-bermuda": [{ game: "bermuda" }],
  bo3: [
    { game: "x01", score: 501, rules: "double" },
    { game: "cricket" },
    { game: "x01", score: 501, rules: "double" },
  ],
  bo5: [
    { game: "x01", score: 501, rules: "double" },
    { game: "cricket" },
    { game: "x01", score: 501, rules: "double" },
    { game: "cricket" },
    { game: "x01", score: 501, rules: "double" },
  ],
};

export function normalizeLeg(leg) {
  // Legacy bare strings, turned into leg objects and then normalized by the
  // SAME code below rather than by a parallel set of returns.
  //
  // They used to return finished descriptors of their own, and that quietly
  // broke the moment x01 grew a field: a "501" leg came back without the
  // freeze keys while an equivalent object leg had them, so two legs that are
  // the same game disagreed about their own shape depending on which build
  // had written them down. Anything added to x01 from here on lands on both
  // paths because there is only one.
  if (typeof leg === "string") {
    if (leg === "cricket") return { game: "cricket", bull: "split" };
    if (leg === "bermuda") return { game: "bermuda", bull: "split" };
    if (leg === "countup") return normalizeLeg({ game: "countup", rounds: DEFAULT_ROUNDS });
    const score = Number(leg);
    return normalizeLeg({
      game: "x01",
      score: Number.isFinite(score) && score > 0 ? score : 501,
    });
  }
  if (!leg || typeof leg !== "object") return normalizeLeg({ game: "x01", score: 501 });
  // Cricket is always split-bull: outer is one mark, inner is two. Full bull
  // isn't a Cricket variant, so the leg pins itself to split rather than
  // inheriting the match setting. That makes applyBullMode a no-op here
  // without either game mode needing a special case.
  if (leg.game === "cricket") return { game: "cricket", bull: "split" };
  // Bermuda's targets include the bull explicitly and its last round IS the
  // inner bull, so full-bull mode - which promotes the outer bull to the inner
  // - would collapse two distinct rounds into one. Pinned to split for the
  // same reason Cricket is.
  if (leg.game === "bermuda") return { game: "bermuda", bull: "split" };
  const bull = leg.bull === "full" ? "full" : "split";
  if (leg.game === "countup") {
    return {
      game: "countup",
      rounds: Number(leg.rounds) > 0 ? Number(leg.rounds) : DEFAULT_ROUNDS,
      bull,
    };
  }
  // The Freeze Rule, and what happens when a frozen player reaches zero.
  //
  // These sit BESIDE `rules` rather than inside it because `rules` is a string
  // key into X01_RULES - "double", "master-open" and so on - not an object
  // with room for another field. docs/team-play.md assumed otherwise; this is
  // the shape the code actually has.
  //
  // The freeze is a partners rule and does nothing in a singles leg, but it is
  // normalized unconditionally all the same: an absent key must mean the
  // default rather than undefined behaviour, and a leg descriptor that
  // describes itself fully is what lets a saved match be read back without
  // knowing which mode recorded it.
  return {
    game: "x01",
    score: Number(leg.score) > 0 ? Number(leg.score) : 501,
    rules: leg.rules || "double",
    freeze: leg.freeze === true,
    // "loss" is the sourced behaviour - reaching zero while frozen hands the
    // leg to the opposition - and therefore the default. "bust" is the gentler
    // house reading: the score is restored and the turn passes, exactly like
    // any other bust.
    frozenFinish: leg.frozenFinish === "bust" ? "bust" : "loss",
    bull,
  };
}

export function gameLabel(leg) {
  const l = normalizeLeg(leg);
  // Only mentioned when it isn't the default, so ordinary legs read cleanly.
  const bull = l.bull === "full" ? " · full bull" : "";
  if (l.game === "cricket") return "Cricket"; // always split bull
  if (l.game === "bermuda") return `Bermuda Triangle · ${BERMUDA_ROUNDS} rounds`;
  if (l.game === "countup") return `Count Up · ${l.rounds} rounds${bull}`;
  // "501 · Double out" - the variant matters as much as the number, so it's
  // always shown rather than only when it's unusual.
  //
  // The freeze is named only when it is on, like full bull: it applies to
  // partners games alone, so mentioning it on every singles leg would be noise
  // on the format most people play.
  const freeze = l.freeze
    ? ` · freeze${l.frozenFinish === "bust" ? " (bust)" : ""}`
    : "";
  return `${l.score} · ${rulesLabel(l.rules)}${freeze}${bull}`;
}

export function createMatch(legGames, playerCount) {
  const legs = (legGames?.length ? legGames : ["501"]).map(normalizeLeg);
  return {
    legs,
    currentLeg: 0,
    legsWon: new Array(playerCount).fill(0),
    // Set when the match is decided - either all legs played or someone has
    // an unassailable lead.
    over: false,
    winnerIndex: null,
    drawn: false,
  };
}

// The full leg descriptor for the leg in progress.
export function currentLegConfig(match) {
  return match.legs[match.currentLeg] ?? match.legs[match.legs.length - 1];
}

// Just "x01" or "cricket" - for callers that only need to branch on which
// board/scoreboard to show.
export function currentGameType(match) {
  return currentLegConfig(match).game;
}

export function isFinalLeg(match) {
  return match.currentLeg >= match.legs.length - 1;
}

// Darts convention: the throw alternates each leg, so the same player doesn't
// get the advantage of going first every time.
export function startingPlayerForLeg(legIndex, playerCount) {
  return playerCount > 0 ? legIndex % playerCount : 0;
}

function ranked(match) {
  return match.legsWon
    .map((wins, index) => ({ wins, index }))
    .sort((a, b) => b.wins - a.wins);
}

// Whoever is ahead right now, or null if it's level at the top.
export function leaderOf(match) {
  const [first, second] = ranked(match);
  if (!first) return null;
  if (second && second.wins === first.wins) return null;
  return first.index;
}

// Has someone already won more legs than anyone else can still reach? A
// best-of-5 sitting at 3-0 is over - playing legs 4 and 5 can't change it.
export function clinchedBy(match) {
  const remaining = match.legs.length - (match.currentLeg + 1);
  const [first, second] = ranked(match);
  if (!first) return null;
  // Solo: there's nobody to build an unassailable lead over, so a medley
  // plays every leg instead of "clinching" the moment the first one is won.
  if (!second) return null;
  return first.wins > second.wins + remaining ? first.index : null;
}

// Records a leg win and decides whether the match is finished. Mutates the
// match object the caller owns - the decision logic above stays pure.
// winnerIndex may be null: Count Up legs can end level, and awarding the leg
// to nobody is more honest than picking a winner arbitrarily. The match still
// progresses - it just isn't credited to either player.
export function recordLegWin(match, winnerIndex) {
  if (match.over) return match;
  if (winnerIndex !== null && winnerIndex !== undefined) {
    match.legsWon[winnerIndex] += 1;
  }

  const clinch = clinchedBy(match);
  if (clinch !== null) {
    match.over = true;
    match.winnerIndex = clinch;
    return match;
  }

  if (isFinalLeg(match)) {
    match.over = true;
    const leader = leaderOf(match);
    // An even number of legs can genuinely end level - say so rather than
    // inventing a winner.
    match.winnerIndex = leader;
    match.drawn = leader === null;
  }
  return match;
}

export function advanceLeg(match) {
  if (match.over) return match;
  match.currentLeg += 1;
  return match;
}

// "2 – 1" for the scoreboard.
export function matchScoreText(match, names) {
  return match.legsWon
    .map((wins, i) => `${names?.[i] ?? `P${i + 1}`} ${wins}`)
    .join("  –  ");
}

export function legProgressText(match) {
  if (match.legs.length <= 1) return "";
  return `Leg ${match.currentLeg + 1} of ${match.legs.length} · ${gameLabel(currentLegConfig(match))}`;
}
