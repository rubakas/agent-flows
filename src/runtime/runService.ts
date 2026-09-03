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
  /** "awaiting_approval" when the run suspended at a gate. */
  status: "awaiting_approval" | "success" | "failed";
  gateMessage?: string;
  spec?: unknown;
  result?: unknown;
}

export interface ApproveResult {
  runId: string;
  status?: "success" | "failed";
  result?: unknown;
  /** Defined when the call could not be processed (no run, wrong status, etc.). */
  error?: string;
}

export interface GetResult {
  runId: string;
  pipelineId: string;
  status: "running" | "suspended" | "success" | "failed";
  result?: unknown;
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
}

// ── RunService ─────────────────────────────────────────────────────────────────

export class RunService {
  private readonly registry = new Map<string, RunRecord>();

  constructor(private readonly mastra: MastraLike) {}

  /**
   * Start a pipeline run. Returns immediately.
   * If the pipeline suspends at a gate, returns status "awaiting_approval".
   * The public run id is Mastra's own run id so it keys LibSQL snapshots and
   * resume() calls without a separate mapping.
   */
  async start(pipelineId: string, wfInput: Record<string, unknown>): Promise<StartResult> {
    const wf = this.mastra.getWorkflow(pipelineId);
    const run = await wf.createRun();
    const { runId } = run;

    const record: RunRecord = { pipelineId, run, status: "running" };
    this.registry.set(runId, record);

    const r1 = await run.start({ inputData: wfInput });

    if (r1.status === "suspended") {
      record.status = "suspended";
      record.suspendedStep = r1.suspended?.[0] ?? ["approve"];
      const gateStep = r1.steps?.approve;
      const suspendPayload = gateStep?.suspendPayload;
      record.suspendPayload = suspendPayload;
      return {
        runId,
        status: "awaiting_approval",
        gateMessage: (suspendPayload?.message as string | undefined) ?? "Approve this spec?",
        spec: suspendPayload?.spec,
      };
    }

    if (r1.status === "success") {
      record.status = "success";
      record.result = r1.result;
      return { runId, status: "success", result: r1.result };
    }

    record.status = "failed";
    return { runId, status: "failed" };
  }

  /** Return the current state of a run, or undefined if the id is unknown. */
  get(runId: string): GetResult | undefined {
    const record = this.registry.get(runId);
    if (!record) return undefined;
    return {
      runId,
      pipelineId: record.pipelineId,
      status: record.status,
      result: record.result,
    };
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
      step: record.suspendedStep ?? ["approve"],
      resumeData: { approved },
    });

    if (r2.status === "success") {
      record.status = "success";
      record.result = r2.result;
      return { runId, status: "success", result: r2.result };
    }

    record.status = "failed";
    return { runId, status: "failed" };
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
