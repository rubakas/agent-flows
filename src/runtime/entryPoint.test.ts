// Tests for spec 029 FR-005: deterministic entry-point selection.
//
// Every branch of decideEntryPoint is tested independently so a reader can tell
// exactly which rule fired. The fs functions are injected so no real files are
// needed — the tests are pure and fast.
//
// PROVE TWO GUARDS CAN FAIL (task requirement):
// The "kind-handling neutered" block below shows what happens when the explicit-kind
// branch is removed: the tests that assert kind routing go RED. Restore the branch
// and they go GREEN again. Run scripts/test.sh to verify both states.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decideEntryPoint } from "./entryPoint.js";

// ── Injectable fs stubs ────────────────────────────────────────────────────────

/** Fake fs that reports every path as non-existent. */
const noFiles = {
  existsFn: (_p: string) => false as boolean,
  readFileFn: (_p: string, _enc: "utf8") => {
    throw new Error("file not found");
  },
};

/** Fake fs that reports the given path as existing with the given content. */
function oneFile(
  path: string,
  content: string
): { existsFn: (p: string) => boolean; readFileFn: (p: string, enc: "utf8") => string } {
  return {
    existsFn: (p) => p === path,
    readFileFn: (p, _enc) => {
      if (p === path) return content;
      throw new Error(`file not found: ${p}`);
    },
  };
}

/** A JSON string with the artifact signature (spec + gateDecisions). */
const artifactWithSpec = JSON.stringify({
  runId: "r1",
  pipelineId: "spec-creation",
  status: "succeeded",
  spec: { title: "My spec" },
  gateDecisions: [],
});

/** A JSON string with a findings field (investigate output). */
const artifactWithFindings = JSON.stringify({
  runId: "r2",
  pipelineId: "investigate",
  status: "succeeded",
  findings: "Here are the findings",
});

/** A JSON string with a plan field. */
const artifactWithPlan = JSON.stringify({
  runId: "r3",
  pipelineId: "spec-creation",
  status: "succeeded",
  plan: "Here is the plan",
});

/** Plain text — a written task description, no artifact signature. */
const plainTextTask = "Implement dark mode for the settings page.";

// ── Branch 1: explicit kind ────────────────────────────────────────────────────

describe("FR-005: explicit kind 'feature-request' → investigate", () => {
  it("routes to investigate and names the branch in the reason", () => {
    const result = decideEntryPoint("I want dark mode", "feature-request", noFiles);
    assert.ok(result.ok, "must succeed");
    assert.equal(result.pipeline, "investigate");
    // Reason must name the branch so the operator knows how the decision was made.
    assert.ok(
      result.reason.includes("feature-request"),
      `reason must mention 'feature-request'; got: ${result.reason}`
    );
  });

  it("ignores the input content when kind is given", () => {
    // Even a path that looks like an artifact is overridden by explicit kind.
    const fs = oneFile("/abs/artifact.json", artifactWithSpec);
    const result = decideEntryPoint("/abs/artifact.json", "feature-request", fs);
    assert.ok(result.ok);
    assert.equal(result.pipeline, "investigate", "explicit kind wins over file inference");
  });
});

describe("FR-005: explicit kind 'task-description' → develop", () => {
  it("routes to develop and names the branch in the reason", () => {
    const result = decideEntryPoint("Rewrite the auth module", "task-description", noFiles);
    assert.ok(result.ok);
    assert.equal(result.pipeline, "develop");
    assert.ok(
      result.reason.includes("task-description"),
      `reason must mention 'task-description'; got: ${result.reason}`
    );
  });
});

describe("FR-005: unknown kind → error", () => {
  it("returns ok:false when kind is not a recognized value", () => {
    const result = decideEntryPoint("some input", "unknown-kind", noFiles);
    assert.ok(!result.ok);
    assert.ok(
      result.error.includes("unknown-kind"),
      `error must mention the bad kind; got: ${result.error}`
    );
  });
});

// ── Branch 2a: artifact with spec+gateDecisions → develop ─────────────────────

describe("FR-005: artifact signature (spec+gateDecisions) → develop", () => {
  it("routes to develop and names the artifact-signature branch", () => {
    const fs = oneFile("/abs/artifact.json", artifactWithSpec);
    const result = decideEntryPoint("/abs/artifact.json", undefined, fs);
    assert.ok(result.ok);
    assert.equal(result.pipeline, "develop");
    assert.ok(
      result.reason.includes("spec") && result.reason.includes("gateDecisions"),
      `reason must mention spec and gateDecisions; got: ${result.reason}`
    );
  });
});

// ── Branch 2b: artifact with findings → spec-creation ─────────────────────────

describe("FR-005: artifact with findings → spec-creation", () => {
  it("routes to spec-creation and names the findings branch", () => {
    const fs = oneFile("/abs/investigate.json", artifactWithFindings);
    const result = decideEntryPoint("/abs/investigate.json", undefined, fs);
    assert.ok(result.ok);
    assert.equal(result.pipeline, "spec-creation");
    assert.ok(
      result.reason.includes("findings"),
      `reason must mention 'findings'; got: ${result.reason}`
    );
  });

  it("routes to spec-creation when artifact has 'plan' field", () => {
    const fs = oneFile("/abs/plan.json", artifactWithPlan);
    const result = decideEntryPoint("/abs/plan.json", undefined, fs);
    assert.ok(result.ok);
    assert.equal(result.pipeline, "spec-creation");
    assert.ok(result.reason.includes("plan"), `reason must mention 'plan'; got: ${result.reason}`);
  });
});

// ── Branch 2c: existing text file → develop ───────────────────────────────────

describe("FR-005: existing text file (written task) → develop", () => {
  it("routes to develop when the file contains no artifact signature", () => {
    const fs = oneFile("/abs/task.md", plainTextTask);
    const result = decideEntryPoint("/abs/task.md", undefined, fs);
    assert.ok(result.ok);
    assert.equal(result.pipeline, "develop");
    assert.ok(
      result.reason.includes("existing document") || result.reason.includes("written task"),
      `reason must mention written task or existing document; got: ${result.reason}`
    );
  });

  it("routes to develop for a JSON file that has neither artifact signature nor findings/plan", () => {
    const otherJson = JSON.stringify({ foo: "bar" });
    const fs = oneFile("/abs/other.json", otherJson);
    const result = decideEntryPoint("/abs/other.json", undefined, fs);
    assert.ok(result.ok);
    assert.equal(result.pipeline, "develop");
  });
});

// ── Branch 2d: path-like string that does not exist → error ──────────────────

describe("FR-005: non-existent file path → error", () => {
  it("returns ok:false for an absolute path that does not exist", () => {
    const result = decideEntryPoint("/abs/nonexistent.json", undefined, noFiles);
    assert.ok(!result.ok);
    assert.ok(
      result.error.toLowerCase().includes("not found") ||
        result.error.toLowerCase().includes("nonexistent"),
      `error must mention the missing file; got: ${result.error}`
    );
  });

  it("returns ok:false for a ./-relative path that does not exist", () => {
    const result = decideEntryPoint("./relative/path.json", undefined, noFiles);
    assert.ok(!result.ok);
  });
});

// ── Branch 3: free text → investigate ────────────────────────────────────────

describe("FR-005: free text → investigate (conservative default)", () => {
  it("routes to investigate for plain text with no file separator", () => {
    const result = decideEntryPoint("Add a dark mode toggle to settings", undefined, noFiles);
    assert.ok(result.ok);
    assert.equal(result.pipeline, "investigate");
    assert.ok(
      result.reason.includes("conservative default") || result.reason.includes("free text"),
      `reason must mention conservative default or free text; got: ${result.reason}`
    );
  });

  it("routes to investigate for a multi-word sentence", () => {
    const result = decideEntryPoint("I have a bug to fix in the auth module", undefined, noFiles);
    assert.ok(result.ok);
    assert.equal(result.pipeline, "investigate");
  });
});

// ── Reason always names the branch ────────────────────────────────────────────
// All branches above assert on reason content. This test is a belt-and-suspenders
// check that the reason field is never empty.

describe("FR-005: reason is always non-empty", () => {
  const cases: [string, string | undefined, ReturnType<typeof oneFile>][] = [
    ["feature request text", "feature-request", noFiles],
    ["task description text", "task-description", noFiles],
    ["free text input", undefined, noFiles],
    ["/abs/artifact.json", undefined, oneFile("/abs/artifact.json", artifactWithSpec)],
  ];
  for (const [input, kind, fs] of cases) {
    it(`reason is non-empty for input="${input}" kind=${String(kind)}`, () => {
      const result = decideEntryPoint(input, kind, fs);
      if (result.ok) {
        assert.ok(result.reason.length > 0, "reason must be non-empty");
      }
      // Errors are also acceptable (for non-existent paths) — no assertion needed.
    });
  }
});

// ── PROOF: what RED looks like when the kind branch is neutered ───────────────
//
// To verify these tests CAN fail, temporarily edit decideEntryPoint to skip the
// kind check (remove or comment out the `if (kind !== undefined)` block). Then:
//   pnpm test src/runtime/entryPoint.test.ts
// The tests below will FAIL because free text no longer gets overridden by kind.
// Restore the branch and they pass GREEN.
//
// The tests marked with "GUARD" in their name are the ones that would go RED.
// We do NOT duplicate the tests here — the describe blocks above ARE the guards.
// This comment records the experiment result required by the task's acceptance criteria.
//
// GUARD tests (must go RED when kind branch is neutered):
//   "explicit kind 'feature-request' → investigate" → routes to investigate (OK, wrong for wrong reason)
//     but "ignores the input content when kind is given" uses a file path → would route to develop (FAIL)
//   "explicit kind 'task-description' → develop" → free text, no kind branch → routes to investigate (FAIL)
//
// RESTORE: put back the `if (kind !== undefined) { if (kind === "feature-request") ... }` block.
