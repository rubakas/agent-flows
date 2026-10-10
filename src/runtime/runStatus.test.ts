// Spec 047 FR-11 — the status vocabulary every reader shares.
//
// Each predicate is pinned against the behaviour it replaced: the MCP poll loop's
// terminal set, the idle self-exit's in-flight rule, the artifact handoff's
// accepted statuses and the daemon-down fallback's "orphaned" rule.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { hasStopped, isChainable, isInFlight, runPhase } from "./runStatus.js";

describe("hasStopped — the MCP poll loop's exit", () => {
  it("is true at a gate and at every settled status; cancelled included (spec 033 FR-010)", () => {
    for (const status of ["awaiting_approval", "succeeded", "rejected", "failed", "cancelled"]) {
      assert.equal(hasStopped(status), true, status);
    }
  });

  it("is true for an unreadable run: its artifact will not parse, so nothing will advance it", () => {
    assert.equal(hasStopped("unreadable"), true);
  });

  it("is false while the run is executing, and for a status nobody knows", () => {
    assert.equal(hasStopped("running"), false);
    assert.equal(hasStopped("martian"), false);
  });
});

describe("isInFlight — what keeps an auto-started daemon alive", () => {
  it("counts live running and live awaiting runs only", () => {
    assert.equal(isInFlight({ status: "running", source: "live" }), true);
    assert.equal(isInFlight({ status: "awaiting_approval", source: "live" }), true);
    assert.equal(isInFlight({ status: "running", source: "disk" }), false);
    assert.equal(isInFlight({ status: "awaiting_approval", source: "disk" }), false);
    assert.equal(isInFlight({ status: "succeeded", source: "live" }), false);
  });
});

describe("isChainable — which artifacts may seed a following stage", () => {
  it("accepts exactly succeeded, awaiting_approval, failed and rejected", () => {
    for (const status of ["succeeded", "awaiting_approval", "failed", "rejected"]) {
      assert.equal(isChainable(status), true, status);
    }
    for (const status of ["running", "cancelled", "unreadable", "martian"]) {
      assert.equal(isChainable(status), false, status);
    }
  });
});

describe("runPhase — what a reader may conclude", () => {
  it("a live run is live or awaiting", () => {
    assert.equal(runPhase({ status: "running", source: "live" }), "live");
    assert.equal(runPhase({ status: "awaiting_approval", source: "live" }), "awaiting");
  });

  it("a disk run claiming to be in flight is restored with a daemon up, orphaned without", () => {
    for (const status of ["running", "awaiting_approval"]) {
      assert.equal(runPhase({ status, source: "disk" }), "restored", status);
      assert.equal(runPhase({ status, source: "disk" }, true), "restored", status);
      assert.equal(runPhase({ status, source: "disk" }, false), "orphaned", status);
    }
  });

  it("a settled run is terminal wherever it came from", () => {
    for (const status of ["succeeded", "rejected", "failed", "cancelled"]) {
      assert.equal(runPhase({ status, source: "live" }), "terminal", status);
      assert.equal(runPhase({ status, source: "disk" }, false), "terminal", status);
    }
  });

  it("an unparseable artifact is unreadable", () => {
    assert.equal(runPhase({ status: "unreadable", source: "disk" }), "unreadable");
  });
});
