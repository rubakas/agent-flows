// Spec 042 D11 — when an auto-started daemon is allowed to reap itself.
//
// The three refusals are the load-bearing half: a human's daemon is never
// touched, a daemon carrying work is never touched, and a run left waiting at a
// gate counts as work, because exiting under it strands an approval nobody can
// give.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { countInFlight, DEFAULT_IDLE_MS, shouldExitWhenIdle } from "./idleShutdown.js";

const IDLE = DEFAULT_IDLE_MS;

function inputs(over: Partial<Parameters<typeof shouldExitWhenIdle>[0]> = {}) {
  return {
    autostarted: true,
    msSinceLastRequest: IDLE + 1,
    inFlight: 0,
    idleMs: IDLE,
    ...over,
  };
}

describe("shouldExitWhenIdle — an auto-started daemon reaps itself, nothing else does", () => {
  it("exits when auto-started, quiet past the span, and carrying nothing", () => {
    assert.equal(shouldExitWhenIdle(inputs()), true);
  });

  it("never exits a daemon a human started, however long it has been quiet", () => {
    assert.equal(
      shouldExitWhenIdle(inputs({ autostarted: false, msSinceLastRequest: IDLE * 1000 })),
      false,
      "`agent-flows serve` has an owner who expects it to stay up"
    );
  });

  it("never exits while a run is executing", () => {
    assert.equal(shouldExitWhenIdle(inputs({ inFlight: 1 })), false);
  });

  it("stays alive below the span", () => {
    assert.equal(shouldExitWhenIdle(inputs({ msSinceLastRequest: IDLE - 1 })), false);
  });

  it("exits exactly at the span, not one tick later", () => {
    assert.equal(shouldExitWhenIdle(inputs({ msSinceLastRequest: IDLE })), true);
  });
});

describe("countInFlight — what counts as work worth staying alive for", () => {
  it("counts a live running run", () => {
    assert.equal(countInFlight([{ status: "running", source: "live" }]), 1);
  });

  it("counts a run suspended at a gate — exiting would strand the approval", () => {
    assert.equal(countInFlight([{ status: "awaiting_approval", source: "live" }]), 1);
  });

  it("ignores a run persisted as running by a process that died", () => {
    assert.equal(
      countInFlight([{ status: "running", source: "disk" }]),
      0,
      "an old crash must not pin every future daemon for this project open"
    );
  });

  it("ignores settled runs", () => {
    assert.equal(
      countInFlight([
        { status: "succeeded", source: "live" },
        { status: "failed", source: "live" },
        { status: "cancelled", source: "live" },
        { status: "rejected", source: "live" },
      ]),
      0
    );
  });
});
