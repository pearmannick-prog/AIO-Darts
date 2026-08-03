// rating.js - the 1-20 rating scale and its letter ranks.
//
// A DARTSLIVE-style table: a player's three-dart average in x01 ("01 PPR",
// points per round) and their marks per round in Cricket ("CR MPR") each map to
// a rating from 1 to 20, and each rating belongs to a lettered rank from C up
// to GM.
//
// Pure and shared, like the rest of the statistics layer, so the browser and
// the server agree about what somebody's rank is. Both inputs are numbers the
// engine already derives from stored darts - threeDart and mpr - so this adds a
// lookup, not a new thing to record. It therefore applies retroactively to
// every match ever played.
//
// THE TABLE IS DATA, NOT LOGIC. Every threshold lives in one array. Adjusting
// the scale, or swapping in a different one, is an edit to that array and
// nothing else.

// Each row is the FLOOR of its band: rating 19 is 137.00 up to but not
// including 142.00, which is where 20 begins. Written as floors rather than
// ranges because a range has two numbers that can disagree with the next row,
// and this way a gap or an overlap is impossible to write.
//
// The top row has no ceiling ("142.00-" in the table) and the bottom row starts
// at zero, so every possible value lands somewhere.
export const RATING_TABLE = [
  { rating: 20, rank: "GM", ppr: 142.00, mpr: 5.70 },
  { rating: 19, rank: "M",  ppr: 137.00, mpr: 5.40 },
  { rating: 18, rank: "M",  ppr: 132.00, mpr: 5.10 },
  { rating: 17, rank: "SS", ppr: 127.00, mpr: 4.80 },
  { rating: 16, rank: "SS", ppr: 122.00, mpr: 4.50 },
  { rating: 15, rank: "S",  ppr: 116.00, mpr: 4.25 },
  { rating: 14, rank: "S",  ppr: 110.00, mpr: 4.00 },
  { rating: 13, rank: "AA", ppr: 103.00, mpr: 3.75 },
  { rating: 12, rank: "AA", ppr: 96.00,  mpr: 3.50 },
  { rating: 11, rank: "A",  ppr: 89.00,  mpr: 3.25 },
  { rating: 10, rank: "A",  ppr: 82.00,  mpr: 3.00 },
  { rating: 9,  rank: "BB", ppr: 75.50,  mpr: 2.70 },
  { rating: 8,  rank: "BB", ppr: 69.50,  mpr: 2.45 },
  { rating: 7,  rank: "B",  ppr: 63.00,  mpr: 2.20 },
  { rating: 6,  rank: "B",  ppr: 57.00,  mpr: 2.00 },
  { rating: 5,  rank: "CC", ppr: 51.00,  mpr: 1.80 },
  { rating: 4,  rank: "CC", ppr: 45.00,  mpr: 1.60 },
  { rating: 3,  rank: "C",  ppr: 40.00,  mpr: 1.40 },
  { rating: 2,  rank: "C",  ppr: 35.00,  mpr: 1.20 },
  { rating: 1,  rank: "C",  ppr: 0,      mpr: 0 },
];

// The colours from the rank table, for badges. A rank is ALWAYS shown with its
// letters as well - the colour is decoration, never the thing that says which
// rank it is, because several of these pairs are indistinguishable to a
// colour-blind reader and all of them are on a printed page.
export const RANK_COLOURS = Object.freeze({
  GM: "#C7A24A",
  M:  "#9AA0A6",
  SS: "#7FD4E8",
  S:  "#3FA9D6",
  AA: "#E8447A",
  A:  "#F06292",
  BB: "#35C46A",
  B:  "#2FA355",
  CC: "#3FB6D6",
  C:  "#4A90D9",
});

// How many matches before a rating means anything. A three-dart average over
// one leg is noise, and a rank badge implies a settled standard rather than a
// lucky night - so below this the rating is reported as null and the UI says
// "unranked" instead of awarding somebody GM for a single good visit.
export const RANKED_MINIMUM_LEGS = 10;

function lookup(value, key) {
  if (!Number.isFinite(value) || value < 0) return null;
  // Highest row whose floor the value reaches. The table is ordered high to
  // low, so the first match is the answer.
  return RATING_TABLE.find((row) => value >= row[key]) ?? RATING_TABLE[RATING_TABLE.length - 1];
}

// x01 three-dart average -> a row of the table.
export function ratingForPpr(ppr) {
  return lookup(ppr, "ppr");
}

// Cricket marks per round -> a row of the table.
export function ratingForMpr(mpr) {
  return lookup(mpr, "mpr");
}

export function rankForRating(rating) {
  const row = RATING_TABLE.find((r) => r.rating === Math.round(rating));
  return row?.rank ?? "C";
}

// The combined rating, which is what a player thinks of as "my rating".
//
// The average of the two, which is the DARTSLIVE convention - somebody strong
// at 01 and weak at Cricket sits between the two rather than being flattered by
// their best game. A player who has only played one of the two is rated on that
// one alone rather than being halved for not having played the other.
//
// Isolated in its own function precisely because it is the one part of this
// that is a judgement rather than a number read off the table: changing it to
// "the higher of the two", or to a weighted blend, is a change here and nowhere
// else.
export function combineRatings(ratingX01, ratingCricket) {
  const parts = [ratingX01, ratingCricket].filter((r) => Number.isFinite(r));
  if (!parts.length) return null;
  const mean = parts.reduce((sum, r) => sum + r, 0) / parts.length;
  // Rounded down: a rating is a floor you have reached, not one you are near.
  return Math.max(1, Math.floor(mean));
}

// Everything the UI needs about one player's standing, from the two averages.
// Returns nulls rather than a rank when there is not enough play to justify
// one - see RANKED_MINIMUM_LEGS.
export function ratingFrom({ threeDart = null, mpr = null, x01Legs = 0, cricketLegs = 0 } = {}) {
  const x01Ranked = x01Legs >= RANKED_MINIMUM_LEGS && Number.isFinite(threeDart) && threeDart > 0;
  const cricketRanked = cricketLegs >= RANKED_MINIMUM_LEGS && Number.isFinite(mpr) && mpr > 0;

  const x01Row = x01Ranked ? ratingForPpr(threeDart) : null;
  const cricketRow = cricketRanked ? ratingForMpr(mpr) : null;
  const overall = combineRatings(x01Row?.rating ?? null, cricketRow?.rating ?? null);

  return {
    // Null means unranked, which is different from rating 1.
    rating: overall,
    rank: overall === null ? null : rankForRating(overall),
    x01: x01Row ? { rating: x01Row.rating, rank: x01Row.rank, ppr: threeDart } : null,
    cricket: cricketRow ? { rating: cricketRow.rating, rank: cricketRow.rank, mpr } : null,
    // What is still needed to be ranked, so the UI can say so rather than
    // showing a blank badge with no explanation.
    needs: {
      x01Legs: Math.max(0, RANKED_MINIMUM_LEGS - x01Legs),
      cricketLegs: Math.max(0, RANKED_MINIMUM_LEGS - cricketLegs),
    },
  };
}
