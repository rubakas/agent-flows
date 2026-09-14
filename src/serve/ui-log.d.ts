// Types for ui-log.js. The run-view renderers ship as plain ESM so the browser
// can load them unbuilt from /ui-log.js; this declaration lets the unit test
// import them without turning on allowJs for the whole project.

/** One line of a run's events file, as declared in src/canon/stepLogEvents.ts. */
type LogEvent = Record<string, unknown>;

/** Per-run merge state: the highest seq applied and the events kept per step. */
export interface LogState {
  lastSeq: number;
  byStep: Map<string, LogEvent[]>;
  droppedEarlier: Map<string, number>;
}

export declare const MAX_EVENTS_PER_STEP: number;
export declare function toolCallSummary(event: LogEvent): string;
export declare function renderLogEvent(event: LogEvent): string;
export declare function renderStepFooter(events: LogEvent[]): string;
export declare function renderDecisions(
  gateDecisions: LogEvent[] | undefined,
  judgeError?: string
): string;
export declare function renderOutput(
  payload: { kind?: string; output?: unknown } | null | undefined
): string;
export declare function mergeLogEvents(
  state: LogState | null | undefined,
  incoming: LogEvent[]
): LogState;
