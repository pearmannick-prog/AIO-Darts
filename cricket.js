// cricket.js - pure Cricket rules.
//
// Deliberately side-effect-free and dependency-light, exactly like scoring.js:
// two browsers running the same inputs through these functions land on the
// same state, which is what lets online play stay in sync without a
// rollback/replay system.
//
// Cricket in brief, for anyone reading this who hasn't played it:
//   * Only 20, 19, 18, 17, 16, 15 and the bull matter. Everything else is a
//     complete miss, scoring-wise.
//   * Each hit is worth "marks": a single is 1, a double 2, a triple 3.
//     Three marks CLOSES that number for you.
//   * Once you've closed a number, further hits on it score points equal to
//     the number's value per mark - but only while an opponent still has it
//     open. Once everyone has closed it, it's dead and worth nothing.
//   * You win by closing every number AND being level or ahead on points.
//     Closing everything while behind does NOT win - you keep throwing to
//     catch up, which is the part that surprises people.

import { SegmentType } from "./granboard.js";

// Bull is stored as the string "BULL" to match the `section` a segment
// carries, so marks can be keyed off it directly without a special case.
export const CRICKET_TARGETS = [20, 19, 18, 17, 16, 15, "BULL"];
export const MARKS_TO_CLOSE = 3;

export function targetValue(target) {
  return target === "BULL" ? 25 : target;
}

export function targetLabel(target) {
  return target === "BULL" ? "Bull" : String(target);
}

export function createCricketPlayer(name) {
  const marks = {};
  for (const t of CRICKET_TARGETS) marks[t] = 0;
  return { name, marks, points: 0 };
}

// Translates a dart into cricket terms. Returns null for anything that isn't
// a cricket number - a T7 is simply nothing here, not a miss to be recorded
// specially.
//
// SegmentType doubles as the multiplier (Single=1, Double=2, Triple=3), so
// marks fall straight out of it - including the bull, where a single bull is
// 1 mark and a double bull is 2.
export function segmentToMarks(segment) {
  if (!segment) return null;

  if (segment.section === "BULL") {
    return { target: "BULL", marks: segment.type === SegmentType.Double ? 2 : 1 };
  }

  if (typeof segment.section !== "number") return null;
  if (!CRICKET_TARGETS.includes(segment.section)) return null;

  const marks = segment.type;
  if (marks !== 1 && marks !== 2 && marks !== 3) return null;
  return { target: segment.section, marks };
}

export function isClosedBy(player, target) {
  return (player.marks?.[target] || 0) >= MARKS_TO_CLOSE;
}

export function hasClosedAll(player) {
  return CRICKET_TARGETS.every((t) => isClosedBy(player, t));
}

// A number is "dead" once every player has closed it - nobody can score on it
// again. Worth checking before awarding points, or a two-player game would
// keep paying out on numbers both players finished.
export function isTargetDead(players, target) {
  return players.every((p) => isClosedBy(p, target));
}

// Works out what a dart does without changing anything. The caller applies the
// result - same split as resolveThrow in scoring.js.
//
// Returns:
//   target       - which cricket number was hit, or null if it wasn't one
//   marks        - marks the dart was worth (1-3)
//   marksApplied - how many of those actually went toward closing (the rest
//                  overflow into points)
//   newMarks     - the player's mark count afterwards, capped at 3
//   points       - points scored by the overflow, 0 if the number is dead
//   justClosed   - true only on the dart that closes it
//   wasted       - overflow that scored nothing because everyone had closed it
export function resolveCricketThrow(players, playerIndex, segment) {
  const none = {
    target: null, marks: 0, marksApplied: 0, newMarks: 0,
    points: 0, justClosed: false, wasted: false,
  };

  const hit = segmentToMarks(segment);
  if (!hit) return none;

  const me = players[playerIndex];
  if (!me) return none;

  const before = me.marks?.[hit.target] || 0;
  const needed = Math.max(0, MARKS_TO_CLOSE - before);
  const marksApplied = Math.min(hit.marks, needed);
  const overflow = hit.marks - marksApplied;

  // Overflow only pays out while someone else still has the number open. A
  // triple on a number you've already closed is worth 3x face value against
  // an opponent who hasn't got there yet, and nothing at all once they have.
  const scoreable = players.some((p, i) => i !== playerIndex && !isClosedBy(p, hit.target));
  const points = scoreable ? overflow * targetValue(hit.target) : 0;

  return {
    target: hit.target,
    marks: hit.marks,
    marksApplied,
    newMarks: Math.min(MARKS_TO_CLOSE, before + hit.marks),
    points,
    justClosed: before < MARKS_TO_CLOSE && before + hit.marks >= MARKS_TO_CLOSE,
    wasted: overflow > 0 && !scoreable,
  };
}

// Mutates one player by the result of resolveCricketThrow. Kept separate so
// the resolve step stays pure and testable on its own.
export function applyCricketResult(player, result) {
  if (!result?.target) return;
  player.marks[result.target] = result.newMarks;
  player.points += result.points;
}

// Closing everything isn't enough on its own - you also have to be level or
// ahead on points. This is why a game can look finished and isn't.
export function checkCricketWin(players, playerIndex) {
  const me = players[playerIndex];
  if (!me || !hasClosedAll(me)) return false;
  const best = players.reduce(
    (max, p, i) => (i === playerIndex ? max : Math.max(max, p.points)),
    -Infinity
  );
  return me.points >= best;
}

// A short description of what a dart did, for the throw log.
export function describeCricketResult(segment, result) {
  if (!result?.target) return `${segment?.longName || "Miss"} (no score)`;
  const label = targetLabel(result.target);
  const bits = [];
  if (result.marksApplied > 0) {
    bits.push(`${result.marksApplied} mark${result.marksApplied > 1 ? "s" : ""} on ${label}`);
  }
  if (result.points > 0) bits.push(`+${result.points}`);
  if (result.wasted) bits.push(`${label} closed out`);
  if (result.justClosed && result.points === 0 && !result.wasted) bits.push("closed");
  return bits.join(" · ") || `${label} (no score)`;
}

// Marks are shown the way they're chalked on a real board: one slash, then
// crossed into an X, then circled once closed.
export function markSymbol(count) {
  if (count >= MARKS_TO_CLOSE) return "\u2297"; // circled X
  if (count === 2) return "\u2715";             // X
  if (count === 1) return "\u2571";             // /
  return "";
}
