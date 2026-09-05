import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { assembleSpec } from "./assemble.js";
import { pipelineLevels } from "./graph.js";
import { loadPipeline } from "./load.js";
import { renderPrompt } from "./render.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = join(__dirname, "..", "..");
const pipelinesYaml = join(repoRoot, "pipelines", "spec-creation.yaml");

describe("loadPipeline", () => {
  it("loads spec-creation.yaml successfully", () => {
    const { def, prompts } = loadPipeline(pipelinesYaml);
    assert.equal(def.id, "spec-creation");
    assert.equal(def.steps.length, 7);

    for (const id of ["intake", "enrich", "critic", "security"]) {
      assert.ok(id in prompts, `prompts["${id}"] should be loaded`);
      assert.ok(prompts[id].length > 0, `prompts["${id}"] should be non-empty`);
    }

    const critiqueIds = def.steps.filter((s) => s.dependsOn?.includes("enrich")).map((s) => s.id);
    assert.deepEqual(critiqueIds, ["critic", "security"]);
  });

  it("spec-creation pipeline levels match expected execution order (equivalence)", () => {
    const { def } = loadPipeline(pipelinesYaml);
    const levels = pipelineLevels(def.steps);
    assert.deepEqual(
      levels,
      [["intake"], ["enrich"], ["critic", "security"], ["assemble"], ["approve"], ["persist"]],
      "pipelineLevels must return the canonical six-level execution order"
    );
  });

  it("throws on duplicate step ids", () => {
    const yaml = `
id: test
version: 1
description: test
inputs:
  - request
steps:
  - id: s1
    kind: gate
    message: ok?
  - id: s1
    kind: gate
    message: ok?
`;
    assert.throws(
      () =>
        loadPipeline("/fake/pipelines/test.yaml", {
          readFile: (p) => (p.endsWith(".yaml") ? yaml : ""),
        }),
      /[Dd]uplicate.*s1/
    );
  });

  it("throws on llm step without model or role", () => {
    const yaml = `
id: test
version: 1
description: test
inputs:
  - request
steps:
  - id: s1
    kind: llm
    prompt: prompts/intake.md
`;
    assert.throws(
      () =>
        loadPipeline("/fake/pipelines/test.yaml", {
          readFile: (p) => (p.endsWith(".yaml") ? yaml : "prompt content"),
        }),
      /s1.*model|model.*s1/
    );
  });

  it("throws on llm step with both role and model", () => {
    const yaml = `
id: test
version: 1
description: test
inputs:
  - request
steps:
  - id: s1
    kind: llm
    role: worker
    model: sonnet
    prompt: prompts/intake.md
`;
    assert.throws(
      () =>
        loadPipeline("/fake/pipelines/test.yaml", {
          readFile: (p) => (p.endsWith(".yaml") ? yaml : "prompt content"),
        }),
      /s1.*both role and model|cannot set both/
    );
  });

  it("throws on llm step with an unknown role", () => {
    const yaml = `
id: test
version: 1
description: test
inputs:
  - request
steps:
  - id: s1
    kind: llm
    role: overlord
    prompt: prompts/intake.md
`;
    assert.throws(
      () =>
        loadPipeline("/fake/pipelines/test.yaml", {
          readFile: (p) => (p.endsWith(".yaml") ? yaml : "prompt content"),
        }),
      /s1.*overlord|unknown role/
    );
  });

  it("accepts llm step with only a role (no model)", () => {
    const yaml = `
id: test
version: 1
description: test
inputs:
  - request
steps:
  - id: s1
    kind: llm
    role: worker
    prompt: prompts/intake.md
`;
    const { def } = loadPipeline("/fake/pipelines/test.yaml", {
      readFile: (p) => (p.endsWith(".yaml") ? yaml : "prompt content"),
    });
    assert.equal(def.steps[0].role, "worker");
    assert.equal(def.steps[0].model, undefined);
  });

  it("throws on role set on a non-llm step", () => {
    const yaml = `
id: test
version: 1
description: test
inputs:
  - request
steps:
  - id: g1
    kind: gate
    role: worker
    message: ok?
`;
    assert.throws(
      () =>
        loadPipeline("/fake/pipelines/test.yaml", {
          readFile: (p) => (p.endsWith(".yaml") ? yaml : ""),
        }),
      /g1.*role.*llm|role.*only.*llm/
    );
  });

  it("throws on missing prompt file", () => {
    const yaml = `
id: test
version: 1
description: test
inputs:
  - request
steps:
  - id: s1
    kind: llm
    model: sonnet
    prompt: prompts/nonexistent.md
`;
    assert.throws(
      () =>
        loadPipeline("/fake/pipelines/test.yaml", {
          readFile: (p) => {
            if (p.endsWith(".yaml")) return yaml;
            throw new Error("ENOENT");
          },
        }),
      /s1/
    );
  });

  it("rejects a prompt path that escapes the pipeline root via ../", () => {
    const yaml = `
id: test
version: 1
description: test
inputs:
  - request
steps:
  - id: s1
    kind: llm
    model: sonnet
    prompt: ../../../../.ssh/id_ed25519
`;
    assert.throws(
      () =>
        loadPipeline("/fake/pipelines/test.yaml", {
          readFile: (p) => (p.endsWith(".yaml") ? yaml : "prompt content"),
        }),
      (err: Error) => {
        assert.ok(err.message.includes("s1"), "error should name the step id");
        assert.ok(
          err.message.includes("escapes") || err.message.includes("outside"),
          "error should say it escapes the root"
        );
        return true;
      }
    );
  });

  it("accepts a legitimate nested prompt path inside the root", () => {
    const yaml = `
id: test
version: 1
description: test
inputs:
  - request
steps:
  - id: s1
    kind: llm
    model: sonnet
    prompt: prompts/nested/deep.md
`;
    const { prompts } = loadPipeline("/fake/pipelines/test.yaml", {
      readFile: (p) => (p.endsWith(".yaml") ? yaml : "prompt content"),
    });
    assert.equal(prompts.s1, "prompt content");
  });

  it("rejects a symlink that points outside the pipeline root", (t) => {
    const tmp = mkdtempSync(join(tmpdir(), "yoke-symlink-test-"));
    const outsideDir = join(tmp, "outside");
    const rootDir = join(tmp, "root");
    const promptsDir = join(rootDir, "prompts");
    const pipelinesDir = join(rootDir, "pipelines");
    try {
      mkdirSync(outsideDir);
      mkdirSync(promptsDir, { recursive: true });
      mkdirSync(pipelinesDir, { recursive: true });
      const secretPath = join(outsideDir, "secret.txt");
      writeFileSync(secretPath, "secret contents");
      try {
        symlinkSync(secretPath, join(promptsDir, "evil.md"));
      } catch {
        t.skip("symlink creation not permitted on this platform");
        return;
      }
      const yaml = `
id: test
version: 1
description: test
inputs:
  - request
steps:
  - id: s1
    kind: llm
    model: sonnet
    prompt: prompts/evil.md
`;
      writeFileSync(join(pipelinesDir, "test.yaml"), yaml);
      assert.throws(
        () => loadPipeline(join(pipelinesDir, "test.yaml")),
        (err: Error) => {
          assert.ok(err.message.includes("s1"), "error should name the step id");
          assert.ok(
            err.message.includes("symlink") || err.message.includes("outside"),
            "error should indicate symlink escape"
          );
          return true;
        }
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("throws on unknown schema", () => {
    const yaml = `
id: test
version: 1
description: test
inputs:
  - request
steps:
  - id: s1
    kind: llm
    model: sonnet
    prompt: prompts/intake.md
    schema: unknown
`;
    assert.throws(
      () =>
        loadPipeline("/fake/pipelines/test.yaml", {
          readFile: (p) => (p.endsWith(".yaml") ? yaml : "prompt content"),
        }),
      /s1.*unknown|unknown.*schema/
    );
  });

  it("loads a valid dependsOn pipeline", () => {
    const yaml = `
id: test
version: 1
description: test
inputs:
  - request
steps:
  - id: a
    kind: llm
    role: worker
    prompt: prompts/a.md
  - id: b
    kind: llm
    role: worker
    prompt: prompts/b.md
    dependsOn: [a]
  - id: c
    kind: llm
    role: worker
    prompt: prompts/c.md
    dependsOn: [b]
`;
    const { def } = loadPipeline("/fake/pipelines/test.yaml", {
      readFile: (p) => (p.endsWith(".yaml") ? yaml : "prompt content"),
    });
    assert.equal(def.steps.length, 3);
    assert.deepEqual(def.steps[1].dependsOn, ["a"]);
    assert.deepEqual(def.steps[2].dependsOn, ["b"]);
  });

  it("throws on a cycle in dependsOn, naming the members", () => {
    const yaml = `
id: test
version: 1
description: test
inputs:
  - request
steps:
  - id: a
    kind: llm
    role: worker
    prompt: prompts/a.md
    dependsOn: [b]
  - id: b
    kind: llm
    role: worker
    prompt: prompts/b.md
    dependsOn: [a]
`;
    assert.throws(
      () =>
        loadPipeline("/fake/pipelines/test.yaml", {
          readFile: (p) => (p.endsWith(".yaml") ? yaml : "prompt content"),
        }),
      (err: Error) => {
        assert.ok(err.message.includes("cycle"), "error must mention 'cycle'");
        assert.ok(err.message.includes("a"), "error must name step 'a'");
        assert.ok(err.message.includes("b"), "error must name step 'b'");
        return true;
      }
    );
  });

  it("throws when dependsOn references an unknown step id", () => {
    const yaml = `
id: test
version: 1
description: test
inputs:
  - request
steps:
  - id: a
    kind: llm
    role: worker
    prompt: prompts/a.md
  - id: b
    kind: llm
    role: worker
    prompt: prompts/b.md
    dependsOn: [nonexistent]
`;
    assert.throws(
      () =>
        loadPipeline("/fake/pipelines/test.yaml", {
          readFile: (p) => (p.endsWith(".yaml") ? yaml : "prompt content"),
        }),
      /nonexistent|unknown/
    );
  });

  it("loads a pipeline using neither phase nor dependsOn (plain sequential)", () => {
    const yaml = `
id: test
version: 1
description: test
inputs:
  - request
steps:
  - id: g1
    kind: gate
    message: approve?
`;
    const { def } = loadPipeline("/fake/pipelines/test.yaml", {
      readFile: (p) => (p.endsWith(".yaml") ? yaml : ""),
    });
    assert.equal(def.steps.length, 1);
    assert.equal(def.steps[0].dependsOn, undefined);
  });

  it("rejects an invalid workspace value on a step", () => {
    const yaml = `
id: test
version: 1
description: test
inputs:
  - request
steps:
  - id: s1
    kind: llm
    model: sonnet
    prompt: prompts/intake.md
    workspace: write
`;
    assert.throws(
      () =>
        loadPipeline("/fake/pipelines/test.yaml", {
          readFile: (p) => (p.endsWith(".yaml") ? yaml : "prompt content"),
        }),
      (err: Error) => {
        assert.ok(err.message.includes("s1"), "error must name the step id");
        assert.ok(
          err.message.toLowerCase().includes("workspace") || err.message.includes("write"),
          "error must reference the invalid workspace value"
        );
        return true;
      }
    );
  });

  it('accepts workspace: "read" on a step and preserves it in the definition', () => {
    const yaml = `
id: test
version: 1
description: test
inputs:
  - request
steps:
  - id: s1
    kind: llm
    model: sonnet
    prompt: prompts/intake.md
    workspace: read
`;
    const { def } = loadPipeline("/fake/pipelines/test.yaml", {
      readFile: (p) => (p.endsWith(".yaml") ? yaml : "prompt content"),
    });
    assert.equal(def.steps[0].workspace, "read");
  });

  it("loads a pipeline with two gates without throwing", () => {
    const yaml = `
id: test
version: 1
description: test
inputs:
  - request
steps:
  - id: gate1
    kind: gate
    message: first gate?
  - id: gate2
    kind: gate
    message: second gate?
`;
    const { def } = loadPipeline("/fake/pipelines/test.yaml", {
      readFile: (p) => (p.endsWith(".yaml") ? yaml : ""),
    });
    assert.equal(def.steps.length, 2);
    assert.equal(def.steps.filter((s) => s.kind === "gate").length, 2);
  });

  it("loads a dependsOn pipeline that contains an isolated step (no edges in or out)", () => {
    // An isolated step is valid: pipelineLevels places it at level 0 and execution
    // is well-defined. Rejecting it would make in-progress editor state unsaveable
    // (FR-007/FR-008). This test pins that decision so the rule is not reintroduced.
    const yaml = `
id: test
version: 1
description: test
inputs:
  - request
steps:
  - id: a
    kind: llm
    role: worker
    prompt: prompts/a.md
  - id: b
    kind: llm
    role: worker
    prompt: prompts/b.md
    dependsOn: [a]
  - id: isolated
    kind: llm
    role: worker
    prompt: prompts/isolated.md
`;
    const { def } = loadPipeline("/fake/pipelines/test.yaml", {
      readFile: (p) => (p.endsWith(".yaml") ? yaml : "prompt content"),
    });
    assert.equal(def.steps.length, 3);
    const iso = def.steps.find((s) => s.id === "isolated");
    assert.ok(iso, "isolated step should be present");
    assert.equal(iso?.dependsOn, undefined);
  });
});

describe("renderPrompt", () => {
  it("substitutes all placeholders", () => {
    const result = renderPrompt("Hello {{name}}, you are {{role}}.", {
      name: "Alice",
      role: "admin",
    });
    assert.equal(result, "Hello Alice, you are admin.");
  });

  it("throws when a placeholder has no var", () => {
    assert.throws(() => renderPrompt("Hello {{name}}.", {}), /name/);
  });

  it("ignores extra vars that are unused", () => {
    const result = renderPrompt("Hello {{name}}.", { name: "Bob", extra: "x" });
    assert.equal(result, "Hello Bob.");
  });
});

describe("assembleSpec", () => {
  const intake = `# T

A feature description.

## Requirements
- Req 1
- Req 2

## Acceptance Criteria
- AC 1
- AC 2
`;

  const enrich = `## Enrichment additions
- Edge case 1
`;

  it("produces correct HardenedSpec from canned inputs", () => {
    const spec = assembleSpec({
      intake,
      enrich,
      critic: {
        weaknesses: [{ text: "Ambiguous requirement", severity: "medium", blocking: false }],
      },
      security: {
        securityFindings: [{ text: "No auth check", severity: "high", blocking: true }],
      },
    });

    assert.equal(spec.title, "T");
    assert.deepEqual(spec.requirements, ["Req 1", "Req 2"]);
    assert.deepEqual(spec.acceptanceCriteria, ["AC 1", "AC 2"]);
    assert.equal(spec.description, intake + "\n\n" + enrich);
    assert.equal(spec.weaknesses?.length, 1);
    assert.equal(spec.weaknesses?.[0].text, "Ambiguous requirement");
    assert.equal(spec.securityFindings?.length, 1);
    assert.equal(spec.securityFindings?.[0].blocking, true);
  });
});

// ---------------------------------------------------------------------------
// loop step validation
// ---------------------------------------------------------------------------

describe("loadPipeline — loop step validation", () => {
  function makeLoopYaml(overrides: string): string {
    return `
id: test
version: 1
description: test
inputs:
  - request
steps:
  - id: converge
    kind: loop
${overrides}
`;
  }

  it("loads a valid loop step pipeline without throwing", () => {
    const bodyYaml = `
id: build-round
version: 1
description: body
inputs:
  - request
steps:
  - id: eval
    kind: llm
    role: worker
    prompt: prompts/eval.md
`;
    const { def } = loadPipeline("/fake/pipelines/test.yaml", {
      readFile: (p) => {
        if (p.endsWith("test.yaml"))
          return makeLoopYaml("    pipeline: build-round\n    maxIterations: 3\n    until: passed");
        if (p.endsWith("build-round.yaml")) return bodyYaml;
        return "prompt content";
      },
    });
    assert.equal(def.steps[0].kind, "loop");
    assert.equal(def.steps[0].maxIterations, 3);
    assert.equal(def.steps[0].until, "passed");
  });

  it("throws when loop step is missing pipeline", () => {
    assert.throws(
      () =>
        loadPipeline("/fake/pipelines/test.yaml", {
          readFile: (p) =>
            p.endsWith(".yaml")
              ? makeLoopYaml("    maxIterations: 3\n    until: passed")
              : "prompt content",
        }),
      /converge.*requires pipeline|loop step requires pipeline/
    );
  });

  it("throws when loop step is missing maxIterations", () => {
    assert.throws(
      () =>
        loadPipeline("/fake/pipelines/test.yaml", {
          readFile: (p) =>
            p.endsWith(".yaml")
              ? makeLoopYaml("    pipeline: build-round\n    until: passed")
              : "prompt content",
        }),
      /maxIterations/
    );
  });

  it("throws when loop step has maxIterations of zero", () => {
    assert.throws(
      () =>
        loadPipeline("/fake/pipelines/test.yaml", {
          readFile: (p) =>
            p.endsWith(".yaml")
              ? makeLoopYaml("    pipeline: build-round\n    maxIterations: 0\n    until: passed")
              : "prompt content",
        }),
      /maxIterations/
    );
  });

  it("throws when loop step has negative maxIterations", () => {
    assert.throws(
      () =>
        loadPipeline("/fake/pipelines/test.yaml", {
          readFile: (p) =>
            p.endsWith(".yaml")
              ? makeLoopYaml("    pipeline: build-round\n    maxIterations: -1\n    until: passed")
              : "prompt content",
        }),
      /maxIterations/
    );
  });

  it("throws when loop step is missing until", () => {
    assert.throws(
      () =>
        loadPipeline("/fake/pipelines/test.yaml", {
          readFile: (p) =>
            p.endsWith(".yaml")
              ? makeLoopYaml("    pipeline: build-round\n    maxIterations: 3")
              : "prompt content",
        }),
      /until/
    );
  });

  it("throws when loop step has a forbidden field (prompt)", () => {
    assert.throws(
      () =>
        loadPipeline("/fake/pipelines/test.yaml", {
          readFile: (p) =>
            p.endsWith(".yaml")
              ? makeLoopYaml(
                  "    pipeline: build-round\n    maxIterations: 3\n    until: passed\n    prompt: prompts/x.md"
                )
              : "prompt content",
        }),
      /prompt/
    );
  });
});
