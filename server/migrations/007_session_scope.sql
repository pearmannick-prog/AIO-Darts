-- 007_session_scope.sql
--
-- A PARTNER TOKEN WAS A FULL SESSION WEARING A DIFFERENT HAT.
--
-- The second person at a shared board signs in with POST /api/auth/partner and
-- gets a token back in the response body, because the session cookie is one per
-- browser and issuing them a second one would sign the board's owner out. The
-- comment above that handler says the token "buys one capability, not a
-- session": only the match upload reads it, so a partner can have their darts
-- counted and do nothing else.
--
-- That was documentation, not enforcement. The token was an ordinary row in
-- `sessions` with nothing to distinguish it, so it satisfied the cookie lookup
-- just as well as the bearer one. HttpOnly stops a page script READING the
-- session cookie; it does not stop one WRITING it. Anyone holding the raw
-- partner token - the board's owner, who watched it arrive, or any script on
-- the page, which is where accountstore.js keeps it in memory - could do
--
--     document.cookie = "aiodarts_session=<token>"
--
-- and be that user for the token's full twelve hours: their statistics, their
-- friends, their password, the lobby. The guest at your board handed you the
-- keys to their account by playing a leg of darts.
--
-- So the distinction becomes a column that the queries actually test. See
-- userForRequest and userForBearer in auth.js, which are now each other's
-- opposite rather than the same query twice.
ALTER TABLE sessions ADD COLUMN scope TEXT NOT NULL DEFAULT 'full';

-- Existing rows are backfilled by DURATION, which identifies them exactly
-- rather than approximately: createSession is only ever called two ways, a
-- 30-day sign-in or a 12-hour partner session, so "expires less than a day
-- after it was created" is precisely the set of partner tokens and nothing
-- else. Marking them rather than deleting them closes the hole for tokens
-- already issued WITHOUT signing anybody out mid-match - unlike 005, where the
-- raw tokens could not be converted and everyone had to sign in again.
UPDATE sessions
   SET scope = 'partner'
 WHERE julianday(expires_at) - julianday(created_at) < 1;
