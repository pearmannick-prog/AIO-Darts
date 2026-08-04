-- 004_password_reset.sql
--
-- Accounts have always used an email address as the identifier and never once
-- sent anything to it, which meant a forgotten password locked a player out
-- permanently - there was no recovery path, and no admin route either short of
-- editing this file by hand.
--
-- One table, and no changes to any existing one.

CREATE TABLE password_resets (
  -- The HASH of the token, never the token itself. Sessions store theirs raw
  -- because a cookie only ever exists in the browser that owns it. A reset
  -- token is different in kind: it travels in an email, so it also comes to
  -- rest in an inbox, in a mail server's logs, and possibly in a forwarded
  -- message. A stolen copy of this database must not hand over live reset
  -- links, and hashing is what makes the stored row useless on its own.
  token_hash TEXT    PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT    NOT NULL,
  -- Short by design - an hour. A reset link is a password in an email, and the
  -- window in which a leaked one is dangerous should be small.
  expires_at TEXT    NOT NULL,
  -- Single use. Stamped on redemption rather than deleting the row, so a second
  -- click on the same link can say "this link has already been used" instead of
  -- "invalid link" - the difference between an explicable message and one that
  -- sends someone to request another reset they do not need.
  used_at    TEXT
);

CREATE INDEX password_resets_user_idx   ON password_resets(user_id);
CREATE INDEX password_resets_expiry_idx ON password_resets(expires_at);
