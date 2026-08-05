// medleybuilder.js - the "Format" control: a preset dropdown plus an editable
// list of legs.
//
// Shared by the local setup panel and the online challenge panel. It's a
// factory rather than a module-level singleton because the page has two
// independent copies on screen at once, each with its own elements and its
// own selection - a single shared instance would have them overwriting each
// other.
//
// Knows nothing about matches or scoring: it produces a list of leg objects
// (see medley.js) and the caller decides what to do with them.

import { X01_SCORES, X01_RULES } from "./scoring.js";
import { MATCH_PRESETS, normalizeLeg, gameLabel } from "./medley.js";
import { COUNTUP_ROUND_OPTIONS, DEFAULT_ROUNDS } from "./countup.js";
import { getPref, setPref, subscribe } from "./prefs.js";

const DEFAULT_LEG = { game: "x01", score: 501, rules: "double" };

// How many recent formats to offer. Three, because this is a shortcut and a
// long row of near-identical chips is slower to read than the dropdown it was
// meant to save you from.
const RECENT_LIMIT = 3;
const PRESET_LIMIT = 12;

const describeLegs = (legs) => legs.map(gameLabel).join(" · ");
const legsKey = (legs) => JSON.stringify(legs.map(normalizeLeg));

// gameLabel is written for the format dropdown, where there is a whole row to
// read: "501 · Open in / Double out · Cricket · 501 · Open in / Double out".
// On a chip that is unreadable and wraps to three lines, so chips get their own
// shorter form and keep the full one as the tooltip.
function compactLeg(leg) {
  const l = normalizeLeg(leg);
  if (l.game === "x01") return String(l.score);
  if (l.game === "countup") return "Count Up";
  if (l.game === "bermuda") return "Bermuda";
  return "Cricket";
}

function shortLabel(legs) {
  const list = (legs || []).map(normalizeLeg);
  if (!list.length) return "Format";
  if (list.length === 1) return compactLeg(list[0]);
  const games = [...new Set(list.map(compactLeg))];
  return `${list.length} legs · ${games.join(" / ")}`;
}

// Building a medley is the fiddliest flow in the app - pick a format, add legs,
// set the rules on each, choose the bull - and people play the SAME one over
// and over, rebuilding it every time. These two together are the fix: recents
// cost nothing to maintain and cover the common case; a named preset covers
// "the format my league plays on Tuesdays".
export function recordFormatUsed(legs) {
  if (!Array.isArray(legs) || !legs.length) return;
  const entry = { legs: legs.map(normalizeLeg), label: shortLabel(legs), full: describeLegs(legs) };
  const key = legsKey(legs);
  const rest = (getPref("recentFormats") || []).filter((r) => legsKey(r.legs || []) !== key);
  setPref("recentFormats", [entry, ...rest].slice(0, RECENT_LIMIT));
}

function sameLeg(a, b) {
  const x = normalizeLeg(a), y = normalizeLeg(b);
  return x.game === y.game && x.score === y.score && x.rules === y.rules
    && x.rounds === y.rounds && x.bull === y.bull;
}

// els: { legs, addBtn, preset } - any may be absent, in which case the
// builder degrades quietly rather than throwing.
export function createMedleyBuilder(els) {
  const { legs: legsEl, addBtn, preset, bull: bullEl, chips: chipsEl } = els || {};

  // Bull mode is stored per leg (so it crosses the wire with the rest of the
  // config) but chosen once for the whole match - a fifth dropdown on every
  // leg row would be noise, and mixing bull modes between legs of one match
  // isn't a thing anyone wants.
  const bullMode = () => (bullEl?.value === "full" ? "full" : "split");

  function render(legs) {
    if (!legsEl) return;
    legsEl.innerHTML = legs.map(normalizeLeg).map((leg, i) => {
      const isX01 = leg.game === "x01";
      const isCountUp = leg.game === "countup";
      // Score and rules only exist for x01 - cricket has neither a starting
      // score nor an in/out rule.
      const scoreOptions = X01_SCORES
        .map((n) => `<option value="${n}"${isX01 && leg.score === n ? " selected" : ""}>${n}</option>`)
        .join("");
      // Count Up's only setting is how many rounds it runs for.
      const roundOptions = COUNTUP_ROUND_OPTIONS
        .map((n) => `<option value="${n}"${isCountUp && leg.rounds === n ? " selected" : ""}>${n} rounds</option>`)
        .join("");
      const rulesOptions = Object.entries(X01_RULES)
        .map(([key, r]) => `<option value="${key}"${isX01 && leg.rules === key ? " selected" : ""}>${r.label}</option>`)
        .join("");

      return `
      <div class="leg-row">
        <span class="leg-label">Leg ${i + 1}</span>
        <select class="leg-game">
          <option value="x01"${isX01 ? " selected" : ""}>x01</option>
          <option value="cricket"${leg.game === "cricket" ? " selected" : ""}>Cricket</option>
          <option value="countup"${isCountUp ? " selected" : ""}>Count Up</option>
          <option value="bermuda"${leg.game === "bermuda" ? " selected" : ""}>Bermuda Triangle</option>
        </select>
        <select class="leg-score${isX01 ? "" : " hidden"}">${scoreOptions}</select>
        <select class="leg-rules${isX01 ? "" : " hidden"}">${rulesOptions}</select>
        <select class="leg-rounds${isCountUp ? "" : " hidden"}">${roundOptions}</select>
        <button type="button" class="leg-remove" title="Remove this leg">&times;</button>
      </div>`;
    }).join("");
    // With one leg there's nothing to remove - hide rather than let someone
    // delete their way to a match with no games in it.
    legsEl.classList.toggle("single", legs.length <= 1);
  }

  function getLegs() {
    const rows = legsEl?.querySelectorAll(".leg-row") || [];
    const legs = [...rows].map((row) => {
      const game = row.querySelector(".leg-game")?.value;
      if (game === "cricket") return { game: "cricket" };
      // Bermuda's round count is fixed by its target list, so it has no
      // options of its own - like Cricket, the row is just the game.
      if (game === "bermuda") return { game: "bermuda" };
      if (game === "countup") {
        return { game: "countup", rounds: Number(row.querySelector(".leg-rounds")?.value) || DEFAULT_ROUNDS };
      }
      return {
        game: "x01",
        score: Number(row.querySelector(".leg-score")?.value) || 501,
        rules: row.querySelector(".leg-rules")?.value || "double",
      };
    });
    const mode = bullMode();
    const withBull = (legs.length ? legs : [{ ...DEFAULT_LEG }]).map((l) => ({ ...l, bull: mode }));
    return withBull;
  }

  // Editing a leg by hand means the preset no longer describes the match, so
  // the dropdown falls back to "Custom" rather than displaying a lie.
  function markCustomIfNeeded() {
    if (!preset) return;
    const legs = getLegs();
    const hit = Object.entries(MATCH_PRESETS)
      .find(([, p]) => p.length === legs.length
        && p.every((g, i) => sameLeg({ ...normalizeLeg(g), bull: legs[i].bull }, legs[i])));
    preset.value = hit ? hit[0] : "custom";
  }

  preset?.addEventListener("change", () => {
    const chosen = MATCH_PRESETS[preset.value];
    if (chosen) render(chosen);
  });

  addBtn?.addEventListener("click", () => {
    const legs = getLegs();
    // Continue the pattern rather than always appending 501 - in an
    // alternating medley the next leg is almost always the other game.
    const last = normalizeLeg(legs[legs.length - 1]);
    const next = legs.length >= 2
      ? legs[legs.length - 2]
      : (last.game === "x01" ? { game: "cricket" } : { ...DEFAULT_LEG });
    render([...legs, next]);
    markCustomIfNeeded();
  });

  legsEl?.addEventListener("click", (event) => {
    if (!event.target.classList.contains("leg-remove")) return;
    const legs = getLegs();
    if (legs.length <= 1) return;
    const index = [...legsEl.querySelectorAll(".leg-row")].indexOf(event.target.closest(".leg-row"));
    legs.splice(index, 1);
    render(legs);
    markCustomIfNeeded();
  });

  legsEl?.addEventListener("change", (event) => {
    // Switching a leg between x01 and cricket changes which controls that row
    // needs, so the row is rebuilt rather than just re-checked.
    if (event.target.classList.contains("leg-game")) render(getLegs());
    markCustomIfNeeded();
  });

  // Seed from whatever the preset dropdown is showing, not from an
  // independent default. These were two sources of truth: if the HTML's
  // selected option didn't happen to match DEFAULT_LEG, the page loaded with
  // the Format box saying one thing and the leg row showing another.
  render(MATCH_PRESETS[preset?.value] || [{ ...DEFAULT_LEG }]);

  // -------------------------------------------------------------------------
  // Recents and saved formats
  //
  // Built as DOM rather than innerHTML because a saved format carries a NAME
  // the player typed. The rest of this file builds rows with innerHTML and that
  // is fine - every value in them comes from a fixed list of games and scores -
  // but the moment a string is user-supplied it needs a text node, and
  // lobbyui.js has already been the cautionary tale here.

  function applyLegs(legs) {
    const list = (legs || []).map(normalizeLeg);
    if (!list.length) return;
    render(list);
    if (bullEl && list[0].bull) bullEl.value = list[0].bull;
    markCustomIfNeeded();
  }

  function chip(label, title, onClick) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "format-chip";
    button.textContent = label;
    if (title) button.title = title;
    button.addEventListener("click", onClick);
    return button;
  }

  function renderChips() {
    if (!chipsEl) return;
    chipsEl.textContent = "";

    for (const saved of getPref("formatPresets") || []) {
      const button = chip("★ " + saved.name, saved.full || saved.label || "", () => applyLegs(saved.legs));
      const remove = document.createElement("span");
      remove.className = "format-chip-x";
      remove.textContent = "×";
      remove.title = "Forget this format";
      remove.addEventListener("click", (event) => {
        event.stopPropagation(); // or loading it would race deleting it
        setPref("formatPresets", (getPref("formatPresets") || []).filter((p) => p.name !== saved.name));
      });
      button.appendChild(remove);
      chipsEl.appendChild(button);
    }

    // Recents come after saved ones: something you named beats something you
    // merely played.
    for (const recent of getPref("recentFormats") || []) {
      chipsEl.appendChild(chip(recent.label, recent.full || "Played recently", () => applyLegs(recent.legs)));
    }

    const save = chip("+ Save format", "Remember the format above under a name", () => {
      const name = window.prompt("Name this format", describeLegs(getLegs()))?.trim();
      if (!name) return;
      const legs = getLegs();
      const existing = (getPref("formatPresets") || []).filter((p) => p.name !== name);
      setPref("formatPresets", [...existing, {
        name, legs, label: shortLabel(legs), full: describeLegs(legs),
      }].slice(0, PRESET_LIMIT));
    });
    save.classList.add("format-chip-save");
    chipsEl.appendChild(save);
  }

  renderChips();

  // Saving, forgetting and playing a format all change this row, and the two
  // builders on the page - local and online - share one list. Redrawing from
  // the store rather than at each call site is what keeps the setup screen and
  // the challenge screen showing the same thing, and it is why nothing above
  // calls renderChips after a write.
  subscribe((key) => {
    if (key === "recentFormats" || key === "formatPresets" || key === null) renderChips();
  });

  return {
    getLegs,
    render,
    renderChips,
    describe: () => describeLegs(getLegs()),
  };
}
