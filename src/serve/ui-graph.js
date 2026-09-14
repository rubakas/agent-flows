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
  const height = Math.max(1, rows) * (BOX_H + ROW_GAP) + 2 * MARGIN;

  const allIds = cols.flat();
  const reachable = reachableIds(allIds, edges);

  let body = "";

  // Edges first so a box always paints over the line that ends under it.
  for (const e of edges) {
    const from = pos.get(e.from);
    const to = pos.get(e.to);
    if (!from || !to) continue;
    body +=
      `<line class="edge" x1="${from.x + BOX_W}" y1="${from.y + BOX_H / 2}" ` +
      `x2="${to.x}" y2="${to.y + BOX_H / 2}" />`;
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
    `viewBox="0 0 ${width} ${height}" role="img" aria-label="pipeline diagram">${body}</svg>`
  );
}
