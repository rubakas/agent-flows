// Levels diagram for a pipeline (spec 037 D7/FR-007).
//
// Plain ESM with no dependencies and no DOM access, served by the daemon at
// /ui-graph.js and imported by ui.html. It is the workflow canvas the retired
// hybrid was adopted for (ADR-0017): the picture is generated from the
// levelling the binder already computes, so it can never disagree with what
// runs.
//
// Step ids come from YAML in the project's checkout, so every one of them is
// escaped and lands only in text nodes and quoted non-URL attributes — never in
// href/xlink:href, where an escaped "javascript:" would still execute (S7).

/**
 * Escape HTML entities. Identical to `escH` in ui.html and `esc` in ui-log.js —
 * the page's house rule is that all server data is escaped with it.
 *
 * @param {unknown} s
 * @returns {string}
 */
function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Box and spacing geometry (spec 037 D7). The container scrolls horizontally. */
export const BOX_W = 160;
export const BOX_H = 44;
export const COL_GAP = 48;
export const ROW_GAP = 16;
const MARGIN = 12;

/** The arrowhead every edge ends in, so direction is readable without tracing. */
const ARROW_DEFS =
  '<defs><marker id="af-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" ' +
  'markerHeight="6" orient="auto-start-reverse">' +
  '<path class="edge-head" d="M0 1 L7 4 L0 7 z" /></marker></defs>';

/** How far apart two edges sharing a gutter or a lane run from each other. */
const LANE = 5;

/**
 * The path one edge takes, as right angles rather than a diagonal.
 *
 * A straight line between two boxes on different rows crosses the column gap at
 * an angle, and over a two-column span it crosses whatever box sits between —
 * which is how the diagram came to read as a spray of crossing lines.
 *
 * Two routes, because one is not enough. An edge to the NEXT column turns once
 * in the gutter before its target, which is always empty. An edge spanning more
 * than one column cannot be routed between the boxes at all: every horizontal
 * lane at box height is occupied by the columns it skips. It drops into a lane
 * BELOW the diagram, runs across there, and climbs into its target's gutter.
 *
 * @param {{ x: number, y: number }} from Top-left of the source box.
 * @param {{ x: number, y: number }} to Top-left of the target box.
 * @param {number} lane Index among the edges arriving at this target.
 * @param {number} [laneY] Y of the free lane below the boxes, for long spans.
 * @returns {string} An SVG path `d`.
 */
export function edgePath(from, to, lane = 0, laneY) {
  const sx = from.x + BOX_W;
  const sy = from.y + BOX_H / 2;
  const ex = to.x;
  const ey = to.y + BOX_H / 2;
  const fan = (lane - 0.5) * LANE;
  const turn = ex - COL_GAP / 2 + fan;

  if (sy === ey) return `M${sx} ${sy} H${ex}`;

  // One column apart: the gutter before the target is the only gap needed.
  const spansOneColumn = ex - sx <= COL_GAP + 1;
  if (spansOneColumn || laneY === undefined) return `M${sx} ${sy} H${turn} V${ey} H${ex}`;

  // Further: out into our own gutter, down under everything, across, and up.
  const out = sx + COL_GAP / 2 + fan;
  return `M${sx} ${sy} H${out} V${laneY} H${turn} V${ey} H${ex}`;
}

/** Steps reachable by following dependsOn edges forward from the roots. */
function reachableIds(ids, edges) {
  const hasIncoming = new Set();
  for (const e of edges) hasIncoming.add(e.to);
  const outgoing = new Map();
  for (const e of edges) {
    if (!outgoing.has(e.from)) outgoing.set(e.from, []);
    outgoing.get(e.from).push(e.to);
  }
  const seen = new Set();
  const queue = ids.filter((id) => !hasIncoming.has(id));
  while (queue.length > 0) {
    const id = queue.shift();
    if (seen.has(id)) continue;
    seen.add(id);
    for (const next of outgoing.get(id) ?? []) queue.push(next);
  }
  return seen;
}

/**
 * The muted third line of a box: the mounted pipeline of a `loop` step and the
 * parent prefix of a nested-origin step.
 *
 * `kind: pipeline` steps are inlined before the page ever sees them, so a
 * mounted-pipeline marker only ever belongs to a `loop` box; a nested-origin
 * step is recognisable by its `parent.child` id (src/canon/nest.ts).
 */
function subLabel(id, step) {
  const parts = [];
  if (step?.kind === "loop" && step.pipeline) parts.push(`↻ ${String(step.pipeline)}`);
  const dot = id.indexOf(".");
  if (dot > 0) parts.push(`in ${id.slice(0, dot)}`);
  return parts.join(" · ");
}

/**
 * Render a pipeline's levels as an inline SVG: one column per level, one box
 * per step, one straight edge per dependsOn.
 *
 * @param {readonly (readonly string[])[]} levels Levelled step ids, as
 *   `pipelineLevels` returns them.
 * @param {{ nodes?: { id: string }[], edges?: { from: string, to: string }[] }} graph
 * @param {{ steps?: { id: string, kind?: string, role?: string, pipeline?: string }[] }} [opts]
 *   The pipeline's step definitions, used for the kind/role line.
 * @returns {string} An `<svg>` element as a string.
 */
export function renderLevelsSvg(levels, graph, opts) {
  const cols = Array.isArray(levels) ? levels.map((level) => [...level]) : [];
  const edges = (graph?.edges ?? []).filter(
    (e) => e && typeof e.from === "string" && typeof e.to === "string"
  );
  const stepById = new Map();
  for (const step of opts?.steps ?? []) {
    if (step && typeof step.id === "string") stepById.set(step.id, step);
  }

  const pos = new Map();
  cols.forEach((level, col) => {
    level.forEach((id, row) => {
      pos.set(id, {
        x: MARGIN + col * (BOX_W + COL_GAP),
        y: MARGIN + row * (BOX_H + ROW_GAP),
      });
    });
  });

  const rows = cols.reduce((max, level) => Math.max(max, level.length), 0);
  const width = cols.length * (BOX_W + COL_GAP) + 2 * MARGIN;
  const boxesBottom = MARGIN + Math.max(1, rows) * (BOX_H + ROW_GAP) - ROW_GAP;

  // An edge spanning more than one column has to pass under the boxes; the lane
  // it uses only exists if the picture is tall enough to hold it.
  const longEdges = edges.filter((e) => {
    const from = pos.get(e.from);
    const to = pos.get(e.to);
    return from !== undefined && to !== undefined && to.x - (from.x + BOX_W) > COL_GAP + 1;
  }).length;
  const laneY = longEdges > 0 ? boxesBottom + LANE * 2 : undefined;
  const height = (laneY === undefined ? boxesBottom : laneY + longEdges * LANE) + MARGIN;

  const allIds = cols.flat();
  const reachable = reachableIds(allIds, edges);

  let body = "";

  // Edges first so a box always paints over the line that ends under it.
  // Several edges arriving at one box would otherwise share a vertical segment
  // and read as a single thick line, so each gets its own lane in the gutter.
  const laneByTarget = new Map();
  for (const e of edges) {
    const from = pos.get(e.from);
    const to = pos.get(e.to);
    if (!from || !to) continue;
    const lane = laneByTarget.get(e.to) ?? 0;
    laneByTarget.set(e.to, lane + 1);
    body += `<path class="edge" d="${edgePath(from, to, lane, laneY)}" marker-end="url(#af-arrow)" />`;
  }

  for (const id of allIds) {
    const at = pos.get(id);
    const step = stepById.get(id);
    const kind = step?.kind === undefined ? "" : String(step.kind);
    const role = step?.role === undefined ? "" : String(step.role);
    const meta = [kind, role].filter((p) => p !== "").join(" · ");
    const sub = subLabel(id, step);
    const classes = ["node"];
    if (kind !== "") classes.push(`kind-${kind.replace(/[^a-z0-9-]/giu, "")}`);
    if (!reachable.has(id)) classes.push("unreachable");
    body +=
      `<g class="${esc(classes.join(" "))}" data-step="${esc(id)}">` +
      `<rect x="${at.x}" y="${at.y}" width="${BOX_W}" height="${BOX_H}" rx="3" />` +
      `<text class="node-id" x="${at.x + 8}" y="${at.y + 17}">${esc(id)}</text>` +
      (meta === ""
        ? ""
        : `<text class="node-meta" x="${at.x + 8}" y="${at.y + 30}">${esc(meta)}</text>`) +
      (sub === ""
        ? ""
        : `<text class="node-sub" x="${at.x + 8}" y="${at.y + 40}">${esc(sub)}</text>`) +
      `</g>`;
  }

  return (
    `<svg class="levels" width="${width}" height="${height}" ` +
    `viewBox="0 0 ${width} ${height}" role="img" aria-label="pipeline diagram">` +
    ARROW_DEFS +
    `${body}</svg>`
  );
}
