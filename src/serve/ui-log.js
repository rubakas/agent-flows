// Run-view renderers for the step log, gate decisions and step outputs
// (spec 036 D9/D10, spec 037 D10/FR-011).
//
// Plain ESM with no dependencies and no DOM access, served by the daemon at
// /ui-log.js and imported by ui.html. It lives in its own file for the same
// reason ui-route.js does: the table-from-JSON-keys path is new logic with no
// precedent in the page to copy, so it has to be unit-testable — including its
// escaping — without a browser.
//
// Everything these functions render is model-produced or repository-produced
// and reaches the page through prompt injection or a hostile checkout, so every
// dynamic value passes through esc().

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

/** The page keeps at most this many rendered events per step (spec 036 D5). */
export const MAX_EVENTS_PER_STEP = 2000;

/** A tool call summarised for one line is cut here; a cell in an output table at 200. */
const TOOL_SUMMARY_LIMIT = 160;
const OUTPUT_CELL_LIMIT = 200;

/** "" for absent values, so a missing argument renders as a bare tool name. */
function str(v) {
  return v === undefined || v === null ? "" : String(v);
}

function cut(text, limit) {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function compactJson(value) {
  if (value === undefined) return "";
  try {
    return str(JSON.stringify(value));
  } catch {
    return "";
  }
}

/** Join the parts of a summary line, dropping the ones that are absent. */
function line(...parts) {
  return parts.filter((p) => p !== "").join(" ");
}

/**
 * One line of plain (unescaped) text for a `tool.call` event, per spec 036 D10.
 * Exported separately from renderLogEvent so the summary strings can be tested
 * on their own; the caller is responsible for escaping.
 *
 * @param {{ name?: string, input?: unknown }} event
 * @returns {string}
 */
export function toolCallSummary(event) {
  const name = str(event?.name);
  const input = event?.input;
  const arg = (key) => (input && typeof input === "object" ? str(input[key]) : "");

  switch (name) {
    case "Read":
    case "Edit":
    case "Write":
      return line(name, arg("file_path"));
    case "Grep": {
      const pattern = arg("pattern");
      return line(name, pattern === "" ? "" : `"${pattern}"`, arg("path"));
    }
    case "Glob":
      return line(name, arg("pattern"));
    case "Bash":
      return line(name, arg("command"));
    default:
      return cut(line(name, compactJson(input)), TOOL_SUMMARY_LIMIT);
  }
}

/** `tool.call` → `log-tool-call`: a kind is a class name with the dot replaced. */
function kindClass(kind) {
  return `log-${str(kind).replace(/\./gu, "-")}`;
}

function muted(kind, text) {
  return `<li class="log-event ${kindClass(kind)} log-note">${esc(text)}</li>`;
}

/**
 * Render one step-log event as an `<li>` (spec 036 D10). `usage` renders as ""
 * — it is consumed by the step footer instead — and so does an unknown kind.
 *
 * @param {Record<string, any>} event One line of the run's events file.
 * @returns {string} HTML, or "" when the event has no line of its own.
 */
export function renderLogEvent(event) {
  if (!event || typeof event !== "object") return "";
  const kind = str(event.kind);

  switch (kind) {
    case "tool.call": {
      const classes = ["log-event", kindClass(kind)];
      if (event.nested === true) classes.push("nested");
      if (event.denied === true) classes.push("warn");
      const text = toolCallSummary(event) + (event.denied === true ? " (denied)" : "");
      return `<li class="${classes.join(" ")}">${esc(text)}</li>`;
    }
    case "tool.result": {
      const body = event.redacted === true ? "redacted" : str(event.excerpt);
      return `<li class="log-event ${kindClass(kind)}"><details class="log-result">
        <summary>result · ${esc(event.ok === true ? "ok" : "error")}</summary>
        <pre>${esc(body)}</pre>
      </details></li>`;
    }
    case "message":
      return `<li class="log-event ${kindClass(kind)}"><p>${esc(str(event.text))}</p></li>`;
    case "check.output": {
      const stream = event.stream === "stderr" ? "stderr" : "stdout";
      return `<li class="log-event ${kindClass(kind)}"><pre class="term ${stream}">${esc(str(event.text))}</pre></li>`;
    }
    case "watchdog":
      return `<li class="log-event ${kindClass(kind)} warn">${esc(
        `watchdog: ${str(event.pathology)} — ${str(event.detail)} (attempt ${str(event.attempt)})`
      )}</li>`;
    case "step.start":
      return muted(kind, line("step started", str(event.model), str(event.transport)));
    case "step.result":
      return muted(
        kind,
        line(`step ${str(event.status)}`, formatDuration(event.durationMs), str(event.error))
      );
    case "decision":
      return muted(
        kind,
        `decision: ${str(event.gateStepId)} ${event.approved === true ? "approved" : "rejected"} by ${
          event.decidedBy === "human" ? "human" : "judge"
        }`
      );
    case "judge.degraded":
      return muted(kind, `judge degraded: ${str(event.error)}`);
    case "log.truncated":
      return muted(kind, `log truncated after ${str(event.events)} events`);
    default:
      return "";
  }
}

/** "1m 32s" / "4.2s" / "840ms"; "" when the duration is not a finite number. */
function formatDuration(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}m ${total % 60}s`;
}

/**
 * The D9 footer of one step: cost, turns, tokens, duration and denials, read
 * from the step's last `usage` event and its `step.result`. Parts the provider
 * did not report are omitted; "" when nothing at all is known.
 *
 * @param {Array<Record<string, any>>} events The step's events, in seq order.
 * @returns {string} HTML.
 */
export function renderStepFooter(events) {
  const list = Array.isArray(events) ? events : [];
  let usage;
  let result;
  for (const ev of list) {
    if (!ev || typeof ev !== "object") continue;
    if (ev.kind === "usage") usage = ev;
    if (ev.kind === "step.result") result = ev;
  }

  const parts = [];
  if (usage && typeof usage.costUsd === "number") parts.push(`$${usage.costUsd.toFixed(4)}`);
  if (usage && typeof usage.turns === "number")
    parts.push(`${usage.turns} ${usage.turns === 1 ? "turn" : "turns"}`);
  if (usage && usage.usage && typeof usage.usage === "object") {
    const { inputTokens, outputTokens } = usage.usage;
    if (typeof inputTokens === "number" && typeof outputTokens === "number")
      parts.push(`${inputTokens} in / ${outputTokens} out`);
  }
  const durationMs = result ? result.durationMs : usage ? usage.durationMs : undefined;
  const duration = formatDuration(durationMs);
  if (duration !== "") parts.push(duration);
  if (usage && typeof usage.denials === "number" && usage.denials > 0)
    parts.push(`${usage.denials} denied`);

  return parts.length === 0 ? "" : esc(parts.join(" · "));
}

/**
 * The Decisions table of spec 036 D10: every gate decision recorded so far,
 * plus a final row for a judge that degraded to manual.
 *
 * @param {Array<Record<string, any>>} gateDecisions
 * @param {string | undefined} judgeError
 * @returns {string} HTML, or "" when there is nothing to show.
 */
export function renderDecisions(gateDecisions, judgeError) {
  const decisions = Array.isArray(gateDecisions) ? gateDecisions.filter(Boolean) : [];
  const error = str(judgeError);
  if (decisions.length === 0 && error === "") return "";

  let rows = "";
  for (const d of decisions) {
    const by = d.decidedBy === "human" ? "human" : line("judge", str(d.judgeModelId));
    const verdict = d.approved === true ? "approved" : "rejected";
    const badge = d.superseded === true ? ` <span class="decision-badge">superseded</span>` : "";
    rows += `<tr>
      <td class="pipeline-id">${esc(str(d.gateStepId))}</td>
      <td>${esc(by)}</td>
      <td>${esc(verdict)}${badge}</td>
      <td>${esc(str(d.reason))}</td>
      <td>${esc(str(d.decidedAt))}</td>
    </tr>`;
  }
  if (error !== "") {
    rows += `<tr class="warn">
      <td class="pipeline-id">—</td>
      <td>judge</td>
      <td>degraded</td>
      <td colspan="2">${esc(error)}</td>
    </tr>`;
  }

  return `<table class="decisions">
    <thead><tr><th>Gate</th><th>By</th><th>Verdict</th><th>Reason</th><th>When</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

/** True for the one shape that renders as a table: a non-empty array of plain objects. */
function isRowArray(output) {
  return (
    Array.isArray(output) &&
    output.length > 0 &&
    output.every((row) => row !== null && typeof row === "object" && !Array.isArray(row))
  );
}

/** A cell value as text: strings as they are, anything else as compact JSON. */
function cellText(value) {
  return typeof value === "string" ? value : compactJson(value);
}

/**
 * One step's persisted output, as served by GET /api/runs/:id/steps/:stepId/output
 * (spec 036 D6/D10): an array of objects as a table whose columns are the union
 * of keys in order of first appearance, any other JSON pretty-printed, text as-is.
 *
 * @param {{ kind?: string, output?: unknown } | null | undefined} payload
 * @returns {string} HTML.
 */
export function renderOutput(payload) {
  if (!payload || typeof payload !== "object") return "";
  const { kind, output } = payload;

  if (kind === "json" && isRowArray(output)) {
    const columns = [];
    for (const row of output) {
      for (const key of Object.keys(row)) if (!columns.includes(key)) columns.push(key);
    }
    const head = columns.map((c) => `<th>${esc(c)}</th>`).join("");
    let rows = "";
    for (const row of output) {
      let cells = "";
      for (const column of columns) {
        const text = cellText(row[column]);
        cells +=
          text.length > OUTPUT_CELL_LIMIT
            ? `<td><details><summary>${esc(cut(text, OUTPUT_CELL_LIMIT))}</summary><pre>${esc(text)}</pre></details></td>`
            : `<td>${esc(text)}</td>`;
      }
      rows += `<tr>${cells}</tr>`;
    }
    return `<table class="output"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>`;
  }

  if (kind === "json") {
    let text;
    try {
      text = str(JSON.stringify(output, null, 2));
    } catch {
      text = "";
    }
    return `<pre class="code-block">${esc(text)}</pre>`;
  }

  return `<pre class="code-block">${esc(str(output))}</pre>`;
}

/**
 * Merge incoming events into a run's log state by `seq` (spec 036 D4/D5).
 *
 * The page opens the SSE stream before it fetches the backfill, so the same
 * event can arrive twice; `seq` is what makes that idempotent. Pure: the given
 * state is never mutated.
 *
 * @param {{ lastSeq: number, byStep: Map<string, Array<Record<string, any>>>,
 *           droppedEarlier: Map<string, number> } | null | undefined} state
 * @param {Array<Record<string, any>>} incoming
 * @returns {{ lastSeq: number, byStep: Map<string, Array<Record<string, any>>>,
 *             droppedEarlier: Map<string, number> }}
 */
export function mergeLogEvents(state, incoming) {
  let lastSeq = state ? state.lastSeq : 0;
  const byStep = new Map(state ? state.byStep : undefined);
  const droppedEarlier = new Map(state ? state.droppedEarlier : undefined);

  const fresh = (Array.isArray(incoming) ? incoming : [])
    .filter((ev) => ev && typeof ev === "object" && typeof ev.seq === "number")
    .sort((a, b) => a.seq - b.seq);

  // Copy an existing step's array once, the first time this call appends to it.
  const copied = new Set();
  for (const ev of fresh) {
    if (ev.seq <= lastSeq) continue;
    lastSeq = ev.seq;
    const stepId = str(ev.stepId);
    let events = byStep.get(stepId);
    if (!copied.has(stepId)) {
      events = events === undefined ? [] : events.slice();
      copied.add(stepId);
      byStep.set(stepId, events);
    }
    events.push(ev);
    if (events.length > MAX_EVENTS_PER_STEP) {
      const dropped = events.length - MAX_EVENTS_PER_STEP;
      events.splice(0, dropped);
      droppedEarlier.set(stepId, (droppedEarlier.get(stepId) ?? 0) + dropped);
    }
    byStep.set(stepId, events);
  }

  return { lastSeq, byStep, droppedEarlier };
}
