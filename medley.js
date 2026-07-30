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

// A leg is an object rather than a bare game name, because x01 isn't one game
// - a leg needs to carry its starting score and its in/out rules too:
//   { game: "x01", score: 501, rules: "double" }
//   { game: "cricket" }
// Plain strings are still accepted and normalised, so older callers and saved
// configs keep working.
export function normalizeLeg(leg) {
  if (typeof leg === "string") {
    if (leg === "cricket") return { game: "cricket" };
    const score = Number(leg);
    return { game: "x01", score: Number.isFinite(score) && score > 0 ? score : 501, rules: "double" };
  }
  if (!leg || typeof leg !== "object") return { game: "x01", score: 501, rules: "double" };
  if (leg.game === "cricket") return { game: "cricket" };
  return {
    game: "x01",
    score: Number(leg.score) > 0 ? Number(leg.score) : 501,
    rules: leg.rules || "double",
  };
}

export function gameLabel(leg) {
  const l = normalizeLeg(leg);
  if (l.game === "cricket") return "Cricket";
  // "501 · Double out" - the variant matters as much as the number, so it's
  // always shown rather than only when it's unusual.
  return `${l.score} · ${rulesLabel(l.rules)}`;
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
export function recordLegWin(match, winnerIndex) {
  if (match.over) return match;
  match.legsWon[winnerIndex] += 1;

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
