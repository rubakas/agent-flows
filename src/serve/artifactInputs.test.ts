// Tests for artifact → run-inputs resolution (spec 029 FR-003/FR-011).
//
// This logic used to be reachable only through POST /api/runs, so every rule in
// it was pinned — if at all — by an HTTP round trip. Now that it is a function,
// each refusal is asserted directly on the message the route would return as a
// 400, which is what a caller actually sees.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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

// The path is the one value in a request that decides where a chain writes and what
// it reads, so every way out of the state root is pinned here, on the function, with
// the exact message a caller gets. These cases used to be reachable only through
// POST /api/runs.
describe("resolveArtifactInputs — the artifact path is confined to the state root", () => {
  const ARTIFACT = {
    runId: "src-run",
    pipelineId: "spec-creation",
    status: "succeeded",
    gateMode: "manual",
    spec: "the plan",
    steps: {},
    gateDecisions: [],
  };

  /** A temp tree: `<tmp>/state` is the state root, `<tmp>/state/project` the project. */
  function layout() {
    const tmp = makeStateRoot();
    const stateRoot = join(tmp, "state");
    const projectDir = join(stateRoot, "project");
    mkdirSync(projectDir, { recursive: true });
    const put = (path: string): string => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(ARTIFACT), "utf8");
      return path;
    };
    const resolveAt = (artifactPath: unknown, root = stateRoot) =>
      resolveArtifactInputs({
        artifactPath,
        projectDir,
        stateRoot: root,
        pipelineDef: pipeline(["plan"]),
        explicitInputs: {},
      });
    return { tmp, stateRoot, projectDir, put, resolveAt };
  }

  function refused(result: ReturnType<typeof resolveArtifactInputs>): string {
    assert.equal(result.ok, false, `expected a refusal, got ${JSON.stringify(result)}`);
    if (result.ok) throw new Error("unreachable");
    return result.error;
  }

  it("accepts an absolute path inside the state root, and names its directory", () => {
    const t = layout();
    try {
      const inside = t.put(join(t.stateRoot, "runs", "inside-run", "spec-creation.json"));
      const result = t.resolveAt(inside);
      assert.deepEqual(result, {
        ok: true,
        inputs: { plan: "the plan" },
        chainDir: dirname(inside),
      });
    } finally {
      rmSync(t.tmp, { recursive: true, force: true });
    }
  });

  it("accepts a relative path that stays inside the project directory", () => {
    const t = layout();
    try {
      t.put(join(t.projectDir, "handoff", "spec-creation.json"));
      const result = t.resolveAt(join("handoff", "spec-creation.json"));
      assert.equal(result.ok, true, JSON.stringify(result));
    } finally {
      rmSync(t.tmp, { recursive: true, force: true });
    }
  });

  it("refuses an absolute path outside the state root", () => {
    const t = layout();
    try {
      const outside = t.put(join(t.tmp, "elsewhere", "spec-creation.json"));
      assert.equal(refused(t.resolveAt(outside)), `artifactPath must be under ${t.stateRoot}`);
    } finally {
      rmSync(t.tmp, { recursive: true, force: true });
    }
  });

  it("refuses /tmp/x, a path the daemon never writes to", () => {
    const t = layout();
    try {
      assert.equal(refused(t.resolveAt("/tmp/x")), `artifactPath must be under ${t.stateRoot}`);
    } finally {
      rmSync(t.tmp, { recursive: true, force: true });
    }
  });

  it("refuses a sibling of a state root that does not exist yet", () => {
    // Shortening a not-yet-created root to its parent would accept everything beside it.
    const t = layout();
    try {
      const notYet = join(t.tmp, "not-created-yet");
      const beside = t.put(join(t.tmp, "beside.json"));
      assert.equal(refused(t.resolveAt(beside, notYet)), `artifactPath must be under ${notYet}`);
    } finally {
      rmSync(t.tmp, { recursive: true, force: true });
    }
  });

  it("refuses an absolute path that climbs out of the root with ..", () => {
    const t = layout();
    try {
      const escaped = join(t.stateRoot, "runs", "..", "..", "..", "x.json");
      assert.equal(refused(t.resolveAt(escaped)), `artifactPath must be under ${t.stateRoot}`);
    } finally {
      rmSync(t.tmp, { recursive: true, force: true });
    }
  });

  it("refuses a relative path that traverses outside the project directory", () => {
    const t = layout();
    try {
      t.put(join(t.tmp, "outside.json"));
      assert.equal(
        refused(t.resolveAt(join("..", "..", "outside.json"))),
        'Artifact path "../../outside.json" escapes the project directory — rejected'
      );
    } finally {
      rmSync(t.tmp, { recursive: true, force: true });
    }
  });

  it("refuses a symlink inside the root that points outside it", (ctx) => {
    const t = layout();
    try {
      const target = join(t.tmp, "linked-target");
      t.put(join(target, "spec-creation.json"));
      const link = join(t.stateRoot, "runs", "link-out");
      mkdirSync(dirname(link), { recursive: true });
      try {
        symlinkSync(target, link, "dir");
      } catch {
        ctx.skip("symlinks unavailable");
        return;
      }
      assert.equal(
        refused(t.resolveAt(join(link, "spec-creation.json"))),
        `artifactPath must be under ${t.stateRoot}`,
        "a symlink must not be a way out of the state root"
      );
    } finally {
      rmSync(t.tmp, { recursive: true, force: true });
    }
  });

  it("refuses a NUL byte and an empty path before touching the filesystem", () => {
    const t = layout();
    try {
      const withNul = join(t.stateRoot, "runs", "a\0b.json");
      assert.equal(
        refused(t.resolveAt(withNul)),
        `Invalid artifact path: ${JSON.stringify(withNul)}`
      );
      assert.equal(refused(t.resolveAt("")), 'Invalid artifact path: ""');
    } finally {
      rmSync(t.tmp, { recursive: true, force: true });
    }
  });

  it("refuses a path that is not a string", () => {
    const t = layout();
    try {
      assert.equal(refused(t.resolveAt(7)), 'Field "artifactPath" must be a string');
    } finally {
      rmSync(t.tmp, { recursive: true, force: true });
    }
  });

  it("refuses an artifact file that does not exist, naming the path", () => {
    const t = layout();
    try {
      const missing = join(t.stateRoot, "runs", "gone", "spec-creation.json");
      assert.equal(refused(t.resolveAt(missing)), `Artifact file not found: ${missing}`);
    } finally {
      rmSync(t.tmp, { recursive: true, force: true });
    }
  });

  it("refuses a file that is not valid JSON, and JSON that is not an object", () => {
    const t = layout();
    try {
      const bad = join(t.stateRoot, "runs", "bad.json");
      mkdirSync(dirname(bad), { recursive: true });
      writeFileSync(bad, "not json {{{", "utf8");
      assert.equal(refused(t.resolveAt(bad)), "Artifact file contains invalid JSON");
      writeFileSync(bad, "[1, 2]", "utf8");
      assert.equal(refused(t.resolveAt(bad)), "Artifact is not a valid JSON object");
    } finally {
      rmSync(t.tmp, { recursive: true, force: true });
    }
  });
});
