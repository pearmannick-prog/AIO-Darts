// bermuda.js - Bermuda Triangle.
//
// Pure and side-effect-free, like scoring.js, cricket.js and countup.js, so
// local and online play compute identical results from identical inputs. That
// is what keeps two browsers in lockstep with no rollback machinery.
//
// The rules, from Arachnid's manual:
//
//   Players shoot at a different target each round. The targets are 12 through
//   20, then any Double, any Triple, the Single Bull and the Double Bull.
//
//   Hitting any segment of the current number accumulates points - a single 12
//   scores 12, a double 24, a triple 36. When "Double" is the current target,
//   ANY double scores; the same for "Triple".
//
//   Miss the current target with all three darts and your total is CUT IN HALF.
//
//   Highest score at the end wins.
//
// That halving is the whole character of the game: it is not a count-up with
// decoration, it is a game where a bad round is punished in proportion to how
// well you were doing. Somebody on 400 loses 200 for one missed round.

import { SegmentType } from "./granboard.js";

// The rounds, in order. `kind` is what makes a dart count:
//   number - any segment of that number
//   double - any double, anywhere on the board
//   triple - any triple, anywhere
//   bull   - the outer (single) bull specifically
//   dbull  - the inner (double) bull specifically
export const BERMUDA_TARGETS = Object.freeze([
  { kind: "number", value: 12, label: "12" },
  { kind: "number", value: 13, label: "13" },
  { kind: "number", value: 14, label: "14" },
  { kind: "number", value: 15, label: "15" },
  { kind: "number", value: 16, label: "16" },
  { kind: "number", value: 17, label: "17" },
  { kind: "number", value: 18, label: "18" },
  { kind: "number", value: 19, label: "19" },
  { kind: "number", value: 20, label: "20" },
  { kind: "double", label: "Any Double" },
  { kind: "triple", label: "Any Triple" },
  { kind: "bull", label: "Bullseye" },
  { kind: "dbull", label: "Double Bull" },
]);

export const BERMUDA_ROUNDS = BERMUDA_TARGETS.length;

export function createBermudaPlayer(name) {
  return {
    name,
    total: 0,
    round: 0,
    // Darts thrown in the current round, and whether any of them found the
    // target. The halving depends on the WHOLE round missing, so it cannot be
    // decided a dart at a time.
    dartsThisRound: 0,
    hitThisRound: false,
    // Kept for the scoreboard: what each completed round did to the total.
    history: [],
  };
}

export function bermudaTarget(roundIndex) {
  return BERMUDA_TARGETS[roundIndex] ?? null;
}

// Does this dart count for this target, and if so for how much?
//
// The scoring is the segment's own value in every case - a triple 20 on the
// "Any Triple" round is worth 60, not 20 - because the rule is "hitting any
// segment of the current number accumulates points" and the segment's value is
// what it is worth.
export function resolveBermudaThrow(segment, target) {
  const none = { hit: false, points: 0 };
  if (!segment || !target) return none;

  switch (target.kind) {
    case "number":
      // Any segment of that number: single, double or triple.
      return Number(segment.section) === target.value
        ? { hit: true, points: segment.value }
        : none;

    case "double":
      // Any double anywhere. The inner bull is a double and counts.
      return segment.type === SegmentType.Double
        ? { hit: true, points: segment.value }
        : none;

    case "triple":
      return segment.type === SegmentType.Triple
        ? { hit: true, points: segment.value }
        : none;

    case "bull":
      // The outer bull specifically. An inner bull is a bull too and is worth
      // more, so it counts here rather than being a miss - refusing it would
      // punish the better dart.
      return segment.section === "BULL"
        ? { hit: true, points: segment.value }
        : none;

    case "dbull":
      return segment.section === "BULL" && segment.type === SegmentType.Double
        ? { hit: true, points: segment.value }
        : none;

    default:
      return none;
  }
}

// Applies one dart. Mutates the player the caller owns, the same way
// applyCricketResult does, so the resolve step above stays pure and testable.
export function applyBermudaThrow(player, result) {
  player.dartsThisRound += 1;
  if (result.hit) {
    player.hitThisRound = true;
    player.total += result.points;
  }
}

export function isBermudaRoundOver(player) {
  return player.dartsThisRound >= 3;
}

// Ends the round, applying the halving if all three darts missed. Returns what
// happened, so the UI can say so rather than leaving the player to work out why
// their score dropped.
//
// Halved scores are rounded DOWN. The rule says "cut in half" and does not say
// what to do with an odd number; rounding down is the reading that keeps the
// punishment a punishment.
export function endBermudaRound(player) {
  const missed = !player.hitThisRound;
  const before = player.total;

  if (missed) player.total = Math.floor(player.total / 2);

  const entry = {
    round: player.round,
    target: bermudaTarget(player.round),
    missed,
    before,
    after: player.total,
    lost: before - player.total,
  };
  player.history.push(entry);

  player.round += 1;
  player.dartsThisRound = 0;
  player.hitThisRound = false;

  return entry;
}

export function isBermudaComplete(players) {
  return players.every((p) => p.round >= BERMUDA_ROUNDS);
}

// Highest total wins. Returns null on a tie rather than picking one - the same
// choice Count Up makes, and for the same reason: awarding the win arbitrarily
// is worse than saying it was level.
export function checkBermudaWin(players) {
  if (!players.length) return null;
  let best = -Infinity;
  let winner = null;
  let tied = false;

  players.forEach((player, index) => {
    if (player.total > best) {
      best = player.total;
      winner = index;
      tied = false;
    } else if (player.total === best) {
      tied = true;
    }
  });

  return tied ? null : winner;
}

export function describeBermudaResult(segment, result, target) {
  if (!result.hit) return `${segment.longName} - missed ${target?.label ?? "target"}`;
  return `${segment.longName} - ${result.points} on ${target?.label ?? "target"}`;
}
