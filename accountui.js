// accountui.js - the account screens: sign in, create account, profile.
//
// Wiring only. Every decision about what is true (is anyone signed in? is there
// even a server?) belongs to accountstore.js; this file turns that into DOM and
// turns clicks back into calls. Same split as game.js/scoring.js elsewhere in
// the project, for the same reason: the interesting logic stays testable and
// the DOM code stays boring.
//
// The load-bearing rule for this whole screen: a guest is never interrupted.
// The account tab and header chip do not exist at all until the app has
// confirmed there is an accounts API behind it, and nothing here ever pops up
// over a game in progress.

import {
  subscribe, refresh, register, login, logout,
  updateProfile, changePassword, uploadAvatar, avatarUrl, ApiUnavailable,
  fetchMatches, fetchStats, fetchDashboard, fetchAchievements,
  fetchBoardCatalogue, fetchLeaderboard, fetchFriends, searchPlayers,
  friendAction, createClub, joinClub, leaveClub,
  queuedMatchCount, queuedMatches, flushQueue, takeUnlocks,
} from "./accountstore.js";
import { gameLabel } from "./medley.js";
import { lineChart, barChart, chartTable } from "./charts.js";
import { gameLabelFor, computeStats } from "./statsengine.js";

const el = {
  chip: document.getElementById("account-chip"),
  chipLabel: document.getElementById("account-chip-label"),
  chipAvatar: document.getElementById("account-chip-avatar"),
  tab: document.getElementById("tab-account"),

  authPanel: document.getElementById("account-auth"),
  homePanel: document.getElementById("account-home"),
  nav: document.getElementById("account-nav"),
  dashPanel: document.getElementById("account-dashboard"),
  dashAvatar: document.getElementById("dash-avatar"),
  dashName: document.getElementById("dash-name"),
  dashSub: document.getElementById("dash-sub"),
  dashHeadline: document.getElementById("dash-headline"),
  dashRecent: document.getElementById("dash-recent"),
  dashBests: document.getElementById("dash-bests"),
  dashAchievements: document.getElementById("dash-achievements"),
  dashChart: document.getElementById("dash-chart"),
  dashMessage: document.getElementById("dash-message"),

  boardsPanel: document.getElementById("account-leaderboards"),
  boardSelect: document.getElementById("board-select"),
  boardScope: document.getElementById("board-scope"),
  boardClub: document.getElementById("board-club"),
  boardWindow: document.getElementById("board-window"),
  boardTable: document.getElementById("board-table"),
  boardMessage: document.getElementById("board-message"),
  boardOptIn: document.getElementById("board-optin"),
  boardQualification: document.getElementById("board-qualification"),

  friendsPanel: document.getElementById("account-friends"),
  friendSearch: document.getElementById("friend-search"),
  friendResults: document.getElementById("friend-results"),
  friendRequests: document.getElementById("friend-requests"),
  friendList: document.getElementById("friend-list"),
  friendMessage: document.getElementById("friend-message"),
  clubList: document.getElementById("club-list"),
  clubName: document.getElementById("club-name"),
  clubSlug: document.getElementById("club-slug"),
  clubCreateBtn: document.getElementById("club-create-btn"),
  clubJoinBtn: document.getElementById("club-join-btn"),

  achievementsPanel: document.getElementById("account-achievements"),
  achievementList: document.getElementById("achievement-list"),
  achievementCount: document.getElementById("achievement-count"),
  achievementMessage: document.getElementById("achievement-message"),

  statsPanel: document.getElementById("account-stats"),
  statsSections: document.getElementById("stats-sections"),
  statsCounted: document.getElementById("stats-counted"),
  statsMessage: document.getElementById("stats-message"),
  trendGrain: document.getElementById("trend-grain"),
  trendCharts: document.getElementById("trend-charts"),
  trendTableToggle: document.getElementById("trend-table-toggle"),
  historyPanel: document.getElementById("account-history"),
  historyList: document.getElementById("history-list"),
  historyMore: document.getElementById("history-more"),
  historyMessage: document.getElementById("history-message"),
  historyQueueNote: document.getElementById("history-queue-note"),

  loginForm: document.getElementById("login-form"),
  loginEmail: document.getElementById("login-email"),
  loginPassword: document.getElementById("login-password"),
  loginMessage: document.getElementById("login-message"),

  registerForm: document.getElementById("register-form"),
  registerName: document.getElementById("register-name"),
  registerEmail: document.getElementById("register-email"),
  registerPassword: document.getElementById("register-password"),
  registerFormat: document.getElementById("register-format"),
  registerOutRule: document.getElementById("register-outrule"),
  registerMessage: document.getElementById("register-message"),

  avatar: document.getElementById("account-avatar"),
  displayName: document.getElementById("account-display-name"),
  meta: document.getElementById("account-meta"),

  profileForm: document.getElementById("profile-form"),
  profileName: document.getElementById("profile-name"),
  profileFormat: document.getElementById("profile-format"),
  profileOutRule: document.getElementById("profile-outrule"),
  profileLeaderboard: document.getElementById("profile-leaderboard"),
  profileMessage: document.getElementById("profile-message"),

  avatarInput: document.getElementById("avatar-input"),
  avatarChoose: document.getElementById("avatar-choose"),
  avatarRemove: document.getElementById("avatar-remove"),
  avatarMessage: document.getElementById("avatar-message"),

  passwordForm: document.getElementById("password-form"),
  passwordCurrent: document.getElementById("password-current"),
  passwordNew: document.getElementById("password-new"),
  passwordMessage: document.getElementById("password-message"),

  logoutBtn: document.getElementById("logout-btn"),
};

// Bumped whenever the picture changes, and appended to the avatar URL. The
// response is cached for five minutes, which is right for repeat page views and
// exactly wrong for the second after you upload a new one.
let avatarVersion = 0;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
function setMessage(node, text, kind = "error") {
  node.textContent = text || "";
  node.classList.remove("error", "ok");
  if (text) node.classList.add(kind);
}

// Errors from the store come in two flavours and deserve different words: a
// validation failure is something to fix, a missing server is something to wait
// out. Everything else is unexpected and says so plainly.
function describeError(err) {
  if (err instanceof ApiUnavailable) {
    return "Can't reach the server right now. Your darts still work offline.";
  }
  return err?.message || "Something went wrong.";
}

// Disabled while a request is in flight, so a double-tap on a slow connection
// doesn't create two accounts or two sessions.
async function withBusy(button, fn) {
  if (!button) return fn();
  const label = button.textContent;
  button.disabled = true;
  try {
    return await fn();
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
}

function initials(name) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "●";
  return parts.length === 1
    ? parts[0].slice(0, 2).toUpperCase()
    : (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// An <img> when there's a picture, initials when there isn't. Written as a
// swap of innerHTML rather than a hidden img so a removed picture leaves no
// broken-image icon behind.
function paintAvatar(node, user, size) {
  const url = avatarUrl(user, avatarVersion);
  if (url) {
    node.innerHTML = "";
    const img = document.createElement("img");
    img.src = url;
    img.alt = "";
    img.width = size;
    img.height = size;
    img.style.cssText = "width:100%;height:100%;object-fit:cover;border-radius:50%";
    node.appendChild(img);
  } else {
    node.textContent = initials(user?.displayName);
  }
}

function formatJoined(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
// Which account screen is showing. Must match whichever .account-nav-btn is
// marked active in index.html - they are two halves of the same fact, and when
// they disagree the page renders one screen while the nav highlights another.
// Reset to the default whenever someone signs out, so the next person to sign
// in doesn't land on the last one's page.
let view = "dashboard";

// The most recent account state, kept so that switching sub-screens can
// re-render without waiting for the store to notify about something.
let accountSnapshot = { user: null, available: false, ready: false };

function render({ user, available, ready }) {
  // Nothing at all until we know: showing "Sign in" and then swapping it for a
  // name half a second later is a flicker on every single page load.
  // The tab appears when there is either an accounts API to use or local
  // matches to show. The second case is what keeps statistics working in the
  // Android build and offline, where there is no server to ask.
  const show = ready && (available || queuedMatchCount() > 0);
  el.chip.classList.toggle("hidden", !ready || !available);
  el.tab.classList.toggle("hidden", !show);

  if (!show) return;

  el.chipLabel.textContent = user ? user.displayName : "Sign in";
  paintAvatar(el.chipAvatar, user, 24);

  // Signed out, the sign-in form and the local statistics sit on the same
  // screen: the statistics are the reason to want the account, so hiding them
  // behind it would be exactly backwards.
  el.authPanel.classList.toggle("hidden", Boolean(user) || !available);
  el.nav.classList.toggle("hidden", !user);
  el.dashPanel.classList.toggle("hidden", !user || view !== "dashboard");
  el.achievementsPanel.classList.toggle("hidden", !user || view !== "achievements");
  el.boardsPanel.classList.toggle("hidden", !user || view !== "leaderboards");
  el.friendsPanel.classList.toggle("hidden", !user || view !== "friends");
  el.statsPanel.classList.toggle("hidden", user ? view !== "stats" : false);
  el.historyPanel.classList.toggle("hidden", !user || view !== "history");
  el.homePanel.classList.toggle("hidden", !user || view !== "profile");

  if (!user) {
    view = "dashboard";
    historyLoaded = false;
    dashLoaded = false;
    achievementsLoaded = false;
    boardsLoaded = false;
    friendsLoaded = false;
    // The guest statistics screen is still live, so it is refreshed rather
    // than reset - a match just played as a guest should appear on it.
    if (!statsLoaded || statsSeen !== accountSnapshot.matchesVersion) {
      statsSeen = accountSnapshot.matchesVersion;
      loadStats();
    }
    return;
  }

  el.displayName.textContent = user.displayName;
  el.meta.textContent = `${user.email} · joined ${formatJoined(user.createdAt)}`;
  paintAvatar(el.avatar, user, 56);

  // The form is only repopulated from the server's copy - it is never the place
  // the value is remembered - so a failed save leaves the screen showing what
  // is actually stored rather than what was typed.
  el.profileName.value = user.displayName;
  el.profileFormat.value = user.prefFormat || "";
  el.profileOutRule.value = user.prefOutRule || "double";
  el.profileLeaderboard.checked = Boolean(user.leaderboardOptIn);

  // Refetched when there is something new to show, not on every notification:
  // saving a profile also notifies, and reloading the whole history because a
  // display name changed would be silly. matchesVersion changes exactly when a
  // match is finished or uploaded, which is exactly when this is stale.
  const version = accountSnapshot.matchesVersion;

  if (view === "history" && (!historyLoaded || matchesSeen !== version)) {
    matchesSeen = version;
    loadHistory({ reset: true });
  }

  if (view === "stats" && (!statsLoaded || statsSeen !== version)) {
    statsSeen = version;
    loadStats();
  }

  if (view === "dashboard" && (!dashLoaded || dashSeen !== version)) {
    dashSeen = version;
    loadDashboard();
  }

  if (view === "achievements" && (!achievementsLoaded || achievementsSeen !== version)) {
    achievementsSeen = version;
    loadAchievements();
  }

  // These two are reloaded on every visit rather than watched for staleness:
  // both depend on OTHER people's play, which no local signal can tell us
  // about, so "the moment you looked" is the only sensible refresh point.
  if (view === "leaderboards") loadLeaderboard();
  if (view === "friends" && !friendsLoaded) loadFriends();
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------
let dashLoaded = false;
let dashSeen = -1;

// The five numbers worth putting at the top. Everything else is a click away on
// the statistics screen - a dashboard that shows forty metrics is a statistics
// page with a different name.
function headlineMetrics(stats) {
  const career = stats.career.metrics;
  const pick = (metrics, key) => metrics.find((m) => m.key === key);
  const x01 = stats.games.find((g) => g.key === "x01");
  const cricket = stats.games.find((g) => g.key === "cricket");

  return [
    pick(career, "played"),
    pick(career, "winPct"),
    pick(career, "currentStreak"),
    x01 ? pick(x01.metrics, "threeDart") : null,
    cricket ? pick(cricket.metrics, "mpr") : null,
  ].filter(Boolean);
}

async function loadDashboard() {
  setMessage(el.dashMessage, "");
  try {
    const { dashboard } = await fetchDashboard();
    dashLoaded = true;
    renderDashboard(dashboard);
  } catch (err) {
    setMessage(el.dashMessage, describeError(err));
  }
}

function renderDashboard(dashboard) {
  const user = accountSnapshot.user;
  const { stats, recentMatches, achievements, personalBests } = dashboard;

  paintAvatar(el.dashAvatar, user, 56);
  el.dashName.textContent = user?.displayName || "Player";
  // The game's own module is the naming authority, so this reads "Cricket" and
  // "X01" rather than the raw keys they are stored under.
  el.dashSub.textContent = stats.career.raw.favourite
    ? `Mostly plays ${gameLabelFor(stats.career.raw.favourite)}`
    : "No matches yet";

  el.dashHeadline.innerHTML = "";
  for (const m of headlineMetrics(stats)) el.dashHeadline.appendChild(statTile(m));

  el.dashRecent.innerHTML = "";
  if (!recentMatches.length) {
    const empty = document.createElement("div");
    empty.className = "history-empty";
    empty.textContent = "Nothing played yet.";
    el.dashRecent.appendChild(empty);
  } else {
    for (const match of recentMatches) el.dashRecent.appendChild(historyRow(match));
  }

  el.dashBests.innerHTML = "";
  if (!personalBests.length) {
    const empty = document.createElement("div");
    empty.className = "badge-empty";
    empty.textContent = "Personal bests appear once you have played a few legs.";
    el.dashBests.appendChild(empty);
  } else {
    for (const best of personalBests) {
      el.dashBests.appendChild(statTile({ ...best, label: `${best.gameLabel} · ${best.label}` }));
    }
  }

  el.dashAchievements.innerHTML = "";
  if (!achievements.earned.length) {
    const empty = document.createElement("div");
    empty.className = "badge-empty";
    empty.textContent = `None yet - there are ${achievements.total} to go after.`;
    el.dashAchievements.appendChild(empty);
  } else {
    // The most recent handful; the full cabinet has its own screen.
    for (const a of achievements.earned.slice(0, 8)) {
      const badge = document.createElement("span");
      badge.className = "badge";
      badge.textContent = `★ ${a.label}`;
      badge.title = a.description;
      el.dashAchievements.appendChild(badge);
    }
  }

  // One chart, and it answers the question a dashboard is for: am I getting
  // better? The rest of the trends live on the statistics screen.
  const buckets = (stats.trends.weekly ?? []).filter((b) => b.x01Darts > 0);
  lineChart(el.dashChart, {
    data: buckets.map((b) => ({ label: b.key, value: b.threeDartAverage, detail: `${b.key} · ${b.x01Darts} darts` })),
    format: (v) => Number(v).toFixed(1),
    empty: "Play a few x01 legs and your form appears here.",
  });
}

// ---------------------------------------------------------------------------
// Achievements
// ---------------------------------------------------------------------------
let achievementsLoaded = false;
let achievementsSeen = -1;

async function loadAchievements() {
  setMessage(el.achievementMessage, "");
  try {
    const { achievements } = await fetchAchievements();
    achievementsLoaded = true;
    renderAchievements(achievements);
  } catch (err) {
    setMessage(el.achievementMessage, describeError(err));
  }
}

function renderAchievements(achievements) {
  const earned = achievements.filter((a) => a.earned).length;
  el.achievementCount.textContent = `${earned} of ${achievements.length} earned`;
  el.achievementList.innerHTML = "";

  // Grouped by the game that declared them, which is also how they are
  // declared in the code - so a new game's achievements appear as their own
  // group with nothing here changed.
  const groups = new Map();
  for (const a of achievements) {
    if (!groups.has(a.gameLabel)) groups.set(a.gameLabel, []);
    groups.get(a.gameLabel).push(a);
  }

  for (const [label, items] of groups) {
    const heading = document.createElement("div");
    heading.className = "achievement-group";
    heading.textContent = label;
    el.achievementList.appendChild(heading);

    // Earned first within a group: the cabinet reads better than the to-do list.
    for (const a of [...items].sort((x, y) => Number(y.earned) - Number(x.earned))) {
      const row = document.createElement("div");
      row.className = `achievement-row ${a.earned ? "earned" : "locked"}`;

      const mark = document.createElement("div");
      mark.className = "achievement-mark";
      mark.textContent = a.earned ? "★" : "☆";

      const middle = document.createElement("div");
      const name = document.createElement("div");
      name.className = "achievement-name";
      name.textContent = a.label;
      const desc = document.createElement("div");
      desc.className = "achievement-desc";
      desc.textContent = a.description;
      middle.append(name, desc);

      const when = document.createElement("div");
      when.className = "achievement-when";
      // Never state by colour alone - an earned badge carries its date and a
      // locked one says the word.
      when.textContent = a.earned ? formatJoined(a.earnedAt) : "Locked";

      row.append(mark, middle, when);
      el.achievementList.appendChild(row);
    }
  }
}

// ---------------------------------------------------------------------------
// Leaderboards
// ---------------------------------------------------------------------------
let boardsLoaded = false;
let boardCatalogue = null;

function fillBoardSelect(boards) {
  el.boardSelect.innerHTML = "";
  // Grouped by the game that declared the board, which is also how they are
  // declared - so a new game's boards appear as their own group with nothing
  // here changed.
  const groups = new Map();
  for (const board of boards) {
    if (!groups.has(board.group)) groups.set(board.group, []);
    groups.get(board.group).push(board);
  }
  for (const [label, items] of groups) {
    const group = document.createElement("optgroup");
    group.label = label;
    for (const board of items) {
      const option = document.createElement("option");
      option.value = board.key;
      option.textContent = board.label;
      group.appendChild(option);
    }
    el.boardSelect.appendChild(group);
  }
}

async function loadBoardCatalogue() {
  const data = await fetchBoardCatalogue();
  boardCatalogue = data;
  boardsLoaded = true;

  fillBoardSelect(data.boards);

  el.boardClub.innerHTML = "";
  for (const club of data.clubs) {
    const option = document.createElement("option");
    option.value = String(club.id);
    option.textContent = `${club.name} (${club.members})`;
    el.boardClub.appendChild(option);
  }
  // Offering a club scope with no clubs to pick would be a dead end.
  el.boardScope.querySelector('option[value="club"]').disabled = data.clubs.length === 0;

  setMessage(
    el.boardOptIn,
    data.optedIn
      ? ""
      : "You are not shown on leaderboards. Turn that on under Profile if you want to appear.",
    "ok"
  );
}

function boardRow(entry, board, isYou) {
  const row = document.createElement("div");
  row.className = `board-row${isYou ? " you" : ""}`;

  const rank = document.createElement("div");
  rank.className = "board-rank";
  rank.textContent = `#${entry.rank}`;

  const avatar = document.createElement("div");
  avatar.className = "board-avatar";
  paintAvatar(avatar, { displayName: entry.displayName, hasAvatar: entry.hasAvatar, id: entry.userId }, 28);

  const name = document.createElement("div");
  name.className = "board-name";
  name.textContent = entry.displayName;
  if (isYou) {
    // The highlight is reinforced with a word, so the viewer's own row is not
    // identified by colour alone.
    const tag = document.createElement("span");
    tag.className = "board-you-tag";
    tag.textContent = "You";
    name.appendChild(tag);
  }

  const value = document.createElement("div");
  value.className = "board-value";
  value.textContent = formatMetric(entry.value, board.format);

  row.append(rank, avatar, name, value);
  return row;
}

async function loadLeaderboard() {
  setMessage(el.boardMessage, "");
  try {
    if (!boardsLoaded) await loadBoardCatalogue();

    const scope = el.boardScope.value;
    el.boardClub.classList.toggle("hidden", scope !== "club");

    const { leaderboard } = await fetchLeaderboard({
      board: el.boardSelect.value,
      scope,
      window: el.boardWindow.value,
      clubId: scope === "club" ? Number(el.boardClub.value) : null,
    });

    // The qualification is stated next to the board rather than hidden, because
    // "why am I not on this?" is otherwise unanswerable.
    el.boardQualification.textContent = leaderboard.board.minimum
      ? `Qualification: ${leaderboard.board.minimum}`
      : "";

    el.boardTable.innerHTML = "";
    if (!leaderboard.entries.length) {
      const empty = document.createElement("div");
      empty.className = "people-empty";
      empty.textContent = leaderboard.board.minimum
        ? `Nobody has qualified yet (${leaderboard.board.minimum}).`
        : "No scores on this board yet.";
      el.boardTable.appendChild(empty);
      return;
    }

    for (const entry of leaderboard.entries) {
      el.boardTable.appendChild(boardRow(entry, leaderboard.board, entry.userId === accountSnapshot.user?.id));
    }

    // Someone outside the top fifty still gets to see where they stand, which
    // is the only reason most people open a leaderboard a second time.
    const shown = leaderboard.entries.some((e) => e.userId === accountSnapshot.user?.id);
    if (leaderboard.you && !shown) {
      const gap = document.createElement("div");
      gap.className = "board-gap";
      gap.textContent = "···";
      el.boardTable.append(gap, boardRow(leaderboard.you, leaderboard.board, true));
    }
  } catch (err) {
    setMessage(el.boardMessage, describeError(err));
  }
}

for (const control of ["boardSelect", "boardScope", "boardWindow", "boardClub"]) {
  el[control].addEventListener("change", loadLeaderboard);
}

// A monthly view only exists for boards whose trend buckets carry the number.
// The control is disabled rather than silently ignored when it does not.
el.boardSelect.addEventListener("change", () => {
  const monthlyCapable = new Set([
    "career-wins", "career-winpct", "x01-average", "x01-checkout", "x01-180s", "cricket-mpr",
  ]);
  const supported = monthlyCapable.has(el.boardSelect.value);
  el.boardWindow.querySelector('option[value="month"]').disabled = !supported;
  if (!supported) el.boardWindow.value = "all";
});

// ---------------------------------------------------------------------------
// Friends and clubs
// ---------------------------------------------------------------------------
let friendsLoaded = false;

function personRow(person, actions, subtitle) {
  const row = document.createElement("div");
  row.className = "person-row";

  const avatar = document.createElement("div");
  avatar.className = "board-avatar";
  paintAvatar(avatar, { displayName: person.displayName, hasAvatar: person.hasAvatar, id: person.id }, 32);

  const middle = document.createElement("div");
  const name = document.createElement("div");
  name.className = "person-name";
  name.textContent = person.displayName;
  middle.appendChild(name);
  if (subtitle) {
    const sub = document.createElement("div");
    sub.className = "person-sub";
    sub.textContent = subtitle;
    middle.appendChild(sub);
  }

  const buttons = document.createElement("div");
  buttons.className = "person-actions";
  for (const action of actions) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = action.primary ? "btn-ink" : "btn-quiet";
    button.textContent = action.label;
    button.addEventListener("click", () => action.run());
    buttons.appendChild(button);
  }

  row.append(avatar, middle, buttons);
  return row;
}

function fillList(node, rows, emptyText) {
  node.innerHTML = "";
  if (!rows.length) {
    const empty = document.createElement("div");
    empty.className = "people-empty";
    empty.textContent = emptyText;
    node.appendChild(empty);
    return;
  }
  for (const row of rows) node.appendChild(row);
}

async function loadFriends() {
  setMessage(el.friendMessage, "");
  try {
    const { friends, clubs } = await fetchFriends();
    friendsLoaded = true;

    fillList(el.friendRequests, friends.incoming.map((person) =>
      personRow(person, [
        { label: "Accept", primary: true, run: () => runFriendAction("accept", person.id) },
        { label: "Decline", run: () => runFriendAction("remove", person.id) },
      ], "wants to be friends")
    ), "No requests.");

    fillList(el.friendList, [
      ...friends.accepted.map((person) =>
        personRow(person, [{ label: "Remove", run: () => runFriendAction("remove", person.id) }])),
      ...friends.outgoing.map((person) =>
        personRow(person, [{ label: "Cancel", run: () => runFriendAction("remove", person.id) }], "request sent")),
    ], "No friends yet - search for someone above.");

    fillList(el.clubList, clubs.map((club) =>
      personRow(
        { displayName: club.name, hasAvatar: false, id: `club-${club.id}` },
        [{ label: "Leave", run: () => runLeaveClub(club.id) }],
        // The slug is the invite, so it is shown rather than buried.
        `${club.members} member${club.members === 1 ? "" : "s"} · code: ${club.slug}`
      )
    ), "Not in any clubs.");
  } catch (err) {
    setMessage(el.friendMessage, describeError(err));
  }
}

async function runFriendAction(action, userId) {
  setMessage(el.friendMessage, "");
  try {
    await friendAction(action, userId);
    await loadFriends();
    // A new friend changes who is on a friends board.
    boardsLoaded = false;
    if (el.friendSearch.value.trim().length >= 2) runSearch();
  } catch (err) {
    setMessage(el.friendMessage, describeError(err));
  }
}

async function runLeaveClub(clubId) {
  try {
    await leaveClub(clubId);
    boardsLoaded = false;
    await loadFriends();
  } catch (err) {
    setMessage(el.friendMessage, describeError(err));
  }
}

// Debounced, because this fires per keystroke and each one is a database query.
let searchTimer = null;
function runSearch() {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(async () => {
    const query = el.friendSearch.value.trim();
    if (query.length < 2) {
      el.friendResults.innerHTML = "";
      return;
    }
    try {
      const { users } = await searchPlayers(query);
      fillList(el.friendResults, users.map((person) =>
        personRow(person, [
          { label: "Add friend", primary: true, run: () => runFriendAction("request", person.id) },
        ])
      ), "Nobody found with that name.");
    } catch (err) {
      setMessage(el.friendMessage, describeError(err));
    }
  }, 250);
}

el.friendSearch.addEventListener("input", runSearch);

el.clubCreateBtn.addEventListener("click", async () => {
  setMessage(el.friendMessage, "");
  try {
    const { club } = await createClub(el.clubName.value);
    el.clubName.value = "";
    boardsLoaded = false;
    await loadFriends();
    setMessage(el.friendMessage, `Created ${club.name}. Share the code "${club.slug}" to invite people.`, "ok");
  } catch (err) {
    setMessage(el.friendMessage, describeError(err));
  }
});

el.clubJoinBtn.addEventListener("click", async () => {
  setMessage(el.friendMessage, "");
  try {
    const { club } = await joinClub(el.clubSlug.value);
    el.clubSlug.value = "";
    boardsLoaded = false;
    await loadFriends();
    setMessage(el.friendMessage, `Joined ${club.name}.`, "ok");
  } catch (err) {
    setMessage(el.friendMessage, describeError(err));
  }
});

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------
let statsLoaded = false;
let statsSeen = -1;
let latestStats = null;
let showTrendTables = false;

// The UI branches on a metric's `format` and nothing else. That is what lets a
// new game module put a metric on this page without the page knowing it exists.
function formatMetric(value, format) {
  if (format === "percent") return `${value}%`;
  if (format === "decimal") return Number(value).toFixed(2);
  if (format === "integer") return Number(value).toLocaleString();
  return String(value);
}

function statTile(m) {
  const tile = document.createElement("div");
  tile.className = "stat-tile";

  const value = document.createElement("div");
  value.className = "stat-value";
  value.textContent = formatMetric(m.value, m.format);

  const label = document.createElement("div");
  label.className = "stat-label";
  label.textContent = m.label;

  tile.append(value, label);

  // Definitions that are judgement calls travel with the number. Checkout
  // percentage in particular means slightly different things to different
  // scorers, and a number whose meaning is arguable should say which reading
  // it took rather than letting someone assume the other one.
  if (m.hint) {
    const hint = document.createElement("div");
    hint.className = "stat-hint";
    hint.textContent = m.hint;
    tile.appendChild(hint);
  }

  return tile;
}

function statsSection(title, metrics) {
  const heading = document.createElement("div");
  heading.className = "account-section-title";
  heading.textContent = title;

  const grid = document.createElement("div");
  grid.className = "stat-grid";
  for (const m of metrics) grid.appendChild(statTile(m));

  return [heading, grid];
}

function renderStats(stats) {
  latestStats = stats;
  el.statsSections.innerHTML = "";

  el.statsCounted.textContent = stats.matchesCounted === 1
    ? "from 1 match"
    : `from ${stats.matchesCounted} matches`;

  el.statsSections.append(...statsSection("Career", stats.career.metrics));

  // One section per game that has actually been played. The engine leaves out
  // games with no legs, so this loop is also what keeps the page from being a
  // wall of zeroes for modes someone has never touched.
  for (const game of stats.games) {
    el.statsSections.append(...statsSection(game.label, game.metrics));
  }

  renderTrends();
}

function trendBlock(title, data, options) {
  const block = document.createElement("div");
  block.className = "chart-block";

  const heading = document.createElement("div");
  heading.className = "chart-title";
  heading.textContent = title;
  block.appendChild(heading);

  const body = document.createElement("div");
  block.appendChild(body);

  // The table is the same data, not a lesser version of it: it is the reading
  // for anyone who can't use a hover tooltip, and it is why these charts can
  // stay single-colour without losing anything.
  if (showTrendTables) {
    chartTable(body, { data, valueLabel: options.valueLabel, format: options.format });
  } else if (options.kind === "bar") {
    barChart(body, { data, format: options.format, empty: options.empty });
  } else {
    lineChart(body, { data, format: options.format, empty: options.empty });
  }

  return block;
}

function renderTrends() {
  if (!latestStats) return;
  el.trendCharts.innerHTML = "";

  const grain = el.trendGrain.value;
  const buckets = latestStats.trends[grain] ?? [];

  const improved = latestStats.trends.mostImproved;
  if (improved) {
    const note = document.createElement("div");
    note.className = "improved-note";
    note.textContent =
      `Most improved: ${improved.label}, up from ${improved.from} to ${improved.to} ` +
      `comparing your earliest and most recent play.`;
    el.trendCharts.appendChild(note);
  }

  const label = (b) => b.key;

  // Each chart answers one question with one series. Two measures on one pair
  // of axes would need two scales, which is the fastest way to make a chart
  // say something untrue.
  el.trendCharts.append(
    trendBlock("Three-dart average", buckets
      .filter((b) => b.x01Darts > 0)
      .map((b) => ({ label: label(b), value: b.threeDartAverage, detail: `${label(b)} · ${b.x01Darts} darts` })),
      { valueLabel: "3-dart avg", format: (v) => Number(v).toFixed(1), empty: "No x01 legs yet." }),

    trendBlock("Checkout %", buckets
      .filter((b) => b.checkoutChances > 0)
      .map((b) => ({ label: label(b), value: b.checkoutPct, detail: `${b.checkouts} of ${b.checkoutChances} chances` })),
      { valueLabel: "Checkout %", format: (v) => `${Number(v).toFixed(0)}%`, empty: "No checkout chances yet." }),

    trendBlock("Marks per round", buckets
      .filter((b) => b.cricketRounds > 0)
      .map((b) => ({ label: label(b), value: b.mpr, detail: `${b.cricketMarks} marks in ${b.cricketRounds} rounds` })),
      { valueLabel: "MPR", format: (v) => Number(v).toFixed(2), empty: "No Cricket legs yet." }),

    trendBlock("Win rate", buckets
      .map((b) => ({ label: label(b), value: b.winPct, detail: `${b.won} of ${b.played} matches` })),
      { kind: "bar", valueLabel: "Win %", format: (v) => `${Number(v).toFixed(0)}%`, empty: "No matches yet." }),

    trendBlock("180s", buckets
      .map((b) => ({ label: label(b), value: b.oneEighties, detail: `${b.oneEighties} in this period` })),
      { kind: "bar", valueLabel: "180s", format: (v) => String(v), empty: "No 180s yet - keep at it." }),
  );
}

async function loadStats() {
  setMessage(el.statsMessage, "");

  // A guest - signed out, or running the Android build, which has no server at
  // all - gets their statistics computed right here from the matches sitting in
  // the local queue. This is the payoff for statsengine.js being shared rather
  // than living on the server: the numbers are the same numbers, produced by
  // the same code, with nothing to sign in to.
  if (!accountSnapshot.user) {
    const local = queuedMatches();
    statsLoaded = true;
    renderStats(computeStats(local));
    setMessage(
      el.statsMessage,
      local.length
        ? "From matches played on this device. Create an account to keep them and see them anywhere."
        : "Finish a match and your statistics appear here - no account needed.",
      "ok"
    );
    return;
  }

  try {
    const { stats } = await fetchStats();
    statsLoaded = true;
    renderStats(stats);
  } catch (err) {
    setMessage(el.statsMessage, describeError(err));
  }
}

el.trendGrain.addEventListener("change", renderTrends);

el.trendTableToggle.addEventListener("click", () => {
  showTrendTables = !showTrendTables;
  el.trendTableToggle.textContent = showTrendTables ? "Show as charts" : "Show as table";
  renderTrends();
});

// ---------------------------------------------------------------------------
// Match history
// ---------------------------------------------------------------------------
let historyLoaded = false;
let historyCursor = null; // ended_at of the last row seen - see keyset paging
let matchesSeen = -1;     // the matchesVersion this screen last rendered

function describeFormat(match) {
  // A single-leg match reads as the game it was; a medley reads as its shape,
  // because listing "501 · Cricket · 501" in a history row is noise.
  const legs = Array.isArray(match.format) ? match.format : [];
  if (legs.length === 1) return gameLabel(legs[0]);
  if (legs.length > 1) return `${legs.length} legs · ${legs.map((l) => gameLabel(l).split(" · ")[0]).join(", ")}`;
  return match.games?.map((g) => g.game).join(", ") || "Match";
}

function describeDuration(ms) {
  const minutes = Math.round((ms || 0) / 60000);
  if (minutes < 1) return "under a minute";
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function describeWhen(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  return sameDay
    ? `Today ${date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`
    : date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function historyRow(match) {
  const self = match.players.find((p) => p.isSelf) ?? match.players[0];
  const others = match.players.filter((p) => p !== self);

  const row = document.createElement("div");
  row.className = "history-row";

  const result = document.createElement("div");
  // A drawn match is neither, and saying so is more honest than rounding it to
  // a loss - Count Up legs make draws genuinely reachable.
  const outcome = match.drawn ? "draw" : match.won ? "win" : "loss";
  result.className = `history-result ${outcome}`;
  result.textContent = match.drawn ? "Draw" : match.won ? "Win" : "Loss";

  const middle = document.createElement("div");
  const opponent = document.createElement("div");
  opponent.className = "history-opponent";
  opponent.textContent = others.length
    ? `vs ${others.map((p) => p.displayName).join(", ")}`
    : "Solo practice";
  const detail = document.createElement("div");
  detail.className = "history-detail";
  detail.textContent = [
    describeFormat(match),
    describeWhen(match.endedAt),
    `${match.dartsThrown} darts`,
    describeDuration(match.durationMs),
    match.mode === "online" ? "online" : null,
  ].filter(Boolean).join(" · ");
  middle.append(opponent, detail);

  const score = document.createElement("div");
  score.className = "history-score";
  score.textContent = match.players.map((p) => p.legsWon).join("–");

  row.append(result, middle, score);
  return row;
}

async function loadHistory({ reset = false } = {}) {
  if (reset) {
    el.historyList.innerHTML = "";
    historyCursor = null;
  }
  setMessage(el.historyMessage, "");

  try {
    const { matches } = await fetchMatches({ limit: 25, before: historyCursor });
    historyLoaded = true;

    if (!matches.length && !historyCursor) {
      const empty = document.createElement("div");
      empty.className = "history-empty";
      empty.textContent = "No matches yet. Finish a game and it will appear here.";
      el.historyList.appendChild(empty);
      el.historyMore.classList.add("hidden");
      return;
    }

    for (const match of matches) el.historyList.appendChild(historyRow(match));
    historyCursor = matches.length ? matches[matches.length - 1].endedAt : historyCursor;
    // A full page probably means there are more; a short one definitely means
    // there aren't.
    el.historyMore.classList.toggle("hidden", matches.length < 25);
  } catch (err) {
    setMessage(el.historyMessage, describeError(err));
  }

  // Anything still queued hasn't reached the server, and the history above is
  // therefore incomplete. Saying so is better than letting someone conclude
  // their match wasn't recorded.
  const queued = queuedMatchCount();
  el.historyQueueNote.classList.toggle("hidden", queued === 0);
  el.historyQueueNote.textContent = queued
    ? `${queued} match${queued === 1 ? "" : "es"} waiting to upload`
    : "";
}

el.historyMore.addEventListener("click", () => loadHistory());

for (const button of document.querySelectorAll(".account-nav-btn")) {
  button.addEventListener("click", () => {
    view = button.dataset.view;
    for (const other of document.querySelectorAll(".account-nav-btn")) {
      other.classList.toggle("active", other === button);
    }
    render(accountSnapshot);
    if (view !== "profile") {
      // Coming back to these screens is the natural moment to retry anything
      // that failed to upload earlier - they are the two that would otherwise
      // quietly be missing a match.
      flushQueue().catch(() => {});
    }
  });
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------
// Clicking the tab button rather than toggling panels directly: online.js owns
// which mode is visible, and two modules writing that state is how you end up
// with two panels on screen at once.
function openAccountTab() {
  el.tab?.click();
}

el.chip.addEventListener("click", openAccountTab);

for (const tab of document.querySelectorAll(".auth-tab")) {
  tab.addEventListener("click", () => {
    const which = tab.dataset.auth;
    for (const other of document.querySelectorAll(".auth-tab")) {
      other.classList.toggle("active", other === tab);
    }
    el.loginForm.classList.toggle("hidden", which !== "login");
    el.registerForm.classList.toggle("hidden", which !== "register");
  });
}

// Deep links, so "the stats page" is a thing you can bookmark or send to
// yourself. Deliberately minimal: the app is one page with tabs, and a real
// router would be a framework's worth of machinery to serve four URLs.
function applyHash() {
  const route = location.hash.replace(/^#\/?/, "");
  if (["account", "login", "profile", "signin"].includes(route)) {
    openAccountTab();
    if (route === "login" || route === "signin") {
      document.querySelector('.auth-tab[data-auth="login"]')?.click();
    }
  }
}

window.addEventListener("hashchange", applyHash);

// ---------------------------------------------------------------------------
// Forms
// ---------------------------------------------------------------------------
el.loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  setMessage(el.loginMessage, "");
  await withBusy(event.submitter, async () => {
    try {
      await login({ email: el.loginEmail.value, password: el.loginPassword.value });
      el.loginForm.reset();
    } catch (err) {
      setMessage(el.loginMessage, describeError(err));
    }
  });
});

el.registerForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  setMessage(el.registerMessage, "");
  await withBusy(event.submitter, async () => {
    try {
      await register({
        email: el.registerEmail.value,
        displayName: el.registerName.value,
        password: el.registerPassword.value,
        prefFormat: el.registerFormat.value || null,
        prefOutRule: el.registerOutRule.value || null,
      });
      el.registerForm.reset();
    } catch (err) {
      setMessage(el.registerMessage, describeError(err));
    }
  });
});

el.profileForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  setMessage(el.profileMessage, "");
  await withBusy(event.submitter, async () => {
    try {
      await updateProfile({
        displayName: el.profileName.value,
        prefFormat: el.profileFormat.value || null,
        prefOutRule: el.profileOutRule.value || null,
        leaderboardOptIn: el.profileLeaderboard.checked,
      });
      setMessage(el.profileMessage, "Profile saved.", "ok");
    } catch (err) {
      setMessage(el.profileMessage, describeError(err));
    }
  });
});

el.passwordForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  setMessage(el.passwordMessage, "");
  await withBusy(event.submitter, async () => {
    try {
      await changePassword({
        currentPassword: el.passwordCurrent.value,
        newPassword: el.passwordNew.value,
      });
      el.passwordForm.reset();
      setMessage(el.passwordMessage, "Password changed.", "ok");
    } catch (err) {
      setMessage(el.passwordMessage, describeError(err));
    }
  });
});

// ---------------------------------------------------------------------------
// Avatar
// ---------------------------------------------------------------------------
el.avatarChoose.addEventListener("click", () => el.avatarInput.click());

el.avatarInput.addEventListener("change", async () => {
  const file = el.avatarInput.files?.[0];
  if (!file) return;
  setMessage(el.avatarMessage, "");

  // Checked here as well as on the server so the error arrives instantly and
  // names a number, instead of after uploading a photo over a phone connection.
  if (file.size > 256 * 1024) {
    setMessage(el.avatarMessage, "That picture is over 256KB - pick a smaller one.");
    el.avatarInput.value = "";
    return;
  }

  try {
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error("Couldn't read that file."));
      reader.readAsDataURL(file);
    });
    await uploadAvatar(dataUrl);
    avatarVersion += 1;
    setMessage(el.avatarMessage, "Picture updated.", "ok");
  } catch (err) {
    setMessage(el.avatarMessage, describeError(err));
  } finally {
    // Cleared so choosing the same file again still fires a change event.
    el.avatarInput.value = "";
  }
});

el.avatarRemove.addEventListener("click", async () => {
  setMessage(el.avatarMessage, "");
  try {
    await uploadAvatar(null);
    avatarVersion += 1;
    setMessage(el.avatarMessage, "Picture removed.", "ok");
  } catch (err) {
    setMessage(el.avatarMessage, describeError(err));
  }
});

el.logoutBtn.addEventListener("click", async () => {
  await logout();
  setMessage(el.profileMessage, "");
  setMessage(el.avatarMessage, "");
  setMessage(el.passwordMessage, "");
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Unlock notices
// ---------------------------------------------------------------------------
// When a finished match earns something, say so where the player already is -
// on the game panel, under the winner banner. Deliberately NOT a modal: the
// most likely moment for this is mid-medley, with another leg to start, and a
// dialog over the board would be the app interrupting a game to congratulate
// itself.
//
// The notice appears on whichever game panel is on screen, and clears itself.
function showUnlocks(unlocks) {
  if (!unlocks.length) return;

  const host = document.querySelector("#local-mode #game-panel:not(.hidden)")
    || document.querySelector("#online-mode #online-game-panel:not(.hidden)")
    || el.dashPanel;
  if (!host) return;

  const toast = document.createElement("div");
  toast.className = "unlock-toast";
  const names = unlocks.map((u) => u.label).join(", ");
  toast.innerHTML = `<strong>Achievement unlocked</strong> · ${names}`;
  host.prepend(toast);

  setTimeout(() => toast.remove(), 12000);
}

subscribe((snapshot) => {
  accountSnapshot = snapshot;
  render(snapshot);
  // Unlocks arrive with the background upload, which finishes after the match
  // does - so they are collected here rather than returned to the code that
  // ended the game.
  showUnlocks(takeUnlocks());
});
refresh().then(applyHash);
