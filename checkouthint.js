// checkouthint.js - the one place the checkout suggestion is drawn.
//
// Shared by game.js and online.js for the same reason dartboard.js and
// quickentry.js are: local and online must not drift. It is the DOM half of
// checkout.js, kept apart so that module stays pure and testable in node.
//
// It reads the player's preference itself rather than being passed it. The
// caller knows the score and the rules; whether the player wants to be told is
// none of its business, and threading a setting through both controllers is
// how a setting ends up honoured in one of them.

import { checkoutAdvice } from "./checkout.js";
import { getPref } from "./prefs.js";

/**
 * The running average for the leg in progress - PPD in x01, MPR in Cricket.
 *
 * The figure comes from the recorder (see liveStats there), which is the only
 * thing that sees every dart from both controllers, so this cannot disagree
 * between local and online play or with what is saved at the end. All this does
 * is put it on screen.
 *
 * Count Up and Bermuda return nothing, because a points-per-dart figure for a
 * game you win by scoring MORE is a number that reads backwards.
 *
 * @param {HTMLElement} node   where it goes; absent is fine
 * @param {object|null} stats  whatever recorder.liveStats(seat) returned
 */
export function renderLiveAverage(node, stats) {
  if (!node) return;
  const label = node.querySelector(".oche-stat-label");
  const value = node.querySelector(".oche-stat-value");
  if (!label || !value) return;

  const second = node.querySelector(".oche-stat-second");

  // NOTHING AT ALL rather than a captioned blank. null means the game has no
  // live average to offer - Count Up and Bermuda, which are won by scoring MORE
  // - and an empty "PPD -" sitting in the corner of those is a number the player
  // waits for and is never given. Before the first dart the recorder returns a
  // labelled object with a null value instead, which is the case below.
  node.classList.toggle("hidden", !stats);
  if (!stats) return;

  label.textContent = stats.label;
  // A dash rather than 0.00: before the first dart there is no average, and
  // showing zero reads as a bad one. The LABEL is still the game's own - see
  // liveStats - so Cricket says MPR while it waits.
  value.textContent = stats.value === null
    ? "-"
    : stats.value.toFixed(stats.digits ?? 2);
  // The machines show a second figure under the first, and it earns its place:
  // in x01 it is the three-dart average, which is the number players actually
  // speak in, and in Cricket it is the points, which say something different
  // from the marks.
  // The caption comes from the stats object, not from here, so it always names
  // the number beneath it: 3DA where that is a three-dart average, PPR in
  // Cricket where it is points per round and no kind of average at all.
  if (second) {
    second.textContent = typeof stats.secondary === "number"
      ? `${stats.secondaryLabel || ""} ${stats.secondary.toFixed(2)}`.trim()
      : "";
  }
}

/**
 * @param {HTMLElement} node   where it goes; absent is fine
 * @param {object} state       { on, remaining, dartsLeft, rules, bull }
 */
export function renderCheckoutHint(node, state) {
  if (!node) return;

  const level = getPref("checkoutHelp");
  const { on, remaining, dartsLeft, rules, bull } = state || {};

  if (!on || level === "off" || !Number.isInteger(remaining)) {
    node.textContent = "";
    node.classList.add("hidden");
    return;
  }

  const lines = checkoutAdvice(remaining, dartsLeft, rules, bull, {
    level,
    onlyUnder100: getPref("checkoutUnder100"),
  });

  if (!lines.length) {
    // No route is a fact worth nothing: at 167 with two darts left there is
    // simply nothing to aim at, and saying so is noise on a screen someone is
    // reading between throws.
    node.textContent = "";
    node.classList.add("hidden");
    return;
  }

  node.textContent = "";
  node.classList.remove("hidden");

  // Built as elements rather than innerHTML out of habit, and because the
  // multi-route view wants each line to be its own row.
  for (const line of lines) {
    const row = document.createElement("span");
    row.className = "checkout-route";
    row.textContent = line;
    node.appendChild(row);
  }
}
