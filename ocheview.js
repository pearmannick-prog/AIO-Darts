// ocheview.js - the arcade scoreboard. What the machine in the pub shows while
// you are standing at the line.
//
// This is Board View taken to its end: the fourth step past Desk, Room and
// Across the room, where the app stops being a page you read and becomes a
// scoreboard on a wall. No header, no tabs, no keypad, no browser furniture -
// the score, whose turn it is, and the three darts of this visit.
//
// IT RESTYLES THE GAME PANEL, IT DOES NOT RENDER A SECOND ONE. That is the
// whole design, and it is the reason this file is short. A fullscreen
// scoreboard needs live match state - scores, current player, darts thrown -
// and game.js and online.js both keep theirs private, deliberately. Rendering
// a second scoreboard would mean either exporting that state or duplicating
// the rendering, and a duplicate scoreboard is a scoreboard that will
// eventually disagree with the real one about who has won.
//
// So instead the existing panel is put into fullscreen and given a class, and
// CSS rearranges what is already on screen. x01, Cricket, Count Up and Bermuda
// all work in here without knowing it exists, local and online alike, because
// none of them are involved. It is the same move .immersive already makes for
// the video stage - a class on the game panel - for the same reason.
//
// NOTHING BECOMES UNREACHABLE. It is tempting to drop the keypad and the
// clickable board entirely: if you are standing at the oche then a real board
// is doing the scoring. But "a real board" is a Granboard or a camera scorer
// that might not be connected, and a scoreboard nobody can score into is an
// ornament. They are hidden, not removed, and one tap brings them back.

const FULLSCREEN_UNSUPPORTED_NOTE =
  "Couldn't go fullscreen - showing the big scoreboard anyway.";

let active = null; // the panel currently in oche view
let wakeLock = null;

// ---------------------------------------------------------------------------
// Keeping the screen awake
//
// A tablet under the board sleeping between visits is the single most annoying
// thing this mode could do, and it would happen within a minute on default
// settings. The lock is released when the mode ends, and RE-ACQUIRED when the
// tab becomes visible again: the browser drops it on every tab switch, screen
// lock and minimise, and it does not come back on its own.

async function acquireWakeLock() {
  if (!navigator.wakeLock) return;
  try {
    wakeLock = await navigator.wakeLock.request("screen");
  } catch {
    // Denied, unsupported, or the document was not visible. A scoreboard that
    // dims is worse than one that does not, but it is not worth an error.
  }
}

function releaseWakeLock() {
  try {
    wakeLock?.release();
  } catch {
    // Already gone.
  }
  wakeLock = null;
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && active) acquireWakeLock();
});

// ---------------------------------------------------------------------------
// The in-view controls
//
// Built here rather than in index.html because they belong to whichever panel
// is in the mode, and there are two panels. One set, moved.

function buildControls() {
  const bar = document.createElement("div");
  bar.className = "oche-controls";

  const entry = document.createElement("button");
  entry.type = "button";
  entry.className = "oche-btn";
  entry.textContent = "Score";
  entry.title = "Show the keypad and board";
  entry.addEventListener("click", () => {
    const showing = active?.classList.toggle("oche-entry-open");
    entry.classList.toggle("active", Boolean(showing));
  });

  const exit = document.createElement("button");
  exit.type = "button";
  exit.className = "oche-btn";
  exit.textContent = "✕ Exit";
  exit.addEventListener("click", () => stopOcheView());

  bar.appendChild(entry);
  bar.appendChild(exit);
  return bar;
}

let controls = null;

// ---------------------------------------------------------------------------

export async function startOcheView(panel) {
  if (!panel || active) return;
  active = panel;
  panel.classList.add("oche-mode");

  if (!controls) controls = buildControls();
  panel.appendChild(controls);

  // Fullscreen is requested, not required. It needs a user gesture and it is
  // refused outright in some embedded webviews - including, quite possibly, the
  // Android wrapper this app also ships as. The class above has already done
  // the real work, so a refusal costs the browser chrome and nothing else.
  try {
    await panel.requestFullscreen?.();
  } catch {
    panel.dataset.ocheNote = FULLSCREEN_UNSUPPORTED_NOTE;
  }

  acquireWakeLock();
}

export function stopOcheView() {
  if (!active) return;
  const panel = active;
  active = null;

  panel.classList.remove("oche-mode", "oche-entry-open");
  delete panel.dataset.ocheNote;
  controls?.remove();
  releaseWakeLock();

  if (document.fullscreenElement) {
    document.exitFullscreen?.().catch(() => {});
  }
}

export function isOcheView() {
  return Boolean(active);
}

// Escape, the browser's own fullscreen close button, and the OS gesture all
// leave fullscreen without telling us. Without this the panel keeps the class
// and the app is stuck looking like a scoreboard in a normal window.
document.addEventListener("fullscreenchange", () => {
  if (!document.fullscreenElement && active) stopOcheView();
});

// ---------------------------------------------------------------------------
// Wiring
//
// Every .js-oche button turns the mode on for whichever game panel contains it,
// so the same markup serves local and online without either controller being
// told about this file.

export function wireOcheButtons() {
  for (const button of document.querySelectorAll(".js-oche")) {
    button.addEventListener("click", () => {
      const panel = button.closest(".panel");
      if (panel) startOcheView(panel);
    });
  }
}

wireOcheButtons();
