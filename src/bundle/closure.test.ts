import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { catalogRows, resolveCatalog, resolveLayers } from "../canon/layers.js";
import { packageRoot } from "../packageRoot.js";
import { exportBundle } from "./bundle.js";
import { computeClosure } from "./closure.js";

const repoRoot = packageRoot();
const bundledPipelinesDir = join(repoRoot, "pipelines");

// realpathSync resolves /tmp → /private/tmp on macOS so that loadPipeline's
// symlink-containment check (realpathSync vs resolve) sees consistent paths.
function makeTempDir(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

// ── 1. Transitive closure for cycle ────────────────────────────────────────────

describe("computeClosure — cycle", () => {
  it("includes every transitively nested pipeline", () => {
    const { pipelines } = computeClosure("cycle", bundledPipelinesDir);
    const expectedPipelines = new Set([
      "cycle",
      "investigate",
      "spec-creation",
      "build",
      "ship",
      "develop",
      "build-round",
      "audit",
      "correct-plan",
    ]);
    assert.deepEqual(pipelines, expectedPipelines);
  });

  it("includes every prompt referenced by any pipeline in the closure", () => {
    const { prompts } = computeClosure("cycle", bundledPipelinesDir);
    const expectedPrompts = new Set([
      "prompts/audit-correctness.md",
      "prompts/audit-security.md",
      "prompts/audit-synthesis.md",
      "prompts/correct-plan.md",
      "prompts/investigate-survey.md",
      "prompts/investigate-findings.md",
      "prompts/intake.md",
      "prompts/enrich.md",
      "prompts/critic.md",
      "prompts/security.md",
      "prompts/develop-implement.md",
      "prompts/build-fix.md",
    ]);
    assert.deepEqual(prompts, expectedPrompts);
  });

  it("excludes pipelines nothing in the closure references", () => {
    const { pipelines } = computeClosure("cycle", bundledPipelinesDir);
    // `test` is a standalone workflow: build-round runs the suite with its own
    // check step rather than nesting test.yaml, so nothing pulls it in.
    assert.ok(!pipelines.has("test"), "test should not be in closure");
  });

  it("excludes prompts nothing in the closure references", () => {
    const { prompts } = computeClosure("cycle", bundledPipelinesDir);
    assert.ok(!prompts.has("prompts/nonexistent.md"), "unreferenced prompt must be absent");
    // audit IS referenced now — build nests it as the post-loop review step.
    assert.ok(prompts.has("prompts/audit-synthesis.md"), "audit prompts are in the closure");
  });
});

// ── 5. Project copies take precedence, without hiding the bundled set ─────────
//
// These three cases asserted `resolveCanonDir`'s exclusive flip until spec 038
// D13 replaced it. They now assert the merged view's precedence: the project's
// copy still wins on an id collision, but the bundled catalogue stays visible.
// AGENT_FLOWS_HOME is pinned so the owner's real user library is never a layer.

describe("merged layers — project copies take precedence over bundled (038 FR-017)", () => {
  it("resolves a colliding id to the project copy while keeping the bundled set listed", () => {
    const projectDir = makeTempDir("agent-flows-precedence-");
    const home = makeTempDir("agent-flows-home-");
    try {
      const projectPipelinesDir = join(projectDir, ".agent-flows", "pipelines");
      mkdirSync(projectPipelinesDir, { recursive: true });
      writeFileSync(
        join(projectPipelinesDir, "investigate.yaml"),
        "id: investigate\nversion: 1\ndescription: custom\ninputs: []\nsteps: []\n"
      );

      const catalog = resolveCatalog(projectDir, { AGENT_FLOWS_HOME: home });
      const investigate = catalog.entries.get("investigate");
      assert.equal(investigate?.layer.source, "repo");
      assert.equal(investigate?.filePath, join(projectPipelinesDir, "investigate.yaml"));
      assert.deepEqual(investigate?.shadows, ["bundled"]);

      const ids = catalogRows(catalog).map((e) => e.id);
      assert.ok(
        ids.includes("spec-creation"),
        `the bundled catalogue is not hidden by a project copy; got: ${ids.join(", ")}`
      );
    } finally {
      rmSync(projectDir, { recursive: true });
      rmSync(home, { recursive: true });
    }
  });

  it("is the bundled layer alone when .agent-flows/ does not exist", () => {
    const projectDir = makeTempDir("agent-flows-fallback-");
    const home = makeTempDir("agent-flows-home-");
    try {
      const layers = resolveLayers(projectDir, { AGENT_FLOWS_HOME: home });
      assert.deepEqual(
        layers.map((l) => l.source),
        ["bundled"]
      );
      assert.ok(existsSync(layers[0].pipelinesDir), "bundled pipelinesDir must exist on disk");
    } finally {
      rmSync(projectDir, { recursive: true });
      rmSync(home, { recursive: true });
    }
  });

  it("an empty .agent-flows/pipelines/ contributes no workflow, and hides none", () => {
    const projectDir = makeTempDir("agent-flows-empty-");
    const home = makeTempDir("agent-flows-home-");
    try {
      mkdirSync(join(projectDir, ".agent-flows", "pipelines"), { recursive: true });
      const catalog = resolveCatalog(projectDir, { AGENT_FLOWS_HOME: home });
      assert.ok(
        catalogRows(catalog).every((e) => e.layer.source === "bundled"),
        "an empty repository canon contributes nothing"
      );
      assert.ok(catalog.entries.has("spec-creation"));
    } finally {
      rmSync(projectDir, { recursive: true });
      rmSync(home, { recursive: true });
    }
  });
});

// ── 6. Path traversal rejection ────────────────────────────────────────────────

describe("computeClosure — path traversal rejection", () => {
  it("rejects a prompt path that escapes the catalogue root", () => {
    const fakeRoot = makeTempDir("agent-flows-traversal-");
    try {
      const pipelinesDir = join(fakeRoot, "pipelines");
      mkdirSync(pipelinesDir);
      writeFileSync(
        join(pipelinesDir, "evil.yaml"),
        [
          "id: evil",
          "version: 1",
          "description: evil",
          "inputs: []",
          "steps:",
          "  - id: s",
          "    kind: llm",
          "    prompt: ../../etc/passwd",
          "    role: worker",
        ].join("\n") + "\n"
      );

      assert.throws(
        () => computeClosure("evil", pipelinesDir),
        (err: unknown) => {
          assert.ok(err instanceof Error, "must throw an Error");
          assert.ok(
            err.message.includes("escapes") || err.message.includes("invalid"),
            `error must describe the path problem; got: "${err.message}"`
          );
          return true;
        }
      );
    } finally {
      rmSync(fakeRoot, { recursive: true, force: true });
    }
  });
});

// ── 7. computeClosure survives the install removal (FR-028) ───────────────────
//
// `installWorkflow` is gone; `computeClosure` is not, because `exportBundle`
// walks the same closure. A future cleanup pass that deletes it as dead code
// must fail here rather than silently emptying every exported bundle.

describe("FR-028: exportBundle still depends on computeClosure", () => {
  it("an exported bundle carries exactly the ids computeClosure reports", () => {
    const { pipelines } = computeClosure("cycle", bundledPipelinesDir);
    const exported = exportBundle("cycle", bundledPipelinesDir)
      .files.filter((f) => f.path.startsWith("pipelines/"))
      .map((f) => f.path.replace(/^pipelines\/|\.yaml$/gu, ""))
      .sort();
    assert.deepEqual(exported, [...pipelines].sort());
  });
});
