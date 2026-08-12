// Tests for session scope - which token may do what.
//
// This one earns its place because the restriction it checks was, for a while,
// a COMMENT. The partner sign-in handler said its token "buys one capability,
// not a session", and that was true of how the app used it and false of what
// the token could do: a partner session was an ordinary row in `sessions`, so
// it satisfied the cookie lookup exactly as well as the bearer one. HttpOnly
// stops a page script reading the session cookie; nothing stops one writing it.
// Pasting the partner's token into `document.cookie` made the guest at your
// board into you-are-them for twelve hours.
//
// Nothing about that is visible from either end. The partner's darts upload,
// the owner stays signed in, both sessions behave exactly as intended, and the
// hole is only reachable by someone deliberately trying it - which is precisely
// the shape of thing that survives being read and re-read. So the rule is
// asserted from BOTH sides here: what each token must do, and what it must not.
//
// This is also the first test in the repo to open a real database. It is worth
// the temporary directory: the invariant lives in two SQL WHERE clauses and a
// migration, none of which a pure test can reach.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDatabase, getDatabase, closeDatabase } from "./db.js";
import {
  hashPassword, createSession, userForRequest, userForBearer,
  SESSION_COOKIE, PARTNER_SESSION_HOURS, SCOPE_PARTNER, SCOPE_FULL,
} from "./auth.js";

const asCookie = (token) => ({ headers: { cookie: `${SESSION_COOKIE}=${token}` } });
const asBearer = (token) => ({ headers: { authorization: `Bearer ${token}` } });

let dir;
let userId;

test.before(async () => {
  dir = await mkdtemp(join(tmpdir(), "aio-darts-auth-"));
  await openDatabase(dir);

  const { hash, salt } = await hashPassword("hunter2");
  getDatabase()
    .prepare(
      `INSERT INTO users (email, display_name, password_hash, password_salt, created_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run("guest@example.com", "Guest", hash, salt, new Date().toISOString());
  userId = getDatabase().prepare("SELECT id FROM users WHERE email = ?")
    .get("guest@example.com").id;
});

test.after(async () => {
  closeDatabase?.();
  await rm(dir, { recursive: true, force: true });
});

test("a partner token uploads a match - the one thing it is for", () => {
  const { token } = createSession(userId, "ua",
    { hours: PARTNER_SESSION_HOURS, scope: SCOPE_PARTNER });
  const user = userForBearer(asBearer(token));
  assert.equal(user?.email, "guest@example.com");
});

// THE ATTACK. A partner token in the session cookie must authenticate nothing.
// userForRequest is the single door for every cookie-authenticated surface -
// the /api/* context and the lobby socket both - so this one assertion is the
// whole of the restriction rather than one instance of it.
test("a partner token in the session cookie is NOT a session", () => {
  const { token } = createSession(userId, "ua",
    { hours: PARTNER_SESSION_HOURS, scope: SCOPE_PARTNER });
  assert.equal(userForRequest(asCookie(token)), null);
});

test("an ordinary sign-in is untouched by any of this", () => {
  const { token } = createSession(userId, "ua");
  assert.equal(userForRequest(asCookie(token))?.email, "guest@example.com");
});

// The other direction. It matters less - anyone holding a full session's token
// already has the cookie it came from - but the two lookups being exact
// opposites is what keeps the rule to one sentence, and it stops a token being
// quietly promoted by arriving through the other door.
test("a full session's token is not accepted as a bearer token", () => {
  const { token } = createSession(userId, "ua");
  assert.equal(userForBearer(asBearer(token)), null);
});

test("scope defaults to full, so a caller cannot mint a partner session by omission", () => {
  const { token } = createSession(userId, "ua");
  const row = getDatabase()
    .prepare("SELECT scope FROM sessions WHERE user_id = ? ORDER BY rowid DESC LIMIT 1")
    .get(userId);
  assert.equal(row.scope, SCOPE_FULL);
  assert.ok(userForRequest(asCookie(token)));
});

// Rows written before migration 007 carry no scope of their own. The migration
// identifies them by DURATION, which is exact rather than approximate:
// createSession is only ever called two ways, a 30-day sign-in or a 12-hour
// partner session, so "expires less than a day after it was created" is
// precisely the set of partner tokens. Asserted because the backfill is the
// half of the fix that protects tokens ALREADY issued - and it runs once, on a
// database nobody will look at again.
test("the backfill classifies pre-existing rows by duration", () => {
  const db = getDatabase();
  const now = new Date();
  const insert = (token, hours) => db
    .prepare(
      `INSERT INTO sessions (token, user_id, created_at, expires_at, user_agent, scope)
       VALUES (?, ?, ?, ?, 'ua', 'full')`
    )
    .run(token, userId, now.toISOString(),
         new Date(now.getTime() + hours * 3600_000).toISOString());

  insert("legacy-partner", PARTNER_SESSION_HOURS);
  insert("legacy-full", 30 * 24);

  // The statement from 007_session_scope.sql, verbatim.
  db.exec(`UPDATE sessions SET scope = 'partner'
            WHERE julianday(expires_at) - julianday(created_at) < 1`);

  const scopeOf = (t) => db.prepare("SELECT scope FROM sessions WHERE token = ?").get(t).scope;
  assert.equal(scopeOf("legacy-partner"), SCOPE_PARTNER);
  assert.equal(scopeOf("legacy-full"), SCOPE_FULL);
});
