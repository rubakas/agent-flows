// Tests for the export/import bundle feature.
// Covers: complete closure, round-trip loadability, traversal rejection,
// invalid-bundle rejection, and skip-by-default semantics.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { loadPipeline } from "../canon/load.js";
import { exportBundle, importBundle, parseBundle, stringifyBundle } from "./bundle.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = join(__dirname, "..", "..");
const bundledPipelinesDir = join(repoRoot, "pipelines");

// realpathSync resolves /tmp → /private/tmp on macOS so that loadPipeline's
// symlink-containment check sees consistent paths.
function makeTempDir(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

// ── 1. Bundle contains complete closure for cycle ──────────────────────────────

describe("exportBundle — cycle closure", () => {
  it("bundle contains every pipeline in the transitive closure", () => {
    const bundle = exportBundle("cycle", bundledPipelinesDir);
    const bundledPipelineIds = bundle.files
      .filter((f) => f.path.startsWith("pipelines/"))
      .map((f) => f.path.replace(/^pipelines\//u, "").replace(/\.yaml$/u, ""))
      .sort();

    const expected = [
      "audit",
      "build",
      "build-round",
      "cycle",
      "develop",
      "investigate",
      "ship",
      "spec-creation",
    ];
    assert.deepEqual(bundledPipelineIds, expected);
  });

  it("bundle contains every prompt referenced by any pipeline in the closure", () => {
    const bundle = exportBundle("cycle", bundledPipelinesDir);
    const bundledPrompts = bundle.files
      .filter((f) => f.path.startsWith("prompts/"))
      .map((f) => f.path)
      .sort();

    const expectedPrompts = [
      "prompts/audit-correctness.md",
      "prompts/audit-security.md",
      "prompts/audit-synthesis.md",
      "prompts/build-fix.md",
      "prompts/critic.md",
      "prompts/develop-implement.md",
      "prompts/enrich.md",
      "prompts/intake.md",
      "prompts/investigate-findings.md",
      "prompts/investigate-survey.md",
      "prompts/security.md",
    ];
    assert.deepEqual(bundledPrompts, expectedPrompts);
  });

  it("bundle has correct metadata fields", () => {
    const bundle = exportBundle("cycle", bundledPipelinesDir);
    assert.equal(bundle.bundleVersion, 1);
    assert.equal(bundle.sourcePipeline, "cycle");
    assert.ok(typeof bundle.exportedAt === "string" && bundle.exportedAt.length > 0);
  });

  it("all pipeline file contents are non-empty YAML", () => {
    const bundle = exportBundle("cycle", bundledPipelinesDir);
    for (const f of bundle.files.filter((x) => x.path.startsWith("pipelines/"))) {
      assert.ok(f.content.length > 0, `${f.path} must have non-empty content`);
      assert.ok(f.content.includes("id:"), `${f.path} must contain an id field`);
    }
  });
});

// ── 2. Export-then-import round-trip ──────────────────────────────────────────

describe("exportBundle + importBundle — round-trip", () => {
  it("imported cycle canon is loadable via loadPipeline", () => {
    const projectDir = makeTempDir("agent-flows-bundle-roundtrip-");
    try {
      const bundle = exportBundle("cycle", bundledPipelinesDir);
      const report = importBundle(bundle, projectDir, false);

      // Verify the report is truthful.
      assert.ok(report.written.length > 0, "round-trip must write files");
      assert.equal(report.skipped.length, 0, "fresh import must have no skips");

      // Load the root pipeline — this is the definitive round-trip check.
      // loadPipeline recursively loads all nested pipelines and prompts;
      // if any piece is missing or malformed, it throws.
      const cycleYaml = join(projectDir, ".agent-flows", "pipelines", "cycle.yaml");
      assert.ok(existsSync(cycleYaml), "cycle.yaml must exist after import");

      const loaded = loadPipeline(cycleYaml);
      assert.equal(loaded.def.id, "cycle");
      assert.ok(loaded.def.steps.length > 0, "cycle must have steps after round-trip");
    } finally {
      rmSync(projectDir, { recursive: true });
    }
  });

  it("stringifyBundle + parseBundle preserves all files", () => {
    const bundle = exportBundle("investigate", bundledPipelinesDir);
    const yamlText = stringifyBundle(bundle);
    const parsed = parseBundle(yamlText);

    assert.equal(parsed.bundleVersion, 1);
    assert.equal(parsed.sourcePipeline, "investigate");
    assert.equal(parsed.files.length, bundle.files.length);

    for (const original of bundle.files) {
      const found = parsed.files.find((f) => f.path === original.path);
      assert.ok(found, `file "${original.path}" must survive stringify + parse`);
      assert.equal(found.content, original.content, `content for "${original.path}" must match`);
    }
  });
});

// ── 3. Traversal path rejection ────────────────────────────────────────────────

describe("importBundle — traversal path rejection", () => {
  it("rejects a bundle with a ../ traversal path and writes nothing", () => {
    const projectDir = makeTempDir("agent-flows-traversal-");
    try {
      const maliciousBundle = {
        bundleVersion: 1 as const,
        exportedAt: new Date().toISOString(),
        sourcePipeline: "evil",
        files: [{ path: "../outside-agent-flows/malicious.yaml", content: "# bad" }],
      };

      assert.throws(
        () => importBundle(maliciousBundle, projectDir, false),
        (err: unknown) => {
          assert.ok(err instanceof Error, "must throw an Error");
          assert.ok(
            err.message.includes("escapes") || err.message.includes("invalid"),
            `error must mention path escape; got: "${err.message}"`
          );
          return true;
        }
      );

      // Nothing must have been written to the project directory.
      const agentFlowsDir = join(projectDir, ".agent-flows");
      assert.ok(
        !existsSync(agentFlowsDir),
        ".agent-flows must not be created after a traversal rejection"
      );
    } finally {
      rmSync(projectDir, { recursive: true });
    }
  });

  it("rejects an absolute path in a bundle entry and writes nothing", () => {
    const projectDir = makeTempDir("agent-flows-abs-path-");
    try {
      const maliciousBundle = {
        bundleVersion: 1 as const,
        exportedAt: new Date().toISOString(),
        sourcePipeline: "evil",
        files: [{ path: "/etc/passwd", content: "# bad" }],
      };

      assert.throws(
        () => importBundle(maliciousBundle, projectDir, false),
        (err: unknown) => {
          assert.ok(err instanceof Error, "must throw an Error");
          return true;
        }
      );

      const agentFlowsDir = join(projectDir, ".agent-flows");
      assert.ok(!existsSync(agentFlowsDir), ".agent-flows must not be created");
    } finally {
      rmSync(projectDir, { recursive: true });
    }
  });
});

// ── 4. Invalid bundle rejection ────────────────────────────────────────────────

describe("importBundle / parseBundle — invalid bundle rejection", () => {
  it("parseBundle throws on non-YAML input", () => {
    assert.throws(
      () => parseBundle("not: yaml: : : :::"),
      (err: unknown) => {
        assert.ok(err instanceof Error, "must throw an Error");
        return true;
      }
    );
  });

  it("parseBundle throws when bundleVersion is missing or wrong", () => {
    assert.throws(
      () => parseBundle("bundleVersion: 99\nsourcePipeline: x\nexportedAt: x\nfiles: []\n"),
      /Unsupported bundleVersion/u
    );
  });

  it("parseBundle throws when sourcePipeline is missing", () => {
    assert.throws(
      () => parseBundle("bundleVersion: 1\nexportedAt: x\nfiles: []\n"),
      /sourcePipeline/u
    );
  });

  it("importBundle rejects a bundle with a pipeline that fails to load and writes nothing", () => {
    const projectDir = makeTempDir("agent-flows-invalid-pipeline-");
    try {
      const badBundle = {
        bundleVersion: 1 as const,
        exportedAt: new Date().toISOString(),
        sourcePipeline: "broken",
        files: [
          {
            path: "pipelines/broken.yaml",
            // "steps: bad" is not a valid steps array — loadPipeline will throw.
            content: "id: broken\nversion: 1\ndescription: bad\ninputs: []\nsteps: bad\n",
          },
        ],
      };

      assert.throws(
        () => importBundle(badBundle, projectDir, false),
        (err: unknown) => {
          assert.ok(err instanceof Error, "must throw an Error");
          assert.ok(
            err.message.includes("validation failed") || err.message.includes("broken"),
            `error must mention the failing pipeline; got: "${err.message}"`
          );
          return true;
        }
      );

      // Nothing must have been written to the project directory.
      const destYaml = join(projectDir, ".agent-flows", "pipelines", "broken.yaml");
      assert.ok(!existsSync(destYaml), "broken.yaml must not be written on validation failure");
    } finally {
      rmSync(projectDir, { recursive: true });
    }
  });
});

// ── 5. Skip existing files unless overwrite is requested ──────────────────────

describe("importBundle — skip-by-default semantics", () => {
  it("skips files that already exist and reports them", () => {
    const projectDir = makeTempDir("agent-flows-bundle-skip-");
    try {
      const bundle = exportBundle("investigate", bundledPipelinesDir);

      // First import — all files written.
      const first = importBundle(bundle, projectDir, false);
      assert.ok(first.written.length > 0, "first import must write files");
      assert.equal(first.skipped.length, 0, "first import must have no skips");

      // Second import (same bundle) — all files skipped.
      const second = importBundle(bundle, projectDir, false);
      assert.equal(second.written.length, 0, "second import must write nothing");
      assert.ok(second.skipped.length > 0, "second import must skip all files");
      for (const s of second.skipped) {
        assert.ok(
          s.includes("already exists"),
          `skip entry must say "already exists"; got: "${s}"`
        );
      }
    } finally {
      rmSync(projectDir, { recursive: true });
    }
  });

  it("overwrites existing files when overwrite=true", () => {
    const projectDir = makeTempDir("agent-flows-bundle-overwrite-");
    try {
      const bundle = exportBundle("investigate", bundledPipelinesDir);

      // Pre-seed one file with different content.
      const destPipelinesDir = join(projectDir, ".agent-flows", "pipelines");
      mkdirSync(destPipelinesDir, { recursive: true });
      writeFileSync(join(destPipelinesDir, "investigate.yaml"), "# pre-existing");

      const report = importBundle(bundle, projectDir, true);
      assert.ok(
        report.written.includes("pipelines/investigate.yaml"),
        "investigate.yaml must be in written when overwrite=true"
      );
      assert.ok(
        !report.skipped.some((s) => s.startsWith("pipelines/investigate.yaml")),
        "investigate.yaml must not be in skipped when overwrite=true"
      );
    } finally {
      rmSync(projectDir, { recursive: true });
    }
  });
});
