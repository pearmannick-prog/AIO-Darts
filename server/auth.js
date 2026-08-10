// auth.js - password hashing and session cookies.
//
// Deliberately small and dependency-free. Everything here is node:crypto plus
// two SQL statements; there is no passport, no bcrypt, no jsonwebtoken.
//
// Why sessions rather than JWTs: a JWT cannot be revoked without keeping a
// server-side list of revoked tokens, at which point it is a session table with
// extra steps and a signing key to protect. A random opaque token in a table
// logs someone out with a DELETE, survives a restart because it is on disk, and
// tells an attacker who steals one nothing about anything else.
//
// Why scrypt rather than bcrypt/argon2: it is in the standard library, it is
// memory-hard, and it is what Node's own docs point at for this. The cost
// parameters below are the defaults, which are sized so a single hash takes
// long enough to make guessing expensive - that is also why registration and
// login are the only two places this runs.

import { randomBytes, scrypt, timingSafeEqual, createHash } from "node:crypto";
import { promisify } from "node:util";
import { getDatabase } from "./db.js";

const scryptAsync = promisify(scrypt);

const KEY_LENGTH = 64;
const SALT_BYTES = 16;
const TOKEN_BYTES = 32; // 256 bits of session token - not guessable
const SESSION_DAYS = 30;

export const SESSION_COOKIE = "aiodarts_session";

// ---------------------------------------------------------------------------
// Passwords
// ---------------------------------------------------------------------------
export async function hashPassword(password) {
  const salt = randomBytes(SALT_BYTES).toString("hex");
  const derived = await scryptAsync(password, salt, KEY_LENGTH);
  return { hash: derived.toString("hex"), salt };
}

// Compared with timingSafeEqual rather than ===, so the time taken doesn't leak
// how much of the hash matched. The length guard is needed because
// timingSafeEqual throws on mismatched lengths - which would itself be a
// (crude) signal, hence returning false rather than letting it throw.
export async function verifyPassword(password, hash, salt) {
  const derived = await scryptAsync(password, salt, KEY_LENGTH);
  const expected = Buffer.from(hash, "hex");
  if (expected.length !== derived.length) return false;
  return timingSafeEqual(expected, derived);
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------
// STORED HASHED. The raw token exists in exactly one place - the cookie in the
// browser it was issued to - and the database holds only its SHA-256.
//
// This used to store the token as sent. The consequence was that a stolen copy
// of the database was a stolen copy of every LIVE SESSION: paste a value into a
// cookie and you are that user for up to thirty days, with no password needed,
// no reset triggered, and nothing anywhere to notice. Passwords were already
// safe behind scrypt, so the sessions table was the softest thing in the file.
//
// SHA-256 rather than scrypt, for the same reason as the reset tokens: this is
// 256 bits of randomness, not a password. There is no dictionary to try, so
// there is nothing for a slow hash to slow down - and a slow hash here would be
// paid on every single authenticated request.
//
// Lookup is still an exact match on a 64-character hex string, so nothing about
// the schema or the queries' shape changes.
function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

// A PARTNER SESSION is hours, not thirty days.
//
// It exists so the second person at one board can have their own darts land in
// their own account, and it is fundamentally different from a sign-in on your
// own device: the board is shared, the person is a guest at it, and nobody
// intends to stay signed in there. Long enough for an evening of darts, short
// enough that a forgotten one is dead by morning.
const PARTNER_SESSION_HOURS = 12;

export function createSession(userId, userAgent, { hours = null } = {}) {
  const token = randomBytes(TOKEN_BYTES).toString("hex");
  const now = new Date();
  const expires = new Date(now.getTime()
    + (hours ? hours * 3600_000 : SESSION_DAYS * 86400_000));

  getDatabase()
    .prepare(
      `INSERT INTO sessions (token, user_id, created_at, expires_at, user_agent)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(hashToken(token), userId, now.toISOString(), expires.toISOString(), (userAgent || "").slice(0, 200));

  // The RAW token goes back to the caller, and from there into the cookie. It
  // is never written down here.
  return { token, expires };
}

// Resolves a request's cookie to a user row, or null. Expiry is checked in SQL
// rather than in JS so an expired session is never even returned - there is no
// window where a caller could forget to check.
export function userForRequest(req) {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (!token) return null;

  const row = getDatabase()
    .prepare(
      `SELECT u.* FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token = ? AND s.expires_at > ?`
    )
    .get(hashToken(token), new Date().toISOString());

  return row || null;
}

export { PARTNER_SESSION_HOURS };

// Resolves a BEARER token to a user row, or null.
//
// This is the partner's path, and it is separate from userForRequest for one
// reason: the cookie is HttpOnly, one per browser, so a second person signing
// in on the same machine would sign the first one out. Their token therefore
// travels in a header the page can set, which means the page can also read it
// - so it is deliberately NOT a general-purpose way to authenticate.
//
// Only the match upload honours it (see api.js). A partner is at this board to
// throw darts, and the one thing they need from the server is for those darts
// to be counted; they cannot read anyone's statistics, change a password, or
// touch the lobby with it. Widening this later is a decision to make on
// purpose, not by adding a second caller.
export function userForBearer(req) {
  const header = String(req.headers.authorization || "");
  const match = /^Bearer\s+([A-Za-z0-9]+)$/.exec(header.trim());
  if (!match) return null;

  const row = getDatabase()
    .prepare(
      `SELECT u.* FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token = ? AND s.expires_at > ?`
    )
    .get(hashToken(match[1]), new Date().toISOString());

  return row || null;
}

export function destroySession(req) {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (!token) return;
  getDatabase().prepare("DELETE FROM sessions WHERE token = ?").run(hashToken(token));
}

// Expired rows are dead weight that nothing reads (userForRequest filters them
// out), so this is housekeeping rather than a security measure - it runs on a
// timer from server.js purely to stop the table growing forever.
export function purgeExpiredSessions() {
  const { changes } = getDatabase()
    .prepare("DELETE FROM sessions WHERE expires_at <= ?")
    .run(new Date().toISOString());
  return changes;
}

// ---------------------------------------------------------------------------
// Cookies
// ---------------------------------------------------------------------------
export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

// HttpOnly so page scripts can't read it (an XSS then can't exfiltrate the
// session), SameSite=Lax so it isn't sent on cross-site form posts, and Secure
// only when the connection actually is HTTPS - setting Secure unconditionally
// would break the http://localhost testing this app is developed against.
//
// The proto check honours x-forwarded-proto because the intended deployment is
// behind a reverse proxy terminating TLS, where req.socket.encrypted is false
// even though the browser is on https.
export function sessionCookie(req, token, expires) {
  const secure = isSecureRequest(req) ? "; Secure" : "";
  return (
    `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax` +
    `; Expires=${expires.toUTCString()}${secure}`
  );
}

export function clearedCookie(req) {
  const secure = isSecureRequest(req) ? "; Secure" : "";
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}

function isSecureRequest(req) {
  const forwarded = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  return forwarded === "https" || Boolean(req.socket?.encrypted);
}
