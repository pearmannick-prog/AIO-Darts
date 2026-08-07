// cricketboard.js - the DartConnect-style cricket board, shared by local and
// online play.
//
// Extracted from game.js for the same reason dartboard.js was: online mode
// needs the identical board, and a second copy would drift. This module owns
// the markup and the click-to-segment translation; it knows nothing about
// whose turn it is or how scoring works - callers hand it players and get
// segment IDs back.

import { createSegment, SegmentID } from "./granboard.js";
import {
  CRICKET_TARGETS, markSymbol, targetLabel, isClosedBy, isTargetDead,
} from "./cricket.js";

// Builds the board into containerEl.
//   players       - array of cricket player objects ({ name, marks, points })
//   currentIndex  - whose turn it is, for highlighting
export function renderCricketBoard(containerEl, players, currentIndex) {
  if (!containerEl) return;

  // Targets run down the centre with D and T either side, and each player's
  // marks sit in a flanking column. Players are split around the centre so
  // two read as the familiar left-vs-right board; three or four still work,
  // just unevenly split.
  const half = Math.ceil(players.length / 2);
  const left = players.map((p, i) => ({ p, i })).slice(0, half);
  const right = players.map((p, i) => ({ p, i })).slice(half);

  const side = (group, cls) => `<div class="ck-side ${cls}">` +
    group.map(({ p, i }) =>
      `<div class="ck-col${i === currentIndex ? " active" : ""}">
         <div class="ck-name">${p.name}</div>
         <div class="ck-points">${p.points}</div>
       </div>`).join("") + `</div>`;

  // data-marks carries the COUNT as well as the glyph, because the three
  // symbols do not share metrics: the single mark is a box-drawing diagonal
  // (U+2571), which by definition fills its whole em box, while the X and the
  // circled X are ordinary symbols with side bearings. At one font-size the
  // slash therefore drew visibly longer than the X above it. CSS evens them up
  // - see .ck-mark[data-marks="1"] - and it has to be done there rather than by
  // picking a different character, because nothing in the common fonts is both
  // a clean diagonal and metrically matched to U+2715.
  const marksFor = (group, target) => `<div class="ck-side">` +
    group.map(({ p }) => {
      const count = p.marks[target] || 0;
      return `<div class="ck-mark${isClosedBy(p, target) ? " closed" : ""}" data-marks="${count}">${markSymbol(count)}</div>`;
    }).join("") + `</div>`;

  const rows = CRICKET_TARGETS.map((target) => {
    const dead = isTargetDead(players, target);
    // There is no triple bull on a real board, so that button is disabled
    // rather than quietly scoring something wrong.
    const noTriple = target === "BULL";
    return `<div class="ck-row${dead ? " dead" : ""}">
      ${marksFor(left, target)}
      <div class="ck-controls">
        <button type="button" class="ck-mod" data-target="${target}" data-mult="2">D</button>
        <button type="button" class="ck-num" data-target="${target}" data-mult="1">${targetLabel(target)}</button>
        <button type="button" class="ck-mod${noTriple ? " ck-disabled" : ""}" data-target="${target}" data-mult="3"${noTriple ? " disabled" : ""}>T</button>
      </div>
      ${marksFor(right, target)}
    </div>`;
  }).join("");

  // NO MISS BUTTON. End turn is the one control that means "that visit is
  // over", and a Miss button beside it is a second way to say the same thing
  // that says it less well: a miss is only ever interesting as part of a visit,
  // and tapping it once for each dart that went nowhere is bookkeeping the
  // player is being asked to do on the app's behalf. Ending the turn now
  // records the darts that were not entered as thrown and missed - see
  // matchrecorder's endTurn - so the averages come out the same without anyone
  // tapping anything three times.
  //
  // It also bought the pad a whole row back, which at the oche is the
  // difference between the marks being readable and not.
  containerEl.innerHTML =
    `<div class="ck-row ck-header">
       ${side(left, "ck-left")}
       <div class="ck-controls"></div>
       ${side(right, "ck-right")}
     </div>` +
    rows;
}

// Translates a click on the board into the SAME segment a real Granboard hit
// or a click on the dartboard graphic would produce, so every input path ends
// up in one scoring routine. Returns null for clicks that aren't a button.
export function segmentFromBoardClick(target) {
  const btn = target.closest?.("[data-target]");
  if (!btn || btn.disabled) return null;

  const name = btn.dataset.target;
  const mult = Number(btn.dataset.mult);

  if (name === "MISS") return createSegment(SegmentID.MISS);
  if (name === "BULL") return createSegment(mult === 2 ? SegmentID.DBL_BULL : SegmentID.BULL);

  const section = Number(name);
  if (!Number.isFinite(section)) return null;
  const slot = mult === 3 ? 1 : mult === 2 ? 3 : 0; // triple / double / single
  return createSegment((section - 1) * 4 + slot);
}

// One delegated listener rather than rebinding every button on each render -
// the board is rewritten after every dart.
export function wireCricketBoard(containerEl, onSegment) {
  containerEl?.addEventListener("click", (event) => {
    const segment = segmentFromBoardClick(event.target);
    if (segment) onSegment(segment);
  });
}
