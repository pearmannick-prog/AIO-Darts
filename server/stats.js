// stats.js - the server's side of statistics: load, compute, cache.
//
// The computing itself is NOT here. It is in ../statsengine.js, which the
// browser imports too, so that a guest's locally-computed statistics and a
// signed-in user's server-computed ones are the same numbers from the same
// code. This file only deals with the parts a browser has no equivalent of:
// reading a whole history out of SQLite, and not doing that on every request.

import { getDatabase } from "./db.js";
import { loadAllMatches } from "./matches.js";
import {
  computeStats, evaluateAchievements, allAchievements, ENGINE_VERSION,
} from "../statsengine.js";

// The cache is a plain row holding the engine's output. It is invalidated by
// deleting it, which insertMatch() does on every upload, so the only way to
// read a stale number is to have a bug that forgets to delete - not to have a
// timer that hasn't fired yet. There is deliberately no TTL: statistics change
// when a match is added and at no other time.
export function statsFor(userId) {
  const db = getDatabase();

  const cached = db.prepare("SELECT * FROM stats_cache WHERE user_id = ?").get(userId);
  if (cached) {
    try {
      const parsed = JSON.parse(cached.json);
      // Written by an older version of the engine means written by different
      // rules. Deployed code and cached numbers disagreeing is the one way this
      // cache can be actively wrong rather than merely stale, so the stamp is
      // checked rather than trusted.
      if (parsed.engineVersion === ENGINE_VERSION) return parsed;
    } catch {
      // A corrupt cache row is not worth investigating - it is derived data.
      // Fall through and rebuild it.
    }
  }

  const matches = loadAllMatches(userId);
  const stats = computeStats(matches);

  db.prepare(
    `INSERT INTO stats_cache (user_id, matches_counted, json, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       matches_counted = excluded.matches_counted,
       json = excluded.json,
       updated_at = excluded.updated_at`
  ).run(userId, matches.length, JSON.stringify(stats), new Date().toISOString());

  return stats;
}

// What one player may see about another: enough to decide whether to challenge
// them, and nothing else.
//
// Gated on the same opt-in as the leaderboards. One switch with one meaning is
// easier to reason about than a matrix of visibilities, and it fails closed - a
// player who has not opted in has a name and nothing more, which is exactly
// what they asked for.
export function publicProfileFor(viewerId, userId) {
  const db = getDatabase();
  const row = db
    .prepare("SELECT id, display_name, created_at, avatar_blob IS NOT NULL AS has_avatar, leaderboard_opt_in FROM users WHERE id = ?")
    .get(userId);
  if (!row) return null;

  const profile = {
    userId: row.id,
    displayName: row.display_name,
    hasAvatar: Boolean(row.has_avatar),
    joinedAt: row.created_at,
    shared: Boolean(row.leaderboard_opt_in),
    headline: [],
    achievements: 0,
  };

  // Your own card always shows your own figures, opt-in or not - the setting is
  // about what OTHER people see.
  if (!profile.shared && viewerId !== userId) return profile;

  const stats = statsFor(userId);
  const pick = (metrics, key) => metrics.find((m) => m.key === key) ?? null;
  const x01 = stats.games.find((g) => g.key === "x01");
  const cricket = stats.games.find((g) => g.key === "cricket");

  profile.headline = [
    pick(stats.career.metrics, "played"),
    pick(stats.career.metrics, "winPct"),
    x01 ? pick(x01.metrics, "threeDart") : null,
    x01 ? pick(x01.metrics, "highestCheckout") : null,
    cricket ? pick(cricket.metrics, "mpr") : null,
  ].filter(Boolean);

  // The rank is the headline of a player card - it is the thing someone reads
  // before deciding whether to challenge - so it goes out with the profile.
  profile.rating = stats.rating;

  profile.achievements = db
    .prepare("SELECT COUNT(*) AS n FROM achievements WHERE user_id = ?")
    .get(userId).n;

  return profile;
}

export function invalidateStats(userId) {
  getDatabase().prepare("DELETE FROM stats_cache WHERE user_id = ?").run(userId);
}

// ---------------------------------------------------------------------------
// Achievements
// ---------------------------------------------------------------------------
// Run after a match is stored. Awards anything newly qualified for and returns
// only what is new, so the client can say "you just did that" rather than
// re-announcing everything.
//
// This recomputes the statistics, which is the one place that cost is paid on
// write rather than on read. It is worth it: an achievement has to be attached
// to the match that earned it, and "the match you were looking at when you next
// opened the dashboard" is not that. It also leaves the cache warm for the
// dashboard the player is about to see.
export function awardAchievements(userId, matchId) {
  const db = getDatabase();
  const stats = statsFor(userId);
  const earned = evaluateAchievements(stats);

  const existing = new Set(
    db.prepare("SELECT code FROM achievements WHERE user_id = ?").all(userId).map((r) => r.code)
  );

  const insert = db.prepare(
    `INSERT INTO achievements (user_id, code, game, earned_at, match_id)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id, code) DO NOTHING`
  );

  const now = new Date().toISOString();
  const fresh = [];

  for (const achievement of earned) {
    if (existing.has(achievement.code)) continue;
    insert.run(userId, achievement.code, achievement.game, now, matchId ?? null);
    fresh.push({
      code: achievement.code,
      label: achievement.label,
      description: achievement.description,
      game: achievement.game,
      gameLabel: achievement.gameLabel,
      earnedAt: now,
    });
  }

  return fresh;
}

// Everything there is to earn, with the earned ones marked. Locked achievements
// are shown too - a list of what you have done is a trophy cabinet, and a list
// of what there is to do is something to aim at.
export function achievementsFor(userId) {
  // Catch up before reading. Awarding only on upload would mean an achievement
  // added to the code today is never granted to the people who already earned
  // it - they would have to play another match to be told about something they
  // did last month. Running the evaluation here as well is what makes new
  // achievements genuinely retroactive.
  //
  // The cost is that a retroactively granted achievement is dated when it was
  // noticed rather than when it was earned, and has no match attached. That is
  // the honest trade: the alternative is re-walking every match to find the one
  // that did it, for a date nobody is checking.
  awardAchievements(userId, null);

  const earned = new Map(
    getDatabase()
      .prepare("SELECT code, earned_at, match_id FROM achievements WHERE user_id = ?")
      .all(userId)
      .map((row) => [row.code, row])
  );

  return allAchievements().map((achievement) => ({
    ...achievement,
    earned: earned.has(achievement.code),
    earnedAt: earned.get(achievement.code)?.earned_at ?? null,
    matchId: earned.get(achievement.code)?.match_id ?? null,
  }));
}
