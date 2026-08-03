// autodarts.js - reading throws from an Autodarts board.
//
// Autodarts (https://autodarts.io) is a camera-based automatic scoring system.
// Its Board Manager runs on the player's own machine and reports what it sees;
// this file turns what it reports into the SAME segment objects granboard.js
// produces, so an Autodarts dart travels the identical path through the app as
// a Bluetooth dart, a clicked board, or a manual entry. Nothing downstream
// learns a fourth input exists.
//
// Autodarts is a trademark of Autodarts GmbH. This file is an independent
// reader of a local interface - no Autodarts code is copied or redistributed,
// and the app is not affiliated with or endorsed by them.
//
// THIS FILE IS DELIBERATELY ONLY THE MAPPER. There is no connection code yet,
// because one question is still open: a WebSocket server may reject a foreign
// Origin header even though browsers don't apply CORS to WebSockets, and that
// is unanswerable without a real board. The mapping is independent of it, is
// pure, and is exhaustively testable - so it exists first. See the note at the
// bottom for what the connection layer will need.

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

// Autodarts has used more than one vocabulary for the same thing across its
// board manager, its web API and the third-party integrations that read them,
// so this accepts all of the spellings rather than betting on one. Being
// generous here is cheap; guessing wrong is a silently dropped dart.
const BED_SLOTS = new Map(Object.entries({
  s: SLOT_OUTER, single: SLOT_OUTER, singleouter: SLOT_OUTER, outersingle: SLOT_OUTER, outer: SLOT_OUTER,
  si: SLOT_INNER, singleinner: SLOT_INNER, innersingle: SLOT_INNER, inner: SLOT_INNER,
  t: SLOT_TRIPLE, triple: SLOT_TRIPLE, treble: SLOT_TRIPLE,
  d: SLOT_DOUBLE, double: SLOT_DOUBLE,
}));

// A bare multiplier, for reports that give a number and a 1/2/3 rather than a
// named bed. 1 resolves to the OUTER single for the reason given below.
const MULTIPLIER_SLOTS = new Map([[1, SLOT_OUTER], [2, SLOT_DOUBLE], [3, SLOT_TRIPLE]]);

// The bulls and the non-hits. Two things here are load-bearing:
//
// The bull is emitted in SPLIT form always - outer bull is a single 25, inner
// is a double 50. Full-bull play is a transform applied further in
// (applyBullMode in granboard.js), so promoting the outer bull here as well
// would apply it twice and turn a 25 into a 50 in a split-bull match.
//
// A bare "BULL" is read as the OUTER bull, matching this codebase's own
// SegmentID names where BULL is 25 and DBL_BULL is 50. That is the one mapping
// in this file I would most like confirmed against real hardware: if Autodarts
// means 50 by it, every inner bull scores half until it is fixed. It is at
// least a loud kind of wrong - a bull that scores 25 is visible on the very
// first throw - which is why it maps to something rather than being rejected.
const NAMED_SEGMENTS = new Map(Object.entries({
  25: SegmentID.BULL, s25: SegmentID.BULL, sbull: SegmentID.BULL,
  bull: SegmentID.BULL, singlebull: SegmentID.BULL, outerbull: SegmentID.BULL,

  50: SegmentID.DBL_BULL, d25: SegmentID.DBL_BULL, dbull: SegmentID.DBL_BULL,
  doublebull: SegmentID.DBL_BULL, innerbull: SegmentID.DBL_BULL,
  bullseye: SegmentID.DBL_BULL,

  0: SegmentID.MISS, m: SegmentID.MISS, miss: SegmentID.MISS,
  out: SegmentID.MISS, outside: SegmentID.MISS, none: SegmentID.MISS,
}));

function normalize(value) {
  return String(value).trim().toLowerCase().replace(/[\s_-]/g, "");
}

// Which of a number's four IDs a bed name or multiplier refers to.
//
// WHY A BARE SINGLE BECOMES THE OUTER ONE. Autodarts reports "S20" without
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

// Parses the compact string form: "T20", "d16", "S5", "SI20", "25", "BULL",
// "M". Returns a SegmentID or undefined.
function idFromString(text) {
  const key = normalize(text);
  if (!key) return undefined;

  const named = NAMED_SEGMENTS.get(key);
  if (named !== undefined) return named;

  // A bed prefix and a number. The prefix is optional so a bare "20" reads as
  // a single 20 rather than being rejected - some reports drop it.
  const match = /^([a-z]*)(\d{1,2})$/.exec(key);
  if (!match) return undefined;

  const [, prefix, digits] = match;
  const slot = prefix ? BED_SLOTS.get(prefix) : SLOT_OUTER;
  return idForNumber(digits, slot);
}

// ---------------------------------------------------------------------------
// The one entry point
// ---------------------------------------------------------------------------
// Accepts every shape an Autodarts throw has been seen to arrive in:
//
//   "T20"                                   compact string
//   { name: "T20" }                         wrapped, as the web API sends
//   { number: 20, bed: "Triple" }           named bed
//   { number: 20, multiplier: 3 }           bare multiplier
//   { segment: { ... } }                    nested under a throw object
//   { isMiss: true }                        an explicit miss
//
// Returns a segment object identical in shape to granboard.js's, or NULL for
// anything it cannot read. Null rather than a miss on purpose: a dart the
// mapper failed to understand is a bug to surface, and scoring it as a thrown
// miss would quietly cost the player a dart while hiding the cause.
export function segmentFromAutodarts(input) {
  const id = segmentIdFromAutodarts(input);
  return id === undefined ? null : createSegment(id);
}

// The same resolution, stopping at the raw ID. Exported so tests can assert on
// the integer without going through createSegment's derived fields.
export function segmentIdFromAutodarts(input) {
  if (input === null || input === undefined) return undefined;

  if (typeof input === "string" || typeof input === "number") {
    return idFromString(input);
  }

  if (typeof input !== "object") return undefined;

  // A throw object wrapping the segment - unwrap and try again. Guarded
  // against self-reference so a malformed payload can't spin forever.
  if (input.segment && input.segment !== input) {
    const nested = segmentIdFromAutodarts(input.segment);
    if (nested !== undefined) return nested;
  }

  // An explicit miss beats everything else on the object: a miss report may
  // still carry the number the camera thought it was nearest.
  if (input.isMiss === true) return SegmentID.MISS;

  if (input.name !== undefined && input.name !== null) {
    const named = idFromString(input.name);
    if (named !== undefined) return named;
  }

  if (input.number !== undefined && input.number !== null) {
    // The bulls arrive as number 25 or 50 with no useful bed, so they are
    // resolved by name before the 1-20 path rejects them.
    const asNamed = NAMED_SEGMENTS.get(normalize(input.number));
    if (asNamed !== undefined && (input.number === 25 || input.number === 50 || input.number === 0)) {
      // A double 25 is the inner bull however it was spelled.
      if (input.number === 25 && slotFor(input.bed, input.multiplier) === SLOT_DOUBLE) {
        return SegmentID.DBL_BULL;
      }
      return asNamed;
    }
    return idForNumber(input.number, slotFor(input.bed, input.multiplier) ?? SLOT_OUTER);
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// What the connection layer will need, when the Origin question is settled
// ---------------------------------------------------------------------------
// Measured against a stand-in on 3 August 2026, from the live HTTPS site:
//
//   - A WebSocket to http://localhost:3180 needs NO permission prompt and is
//     not subject to CORS. That is the friction-free path and the one to use.
//   - fetch() is gated twice: a Chrome Local Network Access grant, AND the
//     server sending Access-Control-Allow-Origin. A board manager that sends
//     no CORS headers is unreadable by fetch - a no-cors probe returns an
//     opaque response, so the request is sent and merely unreadable. Do not
//     add a REST fallback; it would inherit a problem the WebSocket avoids.
//   - Anything beyond loopback (a Pi on the LAN) prompts once, per origin.
//     Say what is about to be asked BEFORE triggering it, the way the device
//     check does for the camera.
//
// Never add a CSP with upgrade-insecure-requests: it rewrites
// http://localhost:3180 to https and breaks this outright.
