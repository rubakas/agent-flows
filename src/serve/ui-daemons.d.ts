// Types for ui-daemons.js. The panel ships as plain ESM so the browser can load
// it unbuilt from /ui-daemons.js; this declaration lets the unit test import it
// without turning on allowJs for the whole project.

/** One row of the daemons panel, as `GET /api/daemons` reports it (spec 042 FR-001). */
export interface DaemonRowData {
  projectKey: string;
  projectDir: string;
  pid: number;
  port: number;
  startedAt: string;
  version?: string;
  live: boolean;
  self: boolean;
  staleReason?: string;
}

export interface DaemonRowOptions {
  /** Injected clock, so uptime is assertable without waiting. */
  now?: number;
  /** The project key whose stop is in flight; that row shows "stopping…". */
  busy?: string;
  /** The outcome line to show beside this row's action. */
  result?: string;
}

/** What the page observed after issuing a stop (spec 042 FR-003, FR-004). */
export interface StopResultData {
  outcome?: string;
  reason?: string;
  /** True when the answer never arrived because the page's own daemon stopped. */
  disconnected?: boolean;
}

export declare function fmtUptime(startIso: string | undefined, now?: number): string;
export declare function daemonRow(d: DaemonRowData, opts?: DaemonRowOptions): string;
export declare function daemonsTable(
  daemons: DaemonRowData[],
  opts?: { now?: number; busy?: string; results?: Record<string, string> }
): string;
export declare function stopConfirmText(project: string, pid: number | string): string;
export declare function stopResultLine(result: StopResultData): string;
