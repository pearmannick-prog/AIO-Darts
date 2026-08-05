// leaderboard.js - ranking players against each other.
//
// A leaderboard here is a QUERY, not a pipeline. Every player's statistics are
// already computed and cached (see stats.js), and every board is a way of
// pulling one number out of that (see leaderboards() in statsengine.js). So
// ranking is: read the cached rows, extract the number, sort. There is no
// separate leaderboard table to keep in step, and adding a board adds nothing
// to maintain.
//
// TWO THINGS THIS DELIBERATELY IS NOT:
//
//   It is not authoritative. Scores are computed in the browser and uploaded;
//   a peer-to-peer app with no referee cannot prove a match happened. These are
//   self-reported figures, fine for a club board and worthless as a ranking
//   anyone could win money on. The UI says so rather than implying otherwise.
//
//   It is not opt-out. A player appears only if they have chosen to, on every
//   board including a friends board. One switch, one meaning - "show me on
//   leaderboards" is easier to reason about than a matrix of visibilities, and
//   it fails closed.

import { getDatabase } from "./db.js";
import { ApiError } from "./api-error.js";
import { statsFor } from "./stats.js";
import { leaderboardByKey, boardValueFor, ENGINE_VERSION } from "../statsengine.js";

// How many rows a board returns. Long enough to find yourself on a club board,
// short enough that nobody scrolls a global one.
const BOARD_SIZE = 50;

// How many out-of-date players a single board request will rebuild. See the
// healing pass in cachedStatsFor: this is the bound that keeps "the board fixes
// itself" from meaning "one page view recomputes a thousand histories".
const HEAL_PER_REQUEST = 5;

// Reads every cached statistics row for the given users. Players with no cache
// row are simply not ranked: the row is written whenever a match is uploaded or
// statistics are read, so the only people missing are those who have never
// played, who have nothing to rank anyway.
//
// Rows written by an older engine are skipped rather than trusted. They will be
// rebuilt the next time that player looks at their own statistics, and ranking
// someone by a formula that has since been corrected is worse than leaving them
// off for a day.
function cachedStatsFor(userIds) {
  if (!userIds.length) return [];

  const db = getDatabase();
  const placeholders = userIds.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT s.user_id, s.json, u.display_name, u.avatar_blob IS NOT NULL AS has_avatar
       FROM stats_cache s JOIN users u ON u.id = s.user_id
       WHERE s.user_id IN (${placeholders}) AND u.leaderboard_opt_in = 1`
    )
    .all(...userIds);

  const out = [];
  const stale = [];

  for (const row of rows) {
    const player = {
      userId: row.user_id,
      displayName: row.display_name,
      hasAvatar: Boolean(row.has_avatar),
    };
    try {
      const stats = JSON.parse(row.json);
      if (stats.engineVersion !== ENGINE_VERSION) {
        stale.push(player);
        continue;
      }
      out.push({ ...player, stats });
    } catch {
      // Derived data; a corrupt row is rebuilt rather than investigated.
      stale.push(player);
    }
  }

  // THE HEALING PASS. Skipping stale rows keeps a board from ranking anyone by
  // a formula that has since been corrected - but on its own it means that the
  // moment ENGINE_VERSION changes, every board empties and only refills as each
  // player happens to open their own statistics. Someone who plays but never
  // looks would never come back.
  //
  // So a few are rebuilt on each request. Bounded, because rebuilding is a full
  // read of that player's history and a board must not turn into a hundred of
  // them; over a handful of page views the board repopulates itself.
  for (const player of stale.slice(0, HEAL_PER_REQUEST)) {
    try {
      out.push({ ...player, stats: statsFor(player.userId) });
    } catch {
      // One player's statistics failing to rebuild must not fail the board.
    }
  }

  return out;
}

// The pool of players a board is drawn from.
//   global  - everyone who has opted in
//   friends - the viewer's accepted friends, plus the viewer
//   club    - a club's members
function poolFor(scope, { userId, friendIds, clubMemberIds }) {
  if (scope === "friends") return [...new Set([userId, ...friendIds])];
  if (scope === "club") return clubMemberIds;

  return getDatabase()
    .prepare("SELECT user_id FROM stats_cache")
    .all()
    .map((row) => row.user_id);
}

// A monthly board reads the month's trend bucket rather than the lifetime
// totals - which is exactly why the engine keeps raw per-bucket counts instead
// of pre-divided averages: a monthly average has to be computed from that
// month's darts, not averaged out of an average.
//
// Only the boards with a monthly equivalent are offered; "highest checkout ever"
// does not become a different question when scoped to a month, but the trend
// buckets do not carry it, so those boards stay all-time and say so.
const MONTHLY_VALUES = {
  "career-wins": (b) => b.won,
  "career-winpct": (b) => b.winPct,
  "x01-average": (b) => b.threeDartAverage,
  "x01-checkout": (b) => b.checkoutPct,
  "x01-180s": (b) => b.oneEighties,
  "cricket-mpr": (b) => b.mpr,
};

const MONTHLY_MINIMUMS = {
  "career-winpct": (b) => b.played >= 5,
  "x01-average": (b) => b.x01Darts >= 100,
  "x01-checkout": (b) => b.checkoutChances >= 15,
  "cricket-mpr": (b) => b.cricketRounds >= 15,
};

export function supportsMonthly(boardKey) {
  return Object.hasOwn(MONTHLY_VALUES, boardKey);
}

function monthKey(date = new Date()) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function buildLeaderboard({
  boardKey, scope = "global", window = "all",
  userId, friendIds = [], clubMemberIds = [],
}) {
  const board = leaderboardByKey(boardKey);
  if (!board) throw new ApiError(404, "No such leaderboard.");

  const monthly = window === "month";
  if (monthly && !supportsMonthly(boardKey)) {
    throw new ApiError(400, "That board is all-time only.");
  }

  const pool = poolFor(scope, { userId, friendIds, clubMemberIds });
  const entries = [];
  const month = monthKey();

  for (const player of cachedStatsFor(pool)) {
    let value = null;

    if (monthly) {
      const bucket = player.stats.trends?.monthly?.find((b) => b.key === month);
      const qualifies = MONTHLY_MINIMUMS[boardKey];
      if (bucket && (!qualifies || qualifies(bucket))) {
        const raw = MONTHLY_VALUES[boardKey](bucket);
        value = Number.isFinite(raw) ? raw : null;
      }
    } else {
      value = boardValueFor(board, player.stats);
    }

    // Null means "not ranked" - hasn't played that game, or hasn't met the
    // qualification. Zero is a real score and stays.
    if (value === null) continue;
    entries.push({
      userId: player.userId,
      displayName: player.displayName,
      hasAvatar: player.hasAvatar,
      value,
    });
  }

  // Every board here is "higher is better". A board where lower wins (fewest
  // darts in a leg) would need a direction flag - there isn't one yet, and
  // adding it before there is a board that needs it would be guessing.
  entries.sort((a, b) => b.value - a.value || a.displayName.localeCompare(b.displayName));

  // Ranks share a number on a tie, and the next rank skips - standard
  // competition ranking, so two players on 100% are both first and nobody is
  // second.
  let lastValue = null;
  let lastRank = 0;
  entries.forEach((entry, index) => {
    if (entry.value !== lastValue) {
      lastRank = index + 1;
      lastValue = entry.value;
    }
    entry.rank = lastRank;
  });

  const you = entries.find((e) => e.userId === userId) || null;

  return {
    board: {
      key: board.key,
      label: board.label,
      group: board.group,
      format: board.format,
      minimum: board.minimum?.label ?? null,
      monthly,
    },
    scope,
    window: monthly ? month : "all",
    entries: entries.slice(0, BOARD_SIZE),
    // Sent separately so someone outside the top fifty can still see where they
    // stand, which is the only reason most people open a leaderboard twice.
    you,
    ranked: entries.length,
  };
}
