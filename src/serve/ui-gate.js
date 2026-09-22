// The gate box: what a person is actually being asked to approve (spec 043).
//
// Before this, the box held one line — the pipeline's `message:` string, which
// is identical on every run of that pipeline — and two buttons. It named the
// KIND of decision and said nothing about the run in front of you.
//
// Pure and DOM-free like its neighbours, because the substance here is model
// output and repository content: a `HardenedSpec` whose every field was written
// by a model, and a paragraph written by another one. All of it is escaped, and
// all of it is asserted without a browser.

import { esc } from "./ui-esc.js";
import { renderMarkdown } from "./ui-markdown.js";

/** Fields of a HardenedSpec that are lists, and what to call them. */
const SPEC_LISTS = [
  { key: "requirements", label: "Requirements" },
  { key: "acceptanceCriteria", label: "Acceptance criteria" },
  { key: "weaknesses", label: "Weaknesses" },
  { key: "securityFindings", label: "Security findings" },
];

/** A Finding is an object; a requirement is a string. Render either as one line. */
function lineOf(item) {
  if (item === null || typeof item !== "object") return String(item ?? "");
  const parts = [item.severity, item.title ?? item.summary ?? item.description, item.location];
  return parts.filter((p) => p !== undefined && p !== null && p !== "").join(" — ");
}

/**
 * The structural summary: the spec's own fields, listed (spec 043 D3).
 *
 * This is the fallback, and the owner explicitly chose a model-written summary
 * over it — it restates the shape of the payload rather than telling anyone what
 * the run decided. It is here because "insufficient" and "useless" are different
 * things, and when the model path has already failed this costs nothing.
 *
 * @param {unknown} spec
 * @returns {string} HTML, or "" when there is no spec to describe.
 */
export function structuralSummary(spec) {
  if (spec === null || typeof spec !== "object") return "";
  const title = String(spec.title ?? "").trim();
  const description = String(spec.description ?? "").trim();
  const counts = SPEC_LISTS.filter((f) => Array.isArray(spec[f.key]) && spec[f.key].length > 0).map(
    (f) => `${spec[f.key].length} ${f.label.toLowerCase()}`
  );
  if (title === "" && description === "" && counts.length === 0) return "";

  let html = "";
  if (title !== "") html += `<p class="gate-title">${esc(title)}</p>`;
  if (description !== "") html += `<p>${esc(description)}</p>`;
  if (counts.length > 0) html += `<p class="muted">${esc(counts.join(" · "))}</p>`;
  return html;
}

/** The spec's lists, in full, for the expander (D6). */
function specDetail(spec) {
  if (spec === null || typeof spec !== "object") return "";
  let html = "";
  for (const field of SPEC_LISTS) {
    const items = spec[field.key];
    if (!Array.isArray(items) || items.length === 0) continue;
    html +=
      `<p class="gate-title">${esc(field.label)}</p><ul class="md-list">` +
      items.map((i) => `<li>${esc(lineOf(i))}</li>`).join("") +
      `</ul>`;
  }
  return html;
}

/**
 * The whole gate box (spec 043 FR-004/FR-005/FR-006).
 *
 * Order is fixed: the question, then what the question is about, then the full
 * material one click away, then the buttons. The buttons are last because a
 * decision comes after its grounds.
 *
 * The label on the summary is load-bearing (D4). A model's reading of the run
 * and a mechanical listing of its fields can disagree, and only one of them can
 * be wrong about the run — an operator who cannot tell which they are looking
 * at has been handed the worse of the two.
 *
 * @param {{ gateMessage?: string, gateSummary?: string, spec?: unknown,
 *   gateStepId?: string }} gate
 * @returns {string} HTML.
 */
export function gateBox(gate) {
  const question = String(gate?.gateMessage ?? "").trim() || "Approve this spec?";
  const summary = String(gate?.gateSummary ?? "").trim();
  const structural = structuralSummary(gate?.spec);
  const detail = specDetail(gate?.spec);

  let body;
  if (summary !== "") {
    // renderMarkdown, not a bare paragraph: the prompt asks for prose, and a
    // model that answers with a list should not have it run together.
    body =
      `<div class="gate-summary"><p class="gate-label">Summary — written by a model, from the run's own output</p>` +
      `<div class="md">${renderMarkdown(summary)}</div></div>`;
  } else if (structural !== "") {
    body =
      `<div class="gate-summary"><p class="gate-label">No summary — the spec's own fields:</p>` +
      structural +
      `</div>`;
  } else {
    // FR-005: `ship`'s gate carries no spec at all. Saying what was looked for
    // beats repeating the question, which is what this box used to do.
    body =
      `<p class="muted">Nothing was attached to ${esc(gate?.gateStepId ?? "this gate")} to describe — ` +
      `no spec payload and no summary. The steps below are the only record of what ran.</p>`;
  }

  const expander =
    detail === "" && structural === ""
      ? ""
      : `<details class="gate-detail"><summary>The full spec</summary>${structural}${detail}</details>`;

  return (
    `<div class="gate-box">` +
    `<p class="gate-question">${esc(question)}</p>` +
    body +
    expander +
    `<div class="gate-actions">` +
    `<button class="btn primary" id="btn-approve-run">Approve</button>` +
    `<button class="btn danger" id="btn-reject-run">Reject (terminates run)</button>` +
    `</div></div>`
  );
}
