// api.js - the /api/* HTTP surface.
//
// Shape: one exported function that server.js calls before it tries to serve a
// static file. It returns true if it handled the request and false if the path
// isn't ours, which keeps the two halves of the server independent - the static
// server doesn't know the API exists, and the API doesn't know about files.
//
// There is no Express here for the same reason there is no bundler anywhere
// else in this project: the whole router is a lookup in a table, and a
// dependency that pulls in fifty transitive packages to do that would be the
// largest thing in the repo by an order of magnitude.
//
// Every route is a plain async function of (req, res, ctx). Anything it throws
// becomes a JSON error response - see the ApiError class - so route bodies can
// be written as the happy path plus guards, without a try/catch each.

import { getDatabase, bool, orNull } from "./db.js";
import { insertMatch, listMatches, loadMatch } from "./matches.js";
import { statsFor, awardAchievements, achievementsFor, publicProfileFor } from "./stats.js";
import {
  searchUsers, friendsOf, requestFriend, acceptFriend, removeFriend, friendIds,
  createClub, joinClub, leaveClub, clubsFor, clubMemberIds,
} from "./social.js";
import { buildLeaderboard } from "./leaderboard.js";
import { leaderboardCatalogue } from "../statsengine.js";
import {
  hashPassword, verifyPassword, createSession, destroySession,
  userForRequest, sessionCookie, clearedCookie,
} from "./auth.js";

// Big enough for a long match's worth of darts (a 500-dart match serialises to
// well under 100KB) and for a capped avatar, small enough that a bad actor
// can't make the process hold megabytes per connection.
const MAX_BODY_BYTES = 2 * 1024 * 1024;

// Avatars are stored in the database, so this cap is also a cap on how big the
// backup file gets. 256KB is generous for a profile picture.
const MAX_AVATAR_BYTES = 256 * 1024;
const AVATAR_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------
// Thrown by routes, caught by the dispatcher, rendered as JSON. The message is
// user-facing: it is shown verbatim in the UI, so it says what to do about the
// problem rather than what went wrong internally.
//
// Defined in its own module and re-exported here so that the modules api.js
// imports can throw one without importing api.js back - see api-error.js.
export { ApiError } from "./api-error.js";
import { ApiError } from "./api-error.js";

function badRequest(message, code) { return new ApiError(400, message, code); }
function unauthorized(message = "Sign in to do that.") { return new ApiError(401, message); }

// ---------------------------------------------------------------------------
// Request/response helpers
// ---------------------------------------------------------------------------
function sendJson(res, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    // Account state must never be cached: a shared machine showing the previous
    // user's dashboard from cache would be both wrong and a privacy problem.
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(payload);
}

async function readJsonBody(req) {
  const chunks = [];
  let total = 0;

  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) {
      throw new ApiError(413, "That request was too large.");
    }
    chunks.push(chunk);
  }

  if (!total) return {};

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw badRequest("The request body wasn't valid JSON.");
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------
// Deliberately loose: the only email check that actually proves anything is
// sending mail to it, and this app sends none. So this rejects the obviously
// malformed and otherwise gets out of the way rather than turning away real
// addresses with unusual shapes.
function normalizeEmail(value) {
  const email = String(value ?? "").trim().toLowerCase();
  if (email.length < 3 || email.length > 254) {
    throw badRequest("Enter an email address.");
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw badRequest("That doesn't look like an email address.");
  }
  return email;
}

function normalizeDisplayName(value) {
  const name = String(value ?? "").trim();
  if (name.length < 1 || name.length > 40) {
    throw badRequest("Display name must be 1-40 characters.");
  }
  return name;
}

// A length floor and nothing else. Composition rules (a number, a symbol, a
// capital) push people towards Password1! and are not what makes a password
// strong; length is.
function checkPassword(value) {
  const password = String(value ?? "");
  if (password.length < 8) {
    throw badRequest("Password must be at least 8 characters.");
  }
  if (password.length > 200) {
    throw badRequest("That password is too long.");
  }
  return password;
}

// ---------------------------------------------------------------------------
// Login throttling
// ---------------------------------------------------------------------------
// In-memory, per email+IP, and intentionally crude. It exists to make online
// password guessing pointless, not to survive a distributed attack - scrypt
// already makes each attempt expensive. In-memory means a restart clears it,
// which is an acceptable trade for having no extra table and no cleanup job.
const attempts = new Map();
const ATTEMPT_LIMIT = 10;
const ATTEMPT_WINDOW_MS = 15 * 60_000;

function throttleKey(req, email) {
  const ip = req.socket.remoteAddress || "?";
  return `${ip}|${email}`;
}

function checkThrottle(key) {
  const record = attempts.get(key);
  if (!record) return;
  if (Date.now() - record.first > ATTEMPT_WINDOW_MS) {
    attempts.delete(key);
    return;
  }
  if (record.count >= ATTEMPT_LIMIT) {
    throw new ApiError(429, "Too many sign-in attempts. Wait a few minutes and try again.");
  }
}

function recordFailure(key) {
  const record = attempts.get(key);
  if (!record || Date.now() - record.first > ATTEMPT_WINDOW_MS) {
    attempts.set(key, { first: Date.now(), count: 1 });
  } else {
    record.count += 1;
  }
}

// ---------------------------------------------------------------------------
// Serialisation
// ---------------------------------------------------------------------------
// The shape the front-end sees. Written out field by field rather than spreading
// the row, so that adding a column - password_hash being the obvious one - can
// never accidentally start returning it.
function publicUser(row) {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    createdAt: row.created_at,
    hasAvatar: Boolean(row.avatar_blob),
    prefFormat: row.pref_format || null,
    prefOutRule: row.pref_out_rule || null,
    leaderboardOptIn: Boolean(row.leaderboard_opt_in),
  };
}

// The handful of metrics worth calling a "personal best". Picked by key from
// whatever each game module reports, so the dashboard never hard-codes a list
// of games - a module that has no such metric simply contributes nothing.
const BEST_KEYS = new Set([
  "highestCheckout", "highestScore", "threeDart", "first9", "fewestDarts",
  "bestMpr", "whiteHorses", "hatTricks", "highestRound", "bestRound", "bestLeg",
]);

function personalBestsFrom(stats) {
  const bests = [];
  for (const game of stats.games) {
    for (const m of game.metrics) {
      if (!BEST_KEYS.has(m.key)) continue;
      if (!m.value) continue; // a best of zero is not a best
      bests.push({ game: game.key, gameLabel: game.label, ...m });
    }
  }
  return bests;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
const routes = {
  "POST /api/auth/register": async (req, res) => {
    const body = await readJsonBody(req);
    const email = normalizeEmail(body.email);
    const displayName = normalizeDisplayName(body.displayName);
    const password = checkPassword(body.password);

    const db = getDatabase();
    const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
    if (existing) {
      throw new ApiError(409, "That email address already has an account.");
    }

    const { hash, salt } = await hashPassword(password);
    const { lastInsertRowid } = db
      .prepare(
        `INSERT INTO users (email, display_name, password_hash, password_salt, created_at,
                            pref_format, pref_out_rule)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        email, displayName, hash, salt, new Date().toISOString(),
        orNull(body.prefFormat), orNull(body.prefOutRule)
      );

    const user = db.prepare("SELECT * FROM users WHERE id = ?").get(lastInsertRowid);
    const { token, expires } = createSession(user.id, req.headers["user-agent"]);

    sendJson(res, 201, { user: publicUser(user) }, {
      "Set-Cookie": sessionCookie(req, token, expires),
    });
  },

  "POST /api/auth/login": async (req, res) => {
    const body = await readJsonBody(req);
    const email = normalizeEmail(body.email);
    const password = String(body.password ?? "");

    const key = throttleKey(req, email);
    checkThrottle(key);

    const db = getDatabase();
    const user = db.prepare("SELECT * FROM users WHERE email = ?").get(email);

    // Same message and roughly the same work whether the address exists or the
    // password is wrong: telling an attacker which email addresses have
    // accounts is a free gift, and this app's whole login surface is public.
    const ok = user && (await verifyPassword(password, user.password_hash, user.password_salt));
    if (!ok) {
      recordFailure(key);
      throw new ApiError(401, "Email or password is incorrect.");
    }

    attempts.delete(key);
    const { token, expires } = createSession(user.id, req.headers["user-agent"]);
    sendJson(res, 200, { user: publicUser(user) }, {
      "Set-Cookie": sessionCookie(req, token, expires),
    });
  },

  "POST /api/auth/logout": async (req, res) => {
    destroySession(req);
    sendJson(res, 200, { ok: true }, { "Set-Cookie": clearedCookie(req) });
  },

  // The front-end calls this on load to find out whether it is a guest or a
  // signed-in user. A guest is a 200 with user: null, not a 401 - being signed
  // out is a normal state in this app, not an error.
  "GET /api/auth/me": async (req, res, ctx) => {
    sendJson(res, 200, { user: ctx.user ? publicUser(ctx.user) : null });
  },

  "PATCH /api/profile": async (req, res, ctx) => {
    if (!ctx.user) throw unauthorized();
    const body = await readJsonBody(req);
    const db = getDatabase();

    // Every field is optional: the profile page saves the whole form, but a
    // caller that only wants to flip the leaderboard toggle shouldn't have to
    // send a display name back.
    const displayName = body.displayName === undefined
      ? ctx.user.display_name
      : normalizeDisplayName(body.displayName);

    const prefFormat = body.prefFormat === undefined ? ctx.user.pref_format : orNull(body.prefFormat);
    const prefOutRule = body.prefOutRule === undefined ? ctx.user.pref_out_rule : orNull(body.prefOutRule);
    const optIn = body.leaderboardOptIn === undefined
      ? ctx.user.leaderboard_opt_in
      : bool(body.leaderboardOptIn);

    db.prepare(
      `UPDATE users SET display_name = ?, pref_format = ?, pref_out_rule = ?, leaderboard_opt_in = ?
       WHERE id = ?`
    ).run(displayName, prefFormat, prefOutRule, optIn, ctx.user.id);

    const user = db.prepare("SELECT * FROM users WHERE id = ?").get(ctx.user.id);
    sendJson(res, 200, { user: publicUser(user) });
  },

  "POST /api/profile/password": async (req, res, ctx) => {
    if (!ctx.user) throw unauthorized();
    const body = await readJsonBody(req);

    const ok = await verifyPassword(
      String(body.currentPassword ?? ""), ctx.user.password_hash, ctx.user.password_salt
    );
    if (!ok) throw badRequest("Current password is incorrect.");

    const password = checkPassword(body.newPassword);
    const { hash, salt } = await hashPassword(password);
    getDatabase()
      .prepare("UPDATE users SET password_hash = ?, password_salt = ? WHERE id = ?")
      .run(hash, salt, ctx.user.id);

    sendJson(res, 200, { ok: true });
  },

  // Uploaded as a data URL in JSON rather than multipart, because that is what
  // a FileReader in the browser produces directly and multipart parsing would
  // be the one piece of this server that wanted a dependency.
  "PUT /api/profile/avatar": async (req, res, ctx) => {
    if (!ctx.user) throw unauthorized();
    const body = await readJsonBody(req);

    if (body.dataUrl === null) {
      getDatabase()
        .prepare("UPDATE users SET avatar_blob = NULL, avatar_mime = NULL WHERE id = ?")
        .run(ctx.user.id);
      sendJson(res, 200, { ok: true, hasAvatar: false });
      return;
    }

    const match = /^data:([^;,]+);base64,(.+)$/s.exec(String(body.dataUrl ?? ""));
    if (!match) throw badRequest("Send the picture as a base64 data URL.");

    const [, mime, base64] = match;
    if (!AVATAR_TYPES.has(mime)) {
      throw badRequest("Profile pictures must be PNG, JPEG, WebP or GIF.");
    }

    const bytes = Buffer.from(base64, "base64");
    if (bytes.length === 0) throw badRequest("That image was empty.");
    if (bytes.length > MAX_AVATAR_BYTES) {
      throw badRequest("Profile pictures must be under 256KB.");
    }

    getDatabase()
      .prepare("UPDATE users SET avatar_blob = ?, avatar_mime = ? WHERE id = ?")
      .run(new Uint8Array(bytes), mime, ctx.user.id);

    sendJson(res, 200, { ok: true, hasAvatar: true });
  },

  // ---------------------------------------------------------------------
  // Matches
  // ---------------------------------------------------------------------
  // The upload endpoint. 401 here is meaningful rather than terminal: the
  // client keeps the match queued locally and sends it again once there is an
  // account for it to belong to, which is how a guest's history survives to
  // become theirs at sign-up.
  "POST /api/matches": async (req, res, ctx) => {
    if (!ctx.user) throw unauthorized("Sign in to save this match.");
    const body = await readJsonBody(req);
    const { id, duplicate } = insertMatch(ctx.user.id, body.match);

    // Achievements are only evaluated for a match that was actually stored. A
    // duplicate from the retry queue must not re-announce anything, and cannot
    // earn anything new - the statistics are unchanged by definition.
    const unlocked = duplicate ? [] : awardAchievements(ctx.user.id, id);

    // 200 rather than 201 for a duplicate: nothing was created, and the client
    // treats both as "safe to drop from the queue".
    sendJson(res, duplicate ? 200 : 201, { id, duplicate, unlocked });
  },

  // Everything the stats page and dashboard need, in one response: career
  // totals, a section per game that has actually been played, and the trend
  // buckets. Served from a cache that a new match invalidates - see stats.js.
  "GET /api/stats": async (req, res, ctx) => {
    if (!ctx.user) throw unauthorized();
    sendJson(res, 200, { stats: statsFor(ctx.user.id) });
  },

  "GET /api/achievements": async (req, res, ctx) => {
    if (!ctx.user) throw unauthorized();
    sendJson(res, 200, { achievements: achievementsFor(ctx.user.id) });
  },

  // Everything the landing screen shows, in one request. Assembled here rather
  // than left to the client to stitch together from three calls, because the
  // dashboard is the first thing loaded after signing in and three round trips
  // on a phone connection is the difference between instant and sluggish.
  "GET /api/dashboard": async (req, res, ctx) => {
    if (!ctx.user) throw unauthorized();

    const stats = statsFor(ctx.user.id);
    const achievements = achievementsFor(ctx.user.id);

    sendJson(res, 200, {
      dashboard: {
        stats,
        recentMatches: listMatches(ctx.user.id, { limit: 5 }),
        achievements: {
          earned: achievements.filter((a) => a.earned)
            .sort((a, b) => String(b.earnedAt).localeCompare(String(a.earnedAt))),
          total: achievements.length,
        },
        // Personal bests are pulled out of the game modules' own metrics rather
        // than listed here, so a new game's records appear without this
        // endpoint knowing what they are.
        personalBests: personalBestsFrom(stats),
      },
    });
  },

  // ---------------------------------------------------------------------
  // Friends and clubs
  // ---------------------------------------------------------------------
  "GET /api/friends": async (req, res, ctx) => {
    if (!ctx.user) throw unauthorized();
    sendJson(res, 200, { friends: friendsOf(ctx.user.id), clubs: clubsFor(ctx.user.id) });
  },

  "GET /api/users/search": async (req, res, ctx) => {
    if (!ctx.user) throw unauthorized();
    const params = new URL(req.url, "http://localhost").searchParams;
    sendJson(res, 200, { users: searchUsers(params.get("q"), ctx.user.id) });
  },

  "POST /api/friends/request": async (req, res, ctx) => {
    if (!ctx.user) throw unauthorized();
    const body = await readJsonBody(req);
    sendJson(res, 200, requestFriend(ctx.user.id, Number(body.userId)));
  },

  "POST /api/friends/accept": async (req, res, ctx) => {
    if (!ctx.user) throw unauthorized();
    const body = await readJsonBody(req);
    sendJson(res, 200, acceptFriend(ctx.user.id, Number(body.userId)));
  },

  // One endpoint for declining, cancelling and unfriending - see removeFriend.
  "POST /api/friends/remove": async (req, res, ctx) => {
    if (!ctx.user) throw unauthorized();
    const body = await readJsonBody(req);
    sendJson(res, 200, removeFriend(ctx.user.id, Number(body.userId)));
  },

  "POST /api/clubs": async (req, res, ctx) => {
    if (!ctx.user) throw unauthorized();
    const body = await readJsonBody(req);
    sendJson(res, 201, { club: createClub(ctx.user.id, body.name) });
  },

  "POST /api/clubs/join": async (req, res, ctx) => {
    if (!ctx.user) throw unauthorized();
    const body = await readJsonBody(req);
    sendJson(res, 200, { club: joinClub(ctx.user.id, body.slug) });
  },

  "POST /api/clubs/leave": async (req, res, ctx) => {
    if (!ctx.user) throw unauthorized();
    const body = await readJsonBody(req);
    sendJson(res, 200, leaveClub(ctx.user.id, Number(body.clubId)));
  },

  // ---------------------------------------------------------------------
  // Leaderboards
  // ---------------------------------------------------------------------
  "GET /api/leaderboards": async (req, res, ctx) => {
    if (!ctx.user) throw unauthorized();
    sendJson(res, 200, {
      boards: leaderboardCatalogue(),
      clubs: clubsFor(ctx.user.id),
      // The page says plainly whether the viewer is on the boards at all,
      // rather than leaving them wondering why they cannot find themselves.
      optedIn: Boolean(ctx.user.leaderboard_opt_in),
    });
  },

  "GET /api/leaderboard": async (req, res, ctx) => {
    if (!ctx.user) throw unauthorized();
    const params = new URL(req.url, "http://localhost").searchParams;
    const scope = params.get("scope") || "global";
    const clubId = Number(params.get("clubId")) || null;

    sendJson(res, 200, {
      leaderboard: buildLeaderboard({
        boardKey: params.get("board"),
        scope,
        window: params.get("window") || "all",
        userId: ctx.user.id,
        friendIds: scope === "friends" ? friendIds(ctx.user.id) : [],
        clubMemberIds: scope === "club" && clubId ? clubMemberIds(ctx.user.id, clubId) : [],
      }),
    });
  },

  "GET /api/matches": async (req, res, ctx) => {
    if (!ctx.user) throw unauthorized();
    const params = new URL(req.url, "http://localhost").searchParams;
    const matches = listMatches(ctx.user.id, {
      limit: Number(params.get("limit")) || 25,
      before: params.get("before") || null,
    });
    sendJson(res, 200, { matches });
  },
};

// Avatars are served as real images rather than inlined into the profile JSON,
// so the browser caches them and a dashboard listing several players doesn't
// carry their pictures in its payload. Handled outside the route table because
// the user id is in the path.
async function serveAvatar(req, res, userId) {
  const row = getDatabase()
    .prepare("SELECT avatar_blob, avatar_mime FROM users WHERE id = ?")
    .get(userId);

  if (!row?.avatar_blob) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("No avatar");
    return;
  }

  res.writeHead(200, {
    "Content-Type": row.avatar_mime || "application/octet-stream",
    // Private, because it is one user's picture, and short, because changing
    // your picture should show up without a hard refresh.
    "Cache-Control": "private, max-age=300",
  });
  res.end(Buffer.from(row.avatar_blob));
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------
// Returns true if this request was an API request (handled, including errors),
// false if server.js should carry on and try to serve a file.
export async function handleApiRequest(req, res) {
  const path = req.url.split("?")[0];
  if (!path.startsWith("/api/")) return false;

  try {
    const avatarMatch = /^\/api\/users\/(\d+)\/avatar$/.exec(path);
    if (avatarMatch && req.method === "GET") {
      await serveAvatar(req, res, Number(avatarMatch[1]));
      return true;
    }

    // A player's public card, for the lobby. Outside the route table because
    // the id is in the path.
    const profileMatch = /^\/api\/users\/(\d+)\/profile$/.exec(path);
    if (profileMatch && req.method === "GET") {
      const user = userForRequest(req);
      if (!user) throw unauthorized();
      const profile = publicProfileFor(user.id, Number(profileMatch[1]));
      if (!profile) throw new ApiError(404, "No such player.");
      sendJson(res, 200, { profile });
      return true;
    }

    // One match in full, every dart included. Outside the route table for the
    // same reason as avatars: the id is part of the path.
    const matchMatch = /^\/api\/matches\/(\d+)$/.exec(path);
    if (matchMatch && req.method === "GET") {
      const user = userForRequest(req);
      if (!user) throw unauthorized();
      // Scoped to the requesting user inside loadMatch, so asking for someone
      // else's match id is a 404 rather than a leak.
      const match = loadMatch(user.id, Number(matchMatch[1]));
      if (!match) throw new ApiError(404, "No such match.");
      sendJson(res, 200, { match });
      return true;
    }

    const route = routes[`${req.method} ${path}`];
    if (!route) {
      sendJson(res, 404, { error: "No such endpoint." });
      return true;
    }

    // Resolved once per request and passed down, so a route never has to
    // remember to look up the session itself - forgetting that is exactly how
    // an endpoint ends up unauthenticated by accident.
    const ctx = { user: userForRequest(req) };
    await route(req, res, ctx);
  } catch (err) {
    if (err instanceof ApiError) {
      sendJson(res, err.status, { error: err.message, code: err.code });
    } else {
      // An unexpected throw is a bug here, not something the user did. Log the
      // detail, return a generic message: internal errors have a habit of
      // containing file paths and SQL.
      console.error(`API ${req.method} ${path} failed:`, err);
      sendJson(res, 500, { error: "Something went wrong on the server." });
    }
  }

  return true;
}
