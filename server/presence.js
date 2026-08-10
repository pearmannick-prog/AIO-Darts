// presence.js - who is online, and what they are doing.
//
// THIS IS THE SWAP POINT. Everything here is in-memory and therefore
// single-process: presence dies with the server, and two instances behind a
// load balancer would each see half the lobby. That is the right trade today -
// this app has tens of players, not thousands, and the in-memory version is a
// fraction of the code of a distributed one.
//
// It is deliberately kept behind a small interface so that when a second
// process is genuinely needed, the change is this file plus a pub/sub bus
// (Redis, or Postgres LISTEN/NOTIFY) and NOT the lobby protocol, the UI, or
// anything else. Paying for the distributed version before there is a second
// process would be guessing at a problem that may never arrive.
//
// Presence is NOT persisted, and shouldn't be. "Alice was online three hours
// ago, before the server restarted" is not a useful thing to tell anyone.

// The states a player can be in. Ordered loosely by how interruptible they are,
// which is the order the lobby sorts by.
export const STATUS = Object.freeze({
  LOOKING: "looking",   // actively wants a match - the top of the lobby
  LOBBY: "lobby",       // in the lobby, open to being challenged
  ONLINE: "online",     // signed in and connected, but not in the lobby screen
  IN_MATCH: "in_match",  // playing - cannot be challenged
  AWAY: "away",         // idle
});

const CHALLENGEABLE = new Set([STATUS.LOOKING, STATUS.LOBBY, STATUS.ONLINE]);

export function isChallengeable(status) {
  return CHALLENGEABLE.has(status);
}

export function createPresence() {
  // userId -> entry. One entry per PERSON, not per connection.
  const entries = new Map();
  // userId -> Set<WebSocket>. A player with the app open on a phone and a
  // laptop is one presence with two sockets; going offline means the last one
  // closing, not the first.
  const sockets = new Map();

  const listeners = new Set();

  function notify(event) {
    for (const fn of listeners) {
      try {
        fn(event);
      } catch (err) {
        console.warn("Presence listener failed:", err.message);
      }
    }
  }

  return {
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    // Returns true if this is the player's FIRST connection, which is what the
    // lobby uses to decide whether anyone needs telling they arrived.
    attach(user, socket) {
      if (!sockets.has(user.id)) sockets.set(user.id, new Set());
      const set = sockets.get(user.id);
      const first = set.size === 0;
      set.add(socket);

      if (first) {
        entries.set(user.id, {
          userId: user.id,
          displayName: user.display_name,
          hasAvatar: Boolean(user.avatar_blob),
          status: STATUS.ONLINE,
          preferredGame: user.pref_format || null,
          // The name of whoever is standing at this player's board with them,
          // or null. LOCAL doubles only, which is why it is a bare string and
          // not a user id: a partner shares a board, so they need no account,
          // no connection and no presence of their own. See
          // docs/team-play.md section 0.
          partner: null,
          roomId: null,
          since: Date.now(),
        });
        notify({ type: "joined", userId: user.id });
      }

      return first;
    },

    // Returns { wasLast, entry } - and `entry` is the state as it was JUST
    // BEFORE removal, which the caller needs. Returning only a boolean was a
    // bug: the disconnect handler has to know which room the player was in to
    // take them out of it, and by then presence.get() answers null, so every
    // disconnect silently left the player in the room forever.
    detach(userId, socket) {
      const set = sockets.get(userId);
      if (!set) return { wasLast: false, entry: null };

      set.delete(socket);
      if (set.size > 0) return { wasLast: false, entry: entries.get(userId) ?? null };

      const entry = entries.get(userId) ?? null;
      sockets.delete(userId);
      entries.delete(userId);
      notify({ type: "left", userId });
      return { wasLast: true, entry };
    },

    update(userId, patch) {
      const entry = entries.get(userId);
      if (!entry) return null;
      Object.assign(entry, patch);
      notify({ type: "updated", userId });
      return entry;
    },

    get(userId) {
      return entries.get(userId) ?? null;
    },

    socketsFor(userId) {
      return sockets.get(userId) ?? new Set();
    },

    isOnline(userId) {
      return entries.has(userId);
    },

    all() {
      return [...entries.values()];
    },

    count() {
      return entries.size;
    },

    // Every connected socket, for a lobby-wide broadcast.
    everySocket() {
      const out = [];
      for (const set of sockets.values()) out.push(...set);
      return out;
    },
  };
}
