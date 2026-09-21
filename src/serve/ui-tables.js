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

/** Statuses counted as active by the In flight chip and the runs poller. */
export const ACTIVE_STATUSES = new Set(["running", "started", "awaiting_approval"]);

/**
 * What an empty runs list says (spec 042 FR-006).
 *
 * Every branch names the next move. An empty state is an invitation to act, not
 * a mood: "No runs." leaves an operator who has just arrived with nowhere to go,
 * which on a page whose whole job is making machinery visible is a dead end.
 *
 * @param {string} filter One of the runs chips: "active", "finished", "all".
 * @returns {string} HTML — the link is the only markup in it.
 */
export function emptyRunsMessage(filter) {
  const start = 'Start one from <a href="#/workflows">Workflows</a>.';
  if (filter === "finished") return `No run has finished yet. ${start}`;
  if (filter === "all") return `No runs on record. ${start}`;
  return `Nothing is running. ${start}`;
}

/**
 * Mastra's own synthetic bookkeeping for parallel merge branches (spec 042 D7).
 * No pipeline author declares one, so an operator shown `__merge_level_1` as the
 * current step learns nothing and mistrusts the number next to it.
 */
const SYNTHETIC_STEP_ID = /^__merge_level_\d+$/u;

/**
 * Where a run has got to, for the runs list (spec 042 D6/D7, FR-005).
 *
 * `steps` is `GetResult.steps` — the run's own per-step states, keyed by id —
 * and `declaredStepIds` is the pipeline's declared step list, which is what N
 * and M are counted against: M is how many steps the author wrote, not how many
 * have happened, so the denominator does not grow as the run advances.
 *
 * The current step is the one that is running. Between steps — and while a
 * synthetic merge is in flight — it is the last step to leave "running", marked
 * `current: false` so the caller can label it rather than imply work is
 * happening there now. Returns null when nothing has started yet.
 *
 * @param {Record<string, { status?: string, startedAt?: string, finishedAt?: string }>} steps
 * @param {string[]} declaredStepIds
 * @returns {{ stepId: string, current: boolean, n: number | null, m: number } | null}
 */
export function runProgress(steps, declaredStepIds) {
  const declared = Array.isArray(declaredStepIds) ? declaredStepIds : [];
  const own = Object.entries(steps ?? {}).filter(([id]) => !SYNTHETIC_STEP_ID.test(id));
  if (own.length === 0) return null;

  const latest = (candidates, key) =>
    candidates
      .filter(([, st]) => typeof st?.[key] === "string")
      .sort(([, a], [, b]) => Date.parse(a[key]) - Date.parse(b[key]))
      .pop();

  const running = own.filter(([, st]) => st?.status === "running" || st?.status === "started");
  const picked = running.length > 0 ? (latest(running, "startedAt") ?? running[0]) : null;
  const chosen = picked ?? latest(own, "finishedAt") ?? null;
  if (chosen === null) return null;

  const stepId = chosen[0];
  const index = declared.indexOf(stepId);
  return {
    stepId,
    current: picked !== null,
    n: index === -1 ? null : index + 1,
    m: declared.length,
  };
}

/**
 * `runProgress` as the one line the runs table shows: `verify 4 of 8`, or
 * `verify (last) 4 of 8` between steps. A step the pipeline no longer declares —
 * an old run of a since-edited workflow — keeps its id and drops the position
 * rather than inventing one.
 *
 * @param {{ stepId: string, current: boolean, n: number | null, m: number } | null} progress
 * @returns {string}
 */
export function progressCell(progress) {
  if (progress === null || progress === undefined) return "";
  const label = progress.current ? esc(progress.stepId) : `${esc(progress.stepId)} (last)`;
  const position =
    progress.n === null || progress.m === 0
      ? ""
      : ` <span class="num">${esc(progress.n)} of ${esc(progress.m)}</span>`;
  return `<span class="step-id">${label}</span>${position}`;
}

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
    writable ? btn("Edit", "data-edit-wf", id) : btn("Fork…", "data-fork-wf", id),
    btn(hidden ? "Show" : "Hide", "data-toggle-wf", id, "", `data-wf-hidden="${hidden}"`),
    ...(writable ? [btn("Delete", "data-del-wf", id, "danger")] : []),
  ].join("");
  return (
    `<tr data-wf-row="${esc(id)}">` +
    // The name opens the workflow. An anchor rather than a click handler, so it
    // carries its own affordance and answers the keyboard and middle-click the
    // way every other link on the page does; the separate View button it
    // replaces said the same thing twice.
    `<td class="pipeline-id"><a class="wf-open" href="#/workflows/${encodeURIComponent(id)}">${esc(
      id
    )}</a>${hidden ? ' <span class="badge">hidden</span>' : ""}</td>` +
    `<td class="pipeline-desc">${esc(wf?.description ?? "")}</td>` +
    `<td>${esc(wf?.steps ?? "")}</td>` +
    `<td class="pipeline-id">${esc(inputs)}</td>` +
    `<td class="muted">${esc(layer)}${shadows ? ` (shadows ${esc(shadows)})` : ""}</td>` +
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
 * While the run is advancing the row also carries where it has got to — the
 * current step and its position in the pipeline (spec 042 FR-005) — so the
 * common question "what is it doing right now" is answered from the list,
 * without opening the run.
 *
 * @param {{ runId: string, pipelineId?: string, status?: string, createdAt?: string,
 *   settledAt?: string, source?: string, projectKey?: string, projectName?: string }} r
 * @param {{ selected?: boolean, progress?: object | null, showProject?: boolean }} [opts]
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
  // The project column appears only when the list spans more than one, so a
  // single-project machine gains no column it would read the same value in.
  const projectCell = opts?.showProject
    ? `<td class="pipeline-id muted" title="${esc(r?.projectKey ?? "")}">${esc(
        r?.projectName ?? ""
      )}</td>`
    : "";
  return (
    `<tr data-run-row="${esc(r?.runId ?? "")}" data-run-project="${esc(r?.projectKey ?? "")}"${
      rowClasses ? ` class="${rowClasses}"` : ""
    }>` +
    `<td><span class="badge ${esc(sc)}">${esc(r?.status ?? "")}</span>${diskMark}</td>` +
    projectCell +
    // The workflow answers "what is this doing"; the subject answers "to what".
    // Both belong in one cell — a run of `code-review` against one pull request
    // is otherwise indistinguishable from a run against the next (042 D14).
    `<td class="pipeline-id">${esc(r?.pipelineId ?? "")}${
      r?.subject ? `<div class="run-subject" title="${esc(r.subject)}">${esc(r.subject)}</div>` : ""
    }</td>` +
    `<td class="run-step">${progressCell(opts?.progress ?? null)}</td>` +
    `<td class="muted">${esc(fmtTime(r?.createdAt))}</td>` +
    `<td class="muted num">${elapsed}</td>` +
    `<td class="actions">${btn("Details", "data-run-details", String(r?.runId ?? ""))}</td>` +
    `</tr>`
  );
}
