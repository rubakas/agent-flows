import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { loadPipeline } from "../canon/load.js";
import { generateWorkflowScript } from "./claudeCode.js";
import type { LoadedPipeline } from "../canon/types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = join(__dirname, "..", "..");
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
