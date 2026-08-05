// dartnotation.js - reading throws from an external scoring system.
//
// Automatic scorers all report the same thing in almost the same way: a short
// string naming a segment. This turns any of them into the SAME segment objects
// granboard.js produces, so a dart from a camera travels the identical path
// through the app as a Bluetooth dart, a clicked board, or a manual entry.
// Nothing downstream learns that another input exists.
//
// ONE PARSER, ONE VOCABULARY PER SOURCE, and that split is the whole point of
// this file rather than an abstraction for its own sake. The numeric forms are
// universal - "T20" is a treble twenty to everybody - but the WORD "bull" is
// not:
//
//   Autodarts       BULL is the outer bull, 25; the inner is 50 or D25.
//   OpenDartboard   BULL is the INNER bull, 50, and the outer one is OUTER.
//
// A single merged table cannot serve both. It would silently halve every bull
// for one of them, refuse legitimate 50 checkouts, and do it without an error
// anywhere - which is the worst class of bug this app can have, because a
// score that is quietly wrong looks exactly like a score that is right.
//
// So a caller says which system it is reading, and gets that system's meaning.
//
// Autodarts is a trademark of Autodarts GmbH; OpenDartboard is GPL-3.0 and
// entirely separate software. This file is an independent reader of what they
// emit - no code from either is copied, linked, or redistributed, and this app
// is not affiliated with or endorsed by them.

import { SegmentID, createSegment } from "./granboard.js";

// The ring slot within a number's four consecutive IDs:
//   0 = inner single, 1 = triple, 2 = outer single, 3 = double
// The same convention as SegmentID, dartboard.js's bands, and
// manualSegmentFromRing in game.js/online.js - see CLAUDE.md. Changing it means
// changing all of them.
const SLOT_INNER = 0;
const SLOT_TRIPLE = 1;
const SLOT_OUTER = 2;
const SLOT_DOUBLE = 3;

// Bed names, shared by every source. Generous on purpose: the same bed has been
// seen spelled several ways across these systems and their integrations, and
// accepting all of them is free where guessing wrong is a dropped dart.
const BED_SLOTS = new Map(Object.entries({
  s: SLOT_OUTER, single: SLOT_OUTER, singleouter: SLOT_OUTER, outersingle: SLOT_OUTER,
  si: SLOT_INNER, singleinner: SLOT_INNER, innersingle: SLOT_INNER, inner: SLOT_INNER,
  t: SLOT_TRIPLE, triple: SLOT_TRIPLE, treble: SLOT_TRIPLE,
  d: SLOT_DOUBLE, double: SLOT_DOUBLE,
}));

const MULTIPLIER_SLOTS = new Map([[1, SLOT_OUTER], [2, SLOT_DOUBLE], [3, SLOT_TRIPLE]]);

// Names that mean the same thing everywhere. The bulls appear here only in
// their UNAMBIGUOUS forms - a bare 25 is the outer bull and a bare 50 is the
// inner one in every system seen so far. The contested word lives per-source.
//
// Bulls are always emitted in SPLIT form: outer is a single 25, inner is a
// double 50. Full-bull play is a transform applied further in (applyBullMode in
// granboard.js), so promoting the outer bull here as well would apply it twice
// and turn a 25 into a 50 in a split-bull match.
const COMMON_NAMES = Object.freeze({
  25: SegmentID.BULL, s25: SegmentID.BULL, sbull: SegmentID.BULL,
  singlebull: SegmentID.BULL, outerbull: SegmentID.BULL,

  50: SegmentID.DBL_BULL, d25: SegmentID.DBL_BULL, dbull: SegmentID.DBL_BULL,
  doublebull: SegmentID.DBL_BULL, innerbull: SegmentID.DBL_BULL,

  0: SegmentID.MISS, m: SegmentID.MISS, miss: SegmentID.MISS,
  out: SegmentID.MISS, none: SegmentID.MISS,
});

// What each system adds, and where they disagree.
export const SOURCES = Object.freeze({
  // Still UNVERIFIED against real hardware - their docs site refuses requests -
  // so the vocabulary is every spelling seen across the third-party
  // integrations rather than a confirmed list. The bare "bull" is read as the
  // OUTER bull to match this codebase's own SegmentID names; if Autodarts means
  // 50 by it, every inner bull scores half until this line is corrected. It is
  // at least a loud kind of wrong - a bull that scores 25 is visible on the
  // first throw.
  autodarts: {
    label: "Autodarts",
    names: { ...COMMON_NAMES, bull: SegmentID.BULL, bullseye: SegmentID.DBL_BULL, outside: SegmentID.MISS },
  },

  // From docs/api.md: scores are "S1" through "D20" plus BULL, OUTER, MISS and
  // END. Listing BULL and OUTER as separate values is what settles the meaning
  // - if BULL were the outer one there would be nothing for OUTER to be.
  //
  // END is "the visit is over", which this app already has a concept for: it is
  // what the Granboard's physical button sends. Mapping it onto RESET_BUTTON
  // means boardlink.js routes it to end-turn in both modes with no new code.
  opendartboard: {
    label: "OpenDartboard",
    names: {
      ...COMMON_NAMES,
      bull: SegmentID.DBL_BULL,
      bullseye: SegmentID.DBL_BULL,
      outer: SegmentID.BULL,
      end: SegmentID.RESET_BUTTON,
    },
  },
});

function normalize(value) {
  return String(value).trim().toLowerCase().replace(/[\s_-]/g, "");
}

// WHY A BARE SINGLE BECOMES THE OUTER ONE. These systems report "S20" without
// saying which side of the treble it landed, but this codebase's segment space
// distinguishes them. They score identically, so nothing in the rules can tell
// the difference - it only decides where the board marker is drawn. The outer
// single is the larger of the two by area (the band from the treble to the
// double sweeps more board than the one from the bull to the treble), so it is
// the better guess when the report doesn't say.
function slotFor(bed, multiplier) {
  if (bed !== undefined && bed !== null && bed !== "") {
    const slot = BED_SLOTS.get(normalize(bed));
    if (slot !== undefined) return slot;
  }
  if (multiplier !== undefined && multiplier !== null) {
    const slot = MULTIPLIER_SLOTS.get(Number(multiplier));
    if (slot !== undefined) return slot;
  }
  return undefined;
}

function idForNumber(number, slot) {
  const n = Number(number);
  if (!Number.isInteger(n) || n < 1 || n > 20) return undefined;
  if (slot === undefined) return undefined;
  return (n - 1) * 4 + slot;
}

function idFromString(vocabulary, text) {
  const key = normalize(text);
  if (!key) return undefined;

  const named = vocabulary[key];
  if (named !== undefined) return named;

  // A bed prefix and a number. The prefix is optional so a bare "20" reads as a
  // single 20 rather than being rejected - some reports drop it.
  const match = /^([a-z]*)(\d{1,2})$/.exec(key);
  if (!match) return undefined;

  const [, prefix, digits] = match;
  const slot = prefix ? BED_SLOTS.get(prefix) : SLOT_OUTER;
  return idForNumber(digits, slot);
}

// ---------------------------------------------------------------------------
// The entry points
// ---------------------------------------------------------------------------
// Accepts every shape these reports have been seen to arrive in:
//
//   "T20"                                   compact string
//   { score: "D20", confidence: 0.95 }      OpenDartboard's WebSocket frame
//   { name: "T20" }                         wrapped, as Autodarts' API sends
//   { number: 20, bed: "Triple" }           named bed
//   { number: 20, multiplier: 3 }           bare multiplier
//   { segment: { ... } }                    nested under a throw object
//   { isMiss: true }                        an explicit miss
//
// Returns a segment object identical in shape to granboard.js's, or NULL for
// anything it cannot read. Null rather than a miss on purpose: a dart the
// mapper failed to understand is a bug to surface, and scoring it as a thrown
// miss would quietly cost the player a dart while hiding the cause.
export function segmentFrom(source, input) {
  const id = segmentIdFrom(source, input);
  return id === undefined ? null : createSegment(id);
}

// The same resolution, stopping at the raw ID. Exported so tests can assert on
// the integer without going through createSegment's derived fields.
export function segmentIdFrom(source, input) {
  const vocabulary = SOURCES[source]?.names;
  if (!vocabulary) throw new Error(`Unknown scoring source: ${source}`);
  if (input === null || input === undefined) return undefined;

  if (typeof input === "string" || typeof input === "number") {
    return idFromString(vocabulary, input);
  }

  if (typeof input !== "object") return undefined;

  // A throw object wrapping the segment - unwrap and try again. Guarded against
  // self-reference so a malformed payload can't spin forever.
  if (input.segment && input.segment !== input) {
    const nested = segmentIdFrom(source, input.segment);
    if (nested !== undefined) return nested;
  }

  // An explicit miss beats everything else on the object: a miss report may
  // still carry the number the camera thought it was nearest.
  if (input.isMiss === true) return SegmentID.MISS;

  // `score` is OpenDartboard's field, `name` is Autodarts'. Both are just a
  // string in the source's own vocabulary, so neither needs special handling
  // beyond looking in the right place.
  for (const key of ["score", "name"]) {
    if (input[key] !== undefined && input[key] !== null) {
      const found = idFromString(vocabulary, input[key]);
      if (found !== undefined) return found;
    }
  }

  if (input.number !== undefined && input.number !== null) {
    // The bulls arrive as number 25 or 50 with no useful bed, so they are
    // resolved by name before the 1-20 path rejects them.
    const asNamed = vocabulary[normalize(input.number)];
    if (asNamed !== undefined && (Number(input.number) === 25 || Number(input.number) === 50 || Number(input.number) === 0)) {
      // A double 25 is the inner bull however it was spelled.
      if (Number(input.number) === 25 && slotFor(input.bed, input.multiplier) === SLOT_DOUBLE) {
        return SegmentID.DBL_BULL;
      }
      return asNamed;
    }
    return idForNumber(input.number, slotFor(input.bed, input.multiplier) ?? SLOT_OUTER);
  }

  return undefined;
}

// Convenience for a connection layer, which reads one source for its lifetime
// and shouldn't have to name it on every dart.
export function createReader(source) {
  if (!SOURCES[source]) throw new Error(`Unknown scoring source: ${source}`);
  return (input) => segmentFrom(source, input);
}

// ---------------------------------------------------------------------------
// What a connection layer will need
// ---------------------------------------------------------------------------
// Measured against a stand-in on 3 August 2026, from the live HTTPS site:
//
//   - A WebSocket to http://localhost needs NO permission prompt and is not
//     subject to CORS. That is the friction-free path.
//   - Anything beyond loopback - a Pi on the LAN, which is what OpenDartboard
//     runs on - prompts once, per origin. Say what is about to be asked BEFORE
//     triggering it, the way the device check does for the camera.
//   - fetch() is gated twice: a Local Network Access grant AND the server
//     sending Access-Control-Allow-Origin. Do not add a REST fallback; it
//     would inherit a problem the WebSocket avoids.
//
// OpenDartboard: ws://<ip>:13520/scores, JSON frames with a `score` field, no
// authentication and no documented Origin check. Autodarts' board manager is on
// port 3180 and whether it checks Origin is still unverified.
//
// Never add a CSP with upgrade-insecure-requests: it rewrites ws:// and
// http://localhost to their secure forms and breaks all of this outright.
