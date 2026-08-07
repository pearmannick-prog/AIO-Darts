// Tests for the checkout finder.
//
// This one earns its place for the same reason the statistics do: a wrong
// checkout route is PLAUSIBLE. It is three darts that add up, shown on a
// screen, and nothing about it looks wrong - a player follows it, misses, and
// blames themselves. There is no board to check it against and no error to
// catch; the only way to know that 141 comes out T20 T19 D12 is to assert it.
//
// The reference values below are the standard UK checkout charts, one per bull
// mode. They are a convention rather than a derivation - charts from different
// sites disagree about a handful of scores - so what is asserted here is the
// arithmetic, the rules, and the cases where the charts genuinely agree.

import test from "node:test";
import assert from "node:assert/strict";

import {
  checkoutRoutes, bestCheckout, isCheckoutable, describeRoute,
} from "../checkout.js";
import { highestCheckout, isOneDartFinish } from "../scoring.js";

const out = (n, darts = 3, rules = "double", bull = "split") => {
  const route = bestCheckout(n, darts, rules, bull);
  return route ? describeRoute(route) : null;
};

const total = (route) => route.reduce((sum, t) => sum + t.value, 0);

// ---------------------------------------------------------------------------
// The chart

test("the standard three-dart finishes come out as the chart prints them", () => {
  const chart = {
    170: "T20 T20 BULL",
    167: "T20 T19 BULL",
    164: "T20 T18 BULL",
    161: "T20 T17 BULL",
    160: "T20 T20 D20",
    158: "T20 T20 D19",
    141: "T20 T19 D12",
    132: "T20 T16 D12",
    100: "T20 D20",
    98: "T20 D19",
    96: "T20 D18",
    81: "T19 D12",
    60: "20 D20",
    50: "BULL",
    40: "D20",
    32: "D16",
  };
  for (const [score, expected] of Object.entries(chart)) {
    assert.equal(out(Number(score)), expected, `checkout for ${score}`);
  }
});

test("a route always adds up to the score it finishes", () => {
  for (let n = 2; n <= 170; n++) {
    for (const route of checkoutRoutes(n, 3, "double", "split")) {
      assert.equal(total(route), n, `route for ${n}: ${describeRoute(route)}`);
    }
  }
});

// ---------------------------------------------------------------------------
// The rules, which are scoring.js's and must not be restated differently here

test("the ceiling matches highestCheckout for every out rule", () => {
  for (const rules of ["double", "master", "siso"]) {
    const ceiling = highestCheckout(rules);
    assert.ok(isCheckoutable(ceiling, 3, rules), `${rules}: ${ceiling} must be out`);
    assert.equal(
      isCheckoutable(ceiling + 1, 3, rules), false,
      `${rules}: ${ceiling + 1} must not be out`
    );
  }
});

test("one-dart finishes agree with scoring.js exactly", () => {
  // Two independent answers to the same question. They must not drift, which
  // is the entire reason this module composes scoring.js rather than copying
  // the out rules into its own vocabulary.
  for (const rules of ["double", "master", "siso"]) {
    for (let n = 1; n <= 180; n++) {
      assert.equal(
        isCheckoutable(n, 1, rules, "split"),
        isOneDartFinish(n, rules),
        `${rules}: one dart at ${n}`
      );
    }
  }
});

test("the last dart obeys the out rule", () => {
  for (const route of checkoutRoutes(120, 3, "double", "split")) {
    const last = route[route.length - 1];
    assert.equal(last.kind, "double", `double out finished on ${last.label}`);
  }
  for (const route of checkoutRoutes(120, 3, "master", "split")) {
    const last = route[route.length - 1];
    assert.ok(
      last.kind === "double" || last.kind === "triple" || last.base === 25,
      `master out finished on ${last.label}`
    );
  }
});

test("leaving exactly 1 is refused under double and master out, allowed under SISO", () => {
  // The edge case the rules deliberately encode. Under double out there is no
  // finishing dart worth 1, so a route that leaves 1 is a bust dressed up as a
  // plan.
  for (const rules of ["double", "master"]) {
    for (let n = 2; n <= 170; n++) {
      for (const route of checkoutRoutes(n, 3, rules, "split")) {
        let left = n;
        for (const t of route.slice(0, -1)) {
          left -= t.value;
          assert.notEqual(left, 1, `${rules}: ${describeRoute(route)} from ${n} leaves 1`);
        }
      }
    }
  }
  assert.equal(out(3, 2, "siso"), "3");
});

// ---------------------------------------------------------------------------
// Bull mode, which is why this takes a parameter the charts split over

test("the outer bull exists only when the bull is split", () => {
  // Under master out the OUTER bull finishes, because it is a single worth 25.
  assert.equal(out(25, 1, "master", "split"), "25");
  // Under full bull there is no 25 on the board at all - a dart there scores
  // 50 - so the same finish simply does not exist.
  assert.equal(out(25, 1, "master", "full"), null);
  // And it never finishes under double out either way: it is a single.
  assert.equal(out(25, 1, "double", "split"), null);
});

test("no route uses a 25 when the bull is full", () => {
  for (let n = 2; n <= 170; n++) {
    for (const route of checkoutRoutes(n, 3, "double", "full")) {
      for (const t of route) {
        assert.notEqual(t.value, 25, `full bull route for ${n} used a 25`);
      }
    }
  }
});

test("170 is the ceiling under both bull modes, since the inner bull is 50 either way", () => {
  assert.equal(out(170, 3, "double", "split"), "T20 T20 BULL");
  assert.equal(out(170, 3, "double", "full"), "T20 T20 BULL");
});

// ---------------------------------------------------------------------------
// The judgement, which is the part a player would notice being wrong

test("setup darts are never doubles or the bull when anything else will do", () => {
  // "60: D14 D16" adds up and is not what any player or any chart would tell
  // you to throw. Checked across the range rather than at one score, because
  // the ranking that prevents it is a weight and weights drift.
  const forced = new Set(); // scores where every route must pass through one
  for (let n = 2; n <= 170; n++) {
    const route = bestCheckout(n, 3, "double", "split");
    if (!route || route.length < 2) continue;
    const setups = route.slice(0, -1);
    const bad = setups.filter((t) => t.kind === "double" || t.base === 25);
    if (!bad.length) continue;
    // Allowed only when no alternative exists at that length.
    const alternatives = checkoutRoutes(n, 3, "double", "split", { limit: 40 })
      .filter((r) => r.length === route.length)
      .filter((r) => r.slice(0, -1).every((t) => t.kind !== "double" && t.base !== 25));
    assert.equal(alternatives.length, 0, `${n}: ${describeRoute(route)} sets up on a double`);
    forced.add(n);
  }
  // A sanity check on the check: if this ever becomes every score, the filter
  // above has stopped meaning anything.
  assert.ok(forced.size < 20, `too many forced routes (${forced.size}) - ranking may be broken`);
});

test("fewer darts always wins", () => {
  for (let n = 2; n <= 170; n++) {
    const three = bestCheckout(n, 3, "double", "split");
    const two = bestCheckout(n, 2, "double", "split");
    if (two) assert.ok(three.length <= 2, `${n}: two-dart out exists but three-dart chosen`);
  }
});

test("routes are distinct, not permutations of each other", () => {
  const routes = checkoutRoutes(141, 3, "double", "split", { limit: 6 });
  const keys = routes.map((r) => r.slice(0, -1).map((t) => t.label).sort().join("|")
    + ">" + r[r.length - 1].label);
  assert.equal(new Set(keys).size, keys.length, "duplicate route shapes returned");
});

test("nothing is offered when there is no way out", () => {
  assert.equal(out(171), null);
  assert.equal(out(1), null);          // double out: no finishing dart scores 1
  assert.equal(out(0), null);
  assert.equal(out(-5), null);
  assert.equal(out(50, 0), null);      // no darts left
  assert.equal(describeRoute(null), "");
  assert.deepEqual(checkoutRoutes(2.5), []);
});
