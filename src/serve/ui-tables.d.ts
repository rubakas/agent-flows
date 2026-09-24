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
export declare function emptyRunsMessage(filter: string): string;
export declare function resolveRunsFilter(
  filter: string,
  state: { pinned?: boolean; activeCount?: number }
): string;
export declare function fmtTime(iso: string | undefined): string;
export declare function statusClass(status: string | undefined): string;
export declare function fmtElapsed(startIso?: string, endIso?: string): string;
/** One step's state as `GetResult.steps` records it (spec 042 FR-005). */
export interface RunStepStateData {
  status?: string;
  startedAt?: string;
  finishedAt?: string;
}

/** Where a run has got to, against the pipeline's declared step list (spec 042 D7). */
export interface RunProgress {
  stepId: string;
  /** False when the step named is the last to have finished, not one now running. */
  current: boolean;
  /** 1-based position among the declared steps, or null when the id is not declared. */
  n: number | null;
  /** How many steps the pipeline declares. */
  m: number;
}

export declare function workflowRow(wf: WorkflowRowData): string;
/** The step whose output is the run's answer — the graph's single sink (042 D17). */
export declare function terminalStepId(
  declaredSteps: { id?: string; dependsOn?: string[] }[] | undefined
): string | null;

/** One row of the run detail panel: a declared step and what the run knows of it. */
export interface RunStepRow {
  id: string;
  state: RunStepStateData;
}

/** Every declared step of the pipeline, in order, with live state merged in. */
export declare function declaredStepRows(
  declaredSteps: ({ id?: string; dependsOn?: string[] } | string)[] | undefined,
  steps: Record<string, RunStepStateData> | undefined
): RunStepRow[];

export declare function runProgress(
  steps: Record<string, RunStepStateData> | undefined,
  declaredStepIds: string[]
): RunProgress | null;
export declare function progressCell(progress: RunProgress | null | undefined): string;
export declare function runRow(
  r: RunRowData,
  opts?: { selected?: boolean; progress?: RunProgress | null }
): string;
