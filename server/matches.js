// matches.js - writing an uploaded match into the database, and reading it back.
//
// Kept out of api.js because this is the one place with real structure to it:
// a match document is a four-level tree (match -> legs -> turns -> throws) and
// storing it is a walk of that tree, not a single INSERT.
//
// Two rules govern everything here:
//
//   1. VALIDATE, DON'T TRUST. The document is produced by the browser, which
//      means it is user input, which means every number in it is a claim. The
//      shape is checked and the values are coerced; a malformed document is
//      rejected with a 400 rather than half-inserted.
//
//   2. ALL OR NOTHING. The whole tree is written inside one transaction. A
//      partially written match would be worse than a missing one, because it
//      would silently corrupt every statistic derived from it.

import { getDatabase, bool, orNull, inTransaction } from "./db.js";
import { ApiError } from "./api-error.js";

// Generous but finite. A very long medley of 701 legs might be a few hundred
// visits; anything past these numbers is a bug or an attempt to fill the disk.
const MAX_LEGS = 100;
const MAX_TURNS_PER_LEG = 500;
const MAX_THROWS_PER_TURN = 3;

function fail(message) {
  return new ApiError(400, message);
}

// SQLite has no boolean and node:sqlite refuses to bind one; `undefined` is a
// bind error rather than NULL. Everything crossing into a statement therefore
// goes through one of these.
function int(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function nullableInt(value) {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function text(value, max = 200) {
  return String(value ?? "").slice(0, max);
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------
// Returns { id, duplicate }. A duplicate is a success, not an error: the
// offline queue retries, and the whole point of the client-generated UUID is
// that arriving twice is harmless.
export function insertMatch(userId, match) {
  if (!match || typeof match !== "object") throw fail("No match in that request.");
  if (!match.clientUuid) throw fail("That match has no identifier.");

  const legs = Array.isArray(match.legs) ? match.legs : [];
  const players = Array.isArray(match.players) ? match.players : [];
  if (!players.length) throw fail("That match has no players.");
  if (legs.length > MAX_LEGS) throw fail("That match has too many legs.");

  const db = getDatabase();

  const existing = db
    .prepare("SELECT id FROM matches WHERE user_id = ? AND client_uuid = ?")
    .get(userId, String(match.clientUuid));
  if (existing) return { id: existing.id, duplicate: true };

  return inTransaction(() => {
    const { lastInsertRowid: matchId } = db
      .prepare(
        `INSERT INTO matches (user_id, client_uuid, mode, started_at, ended_at,
                              duration_ms, format_json, winner_seat, drawn)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        userId,
        text(match.clientUuid, 64),
        match.mode === "online" ? "online" : "local",
        text(match.startedAt, 40) || new Date().toISOString(),
        text(match.endedAt, 40) || new Date().toISOString(),
        int(match.durationMs),
        JSON.stringify(match.format ?? []),
        nullableInt(match.winnerSeat),
        bool(match.drawn)
      );

    const playerStmt = db.prepare(
      `INSERT INTO match_players (match_id, seat, display_name, is_self, legs_won, sets_won)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    players.forEach((player, index) => {
      playerStmt.run(
        matchId,
        int(player.seat, index),
        text(player.displayName, 40) || `Player ${index + 1}`,
        bool(player.isSelf),
        int(player.legsWon),
        int(player.setsWon)
      );
    });

    const legStmt = db.prepare(
      `INSERT INTO legs (match_id, leg_index, game, x01_start, rules, bull, rounds, winner_seat)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const turnStmt = db.prepare(
      `INSERT INTO turns (leg_id, turn_index, seat, darts, scored, remaining_before,
                          remaining_after, bust, is_checkout, entry, game_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const throwStmt = db.prepare(
      `INSERT INTO throws (turn_id, dart_index, segment_id, section, ring, multiplier,
                           value, remaining_before, remaining_after, bust, ignored, at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    legs.forEach((leg, legIndex) => {
      const turns = Array.isArray(leg.turns) ? leg.turns : [];
      if (turns.length > MAX_TURNS_PER_LEG) throw fail("That match has too many turns in a leg.");

      const { lastInsertRowid: legId } = legStmt.run(
        matchId,
        int(leg.legIndex, legIndex),
        text(leg.game, 20) || "x01",
        nullableInt(leg.x01Start),
        orNull(leg.rules ? text(leg.rules, 20) : null),
        orNull(leg.bull ? text(leg.bull, 10) : null),
        nullableInt(leg.rounds),
        nullableInt(leg.winnerSeat)
      );

      turns.forEach((turn, turnIndex) => {
        const throws = Array.isArray(turn.throws) ? turn.throws : [];
        // A quick-total visit is one row standing for three darts, so the cap
        // is on recorded throws rather than on the turn's dart count.
        if (throws.length > MAX_THROWS_PER_TURN) {
          throw fail("That match has a turn with too many darts.");
        }

        const { lastInsertRowid: turnId } = turnStmt.run(
          legId,
          int(turn.turnIndex, turnIndex),
          int(turn.seat),
          int(turn.darts, throws.length),
          int(turn.scored),
          nullableInt(turn.remainingBefore),
          nullableInt(turn.remainingAfter),
          bool(turn.bust),
          bool(turn.isCheckout),
          turn.entry === "quick" ? "quick" : "dart",
          turn.game ? JSON.stringify(turn.game) : null
        );

        throws.forEach((dart, dartIndex) => {
          throwStmt.run(
            turnId,
            int(dart.dartIndex, dartIndex),
            nullableInt(dart.segmentId),
            text(dart.section, 10) || "Other",
            text(dart.ring, 10) || "other",
            int(dart.multiplier, 1),
            int(dart.value),
            nullableInt(dart.remainingBefore),
            nullableInt(dart.remainingAfter),
            bool(dart.bust),
            bool(dart.ignored),
            int(dart.atMs)
          );
        });
      });
    });

    // Any cached statistics are now wrong. Deleting rather than recomputing:
    // the next request for them rebuilds from the darts, and doing it here
    // would make uploading a match pay for a calculation nobody may look at.
    db.prepare("DELETE FROM stats_cache WHERE user_id = ?").run(userId);

    return { id: Number(matchId), duplicate: false };
  });
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------
// The history list: enough to render a row, without the darts. A page of 25
// matches carries a few kilobytes this way rather than a few hundred.
export function listMatches(userId, { limit = 25, before = null } = {}) {
  const db = getDatabase();
  const capped = Math.min(Math.max(int(limit, 25), 1), 100);

  // Keyset pagination on ended_at rather than OFFSET: a new match arriving
  // between pages shifts every offset by one and makes the reader see a row
  // twice. Comparing against the last row seen cannot do that.
  const rows = before
    ? db
        .prepare(
          `SELECT * FROM matches WHERE user_id = ? AND ended_at < ?
           ORDER BY ended_at DESC LIMIT ?`
        )
        .all(userId, String(before), capped)
    : db
        .prepare("SELECT * FROM matches WHERE user_id = ? ORDER BY ended_at DESC LIMIT ?")
        .all(userId, capped);

  const playerStmt = db.prepare(
    "SELECT seat, display_name, is_self, legs_won, sets_won FROM match_players WHERE match_id = ? ORDER BY seat"
  );
  const legStmt = db.prepare(
    "SELECT game, COUNT(*) AS n FROM legs WHERE match_id = ? GROUP BY game"
  );
  const dartStmt = db.prepare(
    `SELECT COALESCE(SUM(t.darts), 0) AS darts
     FROM turns t JOIN legs l ON l.id = t.leg_id
     WHERE l.match_id = ? AND t.seat = ?`
  );

  return rows.map((row) => {
    const players = playerStmt.all(row.id);
    const self = players.find((p) => p.is_self) ?? players[0];
    return {
      id: row.id,
      mode: row.mode,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      durationMs: row.duration_ms,
      format: safeJson(row.format_json, []),
      winnerSeat: row.winner_seat,
      drawn: Boolean(row.drawn),
      games: legStmt.all(row.id).map((g) => ({ game: g.game, legs: g.n })),
      // "Did I win?" is the first thing anyone reads off a history row, so it
      // is answered here rather than leaving the page to work it out from
      // seats.
      won: row.winner_seat !== null && self ? row.winner_seat === self.seat : false,
      dartsThrown: self ? int(dartStmt.get(row.id, self.seat)?.darts) : 0,
      players: players.map((p) => ({
        seat: p.seat,
        displayName: p.display_name,
        isSelf: Boolean(p.is_self),
        legsWon: p.legs_won,
        setsWon: p.sets_won,
      })),
    };
  });
}

// One match in full, including every dart - this is what the stats engine is
// handed, and what a future "replay this match" screen would read.
export function loadMatch(userId, matchId) {
  const db = getDatabase();
  const row = db
    .prepare("SELECT * FROM matches WHERE id = ? AND user_id = ?")
    .get(matchId, userId);
  if (!row) return null;

  const players = db
    .prepare("SELECT * FROM match_players WHERE match_id = ? ORDER BY seat")
    .all(row.id);
  const legs = db
    .prepare("SELECT * FROM legs WHERE match_id = ? ORDER BY leg_index")
    .all(row.id);

  const turnStmt = db.prepare("SELECT * FROM turns WHERE leg_id = ? ORDER BY turn_index");
  const throwStmt = db.prepare("SELECT * FROM throws WHERE turn_id = ? ORDER BY dart_index");

  return {
    id: row.id,
    clientUuid: row.client_uuid,
    mode: row.mode,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    durationMs: row.duration_ms,
    format: safeJson(row.format_json, []),
    winnerSeat: row.winner_seat,
    drawn: Boolean(row.drawn),
    players: players.map((p) => ({
      seat: p.seat,
      displayName: p.display_name,
      isSelf: Boolean(p.is_self),
      legsWon: p.legs_won,
      setsWon: p.sets_won,
    })),
    legs: legs.map((leg) => ({
      legIndex: leg.leg_index,
      game: leg.game,
      x01Start: leg.x01_start,
      rules: leg.rules,
      bull: leg.bull,
      rounds: leg.rounds,
      winnerSeat: leg.winner_seat,
      turns: turnStmt.all(leg.id).map((turn) => ({
        turnIndex: turn.turn_index,
        seat: turn.seat,
        darts: turn.darts,
        scored: turn.scored,
        remainingBefore: turn.remaining_before,
        remainingAfter: turn.remaining_after,
        bust: Boolean(turn.bust),
        isCheckout: Boolean(turn.is_checkout),
        entry: turn.entry,
        game: safeJson(turn.game_json, null),
        throws: throwStmt.all(turn.id).map((dart) => ({
          dartIndex: dart.dart_index,
          segmentId: dart.segment_id,
          section: dart.section,
          ring: dart.ring,
          multiplier: dart.multiplier,
          value: dart.value,
          remainingBefore: dart.remaining_before,
          remainingAfter: dart.remaining_after,
          bust: Boolean(dart.bust),
          ignored: Boolean(dart.ignored),
          atMs: dart.at_ms,
        })),
      })),
    })),
  };
}

// Every match a user has, in full, for the stats engine.
//
// Five queries regardless of how many matches there are, assembled in memory.
// The obvious implementation - loadMatch() in a loop - is four queries per
// match, which is fine at ten matches and ruinous at a thousand.
//
// It does hold the whole history in memory at once. For this app's scale that
// is a few megabytes at the extreme, and the alternative (streaming, or
// incremental statistics kept up to date on insert) is a great deal more
// machinery to maintain than the cache in stats.js, which already means this
// runs about once per new match rather than once per page view.
export function loadAllMatches(userId) {
  const db = getDatabase();

  const matches = db
    .prepare("SELECT * FROM matches WHERE user_id = ? ORDER BY ended_at")
    .all(userId);
  if (!matches.length) return [];

  const byId = new Map();
  for (const row of matches) {
    byId.set(row.id, {
      id: row.id,
      clientUuid: row.client_uuid,
      mode: row.mode,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      durationMs: row.duration_ms,
      format: safeJson(row.format_json, []),
      winnerSeat: row.winner_seat,
      drawn: Boolean(row.drawn),
      players: [],
      legs: [],
    });
  }

  for (const row of db.prepare(
    `SELECT mp.* FROM match_players mp JOIN matches m ON m.id = mp.match_id
     WHERE m.user_id = ? ORDER BY mp.match_id, mp.seat`
  ).all(userId)) {
    byId.get(row.match_id)?.players.push({
      seat: row.seat,
      displayName: row.display_name,
      isSelf: Boolean(row.is_self),
      legsWon: row.legs_won,
      setsWon: row.sets_won,
    });
  }

  const legsById = new Map();
  for (const row of db.prepare(
    `SELECT l.* FROM legs l JOIN matches m ON m.id = l.match_id
     WHERE m.user_id = ? ORDER BY l.match_id, l.leg_index`
  ).all(userId)) {
    const leg = {
      legIndex: row.leg_index,
      game: row.game,
      x01Start: row.x01_start,
      rules: row.rules,
      bull: row.bull,
      rounds: row.rounds,
      winnerSeat: row.winner_seat,
      turns: [],
    };
    legsById.set(row.id, leg);
    byId.get(row.match_id)?.legs.push(leg);
  }

  const turnsById = new Map();
  for (const row of db.prepare(
    `SELECT t.* FROM turns t
     JOIN legs l ON l.id = t.leg_id JOIN matches m ON m.id = l.match_id
     WHERE m.user_id = ? ORDER BY t.leg_id, t.turn_index`
  ).all(userId)) {
    const turn = {
      turnIndex: row.turn_index,
      seat: row.seat,
      darts: row.darts,
      scored: row.scored,
      remainingBefore: row.remaining_before,
      remainingAfter: row.remaining_after,
      bust: Boolean(row.bust),
      isCheckout: Boolean(row.is_checkout),
      entry: row.entry,
      game: safeJson(row.game_json, null),
      throws: [],
    };
    turnsById.set(row.id, turn);
    legsById.get(row.leg_id)?.turns.push(turn);
  }

  for (const row of db.prepare(
    `SELECT th.* FROM throws th
     JOIN turns t ON t.id = th.turn_id
     JOIN legs l ON l.id = t.leg_id JOIN matches m ON m.id = l.match_id
     WHERE m.user_id = ? ORDER BY th.turn_id, th.dart_index`
  ).all(userId)) {
    turnsById.get(row.turn_id)?.throws.push({
      dartIndex: row.dart_index,
      segmentId: row.segment_id,
      section: row.section,
      ring: row.ring,
      multiplier: row.multiplier,
      value: row.value,
      remainingBefore: row.remaining_before,
      remainingAfter: row.remaining_after,
      bust: Boolean(row.bust),
      ignored: Boolean(row.ignored),
      atMs: row.at_ms,
      // Reattached below from the turn's payload.
      extra: null,
    });
  }

  // Per-dart game detail rides in the turn's payload rather than in a column of
  // its own (see matchrecorder.js), so it is redistributed onto the darts here.
  // That means a stats module sees the same shape whether the match came from
  // the database or straight from a game that has just finished - which is what
  // lets the same engine run in the browser and on the server.
  for (const turn of turnsById.values()) {
    const perDart = turn.game?.darts;
    if (Array.isArray(perDart)) {
      turn.throws.forEach((dart, index) => {
        if (perDart[index]) dart.extra = perDart[index];
      });
      continue;
    }

    // Older matches recorded the targets but not the per-dart breakdown. The
    // targets are still worth reattaching; the missing counts are filled in the
    // direction that UNDER-reports rather than over-reports - marksApplied is
    // assumed equal to marks, so nothing is credited as "prevented" that might
    // not have been. A statistic that quietly invents defence out of missing
    // data would be worse than one that is slightly low on old matches.
    const targets = turn.game?.targets;
    if (!Array.isArray(targets)) continue;
    turn.throws.forEach((dart, index) => {
      const target = targets[index];
      if (target === null || target === undefined) return;
      dart.extra = {
        target,
        marks: dart.multiplier,
        marksApplied: dart.multiplier,
        points: 0,
      };
    });
  }

  return [...byId.values()];
}

// Every JSON column in this schema was written by this server, so a parse
// failure means the file has been edited or corrupted. Returning the fallback
// keeps one bad row from taking down a whole history page.
function safeJson(value, fallback) {
  if (value === null || value === undefined) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}
