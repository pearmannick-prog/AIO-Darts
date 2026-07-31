// countup.js - Count Up rules.
//
// The standard practice game on electronic boards, and the simplest scoring
// in the app: every dart adds its face value, you throw a fixed number of
// rounds, and the highest total wins. There is no bust, no double to start
// or finish, and no way to lose points - which is exactly why it's what
// people use to warm up or measure themselves.
//
// Pure and side-effect-free like scoring.js and cricket.js, so both local and
// online play compute identical results from identical inputs.

export const COUNTUP_ROUND_OPTIONS = [5, 8, 10, 15, 20];
export const DEFAULT_ROUNDS = 8;

export function createCountUpPlayer(name) {
  return { name, total: 0, roundsPlayed: 0 };
}

// Every dart counts at face value - a miss is 0, bull 25, double bull 50.
// createSegment already carries the right value for all of those, so there's
// nothing to special-case.
export function resolveCountUpThrow(segment) {
  const points = Number(segment?.value) || 0;
  return { points };
}

export function applyCountUpResult(player, result) {
  player.total += result.points;
}

// A round is one visit of three darts, so rounds and turns are the same
// thing - the caller increments this when a turn ends.
export function isPlayerDone(player, rounds) {
  return player.roundsPlayed >= rounds;
}

// The game only ends once EVERY player has had their full allocation, not
// when the first player finishes - otherwise whoever threw first would be
// scored against opponents who'd had fewer darts.
export function isLegComplete(players, rounds) {
  return players.every((p) => isPlayerDone(p, rounds));
}

// Highest total wins. Returns the winning index, or null on a tie - unlike
// x01 and Cricket, Count Up can genuinely end level, and inventing a winner
// would be worse than reporting the draw.
export function checkCountUpWin(players, rounds) {
  if (!isLegComplete(players, rounds)) return null;
  let best = -Infinity;
  let winner = null;
  let tied = false;
  players.forEach((p, i) => {
    if (p.total > best) {
      best = p.total;
      winner = i;
      tied = false;
    } else if (p.total === best) {
      tied = true;
    }
  });
  return tied ? null : winner;
}

// The number people actually care about in practice: points per round. A
// "ton a round" (100) is the usual benchmark to aim at.
export function roundAverage(player) {
  if (!player.roundsPlayed) return 0;
  return player.total / player.roundsPlayed;
}

export function formatAverage(player) {
  return roundAverage(player).toFixed(1);
}

export function describeCountUpResult(segment, result) {
  const name = segment?.longName || "Miss";
  return result.points > 0 ? `${name} (+${result.points})` : `${name} (0)`;
}
