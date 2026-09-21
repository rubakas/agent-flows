// Tests for artifact → run-inputs resolution (spec 029 FR-003/FR-011).
//
// This logic used to be reachable only through POST /api/runs, so every rule in
// it was pinned — if at all — by an HTTP round trip. Now that it is a function,
// each refusal is asserted directly on the message the route would return as a
// 400, which is what a caller actually sees.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { resolveArtifactInputs } from "./artifactInputs.js";
import type { PipelineDef } from "../canon/types.js";

/**
 * A state root the resolver will accept paths under. Realpath'd because macOS
 * hands out /var/folders symlinks and the containment check resolves both sides.
 */
function makeStateRoot(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "af-artifact-inputs-")));
}

function pipeline(inputs: string[], optionalInputs?: string[]): PipelineDef {
  return {
    id: "build",
    version: 1,
    description: "test pipeline",
    inputs,
    ...(optionalInputs !== undefined ? { optionalInputs } : {}),
    steps: [],
  };
}

/** Writes `artifact` into `root` and resolves inputs against it. */
function resolveFrom(
  root: string,
  artifact: unknown,
  def: PipelineDef | undefined,
  explicitInputs: Record<string, unknown> = {}
) {
  const artifactPath = join(root, "artifact.json");
  writeFileSync(artifactPath, JSON.stringify(artifact), "utf8");
  return resolveArtifactInputs({
    artifactPath,
    projectDir: root,
    stateRoot: root,
    pipelineDef: def,
    explicitInputs,
  });
}

describe("resolveArtifactInputs", () => {
  it("maps a succeeded artifact's string spec onto the plan input", () => {
    const root = makeStateRoot();
    try {
      const result = resolveFrom(
        root,
        { status: "succeeded", spec: "the approved plan text" },
        pipeline(["plan"])
      );
      assert.equal(result.ok, true);
      assert.ok(result.ok);
      assert.deepEqual(result.inputs, { plan: "the approved plan text" });
      assert.equal(result.chainDir, root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("renders a HardenedSpec object rather than serialising it ad hoc", () => {
    const root = makeStateRoot();
    try {
      const result = resolveFrom(
        root,
        {
          status: "awaiting_approval",
          spec: { title: "Add pooling", description: "Pool the connections." },
        },
        pipeline(["plan"])
      );
      assert.ok(result.ok);
      const plan = result.inputs.plan;
      assert.equal(typeof plan, "string");
      // Rendered as the Spec Kit document the human approved, not ad-hoc JSON.
      assert.match(plan as string, /^# Feature Specification: Add pooling$/m);
      assert.ok(!(plan as string).includes('"title"'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses an artifact from a stage that is still running", () => {
    const root = makeStateRoot();
    try {
      const result = resolveFrom(
        root,
        { status: "running", spec: "half-written" },
        pipeline(["plan"])
      );
      assert.equal(result.ok, false);
      assert.ok(!result.ok);
      assert.equal(
        result.error,
        "Cannot use an artifact from a running stage — wait for it to settle first"
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses an artifact whose status is not a recognised terminal one", () => {
    const root = makeStateRoot();
    try {
      const result = resolveFrom(root, { status: "paused", spec: "x" }, pipeline(["plan"]));
      assert.ok(!result.ok);
      assert.match(result.error, /unknown status "paused"/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses a required input the artifact does not carry", () => {
    const root = makeStateRoot();
    try {
      const result = resolveFrom(
        root,
        { status: "succeeded", spec: "the plan" },
        pipeline(["plan", "findings"])
      );
      assert.ok(!result.ok);
      assert.match(result.error, /Cannot resolve required input\(s\) \[findings\]/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("accepts a missing input the caller supplied explicitly", () => {
    const root = makeStateRoot();
    try {
      const result = resolveFrom(
        root,
        { status: "succeeded", spec: "the plan" },
        pipeline(["plan", "findings"]),
        { findings: "supplied by the caller" }
      );
      assert.ok(result.ok);
      // explicitInputs is a presence check only — the caller merges it itself.
      assert.deepEqual(result.inputs, { plan: "the plan" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses a mapped object that holds no string under the input's name", () => {
    const root = makeStateRoot();
    try {
      const result = resolveFrom(
        root,
        { status: "succeeded", result: { audit: { detail: 1 } } },
        pipeline(["findings"])
      );
      assert.ok(!result.ok);
      assert.match(result.error, /cannot be resolved to a string from artifact field "result"/);
      assert.match(result.error, /available keys: \[audit\]/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses a path outside the state root", () => {
    const root = makeStateRoot();
    try {
      const result = resolveArtifactInputs({
        artifactPath: "/tmp/somewhere-else.json",
        projectDir: root,
        stateRoot: root,
        pipelineDef: pipeline(["plan"]),
        explicitInputs: {},
      });
      assert.ok(!result.ok);
      assert.match(result.error, /artifactPath must be under /);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
