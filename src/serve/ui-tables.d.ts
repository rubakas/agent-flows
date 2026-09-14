// Types for ui-tables.js. The row renderers ship as plain ESM so the browser
// can load them unbuilt from /ui-tables.js; this declaration lets the unit test
// import them without turning on allowJs for the whole project.

export interface WorkflowRowData {
  id: string;
  description?: string;
  steps?: number;
  inputs?: string[];
  source?: string;
}

export interface TemplateRowData {
  section: string;
  id?: string;
  description?: string;
  steps?: number;
  inputs?: string[];
  templateId?: string;
  sourcePipeline?: string;
  exportedAt?: string;
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
export declare function templateRow(t: TemplateRowData): string;
export declare function runRow(r: RunRowData, opts?: { selected?: boolean }): string;
