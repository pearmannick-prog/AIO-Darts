// Tests for the external-scorer notation mapper.
//
// This file earns its place for a reason the rest of the rules layer does not:
// there is no hardware to check it against. A scoring bug shows up immediately
// on a dartboard you are looking at, which is why this project tests statistics
// and little else - but nobody here has an Autodarts board or an OpenDartboard
// Pi, so the only way to know a treble 20 maps to a treble 20 is to assert it.
//
// The per-source cases matter most. The two systems disagree about the word
// "bull", and getting that wrong halves a score silently - it produces a
// plausible number rather than an error, which is exactly what a test is for.

import test from "node:test";
import assert from "node:assert/strict";

import { segmentFrom, segmentIdFrom, createReader, SOURCES } from "../dartnotation.js";
import { SegmentID, SegmentType, createSegment, applyBullMode } from "../granboard.js";

const NUMBERS = Array.from({ length: 20 }, (_, i) => i + 1);
const ALL_SOURCES = Object.keys(SOURCES);

test("every source reads singles, doubles and trebles identically", () => {
  for (const source of ALL_SOURCES) {
    for (const n of NUMBERS) {
      const single = segmentFrom(source, `S${n}`);
      assert.equal(single.value, n, `${source} S${n}`);
      assert.equal(single.type, SegmentType.Single, `${source} S${n} type`);

      const double = segmentFrom(source, `D${n}`);
      assert.equal(double.value, n * 2, `${source} D${n}`);
      assert.equal(double.type, SegmentType.Double, `${source} D${n} type`);

      const treble = segmentFrom(source, `T${n}`);
      assert.equal(treble.value, n * 3, `${source} T${n}`);
      assert.equal(treble.type, SegmentType.Triple, `${source} T${n} type`);
    }
  }
});

test("the ring slot convention matches SegmentID exactly", () => {
  // Asserted against the named constants rather than arithmetic, so this fails
  // if the convention is changed in one place and not the other.
  assert.equal(segmentIdFrom("autodarts", "T20"), SegmentID.TRP_20);
  assert.equal(segmentIdFrom("autodarts", "D16"), SegmentID.DBL_16);
  assert.equal(segmentIdFrom("opendartboard", "T20"), SegmentID.TRP_20);
  assert.equal(segmentIdFrom("opendartboard", "D16"), SegmentID.DBL_16);
});

// ---------------------------------------------------------------------------
// The disagreement this file exists for
// ---------------------------------------------------------------------------
test("BULL means different things to the two sources, and both are honoured", () => {
  // OpenDartboard lists BULL and OUTER as separate scores. If BULL were the
  // outer one there would be nothing left for OUTER to mean.
  assert.equal(segmentIdFrom("opendartboard", "BULL"), SegmentID.DBL_BULL);
  assert.equal(segmentFrom("opendartboard", "BULL").value, 50);
  assert.equal(segmentIdFrom("opendartboard", "OUTER"), SegmentID.BULL);
  assert.equal(segmentFrom("opendartboard", "OUTER").value, 25);

  // Autodarts' bare "bull" is read as the outer one, matching this codebase's
  // own SegmentID names. Still unverified against hardware - see the note in
  // dartnotation.js - so this test pins the CHOICE, and is where to look when
  // it turns out to be wrong.
  assert.equal(segmentIdFrom("autodarts", "BULL"), SegmentID.BULL);
  assert.equal(segmentFrom("autodarts", "BULL").value, 25);

  // A merged table could not do both, which is the whole reason for the split.
  assert.notEqual(
    segmentIdFrom("autodarts", "BULL"),
    segmentIdFrom("opendartboard", "BULL")
  );
});

test("numeric bulls are unambiguous everywhere", () => {
  for (const source of ALL_SOURCES) {
    assert.equal(segmentIdFrom(source, "25"), SegmentID.BULL, `${source} 25`);
    assert.equal(segmentIdFrom(source, "50"), SegmentID.DBL_BULL, `${source} 50`);
    assert.equal(segmentIdFrom(source, "D25"), SegmentID.DBL_BULL, `${source} D25`);
  }
});

test("the bull is emitted in split form so full bull is not applied twice", () => {
  const outer = segmentFrom("opendartboard", "OUTER");
  assert.equal(outer.value, 25);
  assert.equal(outer.type, SegmentType.Single);
  // The full-bull transform lives downstream. If the mapper promoted the outer
  // bull itself, this would already read 50 before applyBullMode ran, and a
  // split-bull match would score every outer bull as a double.
  assert.equal(applyBullMode(outer, "split").value, 25);
  assert.equal(applyBullMode(outer, "full").value, 50);
});

test("OpenDartboard's END is the end-of-visit signal, not a dart", () => {
  // Which is a concept the app already has: it is what the Granboard's physical
  // button sends, so boardlink.js routes it to end-turn with no new code.
  assert.equal(segmentIdFrom("opendartboard", "END"), SegmentID.RESET_BUTTON);
  // And it means nothing to Autodarts, which has no such message.
  assert.equal(segmentFrom("autodarts", "END"), null);
});

test("OpenDartboard's whole documented vocabulary is readable", () => {
  // From docs/api.md: S1..D20 plus BULL, OUTER, MISS, END. Every one of these
  // must resolve, because an unreadable value is a dropped dart.
  for (const v of ["S1", "S5", "D12", "D20", "T20", "BULL", "OUTER", "MISS", "END"]) {
    assert.notEqual(segmentFrom("opendartboard", v), null, v);
  }
});

test("OpenDartboard's WebSocket frame is read from its score field", () => {
  const frame = {
    score: "D20", position: { x: 150, y: 200 }, confidence: 0.95,
    camera: 0, processing_time: 15, timestamp: 1699123456789,
  };
  assert.equal(segmentIdFrom("opendartboard", frame), SegmentID.DBL_20);
  // The extra fields are ignored rather than tripping anything up.
  assert.equal(segmentFrom("opendartboard", frame).value, 40);
});

test("a bare single resolves to the outer single, not the inner", () => {
  for (const source of ALL_SOURCES) {
    assert.equal(segmentIdFrom(source, "S20"), SegmentID.OUTER_20, source);
    assert.equal(segmentIdFrom(source, "20"), SegmentID.OUTER_20, source);
    assert.equal(segmentIdFrom(source, "SI20"), SegmentID.INNER_20, source);
  }
});

test("notation is case- and separator-insensitive", () => {
  for (const form of ["T20", "t20", " T20 ", "t-20", "T_20", "TRIPLE20", "treble20"]) {
    assert.equal(segmentIdFrom("autodarts", form), SegmentID.TRP_20, form);
  }
});

test("misses map to MISS", () => {
  for (const source of ALL_SOURCES) {
    for (const form of ["M", "MISS", "OUT", "0", "none"]) {
      assert.equal(segmentIdFrom(source, form), SegmentID.MISS, `${source} ${form}`);
    }
    assert.equal(segmentIdFrom(source, { isMiss: true }), SegmentID.MISS, source);
    // An explicit miss beats a number the camera thought it was nearest.
    assert.equal(
      segmentIdFrom(source, { isMiss: true, number: 20, bed: "Triple" }),
      SegmentID.MISS, source
    );
  }
});

test("object forms resolve the same as their string equivalents", () => {
  const cases = [
    [{ name: "T20" }, "T20"],
    [{ score: "T20" }, "T20"],
    [{ number: 20, bed: "Triple" }, "T20"],
    [{ number: 20, multiplier: 3 }, "T20"],
    [{ number: 16, multiplier: 2 }, "D16"],
    [{ segment: { name: "T19" } }, "T19"],
  ];
  for (const [object, string] of cases) {
    assert.equal(
      segmentIdFrom("autodarts", object),
      segmentIdFrom("autodarts", string),
      JSON.stringify(object)
    );
  }
  assert.equal(segmentIdFrom("autodarts", { number: 25, bed: "Double" }), SegmentID.DBL_BULL);
});

test("unreadable input returns null rather than a miss", () => {
  for (const bad of [null, undefined, "", "  ", "Q7", "T0", "T21", 21, {}, [], true, { number: 21 }]) {
    assert.equal(segmentFrom("autodarts", bad), null, JSON.stringify(bad));
  }
});

test("an unknown source is a programming error, not a silent no-op", () => {
  // Returning null here would turn a typo into every dart being dropped, with
  // nothing to say why.
  assert.throws(() => segmentIdFrom("dartsmind", "T20"), /Unknown scoring source/);
  assert.throws(() => createReader("nope"), /Unknown scoring source/);
});

test("a self-referencing payload does not hang", () => {
  const loop = { number: 20, bed: "Triple" };
  loop.segment = loop;
  assert.equal(segmentIdFrom("autodarts", loop), SegmentID.TRP_20);
});

test("createReader binds one source for a connection's lifetime", () => {
  const read = createReader("opendartboard");
  assert.equal(read("BULL").value, 50);
  assert.equal(read({ score: "T20" }).value, 60);
});

test("output is shape-identical to a Granboard segment", () => {
  // The whole point: nothing downstream may be able to tell which input path a
  // dart arrived on.
  for (const id of [SegmentID.TRP_20, SegmentID.DBL_16, SegmentID.BULL, SegmentID.DBL_BULL, SegmentID.MISS]) {
    const fromBoard = createSegment(id);
    const name = fromBoard.shortName === "Miss" ? "M" : fromBoard.shortName;
    assert.deepEqual(segmentFrom("autodarts", name), fromBoard, fromBoard.shortName);
  }
});
