// statsengine.js - statistics derived from recorded darts.
//
// Pure and side-effect-free, like scoring.js and cricket.js, and imported by
// BOTH the browser and the server. That is the whole point: the stats page a
// guest sees computed locally from their queued matches, and the ones the
// server computes for the dashboard, come from the same function. Two
// implementations would disagree eventually, and the disagreement would be
// invisible until someone noticed their average changed when they signed in.
//
// STATISTICS ARE MODULAR BY GAME. This file knows about matches, legs, turns,
// darts, wins and time. It does not know what MPR is, or what a 180 is. Each
// game contributes a module (stats/x01stats.js, stats/cricketstats.js, ...)
// that declares its own metrics and computes them from the legs of that game.
//
// Adding Around the Clock or Killer later therefore means writing its rules
// module and a stats module beside it, and registering it below. No schema
// change, no change to this file, no migration, and the stats page grows a new
// section on its own because the UI renders whatever the registry contains.
//
// Every module receives the same thing - a list of "leg contexts" - and returns
// the same thing: a list of metrics plus whatever raw totals it wants to expose
// for achievements and leaderboards to read.

import { highestCheckout } from "./scoring.js";
import { ratingFrom, RANKED_MINIMUM_LEGS } from "./rating.js";

// How much real play before practice figures are worth comparing against. The
// same bar as being ranked - reusing it rather than inventing a second number
// keeps "established" meaning one thing in this app.
const PRACTICE_COMPARISON_LEGS = RANKED_MINIMUM_LEGS;
import { x01Stats } from "./stats/x01stats.js";
import { cricketStats } from "./stats/cricketstats.js";
import { countupStats } from "./stats/countupstats.js";
import { bermudaStats } from "./stats/bermudastats.js";

// The registry. Order is display order on the stats page.
const modules = [x01Stats, cricketStats, countupStats, bermudaStats];

// Bumped whenever a definition here or in a game module changes what a number
// MEANS - a new metric, a corrected formula, a different threshold. The server
// stamps it into the cached statistics and treats a mismatch as a cache miss,
// so a logic fix reprices everyone's history on their next request instead of
// leaving them looking at numbers computed by code that no longer exists.
//
// 2: the checkout ceiling and the doubles denominator now follow each leg's
//    out rule rather than assuming double out, so 180 counts as a checkout
//    under master and single out.
// 3: adds the 1-20 rating and its letter rank.
// 4: splits both averages into 80% (the scoring phase) and 100% (the whole
//    game), and points the rating at the 80% figures, which is what the rank
//    table is actually built on.
// 5: adds the Bermuda Triangle module.
// 6: reports the rank against BOTH the 80% and 100% figures. Same table, two
//    lookups - the thresholds are identical, only the averages differ.
// 7: practice matches - those against a computer opponent - are excluded from
//    the real statistics and reported separately.
export const ENGINE_VERSION = 7;

export function registerGameModule(module) {
  if (!modules.some((m) => m.key === module.key)) modules.push(module);
}

export function gameModules() {
  return modules.slice();
}

// ---------------------------------------------------------------------------
// Metric helpers, shared by the modules
// ---------------------------------------------------------------------------
// A metric is a value plus enough information for the UI to render it without
// knowing what it means. `format` is the only thing the page branches on, so a
// new metric never needs a UI change.
export function metric(key, label, value, format = "number", hint = null) {
  return { key, label, value, format, hint };
}

export function ratio(numerator, denominator, digits = 2) {
  if (!denominator) return 0;
  return Number((numerator / denominator).toFixed(digits));
}

export function percent(part, whole) {
  if (!whole) return 0;
  return Number(((part / whole) * 100).toFixed(1));
}

// ---------------------------------------------------------------------------
// Reshaping matches into what the modules want
// ---------------------------------------------------------------------------
// Which seat is the person these statistics are about. A match always records
// it; falling back to seat 0 keeps a match from an older build readable rather
// than dropping it.
export function selfSeat(match) {
  const self = match.players?.find((p) => p.isSelf);
  return self ? self.seat : 0;
}

// One entry per leg of one game, carrying everything a module could want: the
// leg itself, the match it belongs to, which seat is "me", and the turns split
// into mine and the opponents'. Splitting here rather than in every module is
// the difference between a module being twenty lines and being sixty.
function legContexts(matches) {
  const byGame = new Map();

  for (const match of matches) {
    const seat = selfSeat(match);
    for (const leg of match.legs ?? []) {
      const turns = leg.turns ?? [];
      const context = {
        match,
        leg,
        seat,
        turns: turns.filter((t) => t.seat === seat),
        opponentTurns: turns.filter((t) => t.seat !== seat),
        won: leg.winnerSeat === seat,
      };
      if (!byGame.has(leg.game)) byGame.set(leg.game, []);
      byGame.get(leg.game).push(context);
    }
  }

  return byGame;
}

// Every dart the given turns contain, flattened. Quick-total visits are
// excluded by default: their single "throw" stands for three darts nobody
// recorded, so counting it as a dart would put a 140 in the histogram of
// individual scores and claim a segment was hit that never was.
export function dartsOf(turns, { includeQuick = false } = {}) {
  const out = [];
  for (const turn of turns) {
    if (turn.entry === "quick" && !includeQuick) continue;
    for (const dart of turn.throws ?? []) out.push({ ...dart, turn });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Career statistics
// ---------------------------------------------------------------------------
// The things that are true across every game: how much you have played, how
// often you win, and what you actually play. Anything that needs to know what a
// dart was worth belongs in a game module instead.
function careerStats(matches) {
  const played = matches.length;
  let won = 0;
  let drawn = 0;
  let darts = 0;
  let ms = 0;
  const legsByGame = new Map();

  for (const match of matches) {
    const seat = selfSeat(match);
    if (match.drawn) drawn += 1;
    else if (match.winnerSeat === seat) won += 1;

    ms += match.durationMs || 0;

    for (const leg of match.legs ?? []) {
      legsByGame.set(leg.game, (legsByGame.get(leg.game) || 0) + 1);
      for (const turn of leg.turns ?? []) {
        if (turn.seat === seat) darts += turn.darts || 0;
      }
    }
  }

  let favourite = null;
  let mostLegs = 0;
  for (const [game, count] of legsByGame) {
    if (count > mostLegs) {
      mostLegs = count;
      favourite = game;
    }
  }

  const streaks = winStreaks(matches);

  return {
    metrics: [
      metric("played", "Matches played", played, "integer"),
      metric("won", "Matches won", won, "integer"),
      metric("winPct", "Win percentage", percent(won, played), "percent"),
      metric("currentStreak", "Current win streak", streaks.current, "integer"),
      metric("longestStreak", "Longest win streak", streaks.longest, "integer"),
      metric("darts", "Total darts thrown", darts, "integer"),
      metric("hours", "Hours played", ratio(ms, 3600_000, 1), "decimal"),
      metric("favourite", "Favourite game", favourite ? gameLabelFor(favourite) : "—", "text"),
    ],
    raw: { played, won, drawn, darts, durationMs: ms, favourite, ...streaks },
  };
}

// Streaks are counted in match order, oldest first. A draw breaks a streak
// without being a loss - it is not a win, and calling it one would be generous
// in a way the number is supposed to guard against.
function winStreaks(matches) {
  const ordered = [...matches].sort((a, b) => String(a.endedAt).localeCompare(String(b.endedAt)));
  let longest = 0;
  let running = 0;
  let current = 0;

  for (const match of ordered) {
    const isWin = !match.drawn && match.winnerSeat === selfSeat(match);
    running = isWin ? running + 1 : 0;
    longest = Math.max(longest, running);
    current = running;
  }

  return { longest, current };
}

// The registry is also the naming authority, so a game's label lives in exactly
// one place - its module.
export function gameLabelFor(key) {
  return modules.find((m) => m.key === key)?.label || key;
}

// ---------------------------------------------------------------------------
// Trends
// ---------------------------------------------------------------------------
// Statistics over time rather than in total. Bucketed by day, week and month;
// the UI picks which one to draw based on how much history there is, because a
// weekly chart of three days looks broken and a daily chart of three years is
// unreadable.
//
// Each bucket carries the raw totals rather than pre-divided averages, so a
// chart can re-aggregate several buckets (a monthly view from weekly data)
// without the error that averaging averages introduces.
function bucketKey(iso, grain) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;

  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");

  if (grain === "month") return `${year}-${month}`;
  if (grain === "day") return `${year}-${month}-${day}`;

  // ISO-ish week: the Monday of that date's week, which makes the key sortable
  // as a string and readable as a date, unlike a week number.
  const monday = new Date(Date.UTC(year, date.getUTCMonth(), date.getUTCDate()));
  const weekday = (monday.getUTCDay() + 6) % 7; // Monday = 0
  monday.setUTCDate(monday.getUTCDate() - weekday);
  return monday.toISOString().slice(0, 10);
}

function trendBuckets(matches, grain) {
  const buckets = new Map();

  for (const match of matches) {
    const key = bucketKey(match.endedAt, grain);
    if (!key) continue;

    if (!buckets.has(key)) {
      buckets.set(key, {
        key,
        played: 0, won: 0,
        x01Scored: 0, x01Darts: 0,
        checkouts: 0, checkoutChances: 0,
        cricketMarks: 0, cricketRounds: 0,
        oneEighties: 0,
      });
    }

    const bucket = buckets.get(key);
    const seat = selfSeat(match);
    bucket.played += 1;
    if (!match.drawn && match.winnerSeat === seat) bucket.won += 1;

    for (const leg of match.legs ?? []) {
      for (const turn of leg.turns ?? []) {
        if (turn.seat !== seat) continue;

        if (leg.game === "x01") {
          bucket.x01Scored += turn.scored || 0;
          bucket.x01Darts += turn.darts || 0;
          if ((turn.scored || 0) === 180) bucket.oneEighties += 1;
          // Same definition as the checkout percentage in x01stats.js - see
          // the long comment there about why it is visit-based - including the
          // ceiling following the leg's out rule rather than assuming 170.
          if (turn.remainingBefore !== null
              && turn.remainingBefore <= highestCheckout(leg.rules || "double")) {
            bucket.checkoutChances += 1;
            if (turn.isCheckout) bucket.checkouts += 1;
          }
        }

        if (leg.game === "cricket") {
          bucket.cricketMarks += turn.game?.marks || 0;
          bucket.cricketRounds += 1;
        }
      }
    }
  }

  return [...buckets.values()]
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((b) => ({
      ...b,
      winPct: percent(b.won, b.played),
      threeDartAverage: ratio(b.x01Scored * 3, b.x01Darts),
      checkoutPct: percent(b.checkouts, b.checkoutChances),
      mpr: ratio(b.cricketMarks, b.cricketRounds),
    }));
}

// "Most improved" compares the first and last thirds of the history, not the
// first and last match - one exceptional night should not be able to declare
// itself a trend. Returns null until there is enough to compare, rather than a
// number computed from three matches.
function mostImproved(weekly) {
  if (weekly.length < 6) return null;

  const third = Math.max(1, Math.floor(weekly.length / 3));
  const early = weekly.slice(0, third);
  const late = weekly.slice(-third);

  const candidates = [
    { key: "threeDartAverage", label: "3-dart average", digits: 2 },
    { key: "checkoutPct", label: "Checkout %", digits: 1 },
    { key: "mpr", label: "Marks per round", digits: 2 },
    { key: "winPct", label: "Win rate", digits: 1 },
  ];

  let best = null;
  for (const candidate of candidates) {
    const before = average(early.map((b) => b[candidate.key]).filter((v) => v > 0));
    const after = average(late.map((b) => b[candidate.key]).filter((v) => v > 0));
    if (!before || !after) continue;

    const change = after - before;
    const relative = change / before;
    if (change > 0 && (!best || relative > best.relative)) {
      best = {
        key: candidate.key,
        label: candidate.label,
        from: Number(before.toFixed(candidate.digits)),
        to: Number(after.toFixed(candidate.digits)),
        change: Number(change.toFixed(candidate.digits)),
        relative,
      };
    }
  }

  return best;
}

function average(values) {
  if (!values.length) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

// ---------------------------------------------------------------------------
// Leaderboards
// ---------------------------------------------------------------------------
// A board is a way of pulling one number out of a player's statistics, plus the
// qualification needed to be ranked on it. Career boards are here; each game
// declares its own, so a new game mode brings its boards with it.
//
// The definitions live in the shared engine rather than in the server because
// they are statements about what the numbers mean, and that is exactly the kind
// of thing that drifts when it is written twice.
export const CAREER_BOARDS = [
  {
    key: "career-rating",
    label: "Rating",
    format: "integer",
    // Already gated: ratingFrom returns null until there is enough play, and a
    // null value is "not ranked" rather than a score of zero. So the board
    // needs no qualification of its own - the rating IS the qualification.
    value: (raw) => raw.rating,
  },
  { key: "career-wins", label: "Most wins", format: "integer",
    value: (raw) => raw.won },
  { key: "career-streak", label: "Longest win streak", format: "integer",
    value: (raw) => raw.longest },
  {
    key: "career-winpct",
    label: "Win percentage",
    format: "percent",
    // Without this, the top of the board is whoever won their only match.
    minimum: { label: "20 matches", test: (raw) => raw.played >= 20 },
    value: (raw) => (raw.played ? Number(((raw.won / raw.played) * 100).toFixed(1)) : 0),
  },
  { key: "career-darts", label: "Most darts thrown", format: "integer",
    value: (raw) => raw.darts },
];

// Every board that exists, in display order, each knowing which slice of the
// statistics it reads: "career" or a game key.
export function leaderboards() {
  const boards = CAREER_BOARDS.map((b) => ({ ...b, scope: "career", group: "Career" }));
  for (const module of modules) {
    for (const board of module.boards ?? []) {
      boards.push({ ...board, scope: module.key, group: module.label });
    }
  }
  return boards;
}

export function leaderboardByKey(key) {
  return leaderboards().find((b) => b.key === key) || null;
}

// The catalogue as the browser needs it - labels and qualifications, without
// the functions, which would not survive being sent as JSON.
export function leaderboardCatalogue() {
  return leaderboards().map((b) => ({
    key: b.key,
    label: b.label,
    group: b.group,
    format: b.format,
    minimum: b.minimum?.label ?? null,
  }));
}

// Pulls a board's value out of one player's computed statistics, or null when
// they have not played that game or have not met the qualification. Null means
// "not ranked", which is different from a score of zero.
export function boardValueFor(board, stats) {
  const raw = board.scope === "career"
    ? stats?.career?.raw
    : stats?.games?.find((g) => g.key === board.scope)?.raw;

  if (!raw) return null;
  if (board.minimum && !board.minimum.test(raw)) return null;

  const value = board.value(raw);
  return Number.isFinite(value) ? value : null;
}

// ---------------------------------------------------------------------------
// Achievements
// ---------------------------------------------------------------------------
// The ones that belong to no particular game. Game-specific achievements are
// declared by their own module - "First 180" lives in x01stats.js, "White
// horse" in cricketstats.js - so a new game brings its own and nothing here
// needs to know about it.
//
// Every achievement is a TEST OVER TOTALS, not an event caught as it happens.
// That is deliberate: adding a new achievement awards it retroactively to
// everyone who already qualified, because it is recomputed from the darts
// rather than latched at the moment it occurred. Nobody has to replay anything.
export const CAREER_ACHIEVEMENTS = [
  { code: "first-win", label: "First win", description: "Win your first match.",
    test: (r) => r.won >= 1 },
  { code: "ten-wins", label: "Ten wins", description: "Win ten matches.",
    test: (r) => r.won >= 10 },
  { code: "hundred-wins", label: "Century of wins", description: "Win a hundred matches.",
    test: (r) => r.won >= 100 },
  { code: "streak-five", label: "On a run", description: "Win five matches in a row.",
    test: (r) => r.longest >= 5 },
  { code: "streak-ten", label: "Unstoppable", description: "Win ten matches in a row.",
    test: (r) => r.longest >= 10 },
  { code: "thousand-darts", label: "A thousand darts", description: "Throw a thousand darts.",
    test: (r) => r.darts >= 1000 },
  { code: "ten-hours", label: "Ten hours at the oche", description: "Play for ten hours.",
    test: (r) => r.durationMs >= 10 * 3600_000 },
];

// Which achievements the given statistics qualify for, right now. The caller
// compares this with what has already been awarded - this function has no idea
// what is new, only what is true.
export function evaluateAchievements(stats) {
  const earned = [];

  for (const achievement of CAREER_ACHIEVEMENTS) {
    if (achievement.test(stats.career.raw)) {
      earned.push({ ...achievement, game: "career", gameLabel: "Career" });
    }
  }

  for (const game of stats.games) {
    const module = modules.find((m) => m.key === game.key);
    for (const achievement of module?.achievements ?? []) {
      if (achievement.test(game.raw)) {
        earned.push({ ...achievement, game: game.key, gameLabel: game.label });
      }
    }
  }

  return earned;
}

// Every achievement that exists, earned or not - so the UI can show what there
// is to aim at rather than only what has already been done.
export function allAchievements() {
  const all = CAREER_ACHIEVEMENTS.map((a) => ({ ...a, game: "career", gameLabel: "Career" }));
  for (const module of modules) {
    for (const achievement of module.achievements ?? []) {
      all.push({ ...achievement, game: module.key, gameLabel: module.label });
    }
  }
  // `test` is a function and would not survive being sent as JSON; the caller
  // wants the description, not the rule.
  return all.map(({ test, ...rest }) => rest);
}

// ---------------------------------------------------------------------------
// The entry point
// ---------------------------------------------------------------------------
// Takes full match documents - the shape matchrecorder.js produces and
// server/matches.js reads back - and returns everything the dashboard, stats
// page and leaderboards need.
// A match against a computer is practice. The darts are real darts, but the
// record is not a record of playing anybody - so it is kept out of the figures
// that describe you as a player, and reported on its own.
//
// The split is here, in the engine, rather than in a database query: it is a
// statement about what a statistic MEANS, and every caller - the server, a
// guest's browser computing from the local queue - has to agree about it.
function isPractice(match) {
  return match.mode === "practice";
}

export function computeStats(matches = [], { practiceDepth = 0 } = {}) {
  // `practiceDepth` guards the one recursive call below. Practice statistics
  // are the same engine run over the other pile of matches, and without this a
  // practice block would try to compute its own practice block forever.
  const real = practiceDepth ? matches : matches.filter((m) => !isPractice(m));

  const contexts = legContexts(real);
  const career = careerStats(real);

  const games = [];
  for (const module of modules) {
    const legs = contexts.get(module.key) ?? [];
    // A game nobody has played is left out entirely rather than shown as a
    // wall of zeroes - the stats page should describe what you do, not what
    // the app supports.
    if (!legs.length) continue;
    games.push({
      key: module.key,
      label: module.label,
      ...module.lifetime(legs),
    });
  }

  const weekly = trendBuckets(real, "week");

  // The rating reads two game modules' figures, so it is assembled here rather
  // than inside either of them - neither can see the other, by design.
  const x01 = games.find((g) => g.key === "x01")?.raw;
  const cricket = games.find((g) => g.key === "cricket")?.raw;
  // The 80% figures, NOT the whole-game ones. The rank table is built on the
  // pure scoring phase - visits with 100 or more left in x01, rounds before the
  // bull is closed in Cricket - so feeding it the full-game average, which is
  // dragged down by setup shots and missed doubles, would under-rate everybody
  // by a band or two.
  const rating = ratingFrom({
    ppr: x01?.ppr80 ?? null,
    mpr: cricket?.mpr80 ?? null,
    ppr100: x01?.threeDart ?? null,
    mpr100: cricket?.mpr ?? null,
    x01Legs: x01?.legsPlayed ?? 0,
    cricketLegs: cricket?.legsPlayed ?? 0,
  });

  // Also folded into the career totals, so a leaderboard - which reads a board
  // definition against one slice of the statistics - can rank on it without
  // needing to know rating is assembled separately.
  career.raw.rating = rating.rating;
  career.raw.rank = rating.rank;
  // Named so a reader of the cached JSON can tell which pile it came from.
  career.raw.practice = Boolean(practiceDepth);

  return {
    engineVersion: ENGINE_VERSION,
    rating,
    generatedAt: new Date().toISOString(),
    // `real`, not `matches` - practice is excluded from every figure here, and
    // a count that included it would be the one number quietly disagreeing
    // with all the others.
    matchesCounted: real.length,
    career,
    games,
    trends: {
      daily: trendBuckets(real, "day"),
      weekly,
      monthly: trendBuckets(real, "month"),
      mostImproved: mostImproved(weekly),
    },
    // Practice, computed by the same engine over the other pile, so the two are
    // directly comparable - the whole point is to read one against the other.
    //
    // Only surfaced once there is a real standard to compare against. A
    // practice average on its own says nothing; a practice average beside a
    // rated one says whether the practice is working. `established` is the same
    // bar as being ranked, rather than a second invented threshold.
    practice: practiceDepth ? null : practiceStats(matches),
  };
}

function practiceStats(matches) {
  const practice = matches.filter(isPractice);
  if (!practice.length) return null;

  const stats = computeStats(practice, { practiceDepth: 1 });
  const realLegs = matches.filter((m) => !isPractice(m))
    .reduce((sum, m) => sum + (m.legs?.length ?? 0), 0);

  return {
    matchesCounted: practice.length,
    // Below this, the numbers are shown but not compared - there is nothing
    // meaningful to compare them WITH.
    established: realLegs >= PRACTICE_COMPARISON_LEGS,
    legsNeeded: Math.max(0, PRACTICE_COMPARISON_LEGS - realLegs),
    career: stats.career,
    games: stats.games,
    rating: stats.rating,
  };
}

// A single match's summary, used by the history detail view and by achievement
// checks that only care about the match just played.
export function computeMatchStats(match) {
  const seat = selfSeat(match);
  const out = {};

  for (const module of modules) {
    const legs = (match.legs ?? [])
      .filter((leg) => leg.game === module.key)
      .map((leg) => ({
        match,
        leg,
        seat,
        turns: (leg.turns ?? []).filter((t) => t.seat === seat),
        opponentTurns: (leg.turns ?? []).filter((t) => t.seat !== seat),
        won: leg.winnerSeat === seat,
      }));
    if (legs.length) out[module.key] = module.lifetime(legs);
  }

  return out;
}
