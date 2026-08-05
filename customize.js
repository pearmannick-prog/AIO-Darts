// customize.js - the Customize panel, inside the existing settings overlay.
//
// NOT A FOURTH TAB, and this is the one structural rule the feature has.
// Switching tabs ends a match (see switchTab in online.js), and customizing is
// exactly what somebody reaches for MID-MATCH, when they discover they cannot
// read the score from where they are standing. The gear overlay already exists
// for that reason - the camera check and the scorer address are in it for
// exactly the same reason - so this goes in there beside them.
//
// NO APPLY BUTTON ANYWHERE. Every control takes effect on touch, and the sheet
// deliberately does not cover the whole screen, so the app changing underneath
// you IS the preview. An Apply button implies the change is risky and needs
// committing; none of this is risky, and all of it is undone by touching
// something else.
//
// Everything here is built with createElement and textContent. There is no user
// text in this panel today, but lobbyui.js once interpolated a display name
// into innerHTML and that was stored cross-user XSS; building DOM is the house
// style now precisely so that nobody has to notice when a string starts being
// user-controlled.

import { getPref, setPref, resetKeys, restore, subscribe, PREF_GROUPS } from "./prefs.js";
import { THEMES, ACCENTS, checkAccent } from "./theme.js";

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
};

// ---------------------------------------------------------------------------
// A live preview of a theme: a scrap of scoreboard, rendered in the theme it
// is previewing rather than drawn to look like it.
//
// This is why the theme CSS is scoped to [data-theme] on any element instead of
// :root. Setting the attribute on this card makes its subtree genuinely that
// theme, so the preview cannot drift from the real thing - and it answers the
// only question that matters about a darts theme, which is whether you can read
// a big number on it.

function themePreview(themeId, mode) {
  const card = el("div", "theme-card");
  card.dataset.theme = themeId;
  if (mode) card.dataset.mode = mode;

  const stage = el("div", "theme-card-stage");
  const board = el("div", "theme-card-board");
  stage.appendChild(board);

  const score = el("div", "theme-card-score", "180");
  stage.appendChild(score);

  const chip = el("div", "theme-card-chip", "D16");
  stage.appendChild(chip);

  card.appendChild(stage);
  return card;
}

// ---------------------------------------------------------------------------
// Controls

function segmented(options, current, onPick) {
  const row = el("div", "cz-segmented");
  for (const opt of options) {
    const button = el("button", "cz-seg", opt.label);
    button.type = "button";
    button.dataset.value = opt.value;
    if (opt.value === current) button.classList.add("active");
    button.addEventListener("click", () => {
      for (const other of row.children) other.classList.remove("active");
      button.classList.add("active");
      onPick(opt.value);
    });
    row.appendChild(button);
  }
  return row;
}

function field(labelText, hintText) {
  const wrap = el("div", "cz-field");
  wrap.appendChild(el("div", "cz-label", labelText));
  if (hintText) wrap.appendChild(el("div", "cz-hint", hintText));
  return wrap;
}

// ---------------------------------------------------------------------------
// Sections

function themeSection() {
  const wrap = field("Theme");
  const strip = el("div", "theme-strip");

  const cards = new Map();
  for (const theme of THEMES) {
    const card = themePreview(theme.id, theme.id === "baize" ? getPref("mode") : null);
    card.setAttribute("role", "button");
    card.tabIndex = 0;
    card.title = theme.blurb;

    const name = el("div", "theme-card-name", theme.label);
    card.appendChild(name);

    const choose = () => {
      setPref("theme", theme.id);
      for (const [id, node] of cards) node.classList.toggle("selected", id === theme.id);
    };
    card.addEventListener("click", choose);
    card.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        choose();
      }
    });

    if (getPref("theme") === theme.id) card.classList.add("selected");
    cards.set(theme.id, card);
    strip.appendChild(card);
  }

  wrap.appendChild(strip);
  return wrap;
}

function modeSection() {
  const wrap = field("Brightness");
  wrap.appendChild(segmented(
    [
      { value: "light", label: "Light" },
      { value: "dark", label: "Dark" },
      { value: "auto", label: "Auto" },
    ],
    getPref("mode"),
    (value) => setPref("mode", value)
  ));
  wrap.appendChild(el("div", "cz-hint", "Auto follows your phone or computer."));
  return wrap;
}

// The one setting in here that changes how the app is USED rather than how it
// looks. See the long note beside [data-boardview] in index.html.
const BOARD_VIEWS = [
  { value: "desk", label: "Desk", hint: "Sitting down, phone or laptop in front of you." },
  { value: "room", label: "Room", hint: "A few steps back - a tablet on the side." },
  { value: "across", label: "Across the room", hint: "At the oche. The score fills the screen." },
];

function boardViewSection() {
  const wrap = field("Board view");
  wrap.appendChild(segmented(
    BOARD_VIEWS.map(({ value, label }) => ({ value, label })),
    getPref("boardView"),
    (value) => setPref("boardView", value)
  ));
  const hint = el("div", "cz-hint");
  const describe = () => {
    hint.textContent = BOARD_VIEWS.find((v) => v.value === getPref("boardView"))?.hint || "";
  };
  describe();
  wrap.addEventListener("click", describe);
  // The only honest way to choose this one is to go and look from where you
  // actually stand, so the panel says so rather than pretending a preview on a
  // screen 40cm away can answer it.
  wrap.appendChild(hint);
  wrap.appendChild(el("div", "cz-hint", "Pick this one standing at the oche, not sitting here."));
  return wrap;
}

// The in-game control. Lives on the game screen itself, cycles rather than
// expanding, because it has to be one tap while holding three darts.
function wireBoardViewButtons() {
  const label = () => {
    const current = getPref("boardView");
    const entry = BOARD_VIEWS.find((v) => v.value === current) || BOARD_VIEWS[0];
    return "⤡ " + entry.label;
  };
  const buttons = document.querySelectorAll(".js-boardview");
  const refresh = () => {
    for (const button of buttons) button.textContent = label();
  };
  for (const button of buttons) {
    button.addEventListener("click", () => {
      const index = BOARD_VIEWS.findIndex((v) => v.value === getPref("boardView"));
      // Nothing is updated here on purpose: setPref notifies, and the
      // subscriber below is the single place that reconciles the button with
      // the panel's segmented control. Two of them cycling out of step is the
      // obvious bug in a setting with two front doors.
      setPref("boardView", BOARD_VIEWS[(index + 1) % BOARD_VIEWS.length].value);
    });
  }
  refresh();
  return refresh;
}

function accentSection() {
  const wrap = field("Accent");
  const row = el("div", "cz-swatches");
  const current = getPref("accent");
  // Declared before the handlers that close over it. It would work either way -
  // a click happens long after this function returns - but "used above where it
  // is defined" is a trap for whoever edits this next.
  const note = el("p", "cz-note");

  const mark = (value) => {
    for (const node of row.children) {
      node.classList.toggle("selected", node.dataset.value === value);
    }
  };

  for (const accent of ACCENTS) {
    const dot = el("button", "cz-swatch");
    dot.type = "button";
    dot.dataset.value = accent.id;
    dot.style.setProperty("--swatch", accent.hex);
    dot.title = accent.label;
    dot.setAttribute("aria-label", accent.label);
    dot.addEventListener("click", () => {
      setPref("accent", accent.id);
      mark(accent.id);
      note.textContent = "";
      note.classList.remove("warn");
    });
    row.appendChild(dot);
  }

  // Custom, behind the curated eight rather than instead of them.
  const custom = el("button", "cz-swatch cz-swatch-custom");
  custom.type = "button";
  custom.dataset.value = "custom";
  custom.title = "Custom colour";
  custom.setAttribute("aria-label", "Custom colour");

  // The input covers the whole well at zero opacity, so a tap lands on it
  // directly. Nothing forwards clicks to it: a handler on the parent would fire
  // on the bubbling click from the input itself and open the picker twice.
  const picker = el("input", "cz-colour-input");
  picker.type = "color";
  picker.value = /^#/.test(current) ? current : "#C7A24A";
  custom.appendChild(picker);

  picker.addEventListener("input", () => {
    const hex = picker.value;
    const check = checkAccent(hex);
    setPref("accent", hex);
    mark("custom");
    custom.style.setProperty("--swatch", hex);

    // A WARNING WITH A FIX, never a refusal. The colour is already applied -
    // they can see it - and the app offers the nearest shade that works rather
    // than telling them their choice was wrong and reverting it.
    if (check.ok) {
      note.textContent = "";
      note.classList.remove("warn");
      return;
    }
    note.classList.add("warn");
    note.textContent = check.message + " ";
    if (check.suggestion) {
      const fix = el("button", "cz-link", "Use " + check.suggestion);
      fix.type = "button";
      fix.addEventListener("click", () => {
        picker.value = check.suggestion;
        setPref("accent", check.suggestion);
        custom.style.setProperty("--swatch", check.suggestion);
        note.textContent = "";
        note.classList.remove("warn");
      });
      note.appendChild(fix);
    }
  });

  row.appendChild(custom);
  if (/^#/.test(current)) {
    custom.style.setProperty("--swatch", current);
    custom.classList.add("selected");
  } else {
    mark(current);
  }

  wrap.appendChild(row);
  wrap.appendChild(note);
  return wrap;
}

// ---------------------------------------------------------------------------
// Reset
//
// Per section, and with an UNDO rather than a confirm dialog. "Are you sure?"
// taxes everybody in order to guard against a mistake that undo fixes better,
// and this app avoids blocking dialogs everywhere else too.

function resetRow() {
  const row = el("div", "cz-reset-row");
  const button = el("button", "btn-quiet cz-reset", "Reset these");
  button.type = "button";
  const undo = el("button", "cz-link", "Undo");
  undo.type = "button";
  undo.hidden = true;

  // Exactly what this panel shows, no more: board view sits with the
  // game-screen settings rather than the appearance ones, but it is on screen
  // here, so a reset button here has to include it.
  const shown = [...PREF_GROUPS.appearance, "boardView"];

  let timer = null;
  button.addEventListener("click", () => {
    const previous = resetKeys(shown);
    render();
    undo.hidden = false;
    clearTimeout(timer);
    timer = setTimeout(() => { undo.hidden = true; }, 8000);
    undo.onclick = () => {
      restore(previous);
      render();
      undo.hidden = true;
    };
  });

  row.appendChild(button);
  row.appendChild(undo);
  return row;
}

// ---------------------------------------------------------------------------
// Mounting

let mount = null;
let refreshBoardViewButtons = () => {};

function render() {
  if (!mount) return;
  mount.textContent = "";

  const head = el("div", "cz-head");
  head.appendChild(el("h3", "cz-title", "Customize"));
  head.appendChild(el("p", "cz-blurb", "Changes apply as you touch them."));
  mount.appendChild(head);

  mount.appendChild(themeSection());
  mount.appendChild(modeSection());
  mount.appendChild(boardViewSection());
  mount.appendChild(accentSection());
  mount.appendChild(resetRow());
}

export function mountCustomize() {
  const body = document.getElementById("settings-body");
  if (!body) return;
  mount = el("section", "customize-panel");
  // First in the sheet: the hardware panels below it are things you set up once
  // and forget, and this is the one you come back to.
  body.insertBefore(mount, body.firstChild);
  render();
  refreshBoardViewButtons = wireBoardViewButtons();
}

// Another tab on the same machine can change these; the app should not need a
// reload to agree with itself.
subscribe((key) => {
  // The in-game button and the panel's segmented control are two views of one
  // setting; whichever is touched, the other has to agree.
  if (key === "boardView") {
    refreshBoardViewButtons();
    render();
    return;
  }
  if (key === null) {
    refreshBoardViewButtons();
    return;
  }
  const card = mount?.querySelector('.theme-card[data-theme="baize"]');
  if (card && key === "mode") card.dataset.mode = getPref("mode");
});

mountCustomize();
