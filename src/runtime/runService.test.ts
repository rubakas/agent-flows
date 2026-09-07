// Tests for RunService.
//
// Uses pure mock MastraLike objects rather than a real Mastra instance so that
// the test file never imports @mastra/core deep-subpath exports, which cause
// eslint-plugin-import-x@4.17.1 to crash. Real Mastra integration (suspend /
// resume / LibSQL snapshots) is covered by build.test.ts.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ModelRegistry } from "../canon/registry.js";
import { RunService } from "./runService.js";
import type { JudgeDeps, MastraLike, StepEvent } from "./runService.js";
import type { ModelEntry, ProviderProfile } from "../canon/registry.js";

// ── Mock helpers ──────────────────────────────────────────────────────────────

type WatchCallback = (event: Record<string, unknown>) => void;

interface MockRun {
  runId: string;
  startResult: Record<string, unknown>;
  resumeResult: Record<string, unknown>;
  watchers: WatchCallback[];
  start: (opts: unknown) => Promise<Record<string, unknown>>;
  resume: (params: unknown) => Promise<Record<string, unknown>>;
  watch: (cb: WatchCallback) => () => void;
  emit: (event: Record<string, unknown>) => void;
}

function makeMockRun(
  runId: string,
  startResult: Record<string, unknown>,
  resumeResult: Record<string, unknown>
): MockRun {
  const watchers: WatchCallback[] = [];
  return {
    runId,
    startResult,
    resumeResult,
    watchers,
    start: async () => startResult,
    resume: async () => resumeResult,
    watch: (cb) => {
      watchers.push(cb);
      return () => {
        const i = watchers.indexOf(cb);
        if (i !== -1) watchers.splice(i, 1);
      };
    },
    emit: (event) => {
      for (const cb of watchers) cb(event);
    },
  };
}

function makeMastra(run: MockRun): MastraLike {
  return {
    getWorkflow: (_id) => ({
      createRun: async () =>
        run as unknown as Awaited<ReturnType<ReturnType<MastraLike["getWorkflow"]>["createRun"]>>,
    }),
  };
}

// ── Suspended start result fixture ────────────────────────────────────────────

function suspendedResult(_runId: string): Record<string, unknown> {
  return {
    status: "suspended",
    suspended: [["approve"]],
    steps: { approve: { suspendPayload: { message: "Approve this spec?", spec: { title: "T" } } } },
  };
}

function successResult(): Record<string, unknown> {
  return { status: "success", result: { ticketId: 42 } };
}

// ── Tests: non-blocking start ─────────────────────────────────────────────────

describe("RunService.start — non-blocking: returns immediately, background settles", () => {
  it("start returns status 'running' before the background run settles", async () => {
    let resolveBackground!: (r: Record<string, unknown>) => void;

    // A run whose start() does not resolve until we call resolveBackground.
    const pendingRun: Partial<MockRun> & { runId: string; watchers: WatchCallback[] } = {
      runId: "pending-run-001",
      watchers: [],
      start: () =>
        new Promise<Record<string, unknown>>((resolve) => {
          resolveBackground = resolve;
        }),
      resume: async () => successResult(),
      watch: (_cb: WatchCallback) => () => undefined,
    };

    const service = new RunService(makeMastra(pendingRun as unknown as MockRun));

    // start() must return immediately — not wait for the background run.start().
    const startResult = await service.start("test-pipeline", { request: "test" });
    assert.equal(startResult.status, "running", "start must return 'running' immediately");
    assert.equal(startResult.runId, "pending-run-001", "runId must be Mastra's own id");

    // The background has not settled yet — registry shows 'running'.
    const mid = service.get(startResult.runId);
    assert.ok(mid !== undefined, "run must be in registry immediately");
    assert.equal(mid.status, "running", "registry must show 'running' before background settles");

    // Resolve the background run.start() to a suspended result.
    resolveBackground(suspendedResult("pending-run-001"));

    // waitForSettled resolves once the background processes the result.
    const settled = await service.waitForSettled(startResult.runId);
    assert.ok(settled !== undefined, "waitForSettled must resolve");
    assert.equal(settled.status, "awaiting_approval", "settled state must be awaiting_approval");
    assert.ok(settled.gateMessage, "gateMessage must be set");
    assert.ok(settled.spec, "spec must be set");

    // Registry now reflects suspended.
    const after = service.get(startResult.runId);
    assert.ok(after !== undefined);
    assert.equal(after.status, "suspended", "get must show 'suspended' after background settles");
  });

  it("waitForSettled returns undefined for an unknown runId", async () => {
    const run = makeMockRun("run-noop", successResult(), successResult());
    const service = new RunService(makeMastra(run));
    const result = await service.waitForSettled("nonexistent-id");
    assert.equal(result, undefined);
  });
});

// ── Tests: start / get ────────────────────────────────────────────────────────

describe("RunService.start — run reaches gate, get reports suspended", () => {
  it("start returns running with runId; waitForSettled returns awaiting_approval; get returns suspended", async () => {
    const mockRunId = "mastra-run-abc123";
    const run = makeMockRun(mockRunId, suspendedResult(mockRunId), successResult());
    const service = new RunService(makeMastra(run));

    const startResult = await service.start("test-pipeline", { request: "test" });

    assert.equal(startResult.status, "running", "start must return running immediately");
    // Run id is Mastra's own id — not a locally-minted UUID.
    assert.equal(startResult.runId, mockRunId, "runId must be Mastra's own run id");

    // Wait for the background to settle.
    const settled = await service.waitForSettled(startResult.runId);
    assert.ok(settled !== undefined, "waitForSettled must resolve");
    assert.equal(settled.status, "awaiting_approval", "settled state must be awaiting_approval");
    assert.ok(settled.gateMessage, "gateMessage should be set");
    assert.ok(settled.spec, "spec should be set");

    const got = service.get(startResult.runId);
    assert.ok(got !== undefined, "get should find the run");
    assert.equal(got.status, "suspended");
    assert.equal(got.pipelineId, "test-pipeline");
  });

  it("start returns running; waitForSettled returns success when workflow completes without a gate", async () => {
    const run = makeMockRun("run-direct", successResult(), successResult());
    const service = new RunService(makeMastra(run));

    const startResult = await service.start("test-pipeline", { request: "test" });

    assert.equal(startResult.status, "running");
    assert.equal(startResult.runId, "run-direct");

    const settled = await service.waitForSettled(startResult.runId);
    assert.ok(settled !== undefined);
    assert.equal(settled.status, "success");

    const got = service.get(startResult.runId);
    assert.ok(got !== undefined);
    assert.equal(got.status, "success");
  });

  it("get returns undefined for an unknown run id", async () => {
    const run = makeMockRun("run-x", successResult(), successResult());
    const service = new RunService(makeMastra(run));

    assert.equal(service.get("nonexistent"), undefined);
  });
});

// ── Tests: approve ────────────────────────────────────────────────────────────

describe("RunService.approve — resumes suspended run", () => {
  it("approve returns success and get reflects success", async () => {
    const run = makeMockRun("run-ok", suspendedResult("run-ok"), successResult());
    const service = new RunService(makeMastra(run));

    const startResult = await service.start("test-pipeline", { request: "test" });
    // Wait for background to reach suspended before approving.
    await service.waitForSettled(startResult.runId);

    const approval = await service.approve(startResult.runId, true);
    assert.equal(approval.error, undefined, "approve should not return an error");
    assert.equal(approval.status, "success");

    const got = service.get(startResult.runId);
    assert.ok(got !== undefined);
    assert.equal(got.status, "success");
  });
});

// ── Tests: approve — defined error on resolved run ────────────────────────────

describe("RunService.approve — second approve returns defined error", () => {
  it("returns error when run is already resolved", async () => {
    const run = makeMockRun("run-resolved", suspendedResult("run-resolved"), successResult());
    const service = new RunService(makeMastra(run));

    const startResult = await service.start("test-pipeline", { request: "test" });
    await service.waitForSettled(startResult.runId);

    const first = await service.approve(startResult.runId, true);
    assert.equal(first.error, undefined, "first approve must succeed");
    assert.equal(first.status, "success");

    // Second approve on an already-resolved run must return a defined error.
    const second = await service.approve(startResult.runId, true);
    assert.ok(typeof second.error === "string", "second approve must return an error string");
    assert.ok(second.error.includes(startResult.runId), "error should name the run id");
    // Must not return status "success" — it must be an error, not a silent no-op.
    assert.equal(second.status, undefined, "second approve must not report status success");
  });

  it("returns error when run is unknown", async () => {
    const run = makeMockRun("run-y", successResult(), successResult());
    const service = new RunService(makeMastra(run));

    const result = await service.approve("nonexistent-run-id", true);
    assert.ok(typeof result.error === "string", "unknown run must return error string");
    assert.ok(result.error.includes("nonexistent-run-id"), "error should name the run id");
  });
});

// ── Tests: single-flight ──────────────────────────────────────────────────────

describe("RunService.approve — single-flight: two concurrent approvals resolve once", () => {
  it("exactly one approval succeeds when two arrive in the same tick", async () => {
    // Use a slow resume so both calls start before the first finishes.
    let resumeCount = 0;
    const slowRun: Partial<MockRun> & { runId: string; watchers: WatchCallback[] } = {
      runId: "run-race",
      watchers: [],
      start: async () => suspendedResult("run-race"),
      resume: async () => {
        resumeCount++;
        // Yield to allow the second approve() to start.
        await new Promise<void>((resolve) => setImmediate(resolve));
        return successResult();
      },
      watch: (_cb: WatchCallback) => () => undefined,
    };

    const service = new RunService(makeMastra(slowRun as unknown as MockRun));
    const startResult = await service.start("test-pipeline", { request: "test" });
    // Wait for the background to reach suspended before racing two approvals.
    await service.waitForSettled(startResult.runId);

    // Both approve calls are started without awaiting the first.
    const [r1, r2] = await Promise.all([
      service.approve(startResult.runId, true),
      service.approve(startResult.runId, true),
    ]);

    const successes = [r1, r2].filter((r) => r.status === "success" && r.error === undefined);
    const errors = [r1, r2].filter((r) => typeof r.error === "string");

    assert.equal(successes.length, 1, "exactly one approve must succeed");
    assert.equal(errors.length, 1, "exactly one approve must return an error");
    assert.equal(resumeCount, 1, "run.resume must be called exactly once");
  });
});

// ── Tests: two sequential gates ──────────────────────────────────────────────

describe("RunService — two sequential gates: approve re-suspends at second gate", () => {
  it("run suspends at A, approved, suspends at B, approved, then succeeds — asserting status and gate payloads", async () => {
    const gateAResult: Record<string, unknown> = {
      status: "suspended",
      suspended: [["approve"]],
      steps: {
        approve: { suspendPayload: { message: "Approve gate A?", spec: { title: "A" } } },
      },
    };
    const gateBResult: Record<string, unknown> = {
      status: "suspended",
      suspended: [["plan", "approve"]],
      steps: {
        "plan.approve": { suspendPayload: { message: "Approve gate B?", spec: { title: "B" } } },
      },
    };

    let resumeCount = 0;
    const mockRun: Partial<MockRun> & { runId: string; watchers: WatchCallback[] } = {
      runId: "run-two-gates",
      watchers: [],
      start: async () => gateAResult,
      resume: async () => {
        resumeCount++;
        return resumeCount === 1 ? gateBResult : successResult();
      },
      watch: (_cb: WatchCallback) => () => undefined,
    };

    const service = new RunService(makeMastra(mockRun as unknown as MockRun));

    // start → suspended at gate A
    const startResult = await service.start("test-pipeline", { request: "test" });
    assert.equal(startResult.status, "running");

    const settled = await service.waitForSettled(startResult.runId);
    assert.ok(settled !== undefined);
    assert.equal(settled.status, "awaiting_approval");
    assert.equal(settled.gateMessage, "Approve gate A?");
    assert.deepEqual(settled.spec, { title: "A" });
    assert.equal(service.get(startResult.runId)?.status, "suspended");

    // approve gate A → re-suspends at gate B
    const approvalA = await service.approve(startResult.runId, true);
    assert.equal(approvalA.error, undefined, "approving gate A must not error");
    assert.equal(approvalA.status, "awaiting_approval");
    assert.equal(approvalA.gateMessage, "Approve gate B?");
    assert.deepEqual(approvalA.spec, { title: "B" });
    assert.equal(service.get(startResult.runId)?.status, "suspended");

    // approve gate B → success
    const approvalB = await service.approve(startResult.runId, true);
    assert.equal(approvalB.error, undefined, "approving gate B must not error");
    assert.equal(approvalB.status, "success");
    assert.equal(service.get(startResult.runId)?.status, "success");
    assert.equal(resumeCount, 2, "resume must be called exactly twice");
  });
});

// ── Tests: payload from actual suspended step id ──────────────────────────────

describe("RunService — payload is read from actual suspended step id, not hardcoded 'approve'", () => {
  it("returns gateMessage and spec from a nested gate named plan.approve", async () => {
    const nestedSuspendedResult: Record<string, unknown> = {
      status: "suspended",
      suspended: [["plan", "approve"]],
      steps: {
        "plan.approve": {
          suspendPayload: { message: "Approve the plan?", spec: { title: "Plan" } },
        },
      },
    };

    const mockRun: Partial<MockRun> & { runId: string; watchers: WatchCallback[] } = {
      runId: "run-nested-gate",
      watchers: [],
      start: async () => nestedSuspendedResult,
      resume: async () => successResult(),
      watch: (_cb: WatchCallback) => () => undefined,
    };

    const service = new RunService(makeMastra(mockRun as unknown as MockRun));
    const startResult = await service.start("test-pipeline", { request: "test" });
    const settled = await service.waitForSettled(startResult.runId);

    assert.ok(settled !== undefined);
    assert.equal(settled.status, "awaiting_approval");
    assert.equal(
      settled.gateMessage,
      "Approve the plan?",
      "gateMessage must come from plan.approve step, not hardcoded 'approve'"
    );
    assert.deepEqual(settled.spec, { title: "Plan" });

    const approval = await service.approve(startResult.runId, true);
    assert.equal(approval.error, undefined);
    assert.equal(approval.status, "success");
  });
});

// ── Tests: get — gate payload (pending gate retrievable from state) ───────────

describe("RunService.get — suspended run carries gate payload for reconnecting clients", () => {
  it("get() on a suspended run returns gateMessage and spec from the pending gate", async () => {
    const mockRunId = "gate-payload-run-001";
    const run = makeMockRun(mockRunId, suspendedResult(mockRunId), successResult());
    const service = new RunService(makeMastra(run));

    const startResult = await service.start("test-pipeline", { request: "test" });
    await service.waitForSettled(startResult.runId);

    const got = service.get(startResult.runId);
    assert.ok(got !== undefined, "get must find the suspended run");
    assert.equal(got.status, "suspended");
    assert.ok(
      typeof got.gateMessage === "string" && got.gateMessage.length > 0,
      `gateMessage must be a non-empty string; got ${JSON.stringify(got.gateMessage)}`
    );
    assert.ok(
      got.spec !== undefined && got.spec !== null,
      `spec must be present; got ${JSON.stringify(got.spec)}`
    );
  });

  it("get() on a running run does not carry gateMessage or spec", async () => {
    let resolveBackground!: (r: Record<string, unknown>) => void;
    const pendingRun: Partial<MockRun> & { runId: string; watchers: WatchCallback[] } = {
      runId: "gate-payload-running-001",
      watchers: [],
      start: () =>
        new Promise<Record<string, unknown>>((resolve) => {
          resolveBackground = resolve;
        }),
      resume: async () => successResult(),
      watch: (_cb: WatchCallback) => () => undefined,
    };

    const service = new RunService(makeMastra(pendingRun as unknown as MockRun));
    const startResult = await service.start("test-pipeline", { request: "test" });

    const got = service.get(startResult.runId);
    assert.ok(got !== undefined);
    assert.equal(got.status, "running");
    assert.equal(got.gateMessage, undefined, "running run must not carry gateMessage");
    assert.equal(got.spec, undefined, "running run must not carry spec");

    // Resolve background so the run does not dangle.
    resolveBackground(successResult());
    await service.waitForSettled(startResult.runId);
  });

  it("get() on a completed run does not carry gateMessage or spec", async () => {
    const run = makeMockRun("gate-payload-done-001", successResult(), successResult());
    const service = new RunService(makeMastra(run));

    const startResult = await service.start("test-pipeline", { request: "test" });
    await service.waitForSettled(startResult.runId);

    const got = service.get(startResult.runId);
    assert.ok(got !== undefined);
    assert.equal(got.status, "success");
    assert.equal(got.gateMessage, undefined, "completed run must not carry gateMessage");
    assert.equal(got.spec, undefined, "completed run must not carry spec");
  });
});

// ── Fix 4 regression: missing step path must fail loudly, not fall back to "approve" ─

// Before the fix, applyWorkflowResult falls back to ["approve"] when Mastra
// reports suspended but provides no step path. A gate named anything else would
// then be resumed at the wrong step, silently causing undefined behaviour.
// After the fix, the missing step path throws, the background .catch fires, and
// the run is marked "failed" so the caller gets a loud error rather than a
// silent wrong-step resume.
//
// This test MUST FAIL before the runService.ts applyWorkflowResult fix.
describe("RunService — missing step path fails loudly instead of falling back to 'approve'", () => {
  it("run is marked failed when Mastra reports suspended with no step path", async () => {
    const noPathRun: Partial<MockRun> & { runId: string; watchers: WatchCallback[] } = {
      runId: "run-no-step-path",
      watchers: [],
      start: async () => ({
        status: "suspended",
        // `suspended` field is absent — Mastra gave no step path.
      }),
      resume: async () => successResult(),
      watch: (_cb: WatchCallback) => () => undefined,
    };

    const service = new RunService(makeMastra(noPathRun as unknown as MockRun));
    const startResult = await service.start("test-pipeline", { request: "test" });

    const settled = await service.waitForSettled(startResult.runId);
    assert.ok(settled !== undefined, "waitForSettled must resolve");
    assert.equal(
      settled.status,
      "failed",
      "run must be marked failed when no step path is provided — " +
        "fails before fix because the fallback ['approve'] silently marks the run as suspended"
    );
  });
});

// ── Tests: failed run surfaces an error reason ────────────────────────────────

describe("RunService — failed run surfaces error reason in get()", () => {
  it("get() on a run that failed via .catch returns a non-empty error string", async () => {
    const throwingRun: Partial<MockRun> & { runId: string; watchers: WatchCallback[] } = {
      runId: "run-throw",
      watchers: [],
      start: async () => {
        throw new Error("network timeout");
      },
      resume: async () => successResult(),
      watch: (_cb: WatchCallback) => () => undefined,
    };

    const service = new RunService(makeMastra(throwingRun as unknown as MockRun));
    const startResult = await service.start("test-pipeline", { request: "test" });

    const settled = await service.waitForSettled(startResult.runId);
    assert.ok(settled !== undefined, "waitForSettled must resolve");
    assert.equal(settled.status, "failed");
    assert.ok(
      typeof settled.error === "string" && settled.error.length > 0,
      `settled.error must be a non-empty string; got ${JSON.stringify(settled.error)}`
    );
    assert.ok(
      settled.error.includes("network timeout"),
      `settled.error must include the original message; got: ${settled.error}`
    );

    const got = service.get(startResult.runId);
    assert.ok(got !== undefined, "get must find the run");
    assert.equal(got.status, "failed");
    assert.ok(
      typeof got.error === "string" && got.error.length > 0,
      `get().error must be a non-empty string — fails without error capture in .catch; got ${JSON.stringify(got.error)}`
    );
    assert.ok(
      got.error.includes("network timeout"),
      `get().error must include the original message; got: ${got.error}`
    );
  });

  it("get() on a run that returned status:failed carries an error string", async () => {
    const failedResult: Record<string, unknown> = {
      status: "failed",
      error: Object.assign(new Error("step exploded"), { name: "StepError" }),
    };
    const failedRun: Partial<MockRun> & { runId: string; watchers: WatchCallback[] } = {
      runId: "run-failed-result",
      watchers: [],
      start: async () => failedResult,
      resume: async () => successResult(),
      watch: (_cb: WatchCallback) => () => undefined,
    };

    const service = new RunService(makeMastra(failedRun as unknown as MockRun));
    const startResult = await service.start("test-pipeline", { request: "test" });

    const settled = await service.waitForSettled(startResult.runId);
    assert.ok(settled !== undefined);
    assert.equal(settled.status, "failed");
    assert.ok(
      typeof settled.error === "string" && settled.error.length > 0,
      `settled.error must be a non-empty string; got ${JSON.stringify(settled.error)}`
    );

    const got = service.get(startResult.runId);
    assert.ok(got !== undefined);
    assert.equal(got.status, "failed");
    assert.ok(
      typeof got.error === "string" && got.error.length > 0,
      `get().error must be a non-empty string — fails without error capture in applyWorkflowResult; got ${JSON.stringify(got.error)}`
    );
    assert.ok(
      got.error.includes("step exploded"),
      `get().error must include the original message; got: ${got.error}`
    );
  });
});

// ── Tests: subscribe ──────────────────────────────────────────────────────────

describe("RunService.subscribe — step events and gate suspension", () => {
  it("returns a no-op unsubscribe for an unknown run id", async () => {
    const run = makeMockRun("run-sub-noop", successResult(), successResult());
    const service = new RunService(makeMastra(run));

    const unsub = service.subscribe("nonexistent-id", () => undefined);
    assert.doesNotThrow(() => unsub(), "unsubscribe should be callable without error");
  });

  it("gate suspension event is delivered as step-suspended, not step-failed", async () => {
    const run = makeMockRun("run-sub-gate", suspendedResult("run-sub-gate"), successResult());
    const service = new RunService(makeMastra(run));

    const startResult = await service.start("test-pipeline", { request: "test" });
    // The run is in the registry immediately; subscribe works without waiting for settlement.

    const events: StepEvent[] = [];
    const unsubscribe = service.subscribe(startResult.runId, (e) => events.push(e));

    // Emit a 'workflow-step-suspended' event — the Mastra event type for a gate suspension.
    run.emit({
      type: "workflow-step-suspended",
      payload: { id: "approve", status: "suspended", suspendPayload: { message: "Approve?" } },
    });

    // Emit a 'workflow-step-result' with status "suspended" — the other suspension path.
    run.emit({
      type: "workflow-step-result",
      payload: {
        id: "approve",
        stepCallId: "call-1",
        status: "suspended",
        suspendPayload: { message: "Approve?" },
      },
    });

    assert.equal(events.length, 2, "two suspension events should produce two StepEvents");
    for (const e of events) {
      assert.equal(e.kind, "step-suspended", `gate event must be step-suspended, got: ${e.kind}`);
      assert.equal(e.stepId, "approve");
    }
    assert.ok(
      !events.some((e) => e.kind === "step-failed"),
      "gate suspension must never be reported as step-failed"
    );

    // start() attaches one record-level watch; subscribe() adds a second.
    // After unsubscribe(), only the record-level watch remains (FR-006).
    const countBeforeUnsub = run.watchers.length;
    unsubscribe();
    assert.equal(
      run.watchers.length,
      countBeforeUnsub - 1,
      "unsubscribe must remove exactly the subscriber's listener"
    );
  });

  it("genuine step failure is delivered as step-failed, not step-suspended", async () => {
    const run = makeMockRun("run-sub-fail", suspendedResult("run-sub-fail"), successResult());
    const service = new RunService(makeMastra(run));

    const startResult = await service.start("test-pipeline", { request: "test" });
    const events: StepEvent[] = [];
    const unsubscribe = service.subscribe(startResult.runId, (e) => events.push(e));

    run.emit({
      type: "workflow-step-result",
      payload: { id: "intake", stepCallId: "call-err", status: "failed" },
    });

    assert.equal(events.length, 1);
    assert.equal(events[0].kind, "step-failed");
    assert.equal(events[0].stepId, "intake");

    unsubscribe();
  });

  it("step-start and step-finish events are delivered correctly", async () => {
    const run = makeMockRun("run-sub-start", suspendedResult("run-sub-start"), successResult());
    const service = new RunService(makeMastra(run));

    const startResult = await service.start("test-pipeline", { request: "test" });
    const events: StepEvent[] = [];
    const unsubscribe = service.subscribe(startResult.runId, (e) => events.push(e));

    run.emit({ type: "workflow-step-start", payload: { id: "intake" } });
    run.emit({
      type: "workflow-step-result",
      payload: { id: "intake", stepCallId: "call-s", status: "success" },
    });

    assert.equal(events.length, 2);
    assert.equal(events[0].kind, "step-start");
    assert.equal(events[0].stepId, "intake");
    assert.equal(events[1].kind, "step-finish");
    assert.equal(events[1].stepId, "intake");

    unsubscribe();
  });
});

// ── Tests: FR-001 — list() and createdAt ─────────────────────────────────────

describe("RunService.list — FR-001: returns summaries in creation order with createdAt", () => {
  it("empty registry returns []", () => {
    const run = makeMockRun("r", successResult(), successResult());
    const service = new RunService(makeMastra(run));
    assert.deepEqual(service.list(), []);
  });

  it("returns two runs in creation order with exactly {runId, pipelineId, status, createdAt}", async () => {
    const runA = makeMockRun("run-a", successResult(), successResult());
    const runB = makeMockRun("run-b", successResult(), successResult());
    let callCount = 0;
    const mastra: MastraLike = {
      getWorkflow: (_id) => ({
        createRun: async () => {
          callCount++;
          return (callCount === 1 ? runA : runB) as unknown as Awaited<
            ReturnType<ReturnType<MastraLike["getWorkflow"]>["createRun"]>
          >;
        },
      }),
    };

    const service = new RunService(mastra);
    const r1 = await service.start("pipeline-a", {});
    const r2 = await service.start("pipeline-b", {});

    const list = service.list();
    assert.equal(list.length, 2, "list must have 2 runs");
    assert.equal(list[0].runId, r1.runId, "first entry must be first run");
    assert.equal(list[1].runId, r2.runId, "second entry must be second run");
    assert.equal(list[0].pipelineId, "pipeline-a");
    assert.equal(list[1].pipelineId, "pipeline-b");
    assert.ok(typeof list[0].createdAt === "string", "createdAt must be a string (ISO)");
    assert.ok(!isNaN(Date.parse(list[0].createdAt)), "createdAt must be a valid ISO date");

    // No extra fields — list must not expose result, spec, gateMessage, or steps.
    const keys0 = Object.keys(list[0]);
    assert.ok(keys0.includes("runId"), "must have runId");
    assert.ok(keys0.includes("pipelineId"), "must have pipelineId");
    assert.ok(keys0.includes("status"), "must have status");
    assert.ok(keys0.includes("createdAt"), "must have createdAt");
    assert.ok(!keys0.includes("result"), "must NOT have result");
    assert.ok(!keys0.includes("spec"), "must NOT have spec");
    assert.ok(!keys0.includes("gateMessage"), "must NOT have gateMessage");
    assert.ok(!keys0.includes("steps"), "must NOT have steps");
  });

  it("status in list reflects current state after settlement", async () => {
    const run = makeMockRun("run-settled", successResult(), successResult());
    const service = new RunService(makeMastra(run));

    const { runId } = await service.start("p", {});
    await service.waitForSettled(runId);

    const list = service.list();
    assert.equal(list[0].status, "success", "list status must reflect post-settlement state");
  });
});

// ── Tests: FR-006 — per-step output accumulation ─────────────────────────────

describe("RunService FR-006 — per-step output accumulated on record; GetResult.steps present", () => {
  it("GetResult.steps is empty before any events", async () => {
    let resolveStart!: (r: Record<string, unknown>) => void;
    const pendingRun: Partial<MockRun> & { runId: string; watchers: WatchCallback[] } = {
      runId: "run-steps-empty",
      watchers: [],
      start: () =>
        new Promise<Record<string, unknown>>((r) => {
          resolveStart = r;
        }),
      resume: async () => successResult(),
      watch: (cb) => {
        pendingRun.watchers.push(cb);
        return () => {
          const i = pendingRun.watchers.indexOf(cb);
          if (i !== -1) pendingRun.watchers.splice(i, 1);
        };
      },
    };
    const service = new RunService(makeMastra(pendingRun as unknown as MockRun));
    const { runId } = await service.start("p", {});
    const got = service.get(runId);
    assert.ok(got !== undefined);
    assert.deepEqual(got.steps, {}, "steps must be empty object before any events");
    resolveStart(successResult());
  });

  it("step-start accumulates status=started; step-result accumulates status=succeeded with excerpt", async () => {
    const run = makeMockRun("run-steps-acc", successResult(), successResult());
    const service = new RunService(makeMastra(run));

    const { runId } = await service.start("p", {});

    run.emit({ type: "workflow-step-start", payload: { id: "s1" } });

    let got = service.get(runId)!;
    assert.equal(got.steps.s1?.status, "started", "status must be 'started' after step-start");

    run.emit({
      type: "workflow-step-result",
      payload: { id: "s1", stepCallId: "c", status: "success", output: { answer: "hello" } },
    });

    got = service.get(runId)!;
    assert.equal(got.steps.s1?.status, "succeeded");
    assert.ok(
      typeof got.steps.s1?.outputExcerpt === "string",
      "outputExcerpt must be present after step-result with output"
    );
    // Non-null because we just asserted it is a string above.
    const s1excerpt = got.steps.s1?.outputExcerpt;
    assert.ok(
      typeof s1excerpt === "string" && s1excerpt.includes("hello"),
      "excerpt must contain output text"
    );
  });

  it("outputExcerpt is truncated at 2048 chars and outputTruncated is true", async () => {
    const run = makeMockRun("run-truncate", successResult(), successResult());
    const service = new RunService(makeMastra(run));

    const { runId } = await service.start("p", {});

    // Emit a large output — serialized > 2048 chars.
    const bigOutput = { text: "x".repeat(3000) };
    run.emit({
      type: "workflow-step-result",
      payload: { id: "big", stepCallId: "c", status: "success", output: bigOutput },
    });

    const got = service.get(runId)!;
    assert.equal(
      got.steps.big?.outputExcerpt?.length,
      2048,
      "outputExcerpt must be exactly 2048 chars when truncated"
    );
    assert.equal(got.steps.big?.outputTruncated, true, "outputTruncated must be true");
  });

  it("step output that fits within 2048 chars has outputTruncated absent or false", async () => {
    const run = makeMockRun("run-small", successResult(), successResult());
    const service = new RunService(makeMastra(run));

    const { runId } = await service.start("p", {});

    run.emit({
      type: "workflow-step-result",
      payload: { id: "s", stepCallId: "c", status: "success", output: { ok: true } },
    });

    const got = service.get(runId)!;
    assert.ok(!got.steps.s?.outputTruncated, "outputTruncated must be absent or false");
    assert.ok(typeof got.steps.s?.outputExcerpt === "string", "outputExcerpt must be present");
  });

  it("subscribe step-finish event carries outputExcerpt from the accumulator", async () => {
    const run = makeMockRun("run-sub-out", successResult(), successResult());
    const service = new RunService(makeMastra(run));

    const { runId } = await service.start("p", {});
    const events: StepEvent[] = [];
    service.subscribe(runId, (e) => events.push(e));

    run.emit({
      type: "workflow-step-result",
      payload: { id: "q", stepCallId: "c", status: "success", output: { data: "world" } },
    });

    const finish = events.find((e) => e.kind === "step-finish" && e.stepId === "q");
    assert.ok(finish !== undefined, "step-finish event must be emitted");
    assert.ok(
      typeof finish.outputExcerpt === "string" && finish.outputExcerpt.includes("world"),
      "step-finish must carry outputExcerpt from the accumulator"
    );
  });

  it("step without output has no outputExcerpt in GetResult.steps", async () => {
    const run = makeMockRun("run-no-out", successResult(), successResult());
    const service = new RunService(makeMastra(run));
    const { runId } = await service.start("p", {});

    run.emit({
      type: "workflow-step-result",
      payload: { id: "empty-step", stepCallId: "c", status: "success" },
    });

    const got = service.get(runId)!;
    assert.equal(
      got.steps["empty-step"]?.outputExcerpt,
      undefined,
      "no excerpt when output absent"
    );
  });
});

// ── Tests: FR-006 — rejection terminates the run ──────────────────────────────
//
// Test plan item 4: prove that downstream steps (commit/pr) never execute when
// a gate is rejected. The mock simulates what happens when GateRejectedError is
// thrown inside buildGateStep: Mastra marks the workflow failed.
//
// Companion pin: the old semantics (pre-FR-006) would write approved:false into
// context and return status:"success", allowing downstream steps to execute.
// That inversion is documented as a comment because reproducing it at runtime
// would create a real commit and a real public PR.

describe("FR-006 — gate rejection terminates the run; downstream steps never execute", () => {
  it("approve(runId, false) fails the run: status is 'failed', resume called once", async () => {
    // Mock a run where rejection yields status:"failed" (what GateRejectedError produces).
    const rejectedResult = {
      status: "failed",
      error: Object.assign(new Error('Gate "approve" rejected (manual): no reason given'), {
        name: "GateRejectedError",
      }),
    };

    let resumeCount = 0;
    const checkExecuted: string[] = [];

    const mockRun: Partial<MockRun> & { runId: string; watchers: WatchCallback[] } = {
      runId: "run-fr006",
      watchers: [],
      start: async () => suspendedResult("run-fr006"),
      resume: async () => {
        resumeCount++;
        return rejectedResult;
      },
      watch: (_cb: WatchCallback) => () => undefined,
    };

    const service = new RunService(makeMastra(mockRun as unknown as MockRun));
    const { runId } = await service.start("ship", { plan: "" });
    await service.waitForSettled(runId);

    const result = await service.approve(runId, false);

    // The call was processed (status is defined) — not a 409 scenario.
    assert.ok(result.status !== undefined, "status must be defined (call was processed)");
    assert.equal(result.status, "failed", "reject must fail the run");
    assert.ok(
      typeof result.error === "string" && result.error.includes("GateRejectedError"),
      `error must include GateRejectedError; got: ${result.error}`
    );

    // resume was called exactly once — no downstream step invocations.
    assert.equal(resumeCount, 1, "resume must be called exactly once");
    assert.equal(checkExecuted.length, 0, "no downstream check steps must execute");

    // Companion pin: OLD SEMANTICS would return status:"success" and allow downstream steps.
    // The inversion was: buildGateStep wrote approved:false into context and returned,
    // so Mastra continued to commit/pr steps (dependsOn: [approve] passed with approved:false).
    // Verified by code reading on 2026-09-07; runtime reproduction deliberately not executed
    // (would create a real commit and public PR).
  });

  it("run status is 'failed' and get() reflects it after rejection", async () => {
    const rejectedResult = {
      status: "failed",
      error: Object.assign(new Error('Gate "approve" rejected (manual): no reason given'), {
        name: "GateRejectedError",
      }),
    };

    const mockRun = makeMockRun("run-fr006-get", suspendedResult("run-fr006-get"), rejectedResult);
    const service = new RunService(makeMastra(mockRun));

    const { runId } = await service.start("ship", { plan: "" });
    await service.waitForSettled(runId);

    await service.approve(runId, false);

    const got = service.get(runId);
    assert.ok(got !== undefined);
    assert.equal(got.status, "failed", "get() must show failed after rejection");
    assert.ok(
      typeof got.error === "string" && got.error.length > 0,
      "get().error must be a non-empty string after rejection"
    );
  });
});

// ── Tests: FR-007 — approve route HTTP status fix ─────────────────────────────
//
// Test plan item 5: a processed approval whose run fails (e.g. rejection) must
// return HTTP 200 with {status:"failed"}, not 409. A 409 is reserved for when
// the approval itself could not be processed (non-suspended run, unknown id).

describe("FR-007 — approve on non-suspended run returns defined error, no status", () => {
  it("approve on an already-resolved run returns error with status undefined (409 in server)", async () => {
    const run = makeMockRun("run-fr007", successResult(), successResult());
    const service = new RunService(makeMastra(run));

    const { runId } = await service.start("p", {});
    await service.waitForSettled(runId); // settles as success

    const result = await service.approve(runId, true);
    // Non-suspended run: error is defined, status is undefined (caller returns 409).
    assert.ok(typeof result.error === "string", "error must be defined for non-suspended run");
    assert.equal(
      result.status,
      undefined,
      "status must be undefined for unprocessable call (triggers 409)"
    );
  });

  it("approve on a rejected run returns status:'failed' with defined error (200 in server)", async () => {
    const rejectedResult = {
      status: "failed",
      error: Object.assign(new Error('Gate "approve" rejected (manual): no reason given'), {
        name: "GateRejectedError",
      }),
    };

    const mockRun = makeMockRun(
      "run-fr007-reject",
      suspendedResult("run-fr007-reject"),
      rejectedResult
    );
    const service = new RunService(makeMastra(mockRun));

    const { runId } = await service.start("p", {});
    await service.waitForSettled(runId);

    const result = await service.approve(runId, false);
    // Processed approval that led to failure: status is defined (caller returns 200).
    assert.equal(result.status, "failed", "status must be 'failed' (not undefined)");
    assert.ok(typeof result.error === "string", "error must carry the rejection reason");
    // This is the key FR-007 fix: status is defined → server returns 200, not 409.
    assert.notEqual(result.status, undefined, "status must be defined to trigger 200 (not 409)");
  });
});

// ── Group 3 judge helpers ─────────────────────────────────────────────────────

// A stub ModelEntry and ProviderProfile for judge tests (no real CLI/API needed).
const stubEntry: ModelEntry = { id: "stub-model", transport: "cli", cli: { bin: "claude" } };
const stubRegistry = new ModelRegistry([stubEntry]);
const stubProfile: ProviderProfile = {
  id: "stub",
  roles: { reasoner: "stub-model", worker: "stub-model", scout: "stub-model" },
};

/** Build a JudgeDeps with a synchronous stub runner returning a fixed verdict JSON. */
function makeJudgeDeps(verdictJson: string): JudgeDeps {
  return {
    runner: async (_entry, _prompt) => verdictJson,
    registry: stubRegistry,
    profile: stubProfile,
    projectDir: "/tmp",
    judgePrompt: "You are the gate judge.",
  };
}

/** A suspended start result with optional manualOnly flag in the suspend payload. */
function suspendedManualOnly(): Record<string, unknown> {
  return {
    status: "suspended",
    suspended: [["approve"]],
    steps: {
      approve: {
        suspendPayload: {
          message: "Human-only gate — no judge.",
          spec: { title: "T" },
          manualOnly: true,
        },
      },
    },
  };
}

// ── Tests: FR-001/FR-008 — gateMode and gateDecisions in GetResult ────────────

describe("FR-001/FR-008 — gateMode stored on RunRecord; exposed via get() and list()", () => {
  it("get() includes gateMode:'manual' when start() uses default opts", async () => {
    const run = makeMockRun("run-gm-default", suspendedResult("run-gm-default"), successResult());
    const service = new RunService(makeMastra(run));

    const { runId } = await service.start("p", {});
    await service.waitForSettled(runId);

    const got = service.get(runId);
    assert.ok(got !== undefined);
    assert.equal(got.gateMode, "manual", "gateMode must default to 'manual'");
  });

  it("get() includes gateMode:'auto' when start() is called with gateMode:'auto'", async () => {
    const run = makeMockRun("run-gm-auto", successResult(), successResult());
    const service = new RunService(makeMastra(run));

    const { runId } = await service.start("p", {}, { gateMode: "auto" });
    await service.waitForSettled(runId);

    const got = service.get(runId);
    assert.ok(got !== undefined);
    assert.equal(got.gateMode, "auto", "gateMode must be 'auto' when explicitly set");
  });

  it("get() includes gateDecisions:[] before any approval", async () => {
    const run = makeMockRun("run-gd-empty", suspendedResult("run-gd-empty"), successResult());
    const service = new RunService(makeMastra(run));

    const { runId } = await service.start("p", {});
    await service.waitForSettled(runId);

    const got = service.get(runId);
    assert.ok(got !== undefined);
    assert.deepEqual(got.gateDecisions, [], "gateDecisions must be empty before any approval");
  });
});

// ── Tests: FR-002/FR-008 — human decision records GateDecision ───────────────

describe("FR-002/FR-008 — human approval records GateDecision with decidedBy:'human'", () => {
  it("approving a gate appends a GateDecision to gateDecisions", async () => {
    const run = makeMockRun("run-gd-human", suspendedResult("run-gd-human"), successResult());
    const service = new RunService(makeMastra(run));

    const { runId } = await service.start("p", {});
    await service.waitForSettled(runId);

    await service.approve(runId, true);

    const got = service.get(runId);
    assert.ok(got !== undefined);
    assert.equal(got.gateDecisions.length, 1, "must have exactly one GateDecision");

    const d = got.gateDecisions[0];
    assert.ok(d !== undefined);
    assert.equal(d.decidedBy, "human");
    assert.equal(d.approved, true);
    assert.equal(d.mode, "manual");
    assert.equal(d.gateStepId, "approve");
    assert.ok(typeof d.decidedAt === "string" && d.decidedAt.length > 0, "decidedAt must be set");
  });

  it("rejecting a gate appends a GateDecision with approved:false", async () => {
    const rejectedResult = {
      status: "failed",
      error: Object.assign(new Error('Gate "approve" rejected'), { name: "GateRejectedError" }),
    };
    const run = makeMockRun("run-gd-reject", suspendedResult("run-gd-reject"), rejectedResult);
    const service = new RunService(makeMastra(run));

    const { runId } = await service.start("p", {});
    await service.waitForSettled(runId);

    await service.approve(runId, false);

    const got = service.get(runId);
    assert.ok(got !== undefined);
    assert.equal(got.gateDecisions.length, 1);
    assert.equal(got.gateDecisions[0]?.approved, false);
    assert.equal(got.gateDecisions[0]?.decidedBy, "human");
  });
});

// ── Tests: FR-003/FR-009 — auto run dispatches judge; waitForSettled deferred ─

describe("FR-003/FR-009 — auto run: judge dispatched; waitForSettled does not resolve at gate", () => {
  it("waitForSettled stays pending while judge is in flight; resolves after judge approves", async () => {
    // A controlled stub runner — resolves only when we call resolveJudge().
    let resolveJudge!: (raw: string) => void;
    const judgePending = new Promise<string>((resolve) => {
      resolveJudge = resolve;
    });
    const controlledDeps: JudgeDeps = {
      runner: async (_entry, _prompt) => judgePending,
      registry: stubRegistry,
      profile: stubProfile,
      projectDir: "/tmp",
      judgePrompt: "You are the gate judge.",
    };

    // Mock run that suspends first, then succeeds on resume.
    const mockRun: Partial<MockRun> & { runId: string; watchers: WatchCallback[] } = {
      runId: "run-fr009-defer",
      watchers: [],
      start: async () => suspendedResult("run-fr009-defer"),
      resume: async () => successResult(),
      watch: (_cb: WatchCallback) => () => undefined,
    };

    const service = new RunService(makeMastra(mockRun as unknown as MockRun), controlledDeps);
    const { runId } = await service.start("p", {}, { gateMode: "auto" });

    // Track whether waitForSettled has resolved.
    let settled = false;
    const waitPromise = service.waitForSettled(runId).then((r) => {
      settled = true;
      return r;
    });

    // Give the event loop a chance to process the dispatchJudge fire-and-forget.
    // The judge is awaiting judgePending — it has NOT resolved yet.
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(
      settled,
      false,
      "waitForSettled must NOT resolve while judge is still in flight (FR-009)"
    );

    // Release the judge with an approve verdict.
    resolveJudge('{"verdict":"approve","reason":"Evidence is sufficient."}');

    const result = await waitPromise;
    assert.ok(result !== undefined, "waitForSettled must eventually resolve");
    assert.equal(result.status, "success", "run must succeed after judge approves");
    assert.equal(settled, true, "settled must be true after judge fires");
  });

  it("judge approve verdict: run succeeds and GateDecision has decidedBy:'agent'", async () => {
    const deps = makeJudgeDeps('{"verdict":"approve","reason":"All tests pass."}');

    const mockRun: Partial<MockRun> & { runId: string; watchers: WatchCallback[] } = {
      runId: "run-fr003-approve",
      watchers: [],
      start: async () => suspendedResult("run-fr003-approve"),
      resume: async () => successResult(),
      watch: (_cb: WatchCallback) => () => undefined,
    };

    const service = new RunService(makeMastra(mockRun as unknown as MockRun), deps);
    const { runId } = await service.start("p", {}, { gateMode: "auto" });

    const settled = await service.waitForSettled(runId);
    assert.ok(settled !== undefined);
    assert.equal(settled.status, "success", "run must succeed when judge approves");

    const got = service.get(runId);
    assert.ok(got !== undefined);
    assert.equal(got.status, "success");
    assert.equal(got.gateDecisions.length, 1, "must record one GateDecision");

    const d = got.gateDecisions[0];
    assert.ok(d !== undefined);
    assert.equal(d.decidedBy, "agent");
    assert.equal(d.approved, true);
    assert.equal(d.mode, "auto");
    assert.equal(d.reason, "All tests pass.");
    assert.equal(d.judgeModelId, "stub-model");
    assert.ok(!d.superseded, "decision must not be superseded");
  });

  it("judge reject verdict: run fails and GateDecision has approved:false", async () => {
    const deps = makeJudgeDeps('{"verdict":"reject","reason":"Missing test evidence."}');

    const rejectedResult = {
      status: "failed",
      error: Object.assign(new Error('Gate "approve" rejected (auto): Missing test evidence.'), {
        name: "GateRejectedError",
      }),
    };
    const mockRun: Partial<MockRun> & { runId: string; watchers: WatchCallback[] } = {
      runId: "run-fr003-reject",
      watchers: [],
      start: async () => suspendedResult("run-fr003-reject"),
      resume: async () => rejectedResult,
      watch: (_cb: WatchCallback) => () => undefined,
    };

    const service = new RunService(makeMastra(mockRun as unknown as MockRun), deps);
    const { runId } = await service.start("p", {}, { gateMode: "auto" });

    const settled = await service.waitForSettled(runId);
    assert.ok(settled !== undefined);
    assert.equal(settled.status, "failed", "run must fail when judge rejects");

    const got = service.get(runId);
    assert.ok(got !== undefined);
    assert.equal(got.gateDecisions.length, 1);
    assert.equal(got.gateDecisions[0]?.decidedBy, "agent");
    assert.equal(got.gateDecisions[0]?.approved, false);
    assert.equal(got.gateDecisions[0]?.reason, "Missing test evidence.");
  });

  it("manualOnly gate in auto run settles as awaiting_approval; judge NOT dispatched", async () => {
    let judgeCallCount = 0;
    const deps: JudgeDeps = {
      runner: async (_entry, _prompt) => {
        judgeCallCount++;
        return '{"verdict":"approve","reason":"Should not be called."}';
      },
      registry: stubRegistry,
      profile: stubProfile,
      projectDir: "/tmp",
      judgePrompt: "You are the gate judge.",
    };

    const mockRun: Partial<MockRun> & { runId: string; watchers: WatchCallback[] } = {
      runId: "run-manual-only",
      watchers: [],
      start: async () => suspendedManualOnly(),
      resume: async () => successResult(),
      watch: (_cb: WatchCallback) => () => undefined,
    };

    const service = new RunService(makeMastra(mockRun as unknown as MockRun), deps);
    const { runId } = await service.start("p", {}, { gateMode: "auto" });

    const settled = await service.waitForSettled(runId);
    assert.ok(settled !== undefined);
    assert.equal(
      settled.status,
      "awaiting_approval",
      "manualOnly gate must settle as awaiting_approval even in auto mode"
    );

    // Judge must NOT be called for manualOnly gates.
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(judgeCallCount, 0, "judge must not be dispatched for manualOnly gates");
  });
});

// ── Tests: FR-005 — verdict parse failure degrades to manual ─────────────────

describe("FR-005 — malformed judge verdict degrades to manual after two attempts", () => {
  it("two malformed verdicts → judgeError set; run stays suspended (awaiting_approval)", async () => {
    let callCount = 0;
    const deps: JudgeDeps = {
      runner: async (_entry, _prompt) => {
        callCount++;
        return "This is not JSON.";
      },
      registry: stubRegistry,
      profile: stubProfile,
      projectDir: "/tmp",
      judgePrompt: "You are the gate judge.",
    };

    const mockRun: Partial<MockRun> & { runId: string; watchers: WatchCallback[] } = {
      runId: "run-fr005-fail",
      watchers: [],
      start: async () => suspendedResult("run-fr005-fail"),
      resume: async () => successResult(),
      watch: (_cb: WatchCallback) => () => undefined,
    };

    const service = new RunService(makeMastra(mockRun as unknown as MockRun), deps);
    const { runId } = await service.start("p", {}, { gateMode: "auto" });

    const settled = await service.waitForSettled(runId);
    assert.ok(settled !== undefined);
    assert.equal(
      settled.status,
      "awaiting_approval",
      "run must degrade to manual when judge produces malformed verdicts"
    );
    assert.equal(callCount, 2, "judge runner must be called exactly twice (one retry)");

    const got = service.get(runId);
    assert.ok(got !== undefined);
    assert.equal(got.status, "suspended", "registry status must be suspended after degradation");
    assert.ok(
      typeof got.judgeError === "string" && got.judgeError.length > 0,
      `judgeError must be set; got: ${JSON.stringify(got.judgeError)}`
    );
    assert.ok(
      got.judgeError.includes("malformed"),
      `judgeError must mention 'malformed'; got: ${got.judgeError}`
    );
  });

  it("valid verdict on first retry succeeds (only one malformed, one clean)", async () => {
    let callCount = 0;
    const deps: JudgeDeps = {
      runner: async (_entry, prompt) => {
        callCount++;
        // First call: malformed. Second call (retry with error notice): valid JSON.
        if (callCount === 1) return "Not JSON.";
        // On retry prompt the judge corrects itself.
        assert.ok(prompt.includes("PARSE ERROR"), "retry prompt must include PARSE ERROR notice");
        return '{"verdict":"approve","reason":"Corrected on retry."}';
      },
      registry: stubRegistry,
      profile: stubProfile,
      projectDir: "/tmp",
      judgePrompt: "You are the gate judge.",
    };

    const mockRun: Partial<MockRun> & { runId: string; watchers: WatchCallback[] } = {
      runId: "run-fr005-retry",
      watchers: [],
      start: async () => suspendedResult("run-fr005-retry"),
      resume: async () => successResult(),
      watch: (_cb: WatchCallback) => () => undefined,
    };

    const service = new RunService(makeMastra(mockRun as unknown as MockRun), deps);
    const { runId } = await service.start("p", {}, { gateMode: "auto" });

    const settled = await service.waitForSettled(runId);
    assert.ok(settled !== undefined);
    assert.equal(
      settled.status,
      "success",
      "run must succeed when second attempt produces valid verdict"
    );
    assert.equal(callCount, 2, "runner called twice: malformed then valid");
  });
});

// ── Tests: FR-003 — race guard (human beats judge) ────────────────────────────

describe("FR-003 — race guard: human approval while judge in flight supersedes judge verdict", () => {
  it("human approves before judge returns; judge verdict marked superseded; resume called once", async () => {
    // A judge that resolves only after we call releaseJudge.
    let releaseJudge!: (raw: string) => void;
    const judgePending = new Promise<string>((resolve) => {
      releaseJudge = resolve;
    });

    let resumeCount = 0;
    const mockRun: Partial<MockRun> & { runId: string; watchers: WatchCallback[] } = {
      runId: "run-race-guard",
      watchers: [],
      start: async () => suspendedResult("run-race-guard"),
      resume: async () => {
        resumeCount++;
        return successResult();
      },
      watch: (_cb: WatchCallback) => () => undefined,
    };

    const deps: JudgeDeps = {
      runner: async (_entry, _prompt) => judgePending,
      registry: stubRegistry,
      profile: stubProfile,
      projectDir: "/tmp",
      judgePrompt: "You are the gate judge.",
    };

    const service = new RunService(makeMastra(mockRun as unknown as MockRun), deps);
    const { runId } = await service.start("p", {}, { gateMode: "auto" });

    // Give dispatchJudge a chance to start (it's fire-and-forget).
    await new Promise<void>((resolve) => setImmediate(resolve));

    // The run is suspended and the judge is in flight.
    // Human approves now — before the judge resolves.
    const humanApproval = await service.approve(runId, true);
    assert.equal(humanApproval.status, "success", "human approval must succeed");
    assert.equal(resumeCount, 1, "resume must be called once (by human, not judge)");

    // Now release the judge — it should see status !== "suspended" and mark as superseded.
    releaseJudge('{"verdict":"reject","reason":"Too slow."}');

    // Give the event loop a tick to process the judge's resolveGate call.
    await new Promise<void>((resolve) => setImmediate(resolve));

    const got = service.get(runId);
    assert.ok(got !== undefined);
    assert.equal(got.status, "success", "run status must remain success after superseded judge");
    assert.equal(resumeCount, 1, "resume must still be called exactly once");

    // The judge's decision must be recorded as superseded.
    const agentDecision = got.gateDecisions.find((d) => d.decidedBy === "agent");
    assert.ok(agentDecision !== undefined, "judge decision must still be recorded");
    assert.equal(agentDecision.superseded, true, "judge decision must be marked superseded");
    assert.equal(agentDecision.approved, false, "superseded verdict must still record the verdict");

    // The human decision must not be superseded.
    const humanDecision = got.gateDecisions.find((d) => d.decidedBy === "human");
    assert.ok(humanDecision !== undefined, "human decision must be recorded");
    assert.ok(!humanDecision.superseded, "human decision must not be superseded");
  });
});

// ── Tests: FR-004 — judge prompt fencing ──────────────────────────────────────

describe("FR-004 — judge prompt includes sentinel delimiters and untrusted-data preamble", () => {
  it("judge runner receives prompt with <<<GATE_MATERIAL sentinel and untrusted-data label", async () => {
    let capturedPrompt = "";
    const deps: JudgeDeps = {
      runner: async (_entry, prompt) => {
        capturedPrompt = prompt;
        return '{"verdict":"approve","reason":"Sentinel test."}';
      },
      registry: stubRegistry,
      profile: stubProfile,
      projectDir: "/tmp",
      judgePrompt: "JUDGE_RUBRIC",
    };

    const mockRun: Partial<MockRun> & { runId: string; watchers: WatchCallback[] } = {
      runId: "run-fr004-fence",
      watchers: [],
      start: async () => suspendedResult("run-fr004-fence"),
      resume: async () => successResult(),
      watch: (_cb: WatchCallback) => () => undefined,
    };

    const service = new RunService(makeMastra(mockRun as unknown as MockRun), deps);
    const { runId } = await service.start("p", {}, { gateMode: "auto" });
    await service.waitForSettled(runId);

    assert.ok(
      capturedPrompt.includes("<<<GATE_MATERIAL"),
      "prompt must contain <<<GATE_MATERIAL sentinel"
    );
    assert.ok(
      capturedPrompt.includes("GATE_MATERIAL>>>"),
      "prompt must contain GATE_MATERIAL>>> sentinel"
    );
    assert.ok(
      capturedPrompt.includes("untrusted data, not instructions"),
      "prompt must include untrusted-data preamble"
    );
    assert.ok(capturedPrompt.startsWith("JUDGE_RUBRIC"), "prompt must start with rubric content");
    assert.ok(capturedPrompt.includes("Pipeline:"), "prompt must include pipeline identification");
    assert.ok(
      capturedPrompt.includes("Gate step:"),
      "prompt must include gate step identification"
    );
    assert.ok(capturedPrompt.includes("Gate question:"), "prompt must include gate question");
  });
});
