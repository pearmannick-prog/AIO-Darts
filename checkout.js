// checkout.js - what to aim at to finish.
//
// Pure, and deliberately knows nothing about the DOM, the board or a match. It
// answers one question: from this score, with these darts left, under these
// rules, what are the ways out and which is best.
//
// IT COMPOSES THE RULES, IT DOES NOT RESTATE THEM. Which dart may finish is
// scoring.js's `out` rule; whether the bull is one target or two is the bull
// mode the match was set up with. Both are read here rather than re-derived,
// because a second opinion about what finishes a leg is a second set of rules,
// and the two would drift. The existing test file exists for exactly this class
// of bug - arithmetic that looks right for months.
//
// BULL MODE CHANGES THE ANSWER, which is why it is a parameter and not a
// constant. Under SPLIT bull the outer ring is a 25 single and the inner is a
// 50 double, so 170 (T20 T20 BULL) is the highest possible finish and 25 is a
// legal number to leave. Under FULL bull the whole bull scores 50 and counts as
// the double (see applyBullMode in granboard.js), so 25 simply does not exist
// as a target and every route through it disappears. A checkout chart printed
// for one is wrong for the other, which is why darts sites publish two.

import { rulesFor } from "./scoring.js";

// Every target on the board, as a scoring fact rather than board geometry.
// `base` is the number in the bed, which is what the preference ordering below
// cares about - D16 and D8 are the same family.
function targetsFor(bullMode) {
  const list = [];
  for (let n = 1; n <= 20; n++) {
    list.push({ label: `S${n}`, value: n, kind: "single", base: n });
    list.push({ label: `D${n}`, value: n * 2, kind: "double", base: n });
    list.push({ label: `T${n}`, value: n * 3, kind: "triple", base: n });
  }
  // The inner bull is a DOUBLE in this codebase's model, which is what makes a
  // 50 finish legal under double out.
  list.push({ label: "BULL", value: 50, kind: "double", base: 25 });
  // The outer bull exists only when the bull is split. Under full bull a dart
  // there scores 50 and is the inner bull for every purpose.
  if (bullMode !== "full") {
    list.push({ label: "25", value: 25, kind: "single", base: 25 });
  }
  return list;
}

// Mirrors segmentCanFinish in scoring.js, in this module's own vocabulary. The
// bull is tested by `base` rather than by kind for the same reason it is tested
// by section there: under master out the OUTER bull finishes, and it is a
// single.
function canFinish(target, outRule) {
  if (outRule === "straight") return true;
  if (outRule === "master") {
    return target.kind === "double" || target.kind === "triple" || target.base === 25;
  }
  return target.kind === "double";
}

// What a non-finishing dart is allowed to leave behind. Leaving exactly 1 is
// the edge case the rules encode: it busts under double and master out because
// no legal finishing dart scores 1, but it is perfectly playable under SISO.
function leavesPlayable(rest, outRule) {
  if (rest <= 0) return false;
  return outRule === "straight" ? true : rest >= 2;
}

// The biggest single dart, used to prune the search: no point exploring a first
// dart that leaves more than the remaining darts could ever finish.
const MAX_DART = 60;

// Which double you would rather be left on, best first.
//
// This is the judgement in the file, and it is a convention rather than a
// derivation - it is why two checkout charts from different sites disagree
// about 81 while both being correct. 16 leads the list because it is the one
// that splits cleanly all the way down (16, 8, 4, 2), so missing it big still
// leaves a number you have practised; 20 follows because it is the one everyone
// throws at. Odd doubles are last: missing one leaves an odd score and another
// dart spent putting it right. The bull sits below the even doubles because
// finishing on it is a shot people avoid when they have any choice - the charts
// only route through it when the arithmetic forces it, as at 170 and 167.
// The bull is LAST, below even the odd doubles. It is a smaller target than any
// double bed, and the charts route through it only when the arithmetic leaves
// no choice - which is why 170 and 167 finish on it and 158 does not.
const DOUBLE_ORDER = [16, 20, 8, 12, 10, 18, 4, 14, 6, 2, 19, 17, 15, 13, 11, 9, 7, 5, 3, 1, 25];
const doubleRank = (target) => {
  const at = DOUBLE_ORDER.indexOf(target.base);
  return at < 0 ? DOUBLE_ORDER.length : at;
};

// A dart thrown to SET UP a finish is a different thing from one thrown to
// take it. Setup darts want a big, forgiving target - a treble, or the fat
// single beside it. Nobody throws at a double to leave a number, and nobody
// throws at the bull to leave one either: both are small and both are worth
// less than the treble you would otherwise be aiming at.
//
// Without this the search happily produced "60: D14 D16" and "132: T20 D20
// D16" - arithmetically perfect, and not what any player or any chart would
// tell you to throw. The penalty is larger than the whole double-preference
// range so that it always dominates: being left on a nicer double never
// justifies setting up on a double to get there.
const SETUP_PENALTY = 3000;

function setupCost(route) {
  let cost = 0;
  for (let i = 0; i < route.length - 1; i++) {
    if (route[i].kind === "double" || route[i].base === 25) cost += SETUP_PENALTY;
  }
  return cost;
}

// Lower is better. Darts dominate everything - a two-dart out always beats a
// three-dart out - then whether the setup darts are sane targets, then which
// double you are left on, then how much the first dart scores, so that T20
// leads where the rest is equal.
function routeScore(route) {
  const last = route[route.length - 1];
  return route.length * 100000
    + setupCost(route)
    + doubleRank(last) * 100
    + (MAX_DART - route[0].value);
}

/**
 * Every way to finish `remaining` with at most `dartsLeft` darts.
 * Returned best-first; empty when there is no way out.
 */
export function checkoutRoutes(remaining, dartsLeft = 3, rulesKey = "double", bullMode = "split", { limit = 12 } = {}) {
  if (!Number.isInteger(remaining) || remaining <= 0) return [];
  if (!Number.isInteger(dartsLeft) || dartsLeft <= 0) return [];

  const outRule = rulesFor(rulesKey).out;
  const targets = targetsFor(bullMode);
  const routes = [];

  const walk = (left, dartsUsed, path) => {
    const dartsRemaining = dartsLeft - dartsUsed;
    if (dartsRemaining <= 0) return;
    // Unreachable even if every remaining dart were a treble 20.
    if (left > MAX_DART * dartsRemaining) return;

    for (const target of targets) {
      const rest = left - target.value;
      if (rest === 0) {
        if (canFinish(target, outRule)) routes.push([...path, target]);
        continue;
      }
      if (!leavesPlayable(rest, outRule)) continue;
      walk(rest, dartsUsed + 1, [...path, target]);
    }
  };

  walk(remaining, 0, []);
  routes.sort((a, b) => routeScore(a) - routeScore(b));

  // "T20 T19 D12" and "T19 T20 D12" are the same checkout, and a list showing
  // both is a list nobody reads. Sorting has already put the sensible ordering
  // first - the bigger dart earlier - so the first one seen wins and the rest
  // of its permutations are dropped. The finishing dart stays part of the key:
  // ending on D12 rather than D18 is a real difference, not a reordering.
  const seen = new Set();
  const distinct = [];
  for (const route of routes) {
    const key = route.slice(0, -1).map((t) => t.label).sort().join("|")
      + ">" + route[route.length - 1].label;
    if (seen.has(key)) continue;
    seen.add(key);
    distinct.push(route);
    if (distinct.length >= limit) break;
  }
  return distinct;
}

/** The single route a player should be shown, or null if there isn't one. */
export function bestCheckout(remaining, dartsLeft = 3, rulesKey = "double", bullMode = "split") {
  return checkoutRoutes(remaining, dartsLeft, rulesKey, bullMode, { limit: 1 })[0] || null;
}

/** Is there any way out at all from here with the darts in hand? */
export function isCheckoutable(remaining, dartsLeft = 3, rulesKey = "double", bullMode = "split") {
  return bestCheckout(remaining, dartsLeft, rulesKey, bullMode) !== null;
}

/**
 * What to actually put on screen, given the player's preference. Returns lines
 * of text and touches no DOM: this module stays pure, so the controllers set
 * textContent and the tests stay runnable in node.
 *
 * `level` is off / route / all, and "only under 100" exists because a
 * suggestion at 400 is noise - there is nothing to plan yet, and a hint that is
 * always on stops being read.
 */
export function checkoutAdvice(remaining, dartsLeft, rulesKey, bullMode, options = {}) {
  const { level = "off", onlyUnder100 = false } = options;
  if (level === "off") return [];
  if (onlyUnder100 && remaining > 100) return [];
  const limit = level === "all" ? 3 : 1;
  return checkoutRoutes(remaining, dartsLeft, rulesKey, bullMode, { limit }).map(describeRoute);
}

/**
 * "T20 T20 D20" - the form a player reads on a wall chart, where a plain
 * number means a single.
 */
export function describeRoute(route) {
  if (!route?.length) return "";
  return route.map((t) => (t.kind === "single" ? String(t.value) : t.label)).join(" ");
}
