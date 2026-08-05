// audio.js - match sound, and the caller.
//
// The app has never made a sound. For a tablet propped under the board this is
// the single most delightful thing it could do - "one hundred and eighty" is
// the sound of the sport - and it is inherently personal: some people want the
// full caller, some want a quiet click, most of the people in the room want
// neither at two in the morning.
//
// A MISSING FILE IS SILENCE, NEVER AN ERROR. That is the load-bearing decision
// in this file and the reason it can ship before a single recording exists.
// Every cue is looked up optimistically; if there is no file behind it, the
// call does nothing and no one is told. So this can go out today with no assets
// at all, come alive the moment somebody drops recordings into ./sounds, and
// come alive PARTIALLY - a caller who has recorded 180 and 140 and nothing else
// simply calls those two. It also means the Android build, which ships whatever
// is in the repo, never fails on a sound it doesn't have.
//
// There is no bundled audio in this commit. See sounds/README.md for the names
// it looks for.

import { getPref } from "./prefs.js";

const BASE = "./sounds/";
// Ogg first for the browsers that prefer it, mp3 as the universal fallback.
// Both are tried per cue and the first that loads wins, so contributors can
// supply either without this file caring.
const EXTENSIONS = [".mp3", ".ogg"];

// Resolved cue -> HTMLAudioElement, or null once we know there is nothing
// there. Cached both ways: a cue that does not exist must not cost a network
// round trip on every single dart.
const cache = new Map();
let unlocked = false;

function enabled() {
  return getPref("sound") === true;
}

function volume() {
  const v = getPref("soundVolume");
  return typeof v === "number" ? Math.max(0, Math.min(1, v)) : 0.7;
}

// Browsers refuse to play audio until the user has interacted with the page.
// The first dart is itself an interaction, so in practice this is satisfied
// long before anything wants to make a noise - but a Bluetooth board or a
// camera scorer can score a whole visit without the page ever being touched,
// and then the first sound is silently blocked. Priming on the first gesture of
// any kind covers both.
function unlock() {
  if (unlocked) return;
  unlocked = true;
  // Nothing to play yet; the flag alone is what lets load() proceed eagerly.
  // Kept as a function so there is one obvious place to add a silent-buffer
  // prime if a browser ever needs more than this.
}

for (const event of ["pointerdown", "keydown", "touchstart"]) {
  document.addEventListener(event, unlock, { once: true, passive: true });
}

// Resolves a cue name to something playable, or to null if no file answers.
// The result is cached either way.
function load(name) {
  if (cache.has(name)) return cache.get(name);

  const candidates = EXTENSIONS.map((ext) => BASE + name + ext);
  const audio = new Audio();
  audio.preload = "auto";

  let index = 0;
  const tryNext = () => {
    if (index >= candidates.length) {
      // Nothing behind this cue. Remembered, so it is asked for once.
      cache.set(name, null);
      return;
    }
    audio.src = candidates[index++];
  };

  audio.addEventListener("error", tryNext);
  tryNext();

  cache.set(name, audio);
  return audio;
}

/**
 * Play a named cue. Unknown cues, missing files, blocked autoplay and a muted
 * preference all take the same path: nothing happens.
 */
export function cue(name) {
  if (!name || !enabled()) return;
  const audio = load(name);
  if (!audio) return;
  try {
    audio.volume = volume();
    audio.currentTime = 0;
    // play() rejects when the file never loaded or the browser blocked it.
    // Neither is worth surfacing: this is decoration on a darts scoreboard.
    audio.play?.().catch(() => {});
  } catch {
    // Some browsers throw on currentTime before metadata exists.
  }
}

/**
 * The caller announcing a visit total. Separate from cue() because it is the
 * one people will actually notice missing, and because it has its own switch -
 * somebody may want the bust and checkout sounds without a voice.
 */
export function callScore(total) {
  if (!Number.isInteger(total) || total < 0 || total > 180) return;
  if (getPref("caller") !== true) return;
  cue("caller/" + total);
}

/** A dart landed. Deliberately the quietest thing here. */
export const cueHit = () => cue("hit");
/** A visit that busted. */
export const cueBust = () => cue("bust");
/** A leg won on a double. */
export const cueCheckout = () => cue("checkout");
/** The match is over. */
export const cueWin = () => cue("win");
