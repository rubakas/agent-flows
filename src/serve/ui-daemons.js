// The daemons panel: every agent-flows process on this machine (spec 042 D1-D5).
//
// Plain ESM with no dependencies and no DOM access, served by the daemon at
// /ui-daemons.js and imported by ui.html — the same shape as the other ui-*.js
// helpers, so the markup can be asserted without a browser.
//
// Two daemons once ran for two days unnoticed, serving a stale build to an owner
// who could not work out why his changes were missing. This panel is the answer
// to that, which is why a row is never rendered from the record alone: a record
// the daemon could not verify is shown as "not responding" and gets no Stop
// button, because signalling an unverified pid is signalling whatever process
// the operating system has since given that number to.

import { esc } from "./ui-esc.js";

/**
 * Span from an ISO timestamp to now as a short human string, for uptime.
 *
 * @param {string | undefined} startIso
 * @param {number} [now]
 * @returns {string}
 */
export function fmtUptime(startIso, now) {
  const startedMs = new Date(startIso).getTime();
  if (!Number.isFinite(startedMs)) return "—";
  const total = Math.max(0, Math.round(((now ?? Date.now()) - startedMs) / 1000));
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (d > 0) return `${d}d ${String(h).padStart(2, "0")}h`;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  return `${m}m`;
}

/** The last path segment of a project directory, which is what the operator calls it. */
function projectName(dir) {
  return String(dir ?? "")
    .replace(/\/+$/u, "")
    .split("/")
    .pop();
}

/**
 * One row of the daemons table (FR-002).
 *
 * `busy` is the row's own pending state — set the moment Stop is clicked, so a
 * second click cannot issue a second SIGTERM while the first is in flight, and
 * so stopping the daemon serving this very page shows "stopping…" rather than a
 * `stopped` the page will never live to observe (D9, FR-004).
 *
 * @param {{ projectKey: string, projectDir: string, pid: number, port: number,
 *   startedAt: string, live: boolean, self: boolean, staleReason?: string }} d
 * @param {{ now?: number, busy?: string, result?: string }} [opts]
 * @returns {string}
 */
export function daemonRow(d, opts) {
  const live = d?.live === true;
  const key = String(d?.projectKey ?? "");
  // One chip per row: a live daemon is either the one serving this page or just
  // another running process, and saying both takes two chips to say one thing.
  const status = !live
    ? `<span class="badge cancelled" title="${esc(d?.staleReason ?? "")}">not responding</span>`
    : d?.self === true
      ? `<span class="badge active">serving this page</span>`
      : `<span class="badge running">running</span>`;

  // D3: only a verified record gets a control wired to its pid. A stale row
  // offers nothing to click, because there is nothing it could safely signal.
  const action = !live
    ? `<span class="muted">stale record</span>`
    : opts?.busy === key
      ? `<span class="muted">stopping…</span>`
      : `<button class="btn danger" data-stop-daemon="${esc(key)}" data-stop-pid="${esc(
          d?.pid ?? ""
        )}" data-stop-project="${esc(projectName(d?.projectDir))}">Stop</button>`;

  // Seeing what another project's daemon is doing means opening its own page,
  // so its port is the link. This page's port would only reload this page, and
  // a port nothing answered on is a link to a connection error (FR-002).
  const port = Number(d?.port);
  const portCell =
    live && d?.self !== true && Number.isInteger(port)
      ? `<a href="http://localhost:${port}/" target="_blank" rel="noreferrer">${port}</a>`
      : esc(d?.port ?? "");

  return (
    `<tr data-daemon-row="${esc(key)}">` +
    `<td>${status}</td>` +
    `<td class="pipeline-id" title="${esc(d?.projectDir ?? "")}">${esc(
      projectName(d?.projectDir)
    )}</td>` +
    // The pid is developer trivia beside a Stop button that does the killing;
    // it stays on the row as a title for the rare manual `kill`, not a column.
    `<td class="num" title="pid ${esc(d?.pid ?? "")}">${portCell}</td>` +
    `<td class="num muted">${live ? esc(fmtUptime(d?.startedAt, opts?.now)) : "—"}</td>` +
    `<td class="actions">${action}${
      opts?.result ? `<span class="muted">${esc(opts.result)}</span>` : ""
    }</td>` +
    `</tr>`
  );
}

/**
 * The whole panel: the table, or the invitation to start a daemon (FR-006).
 *
 * The empty state names the command, because "no daemons" with nothing to do
 * about it is the state this whole spec exists to stop shipping.
 *
 * @param {object[]} daemons
 * @param {{ now?: number, busy?: string, results?: Record<string, string> }} [opts]
 * @returns {string}
 */
export function daemonsTable(daemons, opts) {
  const rows = Array.isArray(daemons) ? daemons : [];
  if (rows.length === 0) {
    return `<p class="empty">No daemon is running. Start one with <code>pnpm serve</code>.</p>`;
  }
  const body = rows
    .map((d) =>
      daemonRow(d, {
        now: opts?.now,
        busy: opts?.busy,
        result: opts?.results?.[String(d?.projectKey ?? "")],
      })
    )
    .join("");
  return (
    `<table class="table"><thead><tr>` +
    `<th>State</th><th>Project</th><th>Port</th><th>Uptime</th><th></th>` +
    `</tr></thead><tbody>${body}</tbody></table>`
  );
}

/**
 * What the operator is asked before a stop is issued (D8, FR-003).
 *
 * Names the project and the pid, because this is the page's only irreversible
 * action and "are you sure?" does not tell anyone what they are about to kill.
 *
 * @param {string} project
 * @param {number | string} pid
 * @returns {string}
 */
export function stopConfirmText(project, pid) {
  return `Stop the agent-flows daemon for ${project} (pid ${pid})? Any run it is executing ends with it.`;
}

/**
 * The outcome line for a completed stop (FR-003, FR-004).
 *
 * `disconnected` is what the page observed when the daemon it was talking to was
 * the one it stopped: the process is gone, so the answer never arrived. It is
 * reported as exactly that and never as `stopped`, which the page has no way to
 * know (D9).
 *
 * @param {{ outcome?: string, reason?: string, disconnected?: boolean }} result
 * @returns {string}
 */
export function stopResultLine(result) {
  if (result?.disconnected === true) {
    return "Disconnected — this page's own daemon stopped answering. Reload once it is running again.";
  }
  if (result?.outcome === "stopped") return "Stopped.";
  if (result?.outcome === "no-daemon") {
    return `Nothing to stop — ${result.reason ?? "the record was stale"}.`;
  }
  return `Unresolved — ${result?.reason ?? "the daemon did not confirm it stopped"}.`;
}
