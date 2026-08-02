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

import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
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
export function createSession(userId, userAgent) {
  const token = randomBytes(TOKEN_BYTES).toString("hex");
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_DAYS * 86400_000);

  getDatabase()
    .prepare(
      `INSERT INTO sessions (token, user_id, created_at, expires_at, user_agent)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(token, userId, now.toISOString(), expires.toISOString(), (userAgent || "").slice(0, 200));

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
    .get(token, new Date().toISOString());

  return row || null;
}

export function destroySession(req) {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (!token) return;
  getDatabase().prepare("DELETE FROM sessions WHERE token = ?").run(token);
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
