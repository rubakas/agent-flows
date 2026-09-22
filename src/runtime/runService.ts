// Transport-agnostic run ownership (FR-011, FR-020).
// Owns the in-process run registry. The HTTP daemon and the web editor share
// the same RunService instance. The MCP stdio binding (FR-020) proxies to the
// daemon's HTTP API rather than owning its own registry, making the comment true
// for all three surfaces.

import { dirname, join } from "node:path";
import { activeProfileIdOrUnknown, resolveStepModel } from "../canon/registry.js";
import {
  writeRunArtifact,
  upsertManifestEntry,
  listPersistedRuns,
  readPersistedRun,
} from "./artifactStore.js";
import { runJudge } from "./gateJudge.js";
import { runSubject } from "./runSubject.js";
import { clearRun, getRun as getStepIntrospection } from "./stepIntrospection.js";
import {
  appendRunLogFileEvent,
  appendStepLog,
  closeRunLog,
  openRunLog,
  subscribeRunLog,
} from "./stepLog.js";
import type { ArtifactProvenance, StepProvenance } from "./artifactStore.js";
import type { JudgeDeps, JudgeResult } from "./gateJudge.js";
import { runGateSummary } from "./gateSummary.js";
import type { GateSummaryDeps } from "./gateSummary.js";
import type { GatePayload } from "./gateMaterial.js";
import type { ModelRegistry, ProviderProfile } from "../canon/registry.js";
import type { StepLogEvent, StepLogEventInput } from "../canon/stepLogEvents.js";
import type { StepDef } from "../canon/types.js";
import type { WorkflowStreamEvent } from "@mastra/core/stream";

// ── Narrow interfaces for the Mastra API subset used here ────────────────────
// Using structural interfaces rather than Mastra's deeply-generic Run<...> types
// avoids propagating `any` throughout the module while keeping tsc clean.

interface RunResult {
  status: string;
  suspended?: [string[], ...string[][]];
  steps?: Record<string, { suspendPayload?: Record<string, unknown> }>;
  result?: unknown;
  error?: Error;
}

interface MastraRun {
  readonly runId: string;
  start(opts: { inputData: Record<string, unknown> }): Promise<RunResult>;
  resume(params: { step: string[]; resumeData: unknown }): Promise<RunResult>;
  watch(cb: (event: WorkflowStreamEvent) => void): () => void;
  /**
   * Aborts the run's AbortController, which fires the `abortSignal` Mastra hands
   * to every step's execute context (spec 033 D1). Optional so the structural
   * mocks in runService.test.ts that never cancel stay assignable.
   */
  cancel?(): Promise<void>;
}

interface MastraWorkflow {
  createRun(): Promise<MastraRun>;
}

// Public: callers (server.ts, tests) supply a Mastra instance here.
// Mastra<..., Record<string, any>, ...>.getWorkflow() returns `any`, which is
// assignable to MastraWorkflow, so no cast is required in the caller.
export interface MastraLike {
  getWorkflow(id: string): MastraWorkflow;
}

// ── Public types ──────────────────────────────────────────────────────────────

// Re-export for callers that need the provenance types alongside GetResult.
export type { StepProvenance, ArtifactProvenance } from "./artifactStore.js";

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

export interface StepEvent {
  kind: "step-start" | "step-finish" | "step-suspended" | "step-failed" | "step-cancelled";
  stepId: string;
  suspendPayload?: unknown;
  /** Present on step-finish: first OUTPUT_EXCERPT_LIMIT chars of JSON-serialised output. */
  outputExcerpt?: string;
  /** Present on step-finish when the output was truncated. */
  outputTruncated?: boolean;
}

export type StepListener = (event: StepEvent) => void;

export interface StartResult {
  runId: string;
  /** Always "running" — the run advances in the background. */
  status: "running";
}

/**
 * The state after a run first suspends or completes.
 * Returned by waitForSettled(). MCP callers use this to stay blocking
 * while HTTP callers use the non-blocking StartResult.
 *
 * For auto runs (FR-009): the promise does not resolve at a judged suspension;
 * it resolves when the run completes, fails, or the judge fails (degrading to manual).
 */
export interface SettledResult {
  status: "awaiting_approval" | "succeeded" | "rejected" | "failed" | "cancelled";
  gateMessage?: string;
  spec?: unknown;
  result?: unknown;
  error?: string;
}

export interface ApproveResult {
  runId: string;
  status?: "awaiting_approval" | "succeeded" | "rejected" | "failed" | "cancelled";
  gateMessage?: string;
  spec?: unknown;
  result?: unknown;
  /** Defined when the call could not be processed (no run, wrong status, etc.). */
  error?: string;
}

/** Per-step state accumulated by the record-level watch (FR-006). */
export interface StepState {
  status: string;
  /** ISO-8601 timestamp of the step's workflow-step-start event (spec 033 D3). */
  startedAt?: string;
  /** ISO-8601 timestamp of the step's result/cancellation event (spec 033 D3). */
  finishedAt?: string;
  /** Failure reason when status is "failed" (spec 033 D3). */
  error?: string;
  /** First OUTPUT_EXCERPT_LIMIT chars of JSON-serialised step output, if any. */
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
  models?: unknown;
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

/** Outcome of RunService.cancel(). `status` names the status that blocked the cancel. */
export type CancelResult = { ok: true } | { ok: false; status: GetResult["status"] };

export interface GetResult {
  runId: string;
  pipelineId: string;
  /** "unreadable" only ever comes from a persisted run whose artifact failed to parse (FR-012). */
  status:
    | "running"
    | "awaiting_approval"
    | "succeeded"
    | "rejected"
    | "failed"
    | "cancelled"
    | "unreadable";
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
  status:
    | "running"
    | "awaiting_approval"
    | "succeeded"
    | "rejected"
    | "failed"
    | "cancelled"
    | "unreadable";
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

/** The `subject` property when there is one, and nothing at all when there is not. */
function withSubject(invocation: unknown): { subject?: string } {
  const subject = runSubject(invocation);
  return subject === undefined ? {} : { subject };
}

export type { JudgeDeps } from "./gateJudge.js";
export type { GateSummaryDeps } from "./gateSummary.js";

// ── Internal record ────────────────────────────────────────────────────────────

interface RunRecord {
  pipelineId: string;
  run: MastraRun;
  status: "running" | "awaiting_approval" | "succeeded" | "rejected" | "failed" | "cancelled";
  /** Set once in start(); never mutated. */
  readonly createdAt: Date;
  /** Set once by finalizeSettlement at the terminal transition (spec 034 FR-002). */
  settledAt?: string;
  /** Run-level gate mode (FR-001). */
  gateMode: GateMode;
  /**
   * The provider profile this run was started under, when the caller named one.
   * Set once in start(); never mutated. Provenance reads it rather than the
   * daemon's startup profile, which is wrong for any run that chose its own.
   */
  readonly profile?: ProviderProfile;
  /** Set once in start(); never mutated (spec 033 FR-016). */
  readonly invocation: RunInvocation;
  /** Per-step states accumulated by the record-level watch (FR-006). */
  steps: Record<string, StepState>;
  /** All gate decisions recorded so far (FR-008). */
  gateDecisions: GateDecision[];
  /**
   * Set by cancel() before any await (FR-002/FR-006). Its presence makes the
   * cancellation sticky: applyWorkflowResult refuses to overwrite the status
   * with whatever Mastra reports for the aborted or gate-rejected workflow.
   */
  cancelled?: CancelledInfo;
  /**
   * Live SSE subscribers (FR-003). Kept alongside the Mastra watch subscription
   * so cancel() can emit a synthetic step-cancelled event that Mastra's own
   * stream never produces.
   */
  readonly listeners: Set<StepListener>;
  /** Set when the judge fails; cleared on a new suspension. */
  judgeError?: string;
  /** The gate summary, once produced; cleared on a new suspension (spec 043). */
  gateSummary?: string;
  result?: unknown;
  error?: string;
  suspendPayload?: unknown;
  /** The suspended step path returned by Mastra, needed for resume(). */
  suspendedStep?: string[];
  /** Resolves once the background run first suspends or completes. */
  readonly settledPromise: Promise<SettledResult>;
  /** Call exactly once from the background to resolve settledPromise. */
  readonly settle: (result: SettledResult) => void;
  /**
   * Per-step model/transport info for the provenance block (spec 029 FR-002).
   * Populated by callers that can resolve step→model mapping; absent entries
   * are omitted rather than guessed.
   */
  transportPerStep: Record<string, StepProvenance>;
  /**
   * Directory to write this run's artifacts into (spec 029 FR-006).
   * When absent: defaults to <runsDir>/<runId>.
   * When present: artifacts land in the parent run's directory so that chained
   * stages accumulate in one place and the manifest can be updated there.
   */
  chainArtifactDir?: string;
  /**
   * Absolute path of the most-recently written artifact for this run (spec 029 FR-009).
   * Set by persistArtifact after each successful write; absent until first settlement.
   */
  artifactPath?: string;
  /**
   * Directory this run's artifact and event log live in, resolved once in start()
   * (spec 036 D1). Internal: it is not part of GetResult or the artifact.
   */
  artifactDir?: string;
}

// ── Constants ─────────────────────────────────────────────────────────────────

/** Max characters kept in outputExcerpt (FR-006). JSON is ASCII-safe so slice is safe here. */
const OUTPUT_EXCERPT_LIMIT = 2048;

// ── RunService ─────────────────────────────────────────────────────────────────

export class RunService {
  private readonly registry = new Map<string, RunRecord>();

  constructor(
    private readonly mastra: MastraLike,
    private readonly judgeDeps?: JudgeDeps,
    /**
     * Directory holding one subdirectory per run, where durable artifacts are
     * written (spec 029 FR-001, spec 032 FR-004). The daemon passes the state
     * dir's runs/; without it no artifact is written.
     */
    private readonly runsDir?: string,
    /**
     * Provider profile in force for this daemon instance (spec 029 FR-002).
     * Used to record provenance.profileId when judgeDeps.profile is absent.
     */
    private readonly standaloneProfile?: ProviderProfile,
    /**
     * Model registry for provenance recording (spec 029 FR-002).
     * Used to resolve step roles to ModelEntry when judgeDeps.registry is absent.
     */
    private readonly standaloneRegistry?: ModelRegistry,
    /**
     * What the gate summary needs (spec 043). Separate from judgeDeps because
     * the daemon constructs this and not that: a run whose gate a human answers
     * is precisely the run with no judge configured.
     */
    private readonly summaryDeps?: GateSummaryDeps
  ) {}

  /**
   * Start a pipeline run and return immediately with status "running".
   *
   * The run advances in the background — run.start() is fired without being
   * awaited. When the run first suspends or completes, the registry record is
   * updated and settledPromise resolves. Use waitForSettled() to block until
   * that point (MCP callers need this; HTTP callers do not).
   *
   * For auto runs (FR-009): the promise does not resolve at a judged suspension;
   * only at completion, failure, or judge-failure degradation.
   *
   * The public run id is Mastra's own run id so it keys LibSQL snapshots and
   * resume() calls without a separate mapping.
   */
  async start(
    pipelineId: string,
    wfInput: Record<string, unknown>,
    opts?: {
      gateMode?: GateMode;
      /**
       * Pipeline step definitions for provenance recording (spec 029 FR-002).
       * When provided alongside a registry and profile, transportPerStep is
       * filled for every llm step. Non-llm steps (gate, check, persist-ticket,
       * export-spec, assemble-spec) have no model and are omitted. After
       * loadPipeline+expandNested, pipeline-kind steps are already inlined as
       * namespaced children (e.g. "outer.inner") and resolved naturally. Loop
       * steps have no model; their body steps do not appear in this list and
       * are therefore absent from transportPerStep.
       */
      pipelineSteps?: readonly StepDef[];
      /**
       * Directory to write artifacts into when chaining from a parent run
       * (spec 029 FR-006). Stored on the RunRecord and used by persistArtifact.
       */
      chainArtifactDir?: string;
      /**
       * The artifactPath the caller handed in, recorded verbatim on the
       * invocation (spec 033 FR-016) so the run can be reproduced as issued.
       */
      artifactPath?: string;
      /**
       * The profile this run was started under, resolved from the caller's
       * `provider` field. Provenance must name the profile the run actually
       * uses; the instance-level profile is the daemon's startup default and is
       * wrong for any run that named its own.
       */
      provider?: ProviderProfile;
    }
  ): Promise<StartResult> {
    const gateMode: GateMode = opts?.gateMode ?? "manual";
    const wf = this.mastra.getWorkflow(pipelineId);
    const run = await wf.createRun();
    const { runId } = run;

    let settle!: (result: SettledResult) => void;
    const settledPromise = new Promise<SettledResult>((resolve) => {
      settle = resolve;
    });

    // Compute transportPerStep up-front from the pipeline step definitions.
    // The result is an accurate record of what the run will use — not a guess —
    // because it applies the same model-resolution logic as the step runner,
    // including per-run model overrides from wfInput.models (spec 029 FR-002).
    const transportPerStep = this.computeTransportPerStep(
      opts?.pipelineSteps,
      wfInput.models,
      opts?.provider ?? this.judgeDeps?.profile ?? this.standaloneProfile,
      this.judgeDeps?.registry ?? this.standaloneRegistry
    );

    // FR-016: the invocation is the run as the operator issued it. `models` is
    // merged into wfInput for the workflow, so it is split back out here rather
    // than left inside the inputs the UI offers for replay.
    const { models, provider, ...inputsOnly } = wfInput;
    const createdAt = new Date();
    const invocation: RunInvocation = {
      pipeline: pipelineId,
      inputs: inputsOnly,
      ...(models !== undefined ? { models } : {}),
      ...(typeof provider === "string" ? { provider } : {}),
      gateMode,
      ...(opts?.artifactPath !== undefined ? { artifactPath: opts.artifactPath } : {}),
      startedAt: createdAt.toISOString(),
      source: "http",
    };

    const record: RunRecord = {
      pipelineId,
      run,
      status: "running",
      createdAt,
      gateMode,
      invocation,
      steps: {},
      gateDecisions: [],
      listeners: new Set<StepListener>(),
      settledPromise,
      settle,
      transportPerStep,
      ...(opts?.provider !== undefined ? { profile: opts.provider } : {}),
      ...(opts?.chainArtifactDir !== undefined ? { chainArtifactDir: opts.chainArtifactDir } : {}),
    };
    this.registry.set(runId, record);

    // Spec 036 D1: the events file is opened before the workflow starts, not at
    // settlement, so a run cancelled or crashing mid-step still has its log.
    const artifactDir = this.artifactDirFor(record);
    if (artifactDir !== undefined) {
      record.artifactDir = artifactDir;
      openRunLog(runId, { dir: artifactDir, pipelineId });
    }

    // Record-level watch — accumulates per-step state for mid-run observability (FR-006).
    // Runs for the lifetime of the run, regardless of how many SSE subscribers are active.
    run.watch((event: WorkflowStreamEvent) => {
      if (event.type === "workflow-step-start") {
        record.steps[event.payload.id] = {
          status: "started",
          startedAt: new Date().toISOString(),
        };
      } else if (event.type === "workflow-step-suspended") {
        const prevStartedAt = record.steps[event.payload.id]?.startedAt;
        record.steps[event.payload.id] = {
          status: "suspended",
          ...(prevStartedAt !== undefined ? { startedAt: prevStartedAt } : {}),
        };
      } else if (event.type === "workflow-step-result") {
        const { id, status, output } = event.payload;
        // A result landing after cancel() describes an aborted step, not a
        // finished one: runCheckStep resolves (rather than throws) when its
        // signal fires, so Mastra reports "success" and would otherwise
        // resurrect the step the cancellation just closed out.
        const uiStatus =
          record.cancelled !== undefined
            ? "cancelled"
            : status === "success" || status === "skipped"
              ? "succeeded"
              : status;
        // D3: carry the start timestamp forward and stamp the finish; the result
        // event replaces the state wholesale, so anything not copied is lost.
        const prevStartedAt = record.steps[id]?.startedAt;
        const rawError = (event.payload as { error?: unknown }).error;
        // Only Error and string carry a usable message; anything else would
        // stringify to "[object Object]" and tell the operator nothing.
        const stepError =
          rawError instanceof Error
            ? rawError.message
            : typeof rawError === "string"
              ? rawError
              : undefined;
        const state: StepState = {
          status: uiStatus,
          ...(prevStartedAt !== undefined ? { startedAt: prevStartedAt } : {}),
          finishedAt: new Date().toISOString(),
          ...(stepError !== undefined ? { error: stepError } : {}),
        };
        // Extract the step's OWN output from the accumulated context.
        // Every step returns { ...rawCtx, [step.id]: ownValue } so the full
        // context always begins with the shared request prefix — serializing
        // it whole produces byte-identical excerpts across all steps (FR-006).
        const ownOutput =
          output !== null && typeof output === "object"
            ? (output as Record<string, unknown>)[id]
            : undefined;
        if (ownOutput !== undefined) {
          const serialized = JSON.stringify(ownOutput);
          if (serialized.length > OUTPUT_EXCERPT_LIMIT) {
            state.outputExcerpt = serialized.slice(0, OUTPUT_EXCERPT_LIMIT);
            state.outputTruncated = true;
          } else {
            state.outputExcerpt = serialized;
          }
        }
        record.steps[id] = state;
      }
    });

    // Fire the run in the background — do NOT await.
    // The result/rejection updates the registry record and resolves settledPromise.
    // The void operator makes the dangling promise intentional; the catch branch
    // ensures no unhandled rejection can surface.
    void run
      .start({ inputData: wfInput })
      .then((r1) => {
        const settled = this.applyWorkflowResult(record, r1);
        this.afterSettlement(record, settled);
      })
      .catch((err: unknown) => {
        // FR-006: run.cancel() makes Mastra reject the start promise with an
        // abort error. The run is already terminal as "cancelled" — a later
        // "failed" would silently overwrite the operator's decision.
        if (record.cancelled !== undefined) return;
        const name = err instanceof Error ? err.name : undefined;
        const msg = err instanceof Error ? err.message : String(err);
        const errStr = name ? `${name}: ${msg}` : msg;
        record.status = "failed";
        record.error = errStr;
        this.finalizeSettlement(record);
        record.settle({ status: "failed", error: errStr });
      });

    return { runId, status: "running" };
  }

  /**
   * Wait until the background run first suspends or completes.
   *
   * MCP callers use this to preserve the blocking contract that existed before
   * start() was made non-blocking. HTTP callers skip it — they return immediately
   * and let the client poll via GET /api/runs/:id or SSE /api/runs/:id/events.
   *
   * For auto runs (FR-009): does not resolve at a judged suspension.
   *
   * Returns undefined if the runId is unknown.
   */
  async waitForSettled(runId: string): Promise<SettledResult | undefined> {
    const record = this.registry.get(runId);
    if (!record) return undefined;
    return record.settledPromise;
  }

  /**
   * Per-step state with the step's own introspection (prompt/command/model)
   * folded in (spec 033 FR-017).
   *
   * Read-through rather than written into the record on every call: the watch
   * accumulator replaces `record.steps[id]` wholesale on each step event, so a
   * value merged in early would be dropped again by the next event. The record
   * only takes ownership at settlement, where `finalizeSettlement` copies it
   * before the map entry is cleared — and record fields win from then on.
   */
  private mergedSteps(record: RunRecord): Record<string, StepState> {
    const recorded = getStepIntrospection(record.run.runId);
    if (!recorded) return record.steps;
    const merged: Record<string, StepState> = { ...record.steps };
    for (const [stepId, info] of Object.entries(recorded)) {
      // A step can record its prompt before Mastra emits workflow-step-start,
      // so there may be no record state to merge onto yet.
      const existing = record.steps[stepId] as StepState | undefined;
      merged[stepId] = existing ? { ...info, ...existing } : { status: "started", ...info };
    }
    return merged;
  }

  /**
   * Stamp the settle time (spec 034 FR-002), copy the run's introspection into
   * the record and drop the map entry (spec 033 FR-017).
   *
   * Called on every terminal transition: the map is process-
   * global, so a run that never clears it leaks its prompts for the daemon's
   * lifetime, and a run cleared without copying loses them from its own state.
   */
  /**
   * `transportPerStep` as computed at start, corrected for any step a failover
   * moved onto another provider (spec 039).
   *
   * The start-time map is what the run PLANNED to use; a step that failed over
   * reports the provider that actually answered through the same per-run
   * introspection channel its prompt travels on. Read-through for the same
   * reason `mergedSteps` is: the record only takes ownership at settlement.
   */
  private mergedTransportPerStep(record: RunRecord): Record<string, StepProvenance> {
    const recorded = getStepIntrospection(record.run.runId);
    if (!recorded) return record.transportPerStep;
    const merged: Record<string, StepProvenance> = { ...record.transportPerStep };
    for (const [stepId, info] of Object.entries(recorded)) {
      const actual = info.actual;
      if (!actual) continue;
      merged[stepId] = {
        transport: actual.transport,
        modelId: actual.modelId,
        ...(actual.model !== undefined ? { model: actual.model } : {}),
      };
    }
    return merged;
  }

  private finalizeSettlement(record: RunRecord): void {
    // First terminal transition wins: cancel() resumes a gate, so a second
    // settlement can arrive afterwards and would otherwise restamp the run with
    // a later time than the operator's decision.
    record.settledAt ??= new Date().toISOString();
    record.steps = this.mergedSteps(record);
    record.transportPerStep = this.mergedTransportPerStep(record);
    clearRun(record.run.runId);
    closeRunLog(record.run.runId);
  }

  /**
   * Append a decision-shaped event for a gate (FR-005).
   *
   * `resolveGate`'s superseded branch fires after settlement has already closed
   * the log, so a closed run falls back to the file-level path rather than
   * losing the decision.
   */
  private appendDecision(record: RunRecord, stepId: string, input: StepLogEventInput): void {
    if (appendStepLog(record.run.runId, stepId, input) !== undefined) return;
    const { artifactDir } = record;
    if (artifactDir === undefined) return;
    appendRunLogFileEvent(artifactDir, record.pipelineId, record.run.runId, stepId, input);
  }

  /** The log event describing one recorded gate decision. */
  private decisionEvent(decision: GateDecision): StepLogEventInput {
    return {
      kind: "decision",
      gateStepId: decision.gateStepId,
      mode: decision.mode,
      decidedBy: decision.decidedBy,
      approved: decision.approved,
      ...(decision.reason !== undefined ? { reason: decision.reason } : {}),
      ...(decision.judgeModelId !== undefined ? { judgeModelId: decision.judgeModelId } : {}),
      ...(decision.superseded !== undefined ? { superseded: decision.superseded } : {}),
    };
  }

  /**
   * Return the current state of a run, or undefined if the id is unknown.
   *
   * A run the registry has never heard of may still exist on disk: the daemon
   * was restarted, and the artifact is what the run looked like when it settled
   * (spec 034 FR-010). The registry is consulted first — a live run is always
   * fresher than its last snapshot.
   */
  get(runId: string): GetResult | undefined {
    const record = this.registry.get(runId);
    if (!record) return this.getPersisted(runId);
    const out: GetResult = {
      runId,
      pipelineId: record.pipelineId,
      status: record.status,
      source: "live",
      gateMode: record.gateMode,
      invocation: record.invocation,
      steps: this.mergedSteps(record),
      gateDecisions: record.gateDecisions,
      result: record.result,
      ...withSubject(record.invocation),
      ...(record.error !== undefined ? { error: record.error } : {}),
      ...(record.cancelled !== undefined ? { cancelled: record.cancelled } : {}),
      ...(record.judgeError !== undefined ? { judgeError: record.judgeError } : {}),
      // FR-009: expose the artifact path so callers can hand it to the next stage
      // without guessing where it was written.
      ...(record.artifactPath !== undefined ? { artifactPath: record.artifactPath } : {}),
    };
    if (record.status === "awaiting_approval") {
      const payload = record.suspendPayload as Record<string, unknown> | undefined;
      out.gateMessage = (payload?.message as string | undefined) ?? "Approve this spec?";
      out.spec = payload?.spec;
      if (record.gateSummary !== undefined) out.gateSummary = record.gateSummary;
      if (record.suspendedStep !== undefined) out.gateStepId = record.suspendedStep.join(".");
    }
    return out;
  }

  /**
   * Rebuild a run's state from its artifact (spec 034 FR-010).
   *
   * Returns undefined when no runs directory is configured or the id has no
   * artifact — indistinguishable, from the caller's side, from "no such run".
   */
  private getPersisted(runId: string): GetResult | undefined {
    if (!this.runsDir) return undefined;
    const persisted = readPersistedRun(this.runsDir, runId);
    if (!persisted) return undefined;
    // The artifact is a serialised GetResult plus provenance, so it already has
    // the shape callers expect; the cast documents that it is not re-validated
    // field by field, and status/steps/gateDecisions were normalised on read.
    // `subject` is derived rather than read, because artifacts written before it
    // existed carry none and a restored run should not be the nameless one.
    const out = persisted as unknown as GetResult;
    return { ...out, ...withSubject(out.invocation) };
  }

  /**
   * Return a summary list of all runs, live ones first (FR-001, spec 034 FR-010).
   *
   * Summaries carry only the identification/status fields — never result, spec,
   * gateMessage, or step output — so the list endpoint stays light. Runs whose
   * artifacts are on disk but whose daemon has since restarted are merged in;
   * a registry entry always wins over the disk copy of the same id, because the
   * artifact is only ever as new as the last settlement.
   */
  list(): RunSummary[] {
    const live: RunSummary[] = [...this.registry.entries()].map(([runId, record]) => ({
      runId,
      pipelineId: record.pipelineId,
      status: record.status,
      createdAt: record.createdAt.toISOString(),
      ...(record.settledAt !== undefined ? { settledAt: record.settledAt } : {}),
      ...withSubject(record.invocation),
      source: "live" as const,
    }));
    if (!this.runsDir) return live;

    const liveIds = new Set(live.map((r) => r.runId));
    const persisted = listPersistedRuns(this.runsDir)
      .filter((p) => !liveIds.has(p.runId))
      .map((p) => p as unknown as RunSummary);
    return [...live, ...persisted];
  }

  /**
   * Approve or reject a suspended run (human decision).
   *
   * Single-flight per run id: the status transition to "running" happens
   * synchronously before any await, so two approvals arriving in the same
   * tick both see the guard on the first synchronous pass. The second call
   * finds status "running" (not "suspended") and returns a defined error
   * rather than resuming the workflow twice.
   *
   * Approving a run that is not suspended (already resolved, still running,
   * or unknown) returns an error — never a silent no-op.
   *
   * Records a GateDecision with decidedBy:"human" (FR-008).
   */
  async approve(runId: string, approved: boolean, reason?: string): Promise<ApproveResult> {
    const record = this.registry.get(runId);
    if (!record) {
      // A run restored from disk has no workflow to resume; say so instead of
      // "no run found", which would send the operator looking for a lost run.
      const persisted = this.getPersisted(runId);
      if (persisted) {
        return {
          runId,
          error: `Run ${runId} was restored from its artifact (status: ${persisted.status}) and cannot be approved`,
        };
      }
      return { runId, error: `No run found for runId "${runId}"` };
    }
    if (record.status !== "awaiting_approval") {
      return { runId, error: `Run ${runId} is not awaiting approval (status: ${record.status})` };
    }

    // Take the state transition synchronously — before the first await.
    // Any concurrent approve that reaches this point after the assignment
    // will see "running", fail the guard above, and return the error.
    record.status = "running";

    const gateStepId = record.suspendedStep?.join(".") ?? "unknown";
    const decision: GateDecision = {
      gateStepId,
      mode: record.gateMode,
      decidedBy: "human",
      approved,
      // Store the human-supplied reason when present; omit when absent so the
      // field remains undefined rather than holding an empty string (FR-006).
      ...(reason !== undefined ? { reason } : {}),
      decidedAt: new Date().toISOString(),
    };
    record.gateDecisions.push(decision);
    this.appendDecision(record, gateStepId, this.decisionEvent(decision));

    const r2 = await record.run.resume({
      step: record.suspendedStep!,
      resumeData: { approved, mode: record.gateMode, reason },
    });

    const settled = this.applyWorkflowResult(record, r2);
    if (settled.status !== "awaiting_approval") this.finalizeSettlement(record);

    // For auto mode, if the workflow hits another auto gate, dispatch judge.
    // The approve() caller still receives the awaiting_approval shape so the UI
    // can show the gate is pending; the judge resolves it asynchronously.
    if (settled.status === "awaiting_approval" && record.gateMode === "auto") {
      const nextPayload = record.suspendPayload as { manualOnly?: boolean } | undefined;
      if (!nextPayload?.manualOnly) {
        void this.dispatchJudge(record);
      }
    }

    // Spec 029 FR-001: write artifact for every gate suspension and terminal
    // transition reached through the human-approval path.
    void this.persistArtifact(record);

    if (settled.status === "awaiting_approval") {
      return {
        runId,
        status: "awaiting_approval",
        gateMessage: settled.gateMessage,
        spec: settled.spec,
      };
    }
    if (settled.status === "succeeded") {
      return { runId, status: "succeeded", result: settled.result };
    }
    if (settled.status === "rejected") {
      return { runId, status: "rejected", error: settled.error };
    }
    return { runId, status: "failed", error: settled.error };
  }

  /**
   * Cancel an in-flight run (spec 033 D1/FR-001..FR-004).
   *
   * The status transition is synchronous — before the first await — so a second
   * cancel arriving in the same tick sees "cancelled" and is refused rather than
   * aborting the run twice.
   *
   * A `running` run is aborted through Mastra's own AbortController, whose signal
   * reaches every step's execute context and, from there, the adapters' SIGTERM
   * abort listeners — children die and the codex sanitized copy is swept by the
   * existing cleanup, with no per-adapter code here.
   *
   * An `awaiting_approval` run has no step in flight to abort: its gate is
   * resolved through the existing reject path so the workflow unwinds, while
   * `record.cancelled` keeps the terminal status "cancelled", never "rejected"
   * (FR-006).
   *
   * Returns undefined when the run id is unknown.
   */
  async cancel(runId: string, reason?: string): Promise<CancelResult | undefined> {
    const record = this.registry.get(runId);
    if (!record) {
      // Present on disk but not live: a refusal (409), not a 404 (spec 034 FR-011).
      const persisted = this.getPersisted(runId);
      return persisted ? { ok: false, status: persisted.status } : undefined;
    }
    if (record.status !== "running" && record.status !== "awaiting_approval") {
      return { ok: false, status: record.status };
    }

    // Checked before anything is mutated: if a Mastra upgrade drops cancel(),
    // the run must fail loudly here rather than be flagged "cancelled" while its
    // steps keep running and burning tokens.
    if (typeof record.run.cancel !== "function") {
      throw new Error("run cancellation unsupported by this workflow runtime");
    }

    // A suspended run whose step path was never recorded cannot be resumed —
    // resume() needs the exact path, and guessing one is worse than not
    // resuming. Such a run takes the plain abort path instead.
    const gateStep = record.status === "awaiting_approval" ? record.suspendedStep : undefined;
    const at = new Date().toISOString();
    record.cancelled = { at, ...(reason !== undefined ? { reason } : {}) };
    record.status = "cancelled";
    record.error = reason !== undefined ? `Run cancelled: ${reason}` : "Run cancelled";

    // FR-003: Mastra's stream never reports a cancellation, so the in-flight
    // steps are closed out here and the synthetic event is pushed to subscribers.
    for (const [stepId, state] of Object.entries(record.steps)) {
      if (state.status !== "started") continue;
      state.status = "cancelled";
      state.finishedAt = at;
      // FR-014: the same reason the synthetic event exists applies to the log —
      // the step's own terminal event arrives only once its child process has
      // died, which is after this cancel has closed the run's log. The builder
      // still emits its step.result on the abort path; for a run cancelled from
      // here that one lands in a closed log and is dropped, so exactly one
      // terminal event per step reaches the file either way.
      const startedAt = state.startedAt !== undefined ? Date.parse(state.startedAt) : Date.now();
      appendStepLog(record.run.runId, stepId, {
        kind: "step.result",
        status: "cancelled",
        durationMs: Date.now() - startedAt,
        ...(record.error !== undefined ? { error: record.error } : {}),
      });
      for (const listener of record.listeners) listener({ kind: "step-cancelled", stepId });
    }

    if (gateStep !== undefined) {
      const decision: GateDecision = {
        gateStepId: gateStep.join("."),
        mode: record.gateMode,
        decidedBy: "human",
        approved: false,
        ...(reason !== undefined ? { reason } : {}),
        decidedAt: at,
      };
      record.gateDecisions.push(decision);
      this.appendDecision(record, decision.gateStepId, this.decisionEvent(decision));
      try {
        const r2 = await record.run.resume({
          step: gateStep,
          resumeData: { approved: false, mode: record.gateMode, reason },
        });
        this.applyWorkflowResult(record, r2);
      } catch {
        // The workflow unwinding noisily does not change the outcome: the run is
        // cancelled either way, and record.error already names the reason.
      }
    } else {
      await record.run.cancel();
    }

    this.finalizeSettlement(record);
    record.settle({ status: "cancelled", error: record.error });
    void this.persistArtifact(record);
    return { ok: true };
  }

  /**
   * Apply a Mastra workflow result to the run record and return the settled shape.
   *
   * Used by both start() (background) and resolveGate() so the suspended/success/failed
   * branching lives in exactly one place.
   */
  private applyWorkflowResult(record: RunRecord, r: RunResult): SettledResult {
    // FR-006: cancel() is the authority on the terminal status. Cancelling an
    // awaiting_approval run resolves the gate through the reject path, so
    // without this guard the recorded status would read "rejected"; an aborted
    // running run would report "failed" for the same reason.
    if (record.cancelled !== undefined) {
      record.status = "cancelled";
      return {
        status: "cancelled",
        ...(record.error !== undefined ? { error: record.error } : {}),
      };
    }
    if (r.status === "suspended") {
      const suspendedPath = r.suspended?.[0];
      if (!suspendedPath || suspendedPath.length === 0) {
        throw new Error(
          `RunService: Mastra reported "suspended" but provided no step path — ` +
            `cannot resume safely. A wrong-step resume is worse than a loud failure.`
        );
      }
      record.status = "awaiting_approval";
      record.suspendedStep = suspendedPath;
      // Clear any previous judge error when a new gate appears.
      record.judgeError = undefined;
      // …and the previous gate's summary, which describes a decision already made.
      record.gateSummary = undefined;
      const stepKey = record.suspendedStep.join(".");
      const gateStep = r.steps?.[stepKey];
      const suspendPayload = gateStep?.suspendPayload;
      record.suspendPayload = suspendPayload;
      return {
        status: "awaiting_approval",
        gateMessage: (suspendPayload?.message as string | undefined) ?? "Approve this spec?",
        spec: suspendPayload?.spec,
      };
    }
    if (r.status === "success") {
      record.status = "succeeded";
      record.result = r.result;
      return { status: "succeeded", result: r.result };
    }
    // A GateRejectedError is a deliberate human/agent "no" — distinct from an unexpected
    // failure. Map it to "rejected" so callers can tell rejection apart from real errors.
    if (r.error?.name === "GateRejectedError") {
      record.status = "rejected";
      const errStr = r.error.message;
      record.error = errStr;
      return { status: "rejected", error: errStr };
    }
    record.status = "failed";
    const errStr = r.error
      ? r.error.name
        ? `${r.error.name}: ${r.error.message}`
        : r.error.message
      : "workflow failed";
    record.error = errStr;
    return { status: "failed", error: errStr };
  }

  /**
   * Decide whether to settle the promise or dispatch the judge (FR-003/FR-009).
   *
   * Manual mode or completed/failed: settle immediately.
   * Auto mode at a non-manualOnly gate: dispatch judge without settling.
   * Auto mode at a manualOnly gate: settle as awaiting_approval.
   *
   * Spec 029 FR-001: write a durable artifact on every gate suspension and
   * terminal transition. Fire-and-forget — disk errors must not affect the run.
   */
  private afterSettlement(record: RunRecord, settled: SettledResult): void {
    if (settled.status !== "awaiting_approval") this.finalizeSettlement(record);
    // Persist before potentially dispatching the judge so the gate-suspension
    // state is captured on disk even for auto runs (spec 029 FR-001).
    void this.persistArtifact(record);

    if (settled.status === "awaiting_approval" && record.gateMode === "auto") {
      const payload = record.suspendPayload as { manualOnly?: boolean } | undefined;
      if (!payload?.manualOnly) {
        // Dispatch judge without settling (FR-009: auto run does not settle at gate)
        void this.dispatchJudge(record);
        return;
      }
    }
    // Spec 043 FR-001: a human is about to be shown two buttons and a fixed
    // question. Fire-and-forget, and only here — an auto gate the judge will
    // answer has no reader, so summarising it would spend on nobody.
    void this.dispatchGateSummary(record);
    record.settle(settled);
  }

  /**
   * Resume the gate with an agent decision, honouring the single-flight guard.
   *
   * If the run has already left "awaiting_approval" (human approved while judge was in flight),
   * the verdict is recorded as superseded without applying (FR-003 race).
   */
  private async resolveGate(
    record: RunRecord,
    approved: boolean,
    decision: GateDecision
  ): Promise<void> {
    if (record.status !== "awaiting_approval") {
      // Race: human beat the judge. Record as superseded, do not apply.
      decision.superseded = true;
      record.gateDecisions.push(decision);
      this.appendDecision(record, decision.gateStepId, this.decisionEvent(decision));
      return;
    }
    // Single-flight guard — synchronous before first await.
    record.status = "running";
    record.gateDecisions.push(decision);
    this.appendDecision(record, decision.gateStepId, this.decisionEvent(decision));

    try {
      const r2 = await record.run.resume({
        step: record.suspendedStep!,
        resumeData: { approved, mode: "auto", reason: decision.reason },
      });
      const settled = this.applyWorkflowResult(record, r2);
      this.afterSettlement(record, settled);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      record.status = "failed";
      record.error = msg;
      this.finalizeSettlement(record);
      record.settle({ status: "failed", error: msg });
    }
  }

  /**
   * Run the gate judge for a given gate material (FR-004/FR-005/FR-012).
   *
   * Shared by dispatchJudge (auto-mode internal) and the /api/gate-judge route (FR-012).
   * Returns the verdict and metadata on success, or an error string on judge failure.
   * Never returns a successful result that could be interpreted as an approval on failure.
   */
  async gateJudge(material: {
    gateMessage: string;
    spec?: unknown;
    pipelineId?: string;
  }): Promise<{ verdict: "approve" | "reject"; reason: string } | { error: string }> {
    if (!this.judgeDeps) {
      return { error: "Gate judge not configured" };
    }
    const payload = { message: material.gateMessage, spec: material.spec };
    const result = await this.runJudgeCore(material.pipelineId ?? "unknown", "unknown", payload);
    if ("error" in result) return { error: result.error };
    return { verdict: result.verdict, reason: result.reason };
  }

  /**
   * Thin delegate to the judge module: the guard below is the only reason this
   * wrapper exists — a service with no JudgeDeps has no judge to call.
   */
  private async runJudgeCore(
    pipelineId: string,
    gateStepId: string,
    payload: { message?: string; spec?: unknown } | undefined,
    runProfile?: ProviderProfile
  ): Promise<JudgeResult> {
    if (!this.judgeDeps) return { error: "Gate judge not configured" };
    return runJudge(this.judgeDeps, pipelineId, gateStepId, payload, runProfile);
  }

  /**
   * Dispatch the gate judge for an auto run (FR-003/FR-004/FR-005).
   *
   * Fire-and-forget: called without await from afterSettlement() and approve().
   * On clean verdict: resolves via resolveGate() using the same single-flight guard.
   * On judge failure: degrades to manual by settling as awaiting_approval (FR-005).
   */
  private async dispatchJudge(record: RunRecord): Promise<void> {
    if (!this.judgeDeps) {
      // No judge configured (no JudgeDeps injected) — degrade to manual immediately.
      this.degradeToManual(record, "Gate judge not configured");
      return;
    }

    const gateStepId = record.suspendedStep?.join(".") ?? "unknown";
    const payload = record.suspendPayload as
      { message?: string; spec?: unknown; manualOnly?: boolean } | undefined;

    const result = await this.runJudgeCore(record.pipelineId, gateStepId, payload, record.profile);

    if ("error" in result) {
      this.degradeToManual(record, result.error);
      return;
    }

    const decision: GateDecision = {
      gateStepId,
      mode: "auto",
      decidedBy: "agent",
      approved: result.verdict === "approve",
      reason: result.reason,
      judgeModelId: result.judgeModelId,
      workspaceAccess: result.workspaceAccess,
      decidedAt: new Date().toISOString(),
    };
    await this.resolveGate(record, decision.approved, decision);
  }

  /**
   * Produce the gate's summary and attach it to the record (spec 043 FR-001).
   *
   * Fire-and-forget, and deliberately silent. The whole contract is that the
   * gate is no worse off than before this feature existed: no deps, a model
   * error, an empty answer — all of them simply leave `gateSummary` absent, and
   * the page falls back to the payload's own fields (D3/FR-003).
   *
   * Nothing awaits this and nothing branches on it. It cannot fail the run,
   * cannot delay the gate becoming approvable, and cannot resolve it.
   */
  private async dispatchGateSummary(record: RunRecord): Promise<void> {
    if (!this.summaryDeps) return;
    const gateStepId = record.suspendedStep?.join(".") ?? "unknown";
    const payload = record.suspendPayload as GatePayload | undefined;
    const result = await runGateSummary(
      this.summaryDeps,
      record.pipelineId,
      gateStepId,
      payload,
      record.profile
    );
    if ("error" in result) {
      // FR-003: the reason belongs in the log, not in the box the operator
      // reads to decide. A failure notice there is noise at the worst moment.
      this.appendDecision(record, gateStepId, {
        kind: "gate.summary.failed",
        gateStepId,
        error: result.error,
      });
      return;
    }
    // A gate answered while the call was in flight has no reader left.
    if (record.status !== "awaiting_approval") return;
    record.gateSummary = result.summary;
  }

  /**
   * Degrade to manual by setting judgeError and settling as awaiting_approval.
   * Idempotent: safe to call even if the run has already settled (Promise.resolve is no-op).
   */
  private degradeToManual(record: RunRecord, error: string): void {
    record.judgeError = error;
    // The judge was going to answer this gate and cannot; a human now will, so
    // the gate needs the summary it was not given when it was dispatched.
    void this.dispatchGateSummary(record);
    const gateStepId = record.suspendedStep?.join(".") ?? "unknown";
    this.appendDecision(record, gateStepId, { kind: "judge.degraded", gateStepId, error });
    const payload = record.suspendPayload as { message?: string; spec?: unknown } | undefined;
    record.settle({
      status: "awaiting_approval",
      gateMessage: payload?.message ?? "Approve this spec?",
      spec: payload?.spec,
    });
  }

  // ── Spec 029: durable artifact helpers ─────────────────────────────────────

  /**
   * Builds the per-step model/transport map from pipeline step definitions.
   *
   * Only llm steps resolve to a model; all other kinds (gate, check, persist-ticket,
   * export-spec, assemble-spec) are omitted — they have no model and an absent entry
   * is less misleading than an invented one.
   *
   * After loadPipeline+expandNested, pipeline-kind steps no longer exist as-is:
   * their children appear with namespaced ids (e.g. "outer.inner") and their
   * original role/model fields intact, so they are resolved naturally. Loop steps
   * have kind "loop" and are skipped; their body steps do NOT appear in the flat
   * steps list and are therefore absent from transportPerStep by design — a missing
   * entry is less harmful than a wrong one.
   *
   * Models override: wfInput.models (step id → registry model id) takes precedence
   * over the profile's role mapping. This is the point of the override feature: a
   * step run with haiku instead of the profile's opus must say haiku, not opus.
   */
  private computeTransportPerStep(
    steps: readonly StepDef[] | undefined,
    modelsRaw: unknown,
    profile: ProviderProfile | undefined,
    registry: ModelRegistry | undefined
  ): Record<string, StepProvenance> {
    if (!steps || !profile || !registry) return {};

    // Extract the models override map, or use an empty object when absent/malformed.
    const modelsOverride: Record<string, string> =
      modelsRaw !== null &&
      modelsRaw !== undefined &&
      typeof modelsRaw === "object" &&
      !Array.isArray(modelsRaw)
        ? (modelsRaw as Record<string, string>)
        : {};

    const result: Record<string, StepProvenance> = {};
    for (const step of steps) {
      if (step.kind !== "llm") continue;
      const overriddenId = modelsOverride[step.id];
      const entry =
        overriddenId !== undefined
          ? registry.resolve(overriddenId)
          : resolveStepModel(step, profile, registry);
      const provenance: StepProvenance = {
        transport: entry.transport,
        modelId: entry.id,
      };
      const modelName = entry.cli?.model ?? entry.api?.model;
      if (modelName !== undefined) provenance.model = modelName;
      result[step.id] = provenance;
    }
    return result;
  }

  /**
   * The directory this run writes into: the parent run's when chaining stages
   * (spec 029 FR-006), otherwise <runsDir>/<runId>. Undefined when no runs
   * directory is configured, in which case nothing durable is written at all.
   */
  private artifactDirFor(record: RunRecord): string | undefined {
    if (record.chainArtifactDir !== undefined) return record.chainArtifactDir;
    if (this.runsDir === undefined) return undefined;
    return join(this.runsDir, record.run.runId);
  }

  /**
   * Returns the provider profile id for provenance recording.
   * Falls back through: the run's own profile → judgeDeps.profile →
   * standaloneProfile → getActiveProfile() → "unknown".
   */
  private getProfileId(record?: RunRecord): string {
    const profile = record?.profile ?? this.judgeDeps?.profile ?? this.standaloneProfile;
    if (profile) return profile.id;
    return activeProfileIdOrUnknown();
  }

  /**
   * Assemble and write a durable artifact to disk, then update the chain manifest.
   *
   * Swallows all errors — a disk problem must never lose a completed run's
   * result (spec 029 FR-001/FR-006). The write is fire-and-forget from all callers.
   *
   * When record.chainArtifactDir is set (chaining from a parent run), artifacts
   * and the manifest are written into the parent's directory so that all stages
   * in a chain accumulate in one place (spec 029 FR-006).
   */
  private async persistArtifact(record: RunRecord): Promise<void> {
    const runId = record.run.runId;
    const artifactDir = this.artifactDirFor(record);
    if (!artifactDir) return;

    const snapshot = this.get(runId);
    if (!snapshot) return;

    const settledAt = new Date().toISOString();
    const provenance: ArtifactProvenance = {
      pipelineId: record.pipelineId,
      profileId: this.getProfileId(record),
      // Shallow-copy so future step additions don't mutate the written value.
      // Read through the introspection channel: a gate suspension persists an
      // artifact without finalizeSettlement having taken ownership yet.
      transportPerStep: this.mergedTransportPerStep(record),
      startedAt: record.createdAt.toISOString(),
      settledAt,
    };

    const artifactData: Record<string, unknown> = {
      ...snapshot,
      provenance,
      // FR-004: surface the cancellation at the top level of the artifact so a
      // reader does not have to reach into the nested `cancelled` object.
      ...(record.cancelled !== undefined
        ? {
            cancelledAt: record.cancelled.at,
            ...(record.cancelled.reason !== undefined ? { reason: record.cancelled.reason } : {}),
          }
        : {}),
    };

    const artifactPath = await writeRunArtifact(
      artifactDir,
      runId,
      record.pipelineId,
      artifactData
    );

    if (artifactPath !== undefined) {
      // Store on record so get() can expose it (FR-009).
      record.artifactPath = artifactPath;

      // Update the chain manifest (FR-006) in the directory that received the artifact.
      await upsertManifestEntry(artifactDir, record.createdAt.toISOString(), {
        stageId: record.pipelineId,
        artifactPath,
        profileId: this.getProfileId(record),
        status: record.status,
        settledAt,
        ...(record.error !== undefined ? { error: record.error } : {}),
        // FR-004: the manifest is the chain-level view, so a reader deciding
        // whether to resume a stage must see the cancellation there too.
        ...(record.cancelled !== undefined
          ? {
              cancelledAt: record.cancelled.at,
              ...(record.cancelled.reason !== undefined ? { reason: record.cancelled.reason } : {}),
            }
          : {}),
      });
    }
  }

  /**
   * Returns the path of the manifest file for a run, or undefined if the run
   * is unknown or has not written an artifact yet (spec 029 FR-006).
   *
   * The manifest lives in the same directory as the run's artifact:
   * either the chain dir (when chaining) or runs/<runId>/.
   */
  getManifestPath(runId: string): string | undefined {
    const record = this.registry.get(runId);
    if (!record) return undefined;
    const artifactDir = this.artifactDirFor(record);
    if (!artifactDir) return undefined;
    return join(artifactDir, "manifest.json");
  }

  /**
   * Subscribe to step lifecycle events for a run.
   *
   * Events are sourced from Mastra's own run stream (run.watch). Mastra emits
   * 'workflow-step-suspended' for a gate suspension and 'workflow-step-result'
   * with status 'failed' for a genuine step failure — they are distinct event
   * types, so a gate suspension is never delivered as a step failure here.
   *
   * On step-finish, the event carries outputExcerpt/outputTruncated from the
   * record's already-accumulated step state (FR-006).
   *
   * Returns an unsubscribe function. If the run id is unknown, returns a no-op.
   */
  subscribe(runId: string, listener: StepListener): () => void {
    const record = this.registry.get(runId);
    if (!record) return () => undefined;

    // FR-003: step-cancelled is synthesised by cancel(), not emitted by Mastra,
    // so the listener is registered on the record as well as on the run stream.
    record.listeners.add(listener);

    const unwatch = record.run.watch((event: WorkflowStreamEvent) => {
      if (event.type === "workflow-step-start") {
        listener({ kind: "step-start", stepId: event.payload.id });
      } else if (event.type === "workflow-step-suspended") {
        listener({
          kind: "step-suspended",
          stepId: event.payload.id,
          suspendPayload: event.payload.suspendPayload,
        });
      } else if (event.type === "workflow-step-result") {
        const { id, status, suspendPayload } = event.payload;
        if (status === "success" || status === "skipped") {
          // Read excerpt from the record-level accumulator set by start()'s watch.
          const stepState = record.steps[id];
          listener({
            kind: "step-finish",
            stepId: id,
            outputExcerpt: stepState?.outputExcerpt,
            outputTruncated: stepState?.outputTruncated,
          });
        } else if (status === "suspended") {
          listener({ kind: "step-suspended", stepId: id, suspendPayload });
        } else if (status === "failed") {
          listener({ kind: "step-failed", stepId: id });
        }
      }
    });

    return () => {
      record.listeners.delete(listener);
      unwatch();
    };
  }

  /**
   * Subscribe to a live run's step log events (spec 036 D4).
   *
   * Returns an unsubscribe function; a no-op for a disk run or an unknown id,
   * which have no sink to attach to — those readers use the backfill route.
   */
  subscribeLog(runId: string, listener: (event: StepLogEvent) => void): () => void {
    return subscribeRunLog(runId, listener);
  }

  /**
   * Where a run's events file and step outputs live, for the routes that serve
   * them. A run the registry no longer holds is located through its artifact
   * path, which already passed the state-root containment check (spec 034).
   */
  logLocation(runId: string): { dir: string; pipelineId: string } | undefined {
    const record = this.registry.get(runId);
    if (record) {
      if (record.artifactDir === undefined) return undefined;
      return { dir: record.artifactDir, pipelineId: record.pipelineId };
    }
    if (this.runsDir === undefined) return undefined;
    const persisted = readPersistedRun(this.runsDir, runId);
    if (!persisted) return undefined;
    const { artifactPath, pipelineId } = persisted;
    if (typeof artifactPath !== "string" || typeof pipelineId !== "string") return undefined;
    return { dir: dirname(artifactPath), pipelineId };
  }
}
