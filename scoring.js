// scoring.js - pure x01 rules (301 / 501 / 701 and their in/out variants),
// shared by local pass-and-play and online play.
//
// Kept dependency-free and side-effect-free so both game modes compute
// identical results from identical inputs (this is what keeps two remote
// browsers in sync without needing a rollback/replay system - see README).
//
// x01 is a family rather than one game. Three things vary:
//
//   Starting score - 301, 501, 701. Nothing else changes with it.
//
//   The IN rule - whether you have to hit something specific before any of
//   your darts count at all. "Straight in" (the usual) means you're scoring
//   from the first dart. "Double in" means nothing counts until you land a
//   double; darts thrown before that are still darts, they just score zero.
//
//   The OUT rule - what you're allowed to finish on:
//     straight - anything, including a single. Leaving 1 is fine.
//     double   - the standard. Leaving 1 busts, because 1 can't be made
//                with a double.
//     master   - a double OR a triple. Leaving 1 busts for the same reason.
//
// The named combinations people ask for:
//   SISO - single in, single out  -> in: straight, out: straight
//   DIDO - double in, double out  -> in: double,   out: double
//   Master out                    -> in: straight, out: master

import { SegmentType } from "./granboard.js";

export const X01_SCORES = [301, 501, 701];

// The rule presets offered in the UI. Each maps to a concrete in/out pair, so
// everything downstream only ever deals with those two values.
export const X01_RULES = {
  double: { label: "Double out", in: "straight", out: "double" },
  siso: { label: "SISO (single in, single out)", in: "straight", out: "straight" },
  dido: { label: "DIDO (double in, double out)", in: "double", out: "double" },
  master: { label: "Master out (double or triple)", in: "straight", out: "master" },
};

export function rulesFor(key) {
  return X01_RULES[key] || X01_RULES.double;
}

export function rulesLabel(key) {
  return rulesFor(key).label;
}

// Does this dart satisfy the "in" requirement - i.e. is it allowed to open a
// player's scoring?
export function segmentOpens(segment, inRule) {
  if (inRule !== "double") return true;
  return segment.type === SegmentType.Double;
}

// Is this dart allowed to be the finishing one?
export function segmentCanFinish(segment, outRule) {
  if (outRule === "straight") return true;
  if (outRule === "master") {
    return segment.type === SegmentType.Double || segment.type === SegmentType.Triple;
  }
  return segment.type === SegmentType.Double;
}

// The highest score a leg can be checked out from in a single visit, which is
// NOT a constant - it depends on the out rule, and getting that wrong silently
// mis-scores every checkout statistic:
//
//   double out - the last dart must be a double, and the biggest double is the
//                bull at 50, so the ceiling is T20 T20 BULL = 170.
//   master out - a triple may finish, so T20 T20 T20 = 180 is a checkout.
//   straight   - anything may finish, so 180 again.
//
// Lives here rather than in the statistics code because it is a fact about the
// rules, and two copies of it would be two things to fix.
export function highestCheckout(rulesKey) {
  return rulesFor(rulesKey).out === "double" ? 170 : 180;
}

// Can this remaining score be finished with ONE legal dart? Used to decide
// which darts were attempts at a finish.
//
// The segments that exist: singles 1-20 and the 25 outer bull; doubles 2-40
// even and the 50 bull; triples 3-60 in multiples of three. Which of them may
// legally finish is what the out rule decides.
export function isOneDartFinish(remaining, rulesKey) {
  if (!Number.isInteger(remaining) || remaining <= 0) return false;

  const isDouble = (remaining <= 40 && remaining % 2 === 0) || remaining === 50;
  const out = rulesFor(rulesKey).out;
  if (out === "double") return isDouble;

  const isTriple = remaining <= 60 && remaining % 3 === 0;
  if (out === "master") return isDouble || isTriple;

  const isSingle = remaining <= 20 || remaining === 25;
  return isDouble || isTriple || isSingle;
}

// Given a player's remaining score before a throw and the segment hit,
// returns what happens - the caller decides how to apply it (bust reverts
// to the start-of-turn value, which only the caller knows).
//
// options:
//   inRule  - "straight" | "double"                (default straight)
//   outRule - "straight" | "double" | "master"     (default double)
//   opened  - has this player already satisfied the in rule? (default true)
//
// The defaults are plain 501 double-out, so callers that don't care about
// variants can keep passing two arguments and behave exactly as before.
export function resolveThrow(remainingBefore, segment, options = {}) {
  const { inRule = "straight", outRule = "double", opened = true } = options;

  // Double-in: until the player opens, darts land but score nothing. They
  // still count as darts thrown, so a turn is still three of them.
  if (!opened) {
    if (!segmentOpens(segment, inRule)) {
      return {
        after: remainingBefore,
        isBust: false,
        isWin: false,
        opened: false,
        ignored: true, // scored nothing because the player hasn't opened yet
      };
    }
    // The opening dart itself counts, so fall through and score it normally.
  }

  const after = remainingBefore - segment.value;
  const canFinish = segmentCanFinish(segment, outRule);

  // Leaving exactly 1 is only a problem when you need a double or triple to
  // finish - there's no double or triple that makes 1. With straight out you
  // can simply hit a single 1 next, so it isn't a bust.
  const strandedOnOne = after === 1 && outRule !== "straight";

  const isWin = after === 0 && canFinish;
  const isBust = after < 0 || strandedOnOne || (after === 0 && !canFinish);

  return { after, isBust, isWin, opened: true, ignored: false };
}
