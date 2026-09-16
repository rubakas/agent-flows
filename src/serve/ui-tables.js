// Table row renderers for the page's lists (spec 037 D3/D4/FR-008).
//
// Plain ESM with no dependencies and no DOM access, served by the daemon at
// /ui-tables.js and imported by ui.html. The rows are here rather than inline
// in the page for the same reason ui-log.js is: every field in them —
// description, inputs, exportedAt, ids — comes from YAML in the checkout or
// from a bundle the owner was handed, so the escaping has to be testable
// without a browser.

/**
 * Escape HTML entities. Identical to `escH` in ui.html — the page's house rule
 * is that all server data is escaped with it or written via textContent.
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

/** Statuses counted as active by the Active chip and the runs poller. */
export const ACTIVE_STATUSES = new Set(["running", "started", "awaiting_approval"]);

/** Format a UTC ISO string as a short local time string. */
export function fmtTime(iso) {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return String(iso);
  }
}

/** Return a CSS class name for a run/step status string. */
export function statusClass(s) {
  if (s === "running" || s === "started") return "running";
  if (s === "awaiting_approval") return "awaiting_approval";
  if (s === "succeeded" || s === "completed") return "succeeded";
  if (s === "rejected") return "rejected";
  if (s === "cancelled") return "cancelled";
  if (s === "failed" || s === "terminated") return "failed";
  return "";
}

/**
 * Span between two ISO timestamps as a short human string; `endIso` defaults to
 * now, which is what an in-flight run needs. Returns "—" for anything
 * unparseable rather than "NaNs".
 */
export function fmtElapsed(startIso, endIso) {
  const startedMs = new Date(startIso).getTime();
  const endedMs = endIso === undefined ? Date.now() : new Date(endIso).getTime();
  if (!Number.isFinite(startedMs) || !Number.isFinite(endedMs)) return "—";
  const total = Math.max(0, Math.round((endedMs - startedMs) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${String(sec).padStart(2, "0")}s`;
  return `${sec}s`;
}

function btn(label, attr, value, extraClass, extraAttrs) {
  return `<button class="btn${extraClass ? ` ${extraClass}` : ""}" ${attr}="${esc(value)}"${
    extraAttrs ? ` ${extraAttrs}` : ""
  }>${esc(label)}</button>`;
}

/**
 * One row of the Workflows table (spec 038 D13/D14/D15).
 *
 * A workflow the project cannot write — a bundled one — offers `Fork…` where a
 * writable one offers `Edit`: both end in the editor, but the bundled one goes
 * through a copy first, so the package is never written (D14). `Delete` stays
 * off a bundled row because `DELETE /api/pipelines` answers 403 for it and
 * always will.
 *
 * The layer cell names the layer that owns the id and the layers it shadows
 * (FR-020); `hidden` marks a row this project has hidden from the chat surface
 * and this list (FR-026) — hidden is unlisted, never refused. The toggle
 * carries that state in `data-wf-hidden` rather than in its label, so renaming
 * the button cannot invert what clicking it does.
 *
 * @param {{ id: string, description?: string, steps?: number, inputs?: string[],
 *   layer?: string, shadows?: string[], hidden?: boolean }} wf
 * @returns {string}
 */
export function workflowRow(wf) {
  const id = String(wf?.id ?? "");
  const layer = String(wf?.layer ?? "");
  const writable = layer !== "bundled";
  const hidden = wf?.hidden === true;
  const inputs = Array.isArray(wf?.inputs) ? wf.inputs.join(", ") : "";
  const shadows = Array.isArray(wf?.shadows) && wf.shadows.length > 0 ? wf.shadows.join(", ") : "";
  const actions = [
    btn("Run…", "data-run-wf", id),
    btn("View", "data-view-wf", id),
    writable ? btn("Edit", "data-edit-wf", id) : btn("Fork…", "data-fork-wf", id),
    btn(hidden ? "Show" : "Hide", "data-toggle-wf", id, "", `data-wf-hidden="${hidden}"`),
    ...(writable ? [btn("Delete", "data-del-wf", id, "danger")] : []),
  ].join("");
  return (
    `<tr data-wf-row="${esc(id)}">` +
    `<td class="pipeline-id">${esc(id)}${hidden ? ' <span class="badge">hidden</span>' : ""}</td>` +
    `<td class="pipeline-desc">${esc(wf?.description ?? "")}</td>` +
    `<td>${esc(wf?.steps ?? "")}</td>` +
    `<td class="pipeline-id">${esc(inputs)}</td>` +
    `<td class="muted">${esc(layer)}${shadows ? ` (shadows ${esc(shadows)})` : ""}</td>` +
    `<td class="actions">${actions}</td>` +
    `</tr>`
  );
}

/**
 * One row of a Templates section (spec 037 D4, spec 038 D16). The two sections carry
 * different data: a bundled row is a pipeline we ship, a "yours" row is a saved
 * bundle in ~/.agent-flows/templates.
 *
 * @param {{ section: string, id?: string, description?: string, steps?: number,
 *   inputs?: string[], templateId?: string, sourcePipeline?: string,
 *   exportedAt?: string }} t
 * @returns {string}
 */
export function templateRow(t) {
  if (t?.section === "yours") {
    const tid = String(t.templateId ?? "");
    const actions = [
      btn("Preview", "data-preview-tmpl", tid),
      btn("Import", "data-import-tmpl", tid),
      btn("Delete", "data-del-tmpl", tid, "danger"),
    ].join("");
    return (
      `<tr data-tmpl-row="${esc(tid)}">` +
      `<td class="pipeline-id">${esc(tid)}</td>` +
      `<td class="pipeline-id">${esc(t.sourcePipeline ?? "")}</td>` +
      `<td class="pipeline-desc">${esc(t.exportedAt ?? "")}</td>` +
      `<td class="actions">${actions}</td>` +
      `</tr>`
    );
  }
  const id = String(t?.id ?? "");
  const inputs = Array.isArray(t?.inputs) ? t.inputs.join(", ") : "";
  // Import and export only (spec 038 D16): there is no install, and every
  // bundled workflow is already present in every project through the layers.
  const actions = [
    btn("Preview", "data-preview-bundled", id),
    btn("Export", "data-export-bundled", id),
  ].join("");
  return (
    `<tr data-bundled-row="${esc(id)}">` +
    `<td class="pipeline-id">${esc(id)}</td>` +
    `<td class="pipeline-desc">${esc(t?.description ?? "")}</td>` +
    `<td>${esc(t?.steps ?? "")}</td>` +
    `<td class="pipeline-id">${esc(inputs)}</td>` +
    `<td class="actions">${actions}</td>` +
    `</tr>`
  );
}

/**
 * One row of the Runs table (spec 034 FR-002/FR-011), moved here unchanged.
 *
 * A run restored from its artifact is a record, not a live process — the `disk`
 * badge says so in the row, so the missing Cancel button later is not a
 * surprise.
 *
 * @param {{ runId: string, pipelineId?: string, status?: string, createdAt?: string,
 *   settledAt?: string, source?: string }} r
 * @param {{ selected?: boolean }} [opts]
 * @returns {string}
 */
export function runRow(r, opts) {
  const sc = statusClass(r?.status);
  const isActive = ACTIVE_STATUSES.has(r?.status);
  // Active rows tick along with the poller; a settled run shows the fixed span
  // it actually took. A run settled before settledAt was recorded has no end to
  // measure to, so it shows no duration rather than a still-growing elapsed.
  const elapsed = isActive
    ? `<span title="running since ${esc(fmtTime(r.createdAt))}">${esc(fmtElapsed(r.createdAt))}</span>`
    : r?.settledAt !== undefined
      ? `<span title="settled ${esc(fmtTime(r.settledAt))}">${esc(fmtElapsed(r.createdAt, r.settledAt))}</span>`
      : `<span title="no settle time recorded for this run">—</span>`;
  const diskMark =
    r?.source === "disk"
      ? ` <span class="badge disk" title="restored from its artifact — this run is not live">disk</span>`
      : "";
  const rowClasses = [
    r?.status === "awaiting_approval" ? "awaiting" : "",
    opts?.selected ? "selected" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    `<tr data-run-row="${esc(r?.runId ?? "")}"${rowClasses ? ` class="${rowClasses}"` : ""}>` +
    `<td><span class="badge ${esc(sc)}">${esc(r?.status ?? "")}</span>${diskMark}</td>` +
    `<td class="pipeline-id">${esc(r?.pipelineId ?? "")}</td>` +
    `<td class="muted">${esc(fmtTime(r?.createdAt))}</td>` +
    `<td class="muted">${elapsed}</td>` +
    `<td class="actions">${btn("Details", "data-run-details", String(r?.runId ?? ""))}</td>` +
    `</tr>`
  );
}
