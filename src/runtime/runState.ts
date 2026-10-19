// The shapes of a run's state, in one leaf module (spec 047 FR-10).
//
// RunService produces them, the artifact store writes and reads them back, and
// neither may import the other's file without a cycle, so the types live here and
// both re-export what their importers already use. Types only: no I/O, and the
// only import is the status vocabulary.

import type { ReadStatus, StepStatus } from "./runStatus.js";

/**
 * Per-step model and transport info recorded in every artifact.
 * Only entries whose model is known are present — an invented value is worse
 * than an absent one (spec 029 Design B).
 */
export interface StepProvenance {
  transport: "cli" | "api";
  /**
   * Registry entry id — e.g. "opus", "codex", "ollama-qwen".
   * Never a key, secret, or API token.
   */
  modelId: string;
  /** Human-readable model name from the registry entry, e.g. "claude-opus-5". */
  model?: string;
  /** Token counts for API transports (endpoint returns usage); absent for CLI. */
  inputTokens?: number;
  outputTokens?: number;
}

/**
 * Provenance block attached to every artifact.
 * A reader can tell which provider produced the artifact without the daemon running.
 */
export interface ArtifactProvenance {
  /** Matches the pipeline id used to start the run. */
  pipelineId: string;
  /** Active provider profile id, e.g. "anthropic", "openai", "local". */
  profileId: string;
  /**
   * Per-step model info, keyed by step id.
   * Empty when the step model cannot be determined without guessing.
   */
  transportPerStep: Record<string, StepProvenance>;
  /** ISO-8601 timestamp when start() was called. */
  startedAt: string;
  /** ISO-8601 timestamp when the run first settled or suspended at a gate. */
  settledAt: string;
}

/** Run-level gate mode (FR-001). Default "manual" preserves existing behaviour. */
export type GateMode = "manual" | "auto";

/**
 * One recorded gate decision (FR-008).
 * Persists for the lifetime of the RunRecord; exposed via GetResult so every
 * approval is auditable regardless of who or what made it.
 */
export interface GateDecision {
  /** Dot-joined step path of the gate that was decided. */
  gateStepId: string;
  /** Run-level mode in effect at the time of the decision. */
  mode: GateMode;
  decidedBy: "human" | "agent";
  approved: boolean;
  /** Non-empty reason from the agent or (in future) from a human form. */
  reason?: string;
  /** Registry entry id of the judge model; present for agent decisions. */
  judgeModelId?: string;
  /** True when the judge had read-only workspace access; false/absent for api transport. */
  workspaceAccess?: boolean;
  /** True when this verdict arrived after the run had already left suspended (race, FR-003). */
  superseded?: boolean;
  /** ISO-8601 timestamp. */
  decidedAt: string;
}

/** Per-step state accumulated by the record-level watch (FR-006). */
export interface StepState {
  status: StepStatus;
  /** ISO-8601 timestamp of the step's workflow-step-start event (spec 033 D3). */
  startedAt?: string;
  /** ISO-8601 timestamp of the step's result/cancellation event (spec 033 D3). */
  finishedAt?: string;
  /** Failure reason when status is "failed" (spec 033 D3). */
  error?: string;
  /** First OUTPUT_EXCERPT_LIMIT chars of the step's output, if any. */
  outputExcerpt?: string;
  /** True when the output was longer than OUTPUT_EXCERPT_LIMIT. */
  outputTruncated?: boolean;
  /** Rendered prompt sent to the model, for llm steps (spec 033 FR-017). */
  prompt?: string;
  /** Shell command executed, for check steps (spec 033 FR-017). */
  command?: string;
  /** Resolved model id and transport for the step (spec 033 FR-017). */
  model?: string;
}

/**
 * How a run was invoked, recorded once in start() and never mutated
 * (spec 033 D6/FR-016). Inputs are kept verbatim so the operator can reproduce
 * the run from the UI, chat or curl.
 */
export interface RunInvocation {
  pipeline: string;
  inputs: Record<string, unknown>;
  models?: Readonly<Record<string, string>>;
  /** The provider profile id the run was started under, when the caller named one. */
  provider?: string;
  gateMode: GateMode;
  artifactPath?: string;
  /** ISO-8601 timestamp of the start() call. */
  startedAt: string;
  /** Every run enters through the daemon's HTTP API, including the MCP tools. */
  source: "http";
}

/** Recorded when an operator cancels a run (spec 033 FR-002). */
export interface CancelledInfo {
  /** ISO-8601 timestamp of the cancel() call. */
  at: string;
  /** Optional operator-supplied reason. */
  reason?: string;
}

export interface GetResult {
  runId: string;
  pipelineId: string;
  /** "unreadable" only ever comes from a persisted run whose artifact failed to parse (FR-012). */
  status: ReadStatus;
  /** Where this state came from: the live registry, or an artifact on disk (FR-010). */
  source?: "live" | "disk";
  /** Run-level gate mode (FR-001). */
  gateMode: GateMode;
  /** Per-step states accumulated in flight (FR-006). Always present; empty before any step fires. */
  steps: Record<string, StepState>;
  /** How the run was invoked (spec 033 FR-016). */
  invocation?: RunInvocation;
  /** All gate decisions recorded so far (FR-008). Empty until a gate is decided. */
  gateDecisions: GateDecision[];
  result?: unknown;
  /**
   * One line naming what this run was started against (spec 042 D14), derived
   * from its inputs — the same line the runs list shows, so a run opened from
   * that list does not lose the only label that told it apart.
   */
  subject?: string;
  /** Present only when status is "awaiting_approval" — the pending gate's human-readable prompt. */
  gateMessage?: string;
  /** Present only when status is "awaiting_approval" — the spec the human is being asked to approve. */
  spec?: unknown;
  /**
   * Present only when status is "awaiting_approval", and only once it has been
   * produced — one paragraph describing what approving would decide (spec 043).
   *
   * Absent is a normal state, not an error state: it is absent while the call
   * is still in flight and absent for good when it failed. The page renders
   * what it has (FR-003).
   */
  gateSummary?: string;
  /**
   * Present only when status is "awaiting_approval" — the dotted id of the gate
   * step that suspended. The page names it when there is nothing else to show
   * (spec 043 FR-005); "this gate" tells an operator nothing about which one.
   */
  gateStepId?: string;
  /**
   * Present only when status is "failed", "rejected" or "cancelled" — a brief
   * description of why the run ended.
   */
  error?: string;
  /** Present only when status is "cancelled" — when the operator cancelled and why (FR-002). */
  cancelled?: CancelledInfo;
  /**
   * Set when the judge produced a malformed verdict after two attempts or encountered a
   * transport error (FR-005). The run degrades to manual: it remains awaiting_approval so a human
   * can answer instead. Cleared when a new suspension is recorded.
   */
  judgeError?: string;
  /**
   * Absolute path of the durable artifact written by the last persistArtifact call
   * (spec 029 FR-009). Absent until the run first settles or suspends.
   */
  artifactPath?: string;
}

/** One row in the list returned by list() (FR-001). No output, result, spec, or gate data. */
export interface RunSummary {
  runId: string;
  pipelineId: string;
  status: ReadStatus;
  /** Where this summary came from: the live registry, or an artifact on disk (FR-010). */
  source: "live" | "disk";
  /** ISO-8601 timestamp of when start() was called. */
  createdAt: string;
  /**
   * ISO-8601 timestamp of the terminal transition (spec 034 FR-002). Absent
   * while the run is running or waiting at a gate — a suspended run has not
   * settled — so a list consumer can tell "still going" from "took this long".
   */
  settledAt?: string;
  /**
   * One line naming what this run was started against (spec 042 D14), derived
   * from its inputs. Absent when those carry nothing worth showing.
   */
  subject?: string;
}

/**
 * What the run service writes to disk: the live state at the moment of the
 * write, plus the provenance block, and the cancellation lifted to the top
 * level so a reader does not have to reach into the nested `cancelled` object
 * (spec 033 FR-004).
 */
export type RunArtifact = GetResult & {
  provenance: ArtifactProvenance;
  cancelledAt?: string;
  reason?: string;
};

/**
 * A run's state rebuilt from its artifact — the on-disk twin of GetResult. Only
 * the fields below exist on it: the reader builds it field by field rather than
 * passing the file through, so what a caller sees is what this type declares.
 */
export type PersistedRun = GetResult & {
  source: "disk";
  /** ISO-8601 start time, from the artifact's provenance or invocation. */
  createdAt: string;
  /** ISO-8601 settle time; present only for a run that has settled. */
  settledAt?: string;
  provenance?: ArtifactProvenance;
  cancelledAt?: string;
  reason?: string;
  /** Present when status is "unreadable": the file that could not be read. */
  path?: string;
};
