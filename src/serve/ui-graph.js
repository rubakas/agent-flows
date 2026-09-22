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

import { esc } from "./ui-esc.js";

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
 * Where an edge attaches to a box, spread down its side.
 *
 * Every edge used to meet its box at the vertical middle, so the three edges
 * arriving at `verify` landed on one point and their three arrowheads stacked
 * into what looked like one — you could not tell which line went where, which
 * is the complaint this answers. With `n` edges on a side, the `i`th sits at its
 * own height, and each arrowhead is its own.
 *
 * @param {number} boxY Top of the box.
 * @param {number} i Index of this edge among those on that side.
 * @param {number} n How many edges share that side.
 * @returns {number}
 */
export function attachY(boxY, i, n) {
  return boxY + (BOX_H * (i + 1)) / (n + 1);
}

/**
 * The path one edge takes, as right angles rather than a diagonal.
 *
 * A straight line between two boxes crossed the column gap at an angle, and over
 * a two-column span it crossed whatever box sat between — which is how the
 * diagram came to read as a spray of crossing lines.
 *
 * Two routes, because one is not enough. An edge to the NEXT column turns once
 * in the gutter before its target, which is always empty. An edge spanning more
 * than one column cannot be routed between the boxes at all: every horizontal
 * lane at box height is occupied by the columns it skips. It drops into a lane
 * BELOW the diagram, runs across there, and climbs into its target's gutter.
 *
 * @param {{ x: number, y: number }} start Where it leaves the source box.
 * @param {{ x: number, y: number }} end Where it meets the target box.
 * @param {number} turnX X of the vertical run, in the gutter before the target.
 * @param {number} [laneY] Y of the free lane below the boxes, for long spans.
 * @returns {string} An SVG path `d`.
 */
export function edgePath(start, end, turnX, laneY) {
  if (start.y === end.y) return `M${start.x} ${start.y} H${end.x}`;
  const spansOneColumn = end.x - start.x <= COL_GAP + 1;
  if (spansOneColumn || laneY === undefined) {
    return `M${start.x} ${start.y} H${turnX} V${end.y} H${end.x}`;
  }
  const out = start.x + COL_GAP / 2;
  return `M${start.x} ${start.y} H${out} V${laneY} H${turnX} V${end.y} H${end.x}`;
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
  // Count first: an edge's attachment height depends on how many others share
  // that side of the box, which is not known until every edge has been seen.
  const drawable = edges.filter((e) => pos.has(e.from) && pos.has(e.to));
  const outOf = new Map();
  const intoOf = new Map();
  for (const e of drawable) {
    outOf.set(e.from, (outOf.get(e.from) ?? 0) + 1);
    intoOf.set(e.to, (intoOf.get(e.to) ?? 0) + 1);
  }
  const outSeen = new Map();
  const inSeen = new Map();
  for (const e of drawable) {
    const from = pos.get(e.from);
    const to = pos.get(e.to);
    const oi = outSeen.get(e.from) ?? 0;
    const ii = inSeen.get(e.to) ?? 0;
    outSeen.set(e.from, oi + 1);
    inSeen.set(e.to, ii + 1);
    const start = { x: from.x + BOX_W, y: attachY(from.y, oi, outOf.get(e.from)) };
    const end = { x: to.x, y: attachY(to.y, ii, intoOf.get(e.to)) };
    // Fan the turn apart too, so two edges into neighbouring heights do not run
    // their verticals along the same line.
    const turnX = to.x - COL_GAP / 2 + (ii - (intoOf.get(e.to) - 1) / 2) * LANE;
    body += `<path class="edge" d="${edgePath(start, end, turnX, laneY)}" marker-end="url(#af-arrow)" />`;
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
