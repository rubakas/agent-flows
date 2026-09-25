// Tests for the one Mastra-stream -> step-transition translation.
//
// A table, because the value of extracting this function is that there is now
// exactly one place where "what does status X mean" is answered, and a table is
// the shape that makes a missing answer visible.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { UnknownStepStatusError, stepTransitionOf } from "./stepTransition.js";
import type { StepStreamEvent, StepTransition } from "./stepTransition.js";

const TABLE: { event: StepStreamEvent; expected: StepTransition | undefined }[] = [
  { event: { type: "workflow-step-start" }, expected: "step-start" },
  { event: { type: "workflow-step-suspended" }, expected: "step-suspended" },
  { event: { type: "workflow-step-result", status: "success" }, expected: "step-finish" },
  { event: { type: "workflow-step-result", status: "skipped" }, expected: "step-finish" },
  { event: { type: "workflow-step-result", status: "suspended" }, expected: "step-suspended" },
  { event: { type: "workflow-step-result", status: "failed" }, expected: "step-failed" },
  { event: { type: "workflow-start" }, expected: undefined },
  { event: { type: "workflow-finish" }, expected: undefined },
  { event: { type: "workflow-step-output" }, expected: undefined },
];

describe("stepTransitionOf — the single stream translation", () => {
  it("maps every event this project has seen", () => {
    assert.deepEqual(
      TABLE.map((row) => stepTransitionOf(row.event)),
      TABLE.map((row) => row.expected)
    );
  });

  it("throws on an unrecognised step-result status rather than returning undefined", () => {
    // The failure this guards: Mastra renames a status, the mapping silently
    // returns undefined, and every step of every run stops being reported as
    // finished while the runs themselves carry on.
    for (const status of ["done", "aborted", undefined, 7]) {
      assert.throws(
        () => stepTransitionOf({ type: "workflow-step-result", status }),
        UnknownStepStatusError,
        `status ${JSON.stringify(status)} must be loud, not silently unmapped`
      );
    }
  });

  it("names the offending status in the error, so the fix is obvious", () => {
    assert.throws(() => stepTransitionOf({ type: "workflow-step-result", status: "done" }), {
      message: /"done"/u,
    });
  });
});
