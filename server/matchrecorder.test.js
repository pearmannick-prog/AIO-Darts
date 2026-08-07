// Tests for the live averages the scoreboard shows mid-match.
//
// This file exists because of one bug, and the bug is the archetype for
// everything this project bothers testing: a quick-entry 180 displayed a PPD of
// 180.00 and a three-dart average of 540.00. Nothing threw, nothing logged, the
// layout was fine - it was simply a number that cannot exist, sitting on screen
// looking like a number.
//
// A dart is worth at most 60, so PPD cannot exceed 60 and a three-dart average
// cannot exceed 180. Those two ceilings are asserted directly, because they are
// the cheapest possible check that the arithmetic still means what it says.

import test from "node:test";
import assert from "node:assert/strict";

import { createRecorder } from "../matchrecorder.js";

const T20 = { id: 77, section: "20", ring: "triple", type: 3, value: 60 };

function x01Recorder() {
  const rec = createRecorder({ mode: "local", format: "501", players: ["A", "B"] });
  rec.startLeg({ legIndex: 0, game: "x01", x01Start: 501, rules: "double", bull: "split" });
  return rec;
}

function cricketRecorder() {
  const rec = createRecorder({ mode: "local", format: "cricket", players: ["A", "B"] });
  rec.startLeg({ legIndex: 0, game: "cricket", x01Start: null, rules: null, bull: "split" });
  return rec;
}

test("three darts thrown one at a time average per DART, not per visit", () => {
  const rec = x01Recorder();
  let remaining = 501;
  for (let i = 0; i < 3; i++) {
    rec.dart(0, T20, { remainingBefore: remaining, remainingAfter: remaining - 60, scored: 60 });
    remaining -= 60;
  }
  const s = rec.liveStats(0);
  assert.equal(s.kind, "ppd");
  assert.equal(s.value, 60);        // 180 over three darts
  assert.equal(s.secondary, 180);   // and a 180 three-dart average
});

test("a QUICK TOTAL of 180 is three darts, not one", () => {
  // The actual bug. quickTotal records the whole visit as a single throw and
  // sets darts to 3; counting throws instead of darts turned 180 points into
  // 180 points per dart.
  const rec = x01Recorder();
  rec.quickTotal(0, { total: 180, remainingBefore: 501, remainingAfter: 321, bust: false, isCheckout: false });
  const s = rec.liveStats(0);
  assert.equal(s.value, 60, "PPD after a 180 quick total");
  assert.equal(s.secondary, 180, "three-dart average after a 180 quick total");
});

test("per-dart and quick-total entry give the same average for the same visit", () => {
  const byDart = x01Recorder();
  let remaining = 501;
  for (let i = 0; i < 3; i++) {
    byDart.dart(0, T20, { remainingBefore: remaining, remainingAfter: remaining - 60, scored: 60 });
    remaining -= 60;
  }
  const byTotal = x01Recorder();
  byTotal.quickTotal(0, { total: 180, remainingBefore: 501, remainingAfter: 321, bust: false, isCheckout: false });

  // How a score was ENTERED must never change what it averages.
  assert.deepEqual(
    { v: byDart.liveStats(0).value, s: byDart.liveStats(0).secondary },
    { v: byTotal.liveStats(0).value, s: byTotal.liveStats(0).secondary }
  );
});

test("PPD can never exceed 60, nor the three-dart average 180", () => {
  // The ceiling, asserted over every entry path and a bust, because a number
  // above it is impossible rather than merely surprising.
  const cases = [
    (r) => r.quickTotal(0, { total: 180, remainingBefore: 501, remainingAfter: 321, bust: false, isCheckout: false }),
    (r) => r.quickTotal(0, { total: 0, remainingBefore: 501, remainingAfter: 501, bust: true, isCheckout: false }),
    (r) => {
      r.dart(0, T20, { remainingBefore: 501, remainingAfter: 441, scored: 60 });
      r.dart(0, T20, { remainingBefore: 441, remainingAfter: 381, scored: 60 });
    },
  ];
  for (const [i, play] of cases.entries()) {
    const rec = x01Recorder();
    play(rec);
    const s = rec.liveStats(0);
    if (!s) continue;
    assert.ok(s.value <= 60, `case ${i}: PPD ${s.value} exceeds 60`);
    assert.ok(s.secondary <= 180, `case ${i}: three-dart average ${s.secondary} exceeds 180`);
  }
});

test("a bust visit scores nothing, however good its darts were", () => {
  const rec = x01Recorder();
  rec.dart(0, T20, { remainingBefore: 100, remainingAfter: 40, scored: 60 });
  rec.dart(0, T20, { remainingBefore: 40, remainingAfter: 40, scored: 0, bust: true });
  rec.endTurn();
  const s = rec.liveStats(0);
  assert.equal(s.value, 0, "a busted visit averages zero, not the darts' face value");
});

test("Cricket reports marks per round, and a round is a visit", () => {
  const rec = createRecorder({ mode: "local", format: "cricket", players: ["A", "B"] });
  rec.startLeg({ legIndex: 0, game: "cricket", x01Start: null, rules: null, bull: "split" });
  for (let i = 0; i < 3; i++) {
    rec.dart(0, T20, { scored: 0, extra: { target: "20", marks: 3, marksApplied: 3, points: 0 } });
  }
  rec.endTurn();
  const s = rec.liveStats(0);
  assert.equal(s.kind, "mpr");
  assert.equal(s.value, 9, "nine marks in one visit is an MPR of 9");
});

// An empty average still knows its own NAME. Returning a bare null for this
// made the scoreboard fall back to a hardcoded caption, so a Cricket player who
// had not thrown yet was shown "PPD -" - the wrong number's name, on the one
// screen where the name is all there is to read.
test("no value but the right label before anything is thrown", () => {
  const rec = x01Recorder();
  const before = rec.liveStats(0);
  assert.equal(before.label, "PPD");
  assert.equal(before.value, null, "no darts is not an average of zero");

  // And a seat that has not thrown reports the same even when the other has.
  rec.quickTotal(0, { total: 60, remainingBefore: 501, remainingAfter: 441, bust: false, isCheckout: false });
  assert.equal(rec.liveStats(1).value, null);
});

test("a Cricket leg names its figure MPR before a dart is thrown", () => {
  const rec = cricketRecorder();
  const s = rec.liveStats(0);
  assert.equal(s.label, "MPR");
  assert.equal(s.value, null);
});

// A VISIT IS THREE DARTS. The two that were never entered were thrown and
// missed, and counting only what registered flattered every average with darts
// in its denominator.
test("ending a turn counts the darts that were never entered", () => {
  const rec = x01Recorder();
  rec.dart(0, T20, { remainingBefore: 501, remainingAfter: 441, scored: 60 });
  assert.equal(rec.liveStats(0).value, 60, "mid-visit, one dart has scored 60");

  rec.endTurn(0);
  assert.equal(rec.liveStats(0).value, 20, "60 across three darts, two of them missed");
  assert.equal(rec.liveStats(0).secondary, 60, "and a three-dart average of 60");
});

// The visit that leaves no trace at all. Without this it was dropped, and a
// player who missed everything had the round taken out of their MPR denominator
// - so missing made the average go UP.
test("a visit where all three darts missed is still a round", () => {
  const rec = cricketRecorder();
  rec.dart(0, T20, { scored: 0, extra: { target: "20", marks: 3, marksApplied: 3, points: 0 } });
  rec.endTurn(0);
  assert.equal(rec.liveStats(0).value, 3, "three marks in one round");

  rec.endTurn(0); // seat 0 again: nothing registered, the whole visit missed
  assert.equal(rec.liveStats(0).value, 1.5, "three marks across TWO rounds");
});

// The exception, and the reason endTurn checks it: a leg-winning visit really
// did use fewer than three darts.
test("a checkout keeps the darts it actually used", () => {
  const rec = x01Recorder();
  rec.dart(0, T20, { remainingBefore: 60, remainingAfter: 0, scored: 60 });
  rec.endLeg(0);
  const doc = rec.endMatch({ winnerSeat: 0 });
  assert.equal(doc.legs[0].turns[0].darts, 1, "one dart finished it");
  assert.equal(doc.legs[0].turns[0].isCheckout, true);
});
