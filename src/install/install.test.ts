import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { resolveCanonDir } from "../bindings/mastra/pipelineLoader.js";
import { loadPipeline } from "../canon/load.js";
import { computeClosure, installWorkflow, listAvailable, listInstalled } from "./install.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = join(__dirname, "..", "..");
const bundledPipelinesDir = join(repoRoot, "pipelines");
const bundledPromptsDir = join(repoRoot, "prompts");

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
    ]);
    assert.deepEqual(pipelines, expectedPipelines);
  });

  it("includes every prompt referenced by any pipeline in the closure", () => {
    const { prompts } = computeClosure("cycle", bundledPipelinesDir);
    const expectedPrompts = new Set([
      "prompts/audit-correctness.md",
      "prompts/audit-security.md",
      "prompts/audit-synthesis.md",
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

// ── 2. Skip existing files ──────────────────────────────────────────────────────

describe("installWorkflow — skip existing files", () => {
  it("skips a file that already exists and reports it", () => {
    const projectDir = makeTempDir("agent-flows-skip-");
    try {
      // Pre-create one pipeline file.
      const destPipelines = join(projectDir, ".agent-flows", "pipelines");
      mkdirSync(destPipelines, { recursive: true });
      writeFileSync(join(destPipelines, "investigate.yaml"), "# pre-existing");

      const { written, skipped } = installWorkflow(
        ["investigate"],
        bundledPipelinesDir,
        projectDir,
        false
      );

      // investigate.yaml must be skipped; prompts must be written.
      assert.ok(
        skipped.some((s) => s.startsWith("pipelines/investigate.yaml")),
        `Expected investigate.yaml in skipped; got: ${JSON.stringify(skipped)}`
      );
      assert.ok(
        !written.some((w) => w === "pipelines/investigate.yaml"),
        "investigate.yaml must not appear in written"
      );
      // The pre-existing file content must be preserved.
      assert.equal(readFileSync(join(destPipelines, "investigate.yaml"), "utf8"), "# pre-existing");
    } finally {
      rmSync(projectDir, { recursive: true });
    }
  });

  it("each skip entry explicitly notes the reason", () => {
    const projectDir = makeTempDir("agent-flows-skip-reason-");
    try {
      const destPipelines = join(projectDir, ".agent-flows", "pipelines");
      mkdirSync(destPipelines, { recursive: true });
      writeFileSync(join(destPipelines, "investigate.yaml"), "# existing");

      const { skipped } = installWorkflow(["investigate"], bundledPipelinesDir, projectDir, false);

      const entry = skipped.find((s) => s.startsWith("pipelines/investigate.yaml"));
      assert.ok(entry, "investigate.yaml skip entry must be present");
      assert.ok(
        entry.includes("already exists"),
        `Skip entry must mention "already exists"; got: "${entry}"`
      );
    } finally {
      rmSync(projectDir, { recursive: true });
    }
  });
});

// ── 3. Overwrite flag ──────────────────────────────────────────────────────────

describe("installWorkflow — overwrite flag", () => {
  it("overwrites an existing file when overwrite=true", () => {
    const projectDir = makeTempDir("agent-flows-overwrite-");
    try {
      const destPipelines = join(projectDir, ".agent-flows", "pipelines");
      mkdirSync(destPipelines, { recursive: true });
      writeFileSync(join(destPipelines, "investigate.yaml"), "# pre-existing");

      const { written, skipped } = installWorkflow(
        ["investigate"],
        bundledPipelinesDir,
        projectDir,
        true // overwrite
      );

      assert.ok(
        written.some((w) => w === "pipelines/investigate.yaml"),
        "investigate.yaml must appear in written"
      );
      assert.ok(
        !skipped.some((s) => s.startsWith("pipelines/investigate.yaml")),
        "investigate.yaml must not appear in skipped"
      );
      // Content must now match the bundled source.
      const bundledContent = readFileSync(join(bundledPipelinesDir, "investigate.yaml"), "utf8");
      const installedContent = readFileSync(join(destPipelines, "investigate.yaml"), "utf8");
      assert.equal(installedContent, bundledContent);
    } finally {
      rmSync(projectDir, { recursive: true });
    }
  });
});

// ── 4. Installed pipeline loads successfully ───────────────────────────────────

describe("installWorkflow — installed pipeline loads via loadPipeline", () => {
  it("loadPipeline succeeds for an installed pipeline with prompts at .agent-flows/", () => {
    const projectDir = makeTempDir("agent-flows-load-");
    try {
      // Install investigate (simple: 2 steps, 2 prompts, no nested pipelines).
      installWorkflow(["investigate"], bundledPipelinesDir, projectDir, false);

      const yamlPath = join(projectDir, ".agent-flows", "pipelines", "investigate.yaml");
      assert.ok(existsSync(yamlPath), "installed YAML must exist");

      // loadPipeline derives repoRoot = dirname(dirname(yamlPath)) = <projectDir>/.agent-flows
      // and resolves prompts/investigate-survey.md relative to that root.
      // This must succeed without error.
      const loaded = loadPipeline(yamlPath);
      assert.equal(loaded.def.id, "investigate");
      assert.ok("survey" in loaded.prompts, "survey prompt must be loaded");
      assert.ok("findings" in loaded.prompts, "findings prompt must be loaded");
      assert.ok(loaded.prompts.survey.length > 0, "survey prompt must have content");
    } finally {
      rmSync(projectDir, { recursive: true });
    }
  });

  it("all prompt content in installed copy matches bundled source", () => {
    const projectDir = makeTempDir("agent-flows-content-");
    try {
      installWorkflow(["investigate"], bundledPipelinesDir, projectDir, false);

      for (const name of ["investigate-survey", "investigate-findings"]) {
        const bundled = readFileSync(join(bundledPromptsDir, `${name}.md`), "utf8");
        const installed = readFileSync(
          join(projectDir, ".agent-flows", "prompts", `${name}.md`),
          "utf8"
        );
        assert.equal(installed, bundled, `${name}.md content must match bundled source`);
      }
    } finally {
      rmSync(projectDir, { recursive: true });
    }
  });
});

// ── 5. Project copies take precedence over bundled ────────────────────────────

describe("resolveCanonDir — project copies take precedence", () => {
  it("returns project source when .agent-flows/pipelines/ contains YAML files", () => {
    const projectDir = makeTempDir("agent-flows-precedence-");
    try {
      const projectPipelinesDir = join(projectDir, ".agent-flows", "pipelines");
      mkdirSync(projectPipelinesDir, { recursive: true });
      writeFileSync(
        join(projectPipelinesDir, "investigate.yaml"),
        "id: investigate\nversion: 1\ndescription: custom\ninputs: []\nsteps: []\n"
      );

      const result = resolveCanonDir(projectDir);
      assert.equal(result.source, "project");
      assert.equal(result.pipelinesDir, projectPipelinesDir);
    } finally {
      rmSync(projectDir, { recursive: true });
    }
  });

  it("falls back to bundled when .agent-flows/pipelines/ does not exist", () => {
    const projectDir = makeTempDir("agent-flows-fallback-");
    try {
      const result = resolveCanonDir(projectDir);
      assert.equal(result.source, "bundled");
      assert.ok(
        result.pipelinesDir.endsWith("pipelines"),
        "bundled pipelinesDir must end with 'pipelines'"
      );
      assert.ok(existsSync(result.pipelinesDir), "bundled pipelinesDir must exist on disk");
    } finally {
      rmSync(projectDir, { recursive: true });
    }
  });

  it("falls back to bundled when .agent-flows/pipelines/ is empty", () => {
    const projectDir = makeTempDir("agent-flows-empty-");
    try {
      mkdirSync(join(projectDir, ".agent-flows", "pipelines"), { recursive: true });
      const result = resolveCanonDir(projectDir);
      assert.equal(result.source, "bundled");
    } finally {
      rmSync(projectDir, { recursive: true });
    }
  });
});

// ── Helpers ────────────────────────────────────────────────────────────────────

describe("listAvailable and listInstalled", () => {
  it("listAvailable returns all bundled pipeline IDs", () => {
    const available = listAvailable(bundledPipelinesDir);
    assert.ok(available.includes("cycle"), "cycle must be in available list");
    assert.ok(available.includes("investigate"), "investigate must be in available list");
    assert.ok(available.length >= 9, "must have at least 9 bundled pipelines");
  });

  it("listInstalled returns empty array when nothing is installed", () => {
    const projectDir = makeTempDir("agent-flows-list-empty-");
    try {
      assert.deepEqual(listInstalled(projectDir), []);
    } finally {
      rmSync(projectDir, { recursive: true });
    }
  });

  it("listInstalled returns installed IDs after install", () => {
    const projectDir = makeTempDir("agent-flows-list-installed-");
    try {
      installWorkflow(["investigate"], bundledPipelinesDir, projectDir, false);
      const installed = listInstalled(projectDir);
      assert.ok(installed.includes("investigate"), "investigate must be listed as installed");
    } finally {
      rmSync(projectDir, { recursive: true });
    }
  });
});
