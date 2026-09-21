// Types for ui-tables.js. The row renderers ship as plain ESM so the browser
// can load them unbuilt from /ui-tables.js; this declaration lets the unit test
// import them without turning on allowJs for the whole project.

export interface WorkflowRowData {
  id: string;
  description?: string;
  steps?: number;
  inputs?: string[];
  /** The layer that owns this id (spec 038 FR-020). */
  layer?: string;
  /** Layers holding a same-id workflow this row shadows. */
  shadows?: string[];
  /** Hidden from the chat and page listings (spec 038 FR-026). */
  hidden?: boolean;
}

export interface RunRowData {
  runId: string;
  pipelineId?: string;
  status?: string;
  createdAt?: string;
  settledAt?: string;
  source?: string;
}

export declare const ACTIVE_STATUSES: Set<string>;
export declare function fmtTime(iso: string | undefined): string;
export declare function statusClass(status: string | undefined): string;
export declare function fmtElapsed(startIso?: string, endIso?: string): string;
export declare function workflowRow(wf: WorkflowRowData): string;
export declare function runRow(r: RunRowData, opts?: { selected?: boolean }): string;
