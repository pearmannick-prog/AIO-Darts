// dartboard.js - the clickable dartboard visual, shared by local and online
// modes.
//
// This used to live privately inside game.js, which meant online mode had no
// board at all. It's factored out here so both modes render the identical
// board from one source of truth - if the geometry or the ring-to-segment-ID
// mapping ever changes, it changes once and both modes stay consistent.
//
// Nothing in here knows about scoring or game state. It draws a board, tells
// you which segment ID was clicked, and positions a marker - the caller
// decides what that means.

import { SegmentID } from "./granboard.js";

// Standard dartboard number order, clockwise starting from the top (20).
export const BOARD_ORDER = [20, 1, 18, 4, 13, 6, 10, 15, 2, 17, 3, 19, 7, 16, 8, 11, 14, 9, 12, 5];

// Ring boundaries as a fraction of the double ring's outer radius - kept in
// sync with the fractions moveMarkerTo() uses below (inner/triple/outer/double)
// so the hit marker actually lands in the ring it's drawn in.
export const RING_BOUNDS = {
  doubleBull: 0.09,
  bull: 0.16,
  innerSingle: 0.56,
  triple: 0.64,
  outerSingle: 0.94,
  double: 1.0,
};

// The dartboard SVG is drawn in a 200x200 viewBox with the double ring's
// outer edge at this radius - used both to draw it and to convert a ring's
// fractional bounds into the [-1,1] coordinate space positionMarker() uses.
export const BOARD_R = 80;

function polarToCartesian(cx, cy, r, angleDeg) {
  const rad = (angleDeg * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

// Builds an SVG path for one "ring band" of one wedge (a donut slice).
function wedgeBandPath(cx, cy, innerR, outerR, startAngle, endAngle) {
  const p1 = polarToCartesian(cx, cy, outerR, startAngle);
  const p2 = polarToCartesian(cx, cy, outerR, endAngle);
  const p3 = polarToCartesian(cx, cy, innerR, endAngle);
  const p4 = polarToCartesian(cx, cy, innerR, startAngle);
  return `M ${p1.x} ${p1.y} A ${outerR} ${outerR} 0 0 1 ${p2.x} ${p2.y} ` +
         `L ${p3.x} ${p3.y} A ${innerR} ${innerR} 0 0 0 ${p4.x} ${p4.y} Z`;
}

// Generates a dartboard SVG matching a real board's layout: 20 numbered
// wedges, alternating light/dark singles, alternating red/green triple and
// double rings, and a red/green bullseye.
export function buildDartboardSVG() {
  const cx = 100, cy = 100, R = BOARD_R;
  // slot matches the ring-to-segmentId scheme used everywhere else in the
  // app (see manualSegmentFromRing in game.js / online.js and granboard.js's
  // SegmentID): 0=inner single, 1=triple, 2=outer single, 3=double.
  const bands = [
    { key: "innerSingle", slot: 0, from: RING_BOUNDS.bull, to: RING_BOUNDS.innerSingle, colors: ["#EFE6D2", "#1B1A14"] },
    { key: "triple", slot: 1, from: RING_BOUNDS.innerSingle, to: RING_BOUNDS.triple, colors: ["#B7302A", "#2F7A4D"] },
    { key: "outerSingle", slot: 2, from: RING_BOUNDS.triple, to: RING_BOUNDS.outerSingle, colors: ["#EFE6D2", "#1B1A14"] },
    { key: "double", slot: 3, from: RING_BOUNDS.outerSingle, to: RING_BOUNDS.double, colors: ["#B7302A", "#2F7A4D"] },
  ];

  let wedges = "";
  let numbers = "";

  for (let i = 0; i < 20; i++) {
    const center = -90 + i * 18;
    const start = center - 9;
    const end = center + 9;
    const color = (i, colors) => colors[i % 2];
    const boardNumber = BOARD_ORDER[i];

    for (const band of bands) {
      const path = wedgeBandPath(cx, cy, band.from * R, band.to * R, start, end);
      const segmentId = (boardNumber - 1) * 4 + band.slot;
      wedges += `<path class="dartboard-segment" data-segment-id="${segmentId}" ` +
                `d="${path}" fill="${color(i, band.colors)}" stroke="#0d0c09" stroke-width="0.4"/>`;
    }

    const labelPos = polarToCartesian(cx, cy, R * 1.12, center);
    numbers += `<text x="${labelPos.x}" y="${labelPos.y}" fill="#EFE6D2" font-family="Oswald, sans-serif" ` +
               `font-size="9" font-weight="600" text-anchor="middle" dominant-baseline="middle">${boardNumber}</text>`;
  }

  return `
    <svg viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg">
      <circle cx="${cx}" cy="${cy}" r="98" fill="#0F3D2E"/>
      <circle cx="${cx}" cy="${cy}" r="${R + 3}" fill="#111"/>
      ${wedges}
      <circle class="dartboard-segment" data-segment-id="${SegmentID.BULL}" cx="${cx}" cy="${cy}" r="${RING_BOUNDS.bull * R}" fill="#2F7A4D" stroke="#0d0c09" stroke-width="0.4"/>
      <circle class="dartboard-segment" data-segment-id="${SegmentID.DBL_BULL}" cx="${cx}" cy="${cy}" r="${RING_BOUNDS.doubleBull * R}" fill="#B7302A" stroke="#0d0c09" stroke-width="0.4"/>
      ${numbers}
    </svg>
  `;
}

// Renders the board into containerEl and wires every segment to onSegmentClick,
// which receives the numeric segment ID. Use this instead of touching the SVG
// directly so local and online modes behave identically.
export function renderDartboard(containerEl, onSegmentClick) {
  if (!containerEl) return;
  containerEl.innerHTML = buildDartboardSVG();
  containerEl.querySelectorAll("[data-segment-id]").forEach((node) => {
    node.addEventListener("click", () => onSegmentClick(Number(node.dataset.segmentId)));
  });
}

// Positions markerEl over the segment described by `segment`. markerEl is
// passed in rather than looked up so each mode can own its own marker element.
export function moveMarkerTo(markerEl, segment) {
  if (!markerEl) return;

  if (segment.section === "BULL") {
    positionMarker(markerEl, 0, 0);
    return;
  }
  if (segment.section === "Other" || typeof segment.section !== "number") {
    markerEl.classList.add("hidden");
    return;
  }

  const index = BOARD_ORDER.indexOf(segment.section);
  const angleDeg = -90 + index * 18;
  const angleRad = (angleDeg * Math.PI) / 180;

  // Midpoint of each ring band, converted from "fraction of BOARD_R" into
  // the [-1,1] container-fraction space positionMarker() expects (the
  // board face's outer edge sits at BOARD_R/100 of the container).
  const bandMidpoint = (from, to) => ((from + to) / 2) * (BOARD_R / 100);
  const ringRadius = {
    inner: bandMidpoint(RING_BOUNDS.bull, RING_BOUNDS.innerSingle),
    triple: bandMidpoint(RING_BOUNDS.innerSingle, RING_BOUNDS.triple),
    outer: bandMidpoint(RING_BOUNDS.triple, RING_BOUNDS.outerSingle),
    double: bandMidpoint(RING_BOUNDS.outerSingle, RING_BOUNDS.double),
  }[segment.ring] ?? 0.7;

  positionMarker(markerEl, ringRadius * Math.cos(angleRad), ringRadius * Math.sin(angleRad));
}

// x, y are in range [-1, 1] relative to the board center.
function positionMarker(markerEl, x, y) {
  markerEl.classList.remove("hidden");
  markerEl.style.left = `${50 + x * 48}%`;
  markerEl.style.top = `${50 + y * 48}%`;
}

export function hideMarker(markerEl) {
  markerEl?.classList.add("hidden");
}
