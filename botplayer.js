// botplayer.js - computer opponents for practice.
//
// Pure and side-effect-free like the rest of the rules layer. It produces
// segments, exactly the objects a real board or a click produces, so a bot's
// dart travels the same path through applyHit() as a human's - and lands in the
// same recorder, the same statistics, the same undo stack. Nothing downstream
// knows the difference.
//
// HOW THE SKILL WORKS. Not a table of outcomes, and not "70% chance to hit the
// treble". The bot aims at a POINT on the board and its dart lands at that
// point plus a two-dimensional Gaussian error, which is then converted back
// into whatever segment that is. One number - the standard deviation of that
// error, in millimetres - is the entire difference between a beginner and a
// professional.
//
// Doing it geometrically rather than statistically matters, because it produces
// the RIGHT misses for free. A bot aiming at treble 20 and missing sideways
// hits 1 or 5, exactly as a person does; one missing low hits the 20 single.
// A probability table would have to be told that, and would get the
// correlations wrong - real darts that miss badly do not miss uniformly.
//
// The skill levels are pegged to the app's own rating table (see rating.js), so
// "play a B player" means something specific and checkable: a bot whose
// three-dart average actually lands in that band. The sigmas below were
// calibrated by simulation, not guessed - see the note on SKILL_LEVELS.

import { createSegment, SegmentID } from "./granboard.js";

// A standard board, in millimetres from the centre. These are the real
// dimensions; the geometry is what makes the misses believable.
const R_INNER_BULL = 6.35;
const R_OUTER_BULL = 15.9;
const R_TRIPLE_INNER = 99;
const R_TRIPLE_OUTER = 107;
const R_DOUBLE_INNER = 162;
const R_DOUBLE_OUTER = 170;

// Clockwise from the top. 20 is at 12 o'clock, and each wedge is 18 degrees.
const SECTORS = [20, 1, 18, 4, 13, 6, 10, 15, 2, 17, 3, 19, 7, 16, 8, 11, 14, 9, 12, 5];

// Where each ring sits, for aiming at one.
const RING_RADIUS = {
  triple: (R_TRIPLE_INNER + R_TRIPLE_OUTER) / 2,
  double: (R_DOUBLE_INNER + R_DOUBLE_OUTER) / 2,
  // The fat part of the wedge - where you aim when you want a single and do
  // not want to risk the double or the treble.
  inner: (R_OUTER_BULL + R_TRIPLE_INNER) / 2,
  outer: (R_TRIPLE_OUTER + R_DOUBLE_INNER) / 2,
};

// The skill levels, pegged to rating.js's bands. `sigma` is the standard
// deviation of the throwing error in millimetres - one number, and the entire
// difference between a beginner and a professional.
//
// SOLVED, NOT GUESSED. Each sigma was found by binary search: simulate darts at
// treble 20, measure the three-dart average, and search for the sigma that
// lands in the middle of the intended band. The measured averages are in the
// comments and are reproducible with simulateAverage() below - my first attempt
// at estimating these by eye had every level far too loose, with a
// "professional" averaging 65.
//
// Note how small the numbers are. Six millimetres of scatter is a 116 average;
// forty-four is a beginner on 35. Darts is a game of very fine margins, and a
// model that felt right by intuition would have been wrong by a factor of
// three.
export const SKILL_LEVELS = Object.freeze([
  { key: "beginner", label: "Beginner", rank: "C", sigma: 44.1 },   // ~35 avg
  { key: "casual", label: "Casual", rank: "CC", sigma: 20.3 },      // ~51
  { key: "club", label: "Club player", rank: "B", sigma: 15.5 },    // ~63
  { key: "strong", label: "Strong club", rank: "BB", sigma: 12.5 }, // ~75
  { key: "county", label: "County", rank: "A", sigma: 9.9 },        // ~89
  { key: "elite", label: "Elite", rank: "AA", sigma: 7.9 },         // ~103
  { key: "pro", label: "Professional", rank: "S", sigma: 6.3 },     // ~116
]);

export function skillFor(key) {
  return SKILL_LEVELS.find((s) => s.key === key) ?? SKILL_LEVELS[2];
}

// ---------------------------------------------------------------------------
// Throwing
// ---------------------------------------------------------------------------
// Box-Muller: two uniform randoms in, one normal out. Used rather than summing
// randoms because the tails matter here - the occasional wild dart is part of
// what makes a weak bot feel weak, and a naive approximation clips exactly
// those.
function gaussian(random) {
  let u = 0;
  let v = 0;
  while (u === 0) u = random();
  while (v === 0) v = random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// Which segment is at this point on the board.
export function segmentAt(x, y) {
  const radius = Math.hypot(x, y);
  if (radius > R_DOUBLE_OUTER) return createSegment(SegmentID.MISS);
  if (radius <= R_INNER_BULL) return createSegment(SegmentID.DBL_BULL);
  if (radius <= R_OUTER_BULL) return createSegment(SegmentID.BULL);

  // Angle measured clockwise from straight up, which is how the sector list is
  // written. atan2(x, y) rather than the usual (y, x) gives exactly that.
  const degrees = (Math.atan2(x, y) * 180) / Math.PI;
  const fromTop = (degrees + 360) % 360;
  const sector = SECTORS[Math.floor(((fromTop + 9) % 360) / 18)];

  // 0 = inner single, 1 = triple, 2 = outer single, 3 = double. The same slot
  // convention as SegmentID and dartboard.js - see CLAUDE.md.
  let slot;
  if (radius <= R_TRIPLE_INNER) slot = 0;
  else if (radius <= R_TRIPLE_OUTER) slot = 1;
  else if (radius <= R_DOUBLE_INNER) slot = 2;
  else slot = 3;

  return createSegment((sector - 1) * 4 + slot);
}

// The point a bot is aiming at, for a named target.
export function aimPoint(target) {
  if (target.kind === "bull") return { x: 0, y: 0 };

  const index = SECTORS.indexOf(target.section);
  if (index < 0) return { x: 0, y: 0 };

  const radians = (index * 18 * Math.PI) / 180;
  const radius = RING_RADIUS[target.ring] ?? RING_RADIUS.inner;
  // Inverse of segmentAt's angle convention.
  return { x: Math.sin(radians) * radius, y: Math.cos(radians) * radius };
}

// One dart. `random` is injectable so tests and calibration can be
// deterministic; it defaults to Math.random for real play.
export function throwDart(target, sigma, random = Math.random) {
  const aim = aimPoint(target);
  return segmentAt(aim.x + gaussian(random) * sigma, aim.y + gaussian(random) * sigma);
}

// ---------------------------------------------------------------------------
// What to aim at
// ---------------------------------------------------------------------------
const T20 = { kind: "segment", section: 20, ring: "triple" };
const T19 = { kind: "segment", section: 19, ring: "triple" };
const BULL = { kind: "bull" };

// A deliberately ordinary checkout brain: it knows the doubles, knows to leave
// an even number, and otherwise scores. It is not a checkout solver and does
// not need to be - a bot that always found the perfect three-dart route would
// be less like a person, not more, and the skill difference is meant to live in
// the throwing rather than in the arithmetic.
export function chooseX01Target(remaining, dartsLeft, outRule = "double") {
  const straightOut = outRule === "straight";

  // On a finishable double already.
  if (remaining === 50) return BULL;
  if (remaining <= 40 && remaining % 2 === 0) {
    return { kind: "segment", section: remaining / 2, ring: "double" };
  }
  if (straightOut && remaining <= 20) {
    return { kind: "segment", section: remaining, ring: "inner" };
  }

  // Odd, and low enough to set up: take a single to leave an even number.
  if (remaining <= 40 && remaining % 2 === 1) {
    const leave = remaining - 1;
    // Aim at whatever single leaves a tidy double, biased to leaving 32/16/8.
    const single = Math.min(20, Math.max(1, remaining - Math.min(leave, 32)));
    return { kind: "segment", section: single || 1, ring: "inner" };
  }

  // In range to try a treble-and-double route: leave 40 if we can.
  if (remaining <= 170 && dartsLeft >= 2) {
    const wanted = remaining - 40;
    if (wanted > 0 && wanted <= 60 && wanted % 3 === 0) {
      return { kind: "segment", section: wanted / 3, ring: "triple" };
    }
    if (wanted > 0 && wanted <= 20) {
      return { kind: "segment", section: wanted, ring: "inner" };
    }
  }

  // 61-100 with one dart left is a lost cause; keep scoring.
  return remaining > 60 || dartsLeft > 1 ? T20 : T19;
}

// Cricket: hit whatever is still open, biggest first, then the bull. Trebles,
// because three marks a dart is the whole game.
export function chooseCricketTarget(marks = {}) {
  for (const number of [20, 19, 18, 17, 16, 15]) {
    if ((marks[number] || 0) < 3) return { kind: "segment", section: number, ring: "triple" };
  }
  if ((marks.BULL || 0) < 3) return BULL;
  // Everything closed - keep scoring on the 20 for points.
  return T20;
}

// Count Up is pure accumulation: there is no target to close and no way to
// bust, so the highest-value dart on the board is always the right answer.
// Stated in its own function rather than borrowed from the x01 brain, because
// "aim at T20 because that scores most" and "aim at T20 because 501 is a long
// way away" are different reasons that happen to agree.
export function chooseCountUpTarget() {
  return T20;
}

// Bermuda Triangle: the target is dictated by the round, so this is not a
// choice of WHERE to score but of where to stand the best chance of scoring on
// the one thing that counts.
//
// Every case aims at a TREBLE rather than the fat single, which looks reckless
// for a weak bot given that missing a round with all three darts halves the
// total. It isn't, and the geometry is why: a wedge widens as it goes out, so
// the 18-degree slice is about 16mm across at the treble ring and only about
// 9mm at the fat single. Aiming at the treble is both the higher-scoring shot
// AND the wider one - the safe-looking alternative is neither.
//
// The two "anywhere on the board" rounds turn that up further. On Any Double
// and Any Triple a sideways miss off the 20 lands in the 1 or the 5 - which is
// still a double, or still a triple, and still counts. Only a radial miss
// leaves the ring. So the bot aims at the most valuable segment of the ring and
// gets the whole ring as its margin for error.
export function chooseBermudaTarget(target) {
  if (!target) return T20;

  switch (target.kind) {
    // Any segment of the number scores, so aim at its treble.
    case "number":
      return { kind: "segment", section: target.value, ring: "triple" };

    case "double":
      return { kind: "segment", section: 20, ring: "double" };

    case "triple":
      return T20;

    // Both bulls count on "Any Bull" and only the inner one on "Double Bull",
    // but the aim point is the centre of the board either way - there is
    // nowhere else to stand a better chance from.
    case "bull":
    case "dbull":
      return BULL;

    default:
      return T20;
  }
}

// ---------------------------------------------------------------------------
// Calibration
// ---------------------------------------------------------------------------
// Exported so the sigmas above can be checked rather than trusted. Simulates
// darts at treble 20 and returns the three-dart average that results, which is
// the number the rating table reads.
export function simulateAverage(sigma, darts = 60_000, random = Math.random) {
  let total = 0;
  for (let i = 0; i < darts; i++) total += throwDart(T20, sigma, random).value;
  return (total / darts) * 3;
}
