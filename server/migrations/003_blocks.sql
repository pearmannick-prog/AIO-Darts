-- 003_blocks.sql - blocking another player.
--
-- Chat needs this. A room anyone can talk in is a room someone can be
-- unpleasant in, and "mute them in this session" is not a real answer - it
-- forgets the moment the tab closes, which is exactly when it matters. Blocks
-- are stored, not held in memory.
--
-- One direction only, and asymmetric on purpose: blocking someone stops what
-- they send from reaching you, and stops them challenging you. It does not
-- announce anything to them. Telling someone they have been blocked reliably
-- produces a second account, which is the outcome the feature exists to avoid.
CREATE TABLE blocks (
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at      TEXT    NOT NULL,
  PRIMARY KEY (user_id, blocked_user_id),
  CHECK (user_id <> blocked_user_id)
);

-- The lookup the lobby does on every chat message and every challenge, so it
-- is worth an index in both directions: "who have I blocked" for filtering what
-- I receive, and "who has blocked me" for refusing what I send.
CREATE INDEX blocks_by_blocked_idx ON blocks(blocked_user_id);
