// accountstore.js - the browser's half of accounts: session state and the
// /api calls that change it.
//
// Everything the UI knows about "who is signed in" comes from here, and the UI
// never calls fetch itself. That split exists because there are three places
// the answer can come from - a live server, no server at all (the Android APK
// is the front-end with nothing behind it), and a server that has accounts
// switched off - and every screen would otherwise have to handle all three.
//
// The important design point: NOT being signed in is a normal state, not an
// error. Guests play darts here, and always will. Nothing in this module ever
// blocks, redirects, or nags - it reports what it knows and the UI decides.

const listeners = new Set();

const state = {
  // The signed-in user, or null for a guest.
  user: null,
  // Whether this build can talk to an accounts API at all. False in the
  // Android wrapper, false offline, false when the server couldn't open its
  // database. The UI uses it to hide sign-in rather than offer a button that
  // cannot work.
  available: false,
  // False until the first /api/auth/me has settled, so the UI can avoid
  // flashing "Sign in" at someone who turns out to be signed in already.
  ready: false,
  // Bumped whenever the set of stored matches changes - a match finishing, or
  // the queue draining to the server. The history and statistics screens watch
  // this instead of re-fetching on every notification, which is how a match
  // played after the page loaded shows up without a refresh.
  matchesVersion: 0,
};

export function getState() {
  return { ...state };
}

// Returns an unsubscribe function, so a caller that renders once and goes away
// doesn't leak a listener.
export function subscribe(fn) {
  listeners.add(fn);
  fn(getState());
  return () => listeners.delete(fn);
}

function notify() {
  const snapshot = getState();
  for (const fn of listeners) fn(snapshot);
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------
// One place that knows about cookies, JSON and error shape.
//
// `credentials: "same-origin"` is the default for same-origin requests, but is
// stated explicitly because the session cookie is the entire auth mechanism and
// a future change that makes these cross-origin would break it silently.
export class ApiUnavailable extends Error {}

async function apiFetch(path, { method = "GET", body, bearer = null } = {}) {
  let response;
  try {
    response = await fetch(path, {
      method,
      credentials: "same-origin",
      headers: {
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        // A partner's token, for the one route that accepts one. It rides in a
        // header rather than the cookie because the cookie is HttpOnly and
        // there is one per browser - see POST /api/auth/partner.
        ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    // Network-level failure: offline, or no server behind this page at all.
    // Distinguished from an HTTP error because it means "try again later",
    // never "you did something wrong".
    state.available = false;
    throw new ApiUnavailable("No connection to the server.");
  }

  // 503 is what server.js returns when its database wouldn't open. Treated the
  // same as being offline: accounts are simply not on offer right now.
  if (response.status === 503) {
    state.available = false;
    throw new ApiUnavailable("Accounts are unavailable on this server.");
  }

  state.available = true;

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const error = new Error(payload?.error || "Something went wrong.");
    error.status = response.status;
    error.code = payload?.code || null;
    throw error;
  }

  return payload;
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------
// Called once at startup. Failures are swallowed on purpose: a guest with no
// server should see the app exactly as they always have, not an error.
export async function refresh() {
  try {
    const { user } = await apiFetch("/api/auth/me");
    state.user = user;
  } catch (err) {
    state.user = null;
    if (!(err instanceof ApiUnavailable)) {
      console.warn("Could not check sign-in state:", err.message);
    }
  } finally {
    state.ready = true;
    notify();
  }
  // Anything queued while offline or before signing in goes up now. Not
  // awaited: the page should not wait on someone else's backlog to render.
  if (state.user) flushQueue().catch(() => {});
  return getState();
}

export async function register({ email, displayName, password, prefFormat, prefOutRule }) {
  const { user } = await apiFetch("/api/auth/register", {
    method: "POST",
    body: { email, displayName, password, prefFormat, prefOutRule },
  });
  state.user = user;
  notify();
  // The moment an account exists, the matches played as a guest belong to it.
  flushQueue().catch(() => {});
  return user;
}

export async function login({ email, password }) {
  const { user } = await apiFetch("/api/auth/login", {
    method: "POST",
    body: { email, password },
  });
  state.user = user;
  notify();
  flushQueue().catch(() => {});
  return user;
}

// Asks for a reset link. Returns whatever the server said, which is
// deliberately the same sentence whether or not the address has an account -
// see the note on the endpoint. Nothing about local state changes: asking for
// a link does not sign anybody in or out.
export async function requestPasswordReset(email) {
  return apiFetch("/api/auth/forgot", { method: "POST", body: { email } });
}

// Is a reset link still usable? Asked before showing a password form, so a dead
// link is refused up front rather than after someone has chosen a password.
// Read-only: this consumes nothing and changes no local state.
export async function checkResetToken(token) {
  try {
    const { valid } = await apiFetch("/api/auth/reset/check", {
      method: "POST",
      body: { token },
    });
    return Boolean(valid);
  } catch {
    // Offline, or no accounts API. Treat as usable and let the submit decide -
    // refusing here would strand someone whose link is fine on a flaky
    // connection, which is worse than one wasted attempt.
    return true;
  }
}

// Redeems a link. The server signs the user straight back in, so this behaves
// like login from here on - including flushing any guest matches, since the
// person may have played some while locked out.
export async function resetPassword({ token, password }) {
  const { user } = await apiFetch("/api/auth/reset", {
    method: "POST",
    body: { token, password },
  });
  state.user = user;
  notify();
  flushQueue().catch(() => {});
  return user;
}

// The local state is cleared even if the request fails. Someone who clicks
// "Sign out" on a flaky connection expects to be signed out of the screen in
// front of them; the server-side session expires on its own.
export async function logout() {
  try {
    await apiFetch("/api/auth/logout", { method: "POST" });
  } finally {
    state.user = null;
    // The owner of the board leaving takes their guest with them. Leaving a
    // partner signed in after the person who let them in has gone is the one
    // outcome nobody would expect.
    partnerSession = null;
    notify();
  }
}

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------
// Every field is optional - the server treats an absent key as "leave it
// alone", so a single toggle doesn't have to send the whole profile back.
export async function updateProfile(changes) {
  const { user } = await apiFetch("/api/profile", { method: "PATCH", body: changes });
  state.user = user;
  notify();
  return user;
}

export async function changePassword({ currentPassword, newPassword }) {
  return apiFetch("/api/profile/password", {
    method: "POST",
    body: { currentPassword, newPassword },
  });
}

// dataUrl of null removes the picture. The 256KB server cap is checked here too
// so an over-sized file is rejected before it is uploaded, with a message that
// says what to do about it.
export async function uploadAvatar(dataUrl) {
  if (dataUrl && dataUrl.length > 350_000) {
    throw new Error("That picture is too large - pick one under 256KB.");
  }
  const result = await apiFetch("/api/profile/avatar", { method: "PUT", body: { dataUrl } });
  if (state.user) {
    state.user = { ...state.user, hasAvatar: Boolean(result.hasAvatar) };
    notify();
  }
  return result;
}

// Cache-busted on every render so a freshly uploaded picture actually appears -
// the response is cacheable for five minutes, which is right for repeat views
// and wrong for the moment you change it.
export function avatarUrl(user, bust = "") {
  if (!user?.hasAvatar) return null;
  return `/api/users/${user.id}/avatar${bust ? `?v=${bust}` : ""}`;
}

// ---------------------------------------------------------------------------
// The match queue
// ---------------------------------------------------------------------------
// Completed matches are written to localStorage FIRST and uploaded afterwards,
// never the other way round. Three things fall out of that, and all three are
// the point rather than a side effect:
//
//   * A match played offline - on a phone at a club with no signal, or in the
//     Android wrapper, which has no server at all - is not lost.
//   * A match played as a guest is kept. When that person later creates an
//     account, their darts are already there to upload: the history they
//     built before signing up becomes theirs rather than being the price of
//     having waited.
//   * Nothing about finishing a match depends on the network. The upload is
//     something that happens afterwards, so a slow server can never delay the
//     end of a game.
//
// The upload is idempotent on the match's client-generated UUID (see
// matchrecorder.js), which is what makes retrying safe.
const QUEUE_KEY = "aiodarts-match-queue";

// localStorage is a few megabytes and shared with everything else this origin
// stores. A hundred un-uploaded matches is already far past "briefly offline"
// and into "this will never be uploaded", so the oldest are dropped rather than
// growing until writes start failing.
const QUEUE_LIMIT = 100;

function readQueue() {
  try {
    const raw = localStorage.getItem(QUEUE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeQueue(queue) {
  try {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
    return true;
  } catch (err) {
    // Quota exceeded, or storage disabled entirely (private browsing on some
    // browsers). Not fatal - the match is lost, the game is not.
    console.warn("Could not save match locally:", err.message);
    return false;
  }
}

export function queuedMatchCount() {
  return readQueue().length;
}

export function queuedMatches() {
  return readQueue();
}

// Called when a match ends. Returns immediately after storing; the upload is
// attempted in the background and its failure is not the caller's problem.
export function recordMatch(document) {
  const queue = readQueue();
  queue.push(document);
  while (queue.length > QUEUE_LIMIT) queue.shift();
  writeQueue(queue);

  // Tell the screens straight away. A finished match is history the moment it
  // is stored, whether or not the upload has happened yet.
  state.matchesVersion += 1;
  notify();

  // Deliberately not awaited by callers: the end-of-match screen should not
  // wait on a network round trip.
  flushQueue().catch(() => {});
  return document.clientUuid;
}

// ---------------------------------------------------------------------------
// The partner at your board
// ---------------------------------------------------------------------------
// IN MEMORY ONLY, and that is the point rather than a shortcut. A partner is a
// guest at somebody else's board: persisting their token would leave them
// signed in on hardware they do not own, and a reload, a tab close or the
// owner signing out all correctly end it.
//
// It is not part of `state` and is never notified to the UI as an account,
// because it is NOT a second signed-in user - the app has one of those. It is
// a capability to file one person's darts under one person's name.
let partnerSession = null;

export function getPartner() {
  return partnerSession ? { ...partnerSession, token: undefined } : null;
}

export async function signInPartner(email, password) {
  const { user, token } = await apiFetch("/api/auth/partner", {
    method: "POST", body: { email, password },
  });
  partnerSession = { userId: user.id, displayName: user.displayName, token };
  return getPartner();
}

export function signOutPartner() {
  partnerSession = null;
}

// The partner's own copy of a finished match.
//
// The SAME document, with isSelf moved to their seat - which is exactly what
// an online match already does, where both players record their own copy of
// the same darts and neither is the authority. client_uuid is scoped per user,
// so the two rows are each legitimately their own rather than a duplicate.
//
// Best-effort and NOT queued: the offline queue lives in localStorage, and
// queuing this would mean writing a credential to disk to retry it later. A
// partner whose upload fails is told, and can throw again another day; that is
// a better trade than persisting somebody else's session on your board.
export async function recordMatchForPartner(document, seat) {
  if (!partnerSession) return { uploaded: false, reason: "no-partner" };

  // The seat is named after the ACCOUNT this copy is being filed under, not
  // after whatever was typed into a name box. The token decides where these
  // darts land, so anything else on that seat is a label that can disagree with
  // its own destination - and did: a partner signed in as one person while the
  // name box still held another produced a match in their history whose "self"
  // seat carried somebody else's name.
  const theirs = {
    ...document,
    players: (document.players ?? []).map((p) => (p.seat === seat
      ? { ...p, isSelf: true, displayName: partnerSession.displayName || p.displayName }
      : { ...p, isSelf: false })),
  };

  try {
    await apiFetch("/api/matches", {
      method: "POST", body: { match: theirs }, bearer: partnerSession.token,
    });
    return { uploaded: true };
  } catch (err) {
    return { uploaded: false, reason: err?.message || "failed" };
  }
}

let flushing = false;

export async function flushQueue() {
  if (flushing) return { uploaded: 0 };
  const queue = readQueue();
  if (!queue.length) return { uploaded: 0 };

  flushing = true;
  let uploaded = 0;

  try {
    // One at a time, oldest first, stopping at the first sign the server can't
    // take them. Firing them all in parallel would turn a flaky connection
    // into a burst of failures and reorder someone's history for no benefit.
    while (true) {
      const pending = readQueue();
      if (!pending.length) break;
      const match = pending[0];

      try {
        const result = await apiFetch("/api/matches", { method: "POST", body: { match } });
        if (result?.unlocked?.length) pendingUnlocks.push(...result.unlocked);
      } catch (err) {
        if (err instanceof ApiUnavailable) break;

        // 401 means nobody is signed in. The match stays queued - this is the
        // guest case, and those matches are waiting for an account to belong
        // to, not failing.
        if (err.status === 401) break;

        // A 4xx that isn't 401 means this particular match will never be
        // accepted - a malformed document from an older build, most likely.
        // Dropping it is better than blocking every match behind it forever.
        if (err.status >= 400 && err.status < 500) {
          console.warn("Discarding a match the server rejected:", err.message);
          writeQueue(readQueue().slice(1));
          continue;
        }

        break; // 5xx: the server's problem, try again later
      }

      writeQueue(readQueue().slice(1));
      uploaded += 1;
    }
  } finally {
    flushing = false;
  }

  // Only when something actually moved: an empty flush must not cause a
  // re-render, or the history screen would refetch on every idle attempt.
  if (uploaded > 0) {
    state.matchesVersion += 1;
    notify();
  }

  return { uploaded };
}

// ---------------------------------------------------------------------------
// History and statistics
// ---------------------------------------------------------------------------
export async function fetchMatches({ limit = 25, before } = {}) {
  const params = new URLSearchParams({ limit: String(limit) });
  if (before) params.set("before", before);
  return apiFetch(`/api/matches?${params}`);
}

export async function fetchMatch(id) {
  return apiFetch(`/api/matches/${id}`);
}

export async function fetchStats() {
  return apiFetch("/api/stats");
}

export async function fetchDashboard() {
  return apiFetch("/api/dashboard");
}

// ---------------------------------------------------------------------------
// Leaderboards, friends and clubs
// ---------------------------------------------------------------------------
export async function fetchBoardCatalogue() {
  return apiFetch("/api/leaderboards");
}

export async function fetchLeaderboard({ board, scope = "global", window = "all", clubId }) {
  const params = new URLSearchParams({ board, scope, window });
  if (clubId) params.set("clubId", String(clubId));
  return apiFetch(`/api/leaderboard?${params}`);
}

export async function fetchFriends() {
  return apiFetch("/api/friends");
}

export async function searchPlayers(query) {
  return apiFetch(`/api/users/search?q=${encodeURIComponent(query)}`);
}

export async function friendAction(action, userId) {
  return apiFetch(`/api/friends/${action}`, { method: "POST", body: { userId } });
}

export async function createClub(name) {
  return apiFetch("/api/clubs", { method: "POST", body: { name } });
}

export async function joinClub(slug) {
  return apiFetch("/api/clubs/join", { method: "POST", body: { slug } });
}

export async function leaveClub(clubId) {
  return apiFetch("/api/clubs/leave", { method: "POST", body: { clubId } });
}

export async function fetchAchievements() {
  return apiFetch("/api/achievements");
}

// Achievements unlocked by matches that have just been uploaded, waiting to be
// shown once. Read and cleared by the UI - kept here rather than passed back
// through the upload call because the upload happens in the background, long
// after the code that finished the match has moved on.
let pendingUnlocks = [];

export function takeUnlocks() {
  const unlocks = pendingUnlocks;
  pendingUnlocks = [];
  return unlocks;
}
