// Provider-neutral inner step events (spec 036 D1/D2/D5).
//
// Leaf module by construction: it imports nothing at all, so the canon layer
// (adapters, runStep), the runtime sink and the server can all depend on the
// same vocabulary without an import cycle.

/** Every event kind a step log can carry (spec 036 D1). */
export type StepLogKind =
  | "step.start"
  | "message"
  | "tool.call"
  | "tool.result"
  | "check.output"
  | "watchdog"
  | "usage"
  | "step.result"
  | "failover"
  | "decision"
  | "judge.degraded"
  | "log.truncated";

/** Emitted once per step by the step builder, never by an adapter. */
export interface StepStartPayload {
  /** Resolved model id and transport, as recorded for the run state. */
  model: string;
  transport: string;
}

export interface MessagePayload {
  role: "assistant";
  text: string;
  truncated?: boolean;
}

export interface ToolCallPayload {
  callId?: string;
  name: string;
  /** The tool input as the provider reported it, bounded per D5. */
  input: unknown;
  /** True when the call came from a subagent rather than the main turn. */
  nested?: boolean;
  /** Set by the sink when the input names a credential file (D8). */
  denied?: boolean;
  truncated?: boolean;
}

export interface ToolResultPayload {
  callId?: string;
  name?: string;
  ok: boolean;
  excerpt?: string;
  truncated?: boolean;
  /** Set by the sink when the matching call was denied (D8). */
  redacted?: boolean;
}

export interface CheckOutputPayload {
  stream: "stdout" | "stderr";
  text: string;
  truncated?: boolean;
}

export interface WatchdogPayload {
  pathology: "stall" | "loop";
  detail: string;
  /** Which of the two claude attempts tripped (1 or 2). */
  attempt: number;
}

/** Whatever the provider reports about the call it just finished (D9). */
export interface UsagePayload {
  costUsd?: number;
  turns?: number;
  durationMs?: number;
  usage?: { inputTokens: number; outputTokens: number };
  /** Tool calls the CLI refused during the step. */
  denials?: number;
}

/** The terminal event of a step, emitted exactly once by the step builder (D2). */
export interface StepResultPayload {
  status: "succeeded" | "failed" | "cancelled";
  durationMs: number;
  error?: string;
  /**
   * The model and transport that actually answered, present only when a
   * failover moved the step off the one `step.start` named (spec 039).
   * `step.start` is never rewritten — it records what was PLANNED.
   */
  model?: string;
  transport?: string;
}

/**
 * Emitted by the step builder when a step's failure is retried on the next
 * profile in the active profile's fallback chain (spec 039). One per crossing,
 * so the log shows which provider actually answered and why the first did not.
 */
export interface FailoverPayload {
  stepId: string;
  fromProfile: string;
  toProfile: string;
  /** The failure that triggered the crossing. */
  reason: string;
}

export interface DecisionPayload {
  gateStepId: string;
  mode: "manual" | "auto";
  decidedBy: "human" | "agent";
  approved: boolean;
  reason?: string;
  judgeModelId?: string;
  superseded?: boolean;
}

export interface JudgeDegradedPayload {
  gateStepId: string;
  error: string;
}

/** Appended once when a per-run cap of D5 is reached. */
export interface LogTruncatedPayload {
  events: number;
  bytes: number;
}

/** One kind tagged onto its payload — the shape of every event in the union below. */
type Tagged<K extends StepLogKind, P> = P & { kind: K };

/** One event as an emitter produces it: the kind plus its payload, unstamped. */
export type StepLogEventInput =
  | Tagged<"step.start", StepStartPayload>
  | Tagged<"message", MessagePayload>
  | Tagged<"tool.call", ToolCallPayload>
  | Tagged<"tool.result", ToolResultPayload>
  | Tagged<"check.output", CheckOutputPayload>
  | Tagged<"watchdog", WatchdogPayload>
  | Tagged<"usage", UsagePayload>
  | Tagged<"step.result", StepResultPayload>
  | Tagged<"failover", FailoverPayload>
  | Tagged<"decision", DecisionPayload>
  | Tagged<"judge.degraded", JudgeDegradedPayload>
  | Tagged<"log.truncated", LogTruncatedPayload>;

/** One line of an events file: the input plus the stamps the sink applies. */
export type StepLogEvent = StepLogEventInput & {
  /** Monotonic per run, starting at 1. */
  seq: number;
  /** ISO-8601 with milliseconds. */
  at: string;
  runId: string;
  pipelineId: string;
  stepId: string;
};

// ── Bounds (D5) ───────────────────────────────────────────────────────────────

export const MESSAGE_TEXT_LIMIT = 8192;
export const TOOL_INPUT_LIMIT = 2048;
export const TOOL_RESULT_LIMIT = 2048;
export const CHECK_OUTPUT_LIMIT = 4096;
export const MAX_EVENTS_PER_RUN = 20000;
export const MAX_LOG_BYTES_PER_RUN = 32 * 1024 * 1024;

/**
 * Cuts the over-limit fields of one event and marks it `truncated`.
 *
 * Pure: the caller gets a new event and the emitter's own value is untouched,
 * so bounding the log never changes what the step itself returns.
 */
export function boundStepLogEvent(input: StepLogEventInput): StepLogEventInput {
  switch (input.kind) {
    case "message":
      if (input.text.length <= MESSAGE_TEXT_LIMIT) return input;
      return { ...input, text: input.text.slice(0, MESSAGE_TEXT_LIMIT), truncated: true };
    case "tool.call": {
      // A tool input is arbitrary JSON, so it is bounded by its serialised size
      // and replaced wholesale — cutting one field would leave a shape that
      // reads as complete but is not.
      const serialised = JSON.stringify(input.input) ?? "";
      if (serialised.length <= TOOL_INPUT_LIMIT) return input;
      return {
        ...input,
        input: { truncated: serialised.slice(0, TOOL_INPUT_LIMIT) },
        truncated: true,
      };
    }
    case "tool.result":
      if (input.excerpt === undefined || input.excerpt.length <= TOOL_RESULT_LIMIT) return input;
      return { ...input, excerpt: input.excerpt.slice(0, TOOL_RESULT_LIMIT), truncated: true };
    case "check.output":
      if (input.text.length <= CHECK_OUTPUT_LIMIT) return input;
      return { ...input, text: input.text.slice(0, CHECK_OUTPUT_LIMIT), truncated: true };
    default:
      return input;
  }
}

// ── Sink seam ─────────────────────────────────────────────────────────────────

/** Receives provider-neutral inner step events as they happen. */
export type StepEventSink = (event: StepLogEventInput) => void;

/**
 * Hands one event to the sink, swallowing anything the listener throws: a
 * logging failure must never be the reason a step fails.
 */
export function emitStepEvent(sink: StepEventSink | undefined, event: StepLogEventInput): void {
  if (sink === undefined) return;
  try {
    sink(event);
  } catch {
    // The step keeps running; the event is lost rather than the work.
  }
}
