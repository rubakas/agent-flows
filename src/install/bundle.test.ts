// Tests for the export/import bundle feature.
// Covers: complete closure, round-trip loadability, traversal rejection,
// invalid-bundle rejection, and skip-by-default semantics.

import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
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
      "correct-plan",
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
      "prompts/correct-plan.md",
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

// ── FR-016: providers.yaml round-trip ─────────────────────────────────────────

const VALID_PROVIDERS_YAML = `version: 1
models:
  - id: my-model
    transport: cli
    cli: { bin: claude, model: claude-my-model }
profiles:
  - id: my-profile
    roles: { reasoner: my-model, worker: my-model, scout: my-model }
defaultProvider: my-profile
`;

const INVALID_PROVIDERS_YAML = `version: 2\n`; // version must be 1

describe("exportBundle — providers.yaml", () => {
  it("export-includes-providers-yaml-when-present", () => {
    // Use a minimal gate-only pipeline (no prompt file references) so
    // exportBundle's computeClosure produces no prompt entries and no
    // readFileSync calls fail on a synthetic project dir.
    const MINIMAL_PIPELINE = `version: 3
id: minimal-export-test
description: minimal pipeline for FR-016 export test
inputs: [request]
steps:
  - id: approve
    kind: gate
    message: "approve?"
`;

    const projectDir = makeTempDir("agent-flows-export-providers-");
    try {
      const agentFlowsDir = join(projectDir, ".agent-flows");
      mkdirSync(join(agentFlowsDir, "pipelines"), { recursive: true });
      writeFileSync(join(agentFlowsDir, "providers.yaml"), VALID_PROVIDERS_YAML);
      writeFileSync(join(agentFlowsDir, "pipelines", "minimal-export-test.yaml"), MINIMAL_PIPELINE);

      const pipelinesDir = join(agentFlowsDir, "pipelines");
      const bundle = exportBundle("minimal-export-test", pipelinesDir);

      const providersFile = bundle.files.find((f) => f.path === "providers.yaml");
      assert.ok(providersFile, "bundle must include providers.yaml");
      assert.equal(providersFile.content, VALID_PROVIDERS_YAML);
    } finally {
      rmSync(projectDir, { recursive: true });
    }
  });

  it("export-omits-when-absent: no providers.yaml when file does not exist", () => {
    // bundledPipelinesDir's parent has no providers.yaml.
    const bundle = exportBundle("investigate", bundledPipelinesDir);
    const providersFile = bundle.files.find((f) => f.path === "providers.yaml");
    assert.equal(providersFile, undefined, "bundle must not include providers.yaml when absent");
  });
});

describe("importBundle — providers.yaml", () => {
  it("import-skips-existing-providers-yaml: existing project file wins by default", () => {
    const projectDir = makeTempDir("agent-flows-import-prov-skip-");
    try {
      const agentFlowsDir = join(projectDir, ".agent-flows");
      mkdirSync(agentFlowsDir, { recursive: true });
      writeFileSync(join(agentFlowsDir, "providers.yaml"), "version: 1\n# existing\n");

      const bundle = exportBundle("investigate", bundledPipelinesDir);
      // Inject a providers.yaml into the bundle.
      bundle.files.push({ path: "providers.yaml", content: VALID_PROVIDERS_YAML });

      const report = importBundle(bundle, projectDir, false);
      assert.ok(
        report.skipped.some((s) => s.startsWith("providers.yaml")),
        `providers.yaml must be in skipped; skipped: ${report.skipped.join(", ")}`
      );
      // Verify the existing file was not replaced.
      const content = readFileSync(join(agentFlowsDir, "providers.yaml"), "utf8");
      assert.ok(
        content.includes("# existing"),
        "existing providers.yaml content must be preserved"
      );
    } finally {
      rmSync(projectDir, { recursive: true });
    }
  });

  it("import-overwrites-with-flag: overwrite=true replaces existing providers.yaml", () => {
    const projectDir = makeTempDir("agent-flows-import-prov-overwrite-");
    try {
      const agentFlowsDir = join(projectDir, ".agent-flows");
      mkdirSync(agentFlowsDir, { recursive: true });
      writeFileSync(join(agentFlowsDir, "providers.yaml"), "version: 1\n# existing\n");

      const bundle = exportBundle("investigate", bundledPipelinesDir);
      bundle.files.push({ path: "providers.yaml", content: VALID_PROVIDERS_YAML });

      const report = importBundle(bundle, projectDir, true);
      assert.ok(
        report.written.some((w) => w === "providers.yaml"),
        `providers.yaml must be in written; written: ${report.written.join(", ")}`
      );
      const content = readFileSync(join(agentFlowsDir, "providers.yaml"), "utf8");
      assert.equal(content, VALID_PROVIDERS_YAML);
    } finally {
      rmSync(projectDir, { recursive: true });
    }
  });

  it("import-rejects-malformed-bundled-providers: nothing written to project on invalid providers.yaml", () => {
    const projectDir = makeTempDir("agent-flows-import-prov-invalid-");
    try {
      const bundle = exportBundle("investigate", bundledPipelinesDir);
      bundle.files.push({ path: "providers.yaml", content: INVALID_PROVIDERS_YAML });

      assert.throws(
        () => importBundle(bundle, projectDir, false),
        (err: unknown) => {
          assert.ok(err instanceof Error, "must throw an Error");
          assert.ok(
            err.message.includes("providers.yaml"),
            `error must mention providers.yaml: ${err.message}`
          );
          return true;
        }
      );

      // Nothing must have been written to the project.
      const agentFlowsDir = join(projectDir, ".agent-flows");
      assert.ok(!existsSync(agentFlowsDir), "project must not have any written files on failure");
    } finally {
      rmSync(projectDir, { recursive: true });
    }
  });

  it("old-bundle-without-providers-imports-unchanged", () => {
    const projectDir = makeTempDir("agent-flows-import-no-prov-");
    try {
      // Bundle without providers.yaml — current behaviour must be unchanged.
      const bundle = exportBundle("investigate", bundledPipelinesDir);
      assert.ok(
        !bundle.files.some((f) => f.path === "providers.yaml"),
        "bundled pipelines dir has no providers.yaml"
      );

      const report = importBundle(bundle, projectDir, false);
      assert.ok(report.written.length > 0, "must have written pipeline files");
      assert.ok(
        !report.written.includes("providers.yaml"),
        "providers.yaml must not appear in written"
      );
    } finally {
      rmSync(projectDir, { recursive: true });
    }
  });
});

// ── 7. Path allowlist and symlink containment (spec 037 FR-016) ───────────────

describe("importBundle — entry path allowlist (FR-016)", () => {
  it("refuses a bundle carrying a config.json entry and writes nothing", () => {
    const projectDir = makeTempDir("agent-flows-allowlist-");
    try {
      const bundle = exportBundle("investigate", bundledPipelinesDir);
      bundle.files.push({ path: "config.json", content: '{"checkCommand":"rm -rf /"}' });

      assert.throws(
        () => importBundle(bundle, projectDir, false),
        (err: unknown) => {
          assert.ok(err instanceof Error, "must throw an Error");
          assert.ok(
            err.message.includes("config.json") && err.message.includes("not an allowed path"),
            `error must name the refused entry; got: "${err.message}"`
          );
          return true;
        }
      );

      assert.ok(
        !existsSync(join(projectDir, ".agent-flows")),
        "a refused bundle writes nothing at all, not even its valid entries"
      );
    } finally {
      rmSync(projectDir, { recursive: true });
    }
  });

  it("refuses entries outside pipelines/, prompts/ and providers.yaml", () => {
    const projectDir = makeTempDir("agent-flows-allowlist2-");
    try {
      for (const path of [
        "pipelines/nested/deep.yaml",
        "pipelines/notes.md",
        "prompts",
        ".env",
        "scripts/hook.sh",
        "providers.yml",
      ]) {
        assert.throws(
          () =>
            importBundle(
              {
                bundleVersion: 1 as const,
                exportedAt: new Date().toISOString(),
                sourcePipeline: "evil",
                files: [{ path, content: "x" }],
              },
              projectDir,
              false
            ),
          (err: unknown) => {
            assert.ok(err instanceof Error);
            assert.ok(
              err.message.includes("not an allowed path"),
              `entry ${path} must be refused by the allowlist; got: "${err.message}"`
            );
            return true;
          },
          `entry ${path} must be refused`
        );
      }
      assert.ok(!existsSync(join(projectDir, ".agent-flows")), "nothing was written");
    } finally {
      rmSync(projectDir, { recursive: true });
    }
  });

  it("still accepts the three allowed shapes", () => {
    const projectDir = makeTempDir("agent-flows-allowlist3-");
    try {
      const bundle = exportBundle("investigate", bundledPipelinesDir);
      const report = importBundle(bundle, projectDir, false);
      assert.ok(
        report.written.some((p) => p.startsWith("pipelines/")),
        "pipelines/*.yaml is allowed"
      );
      assert.ok(
        report.written.some((p) => p.startsWith("prompts/")),
        "prompts/** is allowed"
      );
    } finally {
      rmSync(projectDir, { recursive: true });
    }
  });
});

describe("importBundle — symlink containment (FR-016/S2)", () => {
  it("a prompts/ symlink pointing outside the project fails before any write", () => {
    const projectDir = makeTempDir("agent-flows-symlink-");
    const outsideDir = makeTempDir("agent-flows-outside-");
    try {
      mkdirSync(join(projectDir, ".agent-flows"), { recursive: true });
      // The kind of symlink assertSafePath cannot see: the entry path is a
      // plain "prompts/…", but the directory it lands in is elsewhere.
      symlinkSync(outsideDir, join(projectDir, ".agent-flows", "prompts"), "dir");

      const bundle = exportBundle("investigate", bundledPipelinesDir);
      assert.throws(
        () => importBundle(bundle, projectDir, false),
        (err: unknown) => {
          assert.ok(err instanceof Error, "must throw an Error");
          assert.ok(
            err.message.includes("symlink"),
            `error must name the symlink escape; got: "${err.message}"`
          );
          return true;
        }
      );

      assert.deepEqual(
        readdirSync(outsideDir),
        [],
        "not one file may land outside the project through the symlink"
      );
      assert.ok(
        !existsSync(join(projectDir, ".agent-flows", "pipelines")),
        "the valid entries of a refused bundle are not written either"
      );
    } finally {
      rmSync(projectDir, { recursive: true });
      rmSync(outsideDir, { recursive: true });
    }
  });
});

// ── 8. Non-normalised entry paths (spec 037 FR-016) ───────────────────────────

describe("importBundle — non-normalised entry paths", () => {
  // The allowlist patterns and the later filters (startsWith("pipelines/"),
  // === "providers.yaml") read the entry path differently once a "." or ".."
  // segment is in it, so such an entry is refused before any I/O happens.
  const traversals = [
    "prompts/../config.json",
    "prompts/x/../../settings.json",
    "prompts/../pipelines/evil.yaml",
    "./prompts/a.md",
    "pipelines/./evil.yaml",
  ];

  for (const path of traversals) {
    it(`refuses ${path} and leaves the project tree untouched`, () => {
      const projectDir = makeTempDir("agent-flows-nonnormal-");
      try {
        // A pre-existing tree, so "unchanged" is an observable state and not
        // merely the absence of .agent-flows/.
        mkdirSync(join(projectDir, ".agent-flows", "prompts"), { recursive: true });
        writeFileSync(join(projectDir, ".agent-flows", "prompts", "keep.md"), "keep\n", "utf8");
        const before = readdirSync(join(projectDir, ".agent-flows"), { recursive: true })
          .map(String)
          .sort();

        assert.throws(
          () =>
            importBundle(
              {
                bundleVersion: 1 as const,
                exportedAt: new Date().toISOString(),
                sourcePipeline: "evil",
                files: [{ path, content: "x" }],
              },
              projectDir,
              false
            ),
          (err: unknown) => {
            assert.ok(err instanceof Error, "must throw an Error");
            assert.ok(
              err.message.includes(JSON.stringify(path)),
              `the error must name the refused entry; got: "${err.message}"`
            );
            assert.ok(
              err.message.includes("normalised"),
              `the error must state why it was refused; got: "${err.message}"`
            );
            return true;
          },
          `entry ${path} must be refused`
        );

        assert.deepEqual(
          readdirSync(join(projectDir, ".agent-flows"), { recursive: true }).map(String).sort(),
          before,
          "a refused bundle writes nothing under the project"
        );
      } finally {
        rmSync(projectDir, { recursive: true });
      }
    });
  }
});

// ── 9. exportBundle reads only inside the catalogue root ──────────────────────

describe("exportBundle — closure paths are contained", () => {
  it("refuses a prompt path that escapes the catalogue root", () => {
    const base = makeTempDir("agent-flows-export-escape-");
    const outsideDir = makeTempDir("agent-flows-export-outside-");
    try {
      const pipelinesDir = join(base, "proj", "pipelines");
      mkdirSync(pipelinesDir, { recursive: true });
      writeFileSync(join(outsideDir, "payload.txt"), "outside payload\n", "utf8");
      const escape = join("..", "..", "..", relative("/", join(outsideDir, "payload.txt")));
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
          `    prompt: ${escape}`,
          "    role: worker",
        ].join("\n") + "\n"
      );

      assert.throws(
        () => exportBundle("evil", pipelinesDir),
        (err: unknown) => {
          assert.ok(err instanceof Error, "must throw an Error");
          assert.ok(
            err.message.includes("escapes"),
            `the error must describe the escape; got: "${err.message}"`
          );
          return true;
        }
      );
    } finally {
      rmSync(base, { recursive: true });
      rmSync(outsideDir, { recursive: true });
    }
  });

  it("refuses a nested pipeline id that escapes the pipelines directory", () => {
    const base = makeTempDir("agent-flows-export-escape2-");
    try {
      const pipelinesDir = join(base, "proj", "pipelines");
      mkdirSync(pipelinesDir, { recursive: true });
      writeFileSync(
        join(base, "outside.yaml"),
        ["id: outside", "version: 1", "description: outside", "inputs: []", "steps: []"].join(
          "\n"
        ) + "\n",
        "utf8"
      );
      writeFileSync(
        join(pipelinesDir, "root.yaml"),
        [
          "id: root",
          "version: 1",
          "description: root",
          "inputs: []",
          "steps:",
          "  - id: s",
          "    kind: pipeline",
          "    pipeline: ../../outside",
        ].join("\n") + "\n"
      );

      assert.throws(
        () => exportBundle("root", pipelinesDir),
        (err: unknown) => {
          assert.ok(err instanceof Error, "must throw an Error");
          assert.ok(
            err.message.includes("escapes"),
            `the error must describe the escape; got: "${err.message}"`
          );
          return true;
        }
      );
    } finally {
      rmSync(base, { recursive: true });
    }
  });
});
