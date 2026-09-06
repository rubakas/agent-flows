// Transport-agnostic run ownership (FR-011).
// Owns the in-process run registry so that MCP stdio, HTTP and the web editor
// all talk to the same state rather than each maintaining their own Map.

import type { WorkflowStreamEvent } from "@mastra/core/stream";

// ── Narrow interfaces for the Mastra API subset used here ────────────────────
// Using structural interfaces rather than Mastra's deeply-generic Run<...> types
// avoids propagating `any` throughout the module while keeping tsc clean.

interface RunResult {
  status: string;
  suspended?: [string[], ...string[][]];
  steps?: Record<string, { suspendPayload?: Record<string, unknown> }>;
  result?: unknown;
}

interface MastraRun {
  readonly runId: string;
  start(opts: { inputData: Record<string, unknown> }): Promise<RunResult>;
  resume(params: { step: string[]; resumeData: unknown }): Promise<RunResult>;
  watch(cb: (event: WorkflowStreamEvent) => void): () => void;
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

export interface StepEvent {
  kind: "step-start" | "step-finish" | "step-suspended" | "step-failed";
  stepId: string;
  suspendPayload?: unknown;
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
 */
export interface SettledResult {
  status: "awaiting_approval" | "success" | "failed";
  gateMessage?: string;
  spec?: unknown;
  result?: unknown;
}

export interface ApproveResult {
  runId: string;
  status?: "awaiting_approval" | "success" | "failed";
  gateMessage?: string;
  spec?: unknown;
  result?: unknown;
  /** Defined when the call could not be processed (no run, wrong status, etc.). */
  error?: string;
}

export interface GetResult {
  runId: string;
  pipelineId: string;
  status: "running" | "suspended" | "success" | "failed";
  result?: unknown;
  /** Present only when status is "suspended" — the pending gate's human-readable prompt. */
  gateMessage?: string;
  /** Present only when status is "suspended" — the spec the human is being asked to approve. */
  spec?: unknown;
}

// ── Internal record ────────────────────────────────────────────────────────────

interface RunRecord {
  pipelineId: string;
  run: MastraRun;
  status: "running" | "suspended" | "success" | "failed";
  result?: unknown;
  suspendPayload?: unknown;
  /** The suspended step path returned by Mastra, needed for resume(). */
  suspendedStep?: string[];
  /** Resolves once the background run first suspends or completes. */
  readonly settledPromise: Promise<SettledResult>;
  /** Call exactly once from the background to resolve settledPromise. */
  readonly settle: (result: SettledResult) => void;
}

// ── RunService ─────────────────────────────────────────────────────────────────

export class RunService {
  private readonly registry = new Map<string, RunRecord>();

  constructor(private readonly mastra: MastraLike) {}

  /**
   * Start a pipeline run and return immediately with status "running".
   *
   * The run advances in the background — run.start() is fired without being
   * awaited. When the run first suspends or completes, the registry record is
   * updated and settledPromise resolves. Use waitForSettled() to block until
   * that point (MCP callers need this; HTTP callers do not).
   *
   * The public run id is Mastra's own run id so it keys LibSQL snapshots and
   * resume() calls without a separate mapping.
   */
  async start(pipelineId: string, wfInput: Record<string, unknown>): Promise<StartResult> {
    const wf = this.mastra.getWorkflow(pipelineId);
    const run = await wf.createRun();
    const { runId } = run;

    let settle!: (result: SettledResult) => void;
    const settledPromise = new Promise<SettledResult>((resolve) => {
      settle = resolve;
    });

    const record: RunRecord = { pipelineId, run, status: "running", settledPromise, settle };
    this.registry.set(runId, record);

    // Fire the run in the background — do NOT await.
    // The result/rejection updates the registry record and resolves settledPromise.
    // The void operator makes the dangling promise intentional; the catch branch
    // ensures no unhandled rejection can surface.
    void run
      .start({ inputData: wfInput })
      .then((r1) => {
        record.settle(this.applyWorkflowResult(record, r1));
      })
      .catch(() => {
        record.status = "failed";
        record.settle({ status: "failed" });
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
   * Returns undefined if the runId is unknown.
   */
  async waitForSettled(runId: string): Promise<SettledResult | undefined> {
    const record = this.registry.get(runId);
    if (!record) return undefined;
    return record.settledPromise;
  }

  /** Return the current state of a run, or undefined if the id is unknown. */
  get(runId: string): GetResult | undefined {
    const record = this.registry.get(runId);
    if (!record) return undefined;
    const out: GetResult = {
      runId,
      pipelineId: record.pipelineId,
      status: record.status,
      result: record.result,
    };
    if (record.status === "suspended") {
      const payload = record.suspendPayload as Record<string, unknown> | undefined;
      out.gateMessage = (payload?.message as string | undefined) ?? "Approve this spec?";
      out.spec = payload?.spec;
    }
    return out;
  }

  /**
   * Approve or reject a suspended run.
   *
   * Single-flight per run id: the status transition to "running" happens
   * synchronously before any await, so two approvals arriving in the same
   * tick both see the guard on the first synchronous pass. The second call
   * finds status "running" (not "suspended") and returns a defined error
   * rather than resuming the workflow twice.
   *
   * Approving a run that is not suspended (already resolved, still running,
   * or unknown) returns an error — never a silent no-op.
   */
  async approve(runId: string, approved: boolean): Promise<ApproveResult> {
    const record = this.registry.get(runId);
    if (!record) return { runId, error: `No run found for runId "${runId}"` };
    if (record.status !== "suspended") {
      return { runId, error: `Run ${runId} is not suspended (status: ${record.status})` };
    }

    // Take the state transition synchronously — before the first await.
    // Any concurrent approve that reaches this point after the assignment
    // will see "running", fail the guard above, and return the error.
    record.status = "running";

    const r2 = await record.run.resume({
      step: record.suspendedStep!,
      resumeData: { approved },
    });

    const settled = this.applyWorkflowResult(record, r2);

    if (settled.status === "awaiting_approval") {
      return {
        runId,
        status: "awaiting_approval",
        gateMessage: settled.gateMessage,
        spec: settled.spec,
      };
    }
    if (settled.status === "success") {
      return { runId, status: "success", result: settled.result };
    }
    return { runId, status: "failed" };
  }

  /**
   * Apply a Mastra workflow result to the run record and return the settled shape.
   *
   * Used by both start() (background) and approve() so the suspended/success/failed
   * branching lives in exactly one place.
   */
  private applyWorkflowResult(record: RunRecord, r: RunResult): SettledResult {
    if (r.status === "suspended") {
      const suspendedPath = r.suspended?.[0];
      if (!suspendedPath || suspendedPath.length === 0) {
        throw new Error(
          `RunService: Mastra reported "suspended" but provided no step path — ` +
            `cannot resume safely. A wrong-step resume is worse than a loud failure.`
        );
      }
      record.status = "suspended";
      record.suspendedStep = suspendedPath;
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
      record.status = "success";
      record.result = r.result;
      return { status: "success", result: r.result };
    }
    record.status = "failed";
    return { status: "failed" };
  }

  /**
   * Subscribe to step lifecycle events for a run.
   *
   * Events are sourced from Mastra's own run stream (run.watch). Mastra emits
   * 'workflow-step-suspended' for a gate suspension and 'workflow-step-result'
   * with status 'failed' for a genuine step failure — they are distinct event
   * types, so a gate suspension is never delivered as a step failure here.
   *
   * Returns an unsubscribe function. If the run id is unknown, returns a no-op.
   */
  subscribe(runId: string, listener: StepListener): () => void {
    const record = this.registry.get(runId);
    if (!record) return () => undefined;

    return record.run.watch((event: WorkflowStreamEvent) => {
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
          listener({ kind: "step-finish", stepId: id });
        } else if (status === "suspended") {
          listener({ kind: "step-suspended", stepId: id, suspendPayload });
        } else if (status === "failed") {
          listener({ kind: "step-failed", stepId: id });
        }
      }
    });
  }
}
