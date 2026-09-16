import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { loadPipeline } from "../canon/load.js";
import { packageRoot } from "../packageRoot.js";
import { generateWorkflowScript } from "./claudeCode.js";
import type { LoadedPipeline } from "../canon/types.js";

const repoRoot = packageRoot();
// audit.yaml is an all-llm pipeline (supported by Binding A) with a parallel
// level and a sequential level — enough structure to exercise the generator.
const pipelineYaml = join(repoRoot, "pipelines", "audit.yaml");

function getGenerated(): string {
  return generateWorkflowScript(loadPipeline(pipelineYaml));
}

describe("generateWorkflowScript — structural checks", () => {
  it("contains the meta literal with correct name", () => {
    const s = getGenerated();
    assert.ok(s.includes("name: 'audit'"), "meta name missing");
    assert.ok(s.includes("export const meta"), "meta export missing");
  });

  it("contains both phase titles derived from step ids", () => {
    const s = getGenerated();
    assert.ok(s.includes("title: 'Correctness'"), "'Correctness' phase missing");
    assert.ok(s.includes("title: 'Synthesis'"), "'Synthesis' phase missing");
  });

  it("emits the early-abort throw for 'plan' input", () => {
    const s = getGenerated();
    assert.ok(s.includes("args.plan is required"), "early-abort throw for plan missing");
    assert.ok(s.includes("throw new Error"), "throw statement missing");
  });

  it("emits label:'correctness' in the correctness agent call", () => {
    const s = getGenerated();
    assert.ok(s.includes("label: 'correctness'"), "label 'correctness' missing");
  });

  it("emits model variable references for all llm steps", () => {
    const s = getGenerated();
    assert.ok(s.includes("mCorrectness"), "mCorrectness missing");
    assert.ok(s.includes("mSecurity"), "mSecurity missing");
    assert.ok(s.includes("mSynthesis"), "mSynthesis missing");
  });

  it("wraps correctness and security agents in parallel([", () => {
    const s = getGenerated();
    assert.ok(s.includes("await parallel(["), "parallel([ missing");
    const parallelIdx = s.indexOf("await parallel([");
    assert.ok(
      s.slice(parallelIdx).includes("label: 'correctness'"),
      "correctness not inside parallel"
    );
    assert.ok(s.slice(parallelIdx).includes("label: 'security'"), "security not inside parallel");
  });

  it("emits the permissions notice banner", () => {
    const s = getGenerated();
    assert.ok(s.includes("NOTICE: per-step permissions"), "permissions banner missing");
    assert.ok(
      s.includes("are NOT enforced by Binding A"),
      "permissions enforcement disclaimer missing"
    );
  });

  it("has no un-substituted {{ }} placeholders left", () => {
    const s = getGenerated();
    assert.ok(!s.includes("{{"), "Found leftover {{ placeholder in generated script");
  });

  it("does not reference Date.now or Math.random", () => {
    const s = getGenerated();
    assert.ok(!s.includes("Date.now"), "Date.now found — not allowed");
    assert.ok(!s.includes("Math.random"), "Math.random found — not allowed");
  });

  it("syntax check — node --check passes on the generated script", () => {
    const s = getGenerated();
    // The generated script is a workflow body (intended to run inside a function
    // context), so `return` at the top level is invalid in a plain .mjs file.
    // Fix: strip the `export` keyword from the meta declaration and wrap the
    // entire script in an async function — `return` and `await` are then valid.
    const wrapped =
      "(async function() {\n" + s.replace(/\bexport const meta\b/, "const meta") + "\n})";
    const tmpFile = join(tmpdir(), "agent-flows-gen-syntax-check.mjs");
    writeFileSync(tmpFile, wrapped);
    try {
      execSync(`node --check ${tmpFile}`, { stdio: "pipe" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      assert.fail(`node --check failed on generated script:\n${msg}`);
    } finally {
      try {
        unlinkSync(tmpFile);
      } catch {
        // ignore cleanup errors
      }
    }
  });
});

describe("generateWorkflowScript — drift guard", () => {
  it("generated output matches .claude/workflows/audit.js on disk", () => {
    const generated = getGenerated();
    const onDisk = readFileSync(join(repoRoot, ".claude", "workflows", "audit.js"), "utf8");
    assert.equal(
      generated,
      onDisk,
      "Generated script has drifted from .claude/workflows/audit.js — run pnpm bindings:claude to regenerate"
    );
  });
});

// ---------------------------------------------------------------------------
// Refusal tests
// ---------------------------------------------------------------------------

describe("generateWorkflowScript — unsupported kind refusal", () => {
  it("throws for a pipeline containing a 'check' step, naming the step id", () => {
    const loaded: LoadedPipeline = {
      def: {
        id: "with-check",
        version: 1,
        description: "pipeline with a check step",
        inputs: [],
        steps: [{ id: "verify", kind: "check" as const, command: "pnpm test" }],
      },
      prompts: {},
    };
    assert.throws(
      () => generateWorkflowScript(loaded),
      (err: Error) => {
        assert.ok(err.message.includes("with-check"), "error must name the pipeline");
        assert.ok(err.message.includes("verify"), "error must name the step id");
        assert.ok(err.message.includes("check"), "error must name the step kind");
        assert.ok(err.message.includes("Binding A"), "error must say Binding A");
        return true;
      },
      "expected a refusal error for check step"
    );
  });

  it("throws for a pipeline containing a 'loop' step, naming the step id", () => {
    const loaded: LoadedPipeline = {
      def: {
        id: "with-loop",
        version: 1,
        description: "pipeline with a loop step",
        inputs: [],
        steps: [{ id: "converge", kind: "loop" as const, pipeline: "develop", maxIterations: 3 }],
      },
      prompts: {},
    };
    assert.throws(
      () => generateWorkflowScript(loaded),
      (err: Error) => {
        assert.ok(err.message.includes("with-loop"), "error must name the pipeline");
        assert.ok(err.message.includes("converge"), "error must name the step id");
        assert.ok(err.message.includes("loop"), "error must name the step kind");
        assert.ok(err.message.includes("Binding A"), "error must say Binding A");
        return true;
      },
      "expected a refusal error for loop step"
    );
  });

  it("generates successfully for an llm-only pipeline", () => {
    const loaded: LoadedPipeline = {
      def: {
        id: "llm-only",
        version: 1,
        description: "pure llm pipeline",
        inputs: ["task"],
        steps: [
          { id: "work", kind: "llm" as const, role: "worker" as const, prompt: "prompts/work.md" },
        ],
      },
      prompts: { work: "Do the work for {{task}}" },
    };
    // Must not throw
    const s = generateWorkflowScript(loaded);
    assert.ok(s.includes("label: 'work'"), "agent label missing");
  });
});

describe("generateWorkflowScript — model ids are escaped, not interpolated", () => {
  it("emits a quote-bearing model id through the single-quote escaper", () => {
    const hostile = "evil' + process.exit(1) + '";
    const loaded: LoadedPipeline = {
      def: {
        id: "hostile-model",
        version: 1,
        description: "llm step with a quote in its model id",
        inputs: ["task"],
        steps: [
          {
            id: "work",
            kind: "llm" as const,
            role: "worker" as const,
            model: hostile,
            prompt: "prompts/work.md",
          },
        ],
      },
      prompts: { work: "Do the work for {{task}}" },
    };
    const s = generateWorkflowScript(loaded);
    const line = s.split("\n").find((l) => l.startsWith("const mWork ="));
    assert.ok(line, `the model variable must be emitted:\n${s}`);
    assert.equal(line, "const mWork = models['work'] || 'evil\\' + process.exit(1) + \\''");
    // Every quote the model contributes must be backslash-escaped: nothing after
    // the opening quote may close the literal early.
    const literal = line.slice(line.indexOf("|| '") + 4, -1);
    assert.equal(
      literal.replace(/\\'/g, ""),
      "evil + process.exit(1) + ",
      `an unescaped quote escaped the literal: ${line}`
    );

    const wrapped =
      "(async function() {\n" + s.replace(/\bexport const meta\b/, "const meta") + "\n})";
    const tmpFile = join(tmpdir(), "agent-flows-hostile-model-check.mjs");
    writeFileSync(tmpFile, wrapped);
    try {
      execSync(`node --check ${tmpFile}`, { stdio: "pipe" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      assert.fail(`a model id must not be able to break the generated script:\n${msg}`);
    } finally {
      try {
        unlinkSync(tmpFile);
      } catch {
        // ignore cleanup errors
      }
    }
  });
});

// ---------------------------------------------------------------------------
// dependsOn path tests
// ---------------------------------------------------------------------------

/**
 * Build a minimal LoadedPipeline for testing the dependsOn code path.
 * All steps are llm kind with role:worker. Prompts are simple strings.
 */
function makeLoaded(
  steps: { id: string; dependsOn?: string[] }[],
  prompt = "Do the work"
): LoadedPipeline {
  const prompts: Record<string, string> = {};
  for (const s of steps) {
    prompts[s.id] = prompt;
  }
  return {
    def: {
      id: "test",
      version: 1,
      description: "test pipeline",
      inputs: [],
      steps: steps.map((s) => ({
        id: s.id,
        kind: "llm" as const,
        role: "worker" as const,
        prompt: `prompts/${s.id}.md`,
        ...(s.dependsOn !== undefined ? { dependsOn: s.dependsOn } : {}),
      })),
    },
    prompts,
  };
}

describe("generateWorkflowScript — dependsOn path", () => {
  it("a dependsOn pipeline generates phase() per level and wraps multi-step levels in parallel()", () => {
    // Diamond: intake → {critic, security} → assemble_out
    const loaded = makeLoaded([
      { id: "intake" },
      { id: "critic", dependsOn: ["intake"] },
      { id: "security", dependsOn: ["intake"] },
      { id: "assemble_out", dependsOn: ["critic", "security"] },
    ]);
    const s = generateWorkflowScript(loaded);

    // Three levels → three phase() calls
    const phaseMatches = [...s.matchAll(/^phase\(/gm)];
    assert.equal(phaseMatches.length, 3, `expected 3 phase() calls, got ${phaseMatches.length}`);

    // Middle level (critic + security) emits one parallel block
    const parallelMatches = [...s.matchAll(/await parallel\(\[/g)];
    assert.equal(
      parallelMatches.length,
      1,
      `expected 1 parallel([ call, got ${parallelMatches.length}`
    );

    const parallelIdx = s.indexOf("await parallel([");
    assert.ok(s.slice(parallelIdx).includes("label: 'critic'"), "critic not inside parallel block");
    assert.ok(
      s.slice(parallelIdx).includes("label: 'security'"),
      "security not inside parallel block"
    );

    // Level-0 and level-2 steps emit sequential (r_ prefix, no parallel)
    assert.ok(s.includes("const r_intake"), "intake should be sequential (r_ prefix)");
    assert.ok(s.includes("const r_assemble_out"), "assemble_out should be sequential (r_ prefix)");
  });

  it("a diamond produces three phases with the middle one parallel", () => {
    const loaded = makeLoaded([
      { id: "intake" },
      { id: "critic", dependsOn: ["intake"] },
      { id: "security", dependsOn: ["intake"] },
      { id: "assemble_out", dependsOn: ["critic", "security"] },
    ]);
    const s = generateWorkflowScript(loaded);

    // Exactly three phase titles in the meta block
    assert.ok(s.includes("title: 'Intake'"), "meta should have 'Intake' phase");
    assert.ok(s.includes("title: 'Critic'"), "meta should have 'Critic' phase (first in level 1)");
    assert.ok(s.includes("title: 'Assemble_out'"), "meta should have 'Assemble_out' phase");

    // Middle level uses parallel([
    assert.ok(s.includes("await parallel(["), "middle level must emit parallel([");

    // Outer levels use sequential form
    assert.ok(s.includes("const r_intake ="), "level 0 must be sequential");
    assert.ok(s.includes("const r_assemble_out ="), "level 2 must be sequential");

    // Null-guard appears exactly once (on the first sequential step, intake)
    assert.ok(
      s.includes("if (!r_intake) throw new Error('intake agent failed')"),
      "null-guard must be on the first sequential step"
    );
    assert.ok(
      !s.includes("if (!r_assemble_out)"),
      "null-guard must NOT appear on subsequent sequential steps"
    );
  });

  it("a linear chain produces no parallel() at all", () => {
    const loaded = makeLoaded([
      { id: "a" },
      { id: "b", dependsOn: ["a"] },
      { id: "c", dependsOn: ["b"] },
    ]);
    const s = generateWorkflowScript(loaded);

    // Three levels → three phase() calls
    const phaseMatches = [...s.matchAll(/^phase\(/gm)];
    assert.equal(phaseMatches.length, 3, `expected 3 phase() calls, got ${phaseMatches.length}`);

    // No parallel blocks
    assert.ok(!s.includes("await parallel(["), "linear chain must not emit parallel([)");

    // All steps are sequential
    assert.ok(s.includes("const r_a ="), "a must be sequential");
    assert.ok(s.includes("const r_b ="), "b must be sequential");
    assert.ok(s.includes("const r_c ="), "c must be sequential");
  });

  it("parallel first level does not leave null-guard on a subsequent single-step level", () => {
    // Level 0: {p, q} in parallel (neither has dependsOn → both are roots)
    // Level 1: r (depends on both p and q) → single-step, sequential
    const loaded = makeLoaded([{ id: "p" }, { id: "q" }, { id: "r", dependsOn: ["p", "q"] }]);
    const s = generateWorkflowScript(loaded);

    // Level 0 is parallel
    assert.ok(s.includes("await parallel(["), "level 0 must be parallel");
    assert.ok(s.includes("label: 'p'"), "p must be inside the parallel block");
    assert.ok(s.includes("label: 'q'"), "q must be inside the parallel block");

    // Level 1 is sequential but must NOT carry the null-guard
    assert.ok(s.includes("const r_r ="), "r must be emitted as a sequential step");
    assert.ok(
      !s.includes("if (!r_r)"),
      "r must NOT carry the null-guard — it is not the first agent that ran"
    );
  });

  it("single-step first level carries the null-guard", () => {
    // Level 0: just one step → it is genuinely the first agent and should be guarded
    const loaded = makeLoaded([{ id: "first" }, { id: "second", dependsOn: ["first"] }]);
    const s = generateWorkflowScript(loaded);

    assert.ok(
      s.includes("if (!r_first) throw new Error('first agent failed')"),
      "null-guard must be present on the single-step first level"
    );
    assert.ok(
      !s.includes("if (!r_second)"),
      "null-guard must NOT appear on the second sequential step"
    );
  });
});

// ---------------------------------------------------------------------------
// schema emission — parallel AND sequential
// ---------------------------------------------------------------------------

describe("generateWorkflowScript — schema arg", () => {
  it("emits schema: on a schema-gated step that is alone in its level", () => {
    // verify depends on both roots, so it is the only step in its level and takes
    // the sequential emit path — it must still be schema-gated.
    const loaded: LoadedPipeline = {
      def: {
        id: "lone-schema",
        version: 1,
        description: "schema step alone in its level",
        inputs: [],
        steps: [
          { id: "correctness", kind: "llm" as const, role: "worker" as const, prompt: "p.md" },
          { id: "security", kind: "llm" as const, role: "worker" as const, prompt: "p.md" },
          {
            id: "verify",
            kind: "llm" as const,
            role: "reasoner" as const,
            prompt: "p.md",
            dependsOn: ["correctness", "security"],
            schema: "codeReviewFindings" as const,
          },
        ],
      },
      prompts: { correctness: "a", security: "b", verify: "c" },
    };
    const s = generateWorkflowScript(loaded);

    assert.ok(s.includes("const r_verify ="), "verify must take the sequential path");
    assert.ok(
      s.includes("label: 'verify'") && /label: 'verify'[^\n]*schema: CODE_REVIEW_SCHEMA/.test(s),
      "sequential schema-gated step must emit schema: CODE_REVIEW_SCHEMA"
    );
  });

  it("still emits schema: on schema-gated steps inside a parallel level", () => {
    const loaded: LoadedPipeline = {
      def: {
        id: "parallel-schema",
        version: 1,
        description: "schema steps in a parallel level",
        inputs: [],
        steps: [
          {
            id: "critic",
            kind: "llm" as const,
            role: "worker" as const,
            prompt: "p.md",
            schema: "weaknesses" as const,
          },
          {
            id: "security",
            kind: "llm" as const,
            role: "worker" as const,
            prompt: "p.md",
            schema: "securityFindings" as const,
          },
        ],
      },
      prompts: { critic: "a", security: "b" },
    };
    const s = generateWorkflowScript(loaded);

    assert.ok(/label: 'critic'[^\n]*schema: WEAK_SCHEMA/.test(s), "critic schema missing");
    assert.ok(/label: 'security'[^\n]*schema: SEC_SCHEMA/.test(s), "security schema missing");
  });
});

// ---------------------------------------------------------------------------
// return block — with and without an assemble-spec step
// ---------------------------------------------------------------------------

function returnBlockOf(script: string): string {
  const idx = script.lastIndexOf("return {");
  assert.notEqual(idx, -1, "generated script has no return block");
  return script.slice(idx);
}

describe("generateWorkflowScript — return block", () => {
  it("a pipeline without an assemble-spec step never references spec or blocking", () => {
    const loaded = makeLoaded([
      { id: "correctness" },
      { id: "security" },
      { id: "verify", dependsOn: ["correctness", "security"] },
      { id: "synthesis", dependsOn: ["verify"] },
    ]);
    const s = generateWorkflowScript(loaded);

    // `spec` / `blocking` are only declared by an assemble-spec step. Referencing
    // them here would make the script throw on an undefined identifier.
    assert.ok(!/\bconst spec\b/.test(s), "no assemble-spec step should declare spec");
    assert.ok(!/\bspec\b/.test(s), `generated script references undefined spec:\n${s}`);
    assert.ok(!/\bblocking\b/.test(s), "generated script references undefined blocking");

    const ret = returnBlockOf(s);
    assert.ok(ret.includes("synthesis: r_synthesis,"), "final step output must be returned");
    assert.ok(
      ret.includes("steps: ['correctness', 'security', 'verify', 'synthesis'],"),
      `summary must list the step ids that ran, got:\n${ret}`
    );
    assert.ok(ret.includes("finalStep: 'synthesis',"), "summary must name the final step");
  });

  it("a pipeline with an assemble-spec step emits the spec/summary return block unchanged", () => {
    const loaded: LoadedPipeline = {
      def: {
        id: "with-assemble",
        version: 1,
        description: "pipeline with an assemble-spec step",
        inputs: [],
        steps: [
          { id: "intake", kind: "llm" as const, role: "worker" as const, prompt: "p.md" },
          {
            id: "assemble",
            kind: "assemble-spec" as const,
            dependsOn: ["intake"],
          },
        ],
      },
      prompts: { intake: "a" },
    };
    const s = generateWorkflowScript(loaded);

    assert.equal(
      returnBlockOf(s),
      [
        "return {",
        "  spec,",
        "  summary: {",
        "    title: spec.title,",
        "    requirements: spec.requirements.length,",
        "    acceptanceCriteria: spec.acceptanceCriteria.length,",
        "    weaknesses: spec.weaknesses.length,",
        "    securityFindings: spec.securityFindings.length,",
        "    blocking,",
        "  },",
        "}",
      ].join("\n")
    );
  });
});
