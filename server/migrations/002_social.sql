-- 002_social.sql - friends, clubs, and the indexes leaderboards read.
--
-- Separate from 001 because an applied migration is never edited: two databases
-- claiming the same version and disagreeing about their contents is the classic
-- way this goes wrong. New schema is always a new file.
--
-- Nothing here stores a statistic. A leaderboard is a query over stats_cache
-- (see server/leaderboard.js) filtered by these relationships, which is why
-- adding a board later needs no schema change at all.

-- Friendship is stored as two rows, one per direction, rather than one row with
-- a canonical ordering. That makes "who are my friends" a single indexed lookup
-- on user_id instead of an OR across two columns, and it makes a pending
-- request naturally directional: the row that exists is the one that was sent.
--
--   A requests B  ->  (A, B, 'pending')
--   B accepts     ->  (A, B, 'accepted') and (B, A, 'accepted')
--
-- status is 'pending' or 'accepted'. A declined request is deleted rather than
-- stored as 'declined': keeping a record of who turned down whom serves nobody,
-- and it would stop the pair ever trying again.
CREATE TABLE friends (
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  friend_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status         TEXT    NOT NULL DEFAULT 'pending',
  created_at     TEXT    NOT NULL,
  PRIMARY KEY (user_id, friend_user_id),
  -- Befriending yourself is not a thing, and it would show up as a duplicate
  -- row on every friends board.
  CHECK (user_id <> friend_user_id)
);

CREATE INDEX friends_incoming_idx ON friends(friend_user_id, status);

-- A club is any group that wants its own board: a pub team, a league, a group
-- chat. Joining is by slug, which doubles as the invite - there is no directory
-- of clubs to browse, so a club is private unless its slug is shared.
CREATE TABLE clubs (
  id         INTEGER PRIMARY KEY,
  name       TEXT    NOT NULL,
  slug       TEXT    NOT NULL UNIQUE,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT    NOT NULL
);

CREATE TABLE club_members (
  club_id   INTEGER NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
  user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- 'owner' or 'member'. The owner is whoever created it; there is no
  -- moderation beyond that yet, and inventing a permission system before there
  -- is anything to moderate would be guessing.
  role      TEXT    NOT NULL DEFAULT 'member',
  joined_at TEXT    NOT NULL,
  PRIMARY KEY (club_id, user_id)
);

CREATE INDEX club_members_user_idx ON club_members(user_id);

-- Every leaderboard reads the cached statistics of everyone who has opted in,
-- so that filter is the first thing every one of those queries does.
CREATE INDEX users_leaderboard_idx ON users(leaderboard_opt_in);
