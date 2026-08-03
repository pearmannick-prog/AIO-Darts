// x01stats.js - statistics for 301/501/701 and their in/out variants.
//
// One of the game modules registered in statsengine.js. It is handed the legs
// of x01 that were played, already split into the player's own visits and the
// opponents', and returns metrics plus the raw totals achievements and
// leaderboards read.
//
// Everything here is derived from stored darts. Nothing is remembered from when
// the match was played, which is why changing a definition below - and several
// of them ARE choices rather than facts - reprices every match ever recorded
// instead of only the ones played afterwards.

import { metric, ratio, percent, dartsOf } from "../statsengine.js";
import { highestCheckout, isOneDartFinish, rulesFor } from "../scoring.js";

// Where the scoring phase ends and the finish zone begins.
//
// This is what separates the two averages the rating tables are built on:
//
//   80%  - the pure SCORING phase, visits thrown while there is still a hundred
//          or more on the board. Nobody is aiming at a double here; the whole
//          job is to put three darts in the treble twenty. It measures how big
//          you score, uncontaminated by finishing.
//   100% - the WHOLE game, including setup shots and darts thrown at a double
//          that missed. It measures what you actually did.
//
// A visit is classified by the score it BEGAN on, so the visit that takes you
// from 140 to 32 counts as scoring - which is what it was, right up until it
// worked.
const FINISH_ZONE = 100;

export const x01Stats = {
  key: "x01",
  label: "X01",

  lifetime(legs) {
    let legsPlayed = 0;
    let legsWon = 0;
    let darts = 0;
    let scored = 0;

    let first9Scored = 0;
    let first9Darts = 0;

    // The scoring-phase totals, which feed the rating.
    let scoringScored = 0;
    let scoringDarts = 0;

    let checkouts = 0;
    let checkoutChances = 0;
    let bestCheckout = 0;

    let highestScore = 0;
    let oneEighties = 0;
    let oneForties = 0;
    let tons = 0;

    let doublesHit = 0;
    let doublesThrown = 0;

    let perfectLegs = 0;
    let fewestDarts = 0;

    const matchesSeen = new Set();
    const scoreHistogram = new Map(); // visit total -> how often

    for (const context of legs) {
      legsPlayed += 1;
      if (context.won) legsWon += 1;
      matchesSeen.add(context.match.clientUuid ?? context.match.id);

      // A PERFECT LEG is one won in the fewest darts the starting score allows:
      // nine for 501, six for 301, twelve for 701. Defining it from the start
      // score rather than hard-coding "nine darts" means it means the same
      // thing in every x01 variant, including any added later.
      if (context.won) {
        const legDarts = context.turns.reduce((sum, t) => sum + (t.darts || 0), 0);
        if (legDarts > 0 && (fewestDarts === 0 || legDarts < fewestDarts)) fewestDarts = legDarts;
        const start = context.leg.x01Start || 501;
        if (legDarts === Math.ceil(start / 180) * 3) perfectLegs += 1;
      }

      // The out rule is per leg, and the two checkout figures below both depend
      // on it: under master or single out a visit that begins on 180 is a
      // genuine chance (T20 T20 T20 finishes), where under double out it is
      // not. Reading it from the leg rather than assuming double out is what
      // stops a medley of mixed rules being scored against the wrong ceiling.
      const legRules = context.leg.rules || "double";
      const ceiling = highestCheckout(legRules);
      const needsDouble = rulesFor(legRules).out === "double";

      // Visits in the order they were thrown - the first-9 average depends on
      // it, and turn_index is the only thing that guarantees it.
      const turns = [...context.turns].sort((a, b) => a.turnIndex - b.turnIndex);

      turns.forEach((turn, index) => {
        const turnScore = turn.scored || 0;
        darts += turn.darts || 0;
        scored += turnScore;

        // The first nine darts of a leg: the standard measure of how well
        // someone scores before checkout pressure starts shaping their throws.
        // Counted as the first three visits, which is what nine darts is
        // unless a leg ended inside them.
        if (index < 3) {
          first9Scored += turnScore;
          first9Darts += turn.darts || 0;
        }

        // Visits thrown before reaching the finish zone. A bust at 140 belongs
        // here - it was a scoring visit that went wrong, and excluding it would
        // quietly flatter the number.
        if (turn.remainingBefore === null || turn.remainingBefore === undefined
            || turn.remainingBefore >= FINISH_ZONE) {
          scoringScored += turnScore;
          scoringDarts += turn.darts || 0;
        }

        if (turnScore > highestScore) highestScore = turnScore;
        if (turnScore === 180) oneEighties += 1;
        if (turnScore >= 140) oneForties += 1;
        if (turnScore >= 100) tons += 1;

        scoreHistogram.set(turnScore, (scoreHistogram.get(turnScore) || 0) + 1);

        // CHECKOUT PERCENTAGE is a definition, not a measurement. Nobody
        // records what a player was aiming at, so "attempts" has to be
        // inferred. This uses the common scorer's definition: a visit that
        // began on a checkable score was a chance, and it was taken if the leg
        // was finished in it. It slightly flatters players who are often on a
        // finish and slightly punishes those who leave awkward numbers, which
        // is exactly what the number is supposed to reflect.
        if (turn.remainingBefore !== null && turn.remainingBefore !== undefined
            && turn.remainingBefore <= ceiling) {
          checkoutChances += 1;
          if (turn.isCheckout) {
            checkouts += 1;
            if (turn.remainingBefore > bestCheckout) bestCheckout = turn.remainingBefore;
          }
        }
      });

      // DOUBLES PERCENTAGE, per dart rather than per visit. A dart thrown while
      // the player was sitting on a one-dart finish is an attempt at it; the
      // one that ended the leg is a hit. Quick-total visits are excluded
      // because they record no individual darts - counting them would inflate
      // the denominator with darts nobody described.
      //
      // Counted ONLY in legs whose out rule actually requires a double. Under
      // master or single out a player on 60 is throwing at a treble, not a
      // double, and folding those darts into a "doubles %" would be measuring
      // something nobody attempted.
      if (needsDouble) {
        for (const dart of dartsOf(context.turns)) {
          if (!isOneDartFinish(dart.remainingBefore, legRules)) continue;
          doublesThrown += 1;
          if (dart.remainingAfter === 0 && !dart.bust) doublesHit += 1;
        }
      }
    }

    const threeDart = ratio(scored * 3, darts);
    const ppr80 = ratio(scoringScored * 3, scoringDarts);

    return {
      metrics: [
        metric("legs", "Legs played", legsPlayed, "integer"),
        metric("legsWon", "Legs won", legsWon, "integer"),
        metric("legWinPct", "Leg win %", percent(legsWon, legsPlayed), "percent"),
        metric("ppr80", "Scoring average (80%)", ppr80, "decimal",
          "Visits thrown with 100 or more left - the pure scoring phase, which is what the rating table reads."),
        metric("threeDart", "3-dart average (100%)", threeDart, "decimal",
          "The whole game, including setup shots and missed doubles."),
        metric("first9", "First 9 average", ratio(first9Scored * 3, first9Darts), "decimal"),
        metric("checkoutPct", "Checkout %", percent(checkouts, checkoutChances), "percent",
          "Visits that began on a checkable score and finished the leg. The ceiling " +
          "follows the leg's out rule - 170 for double out, 180 where a treble can finish."),
        metric("highestCheckout", "Highest checkout", bestCheckout, "integer"),
        metric("highestScore", "Highest score", highestScore, "integer"),
        metric("oneEighties", "180s", oneEighties, "integer"),
        metric("oneForties", "140+", oneForties, "integer"),
        metric("tons", "100+", tons, "integer"),
        metric("doublesPct", "Doubles %", percent(doublesHit, doublesThrown), "percent",
          "Darts thrown while sitting on a one-dart double, in double-out legs only."),
        metric("doublesHit", "Doubles hit", doublesHit, "integer"),
        metric("doublesMissed", "Doubles missed", Math.max(0, doublesThrown - doublesHit), "integer"),
        metric("fewestDarts", "Fewest darts in a leg", fewestDarts, "integer"),
        metric("darts", "Darts thrown", darts, "integer"),
      ],
      raw: {
        legsPlayed, legsWon, darts, scored, threeDart, ppr80, scoringDarts,
        perfectLegs, fewestDarts,
        first9: ratio(first9Scored * 3, first9Darts),
        checkouts, checkoutChances, highestCheckout: bestCheckout, highestScore,
        oneEighties, oneForties, tons,
        doublesHit, doublesThrown,
        matches: matchesSeen.size,
        // Feeds the scoring-consistency heatmap: how often each visit total
        // came up. Sorted so the chart doesn't have to.
        scoreHistogram: [...scoreHistogram.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([score, count]) => ({ score, count })),
      },
    };
  },

  // Leaderboards, like achievements, are declared by the game they measure.
  // Adding Around the Clock brings its own boards with it and the leaderboard
  // page grows an entry without being edited.
  //
  // EVERY AVERAGE NEEDS A QUALIFICATION. Without one, the top of a three-dart
  // average board is whoever has thrown nine darts and got lucky, and the board
  // is worthless within a day of anyone noticing. `minimum` is the honest floor
  // and it is shown on the page next to the board's name rather than hidden.
  boards: [
    {
      key: "x01-average",
      label: "Three-dart average",
      format: "decimal",
      minimum: { label: "300 darts", test: (raw) => raw.darts >= 300 },
      value: (raw) => raw.threeDart,
    },
    {
      key: "x01-first9",
      label: "First 9 average",
      format: "decimal",
      minimum: { label: "300 darts", test: (raw) => raw.darts >= 300 },
      value: (raw) => raw.first9,
    },
    {
      key: "x01-checkout",
      label: "Checkout %",
      format: "percent",
      minimum: { label: "50 chances", test: (raw) => raw.checkoutChances >= 50 },
      value: (raw) => (raw.checkoutChances ? Number(((raw.checkouts / raw.checkoutChances) * 100).toFixed(1)) : 0),
    },
    // Counting boards need no qualification: a total is a total, and someone
    // who has thrown one 180 is honestly in last place rather than wrongly in
    // first.
    { key: "x01-highest-checkout", label: "Highest checkout", format: "integer",
      value: (raw) => raw.highestCheckout },
    { key: "x01-180s", label: "Most 180s", format: "integer",
      value: (raw) => raw.oneEighties },
  ],

  // Achievements are declared by the game they belong to, so "First 180" lives
  // with x01 and can never be awarded for a Cricket match. Each one tests the
  // module's own raw totals, which means they are re-evaluated from the darts
  // rather than latched at the moment they happened - add a new achievement and
  // it is awarded retroactively to everyone who already earned it.
  achievements: [
    { code: "first-180", label: "First 180", description: "Score a maximum." ,
      test: (r) => r.oneEighties >= 1 },
    { code: "ten-180s", label: "Ten maximums", description: "Score ten 180s.",
      test: (r) => r.oneEighties >= 10 },
    { code: "big-fish", label: "Big fish", description: "Check out from 170.",
      test: (r) => r.highestCheckout >= 170 },
    { code: "ton-average", label: "Ton average", description: "Hold a 60+ three-dart average over 300 darts.",
      test: (r) => r.threeDart >= 60 && r.darts >= 300 },
    { code: "perfect-leg", label: "Perfect leg", description: "Win a leg in the fewest darts possible.",
      test: (r) => r.perfectLegs >= 1 },
    { code: "consistent-scorer", label: "Consistent scorer", description: "Throw 50 visits of 100 or more.",
      test: (r) => r.tons >= 50 },
    { code: "sharp-doubles", label: "Sharp doubles", description: "Hit 40% of your doubles over 50 attempts.",
      test: (r) => r.doublesThrown >= 50 && (r.doublesHit / r.doublesThrown) >= 0.4 },
  ],
};
