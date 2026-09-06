// Tests for RunService.
//
// Uses pure mock MastraLike objects rather than a real Mastra instance so that
// the test file never imports @mastra/core deep-subpath exports, which cause
// eslint-plugin-import-x@4.17.1 to crash. Real Mastra integration (suspend /
// resume / LibSQL snapshots) is covered by build.test.ts.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RunService } from "./runService.js";
import type { MastraLike, StepEvent } from "./runService.js";

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

    unsubscribe();
    assert.equal(run.watchers.length, 0, "unsubscribe must remove the listener");
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
