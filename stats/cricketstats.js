// cricketstats.js - statistics for Cricket.
//
// A game module registered in statsengine.js. Cricket measures completely
// different things from x01 - marks rather than points, rounds rather than
// darts to a finish - which is exactly why the stats system is per-game rather
// than one shared list with blanks in it.
//
// Everything is derived from the stored darts. The per-visit payload written by
// matchrecorder.js (targets, marks, points) is used where it exists because it
// is what the rules concluded at the time; where it doesn't, the darts
// themselves still carry the detail.

import { metric, ratio, percent, dartsOf } from "../statsengine.js";

// Cricket's numbers. BULL is a target like any other here.
const TARGET_VALUE = { 20: 20, 19: 19, 18: 18, 17: 17, 16: 16, 15: 15, BULL: 25 };

export const cricketStats = {
  key: "cricket",
  label: "Cricket",

  lifetime(legs) {
    let legsPlayed = 0;
    let legsWon = 0;
    let rounds = 0;
    let darts = 0;
    let marks = 0;
    let points = 0;
    let pointsPrevented = 0;
    let highestRound = 0;
    let bestMatchMpr = 0;

    // Turns by how many marks they were worth. The spec asks for 3/4/5/6-mark
    // turns specifically, so they are counted individually rather than as a
    // histogram nobody would read.
    let threeMark = 0;
    let fourMark = 0;
    let fiveMark = 0;
    let sixMark = 0;

    let whiteHorses = 0;
    let hatTricks = 0;

    let bulls = 0;
    let singles = 0;
    let doubles = 0;
    let triples = 0;

    const perMatch = new Map(); // match -> {marks, rounds} for the best-MPR figure

    for (const context of legs) {
      legsPlayed += 1;
      if (context.won) legsWon += 1;

      const matchKey = context.match.clientUuid ?? context.match.id;
      if (!perMatch.has(matchKey)) perMatch.set(matchKey, { marks: 0, rounds: 0 });
      const matchTally = perMatch.get(matchKey);

      for (const turn of context.turns) {
        // A round IS a visit in Cricket - MPR is marks per visit to the board,
        // which is why this counts turns and not darts.
        rounds += 1;
        darts += turn.darts || 0;
        matchTally.rounds += 1;

        const turnMarks = turn.game?.marks ?? marksFromThrows(turn);
        const turnPoints = turn.game?.points ?? (turn.scored || 0);

        marks += turnMarks;
        points += turnPoints;
        matchTally.marks += turnMarks;

        if (turnPoints > highestRound) highestRound = turnPoints;

        if (turnMarks === 3) threeMark += 1;
        else if (turnMarks === 4) fourMark += 1;
        else if (turnMarks === 5) fiveMark += 1;
        else if (turnMarks === 6) sixMark += 1;

        const throws = turn.throws ?? [];

        // WHITE HORSE. Worth spelling out because the term is used two ways:
        // some scorers mean any six-mark visit, others mean the harder and more
        // specific feat of three triples on three DIFFERENT numbers, all of
        // them still open. This counts the strict version, and the six-mark
        // count above is reported separately - so whichever definition someone
        // has in mind, the number they want is on the page and neither label
        // is wrong.
        if (throws.length === 3 && throws.every((t) => t.multiplier === 3)) {
          const sections = new Set(throws.map((t) => t.section));
          if (sections.size === 3) whiteHorses += 1;
        }

        // Hat trick: three bulls in a visit.
        if (throws.length === 3 && throws.every((t) => t.section === "BULL")) {
          hatTricks += 1;
        }
      }

      // Where the darts landed, for the "what do I actually hit" breakdown.
      for (const dart of dartsOf(context.turns)) {
        if (dart.section === "BULL") bulls += 1;
        if (dart.multiplier === 3) triples += 1;
        else if (dart.multiplier === 2) doubles += 1;
        else singles += 1;
      }

      // POINTS PREVENTED: what the opponents would have scored on numbers this
      // player had already closed. Overflow marks that paid out nothing are
      // exactly that - the opponent hit the number, and closing it first is why
      // it was worth nothing. It is the one Cricket statistic that measures
      // defence, and it is only computable because the opponents' darts are
      // recorded too, not just the player's own.
      for (const turn of context.opponentTurns) {
        for (const dart of turn.throws ?? []) {
          const extra = dart.extra;
          if (!extra?.target) continue;
          const overflow = (extra.marks || 0) - (extra.marksApplied || 0);
          if (overflow > 0 && !(extra.points > 0)) {
            pointsPrevented += overflow * (TARGET_VALUE[extra.target] || 0);
          }
        }
      }
    }

    for (const tally of perMatch.values()) {
      const mpr = ratio(tally.marks, tally.rounds);
      if (mpr > bestMatchMpr) bestMatchMpr = mpr;
    }

    return {
      metrics: [
        metric("legs", "Legs played", legsPlayed, "integer"),
        metric("legsWon", "Legs won", legsWon, "integer"),
        metric("legWinPct", "Leg win %", percent(legsWon, legsPlayed), "percent"),
        metric("mpr", "Marks per round", ratio(marks, rounds), "decimal"),
        metric("bestMpr", "Best match MPR", bestMatchMpr, "decimal"),
        metric("marks", "Total marks", marks, "integer"),
        metric("rounds", "Rounds played", rounds, "integer"),
        metric("marksPerDart", "Marks per dart", ratio(marks, darts), "decimal"),
        metric("points", "Points scored", points, "integer"),
        metric("pointsPrevented", "Points prevented", pointsPrevented, "integer",
          "Opponent marks that scored nothing because you had closed the number."),
        metric("highestRound", "Highest scoring round", highestRound, "integer"),
        metric("threeMark", "3-mark turns", threeMark, "integer"),
        metric("fourMark", "4-mark turns", fourMark, "integer"),
        metric("fiveMark", "5-mark turns", fiveMark, "integer"),
        metric("sixMark", "6-mark turns", sixMark, "integer"),
        metric("whiteHorses", "White horses", whiteHorses, "integer",
          "Three triples on three different numbers in one visit."),
        metric("hatTricks", "Hat tricks", hatTricks, "integer", "Three bulls in one visit."),
        metric("bulls", "Bulls hit", bulls, "integer"),
        metric("triples", "Triples hit", triples, "integer"),
        metric("doubles", "Doubles hit", doubles, "integer"),
        metric("singles", "Singles hit", singles, "integer"),
        metric("darts", "Darts thrown", darts, "integer"),
      ],
      raw: {
        legsPlayed, legsWon, rounds, darts, marks, points, pointsPrevented,
        mpr: ratio(marks, rounds), bestMpr: bestMatchMpr, highestRound,
        threeMark, fourMark, fiveMark, sixMark, whiteHorses, hatTricks,
        bulls, singles, doubles, triples,
        matches: perMatch.size,
      },
    };
  },

  boards: [
    {
      key: "cricket-mpr",
      label: "Marks per round",
      format: "decimal",
      minimum: { label: "50 rounds", test: (raw) => raw.rounds >= 50 },
      value: (raw) => raw.mpr,
    },
    { key: "cricket-white-horses", label: "Most white horses", format: "integer",
      value: (raw) => raw.whiteHorses },
    { key: "cricket-hat-tricks", label: "Most hat tricks", format: "integer",
      value: (raw) => raw.hatTricks },
    { key: "cricket-prevented", label: "Points prevented", format: "integer",
      value: (raw) => raw.pointsPrevented },
  ],

  achievements: [
    { code: "first-cricket-win", label: "Cricket opener", description: "Win a leg of Cricket.",
      test: (r) => r.legsWon >= 1 },
    { code: "white-horse", label: "White horse", description: "Three triples on three different numbers in one visit.",
      test: (r) => r.whiteHorses >= 1 },
    { code: "hat-trick", label: "Hat trick", description: "Three bulls in a single visit.",
      test: (r) => r.hatTricks >= 1 },
    { code: "mpr-three", label: "Three marks a round", description: "Hold an MPR of 3 over 50 rounds.",
      test: (r) => r.mpr >= 3 && r.rounds >= 50 },
    { code: "mpr-four", label: "Four marks a round", description: "Hold an MPR of 4 over 100 rounds.",
      test: (r) => r.mpr >= 4 && r.rounds >= 100 },
    { code: "gatekeeper", label: "Gatekeeper", description: "Deny opponents 500 points by closing first.",
      test: (r) => r.pointsPrevented >= 500 },
  ],
};

// Fallback for turns recorded before the per-visit payload existed, or by a
// build that didn't write one: the marks are still recoverable from the darts.
// A dart's multiplier IS its mark count on a Cricket number.
function marksFromThrows(turn) {
  let total = 0;
  for (const dart of turn.throws ?? []) {
    if (dart.section === "BULL" || TARGET_VALUE[dart.section] !== undefined) {
      total += dart.multiplier || 1;
    }
  }
  return total;
}
