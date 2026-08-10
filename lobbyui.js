// lobbyui.js - drawing the lobby, and turning clicks into lobby messages.
//
// Wiring only; lobbyclient.js owns the connection and the state. The lobby is
// shown INSIDE the Online Play tab, above the invite-code panel rather
// than instead of it, which is the whole shape of the feature: the lobby is the
// easy path when you are signed in and someone else is around, and codes remain
// the path that always works.

import {
  subscribeLobby, connectLobby, disconnectLobby, setStatus,
  challengePlayer, respondToChallenge, cancelChallenge,
  createRoom, joinRoom, leaveRoom, sendChat, joinQueue, leaveQueue,
  watchMatch, stopWatching, takeFriendArrival,
} from "./lobbyclient.js";
import { subscribe as subscribeAccount } from "./accountstore.js";
import { gameLabel } from "./medley.js";
import { rankBadge } from "./accountui.js";

const el = {
  panel: document.getElementById("lobby-panel"),
  count: document.getElementById("lobby-count"),
  looking: document.getElementById("lobby-looking"),
  quickMatch: document.getElementById("quick-match-btn"),
  card: document.getElementById("player-card"),
  cardName: document.getElementById("player-card-name"),
  cardSub: document.getElementById("player-card-sub"),
  cardStats: document.getElementById("player-card-stats"),
  cardActions: document.getElementById("player-card-actions"),
  cardClose: document.getElementById("player-card-close"),
  challenges: document.getElementById("lobby-challenges"),
  alert: document.getElementById("challenge-alert"),
  filter: document.getElementById("lobby-filter"),
  scope: document.getElementById("lobby-scope"),
  players: document.getElementById("lobby-players"),
  rooms: document.getElementById("lobby-rooms"),
  roomName: document.getElementById("room-name"),
  roomCreate: document.getElementById("room-create-btn"),
  roomView: document.getElementById("lobby-room-view"),
  roomMembers: document.getElementById("room-members"),
  roomTitle: document.getElementById("room-title"),
  chatLog: document.getElementById("chat-log"),
  chatInput: document.getElementById("chat-input"),
  chatSend: document.getElementById("chat-send-btn"),
  roomLeave: document.getElementById("room-leave-btn"),
  live: document.getElementById("lobby-live"),
  watchPanel: document.getElementById("watch-panel"),
  watchTitle: document.getElementById("watch-title"),
  watchBoard: document.getElementById("watch-board"),
  watchStop: document.getElementById("watch-stop"),
  message: document.getElementById("lobby-message"),
  // Read, never written, so the challenge carries the format the challenger
  // picked on the panel below rather than a second copy of that control.
  format: document.getElementById("online-format"),
};

let latest = null;

// The format currently selected on the Match Settings panel. Sent with a
// challenge so the guest's app knows what it is agreeing to - the host still
// sends the authoritative match_config once connected, exactly as before.
function selectedLegs() {
  const value = el.format?.value;
  return value ? [{ preset: value }] : null;
}

// `kind` matters: the same line carries both "that didn't work" and "your
// friend just arrived", and showing good news in the error red would be a
// small lie every time it happened.
function setMessage(text, kind = "error") {
  el.message.textContent = text || "";
  el.message.classList.remove("error", "ok");
  if (text) el.message.classList.add(kind);
}

// The human name for a format key, taken from the picker that defines those
// keys. A room carries "single-501"; the option in Match Settings already says
// what that means, so reading it back is one list of format names instead of
// two, and the one that would have gone stale is the copy over here.
function formatLabel(key) {
  if (!key) return "";
  const option = el.format?.querySelector(`option[value="${CSS.escape(key)}"]`);
  return option ? option.textContent.trim() : "";
}

// PROFILES FOR THE LIST, fetched once per player and kept.
//
// The record was always one tap away on the player card, which is the wrong
// depth for the question it answers: "am I in for a game here?" is what you ask
// while READING the list, and a card you have to open for each name in turn is
// how you end up challenging whoever is nearest instead.
//
// Lazily from the client rather than in the lobby payload, and that is the
// load-bearing choice. Presence is pushed to everyone on every change - someone
// going idle would otherwise mean reading statistics for every person online and
// sending them all to everybody. Here it is one request per player you can
// actually see, answered from the same `stats_cache` the profile card uses, and
// then never asked again.
const profiles = new Map(); // userId -> profile, or a Promise while in flight

// roomId -> name, refreshed on every render. Kept here so a player row can say
// WHERE someone is standing: once being in a room means the open lobby cannot
// challenge you, a row with no Challenge button has to explain itself, or it
// reads as the app having lost the button.
let roomNames = new Map();

function profileFor(userId) {
  if (profiles.has(userId)) return profiles.get(userId);
  const pending = fetch(`/api/users/${userId}/profile`, { credentials: "same-origin" })
    .then((r) => r.json())
    .then(({ profile }) => {
      profiles.set(userId, profile);
      return profile;
    })
    // Cached as null so a player whose profile cannot be read is not asked for
    // again on every lobby push for the rest of the session.
    .catch(() => {
      profiles.set(userId, null);
      return null;
    });
  profiles.set(userId, pending);
  return pending;
}

// The two figures this app scores people on, and nothing else. A lobby row has
// room for one glance, so it gets the same numbers the rating is built from
// rather than a card's worth of detail - see the note on averages in
// statsengine.js for why these are the 80% ones.
function fillPlayerStats(node, profile) {
  node.textContent = "";
  if (!profile) return;

  // AN EMPTY HEADLINE IS THE SERVER SAYING NO. It withholds the figures for
  // anyone who has opted out of sharing, so "did it send any?" is the whole
  // permission check and this file does not get a second opinion about who may
  // see what. Testing `shared` here instead was subtly wrong in one direction
  // that matters: your OWN card is served in full whatever that flag says - the
  // setting is about what other people see - so reading it would have hidden
  // your figures from you.
  const headline = profile.headline ?? [];
  if (!headline.length) return;

  const parts = [];
  for (const [key, caption] of [["threeDart", "3DA"], ["mpr", "MPR"]]) {
    const metric = headline.find((m) => m.key === key);
    if (metric && Number(metric.value) > 0) {
      parts.push(`${caption} ${Number(metric.value).toFixed(2)}`);
    }
  }
  // Signed up but has not thrown enough for either average to mean anything.
  // Worth saying rather than leaving blank: "no average yet" is real information
  // about an opponent, and it is different from keeping them private.
  node.textContent = parts.length ? parts.join(" · ") : "No average yet";
}

function statusLabel(status) {
  switch (status) {
    case "looking": return "Looking for a match";
    case "in_match": return "In a match";
    case "away": return "Away";
    case "lobby": return "In the lobby";
    default: return "Online";
  }
}

function personRow(player) {
  const row = document.createElement("div");
  row.className = "person-row";

  const avatar = document.createElement("div");
  avatar.className = "board-avatar";
  avatar.textContent = (player.displayName || "?").slice(0, 2).toUpperCase();

  const middle = document.createElement("div");
  const name = document.createElement("div");
  name.className = "person-name clickable";
  // A pair reads as a pair. The partner is someone else's typing arriving over
  // the wire, so it goes in as text and never as markup - see the stored XSS
  // this file already had once, where a display name was interpolated into
  // innerHTML and ran in the challenged player's session.
  name.textContent = player.partner
    ? `${player.displayName} & ${player.partner}`
    : player.displayName + (player.isSelf ? " (you)" : "");
  name.addEventListener("click", () => openCard(player));
  if (player.partner) {
    // Said as well as shown, because "A & B" alone could be one person with an
    // ampersand in their name, and challenging a pair when you have nobody
    // beside you gets you a singles match rather than the game you wanted.
    const tag = document.createElement("span");
    tag.className = "board-you-tag";
    tag.textContent = "doubles";
    name.appendChild(tag);
  }
  if (player.isFriend && !player.isSelf) {
    const tag = document.createElement("span");
    tag.className = "board-you-tag";
    tag.textContent = "friend";
    name.appendChild(tag);
  }

  const sub = document.createElement("div");
  sub.className = "person-sub";
  const dot = document.createElement("span");
  dot.className = `status-dot status-${player.status}`;
  // Where they are standing, when it is somewhere. This is what makes the
  // missing Challenge button legible: "In Steel Tip" and no button says join
  // them there, where an unexplained gap says the app is broken.
  const where = player.roomId ? roomNames.get(player.roomId) : null;
  const status = where && !player.isSelf
    ? `In ${where}`
    : statusLabel(player.status);
  sub.append(dot, document.createTextNode(status));

  // Their record, on the row. Filled in place when the profile arrives rather
  // than by re-rendering the lobby: a push can replace these rows at any moment,
  // and a late fetch writing into a node that has since been detached is
  // harmless, where a re-render per profile would redraw the list N times.
  const stats = document.createElement("div");
  stats.className = "person-stats";
  // The rank goes on the NAME, the same place the player card puts it, because
  // it is the one thing that answers "am I in for a game here?" before any of
  // the numbers do.
  const show = (profile) => {
    fillPlayerStats(stats, profile);
    if (profile?.shared && profile.rating) name.appendChild(rankBadge(profile.rating));
  };
  const cached = profiles.get(player.userId);
  if (cached && typeof cached.then !== "function") show(cached);
  else profileFor(player.userId).then(show);

  middle.append(name, sub, stats);

  const actions = document.createElement("div");
  actions.className = "person-actions";
  if (player.challengeable) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "btn-ink";
    button.textContent = "Challenge";
    button.addEventListener("click", () => {
      setMessage("");
      challengePlayer(player.userId, selectedLegs());
    });
    actions.appendChild(button);
  }

  row.append(avatar, middle, actions);
  return row;
}

function challengeCard(challenge, incoming) {
  const card = document.createElement("div");
  card.className = "challenge-card";

  // Built as DOM rather than an HTML string, because the name in it belongs to
  // ANOTHER PLAYER and display names are whatever they typed. Interpolating one
  // into innerHTML is stored cross-user XSS: set your name to an <img> with an
  // onerror handler, challenge someone, and the script runs in their session
  // with their cookie. textContent cannot execute anything.
  const text = document.createElement("div");
  text.className = "challenge-text";
  const who = document.createElement("strong");
  who.textContent = incoming ? challenge.fromName : challenge.toName;

  if (incoming) text.append(who, document.createTextNode(" challenged you"));
  else text.append(document.createTextNode("Waiting for "), who);

  const actions = document.createElement("div");
  actions.className = "person-actions";

  if (incoming) {
    const accept = document.createElement("button");
    accept.type = "button";
    accept.className = "btn-ink";
    accept.textContent = "Accept";
    accept.addEventListener("click", () => respondToChallenge(challenge.id, true));

    const decline = document.createElement("button");
    decline.type = "button";
    decline.className = "btn-quiet";
    decline.textContent = "Decline";
    decline.addEventListener("click", () => respondToChallenge(challenge.id, false));

    actions.append(accept, decline);
  } else {
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "btn-quiet";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => cancelChallenge(challenge.id));
    actions.appendChild(cancel);
  }

  card.append(text, actions);
  return card;
}

// ---------------------------------------------------------------------------
// Player card
// ---------------------------------------------------------------------------
// Their actual record, fetched when asked for rather than pushed with the lobby
// - a lobby of thirty people should not carry thirty sets of statistics that
// nobody has looked at.
async function openCard(player) {
  el.card.classList.remove("hidden");
  el.cardName.textContent = player.displayName;
  el.cardSub.textContent = "Loading…";
  el.cardStats.innerHTML = "";
  el.cardActions.innerHTML = "";

  if (player.challengeable) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "btn-primary";
    button.textContent = "Challenge";
    button.addEventListener("click", () => {
      challengePlayer(player.userId, selectedLegs());
      el.card.classList.add("hidden");
    });
    el.cardActions.appendChild(button);
  }

  try {
    const { profile } = await fetch(`/api/users/${player.userId}/profile`, { credentials: "same-origin" })
      .then((r) => r.json());

    const joined = profile.joinedAt
      ? new Date(profile.joinedAt).toLocaleDateString(undefined, { year: "numeric", month: "long" })
      : "";

    if (!profile.shared) {
      // Not a failure, and worth saying plainly rather than showing an empty
      // card that looks broken.
      el.cardSub.textContent = `Playing since ${joined} · keeps their statistics private`;
      return;
    }

    el.cardSub.textContent =
      `Playing since ${joined}${profile.achievements ? ` · ${profile.achievements} achievements` : ""}`;

    // Rank first: it is the one number that answers "am I in for a game here?"
    if (profile.rating) {
      el.cardName.appendChild(document.createTextNode(" "));
      el.cardName.appendChild(rankBadge(profile.rating));
    }

    for (const metric of profile.headline) {
      const tile = document.createElement("div");
      tile.className = "stat-tile";
      const value = document.createElement("div");
      value.className = "stat-value";
      value.textContent = metric.format === "percent"
        ? `${metric.value}%`
        : metric.format === "decimal" ? Number(metric.value).toFixed(2) : metric.value;
      const label = document.createElement("div");
      label.className = "stat-label";
      label.textContent = metric.label;
      tile.append(value, label);
      el.cardStats.appendChild(tile);
    }
  } catch {
    el.cardSub.textContent = "Couldn't load that profile.";
  }
}

el.cardClose.addEventListener("click", () => el.card.classList.add("hidden"));

el.watchStop.addEventListener("click", () => {
  if (latest?.watching) stopWatching(latest.watching.code);
});

// The spectator scoreboard. Deliberately just that: this is a copy the players
// push, not a second connection into their match, and nothing here can affect
// what they are playing.
function renderWatch(watching) {
  el.watchTitle.textContent = watching.players.map((p) => p.displayName).join(" v ");
  el.watchBoard.innerHTML = "";

  const state = watching.state;
  if (!state) {
    const waiting = document.createElement("div");
    waiting.className = "people-empty";
    waiting.textContent = "Waiting for the first darts…";
    el.watchBoard.appendChild(waiting);
    return;
  }

  watching.players.forEach((player, seat) => {
    const box = document.createElement("div");
    const throwing = state.activeSeat === seat && !state.over;
    box.className = `watch-player${throwing ? " throwing" : ""}`;

    const name = document.createElement("div");
    name.className = "watch-name";
    name.textContent = player.displayName;

    const score = document.createElement("div");
    score.className = "watch-score";
    score.textContent = state.scores?.[seat] ?? "-";

    const turn = document.createElement("div");
    turn.className = "watch-turn";
    // The ring says whose turn it is; this says it in words too.
    turn.textContent = state.over ? "match over" : throwing ? "throwing" : " ";

    box.append(name, score, turn);
    el.watchBoard.appendChild(box);
  });

  const legs = state.legsWon ?? [];
  if (legs.length > 1) {
    const tally = document.createElement("div");
    tally.className = "person-sub";
    tally.style.width = "100%";
    tally.textContent = `Legs: ${legs.join(" - ")}`;
    el.watchBoard.appendChild(tally);
  }
}

function renderChat(messages) {
  el.chatLog.innerHTML = "";
  if (!messages.length) {
    const empty = document.createElement("div");
    empty.className = "chat-line chat-empty";
    empty.textContent = "Nothing said yet.";
    el.chatLog.appendChild(empty);
    return;
  }

  for (const message of messages) {
    const line = document.createElement("div");
    line.className = `chat-line${message.system ? " system" : ""}${message.whisper ? " whisper" : ""}`;

    if (message.system) {
      line.textContent = message.text;
    } else {
      const who = document.createElement("span");
      who.className = "chat-who";
      who.textContent = `${message.fromName}${message.whisper ? " (whisper)" : ""}: `;
      line.append(who, document.createTextNode(message.text));
    }
    el.chatLog.appendChild(line);
  }
  // Pinned to the newest line, which is the only one anyone is reading.
  el.chatLog.scrollTop = el.chatLog.scrollHeight;
}

// Incoming challenges, rendered OUTSIDE the online panel so they are visible
// from any tab. This is separate from the in-panel cards on purpose: those are
// part of the lobby screen, and this is the thing that makes sure a challenge
// is not missed by someone who happens to be looking at their statistics.
function renderAlert(state) {
  el.alert.innerHTML = "";
  const incoming = state.incoming ?? [];
  el.alert.classList.toggle("hidden", incoming.length === 0);
  if (!incoming.length) return;

  const challenge = incoming[incoming.length - 1];

  const text = document.createElement("div");
  text.className = "challenge-text";
  const who = document.createElement("strong");
  // textContent, always - this is another player's display name.
  who.textContent = challenge.fromName;
  text.append(who, document.createTextNode(" wants to play you"));

  const actions = document.createElement("div");
  actions.className = "person-actions";

  const accept = document.createElement("button");
  accept.type = "button";
  accept.className = "btn-ink";
  accept.textContent = "Accept";
  accept.addEventListener("click", () => respondToChallenge(challenge.id, true));

  const decline = document.createElement("button");
  decline.type = "button";
  decline.className = "btn-quiet";
  decline.textContent = "Decline";
  decline.addEventListener("click", () => respondToChallenge(challenge.id, false));

  actions.append(accept, decline);
  el.alert.append(text, actions);
}

function render(state) {
  latest = state;
  // Before the early return below: a challenge must show even when the lobby
  // panel itself is not on screen, which is the entire bug this fixes.
  renderAlert(state);

  // The panel exists only when there is a working lobby to show. Everything
  // else on the tab - creating a code, joining one - works regardless, so a
  // missing lobby costs nothing rather than breaking the screen.
  const show = state.connection === "open";
  el.panel.classList.toggle("hidden", !show);
  if (!show) return;

  el.count.textContent = state.count === 1
    ? "1 player online"
    : `${state.count} players online`;

  // Quick Match doubles as its own cancel button while queued, so there is one
  // control rather than two that contradict each other.
  const queued = state.queued !== null;
  el.quickMatch.textContent = queued
    ? `Waiting… (${state.queued} in queue) · Cancel`
    : "Quick Match";
  el.quickMatch.classList.toggle("btn-primary", !queued);
  el.quickMatch.classList.toggle("btn-quiet", queued);

  setMessage(state.error);

  el.challenges.innerHTML = "";
  for (const challenge of state.incoming) el.challenges.appendChild(challengeCard(challenge, true));
  for (const challenge of state.outgoing) el.challenges.appendChild(challengeCard(challenge, false));

  const term = el.filter.value.trim().toLowerCase();
  const friendsOnly = el.scope.value === "friends";

  // Before any row is built, since personRow reads it to say where someone is.
  roomNames = new Map(state.rooms.map((r) => [r.id, r.name]));

  // The switch was write-only: it SET your status and was never set back from
  // it, so after a reconnect the box and the server disagreed - and now that
  // being in a room hangs off this, a stale tick is the difference between
  // "anyone can challenge me" and nobody being able to. The server's view of
  // your own status is the one that decides.
  const self = state.players.find((p) => p.isSelf);
  const openToAll = self?.status === "looking";
  if (el.looking) el.looking.checked = openToAll;

  // Friends first, then anyone actively looking, then everyone else. The point
  // of a lobby is finding someone to play right now, so the people most likely
  // to say yes are the ones at the top.
  const rank = (p) => (p.isFriend ? 0 : 2) + (p.status === "looking" ? -1 : 0);
  const players = state.players
    .filter((p) => !friendsOnly || p.isFriend || p.isSelf)
    .filter((p) => !term || p.displayName.toLowerCase().includes(term))
    .sort((a, b) => rank(a) - rank(b) || a.displayName.localeCompare(b.displayName));

  el.players.innerHTML = "";
  if (!players.length) {
    const empty = document.createElement("div");
    empty.className = "people-empty";
    empty.textContent = state.count <= 1
      ? "Nobody else is here yet. Send someone a challenge code in the meantime."
      : "No players match that.";
    el.players.appendChild(empty);
  } else {
    for (const player of players) el.players.appendChild(personRow(player));
  }

  el.rooms.innerHTML = "";
  if (!state.rooms.length) {
    const empty = document.createElement("div");
    empty.className = "people-empty";
    empty.textContent = "No rooms open. Create one and people can join you.";
    el.rooms.appendChild(empty);
  } else {
    for (const room of state.rooms) {
      const row = document.createElement("div");
      row.className = "person-row";

      const avatar = document.createElement("div");
      avatar.className = "board-avatar";
      avatar.textContent = room.name.slice(0, 2).toUpperCase();

      const middle = document.createElement("div");
      const name = document.createElement("div");
      name.className = "person-name";
      name.textContent = room.name;
      const sub = document.createElement("div");
      sub.className = "person-sub";
      // An empty room used to be impossible - it was swept the moment the last
      // person left - so "0 in here" is a state only the standing rooms can
      // reach, and it is the state they exist for. Worded as an invitation
      // rather than a count, because a permanent room reading "0 in here" looks
      // broken rather than available.
      const who = room.members === 0
        ? "Nobody here yet - be the first"
        : `${room.members} in here`;
      // The room's format, named by the picker that owns those keys rather than
      // by a lookup table here - two lists of format names is one that goes
      // stale, and it would be this one.
      const label = formatLabel(room.game);
      sub.textContent = label ? `${label} · ${who}` : who;
      middle.append(name, sub);

      const actions = document.createElement("div");
      actions.className = "person-actions";
      if (state.room?.id !== room.id) {
        const join = document.createElement("button");
        join.type = "button";
        join.className = "btn-quiet";
        join.textContent = "Join";
        join.addEventListener("click", () => joinRoom(room.id));
        actions.appendChild(join);
      }

      row.append(avatar, middle, actions);
      el.rooms.appendChild(row);
    }
  }

  // Matches in progress, and the one being watched.
  el.live.innerHTML = "";
  if (!state.live.length) {
    const empty = document.createElement("div");
    empty.className = "people-empty";
    empty.textContent = "Nobody is playing right now.";
    el.live.appendChild(empty);
  } else {
    for (const match of state.live) {
      const row = document.createElement("div");
      row.className = "person-row";

      const avatar = document.createElement("div");
      avatar.className = "board-avatar";
      avatar.textContent = "VS";

      const middle = document.createElement("div");
      const name = document.createElement("div");
      name.className = "person-name";
      name.textContent = match.players.map((p) => p.displayName).join(" v ");
      const sub = document.createElement("div");
      sub.className = "person-sub";
      sub.textContent = match.watchers === 1 ? "1 watching" : `${match.watchers} watching`;
      middle.append(name, sub);

      const actions = document.createElement("div");
      actions.className = "person-actions";
      if (state.watching?.code !== match.code) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "btn-quiet";
        btn.textContent = "Watch";
        btn.addEventListener("click", () => watchMatch(match.code));
        actions.appendChild(btn);
      }

      row.append(avatar, middle, actions);
      el.live.appendChild(row);
    }
  }

  el.watchPanel.classList.toggle("hidden", !state.watching);
  if (state.watching) renderWatch(state.watching);

  el.roomView.classList.toggle("hidden", !state.room);
  if (state.room) {
    // The roster, built from the SAME player objects the main list uses - so a
    // row in here carries the same rank, averages and Challenge button, and
    // "anyone in a room can be challenged" is finally true in the one place
    // where you would go looking for it.
    //
    // Filtered client-side from presence rather than sent with the room: every
    // player already arrives carrying their roomId, so the membership is
    // knowledge the client has, and asking the server for a second copy is how
    // the two end up disagreeing about who is in here.
    //
    // Deliberately NOT passed through the search box and Friends-only filter
    // above. Those belong to the lobby list; a room is already a filter, and
    // silently applying a second one would show an empty room to anyone who had
    // left a name in the search box.
    const members = state.players
      .filter((p) => p.roomId === state.room.id)
      .sort((a, b) => a.displayName.localeCompare(b.displayName));

    // Says the rule where it applies, and names the way out of it. Standing in a
    // room quietly stops the open lobby challenging you, and a rule nobody is
    // told about reads as people ignoring you.
    el.roomTitle.textContent = state.room.name;
    const note = document.createElement("span");
    note.className = "room-scope-note";
    note.textContent = el.looking?.checked
      ? " · anyone in the lobby can challenge you"
      : " · only people in here can challenge you";
    el.roomTitle.appendChild(note);

    el.roomMembers.innerHTML = "";
    if (members.length <= 1) {
      const empty = document.createElement("div");
      empty.className = "people-empty";
      // <= 1 rather than 0: you are in here yourself, so an otherwise empty room
      // is a list of one, and "nobody else" is the honest way to say it.
      empty.textContent = "Nobody else in here yet. Anyone who joins shows up here.";
      el.roomMembers.appendChild(empty);
    } else {
      for (const player of members) el.roomMembers.appendChild(personRow(player));
    }

    renderChat(state.messages);
  }
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------
el.quickMatch.addEventListener("click", () => {
  if (latest?.queued !== null && latest?.queued !== undefined) leaveQueue();
  else joinQueue();
});

el.looking.addEventListener("change", () => {
  setStatus(el.looking.checked ? "looking" : "lobby");
});

el.filter.addEventListener("input", () => latest && render(latest));
el.scope.addEventListener("change", () => latest && render(latest));

el.roomCreate.addEventListener("click", () => {
  const name = el.roomName.value.trim();
  if (!name) return;
  createRoom(name, el.format?.value || null);
  el.roomName.value = "";
});

el.roomLeave.addEventListener("click", () => leaveRoom());

function submitChat() {
  const text = el.chatInput.value.trim();
  if (!text) return;
  sendChat(text);
  el.chatInput.value = "";
}

el.chatSend.addEventListener("click", submitChat);
el.chatInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") submitChat();
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
subscribeLobby((state) => {
  render(state);
  // A friend arriving is announced once, in the lobby's own message line -
  // never as a dialog, which would interrupt a match in progress.
  const arrival = takeFriendArrival();
  if (arrival) setMessage(`${arrival.displayName} just came online.`, "ok");
});

// The lobby follows the account: it needs a session to authenticate the socket,
// and it should not sit connected for someone who has signed out.
subscribeAccount(({ user, ready }) => {
  if (!ready) return;
  if (user) connectLobby();
  else disconnectLobby();
});
