// prefs.js - every personal setting in the app, and the only thing that writes
// them.
//
// DEVICE FIRST, ACCOUNT SECOND, and that ordering is the whole design. The
// account tab does not render at all without an accounts API, so a guest - or
// anyone on the Android build, or on a deployment with ACCOUNTS=off - would get
// no personalization whatsoever if preferences lived on the server. They live
// in localStorage, they work signed out, and syncing them to an account is an
// additive convenience that can be removed without breaking anything.
//
// ONE BLOB, VERSIONED. Everything is a single JSON object under one key rather
// than a key per setting. Reading twenty keys on boot is twenty synchronous
// localStorage hits before first paint, and a half-written set of them is a
// state no migration can reason about later.
//
// UNKNOWN KEYS SURVIVE. read() keeps anything it does not recognise. A newer
// build that adds a preference must not have it silently deleted by an older
// tab on the same machine - and once account sync exists, by an older device.
//
// A CORRUPT BLOB MUST NOT BRICK THE APP. Every value is validated on the way
// out, not on the way in, and anything unrecognised falls back to its default.
// Hand-edited localStorage, a half-finished write, a value from a future
// version: all of them degrade to "the app looks normal" rather than to a
// blank screen, which for a darts app someone is standing in front of matters
// more than honouring the setting.

const STORAGE_KEY = "aio-darts-prefs";
const VERSION = 1;

/**
 * How long a completed visit sits before the turn passes, so a misread can
 * still be undone.
 *
 * Here rather than in either controller because game.js and online.js
 * deliberately do not import each other, and both already import this module -
 * so this is the one place both can see without coupling them. A player who
 * uses both modes should feel the same pause in each.
 *
 * ONLY THE DURATION IS SHARED. online.js keeps its own PEER_HOLD_GRACE_MS, the
 * extra time a receiver waits before ending a turn it was never told about,
 * because that is protocol tolerance rather than comfort: it decides how late
 * or lost an `end_turn` may be and still be survived. Sharing that too would
 * mean shortening this number to make pass-and-play feel snappier also
 * shortened how much of a network hiccup an online match can absorb - a
 * correctness change arriving from a cosmetic edit, with nothing in the diff
 * to say so.
 */
export const VISIT_HOLD_MS = 10000;

// ---------------------------------------------------------------------------
// Schema
//
// Each entry declares its default and what counts as a legal value. `osDefault`
// is how a preference answers itself from the operating system, so that most
// players never have to open the customize panel at all: reduced motion and
// dark mode are already system-level decisions people have made, and asking
// them again is a worse experience than reading the answer.

const ENUM = (...values) => (v) => (values.includes(v) ? v : undefined);
const BOOL = (v) => (typeof v === "boolean" ? v : undefined);
const NUM = (min, max) => (v) =>
  typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? v : undefined;
const LIST = (max) => (v) => (Array.isArray(v) ? v.slice(0, max) : undefined);

const media = (query) => {
  // matchMedia is missing in no browser this app supports, but it IS missing in
  // a jsdom-less test environment, and this module is imported by code that is
  // worth testing without a DOM.
  try {
    return typeof matchMedia === "function" ? matchMedia(query) : null;
  } catch {
    return null;
  }
};

const SCHEMA = {
  // ---- Appearance ----
  theme: { def: "baize", parse: ENUM("baize", "night", "broadcast"), attr: "data-theme" },
  // "auto" resolves against the OS at apply time; the RESOLVED value is what
  // gets stamped, so CSS never has to know that auto exists.
  mode: {
    def: "auto",
    parse: ENUM("light", "dark", "auto"),
    osDefault: () => "auto",
  },
  accent: { def: "gold", parse: (v) => (typeof v === "string" && /^[a-z]+$|^#[0-9a-f]{6}$/i.test(v) ? v : undefined) },
  motion: {
    def: "full",
    parse: ENUM("full", "reduced"),
    attr: "data-motion",
    osDefault: () => (media("(prefers-reduced-motion: reduce)")?.matches ? "reduced" : "full"),
  },
  contrast: {
    def: "normal",
    parse: ENUM("normal", "high"),
    attr: "data-contrast",
    osDefault: () => (media("(prefers-contrast: more)")?.matches ? "high" : "normal"),
  },
  density: { def: "comfortable", parse: ENUM("comfortable", "compact"), attr: "data-density" },
  textScale: { def: 1, parse: NUM(0.85, 1.5) },
  colourblindBoard: { def: false, parse: BOOL, attr: "data-cb-board" },

  // ---- The game screen ----
  // The single most valuable setting in the app: how far away you are standing.
  boardView: { def: "desk", parse: ENUM("desk", "room", "across"), attr: "data-boardview" },
  // Hold a finished visit before the turn passes, so a misread can still be
  // undone. Online always holds - it is what makes undo safe there - but local
  // play already lets you undo after a visit, so here it buys a countdown at
  // the cost of a wait. Off by default because pass-and-play is the common
  // case and the next player is standing beside you with their hand out.
  localHold: { def: false, parse: BOOL },
  checkoutHelp: { def: "off", parse: ENUM("off", "route", "all") },
  checkoutUnder100: { def: false, parse: BOOL },
  entryMode: { def: "quicktotal", parse: ENUM("perdart", "quicktotal") },

  // ---- Sound ----
  sound: { def: false, parse: BOOL },
  soundVolume: { def: 0.7, parse: NUM(0, 1) },
  caller: { def: true, parse: BOOL },

  // ---- The app ----
  landing: { def: "local", parse: ENUM("local", "online", "account", "last") },
  lastTab: { def: "local", parse: ENUM("local", "online", "account") },

  // ---- Setup ----
  formatPresets: { def: [], parse: LIST(12) },
  recentFormats: { def: [], parse: LIST(3) },
};

// ---------------------------------------------------------------------------
// Storage

function readRaw() {
  try {
    const text = localStorage.getItem(STORAGE_KEY);
    if (!text) return {};
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    // Private browsing, a full disk, a quota error, or simply corrupt JSON.
    // None of them are a reason to refuse to play darts.
    return {};
  }
}

let cache = null;

function store() {
  if (!cache) cache = readRaw();
  return cache;
}

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...store(), v: VERSION }));
  } catch {
    // Same reasoning: a preference that cannot be saved is a preference that
    // lasts one session, not an error worth interrupting anyone for.
  }
}

// ---------------------------------------------------------------------------
// Reading and writing

export function getPref(key) {
  const entry = SCHEMA[key];
  if (!entry) return undefined;
  const parsed = entry.parse(store()[key]);
  if (parsed !== undefined) return parsed;
  return entry.osDefault ? entry.osDefault() : entry.def;
}

export function allPrefs() {
  const out = {};
  for (const key of Object.keys(SCHEMA)) out[key] = getPref(key);
  return out;
}

export function setPref(key, value) {
  const entry = SCHEMA[key];
  if (!entry) return false;
  if (entry.parse(value) === undefined) return false;
  store()[key] = value;
  persist();
  apply();
  notify(key, value);
  return true;
}

// Reset by group rather than one nuclear button: someone who has spent time on
// their dashboard should be able to undo a theme experiment without losing it.
const GROUPS = {
  appearance: ["theme", "mode", "accent", "motion", "contrast", "density", "textScale", "colourblindBoard"],
  game: ["boardView", "checkoutHelp", "checkoutUnder100", "entryMode", "localHold"],
  sound: ["sound", "soundVolume", "caller"],
  app: ["landing", "lastTab"],
  setup: ["formatPresets", "recentFormats"],
};

export function resetGroup(group) {
  const keys = group === "all" ? Object.keys(SCHEMA) : GROUPS[group];
  if (!keys) return false;
  return resetKeys(keys);
}

// A reset button should undo exactly what the panel above it shows, and a panel
// does not always map onto one group - the Customize panel offers appearance
// plus board view, which lives with the game-screen settings.
export function resetKeys(keys) {
  if (!Array.isArray(keys)) return false;
  // The previous values are returned so the caller can offer an undo rather
  // than a confirm dialog. Asking "are you sure?" first punishes everyone to
  // guard against a mistake that undo fixes better.
  const previous = {};
  for (const key of keys) {
    if (key in store()) {
      previous[key] = store()[key];
      delete store()[key];
    }
  }
  persist();
  apply();
  notify(null, null);
  return previous;
}

export function restore(values) {
  Object.assign(store(), values || {});
  persist();
  apply();
  notify(null, null);
}

// ---------------------------------------------------------------------------
// Subscriptions

const listeners = new Set();

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notify(key, value) {
  for (const fn of listeners) {
    try {
      fn(key, value);
    } catch {
      // One bad listener must not stop the others, and must not stop the
      // preference from having been applied.
    }
  }
}

// ---------------------------------------------------------------------------
// Applying
//
// The actual DOM stamping lives in the inline <head> script in index.html, not
// here, and this calls back into it. That looks backwards and is deliberate:
// the inline script has to run before first paint (a module is deferred, so a
// module would paint the default theme and then flip, on every single load),
// and having two copies of "which attribute does this preference set" is
// exactly the kind of thing that drifts and then only misbehaves on first load,
// which is the hardest place to notice it.

export function apply() {
  const fn = typeof globalThis !== "undefined" && globalThis.__aioApplyPrefs;
  if (typeof fn === "function") fn(allPrefs());
}

// "auto" has to keep tracking the OS after boot - someone whose phone flips to
// dark at sunset should not have to reopen the app.
const darkQuery = media("(prefers-color-scheme: dark)");
darkQuery?.addEventListener?.("change", () => {
  if (getPref("mode") === "auto") apply();
});

export const PREF_GROUPS = GROUPS;
export const PREF_SCHEMA = SCHEMA;
