// bermudastats.js - statistics for Bermuda Triangle.
//
// A game module registered in statsengine.js, and the clearest demonstration of
// why the statistics are per-game: none of x01's measures mean anything here.
// There is no checkout, no average worth quoting against another game, and the
// single most important thing about a player is something no other mode has -
// how often they avoid being halved.
//
// The halving is what this game is about. Missing a round with all three darts
// costs you half of everything you have, so a player who scores enormously and
// misses two rounds finishes behind one who scores modestly and never misses.
// The metrics are chosen to say which of those two somebody is.

import { metric, ratio, percent, dartsOf } from "../statsengine.js";

export const bermudaStats = {
  key: "bermuda",
  label: "Bermuda Triangle",

  lifetime(legs) {
    let legsPlayed = 0;
    let legsWon = 0;
    let rounds = 0;
    let roundsHit = 0;
    let darts = 0;
    let dartsOnTarget = 0;

    let bestFinal = 0;
    let totalFinal = 0;
    let bestRound = 0;

    let halvings = 0;
    let pointsLost = 0;
    let cleanLegs = 0; // finished without being halved once
    let hatTricks = 0;

    for (const context of legs) {
      legsPlayed += 1;
      if (context.won) legsWon += 1;

      // Replayed in throw order, because the running total - and therefore what
      // a halving actually costs - depends on everything before it. A total
      // cannot be recovered from a sum of visits when half of it can vanish.
      const turns = [...context.turns].sort((a, b) => a.turnIndex - b.turnIndex);

      let total = 0;
      let legHalvings = 0;

      for (const turn of turns) {
        rounds += 1;
        darts += turn.darts || 0;

        const payload = turn.game;
        const points = payload?.points ?? (turn.scored || 0);
        // Fall back to the visit's score when a match predates the per-visit
        // payload: a visit that scored nothing was a visit that missed.
        const missed = payload?.missed ?? (points === 0);

        if (!missed) roundsHit += 1;
        if (points > bestRound) bestRound = points;

        const onTarget = (payload?.darts ?? []).filter((d) => d?.hit).length;
        dartsOnTarget += onTarget;

        // A hat trick is the game's only named feat. Three darts, all on the
        // target, in one visit.
        if (onTarget === 3) hatTricks += 1;

        total += points;
        if (missed) {
          const before = total;
          total = Math.floor(total / 2);
          // Zero lost is not a halving worth counting - being halved on nothing
          // costs nothing, and counting it would make an early miss look as bad
          // as a late one.
          if (before - total > 0) {
            halvings += 1;
            legHalvings += 1;
            pointsLost += before - total;
          }
        }
      }

      if (turns.length) {
        totalFinal += total;
        if (total > bestFinal) bestFinal = total;
        if (legHalvings === 0) cleanLegs += 1;
      }
    }

    return {
      metrics: [
        metric("legs", "Games played", legsPlayed, "integer"),
        metric("legsWon", "Games won", legsWon, "integer"),
        metric("legWinPct", "Win %", percent(legsWon, legsPlayed), "percent"),
        metric("bestFinal", "Best score", bestFinal, "integer"),
        metric("avgFinal", "Average score", ratio(totalFinal, legsPlayed, 0), "integer"),
        metric("roundHitPct", "Rounds survived", percent(roundsHit, rounds), "percent",
          "Rounds where at least one dart found the target - the ones that did not halved your score."),
        metric("halvings", "Times halved", halvings, "integer"),
        metric("pointsLost", "Points lost to halving", pointsLost, "integer"),
        metric("cleanLegs", "Unhalved games", cleanLegs, "integer",
          "Games finished without ever missing a round."),
        metric("bestRound", "Best round", bestRound, "integer"),
        metric("dartAccuracy", "Darts on target", percent(dartsOnTarget, darts), "percent"),
        metric("hatTricks", "Hat tricks", hatTricks, "integer",
          "All three darts on the target in one visit."),
        metric("darts", "Darts thrown", darts, "integer"),
      ],
      raw: {
        legsPlayed, legsWon, rounds, roundsHit, darts, dartsOnTarget,
        bestFinal, avgFinal: ratio(totalFinal, legsPlayed, 0), bestRound,
        halvings, pointsLost, cleanLegs, hatTricks,
        roundHitPct: percent(roundsHit, rounds),
      },
    };
  },

  boards: [
    { key: "bermuda-best", label: "Best Bermuda score", format: "integer",
      value: (raw) => raw.bestFinal },
    {
      key: "bermuda-survival",
      label: "Rounds survived",
      format: "percent",
      // An average over a handful of rounds is noise, and this one is easy to
      // sit at 100% on by having played once.
      minimum: { label: "100 rounds", test: (raw) => raw.rounds >= 100 },
      value: (raw) => raw.roundHitPct,
    },
  ],

  achievements: [
    { code: "bermuda-first-win", label: "Survived the Triangle", description: "Win a game of Bermuda Triangle.",
      test: (r) => r.legsWon >= 1 },
    { code: "bermuda-500", label: "Five hundred", description: "Finish a Bermuda game on 500 or more.",
      test: (r) => r.bestFinal >= 500 },
    { code: "bermuda-unhalved", label: "Unscathed", description: "Finish a game without missing a single round.",
      test: (r) => r.cleanLegs >= 1 },
    { code: "bermuda-hat-trick", label: "Triangle hat trick", description: "Put all three darts on the target in one visit.",
      test: (r) => r.hatTricks >= 1 },
    { code: "bermuda-sniper", label: "Sniper", description: "Survive 90% of your rounds over 100 rounds.",
      test: (r) => r.rounds >= 100 && r.roundHitPct >= 90 },
  ],
};
