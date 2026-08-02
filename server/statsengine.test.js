// statsengine.test.js - the one place this project has tests, and deliberately
// so.
//
// The rest of the app is verified by playing it: a scoring bug shows up as a
// wrong number on a board you are looking at. Statistics are different. A
// checkout percentage that is quietly five points too high looks exactly like
// one that is right, for months, until it is compared with something else - and
// by then it has been wrong in every dashboard and every leaderboard.
//
// So the pure arithmetic gets pinned to hand-worked examples. Nothing here
// touches the DOM, the database or the network; it feeds match documents to the
// same functions the browser and server both use.
//
// Run: node --test server/statsengine.test.js

import test from "node:test";
import assert from "node:assert/strict";
import { computeStats } from "../statsengine.js";

// ---------------------------------------------------------------------------
// Builders - so a test reads as the match it describes
// ---------------------------------------------------------------------------
function dart(value, { multiplier = 1, section = String(value), remainingBefore = null,
                       remainingAfter = null, bust = false, ignored = false, extra = null } = {}) {
  return {
    dartIndex: 0, segmentId: null, section, ring: "outer", multiplier, value,
    remainingBefore, remainingAfter, bust, ignored, atMs: 0, extra,
  };
}

function turn(seat, turnIndex, throws, overrides = {}) {
  const scored = overrides.bust ? 0 : throws.reduce((sum, t) => sum + (t.ignored ? 0 : t.value), 0);
  return {
    turnIndex, seat, darts: throws.length, scored,
    remainingBefore: throws[0]?.remainingBefore ?? null,
    remainingAfter: throws[throws.length - 1]?.remainingAfter ?? null,
    bust: false, isCheckout: false, entry: "dart", game: null,
    throws: throws.map((t, i) => ({ ...t, dartIndex: i })),
    ...overrides,
  };
}

function match({ uuid = "m1", game = "x01", turns = [], winnerSeat = 0, drawn = false,
                 endedAt = "2026-01-15T20:00:00.000Z", durationMs = 600000, leg = {} } = {}) {
  return {
    clientUuid: uuid, mode: "local",
    startedAt: endedAt, endedAt, durationMs,
    format: [], winnerSeat, drawn,
    players: [
      { seat: 0, displayName: "Me", isSelf: true, legsWon: winnerSeat === 0 ? 1 : 0, setsWon: 0 },
      { seat: 1, displayName: "Them", isSelf: false, legsWon: winnerSeat === 1 ? 1 : 0, setsWon: 0 },
    ],
    legs: [{
      legIndex: 0, game, x01Start: game === "x01" ? 501 : null,
      rules: game === "x01" ? "double" : null, bull: "split", rounds: null,
      winnerSeat, turns, ...leg,
    }],
  };
}

const x01Of = (stats) => stats.games.find((g) => g.key === "x01").raw;
const cricketOf = (stats) => stats.games.find((g) => g.key === "cricket").raw;

// ---------------------------------------------------------------------------
// x01
// ---------------------------------------------------------------------------
test("three-dart average is points per dart times three, and busts score nothing", () => {
  // 180 off nine darts would be 60. Here: 180 in visit one, a bust in visit
  // two. Six darts thrown, 180 scored -> 90.00.
  const stats = computeStats([match({
    turns: [
      turn(0, 0, [
        dart(60, { multiplier: 3, remainingBefore: 501, remainingAfter: 441 }),
        dart(60, { multiplier: 3, remainingBefore: 441, remainingAfter: 381 }),
        dart(60, { multiplier: 3, remainingBefore: 381, remainingAfter: 321 }),
      ]),
      turn(0, 1, [
        dart(60, { multiplier: 3, remainingBefore: 321, remainingAfter: 261 }),
        dart(60, { multiplier: 3, remainingBefore: 261, remainingAfter: 201 }),
        dart(60, { multiplier: 3, remainingBefore: 201, remainingAfter: 321, bust: true }),
      ], { bust: true }),
    ],
  })]);

  const x01 = x01Of(stats);
  assert.equal(x01.darts, 6);
  assert.equal(x01.scored, 180);
  assert.equal(x01.threeDart, 90);
});

test("first-9 average counts only the first three visits of a leg", () => {
  const scoring = (index, before) => turn(0, index, [
    dart(60, { multiplier: 3, remainingBefore: before, remainingAfter: before - 60 }),
    dart(60, { multiplier: 3, remainingBefore: before - 60, remainingAfter: before - 120 }),
    dart(60, { multiplier: 3, remainingBefore: before - 120, remainingAfter: before - 180 }),
  ]);

  const stats = computeStats([match({
    turns: [
      scoring(0, 501), scoring(1, 321), scoring(2, 141),
      // A fourth, much weaker visit must not drag the first-9 down.
      turn(0, 3, [
        dart(1, { remainingBefore: 141, remainingAfter: 140 }),
        dart(1, { remainingBefore: 140, remainingAfter: 139 }),
        dart(1, { remainingBefore: 139, remainingAfter: 138 }),
      ]),
    ],
  })]);

  assert.equal(x01Of(stats).first9, 180); // nine treble twenties
  // 543 points over 12 darts is 45.25 a dart, and a three-dart average is
  // three times that.
  assert.equal(x01Of(stats).threeDart, 135.75);
});

test("checkout percentage counts visits that began on a finishable score", () => {
  const stats = computeStats([match({
    turns: [
      // Not a chance: 501 is not checkable.
      turn(0, 0, [dart(20, { remainingBefore: 501, remainingAfter: 481 })]),
      // A chance, missed.
      turn(0, 1, [dart(20, { remainingBefore: 120, remainingAfter: 100 })]),
      // A chance, taken - and the highest checkout seen.
      turn(0, 2, [dart(40, { multiplier: 2, section: "20", remainingBefore: 40, remainingAfter: 0 })],
        { isCheckout: true }),
    ],
  })]);

  const x01 = x01Of(stats);
  assert.equal(x01.checkoutChances, 2);
  assert.equal(x01.checkouts, 1);
  assert.equal(x01.highestCheckout, 40);
});

test("the checkout ceiling follows the leg's out rule, not a fixed 170", () => {
  // T20 T20 T20 finishes from 180 when a treble may finish, so a visit that
  // began on 180 is a genuine chance under master and single out - and is not
  // one under double out, where the biggest finish is 170.
  const from180 = (rules, finished) => match({
    uuid: `m-${rules}`,
    leg: { rules },
    turns: [
      turn(0, 0, [
        dart(60, { multiplier: 3, section: "20", remainingBefore: 180, remainingAfter: 120 }),
        dart(60, { multiplier: 3, section: "20", remainingBefore: 120, remainingAfter: 60 }),
        dart(60, { multiplier: 3, section: "20", remainingBefore: 60, remainingAfter: 0 }),
      ], { isCheckout: finished }),
    ],
  });

  const master = x01Of(computeStats([from180("master", true)]));
  assert.equal(master.checkoutChances, 1);
  assert.equal(master.checkouts, 1);
  assert.equal(master.highestCheckout, 180);

  const siso = x01Of(computeStats([from180("siso", true)]));
  assert.equal(siso.checkoutChances, 1);
  assert.equal(siso.highestCheckout, 180);

  // Under double out that visit could not have been a finish, so it is not
  // counted as a chance missed either.
  const double = x01Of(computeStats([from180("double", false)]));
  assert.equal(double.checkoutChances, 0);
  assert.equal(double.highestCheckout, 0);
});

test("doubles are only measured in legs whose out rule requires one", () => {
  // On 60 under master out the player is throwing at a treble. Counting that
  // as a missed double would measure something nobody attempted.
  const on60 = (rules) => match({
    uuid: `d-${rules}`,
    leg: { rules },
    turns: [
      turn(0, 0, [dart(0, { section: "Other", remainingBefore: 60, remainingAfter: 60 })]),
      // 40 is a one-dart double under every rule set.
      turn(0, 1, [dart(0, { section: "Other", remainingBefore: 40, remainingAfter: 40 })]),
    ],
  });

  assert.equal(x01Of(computeStats([on60("master")])).doublesThrown, 0);
  assert.equal(x01Of(computeStats([on60("double")])).doublesThrown, 1); // the 40 only
});

test("doubles percentage counts darts thrown while sitting on a one-dart double", () => {
  const stats = computeStats([match({
    turns: [
      // On 40: three darts at the double, the last one lands.
      turn(0, 0, [
        dart(0, { section: "Other", remainingBefore: 40, remainingAfter: 40 }),
        dart(0, { section: "Other", remainingBefore: 40, remainingAfter: 40 }),
        dart(40, { multiplier: 2, section: "20", remainingBefore: 40, remainingAfter: 0 }),
      ], { isCheckout: true }),
      // On 41: not a one-dart double, so these are not attempts at one.
      turn(0, 1, [dart(1, { remainingBefore: 41, remainingAfter: 40 })]),
    ],
  })]);

  const x01 = x01Of(stats);
  assert.equal(x01.doublesThrown, 3);
  assert.equal(x01.doublesHit, 1);
});

test("a quick-total visit counts as three darts but contributes no individual darts", () => {
  const stats = computeStats([match({
    turns: [{
      turnIndex: 0, seat: 0, darts: 3, scored: 100,
      remainingBefore: 501, remainingAfter: 401, bust: false, isCheckout: false,
      entry: "quick", game: null,
      throws: [dart(100, { section: "Other", remainingBefore: 501, remainingAfter: 401 })],
    }],
  })]);

  const x01 = x01Of(stats);
  assert.equal(x01.darts, 3);
  assert.equal(x01.scored, 100);
  assert.equal(x01.threeDart, 100);
  // No per-dart statistic may be inferred from it.
  assert.equal(x01.doublesThrown, 0);
});

test("scoring milestones are counted from visit totals", () => {
  const visit = (index, total) => ({
    turnIndex: index, seat: 0, darts: 3, scored: total,
    remainingBefore: 501, remainingAfter: 501 - total, bust: false, isCheckout: false,
    entry: "quick", game: null, throws: [dart(total, { section: "Other" })],
  });

  const stats = computeStats([match({ turns: [visit(0, 180), visit(1, 140), visit(2, 100), visit(3, 99)] })]);
  const x01 = x01Of(stats);

  assert.equal(x01.oneEighties, 1);
  assert.equal(x01.oneForties, 2); // 180 and 140 are both 140+
  assert.equal(x01.tons, 3);       // and all three of those are 100+
  assert.equal(x01.highestScore, 180);
});

// ---------------------------------------------------------------------------
// Cricket
// ---------------------------------------------------------------------------
test("MPR is marks per visit, and a white horse needs three different numbers", () => {
  const cricketTurn = (index, targets, marks) => ({
    turnIndex: index, seat: 0, darts: 3, scored: 0,
    remainingBefore: null, remainingAfter: null, bust: false, isCheckout: false,
    entry: "dart", game: { targets, marks, points: 0, runningMpr: 0 },
    throws: targets.map((t, i) => dart(Number(t) || 25, {
      multiplier: 3, section: String(t), extra: { target: t, marks: 3, marksApplied: 3, points: 0 },
    })).map((d, i) => ({ ...d, dartIndex: i })),
  });

  const stats = computeStats([match({
    game: "cricket",
    turns: [
      cricketTurn(0, [20, 19, 18], 9), // three triples, three numbers -> white horse
      cricketTurn(1, [20, 20, 20], 9), // three triples, one number -> not one
    ],
  })]);

  const cricket = cricketOf(stats);
  assert.equal(cricket.rounds, 2);
  assert.equal(cricket.marks, 18);
  assert.equal(cricket.mpr, 9);
  assert.equal(cricket.whiteHorses, 1);
  assert.equal(cricket.triples, 6);
});

test("points prevented counts opponent marks that scored nothing", () => {
  const opponentTurn = {
    turnIndex: 1, seat: 1, darts: 3, scored: 0,
    remainingBefore: null, remainingAfter: null, bust: false, isCheckout: false,
    entry: "dart", game: { targets: [20, 20, 20], marks: 9, points: 0, runningMpr: 0 },
    throws: [0, 1, 2].map((i) => ({
      ...dart(60, { multiplier: 3, section: "20" }),
      dartIndex: i,
      // Closed already, so all three marks overflowed and paid nothing.
      extra: { target: 20, marks: 3, marksApplied: 0, points: 0 },
    })),
  };

  const stats = computeStats([match({
    game: "cricket",
    turns: [
      { turnIndex: 0, seat: 0, darts: 3, scored: 0, remainingBefore: null, remainingAfter: null,
        bust: false, isCheckout: false, entry: "dart",
        game: { targets: [20, 20, 20], marks: 9, points: 120, runningMpr: 9 }, throws: [] },
      opponentTurn,
    ],
  })]);

  // Nine marks at 20 apiece, none of which counted for them.
  assert.equal(cricketOf(stats).pointsPrevented, 180);
});

// ---------------------------------------------------------------------------
// Career
// ---------------------------------------------------------------------------
test("win streaks are counted in time order and broken by a draw", () => {
  const at = (day, winnerSeat, drawn = false) =>
    match({ uuid: `m${day}`, winnerSeat, drawn, endedAt: `2026-01-${String(day).padStart(2, "0")}T20:00:00.000Z` });

  // Deliberately out of order: the engine must sort before counting.
  const stats = computeStats([at(3, 0), at(1, 0), at(2, 1), at(4, 0), at(5, null, true)]);

  assert.equal(stats.career.raw.played, 5);
  assert.equal(stats.career.raw.won, 3);
  assert.equal(stats.career.raw.longest, 2); // days 3 and 4
  assert.equal(stats.career.raw.current, 0); // the draw on day 5 ended it
});

test("a game nobody has played is absent rather than a column of zeroes", () => {
  const stats = computeStats([match({ game: "cricket", turns: [] })]);
  assert.equal(stats.games.some((g) => g.key === "cricket"), true);
  assert.equal(stats.games.some((g) => g.key === "x01"), false);
});

test("no matches at all produces zeroes, not a crash", () => {
  const stats = computeStats([]);
  assert.equal(stats.matchesCounted, 0);
  assert.equal(stats.career.raw.played, 0);
  assert.deepEqual(stats.games, []);
});
