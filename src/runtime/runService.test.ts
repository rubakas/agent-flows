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

// ── Tests: start / get ────────────────────────────────────────────────────────

describe("RunService.start — run reaches gate, get reports suspended", () => {
  it("start returns awaiting_approval with runId, get returns suspended", async () => {
    const mockRunId = "mastra-run-abc123";
    const run = makeMockRun(mockRunId, suspendedResult(mockRunId), successResult());
    const service = new RunService(makeMastra(run));

    const result = await service.start("test-pipeline", { request: "test" });

    assert.equal(result.status, "awaiting_approval");
    // Run id is Mastra's own id — not a locally-minted UUID.
    assert.equal(result.runId, mockRunId, "runId must be Mastra's own run id");
    assert.ok(result.gateMessage, "gateMessage should be set");
    assert.ok(result.spec, "spec should be set");

    const got = service.get(result.runId);
    assert.ok(got !== undefined, "get should find the run");
    assert.equal(got.status, "suspended");
    assert.equal(got.pipelineId, "test-pipeline");
  });

  it("start returns success when workflow completes without a gate", async () => {
    const run = makeMockRun("run-direct", successResult(), successResult());
    const service = new RunService(makeMastra(run));

    const result = await service.start("test-pipeline", { request: "test" });

    assert.equal(result.status, "success");
    assert.equal(result.runId, "run-direct");

    const got = service.get(result.runId);
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

    const start = await service.start("test-pipeline", { request: "test" });
    assert.equal(start.status, "awaiting_approval");

    const approval = await service.approve(start.runId, true);
    assert.equal(approval.error, undefined, "approve should not return an error");
    assert.equal(approval.status, "success");

    const got = service.get(start.runId);
    assert.ok(got !== undefined);
    assert.equal(got.status, "success");
  });
});

// ── Tests: approve — defined error on resolved run ────────────────────────────

describe("RunService.approve — second approve returns defined error", () => {
  it("returns error when run is already resolved", async () => {
    const run = makeMockRun("run-resolved", suspendedResult("run-resolved"), successResult());
    const service = new RunService(makeMastra(run));

    const start = await service.start("test-pipeline", { request: "test" });

    const first = await service.approve(start.runId, true);
    assert.equal(first.error, undefined, "first approve must succeed");
    assert.equal(first.status, "success");

    // Second approve on an already-resolved run must return a defined error.
    const second = await service.approve(start.runId, true);
    assert.ok(typeof second.error === "string", "second approve must return an error string");
    assert.ok(second.error.includes(start.runId), "error should name the run id");
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
    const start = await service.start("test-pipeline", { request: "test" });
    assert.equal(start.status, "awaiting_approval");

    // Both approve calls are started without awaiting the first.
    const [r1, r2] = await Promise.all([
      service.approve(start.runId, true),
      service.approve(start.runId, true),
    ]);

    const successes = [r1, r2].filter((r) => r.status === "success" && r.error === undefined);
    const errors = [r1, r2].filter((r) => typeof r.error === "string");

    assert.equal(successes.length, 1, "exactly one approve must succeed");
    assert.equal(errors.length, 1, "exactly one approve must return an error");
    assert.equal(resumeCount, 1, "run.resume must be called exactly once");
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

    const start = await service.start("test-pipeline", { request: "test" });
    assert.equal(start.status, "awaiting_approval");

    const events: StepEvent[] = [];
    const unsubscribe = service.subscribe(start.runId, (e) => events.push(e));

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

    const start = await service.start("test-pipeline", { request: "test" });
    const events: StepEvent[] = [];
    const unsubscribe = service.subscribe(start.runId, (e) => events.push(e));

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

    const start = await service.start("test-pipeline", { request: "test" });
    const events: StepEvent[] = [];
    const unsubscribe = service.subscribe(start.runId, (e) => events.push(e));

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
