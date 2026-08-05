// countupstats.js - statistics for Count Up.
//
// The smallest of the game modules, and useful precisely because of that: it is
// what a new game's stats module looks like. Count Up has no checkouts, no
// closing, no bust - you throw a fixed number of rounds and add up what you
// hit - so its metrics are almost entirely about scoring rate.
//
// Adding Around the Clock or Killer means writing a file this shape, exporting
// { key, label, lifetime(legs) }, and adding it to the registry in
// statsengine.js. Nothing else in the system needs to know.

import { metric, ratio, percent, dartsOf } from "../statsengine.js";

export const countupStats = {
  key: "countup",
  label: "Count Up",

  lifetime(legs) {
    let legsPlayed = 0;
    let legsWon = 0;
    let rounds = 0;
    let darts = 0;
    let points = 0;
    let bestRound = 0;
    let bestLeg = 0;
    let tonRounds = 0; // rounds of 100+
    let trebles = 0;

    for (const context of legs) {
      legsPlayed += 1;
      if (context.won) legsWon += 1;

      let legPoints = 0;
      for (const turn of context.turns) {
        rounds += 1;
        darts += turn.darts || 0;
        const turnPoints = turn.scored || 0;
        points += turnPoints;
        legPoints += turnPoints;
        if (turnPoints > bestRound) bestRound = turnPoints;
        if (turnPoints >= 100) tonRounds += 1;
      }
      if (legPoints > bestLeg) bestLeg = legPoints;

      for (const dart of dartsOf(context.turns)) {
        if (dart.multiplier === 3) trebles += 1;
      }
    }

    return {
      metrics: [
        metric("legs", "Games played", legsPlayed, "integer"),
        metric("legsWon", "Games won", legsWon, "integer"),
        metric("legWinPct", "Win %", percent(legsWon, legsPlayed), "percent"),
        metric("roundAverage", "Round average", ratio(points, rounds), "decimal"),
        metric("threeDart", "3-dart average", ratio(points * 3, darts), "decimal"),
        metric("bestRound", "Best round", bestRound, "integer"),
        metric("bestLeg", "Best total", bestLeg, "integer"),
        metric("tonRounds", "100+ rounds", tonRounds, "integer"),
        metric("trebles", "Trebles hit", trebles, "integer"),
        metric("points", "Total points", points, "integer"),
        metric("darts", "Darts thrown", darts, "integer"),
      ],
      raw: {
        legsPlayed, legsWon, rounds, darts, points,
        roundAverage: ratio(points, rounds), bestRound, bestLeg, tonRounds, trebles,
      },
    };
  },

  boards: [
    { key: "countup-best", label: "Best Count Up total", format: "integer",
      value: (raw) => raw.bestLeg },
  ],

  achievements: [
    { code: "countup-300", label: "Three hundred club", description: "Score 300 in a game of Count Up.",
      test: (r) => r.bestLeg >= 300 },
    { code: "countup-ton-round", label: "Century round", description: "Score 100 or more in a single round.",
      test: (r) => r.bestRound >= 100 },
  ],
};
