// quickentry.js - DartConnect-style whole-turn-total entry keypad.
//
// This is a fundamentally different input than the per-dart ring+section
// grid: instead of recording each dart's segment, the scorekeeper enters
// the TOTAL points scored that turn (e.g. "45"), the way DartConnect's
// keypad works. That means a quick-total entry always represents and
// finalizes an entire turn at once - the caller's onSubmit is expected to
// apply that total and end the turn immediately, regardless of how many
// individual darts would normally make up a turn.
//
// Because a bare total doesn't say which dart was a double, whether a
// checkout is valid can't be derived from the number alone. This keypad
// assumes: entering a total that brings the score to exactly 0 always
// counts as a valid double-out finish (matching how a scorekeeper would
// actually use this - you only tap the exact finishing number when someone
// really did check out; a missed attempt gets recorded as a bust/lower
// total instead). See README for how to tighten this if it causes issues.

const QUICK_TOTALS = [26, 41, 45, 60, 81, 85, 100, 140, 180];

export function createQuickEntry(container, onSubmit) {
  container.innerHTML = `
    <div class="quick-entry">
      <div class="quick-display" id="${container.id}-display">0</div>
      <div class="quick-shortcuts">
        ${QUICK_TOTALS.map((n) => `<button type="button" class="quick-shortcut-btn" data-total="${n}">${n}</button>`).join("")}
      </div>
      <div class="quick-pad">
        ${[7, 8, 9, 4, 5, 6, 1, 2, 3].map((n) => `<button type="button" class="quick-digit-btn" data-digit="${n}">${n}</button>`).join("")}
        <button type="button" class="quick-digit-btn quick-zero" data-digit="0">0</button>
        <button type="button" class="quick-back-btn">Back</button>
        <button type="button" class="quick-enter-btn">Enter</button>
      </div>
      <button type="button" class="quick-miss-btn">MISS (turn = 0)</button>
    </div>
  `;

  let typed = "";
  const display = container.querySelector(`#${container.id}-display`);

  function updateDisplay() {
    display.textContent = typed === "" ? "0" : typed;
  }

  function reset() {
    typed = "";
    updateDisplay();
  }

  container.querySelectorAll(".quick-digit-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (typed.length >= 3) return; // max possible turn score is 180
      const next = typed + btn.dataset.digit;
      if (Number(next) > 180) return;
      typed = next;
      updateDisplay();
    });
  });

  container.querySelector(".quick-back-btn").addEventListener("click", () => {
    typed = typed.slice(0, -1);
    updateDisplay();
  });

  container.querySelector(".quick-enter-btn").addEventListener("click", () => {
    if (typed === "") return;
    onSubmit(Number(typed));
    reset();
  });

  container.querySelectorAll(".quick-shortcut-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      onSubmit(Number(btn.dataset.total));
      reset();
    });
  });

  container.querySelector(".quick-miss-btn").addEventListener("click", () => {
    onSubmit(0);
    reset();
  });
}
