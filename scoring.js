// scoring.js - pure 501 rules, shared by local pass-and-play and online play.
// Kept dependency-free and side-effect-free so both game modes compute
// identical results from identical inputs (this is what keeps two remote
// browsers in sync without needing a rollback/replay system - see README).

import { SegmentType } from "./granboard.js";

// Given a player's remaining score before a throw and the segment hit,
// returns what happens - the caller decides how to apply it (bust reverts
// to the start-of-turn value, which only the caller knows).
export function resolveThrow(remainingBefore, segment) {
  const after = remainingBefore - segment.value;
  const isBust = after < 0 || after === 1 || (after === 0 && segment.type !== SegmentType.Double);
  const isWin = after === 0 && segment.type === SegmentType.Double;
  return { after, isBust, isWin };
}
