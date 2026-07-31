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

const DEFAULT_LEG = { game: "x01", score: 501, rules: "double" };

function sameLeg(a, b) {
  const x = normalizeLeg(a), y = normalizeLeg(b);
  return x.game === y.game && x.score === y.score && x.rules === y.rules && x.rounds === y.rounds;
}

// els: { legs, addBtn, preset } - any may be absent, in which case the
// builder degrades quietly rather than throwing.
export function createMedleyBuilder(els) {
  const { legs: legsEl, addBtn, preset } = els || {};

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
      if (game === "countup") {
        return { game: "countup", rounds: Number(row.querySelector(".leg-rounds")?.value) || DEFAULT_ROUNDS };
      }
      return {
        game: "x01",
        score: Number(row.querySelector(".leg-score")?.value) || 501,
        rules: row.querySelector(".leg-rules")?.value || "double",
      };
    });
    return legs.length ? legs : [{ ...DEFAULT_LEG }];
  }

  // Editing a leg by hand means the preset no longer describes the match, so
  // the dropdown falls back to "Custom" rather than displaying a lie.
  function markCustomIfNeeded() {
    if (!preset) return;
    const legs = getLegs();
    const hit = Object.entries(MATCH_PRESETS)
      .find(([, p]) => p.length === legs.length && p.every((g, i) => sameLeg(g, legs[i])));
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

  return { getLegs, render, describe: () => getLegs().map(gameLabel).join(" · ") };
}
