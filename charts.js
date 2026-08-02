// charts.js - the small number of chart shapes this app needs, as inline SVG.
//
// WHY HAND-ROLLED. There is no build step here, a strict offline story (the
// service worker precaches everything and the app is installable), and the
// Android wrapper ships the front-end as files. A charting library would be the
// single largest dependency in the project, would have to be vendored to work
// offline, and would be used for two chart types. This is a few hundred lines
// and has no supply chain.
//
// COLOUR. Every chart here is single-series, drawn in the app's felt green on
// the cream panel, and that is a decision rather than a limitation. The brand's
// obvious "two series" pairing - the green and red already used for win and
// loss - fails colour-blind separation badly (deuteranopia ΔE 5.6, where 8 is
// the floor), and the gold has under 2:1 contrast against the cream panel, so
// it cannot carry a mark. Rather than introduce off-brand hues, each chart
// answers one question with one series, and identity comes from the title and
// the labels instead of from colour. Nothing here is ever colour-alone.
//
// The charts are also given a table view by the caller (see accountui.js), so
// the numbers are readable without seeing the picture at all.

const INK = "#1B1A14";
const FELT = "#0F3D2E";
const GRID = "rgba(27,26,20,0.12)";
const MUTED = "rgba(27,26,20,0.55)";

// A fixed viewBox with a fluid width: the SVG scales to its container and the
// geometry below can be written in one coordinate system.
const W = 640;
const H = 220;
const PAD = { top: 14, right: 14, bottom: 26, left: 40 };

const plot = {
  x: PAD.left,
  y: PAD.top,
  w: W - PAD.left - PAD.right,
  h: H - PAD.top - PAD.bottom,
};

function svgEl(name, attrs = {}) {
  const node = document.createElementNS("http://www.w3.org/2000/svg", name);
  for (const [key, value] of Object.entries(attrs)) {
    node.setAttribute(key, String(value));
  }
  return node;
}

// "Nice" axis maximum: rounds up to something a person would choose, so the top
// gridline reads 100 rather than 97.3.
function niceMax(value) {
  if (value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const normalized = value / magnitude;
  const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return step * magnitude;
}

function gridAndAxis(svg, max, formatValue) {
  // Four bands is enough to read a value off and few enough to stay recessive -
  // except on a small count, where quartering the axis produces gridlines at
  // 0.25 and 0.75 of a 180. A chart of things that come in whole numbers gets
  // whole-numbered gridlines.
  const lines = Number.isInteger(max) && max > 0 && max <= 5 ? max : 4;
  for (let i = 0; i <= lines; i++) {
    const value = (max / lines) * i;
    const y = plot.y + plot.h - (plot.h * i) / lines;

    svg.appendChild(svgEl("line", {
      x1: plot.x, x2: plot.x + plot.w, y1: y, y2: y,
      stroke: GRID, "stroke-width": 1,
    }));

    const label = svgEl("text", {
      x: plot.x - 8, y: y + 4, "text-anchor": "end",
      fill: MUTED, "font-size": 11, "font-family": "Inter, sans-serif",
    });
    label.textContent = formatValue(value);
    svg.appendChild(label);
  }
}

// Labels only at the ends and the middle. A tick under every point is the
// commonest way a small chart becomes unreadable.
function xLabels(svg, points) {
  if (!points.length) return;
  const picks = points.length <= 3
    ? points.map((_, i) => i)
    : [0, Math.floor((points.length - 1) / 2), points.length - 1];

  for (const index of new Set(picks)) {
    const point = points[index];
    const text = svgEl("text", {
      x: point.cx,
      y: H - 8,
      "text-anchor": index === 0 ? "start" : index === points.length - 1 ? "end" : "middle",
      fill: MUTED, "font-size": 11, "font-family": "Inter, sans-serif",
    });
    text.textContent = point.label;
    svg.appendChild(text);
  }
}

// ---------------------------------------------------------------------------
// Tooltip
// ---------------------------------------------------------------------------
// One per chart, positioned over the container. An HTML chart is interactive by
// nature and a chart you cannot interrogate is a picture of data rather than a
// view of it - so this is default equipment, not an enhancement.
function attachTooltip(container) {
  const tip = document.createElement("div");
  tip.className = "chart-tip hidden";
  container.appendChild(tip);

  return {
    show(html, cx, cy) {
      tip.innerHTML = html;
      tip.classList.remove("hidden");
      // Positioned in percentages so it follows the SVG as it scales.
      tip.style.left = `${(cx / W) * 100}%`;
      tip.style.top = `${(cy / H) * 100}%`;
    },
    hide() {
      tip.classList.add("hidden");
    },
  };
}

function emptyState(container, message) {
  container.innerHTML = "";
  const note = document.createElement("p");
  note.className = "chart-empty";
  note.textContent = message;
  container.appendChild(note);
}

// ---------------------------------------------------------------------------
// Line chart - a measure over time
// ---------------------------------------------------------------------------
// data: [{ label, value, detail? }] in time order.
export function lineChart(container, { data, format = (v) => String(v), empty = "Not enough matches yet." }) {
  if (!data?.length) return emptyState(container, empty);

  // A single point is a fact, not a trend - drawing a one-point "line" implies
  // a shape that isn't there.
  if (data.length === 1) {
    return emptyState(container, "One match so far - a trend needs a few more.");
  }

  container.innerHTML = "";
  container.classList.add("chart");

  const max = niceMax(Math.max(...data.map((d) => d.value)));
  const svg = svgEl("svg", {
    viewBox: `0 0 ${W} ${H}`,
    role: "img",
    preserveAspectRatio: "none",
  });

  gridAndAxis(svg, max, format);

  const points = data.map((d, i) => ({
    ...d,
    cx: plot.x + (plot.w * i) / (data.length - 1),
    cy: plot.y + plot.h - (plot.h * d.value) / max,
  }));

  svg.appendChild(svgEl("polyline", {
    points: points.map((p) => `${p.cx},${p.cy}`).join(" "),
    fill: "none", stroke: FELT, "stroke-width": 2,
    "stroke-linejoin": "round", "stroke-linecap": "round",
  }));

  // Markers only when they can be told apart; past that the line is the shape
  // and dots are noise.
  if (points.length <= 24) {
    for (const point of points) {
      svg.appendChild(svgEl("circle", {
        cx: point.cx, cy: point.cy, r: 4,
        fill: FELT, stroke: "#EFE6D2", "stroke-width": 2,
      }));
    }
  }

  xLabels(svg, points);
  container.appendChild(svg);

  // Hover: a crosshair snapped to the nearest point, because pixel-accurate
  // pointing at a 4px dot on a phone is not a reasonable thing to ask.
  const tip = attachTooltip(container);
  const crosshair = svgEl("line", {
    y1: plot.y, y2: plot.y + plot.h, stroke: GRID, "stroke-width": 1, opacity: 0,
  });
  svg.appendChild(crosshair);

  const overlay = svgEl("rect", {
    x: plot.x, y: plot.y, width: plot.w, height: plot.h,
    fill: "transparent", style: "cursor:crosshair",
  });

  overlay.addEventListener("pointermove", (event) => {
    const box = svg.getBoundingClientRect();
    const x = ((event.clientX - box.left) / box.width) * W;
    const nearest = points.reduce((best, p) =>
      Math.abs(p.cx - x) < Math.abs(best.cx - x) ? p : best, points[0]);

    crosshair.setAttribute("x1", nearest.cx);
    crosshair.setAttribute("x2", nearest.cx);
    crosshair.setAttribute("opacity", 1);
    tip.show(
      `<strong>${format(nearest.value)}</strong><span>${nearest.detail || nearest.label}</span>`,
      nearest.cx, nearest.cy
    );
  });

  overlay.addEventListener("pointerleave", () => {
    crosshair.setAttribute("opacity", 0);
    tip.hide();
  });

  svg.appendChild(overlay);
}

// ---------------------------------------------------------------------------
// Bar chart - a measure across categories
// ---------------------------------------------------------------------------
export function barChart(container, { data, format = (v) => String(v), empty = "Nothing to show yet." }) {
  if (!data?.length) return emptyState(container, empty);

  container.innerHTML = "";
  container.classList.add("chart");

  const max = niceMax(Math.max(...data.map((d) => d.value)));
  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", preserveAspectRatio: "none" });

  gridAndAxis(svg, max, format);

  // A 2px gap of surface between neighbours, so adjacent bars read as separate
  // marks rather than one striped block.
  const slot = plot.w / data.length;
  const barWidth = Math.max(2, Math.min(48, slot - 2));
  const tip = attachTooltip(container);

  const points = data.map((d, i) => {
    const cx = plot.x + slot * i + slot / 2;
    const height = max ? (plot.h * d.value) / max : 0;
    const y = plot.y + plot.h - height;

    const bar = svgEl("rect", {
      x: cx - barWidth / 2,
      y: d.value > 0 ? y : plot.y + plot.h - 1,
      width: barWidth,
      height: d.value > 0 ? Math.max(1, height) : 1,
      // Rounded at the data end only - the baseline end stays square, anchored
      // to the axis.
      rx: Math.min(4, barWidth / 2),
      fill: FELT,
    });

    bar.addEventListener("pointerenter", () => {
      tip.show(`<strong>${format(d.value)}</strong><span>${d.detail || d.label}</span>`, cx, y);
    });
    bar.addEventListener("pointerleave", () => tip.hide());
    svg.appendChild(bar);

    return { ...d, cx, cy: y };
  });

  xLabels(svg, points);
  container.appendChild(svg);
}

// ---------------------------------------------------------------------------
// Table view
// ---------------------------------------------------------------------------
// Every chart gets one. It is the accessible reading of the same data, the
// answer for anyone who cannot use a hover tooltip, and the thing that makes a
// colour-carrying chart unnecessary in the first place.
export function chartTable(container, { data, valueLabel, format = (v) => String(v) }) {
  container.innerHTML = "";
  if (!data?.length) return;

  const table = document.createElement("table");
  table.className = "chart-table";
  table.innerHTML =
    `<thead><tr><th>Period</th><th>${valueLabel}</th></tr></thead>` +
    `<tbody>${data.map((d) => `<tr><td>${d.label}</td><td>${format(d.value)}</td></tr>`).join("")}</tbody>`;
  container.appendChild(table);
}
