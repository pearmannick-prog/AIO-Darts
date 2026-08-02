// social.js - friends and clubs.
//
// The relationships leaderboards are filtered by, and nothing else. No
// statistics are stored or computed here; a friends board is the same query as
// a global one with a different set of user ids.

import { getDatabase } from "./db.js";
import { ApiError } from "./api-error.js";

function fail(status, message) {
  return new ApiError(status, message);
}

// The public view of another player. Deliberately minimal: a display name and a
// picture is everything anyone needs to recognise a friend, and an email
// address is not something to hand out because two people are on the same
// leaderboard.
export function publicProfile(row) {
  return {
    id: row.id,
    displayName: row.display_name,
    hasAvatar: Boolean(row.avatar_blob ?? row.has_avatar),
  };
}

// ---------------------------------------------------------------------------
// Finding people
// ---------------------------------------------------------------------------
// By display name only, and never by email - being able to type an address and
// learn whether it has an account is a way of confirming someone's identity
// that this app has no reason to offer.
//
// A short query is rejected rather than answered, because "a" would return the
// user list.
export function searchUsers(query, excludeUserId) {
  const term = String(query ?? "").trim();
  if (term.length < 2) throw fail(400, "Type at least two characters to search.");

  return getDatabase()
    .prepare(
      `SELECT id, display_name, avatar_blob IS NOT NULL AS has_avatar
       FROM users
       WHERE display_name LIKE ? AND id <> ?
       ORDER BY display_name LIMIT 20`
    )
    .all(`%${term}%`, excludeUserId)
    .map(publicProfile);
}

// ---------------------------------------------------------------------------
// Friends
// ---------------------------------------------------------------------------
export function friendsOf(userId) {
  const db = getDatabase();

  const accepted = db.prepare(
    `SELECT u.id, u.display_name, u.avatar_blob IS NOT NULL AS has_avatar
     FROM friends f JOIN users u ON u.id = f.friend_user_id
     WHERE f.user_id = ? AND f.status = 'accepted'
     ORDER BY u.display_name`
  ).all(userId).map(publicProfile);

  // Requests sent to this user and not yet answered.
  const incoming = db.prepare(
    `SELECT u.id, u.display_name, u.avatar_blob IS NOT NULL AS has_avatar
     FROM friends f JOIN users u ON u.id = f.user_id
     WHERE f.friend_user_id = ? AND f.status = 'pending'
     ORDER BY f.created_at`
  ).all(userId).map(publicProfile);

  // Requests this user has sent, so the button can say "requested" rather than
  // offering to send it again.
  const outgoing = db.prepare(
    `SELECT u.id, u.display_name, u.avatar_blob IS NOT NULL AS has_avatar
     FROM friends f JOIN users u ON u.id = f.friend_user_id
     WHERE f.user_id = ? AND f.status = 'pending'
     ORDER BY f.created_at`
  ).all(userId).map(publicProfile);

  return { accepted, incoming, outgoing };
}

export function requestFriend(userId, targetId) {
  if (userId === targetId) throw fail(400, "You are already your own best opponent.");

  const db = getDatabase();
  const target = db.prepare("SELECT id FROM users WHERE id = ?").get(targetId);
  if (!target) throw fail(404, "No such player.");

  const existing = db
    .prepare("SELECT status FROM friends WHERE user_id = ? AND friend_user_id = ?")
    .get(userId, targetId);
  if (existing?.status === "accepted") throw fail(409, "You are already friends.");
  if (existing?.status === "pending") throw fail(409, "You have already asked.");

  // If THEY asked first, this is an acceptance rather than a new request.
  // Otherwise two people who both pressed the button would sit waiting for each
  // other indefinitely.
  const reverse = db
    .prepare("SELECT status FROM friends WHERE user_id = ? AND friend_user_id = ?")
    .get(targetId, userId);
  if (reverse?.status === "pending") {
    acceptFriend(userId, targetId);
    return { status: "accepted" };
  }

  db.prepare(
    "INSERT INTO friends (user_id, friend_user_id, status, created_at) VALUES (?, ?, 'pending', ?)"
  ).run(userId, targetId, new Date().toISOString());

  return { status: "pending" };
}

// `userId` is the person accepting; `requesterId` sent it.
export function acceptFriend(userId, requesterId) {
  const db = getDatabase();
  const pending = db
    .prepare("SELECT status FROM friends WHERE user_id = ? AND friend_user_id = ?")
    .get(requesterId, userId);
  if (!pending) throw fail(404, "There is no request from that player.");

  const now = new Date().toISOString();
  db.prepare(
    "UPDATE friends SET status = 'accepted' WHERE user_id = ? AND friend_user_id = ?"
  ).run(requesterId, userId);

  // The matching row for the other direction, so both sides can list their
  // friends with the same one-column lookup.
  db.prepare(
    `INSERT INTO friends (user_id, friend_user_id, status, created_at)
     VALUES (?, ?, 'accepted', ?)
     ON CONFLICT(user_id, friend_user_id) DO UPDATE SET status = 'accepted'`
  ).run(userId, requesterId, now);

  return { status: "accepted" };
}

// Covers declining a request, cancelling one, and removing a friend - all three
// are "there should be no relationship between us", and keeping a record of a
// declined request serves nobody.
export function removeFriend(userId, otherId) {
  const db = getDatabase();
  db.prepare(
    "DELETE FROM friends WHERE (user_id = ? AND friend_user_id = ?) OR (user_id = ? AND friend_user_id = ?)"
  ).run(userId, otherId, otherId, userId);
  return { ok: true };
}

export function friendIds(userId) {
  return getDatabase()
    .prepare("SELECT friend_user_id FROM friends WHERE user_id = ? AND status = 'accepted'")
    .all(userId)
    .map((row) => row.friend_user_id);
}

// ---------------------------------------------------------------------------
// Clubs
// ---------------------------------------------------------------------------
// A slug is the invite. There is no directory to browse, so a club is private
// unless someone shares its slug - which is the same trust model as the
// challenge codes the app already uses for online matches.
function slugify(name) {
  const slug = String(name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  return slug;
}

export function createClub(userId, name) {
  const clean = String(name ?? "").trim();
  if (clean.length < 2 || clean.length > 40) throw fail(400, "Club names are 2-40 characters.");

  const base = slugify(clean);
  if (!base) throw fail(400, "That name has no letters or numbers in it.");

  const db = getDatabase();
  const now = new Date().toISOString();

  // Collisions are resolved by suffix rather than rejected: two pub teams
  // called "The Griffin" is a likely thing, not a mistake worth an error.
  let slug = base;
  for (let attempt = 2; attempt < 50; attempt++) {
    const taken = db.prepare("SELECT id FROM clubs WHERE slug = ?").get(slug);
    if (!taken) break;
    slug = `${base}-${attempt}`;
  }

  const { lastInsertRowid } = db
    .prepare("INSERT INTO clubs (name, slug, created_by, created_at) VALUES (?, ?, ?, ?)")
    .run(clean, slug, userId, now);

  db.prepare(
    "INSERT INTO club_members (club_id, user_id, role, joined_at) VALUES (?, ?, 'owner', ?)"
  ).run(lastInsertRowid, userId, now);

  return clubsFor(userId).find((c) => c.id === Number(lastInsertRowid));
}

export function joinClub(userId, slug) {
  const db = getDatabase();
  const club = db.prepare("SELECT * FROM clubs WHERE slug = ?").get(String(slug ?? "").trim().toLowerCase());
  if (!club) throw fail(404, "No club with that code.");

  db.prepare(
    `INSERT INTO club_members (club_id, user_id, role, joined_at) VALUES (?, ?, 'member', ?)
     ON CONFLICT(club_id, user_id) DO NOTHING`
  ).run(club.id, userId, new Date().toISOString());

  return clubsFor(userId).find((c) => c.id === club.id);
}

export function leaveClub(userId, clubId) {
  const db = getDatabase();
  db.prepare("DELETE FROM club_members WHERE club_id = ? AND user_id = ?").run(clubId, userId);
  // A club nobody is in is not a club. Deleting it frees the slug and stops the
  // table filling with abandoned rows.
  const remaining = db
    .prepare("SELECT COUNT(*) AS n FROM club_members WHERE club_id = ?")
    .get(clubId);
  if (!remaining.n) db.prepare("DELETE FROM clubs WHERE id = ?").run(clubId);
  return { ok: true };
}

export function clubsFor(userId) {
  return getDatabase()
    .prepare(
      `SELECT c.id, c.name, c.slug, m.role,
              (SELECT COUNT(*) FROM club_members cm WHERE cm.club_id = c.id) AS members
       FROM club_members m JOIN clubs c ON c.id = m.club_id
       WHERE m.user_id = ?
       ORDER BY c.name`
    )
    .all(userId)
    .map((row) => ({
      id: row.id, name: row.name, slug: row.slug, role: row.role, members: row.members,
    }));
}

export function clubMemberIds(userId, clubId) {
  const db = getDatabase();
  // Only a member may see a club's board - the slug is the invite, and a
  // non-member holding an id should not be able to read the membership.
  const isMember = db
    .prepare("SELECT 1 AS ok FROM club_members WHERE club_id = ? AND user_id = ?")
    .get(clubId, userId);
  if (!isMember) throw fail(403, "You are not in that club.");

  return db
    .prepare("SELECT user_id FROM club_members WHERE club_id = ?")
    .all(clubId)
    .map((row) => row.user_id);
}
