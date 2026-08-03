// Tests for the Autodarts notation mapper.
//
// This file earns its place for a reason the rest of the rules layer does not:
// there is no board to check it against. A scoring bug shows up immediately on
// a dartboard you are looking at, which is why this project tests statistics
// and little else - but nobody here has Autodarts hardware, so the only way to
// know a treble 20 maps to a treble 20 is to assert it. The mapping is also a
// table over four rings and twenty numbers, where a slot off by one is both
// easy to write and invisible in review.

import test from "node:test";
import assert from "node:assert/strict";

import { segmentFromAutodarts, segmentIdFromAutodarts } from "../autodarts.js";
import { SegmentID, SegmentType, createSegment, applyBullMode } from "../granboard.js";

const NUMBERS = Array.from({ length: 20 }, (_, i) => i + 1);

test("every single, double and treble maps to the right value and type", () => {
  for (const n of NUMBERS) {
    const single = segmentFromAutodarts(`S${n}`);
    assert.equal(single.section, n, `S${n} section`);
    assert.equal(single.value, n, `S${n} value`);
    assert.equal(single.type, SegmentType.Single, `S${n} type`);

    const double = segmentFromAutodarts(`D${n}`);
    assert.equal(double.section, n, `D${n} section`);
    assert.equal(double.value, n * 2, `D${n} value`);
    assert.equal(double.type, SegmentType.Double, `D${n} type`);

    const treble = segmentFromAutodarts(`T${n}`);
    assert.equal(treble.section, n, `T${n} section`);
    assert.equal(treble.value, n * 3, `T${n} value`);
    assert.equal(treble.type, SegmentType.Triple, `T${n} type`);
  }
});

test("the ring slot convention matches SegmentID exactly", () => {
  // 0 = inner single, 1 = triple, 2 = outer single, 3 = double. Asserted
  // against the named constants rather than arithmetic, so this fails if the
  // convention is ever changed in one place and not the other.
  assert.equal(segmentIdFromAutodarts("T20"), SegmentID.TRP_20);
  assert.equal(segmentIdFromAutodarts("D20"), SegmentID.DBL_20);
  assert.equal(segmentIdFromAutodarts("T19"), SegmentID.TRP_19);
  assert.equal(segmentIdFromAutodarts("D16"), SegmentID.DBL_16);
  assert.equal(segmentIdFromAutodarts("T1"), SegmentID.TRP_1);
  assert.equal(segmentIdFromAutodarts("D1"), SegmentID.DBL_1);
});

test("a bare single resolves to the outer single, not the inner", () => {
  // They score identically, so nothing in the rules can tell - it only decides
  // where the marker is drawn. Pinned so the choice is deliberate rather than
  // whatever the parser happened to do.
  assert.equal(segmentIdFromAutodarts("S20"), SegmentID.OUTER_20);
  assert.equal(segmentIdFromAutodarts("20"), SegmentID.OUTER_20);
  // ...but an explicit inner single is honoured when the report gives one.
  assert.equal(segmentIdFromAutodarts("SI20"), SegmentID.INNER_20);
  assert.equal(segmentIdFromAutodarts({ number: 20, bed: "SingleInner" }), SegmentID.INNER_20);
});

test("notation is case- and separator-insensitive", () => {
  for (const form of ["T20", "t20", " T20 ", "t-20", "T_20"]) {
    assert.equal(segmentIdFromAutodarts(form), SegmentID.TRP_20, form);
  }
  assert.equal(segmentIdFromAutodarts("TRIPLE20"), SegmentID.TRP_20);
  assert.equal(segmentIdFromAutodarts("treble20"), SegmentID.TRP_20);
});

test("the bull is emitted in split form so full bull is not applied twice", () => {
  const outer = segmentFromAutodarts("25");
  assert.equal(outer.id, SegmentID.BULL);
  assert.equal(outer.value, 25);
  assert.equal(outer.type, SegmentType.Single);

  const inner = segmentFromAutodarts("50");
  assert.equal(inner.id, SegmentID.DBL_BULL);
  assert.equal(inner.value, 50);
  assert.equal(inner.type, SegmentType.Double);

  // The full-bull transform lives downstream. If the mapper promoted the outer
  // bull itself, this would already read 50 before applyBullMode ran, and a
  // split-bull match would score every outer bull double.
  assert.equal(applyBullMode(outer, "split").value, 25);
  assert.equal(applyBullMode(outer, "full").value, 50);
});

test("the bull's many spellings all land on the right ring", () => {
  for (const form of ["25", "S25", "SBULL", "BULL", "outer bull", "single_bull"]) {
    assert.equal(segmentIdFromAutodarts(form), SegmentID.BULL, form);
  }
  for (const form of ["50", "D25", "DBULL", "double bull", "innerbull", "bullseye"]) {
    assert.equal(segmentIdFromAutodarts(form), SegmentID.DBL_BULL, form);
  }
  // A double 25 is the inner bull however the report spells it.
  assert.equal(segmentIdFromAutodarts({ number: 25, bed: "Double" }), SegmentID.DBL_BULL);
  assert.equal(segmentIdFromAutodarts({ number: 25, multiplier: 2 }), SegmentID.DBL_BULL);
  assert.equal(segmentIdFromAutodarts({ number: 25, bed: "Single" }), SegmentID.BULL);
});

test("misses map to MISS, in every spelling", () => {
  for (const form of ["M", "MISS", "OUT", "OUTSIDE", "0", "none"]) {
    assert.equal(segmentIdFromAutodarts(form), SegmentID.MISS, form);
  }
  assert.equal(segmentIdFromAutodarts({ isMiss: true }), SegmentID.MISS);
  // An explicit miss wins over a number the camera thought it was nearest.
  assert.equal(segmentIdFromAutodarts({ isMiss: true, number: 20, bed: "Triple" }), SegmentID.MISS);
});

test("object forms resolve the same as their string equivalents", () => {
  const cases = [
    [{ name: "T20" }, "T20"],
    [{ number: 20, bed: "Triple" }, "T20"],
    [{ number: 20, multiplier: 3 }, "T20"],
    [{ number: 16, bed: "Double" }, "D16"],
    [{ number: 16, multiplier: 2 }, "D16"],
    [{ number: 5, multiplier: 1 }, "S5"],
    [{ segment: { name: "T20" } }, "T20"],
    [{ segment: { number: 19, bed: "Triple" } }, "T19"],
  ];
  for (const [object, string] of cases) {
    assert.equal(
      segmentIdFromAutodarts(object),
      segmentIdFromAutodarts(string),
      JSON.stringify(object)
    );
  }
});

test("unreadable input returns null rather than a miss", () => {
  // A dart the mapper failed to understand is a bug to surface. Scoring it as
  // a thrown miss would cost the player a dart and hide the cause.
  for (const bad of [null, undefined, "", "  ", "Q7", "T0", "T21", "S99", 21, {}, [], true, { number: 21 }]) {
    assert.equal(segmentFromAutodarts(bad), null, JSON.stringify(bad));
  }
});

test("a self-referencing payload does not hang", () => {
  const loop = { number: 20, bed: "Triple" };
  loop.segment = loop;
  assert.equal(segmentIdFromAutodarts(loop), SegmentID.TRP_20);
});

test("output is shape-identical to a Granboard segment", () => {
  // The whole point of the module: nothing downstream may be able to tell
  // which input path a dart arrived on.
  for (const id of [SegmentID.TRP_20, SegmentID.DBL_16, SegmentID.BULL, SegmentID.DBL_BULL, SegmentID.MISS]) {
    const fromBoard = createSegment(id);
    const fromAutodarts = segmentFromAutodarts(fromBoard.shortName === "Miss" ? "M" : fromBoard.shortName);
    assert.deepEqual(fromAutodarts, fromBoard, fromBoard.shortName);
  }
});
