// theme.js - what themes and accents exist, and whether a colour someone
// picked is actually readable.
//
// The themes THEMSELVES are not here. They are CSS, in index.html, as
// [data-theme=...] blocks. A theme applied from JavaScript has to wait for
// JavaScript, which is the flash the inline bootstrap exists to prevent, and it
// would have to re-run against every panel the app renders later. This file
// holds only what CSS cannot: the catalogue the picker iterates, and the
// arithmetic that decides whether a custom accent can be read.
//
// Because the CSS is scoped to [data-theme] on ANY element rather than :root,
// the picker's preview is the real theme rather than a swatch drawn to look
// like it - put the attribute on a card and its subtree simply IS that theme.
// Nothing in this file needs to know a single colour value, which is what stops
// the previews from drifting away from the themes they preview.

export const THEMES = [
  {
    id: "baize",
    label: "Pub Baize",
    blurb: "The original. Green cloth, cream card, brass numbers.",
  },
  {
    id: "night",
    label: "Oche Night",
    blurb: "Lights down, charcoal and gold. Dark whatever your phone says.",
  },
  {
    id: "broadcast",
    label: "Broadcast",
    blurb: "Televised: near-black, paper white, one red. The easiest to read from the oche.",
  },
];

// Eight, curated, rather than a colour wheel. A casual player must not be able
// to make their own scoreboard unreadable and then not know why - see the
// contrast check below for what happens when they insist.
export const ACCENTS = [
  { id: "gold", label: "Brass", hex: "#C7A24A" },
  { id: "tungsten", label: "Tungsten", hex: "#9BA7B0" },
  { id: "oche", label: "Oche Red", hex: "#C0392B" },
  { id: "baize", label: "Baize", hex: "#2F7A4D" },
  { id: "chalk", label: "Chalk Blue", hex: "#3D6BB8" },
  { id: "amber", label: "Amber", hex: "#E0902F" },
  { id: "plum", label: "Plum", hex: "#8E5BA6" },
  { id: "slate", label: "Slate", hex: "#5C7A8A" },
];

// ---------------------------------------------------------------------------
// Contrast
//
// WCAG relative luminance and contrast ratio. 4.5:1 is the threshold for body
// text; the accent carries button labels at 13-15px, so that is the bar used
// here rather than the 3:1 allowed for large text.

const CONTRAST_FLOOR = 4.5;

export function parseHex(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

const toHex = ({ r, g, b }) =>
  "#" + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("");

export function luminance(rgb) {
  const channel = (v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b);
}

export function contrastRatio(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

const INK = { r: 0x1b, g: 0x1a, b: 0x14 };
const WHITE = { r: 255, g: 255, b: 255 };

// Which of the two text colours the app has survives on top of this fill.
// Always answerable - one of black-ish and white always wins - so this reports
// the ratio too, and the caller decides whether the winner is good enough.
export function pickOnAccent(hex) {
  const rgb = parseHex(hex);
  if (!rgb) return null;
  const onInk = contrastRatio(rgb, INK);
  const onWhite = contrastRatio(rgb, WHITE);
  return onInk >= onWhite
    ? { colour: toHex(INK), ratio: onInk }
    : { colour: toHex(WHITE), ratio: onWhite };
}

// Nudges a colour along its own lightness until label text clears the floor,
// which keeps the hue someone chose instead of substituting a different colour
// and calling it their choice.
function nearestPassing(hex) {
  const rgb = parseHex(hex);
  if (!rgb) return null;
  const best = pickOnAccent(hex);
  // Move AWAY from the text colour that is currently winning: if white text is
  // the better of the two, the fill needs to get darker, and vice versa.
  const towardsDark = best.colour === toHex(WHITE);
  const step = (c) => (towardsDark ? c * 0.96 : c + (255 - c) * 0.04);
  let candidate = { ...rgb };
  for (let i = 0; i < 80; i++) {
    candidate = { r: step(candidate.r), g: step(candidate.g), b: step(candidate.b) };
    const check = pickOnAccent(toHex(candidate));
    if (check && check.ratio >= CONTRAST_FLOOR) return toHex(candidate);
  }
  return null;
}

// The whole answer for a custom accent, in the shape the panel needs: does it
// work, what text goes on it, and if it does not, what nearby colour does.
//
// Deliberately a WARNING WITH A FIX rather than a refusal. Someone typing their
// club's colour in should get to keep it if they insist; what they should not
// get is an unreadable scoreboard and no idea why.
export function checkAccent(hex) {
  const rgb = parseHex(hex);
  if (!rgb) return { valid: false, message: "That isn't a colour code. Try something like #C7A24A." };

  const best = pickOnAccent(hex);
  const ok = best.ratio >= CONTRAST_FLOOR;
  if (ok) return { valid: true, ok: true, onAccent: best.colour, ratio: best.ratio };

  const suggestion = nearestPassing(hex);
  return {
    valid: true,
    ok: false,
    onAccent: best.colour,
    ratio: best.ratio,
    suggestion,
    message: suggestion
      ? "Button text will be hard to read on this. A slightly deeper shade fixes it."
      : "Button text will be hard to read on this colour.",
  };
}

export const ACCENT_CONTRAST_FLOOR = CONTRAST_FLOOR;
