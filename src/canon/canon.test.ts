import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
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
    // 4 llm + assemble + 3 (verify.*) + 1 (correct.revise) + approve + persist + export = 12
    assert.equal(def.steps.length, 12);

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
      [
        ["intake"],
        ["enrich"],
        ["critic", "security"],
        ["assemble"],
        ["verify.correctness", "verify.security"],
        ["verify.synthesis"],
        ["correct.revise"],
        ["approve"],
        ["persist"],
        ["export"],
      ],
      "pipelineLevels must return the canonical ten-level execution order"
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
    const tmp = mkdtempSync(join(tmpdir(), "agent-flows-symlink-test-"));
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

  it("rejects a deprecated workspace: key on a step (migration error)", () => {
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
    assert.throws(
      () =>
        loadPipeline("/fake/pipelines/test.yaml", {
          readFile: (p) => (p.endsWith(".yaml") ? yaml : "prompt content"),
        }),
      (err: Error) => {
        assert.ok(err.message.includes("s1"), "migration error must name the step id");
        assert.ok(
          err.message.includes("workspace") && err.message.includes("permissions"),
          `migration error must mention both "workspace" and "permissions"; got: ${err.message}`
        );
        return true;
      }
    );
  });

  it("rejects an invalid permissions.contents value on a step", () => {
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
    permissions:
      contents: admin
`;
    assert.throws(
      () =>
        loadPipeline("/fake/pipelines/test.yaml", {
          readFile: (p) => (p.endsWith(".yaml") ? yaml : "prompt content"),
        }),
      (err: Error) => {
        assert.ok(err.message.includes("s1"), "error must name the step id");
        assert.ok(
          err.message.includes("permissions") || err.message.includes("admin"),
          "error must reference the invalid permissions value"
        );
        return true;
      }
    );
  });

  it("rejects an unknown scope in permissions (only contents is allowed)", () => {
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
    permissions:
      packages: read
`;
    assert.throws(
      () =>
        loadPipeline("/fake/pipelines/test.yaml", {
          readFile: (p) => (p.endsWith(".yaml") ? yaml : "prompt content"),
        }),
      (err: Error) => {
        assert.ok(err.message.includes("s1"), "error must name the step id");
        assert.ok(
          err.message.includes("packages") || err.message.includes("unknown scope"),
          `error must name the unknown scope; got: ${err.message}`
        );
        return true;
      }
    );
  });

  it('accepts permissions.contents: "read" on a step and preserves it in the definition', () => {
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
    permissions:
      contents: read
`;
    const { def } = loadPipeline("/fake/pipelines/test.yaml", {
      readFile: (p) => (p.endsWith(".yaml") ? yaml : "prompt content"),
    });
    assert.deepEqual(def.steps[0].permissions, { contents: "read" });
  });

  it('accepts permissions.contents: "write" on a step and preserves it in the definition', () => {
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
    permissions:
      contents: write
`;
    const { def } = loadPipeline("/fake/pipelines/test.yaml", {
      readFile: (p) => (p.endsWith(".yaml") ? yaml : "prompt content"),
    });
    assert.deepEqual(def.steps[0].permissions, { contents: "write" });
  });

  it('accepts permissions.contents: "none" on a step (explicit no-access)', () => {
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
    permissions:
      contents: none
`;
    const { def } = loadPipeline("/fake/pipelines/test.yaml", {
      readFile: (p) => (p.endsWith(".yaml") ? yaml : "prompt content"),
    });
    assert.deepEqual(def.steps[0].permissions, { contents: "none" });
  });

  it("rejects permissions: on a gate step (permissions is only allowed on llm steps)", () => {
    const yaml = `
id: test
version: 1
description: test
inputs:
  - request
steps:
  - id: g1
    kind: gate
    message: Approve?
    permissions:
      contents: read
`;
    assert.throws(
      () =>
        loadPipeline("/fake/pipelines/test.yaml", {
          readFile: (p) => (p.endsWith(".yaml") ? yaml : ""),
        }),
      (err: Error) => {
        assert.ok(err.message.includes("g1"), `error must name step id "g1"; got: ${err.message}`);
        assert.ok(
          err.message.toLowerCase().includes("permissions"),
          `error must mention permissions; got: ${err.message}`
        );
        return true;
      }
    );
  });

  it("rejects permissions.allow without permissions.contents", () => {
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
    permissions:
      allow:
        - "**/*.pem"
`;
    assert.throws(
      () =>
        loadPipeline("/fake/pipelines/test.yaml", {
          readFile: (p) => (p.endsWith(".yaml") ? yaml : "prompt content"),
        }),
      (err: Error) => {
        assert.ok(err.message.includes("s1"), `error must name step id; got: ${err.message}`);
        assert.ok(
          err.message.includes("allow") && err.message.includes("contents"),
          `error must mention allow and contents; got: ${err.message}`
        );
        return true;
      }
    );
  });

  it("rejects permissions.deny without permissions.contents", () => {
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
    permissions:
      deny:
        - "src/internal/**"
`;
    assert.throws(
      () =>
        loadPipeline("/fake/pipelines/test.yaml", {
          readFile: (p) => (p.endsWith(".yaml") ? yaml : "prompt content"),
        }),
      (err: Error) => {
        assert.ok(err.message.includes("s1"), `error must name step id; got: ${err.message}`);
        assert.ok(
          err.message.includes("deny") && err.message.includes("contents"),
          `error must mention deny and contents; got: ${err.message}`
        );
        return true;
      }
    );
  });

  it("rejects permissions.allow that is an empty array", () => {
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
    permissions:
      contents: read
      allow: []
`;
    assert.throws(
      () =>
        loadPipeline("/fake/pipelines/test.yaml", {
          readFile: (p) => (p.endsWith(".yaml") ? yaml : "prompt content"),
        }),
      /s1.*allow|allow.*s1/
    );
  });

  it("rejects permissions.deny that is an empty array", () => {
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
    permissions:
      contents: read
      deny: []
`;
    assert.throws(
      () =>
        loadPipeline("/fake/pipelines/test.yaml", {
          readFile: (p) => (p.endsWith(".yaml") ? yaml : "prompt content"),
        }),
      /s1.*deny|deny.*s1/
    );
  });

  it("rejects permissions.allow with a blank string entry", () => {
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
    permissions:
      contents: read
      allow:
        - "  "
`;
    assert.throws(
      () =>
        loadPipeline("/fake/pipelines/test.yaml", {
          readFile: (p) => (p.endsWith(".yaml") ? yaml : "prompt content"),
        }),
      /s1.*allow|allow.*s1/
    );
  });

  it("accepts permissions.allow and .deny on an llm step and preserves them in the definition", () => {
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
    permissions:
      contents: read
      allow:
        - "**/*.pem"
      deny:
        - "src/internal/**"
`;
    const { def } = loadPipeline("/fake/pipelines/test.yaml", {
      readFile: (p) => (p.endsWith(".yaml") ? yaml : "prompt content"),
    });
    assert.deepEqual(def.steps[0].permissions, {
      contents: "read",
      allow: ["**/*.pem"],
      deny: ["src/internal/**"],
    });
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

  it("loads a valid export-spec step without throwing", () => {
    const yaml = `
id: test
version: 1
description: test
inputs:
  - request
steps:
  - id: exp
    kind: export-spec
    path: specs/my-feature
`;
    const { def } = loadPipeline("/fake/pipelines/test.yaml", {
      readFile: (p) => (p.endsWith(".yaml") ? yaml : ""),
    });
    assert.equal(def.steps[0].kind, "export-spec");
    assert.equal(def.steps[0].path, "specs/my-feature");
  });

  it("throws when export-spec step is missing path", () => {
    const yaml = `
id: test
version: 1
description: test
inputs:
  - request
steps:
  - id: exp
    kind: export-spec
`;
    assert.throws(
      () =>
        loadPipeline("/fake/pipelines/test.yaml", {
          readFile: (p) => (p.endsWith(".yaml") ? yaml : ""),
        }),
      (err: Error) => {
        assert.ok(err.message.includes("exp"), `error must name the step id; got: ${err.message}`);
        assert.ok(err.message.includes("path"), `error must mention "path"; got: ${err.message}`);
        return true;
      }
    );
  });

  for (const forbiddenField of ["prompt", "model", "schema", "permissions", "role"] as const) {
    it(`throws when export-spec step sets forbidden field "${forbiddenField}"`, () => {
      const fieldYaml: Record<string, string> = {
        prompt: "    prompt: prompts/intake.md",
        model: "    model: sonnet",
        schema: "    schema: weaknesses",
        permissions: "    permissions:\n      contents: read",
        role: "    role: worker",
      };
      const yaml = `
id: test
version: 1
description: test
inputs:
  - request
steps:
  - id: exp
    kind: export-spec
    path: specs/my-feature
${fieldYaml[forbiddenField]}
`;
      assert.throws(
        () =>
          loadPipeline("/fake/pipelines/test.yaml", {
            readFile: (p) => (p.endsWith(".yaml") ? yaml : "prompt content"),
          }),
        (err: Error) => {
          assert.ok(
            err.message.includes("exp"),
            `error must name step id for field "${forbiddenField}"; got: ${err.message}`
          );
          return true;
        }
      );
    });
  }

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
// skills field validation
// ---------------------------------------------------------------------------

describe("loadPipeline — skills field validation", () => {
  it("rejects skills on a non-llm step (same mechanism as permissions)", () => {
    const yaml = `
id: test
version: 1
description: test
inputs:
  - request
steps:
  - id: g1
    kind: gate
    message: Approve?
    skills:
      - git
`;
    assert.throws(
      () =>
        loadPipeline("/fake/pipelines/test.yaml", {
          readFile: (p) => (p.endsWith(".yaml") ? yaml : ""),
        }),
      (err: Error) => {
        assert.ok(err.message.includes("g1"), `error must name step id; got: ${err.message}`);
        assert.ok(
          err.message.toLowerCase().includes("skills"),
          `error must mention skills; got: ${err.message}`
        );
        return true;
      }
    );
  });

  it("rejects an empty skills array on an llm step", () => {
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
    skills: []
`;
    assert.throws(
      () =>
        loadPipeline("/fake/pipelines/test.yaml", {
          readFile: (p) => (p.endsWith(".yaml") ? yaml : "prompt content"),
        }),
      (err: Error) => {
        assert.ok(err.message.includes("s1"), `error must name step id; got: ${err.message}`);
        assert.ok(
          err.message.toLowerCase().includes("empty") ||
            err.message.toLowerCase().includes("skills"),
          `error must mention empty/skills; got: ${err.message}`
        );
        return true;
      }
    );
  });

  it("rejects a blank entry in skills", () => {
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
    skills:
      - git
      - "   "
`;
    assert.throws(
      () =>
        loadPipeline("/fake/pipelines/test.yaml", {
          readFile: (p) => (p.endsWith(".yaml") ? yaml : "prompt content"),
        }),
      (err: Error) => {
        assert.ok(err.message.includes("s1"), `error must name step id; got: ${err.message}`);
        assert.ok(
          err.message.toLowerCase().includes("blank") ||
            err.message.toLowerCase().includes("skills"),
          `error must mention blank/skills; got: ${err.message}`
        );
        return true;
      }
    );
  });

  it("accepts a valid skills array on an llm step and preserves it in the definition", () => {
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
    skills:
      - git
      - chrome-test
`;
    const { def } = loadPipeline("/fake/pipelines/test.yaml", {
      readFile: (p) => (p.endsWith(".yaml") ? yaml : "prompt content"),
    });
    assert.deepEqual(def.steps[0].skills, ["git", "chrome-test"]);
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

// ---------------------------------------------------------------------------
// check step validation
// ---------------------------------------------------------------------------

describe("loadPipeline — check step validation", () => {
  function makeCheckYaml(overrides: string): string {
    return `
id: test
version: 1
description: test
inputs:
  - request
steps:
  - id: verify
    kind: check
${overrides}
`;
  }

  it("loads a valid check step without throwing", () => {
    const { def } = loadPipeline("/fake/pipelines/test.yaml", {
      readFile: (p) => (p.endsWith(".yaml") ? makeCheckYaml("    command: pnpm test") : ""),
    });
    assert.equal(def.steps[0].kind, "check");
    assert.equal(def.steps[0].command, "pnpm test");
  });

  it("throws when check step is missing command", () => {
    assert.throws(
      () =>
        loadPipeline("/fake/pipelines/test.yaml", {
          readFile: (p) => (p.endsWith(".yaml") ? makeCheckYaml("") : ""),
        }),
      /command/
    );
  });

  it("throws when check step has an empty command", () => {
    assert.throws(
      () =>
        loadPipeline("/fake/pipelines/test.yaml", {
          readFile: (p) => (p.endsWith(".yaml") ? makeCheckYaml("    command: ''") : ""),
        }),
      /command/
    );
  });

  it("throws when check step has prompt set", () => {
    assert.throws(
      () =>
        loadPipeline("/fake/pipelines/test.yaml", {
          readFile: (p) =>
            p.endsWith(".yaml")
              ? makeCheckYaml("    command: pnpm test\n    prompt: prompts/x.md")
              : "prompt content",
        }),
      /prompt/
    );
  });

  it("throws when check step has role set", () => {
    assert.throws(
      () =>
        loadPipeline("/fake/pipelines/test.yaml", {
          readFile: (p) =>
            p.endsWith(".yaml") ? makeCheckYaml("    command: pnpm test\n    role: worker") : "",
        }),
      /role/
    );
  });

  it("throws when check step has model set", () => {
    assert.throws(
      () =>
        loadPipeline("/fake/pipelines/test.yaml", {
          readFile: (p) =>
            p.endsWith(".yaml") ? makeCheckYaml("    command: pnpm test\n    model: sonnet") : "",
        }),
      /model/
    );
  });

  it("throws when check step has schema set", () => {
    assert.throws(
      () =>
        loadPipeline("/fake/pipelines/test.yaml", {
          readFile: (p) =>
            p.endsWith(".yaml")
              ? makeCheckYaml("    command: pnpm test\n    schema: weaknesses")
              : "",
        }),
      /schema/
    );
  });

  it("throws when check step has permissions set", () => {
    assert.throws(
      () =>
        loadPipeline("/fake/pipelines/test.yaml", {
          readFile: (p) =>
            p.endsWith(".yaml")
              ? makeCheckYaml("    command: pnpm test\n    permissions:\n      contents: read")
              : "",
        }),
      /permissions/
    );
  });

  // env field validation tests — MUST FAIL before load.ts validates the env field.
  // Currently load.ts ignores env on check steps, so malformed values are silently
  // accepted instead of rejected. After the fix, each of these throws.
  it("loads a valid check step with a declared env field", () => {
    const { def } = loadPipeline("/fake/pipelines/test.yaml", {
      readFile: (p) =>
        p.endsWith(".yaml")
          ? makeCheckYaml("    command: pnpm test\n    env:\n      - GH_TOKEN")
          : "",
    });
    assert.deepEqual(def.steps[0].env, ["GH_TOKEN"]);
  });

  it("throws when check step env contains a non-string entry", () => {
    // This MUST FAIL before the fix: load.ts currently ignores env entirely,
    // so this call succeeds instead of throwing.
    assert.throws(
      () =>
        loadPipeline("/fake/pipelines/test.yaml", {
          readFile: (p) =>
            p.endsWith(".yaml")
              ? makeCheckYaml("    command: pnpm test\n    env:\n      - 123")
              : "",
        }),
      /env/
    );
  });

  it("throws when check step env is an empty array", () => {
    // This MUST FAIL before the fix: load.ts currently ignores env entirely.
    assert.throws(
      () =>
        loadPipeline("/fake/pipelines/test.yaml", {
          readFile: (p) =>
            p.endsWith(".yaml") ? makeCheckYaml("    command: pnpm test\n    env: []") : "",
        }),
      /env/
    );
  });

  it("throws when check step env contains a blank string", () => {
    assert.throws(
      () =>
        loadPipeline("/fake/pipelines/test.yaml", {
          readFile: (p) =>
            p.endsWith(".yaml")
              ? makeCheckYaml("    command: pnpm test\n    env:\n      - ''")
              : "",
        }),
      /env/
    );
  });

  it("throws when check step env contains an invalid variable name", () => {
    assert.throws(
      () =>
        loadPipeline("/fake/pipelines/test.yaml", {
          readFile: (p) =>
            p.endsWith(".yaml")
              ? makeCheckYaml("    command: pnpm test\n    env:\n      - 123BADNAME")
              : "",
        }),
      /env/
    );
  });

  it("loads a check step with command containing {{checkCommand}} without throwing", () => {
    const { def } = loadPipeline("/fake/pipelines/test.yaml", {
      readFile: (p) =>
        p.endsWith(".yaml") ? makeCheckYaml('    command: "{{checkCommand}}"') : "",
    });
    assert.equal(def.steps[0].command, "{{checkCommand}}");
  });

  it("loads a check step with no braces in command without throwing (byte-identical pass-through)", () => {
    const { def } = loadPipeline("/fake/pipelines/test.yaml", {
      readFile: (p) =>
        p.endsWith(".yaml") ? makeCheckYaml("    command: pnpm lint && pnpm typecheck") : "",
    });
    assert.equal(def.steps[0].command, "pnpm lint && pnpm typecheck");
  });

  it("throws when check step command contains an unknown placeholder", () => {
    // {{other}} is not a recognised placeholder — should be a load error naming
    // the step and the placeholder, not a silent pass-through to /bin/sh.
    assert.throws(
      () =>
        loadPipeline("/fake/pipelines/test.yaml", {
          readFile: (p) => (p.endsWith(".yaml") ? makeCheckYaml('    command: "{{other}}"') : ""),
        }),
      (err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        assert.ok(msg.includes("verify"), `error must name the step; got: ${msg}`);
        assert.ok(msg.includes("other"), `error must name the placeholder; got: ${msg}`);
        return true;
      }
    );
  });

  it("throws when check step command mixes {{checkCommand}} with an unknown placeholder", () => {
    assert.throws(
      () =>
        loadPipeline("/fake/pipelines/test.yaml", {
          readFile: (p) =>
            p.endsWith(".yaml")
              ? makeCheckYaml('    command: "echo {{checkCommand}} {{other}}"')
              : "",
        }),
      (err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        assert.ok(msg.includes("other"), `error must name the unknown placeholder; got: ${msg}`);
        return true;
      }
    );
  });

  it("throws when a non-check step kind has env set", () => {
    // env is only valid on check steps. gate steps must reject it.
    // This MUST FAIL before the fix: load.ts currently doesn't check env on gate steps.
    assert.throws(
      () =>
        loadPipeline("/fake/pipelines/test.yaml", {
          readFile: (p) =>
            p.endsWith(".yaml")
              ? `
id: test
version: 1
description: test
inputs:
  - request
steps:
  - id: approve
    kind: gate
    env:
      - GH_TOKEN
`
              : "",
        }),
      /env/
    );
  });
});

// ---------------------------------------------------------------------------
// prompt placeholder validation
// ---------------------------------------------------------------------------

describe("loadPipeline — prompt placeholder validation", () => {
  it("loads fine when a prompt references only a declared input", () => {
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
    prompt: prompts/s1.md
`;
    const { prompts } = loadPipeline("/fake/pipelines/test.yaml", {
      readFile: (p) => (p.endsWith(".yaml") ? yaml : "Hello {{request}}"),
    });
    assert.equal(prompts.s1, "Hello {{request}}");
  });

  it("loads fine when a prompt references an ancestor step id", () => {
    const yaml = `
id: test
version: 1
description: test
inputs:
  - request
steps:
  - id: survey
    kind: llm
    model: sonnet
    prompt: prompts/survey.md
  - id: findings
    kind: llm
    model: sonnet
    prompt: prompts/findings.md
    dependsOn: [survey]
`;
    const { prompts } = loadPipeline("/fake/pipelines/test.yaml", {
      readFile: (p) => {
        if (p.endsWith("test.yaml")) return yaml;
        if (p.includes("survey")) return "Request: {{request}}";
        return "Based on {{survey}}";
      },
    });
    assert.equal(prompts.findings, "Based on {{survey}}");
  });

  it("throws when a prompt references an unknown placeholder", () => {
    const yaml = `
id: test
version: 1
description: test
inputs:
  - request
steps:
  - id: findings
    kind: llm
    model: sonnet
    prompt: prompts/findings.md
`;
    assert.throws(
      () =>
        loadPipeline("/fake/pipelines/test.yaml", {
          readFile: (p) => (p.endsWith(".yaml") ? yaml : "Based on {{servey}}"),
        }),
      (err: Error) => {
        assert.ok(err.message.includes("findings"), "error names the step");
        assert.ok(err.message.includes("servey"), "error names the bad placeholder");
        assert.ok(err.message.includes("available"), "error lists available keys");
        return true;
      }
    );
  });

  it("throws when a prompt references a sibling step id (non-ancestor)", () => {
    // survey and findings are siblings at level 0 — neither is an ancestor of the other
    const yaml = `
id: test
version: 1
description: test
inputs:
  - request
steps:
  - id: survey
    kind: llm
    model: sonnet
    prompt: prompts/survey.md
  - id: findings
    kind: llm
    model: sonnet
    prompt: prompts/findings.md
`;
    assert.throws(
      () =>
        loadPipeline("/fake/pipelines/test.yaml", {
          readFile: (p) => {
            if (p.endsWith("test.yaml")) return yaml;
            if (p.includes("survey")) return "Request: {{request}}";
            // findings references survey but survey is not an ancestor
            return "Based on {{survey}}";
          },
        }),
      (err: Error) => {
        assert.ok(err.message.includes("findings"), "error names the step");
        assert.ok(err.message.includes("survey"), "error names the bad placeholder");
        return true;
      }
    );
  });

  it("throws when a prompt references a later step id (not yet computed)", () => {
    const yaml = `
id: test
version: 1
description: test
inputs:
  - request
steps:
  - id: early
    kind: llm
    model: sonnet
    prompt: prompts/early.md
  - id: late
    kind: llm
    model: sonnet
    prompt: prompts/late.md
    dependsOn: [early]
`;
    assert.throws(
      () =>
        loadPipeline("/fake/pipelines/test.yaml", {
          readFile: (p) => {
            if (p.endsWith("test.yaml")) return yaml;
            // early references late, which has not run yet
            if (p.includes("early")) return "Peek at {{late}}";
            return "Output";
          },
        }),
      (err: Error) => {
        assert.ok(err.message.includes("early"), "error names the offending step");
        assert.ok(err.message.includes("late"), "error names the bad placeholder");
        return true;
      }
    );
  });

  it("validates a dotted placeholder referencing a nested pipeline step output", () => {
    // A step in the parent pipeline may reference {{foo.bar}} where foo is a nested
    // pipeline step id and bar is a step inside it. After expansion, foo.bar is a
    // real step id in the flat step list and the regex fix allows dots in placeholders.
    const innerYaml = `
id: inner
version: 1
description: inner
inputs: []
steps:
  - id: bar
    kind: llm
    role: worker
    prompt: prompts/bar.md
`;
    const outerYaml = `
id: outer
version: 1
description: outer
inputs: []
steps:
  - id: foo
    kind: pipeline
    pipeline: inner
  - id: consumer
    kind: llm
    role: worker
    prompt: prompts/consumer.md
    dependsOn: [foo]
`;
    const { prompts } = loadPipeline("/fake/pipelines/outer.yaml", {
      readFile: (p) => {
        if (p.endsWith("outer.yaml")) return outerYaml;
        if (p.endsWith("inner.yaml")) return innerYaml;
        if (p.includes("consumer")) return "Result: {{foo.bar}}";
        return "prompt content";
      },
    });
    assert.ok(prompts.consumer.includes("{{foo.bar}}"), "dotted placeholder should be present");
  });

  it("throws when a prompt references an unknown dotted placeholder", () => {
    const innerYaml = `
id: inner
version: 1
description: inner
inputs: []
steps:
  - id: bar
    kind: llm
    role: worker
    prompt: prompts/bar.md
`;
    const outerYaml = `
id: outer
version: 1
description: outer
inputs: []
steps:
  - id: foo
    kind: pipeline
    pipeline: inner
  - id: consumer
    kind: llm
    role: worker
    prompt: prompts/consumer.md
    dependsOn: [foo]
`;
    assert.throws(
      () =>
        loadPipeline("/fake/pipelines/outer.yaml", {
          readFile: (p) => {
            if (p.endsWith("outer.yaml")) return outerYaml;
            if (p.endsWith("inner.yaml")) return innerYaml;
            if (p.includes("consumer")) return "Result: {{foo.nonexistent}}";
            return "prompt content";
          },
        }),
      (err: Error) => {
        assert.ok(err.message.includes("consumer"), "error names the step");
        assert.ok(err.message.includes("nonexistent"), "error names the bad placeholder");
        return true;
      }
    );
  });

  it("error message names the step, the placeholder, and what is available", () => {
    const yaml = `
id: test
version: 1
description: test
inputs:
  - request
steps:
  - id: survey
    kind: llm
    model: sonnet
    prompt: prompts/survey.md
  - id: findings
    kind: llm
    model: sonnet
    prompt: prompts/findings.md
    dependsOn: [survey]
`;
    assert.throws(
      () =>
        loadPipeline("/fake/pipelines/test.yaml", {
          readFile: (p) => {
            if (p.endsWith("test.yaml")) return yaml;
            if (p.includes("survey")) return "{{request}}";
            return "{{servey}}"; // typo
          },
        }),
      (err: Error) => {
        assert.ok(err.message.includes("findings"), "names the step");
        assert.ok(err.message.includes("servey"), "names the bad placeholder");
        // available should include the input and the ancestor
        assert.ok(err.message.includes("request"), "lists pipeline input");
        assert.ok(err.message.includes("survey"), "lists ancestor step id");
        return true;
      }
    );
  });
});

// ---------------------------------------------------------------------------
// permissions.allow matchability validation
// ---------------------------------------------------------------------------

describe("loadPipeline — permissions.allow matchability", () => {
  function makeLlmYaml(permissionsBlock: string): string {
    return `
id: test
version: 1
description: test
inputs:
  - request
steps:
  - id: s1
    kind: llm
    model: sonnet
    prompt: prompts/s1.md
    permissions:
${permissionsBlock}
`;
  }

  it("throws when an allow entry matches no deny pattern, naming step, entry, and hint", () => {
    const yaml = makeLlmYaml(
      "      contents: read\n      allow:\n        - totally-unknown-file.xyz"
    );
    assert.throws(
      () =>
        loadPipeline("/fake/pipelines/test.yaml", {
          readFile: (p) => (p.endsWith(".yaml") ? yaml : "prompt content"),
        }),
      (err: Error) => {
        assert.ok(err.message.includes("s1"), `error must name the step; got: ${err.message}`);
        assert.ok(
          err.message.includes("totally-unknown-file.xyz"),
          `error must name the entry; got: ${err.message}`
        );
        assert.ok(
          err.message.includes("did you mean") || err.message.includes("available patterns"),
          `error must include a hint; got: ${err.message}`
        );
        return true;
      }
    );
  });

  it("loads fine when an allow entry exactly matches a project-default deny pattern", () => {
    const yaml = makeLlmYaml('      contents: read\n      allow:\n        - "**/.env.local"');
    const { def } = loadPipeline("/fake/pipelines/test.yaml", {
      readFile: (p) => (p.endsWith(".yaml") ? yaml : "prompt content"),
    });
    assert.deepEqual(def.steps[0].permissions?.allow, ["**/.env.local"]);
  });

  it("loads fine when an allow entry matches the step's own deny entry", () => {
    const yaml = makeLlmYaml(
      "      contents: read\n      deny:\n        - src/private/**\n      allow:\n        - src/private/**"
    );
    const { def } = loadPipeline("/fake/pipelines/test.yaml", {
      readFile: (p) => (p.endsWith(".yaml") ? yaml : "prompt content"),
    });
    assert.deepEqual(def.steps[0].permissions?.allow, ["src/private/**"]);
  });

  it("convenient form: .env.local matches **/.env.local and loads fine (no ** prefix needed)", () => {
    // Operators should not need to know the exact glob prefix; the trailing-segment
    // match accepts ".env.local" as equivalent to "**/.env.local". This is safe
    // because the removal is bounded to that exact deny pattern — no broader access
    // is silently granted than the operator intended.
    const yaml = makeLlmYaml("      contents: read\n      allow:\n        - .env.local");
    const { def } = loadPipeline("/fake/pipelines/test.yaml", {
      readFile: (p) => (p.endsWith(".yaml") ? yaml : "prompt content"),
    });
    assert.deepEqual(def.steps[0].permissions?.allow, [".env.local"]);
  });
});

describe("loadPipeline — with mapping and unmapped inputs", () => {
  it("loads a nested pipeline with a valid with mapping and rewrites the prompt placeholder", () => {
    const innerYaml = `
id: inner
version: 1
description: inner
inputs:
  - parentKey
steps:
  - id: s
    kind: llm
    role: worker
    prompt: prompts/s.md
`;
    const parentYaml = `
id: parent
version: 1
description: parent
inputs:
  - parentKey
steps:
  - id: n
    kind: pipeline
    pipeline: inner
    with:
      parentKey: parentKey
`;
    const { prompts } = loadPipeline("/fake/pipelines/parent.yaml", {
      readFile: (p) => {
        if (p.endsWith("parent.yaml")) return parentYaml;
        if (p.endsWith("inner.yaml")) return innerYaml;
        if (p.endsWith("s.md")) return "Using: {{parentKey}}";
        throw new Error(`unexpected: ${p}`);
      },
    });
    // The with mapping rewrites {{parentKey}} → {{parentKey}} (identity mapping here,
    // confirming the machinery works without error and the prompt is preserved).
    assert.equal(prompts["n.s"], "Using: {{parentKey}}");
  });

  it("throws when with key is not a declared input of the nested pipeline", () => {
    const innerYaml = `
id: inner
version: 1
description: inner
inputs:
  - realInput
steps:
  - id: s
    kind: llm
    role: worker
    prompt: prompts/s.md
`;
    const parentYaml = `
id: parent
version: 1
description: parent
inputs:
  - request
steps:
  - id: n
    kind: pipeline
    pipeline: inner
    with:
      typo: request
`;
    assert.throws(
      () =>
        loadPipeline("/fake/pipelines/parent.yaml", {
          readFile: (p) => {
            if (p.endsWith("parent.yaml")) return parentYaml;
            if (p.endsWith("inner.yaml")) return innerYaml;
            if (p.endsWith("s.md")) return "{{realInput}}";
            throw new Error(`unexpected: ${p}`);
          },
        }),
      (err: Error) => {
        assert.ok(err.message.includes("typo"), "names the bad with key");
        assert.ok(
          err.message.toLowerCase().includes("not a declared input"),
          "says it is not a declared input"
        );
        return true;
      }
    );
  });

  it("throws when a nested pipeline input appears in a prompt but is not mapped and not a parent input", () => {
    const innerYaml = `
id: inner
version: 1
description: inner
inputs:
  - myInput
steps:
  - id: s
    kind: llm
    role: worker
    prompt: prompts/s.md
`;
    const parentYaml = `
id: parent
version: 1
description: parent
inputs:
  - request
steps:
  - id: n
    kind: pipeline
    pipeline: inner
`;
    // inner's myInput is not mapped via with, and the parent has no myInput input.
    // The placeholder {{myInput}} in the prompt will remain after expansion and fail
    // the load.ts validator.
    assert.throws(
      () =>
        loadPipeline("/fake/pipelines/parent.yaml", {
          readFile: (p) => {
            if (p.endsWith("parent.yaml")) return parentYaml;
            if (p.endsWith("inner.yaml")) return innerYaml;
            if (p.endsWith("s.md")) return "Using: {{myInput}}";
            throw new Error(`unexpected: ${p}`);
          },
        }),
      (err: Error) => {
        assert.ok(err.message.includes("myInput"), "names the unresolvable placeholder");
        return true;
      }
    );
  });
});

// ── D1 — Investigation wiring (spec 017) ─────────────────────────────────────

describe("cycle.yaml — plan step wires investigate.findings into spec-creation", () => {
  it("plan step has with.findings === 'investigate.findings'", () => {
    const raw = readFileSync(join(repoRoot, "pipelines", "cycle.yaml"), "utf8");
    const doc = parse(raw);
    const plan = doc.steps.find((s: { id: string }) => s.id === "plan");
    assert.ok(plan, "plan step must exist");
    assert.equal(
      plan.with?.findings,
      "investigate.findings",
      "plan step must wire investigate.findings into findings input"
    );
  });
});

describe("cycle-dev.yaml — plan step wires investigate.findings into spec-creation", () => {
  it("plan step has with.findings === 'investigate.findings'", () => {
    const raw = readFileSync(join(repoRoot, "pipelines", "cycle-dev.yaml"), "utf8");
    const doc = parse(raw);
    const plan = doc.steps.find((s: { id: string }) => s.id === "plan");
    assert.ok(plan, "plan step must exist");
    assert.equal(
      plan.with?.findings,
      "investigate.findings",
      "plan step must wire investigate.findings into findings input"
    );
  });
});

describe("spec-creation — findings is an optional input", () => {
  it("loads with optionalInputs containing 'findings'", () => {
    const { def } = loadPipeline(pipelinesYaml);
    assert.ok(def.inputs.includes("findings"), "findings must be in inputs");
    assert.ok(def.optionalInputs?.includes("findings"), "findings must be in optionalInputs");
  });
});

describe("loadPipeline — rejects optionalInputs entry not in inputs", () => {
  it("throws when an optionalInputs name is absent from inputs", () => {
    const yaml = `\
id: test
version: 1
description: test
inputs:
  - request
optionalInputs:
  - findings
steps: []
`;
    assert.throws(
      () =>
        loadPipeline("/fake/pipelines/test.yaml", {
          readFile: (p) => (p.endsWith(".yaml") ? yaml : ""),
        }),
      /optionalInputs.*findings|findings.*inputs/
    );
  });
});

// ── D2 — Plan verification and correction (spec 018) ─────────────────────────

describe("spec-creation — verify and correct steps present after expansion (spec 018)", () => {
  it("expanded def contains verify.synthesis and correct.revise", () => {
    const { def } = loadPipeline(pipelinesYaml);
    const ids = def.steps.map((s) => s.id);
    assert.ok(ids.includes("verify.synthesis"), "expanded def must include verify.synthesis");
    assert.ok(ids.includes("correct.revise"), "expanded def must include correct.revise");
  });

  it("correct.revise prompt placeholders resolve without error (ancestor check passes)", () => {
    // loadPipeline throws on any unresolved placeholder — if this passes, the
    // {{plan}} and {{findings}} in correct-plan.md are reachable from correct.revise.
    assert.doesNotThrow(() => loadPipeline(pipelinesYaml));
  });
});

describe("cycle.yaml — build step uses plan.correct.revise (spec 018)", () => {
  it("build step has with.plan === 'plan.correct.revise'", () => {
    const raw = readFileSync(join(repoRoot, "pipelines", "cycle.yaml"), "utf8");
    const doc = parse(raw);
    const build = doc.steps.find((s: { id: string }) => s.id === "build");
    assert.ok(build, "build step must exist");
    assert.equal(
      build.with?.plan,
      "plan.correct.revise",
      "build step must wire plan.correct.revise as the plan input"
    );
  });
});

describe("cycle-dev.yaml — build step uses plan.correct.revise (spec 018)", () => {
  it("build step has with.plan === 'plan.correct.revise'", () => {
    const raw = readFileSync(join(repoRoot, "pipelines", "cycle-dev.yaml"), "utf8");
    const doc = parse(raw);
    const build = doc.steps.find((s: { id: string }) => s.id === "build");
    assert.ok(build, "build step must exist");
    assert.equal(
      build.with?.plan,
      "plan.correct.revise",
      "build step must wire plan.correct.revise as the plan input"
    );
  });
});

describe("spec 018 — negative: with-value typo is caught by placeholder validation", () => {
  // `with` *values* are not validated by nest.ts (it only checks keys); the
  // placeholder check in load.ts is what catches a dangling reference.
  // A typo of `findings: verify` (instead of `findings: verify.synthesis`)
  // causes {{findings}} in the correct-inner prompt to be rewritten to
  // {{verify}}, which is not in the ancestor set — load must throw.
  it("rejects findings: verify (should be verify.synthesis) with a placeholder error", () => {
    const verifyInnerYaml = `
id: verify-inner
version: 1
description: verify inner
inputs:
  - request
steps:
  - id: synthesis
    kind: llm
    role: reasoner
    prompt: prompts/synthesis.md
`;
    const correctInnerYaml = `
id: correct-inner
version: 1
description: correct inner
inputs:
  - findings
steps:
  - id: revise
    kind: llm
    role: reasoner
    prompt: prompts/revise.md
`;
    const outerYaml = `
id: outer
version: 1
description: outer
inputs:
  - request
steps:
  - id: verify
    kind: pipeline
    pipeline: verify-inner
  - id: correct
    kind: pipeline
    pipeline: correct-inner
    with:
      findings: verify
    dependsOn: [verify]
`;
    assert.throws(
      () =>
        loadPipeline("/fake/pipelines/outer.yaml", {
          readFile: (p) => {
            if (p.endsWith("outer.yaml")) return outerYaml;
            if (p.endsWith("verify-inner.yaml")) return verifyInnerYaml;
            if (p.endsWith("correct-inner.yaml")) return correctInnerYaml;
            if (p.endsWith("synthesis.md")) return "Synthesis: {{request}}";
            if (p.endsWith("revise.md")) return "Revise: {{findings}}";
            throw new Error(`unexpected read: ${p}`);
          },
        }),
      (err: Error) => {
        // The rewritten placeholder {{verify}} is not a valid ancestor id after
        // expansion (verify was expanded to verify.synthesis); load must name it.
        assert.ok(
          err.message.includes("verify"),
          `expected error to mention "verify", got: ${err.message}`
        );
        return true;
      }
    );
  });
});

// ── FR-013: manualOnly field validation ───────────────────────────────────────

describe("FR-013: manualOnly field validation in loadPipeline", () => {
  function makeGateYaml(overrides: string) {
    return `
id: test
version: 1
description: test
inputs:
  - request
steps:
  - id: approve
    kind: gate
    message: "Approve?"
    ${overrides}
`;
  }

  it("manualOnly: true on a gate step loads successfully", () => {
    const yaml = makeGateYaml("manualOnly: true");
    const { def } = loadPipeline("/fake/pipelines/test.yaml", {
      readFile: (p) => (p.endsWith(".yaml") ? yaml : ""),
    });
    const step = def.steps[0];
    assert.equal(
      (step as unknown as Record<string, unknown>).manualOnly,
      true,
      "manualOnly: true must be preserved on gate step"
    );
  });

  it("manualOnly: false on a gate step loads successfully", () => {
    const yaml = makeGateYaml("manualOnly: false");
    assert.doesNotThrow(() =>
      loadPipeline("/fake/pipelines/test.yaml", {
        readFile: (p) => (p.endsWith(".yaml") ? yaml : ""),
      })
    );
  });

  it("manualOnly: 'yes' (non-boolean) on a gate step throws at load time", () => {
    const yaml = makeGateYaml("manualOnly: 'yes'");
    assert.throws(
      () =>
        loadPipeline("/fake/pipelines/test.yaml", {
          readFile: (p) => (p.endsWith(".yaml") ? yaml : ""),
        }),
      /manualOnly.*boolean|boolean.*manualOnly/
    );
  });

  it("manualOnly on a check step throws at load time", () => {
    const yaml = `
id: test
version: 1
description: test
inputs:
  - request
steps:
  - id: build
    kind: check
    command: "exit 0"
    manualOnly: true
`;
    assert.throws(
      () =>
        loadPipeline("/fake/pipelines/test.yaml", {
          readFile: (p) => (p.endsWith(".yaml") ? yaml : ""),
        }),
      /manualOnly.*gate|gate.*manualOnly/
    );
  });

  it("manualOnly on a pipeline step throws at load time", () => {
    const innerYaml = `
id: inner
version: 1
description: inner
inputs: []
steps:
  - id: s1
    kind: gate
    message: ok?
`;
    const yaml = `
id: test
version: 1
description: test
inputs:
  - request
steps:
  - id: nested
    kind: pipeline
    pipeline: inner
    manualOnly: true
`;
    assert.throws(
      () =>
        loadPipeline("/fake/pipelines/test.yaml", {
          readFile: (p) => {
            if (p.endsWith("test.yaml")) return yaml;
            if (p.endsWith("inner.yaml")) return innerYaml;
            return "";
          },
        }),
      /manualOnly.*gate|gate.*manualOnly/
    );
  });

  it("manualOnly on an llm step throws at load time", () => {
    const yaml = `
id: test
version: 1
description: test
inputs:
  - request
steps:
  - id: intake
    kind: llm
    role: worker
    prompt: prompts/intake.md
    manualOnly: true
`;
    assert.throws(
      () =>
        loadPipeline("/fake/pipelines/test.yaml", {
          readFile: (p) => (p.endsWith(".yaml") ? yaml : "LLM prompt"),
        }),
      /manualOnly.*gate|gate.*manualOnly/
    );
  });
});

// ── FR-014: ship.yaml declares manualOnly: true on the approve step ───────────

describe("FR-014: ship.yaml approve step declares manualOnly: true", () => {
  it("ship.yaml loads successfully and approve step has manualOnly: true", () => {
    const { def } = loadPipeline(new URL("../../pipelines/ship.yaml", import.meta.url).pathname);
    const approveStep = def.steps.find((s) => s.id === "approve");
    assert.ok(approveStep !== undefined, "approve step must exist in ship.yaml");
    assert.equal(
      (approveStep as unknown as Record<string, unknown>).manualOnly,
      true,
      "ship.approve must declare manualOnly: true (FR-014)"
    );
  });
});
