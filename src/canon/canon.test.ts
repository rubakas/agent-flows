import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { parse } from "yaml";
import { packageRoot } from "../packageRoot.js";
import { assembleSpec } from "./assemble.js";
import { pipelineAncestors, pipelineLevels } from "./graph.js";
import { loadPipeline } from "./load.js";
import { extractPlaceholders, renderPrompt } from "./render.js";

const repoRoot = packageRoot();
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

  it("accepts a review-material step with no command and no prompt", () => {
    const yaml = `
id: test
version: 1
description: test
inputs:
  - baseline
steps:
  - id: material
    kind: review-material
    required: true
`;
    const { def } = loadPipeline("/fake/pipelines/test.yaml", {
      readFile: (p) => (p.endsWith(".yaml") ? yaml : ""),
    });
    assert.equal(def.steps[0].kind, "review-material");
    assert.equal(def.steps[0].required, true);
  });

  it("throws on a review-material step that declares a command", () => {
    const yaml = `
id: test
version: 1
description: test
inputs:
  - baseline
steps:
  - id: material
    kind: review-material
    command: git diff
`;
    assert.throws(
      () =>
        loadPipeline("/fake/pipelines/test.yaml", {
          readFile: (p) => (p.endsWith(".yaml") ? yaml : ""),
        }),
      /material.*cannot set command/
    );
  });

  it("throws on a review-material step that declares an env allowlist", () => {
    const yaml = `
id: test
version: 1
description: test
inputs:
  - baseline
steps:
  - id: material
    kind: review-material
    env:
      - SOME_VAR
`;
    assert.throws(
      () =>
        loadPipeline("/fake/pipelines/test.yaml", {
          readFile: (p) => (p.endsWith(".yaml") ? yaml : ""),
        }),
      /material.*cannot set env/
    );
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

  it("accepts permissions.deny on an llm step and preserves it in the definition", () => {
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
      deny:
        - "src/internal/**"
`;
    const { def } = loadPipeline("/fake/pipelines/test.yaml", {
      readFile: (p) => (p.endsWith(".yaml") ? yaml : "prompt content"),
    });
    assert.deepEqual(def.steps[0].permissions, {
      contents: "read",
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
// V7 / FR-009: permissions.allow is removed
// ---------------------------------------------------------------------------

describe("loadPipeline — permissions.allow is rejected (FR-009)", () => {
  const REMOVED_MESSAGE = "permissions.allow was removed (spec 031); deny is narrowing-only";

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

  function loadWith(yaml: string) {
    return loadPipeline("/fake/pipelines/test.yaml", {
      readFile: (p) => (p.endsWith(".yaml") ? yaml : "prompt content"),
    });
  }

  const shapes: [string, string][] = [
    ["alongside contents", '      contents: read\n      allow:\n        - "**/package.json"'],
    ["without contents", '      allow:\n        - "**/*.pem"'],
    ["as an empty array", "      contents: read\n      allow: []"],
    [
      "alongside a deny entry",
      "      contents: read\n      deny:\n        - src/private/**\n      allow:\n        - src/private/**",
    ],
  ];

  for (const [label, block] of shapes) {
    it(`rejects allow ${label} with the exact removal message`, () => {
      assert.throws(
        () => loadWith(makeLlmYaml(block)),
        (err: Error) => {
          assert.equal(err.message, REMOVED_MESSAGE);
          return true;
        }
      );
    });
  }

  it("still accepts a step declaring only deny", () => {
    const { def } = loadWith(
      makeLlmYaml("      contents: read\n      deny:\n        - src/private/**")
    );
    assert.deepEqual(def.steps[0].permissions, {
      contents: "read",
      deny: ["src/private/**"],
    });
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

describe("loadPipeline — rejects an input name that is not an identifier", () => {
  it("throws naming the input when it would become a JavaScript expression", () => {
    const yaml = `\
id: test
version: 1
description: test
inputs:
  - "x = 1; //"
steps: []
`;
    assert.throws(
      () =>
        loadPipeline("/fake/pipelines/test.yaml", {
          readFile: (p) => (p.endsWith(".yaml") ? yaml : ""),
        }),
      /x = 1; \/\//
    );
  });

  it("accepts ordinary identifier input names", () => {
    const yaml = `\
id: test
version: 1
description: test
inputs:
  - request
  - _findings2
steps: []
`;
    assert.doesNotThrow(() =>
      loadPipeline("/fake/pipelines/test.yaml", {
        readFile: (p) => (p.endsWith(".yaml") ? yaml : ""),
      })
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

describe("check step — required flag validation", () => {
  const loadYaml = (yaml: string) =>
    loadPipeline("/fake/pipelines/test.yaml", {
      readFile: (p) => (p.endsWith(".yaml") ? yaml : ""),
    });

  it("accepts required: true on a check step", () => {
    const { def } = loadYaml(`
id: test
version: 1
description: test
inputs: []
steps:
  - id: verify
    kind: check
    command: "{{checkCommand}}"
    required: true
`);
    assert.equal(def.steps[0].required, true);
  });

  it("throws on a non-boolean required", () => {
    assert.throws(
      () =>
        loadYaml(`
id: test
version: 1
description: test
inputs: []
steps:
  - id: verify
    kind: check
    command: echo hi
    required: "yes"
`),
      /verify.*required must be a boolean/u
    );
  });

  it("accepts required: false on an llm step — an optional dimension", () => {
    const { def } = loadYaml(`
id: test
version: 1
description: test
inputs: []
steps:
  - id: delivery
    kind: llm
    role: worker
    prompt: prompts/delivery.md
    required: false
`);
    assert.equal(
      def.steps[0].required,
      false,
      "an llm step may declare itself optional: its failure is logged, its ctx key is filled " +
        "with the unavailable marker, and the run continues"
    );
  });

  it("throws on a non-boolean required on an llm step", () => {
    assert.throws(
      () =>
        loadYaml(`
id: test
version: 1
description: test
inputs: []
steps:
  - id: delivery
    kind: llm
    role: worker
    prompt: prompts/delivery.md
    required: "no"
`),
      /delivery.*required must be a boolean/u,
      'required: "no" is truthy as a string and would silently make an optional dimension ' +
        "mandatory again"
    );
  });

  it("throws on required set on a non-check step — a silently ignored gate flag is worse than none", () => {
    assert.throws(
      () =>
        loadYaml(`
id: test
version: 1
description: test
inputs: []
steps:
  - id: g1
    kind: gate
    message: ok?
    required: true
`),
      /g1.*cannot set required/u
    );
  });
});

describe("llm step — failover flag validation", () => {
  const loadYaml = (yaml: string) =>
    loadPipeline("/fake/pipelines/test.yaml", {
      readFile: (p) => (p.endsWith(".yaml") ? yaml : "survey"),
    });

  it("accepts failover: false on an llm step", () => {
    const { def } = loadYaml(`
id: test
version: 1
description: test
inputs: []
steps:
  - id: survey
    kind: llm
    role: worker
    prompt: prompts/survey.md
    failover: false
`);
    assert.equal(def.steps[0].failover, false);
  });

  it("throws on a non-boolean failover", () => {
    assert.throws(
      () =>
        loadYaml(`
id: test
version: 1
description: test
inputs: []
steps:
  - id: survey
    kind: llm
    role: worker
    prompt: prompts/survey.md
    failover: "no"
`),
      /survey.*failover must be a boolean/u
    );
  });

  it("throws on failover set on a non-llm step — no other kind is dispatched to a provider", () => {
    assert.throws(
      () =>
        loadYaml(`
id: test
version: 1
description: test
inputs: []
steps:
  - id: g1
    kind: gate
    message: ok?
    failover: false
`),
      /g1.*failover is only allowed on llm steps/u
    );
  });
});

// ── build.yaml — terminal verification check ─────────────────────────────────
//
// A live self-run finished with status "succeeded" while the tree failed
// `pnpm check` on formatting: build-round's `fix` step edits after the `test`
// check it converged on, and those edits were never checked again. The loop
// cannot close that hole (the canon has no conditionals), so build.yaml ends
// with a required check of the project's own command.

describe("build.yaml — terminal verification check (regression: success over a failing tree)", () => {
  const buildYaml = join(repoRoot, "pipelines", "build.yaml");

  it("the last declared step is a required check of {{checkCommand}} depending on review", () => {
    const doc = parse(readFileSync(buildYaml, "utf8")) as {
      steps: Record<string, unknown>[];
    };
    const last = doc.steps[doc.steps.length - 1];
    assert.equal(last.id, "verify", "build.yaml must end with the verification step");
    assert.equal(last.kind, "check");
    assert.equal(
      last.command,
      "{{checkCommand}}",
      "the final word must be the project's own check command, not a weaker one"
    );
    assert.equal(
      last.required,
      true,
      "without required: true a failing check is recorded in the context and ignored — the run still succeeds"
    );
    assert.deepEqual(
      last.dependsOn,
      ["review"],
      "verification depends on the review so the audit still reports findings on a broken tree"
    );
  });

  it("nothing runs after the verification check — it is alone in the last level", () => {
    const { def } = loadPipeline(buildYaml);
    const levels = pipelineLevels(def.steps);
    assert.deepEqual(
      levels[levels.length - 1],
      ["verify"],
      "verify must be the last thing the run does"
    );
    assert.ok(
      def.steps.every((s) => !(s.dependsOn ?? []).includes("verify")),
      "no step may depend on verify"
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

// ── maxBudgetUsd validation ───────────────────────────────────────────────────

describe("maxBudgetUsd and defaultMaxBudgetUsd validation at load time", () => {
  it("check step carrying maxBudgetUsd throws the llm-only message", () => {
    const yaml = `
id: test
version: 1
description: test
inputs: []
steps:
  - id: build
    kind: check
    command: "exit 0"
    maxBudgetUsd: 1
`;
    assert.throws(
      () =>
        loadPipeline("/fake/pipelines/test.yaml", {
          readFile: (p) => (p.endsWith(".yaml") ? yaml : ""),
        }),
      /maxBudgetUsd.*llm|llm.*maxBudgetUsd/i
    );
  });

  it("llm step with maxBudgetUsd: -1 throws the positive-number message", () => {
    const yaml = `
id: test
version: 1
description: test
inputs: []
steps:
  - id: intake
    kind: llm
    role: worker
    prompt: prompts/intake.md
    maxBudgetUsd: -1
`;
    assert.throws(
      () =>
        loadPipeline("/fake/pipelines/test.yaml", {
          readFile: (p) => (p.endsWith(".yaml") ? yaml : "LLM prompt"),
        }),
      /maxBudgetUsd.*positive|positive.*number.*maxBudgetUsd/i
    );
  });

  it('llm step with maxBudgetUsd: "5" (string) throws the positive-number message', () => {
    const yaml = `
id: test
version: 1
description: test
inputs: []
steps:
  - id: intake
    kind: llm
    role: worker
    prompt: prompts/intake.md
    maxBudgetUsd: "5"
`;
    assert.throws(
      () =>
        loadPipeline("/fake/pipelines/test.yaml", {
          readFile: (p) => (p.endsWith(".yaml") ? yaml : "LLM prompt"),
        }),
      /maxBudgetUsd.*positive|positive.*number.*maxBudgetUsd/i
    );
  });

  it("pipeline with defaultMaxBudgetUsd: 0 throws (zero is not a positive number)", () => {
    const yaml = `
id: test
version: 1
description: test
inputs: []
defaultMaxBudgetUsd: 0
steps:
  - id: intake
    kind: llm
    role: worker
    prompt: prompts/intake.md
`;
    assert.throws(
      () =>
        loadPipeline("/fake/pipelines/test.yaml", {
          readFile: (p) => (p.endsWith(".yaml") ? yaml : "LLM prompt"),
        }),
      /defaultMaxBudgetUsd.*positive|positive.*number.*defaultMaxBudgetUsd/i
    );
  });

  it("llm step with maxBudgetUsd: 2.5 loads successfully and the value is the number 2.5", () => {
    const yaml = `
id: test
version: 1
description: test
inputs: []
steps:
  - id: intake
    kind: llm
    role: worker
    prompt: prompts/intake.md
    maxBudgetUsd: 2.5
`;
    const { def } = loadPipeline("/fake/pipelines/test.yaml", {
      readFile: (p) => (p.endsWith(".yaml") ? yaml : "LLM prompt"),
    });
    const step = def.steps[0] as unknown as Record<string, unknown>;
    assert.equal(
      step.maxBudgetUsd,
      2.5,
      "maxBudgetUsd must be passed through as the number 2.5, not a string or other form"
    );
  });
});

// ── FR-014: ship.yaml declares manualOnly: true on the approve step ───────────

describe("FR-014: ship.yaml approve step declares manualOnly: true", () => {
  it("ship.yaml loads successfully and approve step has manualOnly: true", () => {
    const { def } = loadPipeline(join(repoRoot, "pipelines", "ship.yaml"));
    const approveStep = def.steps.find((s) => s.id === "approve");
    assert.ok(approveStep !== undefined, "approve step must exist in ship.yaml");
    assert.equal(
      (approveStep as unknown as Record<string, unknown>).manualOnly,
      true,
      "ship.approve must declare manualOnly: true (FR-014)"
    );
  });
});

// ── every pipeline — the loader's placeholder rule actually covers all of them ─
//
// renderPrompt throws on a placeholder the vars map has no key for, and a step's
// vars map is exactly the pipeline's declared inputs + models/provider + the
// output of every TRANSITIVE ancestor. loadPipeline already refuses such a
// prompt (load.ts, "prompt references unknown placeholder"), and the unit tests
// above prove that rule can fail. What nothing proved is that the rule is run
// against the pipelines actually shipped: a re-wired dependsOn, or a prompt that
// gains a placeholder, is caught only when someone loads that file. This does.
//
// Prove it can fail by appending "{{nope}}" to any prompt a pipeline references:
// the file's case goes red with the step and the placeholder named.

describe("every shipped pipeline loads — graph, prompts and placeholders agree", () => {
  const pipelinesDir = join(repoRoot, "pipelines");
  const files = readdirSync(pipelinesDir)
    .filter((f) => f.endsWith(".yaml"))
    .sort();

  it("the pipelines directory is not empty", () => {
    assert.ok(files.length > 0, "found no pipelines to load — this gate would pass vacuously");
  });

  for (const file of files) {
    it(`${file} loads, and every {{placeholder}} resolves from an input or an ancestor`, () => {
      const { def, prompts } = loadPipeline(join(pipelinesDir, file));
      assert.ok(def.steps.length > 0, `${file} declares no steps`);
      for (const step of def.steps) {
        if (step.kind !== "llm") continue;
        assert.ok(
          (prompts[step.id] ?? "").length > 0,
          `${file}: llm step "${step.id}" loaded an empty prompt`
        );
      }
    });
  }
});

// ── spec 030 / 040 — code-review.yaml structure ──────────────────────────────

describe("code-review.yaml — structure (spec 030, spec 040)", () => {
  const codeReviewYaml = join(repoRoot, "pipelines", "code-review.yaml");
  // The llm steps. `material` is deliberately not one: it holds no prompt and no
  // permissions, so the per-step assertions below do not apply to it.
  const STEP_IDS = [
    "brief",
    "radius",
    "falsifiability",
    "delivery",
    "correctness",
    "security",
    "verify",
    "synthesis",
  ] as const;

  it("loads and defines exactly nine steps", () => {
    const { def } = loadPipeline(codeReviewYaml);
    assert.equal(def.id, "code-review");
    assert.equal(
      def.steps.length,
      9,
      `code-review must define exactly 9 steps (040 FR-001 plus material, delivery and brief); got ${def.steps.length.toString()}: ${def.steps
        .map((s) => s.id)
        .join(", ")}`
    );
    assert.deepEqual(
      def.steps.map((s) => s.id),
      ["material", ...STEP_IDS],
      "step ids must be material, brief, radius, falsifiability, delivery, correctness, " +
        "security, verify, synthesis"
    );
  });

  it("brief is an optional scout step between the capture and the dimensions", () => {
    const { def } = loadPipeline(codeReviewYaml);
    const brief = def.steps.find((s) => s.id === "brief");
    assert.ok(brief, "brief step must exist");
    assert.equal(brief.kind, "llm");
    assert.equal(
      brief.role,
      "scout",
      "brief summarises a capture that already exists and decides nothing, so it runs on the " +
        "cheapest tier; a reasoner here pays reasoning rates to restate a diff"
    );
    assert.deepEqual(brief.dependsOn, ["material"]);
    assert.equal(
      brief.required,
      false,
      "a failed framing paragraph must not take the run with it: the dimensions receive the " +
        "unavailable marker and fall back to the material, which is what they did before " +
        "this step existed"
    );
  });

  it("material is a review-material step that is not required", () => {
    const { def } = loadPipeline(codeReviewYaml);
    const material = def.steps.find((s) => s.id === "material");
    assert.ok(material, "material step must exist");
    assert.equal(material.kind, "review-material");
    assert.notEqual(
      material.required,
      true,
      "material must NOT be required: a caller reviewing a pasted diff, or a tree where git " +
        "fails, must still get a review — on available: false the brief is written from " +
        "{{plan}} alone and the dimensions read it as before"
    );
    assert.equal(
      material.prompt,
      undefined,
      "material is not an llm step and must declare no prompt"
    );
  });

  it("dependency levels are [[material], [brief], [radius, falsifiability, delivery], [correctness, security], [verify], [synthesis]]", () => {
    const { def } = loadPipeline(codeReviewYaml);
    assert.deepEqual(
      pipelineLevels(def.steps),
      [
        ["material"],
        ["brief"],
        ["radius", "falsifiability", "delivery"],
        ["correctness", "security"],
        ["verify"],
        ["synthesis"],
      ],
      "the deterministic capture runs alone first (build.ts permits only llm steps in a " +
        "parallel level), the brief is written from it before any dimension reads it, " +
        "radius feeds the two dimension reviewers, falsifiability and " +
        "delivery run beside it and reach verify directly, and verification stays its own " +
        "level before synthesis (040 FR-001)"
    );
  });

  it("material sits alone at level 0 — a non-llm step may not share a parallel level", () => {
    const { def } = loadPipeline(codeReviewYaml);
    const [firstLevel] = pipelineLevels(def.steps);
    assert.deepEqual(
      firstLevel,
      ["material"],
      "build.ts throws when a level holds more than one step and any of them is not an llm " +
        "step; material is review-material, so anything that joins its level breaks the build"
    );
  });

  it("verify depends on correctness, security, falsifiability and delivery — not on radius directly", () => {
    const { def } = loadPipeline(codeReviewYaml);
    const verify = def.steps.find((s) => s.id === "verify");
    assert.ok(verify, "verify step must exist");
    assert.deepEqual(
      verify.dependsOn,
      ["correctness", "security", "falsifiability", "delivery", "brief"],
      "040 FR-007: the falsifiability and delivery dimensions reach the verifier directly, " +
        "while radius reaches it only through correctness and security (D2)"
    );
  });

  for (const id of STEP_IDS) {
    it(`step "${id}" declares permissions.contents: read`, () => {
      const { def } = loadPipeline(codeReviewYaml);
      const step = def.steps.find((s) => s.id === id);
      assert.ok(step, `step "${id}" must exist`);
      assert.equal(
        step.permissions?.contents,
        "read",
        `step "${id}" must declare permissions.contents: "read". ` +
          (id === "synthesis"
            ? "synthesis is the deliberate difference from audit (FR-002): it pins a workspace " +
              "cwd so it can open a cited file instead of reconciling text blobs blind."
            : "verification is read-only for every step in this pipeline.")
      );
    });
  }

  it("verify is schema-gated on codeReviewFindings", () => {
    const { def } = loadPipeline(codeReviewYaml);
    const verify = def.steps.find((s) => s.id === "verify");
    assert.ok(verify, "verify step must exist");
    assert.equal(
      verify.schema,
      "codeReviewFindings",
      "verify must declare schema: codeReviewFindings so verdicts are machine-checkable"
    );
  });

  it("delivery is schema-gated on codeReviewDelivery", () => {
    const { def } = loadPipeline(codeReviewYaml);
    const delivery = def.steps.find((s) => s.id === "delivery");
    assert.ok(delivery, "delivery step must exist");
    assert.equal(
      delivery.schema,
      "codeReviewDelivery",
      "044 D1: a new axis is a schema slot, not a sentence in a prompt — undeclared, " +
        "`silently-decided` is indistinguishable from `implemented` in free text"
    );
  });

  it("declares inputs [plan, baseline, introducedCommits, specSources] with the last three optional", () => {
    const { def } = loadPipeline(codeReviewYaml);
    assert.deepEqual(
      def.inputs,
      ["plan", "baseline", "introducedCommits", "specSources"],
      "FR-006 inputs. specSources must be declared here as well as in optionalInputs: " +
        "POST /api/runs rejects any key that is not in inputs, so a caller could not supply it"
    );
    assert.deepEqual(
      def.optionalInputs,
      ["plan", "baseline", "introducedCommits", "specSources"],
      "FR-006 optionalInputs, widened: `plan` is optional too, so a caller can POST " +
        '{"pipeline":"code-review","inputs":{}} and get a complete review — the brief step ' +
        "writes the change description the dimensions used to require a human to supply"
    );
  });

  it("loads a non-empty prompt for every step", () => {
    const { prompts } = loadPipeline(codeReviewYaml);
    for (const id of STEP_IDS) {
      assert.ok(id in prompts, `prompts["${id}"] should be loaded`);
      assert.ok(prompts[id].length > 0, `prompts["${id}"] should be non-empty`);
    }
  });
});

// ── spec 040 — prompt wiring and the synthesis isolation ─────────────────────

describe("code-review prompts — placeholders and wiring (spec 040)", () => {
  const codeReviewYaml = join(repoRoot, "pipelines", "code-review.yaml");
  const promptText = (relPath: string): string =>
    readFileSync(join(repoRoot, ...relPath.split("/")), "utf8");

  // FR-008. The graph hands a step the output of every TRANSITIVE ancestor
  // (pipelineAncestors), so synthesis's vars map carries correctness, security,
  // falsifiability and radius whatever its prompt says, and renderPrompt would
  // substitute any of them on sight. Nothing structural withholds them: the
  // isolation is exactly "the prompt names none of them", which is what this
  // asserts. Prove it can fail by adding {{correctness}} to the prompt.
  it("synthesis names {{verify}} and no worker step's raw output", () => {
    const placeholders = new Set(
      extractPlaceholders(promptText("prompts/code-review-synthesis.md"))
    );
    assert.ok(
      placeholders.has("verify"),
      "synthesis must consume {{verify}} — it is the only input it has"
    );
    for (const worker of ["correctness", "security", "falsifiability", "delivery", "radius"]) {
      assert.ok(
        !placeholders.has(worker),
        `prompts/code-review-synthesis.md names {{${worker}}}. synthesis may not see a worker's ` +
          "raw output: it is a transitive ancestor, so the value IS in the vars map and would " +
          "render, letting synthesis re-judge a verdict the verifier settled (030 FR-008, " +
          "040 FR-008)."
      );
    }
  });

  // renderPrompt throws on a placeholder the vars map has no key for, and the
  // vars map of an llm step is exactly inputs + models/provider + transitive
  // ancestors (build.ts). That throw happens at run time, where it costs a run;
  // this check moves it to load time.
  it("every placeholder in every step's prompt is a key that step can actually see", () => {
    const { def, prompts } = loadPipeline(codeReviewYaml);
    const ancestors = pipelineAncestors(def.steps);
    for (const step of def.steps) {
      // Only llm steps carry a prompt; `material` has none to check.
      if (!(step.id in prompts)) continue;
      const visible = new Set([
        ...def.inputs,
        "models",
        "provider",
        ...(ancestors.get(step.id) ?? []),
      ]);
      for (const name of extractPlaceholders(prompts[step.id])) {
        assert.ok(
          visible.has(name),
          `step "${step.id}" names {{${name}}}, which is not in its vars map ` +
            `(${[...visible].join(", ")}). renderPrompt throws on it at run time.`
        );
      }
    }
  });

  it("verify consumes the falsifiability findings", () => {
    const placeholders = new Set(extractPlaceholders(promptText("prompts/code-review-verify.md")));
    assert.ok(
      placeholders.has("falsifiability"),
      "040 FR-007: verify adjudicates falsifiability findings, so its prompt must name them — " +
        "a step whose output no prompt reads is a model call paid for and thrown away"
    );
  });

  it("verify consumes the delivery findings", () => {
    const placeholders = new Set(extractPlaceholders(promptText("prompts/code-review-verify.md")));
    assert.ok(
      placeholders.has("delivery"),
      "verify adjudicates delivery findings like any other dimension's, so its prompt must " +
        "name them — a step whose output no prompt reads is a model call paid for and thrown away"
    );
  });

  it("delivery consumes the spec sources it judges the change against", () => {
    const placeholders = new Set(
      extractPlaceholders(promptText("prompts/code-review-delivery.md"))
    );
    assert.ok(
      placeholders.has("specSources"),
      "the delivery dimension exists to compare the change against what the ticket asked for; " +
        "without {{specSources}} it has nothing to fail the change against"
    );
  });

  // The whole point of the material step: seven CLI sessions each re-deriving the same
  // diff is what a deterministic capture replaces. A dimension prompt that stops naming
  // {{material}} silently goes back to rediscovering scope, and only the bill shows it.
  // delivery is in this list too: it classifies a requirement `replaced-by-prose`
  // or `silently-decided` by reading what the change actually did, which is the
  // diff. It depends on material already; a dependency it never renders is a
  // dependency it does not have.
  for (const id of [
    "radius",
    "falsifiability",
    "correctness",
    "security",
    "delivery",
    "verify",
  ] as const) {
    it(`${id} consumes {{material}} — the deterministic capture, not a re-derived diff`, () => {
      const placeholders = new Set(extractPlaceholders(promptText(`prompts/code-review-${id}.md`)));
      assert.ok(
        placeholders.has("material"),
        `${id} must read the deterministically captured diff, commit list, changed-file list ` +
          "and git-history probes; without it the step spends its tool budget rediscovering " +
          "a scope the daemon already handed it"
      );
    });
  }

  // The brief replaced {{plan}} in every dimension. A dimension that still named
  // {{plan}} would be reading the caller's raw description — empty on the entry path
  // this step exists for — while the paragraph written for it went unread.
  for (const id of [
    "radius",
    "falsifiability",
    "correctness",
    "security",
    "delivery",
    "verify",
  ] as const) {
    it(`${id} reads {{brief}} rather than the caller's raw {{plan}}`, () => {
      const placeholders = new Set(extractPlaceholders(promptText(`prompts/code-review-${id}.md`)));
      assert.ok(
        placeholders.has("brief"),
        `${id} must read the brief: {{plan}} is an optional input and is empty whenever the ` +
          "caller did not write a change description by hand"
      );
      assert.ok(
        !placeholders.has("plan"),
        `prompts/code-review-${id}.md still names {{plan}}. The raw input is empty on the ` +
          "entry path this pipeline now supports; the brief is where the change description is"
      );
    });
  }

  it("brief composes from the capture and the caller's description, and judges neither", () => {
    const placeholders = new Set(extractPlaceholders(promptText("prompts/code-review-brief.md")));
    assert.deepEqual(
      [...placeholders].sort(),
      ["material", "plan"],
      "brief reads the deterministic capture and whatever description the caller supplied, " +
        "and nothing else: it runs before every dimension, so there is nothing else to read"
    );
    // Sliced on an anchor, not searched whole: "judge" and "evaluate" appear in the
    // surrounding prose about what the dimensions do, so a whole-file search passes
    // with the mandate deleted.
    const text = promptText("prompts/code-review-brief.md");
    const anchor = "You are not the judge.";
    assert.notEqual(
      text.indexOf(anchor),
      -1,
      `prompts/code-review-brief.md must state "${anchor}" the way prompts/gate-summary.md ` +
        "does: a brief that pre-judges is read first by five reviewers and comes back confirmed"
    );
  });

  // The goal this whole step exists for: POST /api/runs {"pipeline":"code-review",
  // "inputs":{}} must run a complete review. Every input is optional, so every
  // prompt in the graph has to render with all four of them empty — renderPrompt
  // throws on a placeholder with no value, and that throw costs a run, not a test.
  it("every prompt renders with no caller input at all", () => {
    const { def, prompts } = loadPipeline(codeReviewYaml);
    const optional = new Set(def.optionalInputs ?? []);
    for (const input of def.inputs) {
      assert.ok(
        optional.has(input),
        `input "${input}" is not optional, so {"inputs":{}} is refused before a step runs`
      );
    }
    const ancestors = pipelineAncestors(def.steps);
    for (const step of def.steps) {
      if (!(step.id in prompts)) continue;
      // What build.ts hands the step: the inputs, defaulted to "", plus every
      // transitive ancestor's output.
      const vars: Record<string, string> = { models: "", provider: "" };
      for (const input of def.inputs) vars[input] = "";
      for (const ancestor of ancestors.get(step.id) ?? []) vars[ancestor] = `<${ancestor}>`;
      assert.doesNotThrow(
        () => renderPrompt(prompts[step.id], vars),
        `step "${step.id}" cannot render with an empty input set`
      );
    }
  });

  it("brief composes from the material when the caller supplied no plan", () => {
    const { prompts } = loadPipeline(codeReviewYaml);
    const rendered = renderPrompt(prompts.brief, {
      plan: "",
      material: "## baseline\ndeadbeef\nderived: no baseline was supplied\n\n## diff\n+ one line",
    });
    assert.ok(
      rendered.includes("+ one line"),
      "the capture must reach the brief: it is the only thing left to write a brief from " +
        "when the caller described nothing"
    );
    assert.ok(
      !rendered.includes("{{"),
      `an unsubstituted placeholder survived: ${rendered.slice(0, 200)}`
    );
    // The prompt has to say what to do in this case, not merely be renderable.
    assert.ok(
      prompts.brief.includes("**The caller supplied nothing.**"),
      "the brief prompt must handle an empty description explicitly — a prompt that only " +
        "says 'lead with the caller's intent' produces a brief about nothing"
    );
  });

  it("the synthesis verdict line enumerates all five axes", () => {
    const synthesis = promptText("prompts/code-review-synthesis.md");

    // Sliced, not searched whole. All five axis names also appear in the
    // neighbouring "Searched and not found" paragraph, so asserting against the
    // whole file passes with the entire verdict paragraph deleted — proven by
    // deleting it. The anchor assertions matter as much as the axis ones: a slice
    // taken from a missing anchor is the empty string, and `"".includes(axis)` is
    // false, but only if we never let the search start at -1.
    const anchor = "End with a verdict line";
    const start = synthesis.indexOf(anchor);
    assert.notEqual(
      start,
      -1,
      `prompts/code-review-synthesis.md must still open its verdict paragraph with ` +
        `"${anchor}" — this test reads that paragraph and nothing else, and cannot check a ` +
        "paragraph it cannot find"
    );
    const end = synthesis.indexOf("</output_format>", start);
    assert.notEqual(
      end,
      -1,
      "the verdict paragraph must be the last thing inside <output_format> — without that " +
        "closing tag this test has no end to slice to"
    );
    const verdictParagraph = synthesis.slice(start, end);

    for (const axis of [
      "correctness",
      "security",
      "test falsifiability",
      "blast radius",
      "delivery",
    ]) {
      assert.ok(
        verdictParagraph.includes(axis),
        `prompts/code-review-synthesis.md's verdict paragraph must name the "${axis}" axis: ` +
          "the verdict line has " +
          "to account for every dimension that ran and every one that did not, and an axis " +
          "it never names is indistinguishable from an axis that came back clean"
      );
    }
  });

  // Spec 044 V2. D8 calls this the weakest decision in the spec: synthesis emits
  // free prose under no schema, so nothing downstream can check that the two
  // sections stayed disjoint in an actual report. What CAN be checked is that the
  // prompt still declares them as two sections and still forbids moving an entry
  // from one into the other — the sentence the whole decision rests on. Each
  // assertion reads its own paragraph, sliced from an anchor that must be found:
  // searching the whole file would pass on the strength of the section headings
  // alone, which is the failure this file already shipped once.
  it("synthesis keeps Unverifiable and Questions for owners as separate sections and forbids promotion between them", () => {
    const synthesis = promptText("prompts/code-review-synthesis.md");

    const ownersAnchor = 'Then a separate "Questions for owners" section';
    const unverifiableAnchor = 'Then a separate "Unverifiable" section';
    const ownersAt = synthesis.indexOf(ownersAnchor);
    const unverifiableAt = synthesis.indexOf(unverifiableAnchor);
    assert.notEqual(
      ownersAt,
      -1,
      `prompts/code-review-synthesis.md must declare its owner questions with "${ownersAnchor}" — ` +
        "a business-decision entry merged into the prioritised list is counted as a defect the " +
        "change has to fix"
    );
    assert.notEqual(
      unverifiableAt,
      -1,
      `prompts/code-review-synthesis.md must declare its unverifiable entries with ` +
        `"${unverifiableAnchor}" (spec 044 D8): an entry the verifier could not settle either ` +
        "way is a gap in the reviewer's reach, and a report with nowhere to put it puts it " +
        "somewhere it does not belong"
    );
    assert.ok(
      unverifiableAt > ownersAt,
      "the Unverifiable section must be declared as its own section after Questions for owners, " +
        "not folded into it"
    );

    // The Unverifiable paragraph alone — the "never" clauses have to live where
    // the section is defined, not anywhere in the file.
    const paragraphEnd = synthesis.indexOf("\n\n", unverifiableAt);
    const unverifiable = synthesis.slice(
      unverifiableAt,
      paragraphEnd === -1 ? synthesis.length : paragraphEnd
    );

    assert.ok(
      unverifiable.includes("never promoted into the prioritised list"),
      "the Unverifiable section must forbid promotion into the prioritised list — nothing was " +
        `observed to prioritise. Paragraph read:\n${unverifiable}`
    );
    assert.ok(
      unverifiable.includes('never moved into "Questions for owners"'),
      "the Unverifiable section must forbid moving an entry into Questions for owners — that is " +
        "the failure spec 044 was written against: a claim two git commands refute, routed to a " +
        `human. Paragraph read:\n${unverifiable}`
    );
  });

  for (const id of ["correctness", "security"] as const) {
    it(`${id} consumes {{radius}} as required context`, () => {
      const placeholders = new Set(extractPlaceholders(promptText(`prompts/code-review-${id}.md`)));
      assert.ok(
        placeholders.has("radius"),
        `040 FR-003: ${id} must read the blast-radius report; without it the step reviews the ` +
          "diff alone, which is the blindness spec 040 exists to fix"
      );
    });
  }

  // FR-009. The canon has no conditionals, so a step that finds nothing still
  // runs and still produces output. These literals are the contract that says
  // "the search ran and was empty"; a downstream prompt that no longer quotes
  // one can no longer tell that apart from "the search did not run".
  it("the no-op literals agree between producer and consumer", () => {
    const RADIUS_EMPTY = "No blast radius found — nothing outside the change depends on it.";
    const FALSIFIABILITY_EMPTY = "Every covering test can fail — no unfalsifiable coverage found.";

    assert.ok(
      promptText("prompts/code-review-radius.md").includes(RADIUS_EMPTY),
      "code-review-radius.md must instruct the literal empty reply (FR-009)"
    );
    assert.ok(
      promptText("prompts/code-review-falsifiability.md").includes(FALSIFIABILITY_EMPTY),
      "code-review-falsifiability.md must instruct the literal empty reply (FR-009)"
    );
    for (const id of ["correctness", "security"] as const) {
      assert.ok(
        promptText(`prompts/code-review-${id}.md`).includes(RADIUS_EMPTY),
        `code-review-${id}.md must quote the radius no-op literal verbatim, or it cannot read ` +
          "an empty blast radius as a completed search (FR-009)"
      );
    }
    assert.ok(
      promptText("prompts/code-review-verify.md").includes(FALSIFIABILITY_EMPTY),
      "code-review-verify.md must quote the falsifiability no-op literal verbatim (FR-009)"
    );
  });
});

// ── spec 040 FR-003/FR-010 — the two prompt sets stay forked ─────────────────
//
// `audit` is nested inside build, spec-creation, cycle and cycle-dev, so an edit
// to a shared audit-*.md prompt changes five pipelines at once — and audit
// reviews a plan, not a diff. `git diff --exit-code` proves the prompts are
// untouched by ONE change; this pins the wiring, so re-merging the two sets
// (pointing code-review back at the audit prompts, or audit at the forked ones)
// fails here instead of silently on the next run.

describe("audit and code-review reference disjoint worker prompts (spec 040 FR-003)", () => {
  const promptOf = (pipeline: string, stepId: string): string | undefined => {
    const raw = readFileSync(join(repoRoot, "pipelines", `${pipeline}.yaml`), "utf8");
    const doc = parse(raw) as { steps: { id: string; prompt?: string }[] };
    return doc.steps.find((s) => s.id === stepId)?.prompt;
  };

  for (const id of ["correctness", "security"] as const) {
    it(`audit.${id} still reads prompts/audit-${id}.md`, () => {
      assert.equal(
        promptOf("audit", id),
        `prompts/audit-${id}.md`,
        `audit's ${id} step must keep its own prompt: audit reviews a plan, and it is nested ` +
          "inside build, spec-creation, cycle and cycle-dev, so repointing it changes five pipelines"
      );
    });

    it(`code-review.${id} reads the forked prompts/code-review-${id}.md`, () => {
      assert.equal(
        promptOf("code-review", id),
        `prompts/code-review-${id}.md`,
        `code-review's ${id} step must read the forked prompt: the shared audit prompt has no ` +
          "{{radius}} and frames the input as a plan (040 FR-003)"
      );
    });
  }
});

// ── spec 030 non-goal — audit and its prompts are not modified by code-review ─

describe("audit is unchanged by spec 030 (immutability guard)", () => {
  // git blob SHA-1 of each protected file: sha1("blob " + byteLength + "\0" + bytes).
  // Regenerate with: git hash-object pipelines/audit.yaml prompts/audit-correctness.md \
  //   prompts/audit-security.md prompts/audit-synthesis.md
  const PROTECTED: Record<string, string> = {
    "pipelines/audit.yaml": "2db98adee3f717d0f2d670a66a4ce8c292ce3971",
    "prompts/audit-correctness.md": "f2acb2d6f2a1396ac0f949c53d8e086f34675bb9",
    "prompts/audit-security.md": "1200ef6111d2ed8f898d8b61da6eed69c8cc46fc",
    "prompts/audit-synthesis.md": "051d6eede31ae462d2a166089de111854a5449e5",
  };

  const gitBlobSha1 = (bytes: Buffer): string =>
    createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");

  for (const [relPath, expected] of Object.entries(PROTECTED)) {
    it(`${relPath} is byte-identical to its recorded blob hash`, () => {
      const actual = gitBlobSha1(readFileSync(join(repoRoot, ...relPath.split("/"))));
      assert.equal(
        actual,
        expected,
        `${relPath} CHANGED (git blob ${actual}, expected ${expected}). ` +
          'Spec 030\'s non-goal — "audit is not modified by this spec" — forbids editing ' +
          "audit.yaml or its prompts; code-review is a separate pipeline precisely so audit " +
          `stays byte-identical. Confirm with: git hash-object ${relPath}. If the change was ` +
          "deliberate, updating this constant is not enough — spec 030's acceptance criterion 6 " +
          '("byte-identical to what they were before") no longer holds and must be revisited.'
      );
    });
  }

  it("still defines exactly three steps", () => {
    const { def } = loadPipeline(join(repoRoot, "pipelines", "audit.yaml"));
    assert.equal(def.steps.length, 3);
    assert.deepEqual(
      def.steps.map((s) => s.id),
      ["correctness", "security", "synthesis"]
    );
  });

  it("its synthesis step still declares NO permissions block", () => {
    const raw = readFileSync(join(repoRoot, "pipelines", "audit.yaml"), "utf8");
    const doc = parse(raw) as { steps: { id: string; permissions?: unknown }[] };
    const synthesis = doc.steps.find((s) => s.id === "synthesis");
    assert.ok(synthesis, "audit.synthesis step is gone");
    assert.ok(
      !("permissions" in synthesis),
      "audit.synthesis gained a permissions key — contents: read on synthesis belongs to code-review.yaml only (FR-002)."
    );
  });
});

// ---------------------------------------------------------------------------
// Deadlines must be positive: `0` used to mean "no deadline"
// ---------------------------------------------------------------------------

describe("loadPipeline — timeoutMs and defaultTimeoutMs must be positive integers", () => {
  function stepYaml(extra: string): string {
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
    prompt: prompts/intake.md
${extra}
`;
  }

  function loadWith(yaml: string) {
    return loadPipeline("/fake/pipelines/test.yaml", {
      readFile: (p) => (p.endsWith(".yaml") ? yaml : "prompt content"),
    });
  }

  for (const [label, value] of [
    ["zero", "0"],
    ["negative", "-1"],
    ["fractional", "1.5"],
    ["a string", '"600000"'],
  ] as const) {
    it(`rejects a step timeoutMs of ${label}`, () => {
      assert.throws(
        () => loadWith(stepYaml(`    timeoutMs: ${value}`)),
        (err: Error) => {
          assert.match(err.message, /s1/);
          assert.match(err.message, /timeoutMs must be a positive integer/);
          return true;
        }
      );
    });
  }

  it("rejects a pipeline defaultTimeoutMs of zero", () => {
    const yaml = `
id: test
version: 1
description: test
defaultTimeoutMs: 0
inputs:
  - request
steps:
  - id: s1
    kind: llm
    model: sonnet
    prompt: prompts/intake.md
`;
    assert.throws(
      () => loadWith(yaml),
      (err: Error) => {
        assert.match(err.message, /defaultTimeoutMs must be a positive integer/);
        return true;
      }
    );
  });

  it("accepts a positive timeoutMs", () => {
    const { def } = loadWith(stepYaml("    timeoutMs: 1200000"));
    assert.equal(def.steps[0].timeoutMs, 1_200_000);
  });
});

// `produces: spec` publishes a step's answer as the run's spec. A misspelled
// value would be dropped in silence and the gate would keep showing the
// superseded spec, so the canon refuses it at load time.
describe("loadPipeline — produces", () => {
  function yamlWith(stepLines: string): string {
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
${stepLines}
`;
  }

  function loadWith(yaml: string) {
    return loadPipeline("/fake/pipelines/test.yaml", {
      readFile: (p) => (p.endsWith(".yaml") ? yaml : "prompt content"),
    });
  }

  it("accepts produces: spec on an llm step", () => {
    const { def } = loadWith(yamlWith("    produces: spec"));
    assert.equal(def.steps[0].produces, "spec");
  });

  it("rejects any other produces value", () => {
    assert.throws(
      () => loadWith(yamlWith("    produces: plan")),
      (err: Error) => {
        assert.match(err.message, /s1/u);
        assert.match(err.message, /produces must be "spec"/u);
        return true;
      }
    );
  });

  it("rejects produces on a non-llm step", () => {
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
    produces: spec
`;
    assert.throws(
      () => loadWith(yaml),
      (err: Error) => {
        assert.match(err.message, /gate step cannot set produces/u);
        return true;
      }
    );
  });
});
