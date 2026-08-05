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
