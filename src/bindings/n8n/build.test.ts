import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { loadPipeline } from "../../canon/load.js";
import {
  WORKSPACE_DIR_EXPR,
  AGENT_FLOWS_NODE_TYPE,
  LLM_STEP_PARAMS,
  generateN8nWorkflow,
} from "./build.js";
import type { LoadedPipeline, StepDef } from "../../canon/types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = join(__dirname, "..", "..", "..");
const specCreationYaml = join(repoRoot, "pipelines", "spec-creation.yaml");
const investigateYaml = join(repoRoot, "pipelines", "investigate.yaml");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLoaded(steps: StepDef[], prompts: Record<string, string> = {}): LoadedPipeline {
  return {
    def: {
      id: "test-pipeline",
      version: 1,
      description: "Test pipeline",
      inputs: ["request"],
      steps,
    },
    prompts,
  };
}

function getInputsNode(wf: ReturnType<typeof generateN8nWorkflow>) {
  return wf.nodes.find((n) => n.name === "Inputs");
}

function getInputsFieldNames(wf: ReturnType<typeof generateN8nWorkflow>): string[] {
  const node = getInputsNode(wf);
  if (!node) return [];
  const assignments = (node.parameters.assignments as { assignments: { name: string }[] })
    .assignments;
  return assignments.map((a) => a.name);
}

// ---------------------------------------------------------------------------
// Linear chain: A → B → C
// ---------------------------------------------------------------------------

describe("generateN8nWorkflow — linear chain", () => {
  const loaded = makeLoaded(
    [
      { id: "stepA", kind: "llm", role: "worker" },
      { id: "stepB", kind: "llm", role: "reasoner", dependsOn: ["stepA"] },
      { id: "stepC", kind: "llm", role: "worker", dependsOn: ["stepB"] },
    ],
    { stepA: "Do A for {{request}}", stepB: "Do B", stepC: "" }
  );

  const wf = generateN8nWorkflow(loaded);

  it("produces a manual trigger node", () => {
    const trigger = wf.nodes.find((n) => n.type === "n8n-nodes-base.manualTrigger");
    assert.ok(trigger, "manual trigger node missing");
    assert.equal(trigger.name, "Manual Trigger");
    assert.deepEqual(trigger.position, [100, 300]);
  });

  it("produces an Inputs node of type n8n-nodes-base.set", () => {
    const inputs = getInputsNode(wf);
    assert.ok(inputs, "Inputs node missing");
    assert.equal(inputs.type, "n8n-nodes-base.set");
  });

  it("Inputs node exposes pipeline inputs plus projectDir as fields", () => {
    const fields = getInputsFieldNames(wf);
    assert.ok(fields.includes("request"), "Inputs missing 'request' field");
    assert.ok(fields.includes("projectDir"), "Inputs missing 'projectDir' field");
  });

  it("produces one node per step plus trigger and Inputs", () => {
    // 3 steps + 1 trigger + 1 Inputs
    assert.equal(wf.nodes.length, 5);
    const byName = new Map(wf.nodes.map((n) => [n.name, n]));
    assert.equal(byName.get("stepA")?.type, AGENT_FLOWS_NODE_TYPE, "stepA type");
    assert.equal(byName.get("stepB")?.type, AGENT_FLOWS_NODE_TYPE, "stepB type");
    assert.equal(byName.get("stepC")?.type, AGENT_FLOWS_NODE_TYPE, "stepC type");
  });

  it("llm nodes carry workspaceAccess, workspaceDirectory, prompt, timeoutMs parameters", () => {
    const nodeA = wf.nodes.find((n) => n.name === "stepA")!;
    assert.equal(nodeA.parameters.role, "worker");
    assert.equal(nodeA.parameters.workspaceAccess, "none");
    assert.equal(nodeA.parameters.workspaceDirectory, WORKSPACE_DIR_EXPR);
    assert.equal(typeof nodeA.parameters.timeoutMs, "number");
  });

  it("llm nodes do not carry contentsAccess, workspaceDir, or skills", () => {
    const nodeA = wf.nodes.find((n) => n.name === "stepA")!;
    assert.equal(nodeA.parameters.contentsAccess, undefined, "contentsAccess must be absent");
    assert.equal(nodeA.parameters.workspaceDir, undefined, "workspaceDir must be absent");
    assert.equal(nodeA.parameters.skills, undefined, "skills must be absent");
  });

  it("prompt with placeholder is rewritten to n8n expression", () => {
    const nodeA = wf.nodes.find((n) => n.name === "stepA")!;
    const prompt = nodeA.parameters.prompt as string;
    assert.ok(prompt.startsWith("="), "prompt must start with = for expression mode");
    assert.ok(
      prompt.includes(`$('Inputs').first().json["request"]`),
      "prompt must reference Inputs node for pipeline input"
    );
    assert.ok(prompt.includes("Do A for"), "literal text must be preserved");
  });

  it("prompt without placeholder is emitted as plain string", () => {
    const nodeB = wf.nodes.find((n) => n.name === "stepB")!;
    assert.equal(nodeB.parameters.prompt, "Do B");
  });

  it("llm node with no prompt falls back to empty string", () => {
    const nodeC = wf.nodes.find((n) => n.name === "stepC")!;
    assert.equal(nodeC.parameters.prompt, "");
  });

  it("Manual Trigger connects to Inputs", () => {
    assert.deepEqual(wf.connections["Manual Trigger"], {
      main: [[{ node: "Inputs", type: "main", index: 0 }]],
    });
  });

  it("Inputs connects to level-0 steps", () => {
    assert.deepEqual(wf.connections.Inputs, {
      main: [[{ node: "stepA", type: "main", index: 0 }]],
    });
  });

  it("connections follow the linear DAG beyond Inputs", () => {
    assert.deepEqual(wf.connections.stepA, {
      main: [[{ node: "stepB", type: "main", index: 0 }]],
    });
    assert.deepEqual(wf.connections.stepB, {
      main: [[{ node: "stepC", type: "main", index: 0 }]],
    });
    assert.equal(wf.connections.stepC, undefined);
  });

  it("serialises to JSON without throwing", () => {
    assert.doesNotThrow(() => JSON.stringify(wf));
  });
});

// ---------------------------------------------------------------------------
// Fan-out / fan-in: root → [left, right] → merge
// ---------------------------------------------------------------------------

describe("generateN8nWorkflow — fan-out and fan-in", () => {
  const loaded = makeLoaded(
    [
      { id: "root", kind: "llm", role: "worker" },
      { id: "left", kind: "llm", role: "reasoner", dependsOn: ["root"] },
      { id: "right", kind: "llm", role: "reasoner", dependsOn: ["root"] },
      { id: "merge", kind: "llm", role: "worker", dependsOn: ["left", "right"] },
    ],
    { root: "Root prompt", left: "Left prompt", right: "Right prompt", merge: "Merge prompt" }
  );

  const wf = generateN8nWorkflow(loaded);

  it("has 6 nodes (trigger + Inputs + 4 steps)", () => {
    assert.equal(wf.nodes.length, 6);
  });

  it("trigger connects to Inputs", () => {
    assert.deepEqual(wf.connections["Manual Trigger"], {
      main: [[{ node: "Inputs", type: "main", index: 0 }]],
    });
  });

  it("Inputs connects only to root (level 0)", () => {
    assert.deepEqual(wf.connections.Inputs, {
      main: [[{ node: "root", type: "main", index: 0 }]],
    });
  });

  it("root fans out to left and right", () => {
    const targets = wf.connections.root?.main[0];
    assert.ok(targets, "root has no connections");
    const nodeNames = targets.map((c) => c.node);
    assert.ok(nodeNames.includes("left"), "left missing from root connections");
    assert.ok(nodeNames.includes("right"), "right missing from root connections");
  });

  it("left feeds merge", () => {
    assert.deepEqual(wf.connections.left, {
      main: [[{ node: "merge", type: "main", index: 0 }]],
    });
  });

  it("right feeds merge", () => {
    assert.deepEqual(wf.connections.right, {
      main: [[{ node: "merge", type: "main", index: 0 }]],
    });
  });

  it("merge has no outgoing connections", () => {
    assert.equal(wf.connections.merge, undefined);
  });

  it("serialises to JSON without throwing", () => {
    assert.doesNotThrow(() => JSON.stringify(wf));
  });
});

// ---------------------------------------------------------------------------
// Step kind mapping
// ---------------------------------------------------------------------------

describe("generateN8nWorkflow — step kind → node type", () => {
  // FR-006: gate/assemble-spec/persist-ticket steps are NoOps. This pipeline has
  // no llm prompts that reference them, so generation succeeds. The FR-006 error
  // path is tested in the "loud failures" suite below.
  const loaded = makeLoaded([
    { id: "llmStep", kind: "llm", role: "worker" },
    { id: "gateStep", kind: "gate", message: "Approve?", dependsOn: ["llmStep"] },
    { id: "assembleStep", kind: "assemble-spec", dependsOn: ["gateStep"] },
    { id: "persistStep", kind: "persist-ticket", dependsOn: ["assembleStep"] },
  ]);

  const wf = generateN8nWorkflow(loaded);
  const byName = new Map(wf.nodes.map((n) => [n.name, n]));

  it("llm → AGENT_FLOWS_NODE_TYPE", () => {
    assert.equal(byName.get("llmStep")?.type, AGENT_FLOWS_NODE_TYPE);
  });

  it("gate → n8n-nodes-base.noOp with message as notes", () => {
    const node = byName.get("gateStep")!;
    assert.equal(node.type, "n8n-nodes-base.noOp");
    assert.equal(node.notes, "Approve?");
  });

  it("assemble-spec → n8n-nodes-base.noOp", () => {
    assert.equal(byName.get("assembleStep")?.type, "n8n-nodes-base.noOp");
  });

  it("persist-ticket → n8n-nodes-base.noOp", () => {
    assert.equal(byName.get("persistStep")?.type, "n8n-nodes-base.noOp");
  });
});

// ---------------------------------------------------------------------------
// FR-006 and FR-007: loud failure cases
// ---------------------------------------------------------------------------

describe("generateN8nWorkflow — loud failures (FR-006 / FR-007)", () => {
  it("throws when a prompt references a gate step (FR-006)", () => {
    const loaded = makeLoaded(
      [
        { id: "gateStep", kind: "gate", message: "OK?" },
        { id: "llmStep", kind: "llm", role: "worker", dependsOn: ["gateStep"] },
      ],
      { llmStep: "Result: {{gateStep}}" }
    );
    assert.throws(
      () => generateN8nWorkflow(loaded),
      (err: Error) => {
        assert.ok(err.message.includes("llmStep"), "error must name the referencing step");
        assert.ok(err.message.includes("gateStep"), "error must name the placeholder");
        assert.ok(err.message.includes("gate"), "error must state the step kind");
        return true;
      }
    );
  });

  it("throws when a prompt references a loop step (FR-006)", () => {
    const loaded = makeLoaded(
      [
        { id: "loopStep", kind: "loop", pipeline: "build-round", maxIterations: 3 },
        { id: "llmStep", kind: "llm", role: "worker", dependsOn: ["loopStep"] },
      ],
      { llmStep: "Output: {{loopStep}}" }
    );
    assert.throws(
      () => generateN8nWorkflow(loaded),
      (err: Error) => {
        assert.ok(err.message.includes("loop"), "error must state the step kind");
        return true;
      }
    );
  });

  it("throws when a prompt references an export-spec step (FR-006)", () => {
    const loaded = makeLoaded(
      [
        { id: "exportStep", kind: "export-spec", path: "specs/foo" },
        { id: "llmStep", kind: "llm", role: "worker", dependsOn: ["exportStep"] },
      ],
      { llmStep: "Output: {{exportStep}}" }
    );
    assert.throws(
      () => generateN8nWorkflow(loaded),
      (err: Error) => {
        assert.ok(err.message.includes("export-spec"), "error must state the step kind");
        return true;
      }
    );
  });

  it("throws when a prompt references an assemble-spec step (FR-006)", () => {
    const loaded = makeLoaded(
      [
        { id: "assembleStep", kind: "assemble-spec" },
        { id: "llmStep", kind: "llm", role: "worker", dependsOn: ["assembleStep"] },
      ],
      { llmStep: "Output: {{assembleStep}}" }
    );
    assert.throws(
      () => generateN8nWorkflow(loaded),
      (err: Error) => {
        assert.ok(err.message.includes("assemble-spec"), "error must state the step kind");
        return true;
      }
    );
  });

  it("throws when a prompt references a persist-ticket step (FR-006)", () => {
    const loaded = makeLoaded(
      [
        { id: "persistStep", kind: "persist-ticket" },
        { id: "llmStep", kind: "llm", role: "worker", dependsOn: ["persistStep"] },
      ],
      { llmStep: "Output: {{persistStep}}" }
    );
    assert.throws(
      () => generateN8nWorkflow(loaded),
      (err: Error) => {
        assert.ok(err.message.includes("persist-ticket"), "error must state the step kind");
        return true;
      }
    );
  });

  it("throws when a prompt references {{models}} (FR-006)", () => {
    const loaded = makeLoaded([{ id: "llmStep", kind: "llm", role: "worker" }], {
      llmStep: "Use model: {{models}}",
    });
    // Note: load.ts also validates placeholders; we bypass it by using makeLoaded
    // with a manually crafted prompt. The canon loader would accept {{models}} as
    // always-available. Binding C must reject it.
    assert.throws(
      () => generateN8nWorkflow(loaded),
      (err: Error) => {
        assert.ok(err.message.includes("llmStep"), "error must name the referencing step");
        assert.ok(err.message.includes("models"), "error must mention the models key");
        return true;
      }
    );
  });

  it("throws when a step id equals 'Inputs' (FR-007)", () => {
    const loaded = makeLoaded([{ id: "Inputs", kind: "llm", role: "worker" }], {
      Inputs: "hello",
    });
    assert.throws(
      () => generateN8nWorkflow(loaded),
      (err: Error) => {
        assert.ok(err.message.includes("Inputs"), "error must name the colliding id");
        return true;
      }
    );
  });

  it("throws when a step id equals 'Manual Trigger' (FR-007)", () => {
    const loaded = makeLoaded([{ id: "Manual Trigger", kind: "llm", role: "worker" }], {
      "Manual Trigger": "hello",
    });
    assert.throws(
      () => generateN8nWorkflow(loaded),
      (err: Error) => {
        assert.ok(err.message.includes("Manual Trigger"), "error must name the colliding id");
        return true;
      }
    );
  });
});

// ---------------------------------------------------------------------------
// FR-002 / FR-003: prompt expression rewriting
// ---------------------------------------------------------------------------

describe("generateN8nWorkflow — prompt expression rewriting (FR-002/FR-003)", () => {
  it("pipeline input placeholder → Inputs node reference", () => {
    const loaded = makeLoaded([{ id: "stepA", kind: "llm", role: "worker" }], {
      stepA: "Request: {{request}}",
    });
    const wf = generateN8nWorkflow(loaded);
    const node = wf.nodes.find((n) => n.name === "stepA")!;
    const prompt = node.parameters.prompt as string;
    assert.ok(prompt.startsWith("="), "must start with = for expression mode");
    assert.ok(prompt.includes(`$('Inputs').first().json["request"]`), "must reference Inputs node");
    assert.ok(prompt.includes("Request: "), "literal text preserved");
  });

  it("llm step ancestor placeholder → upstream node output reference", () => {
    const loaded = makeLoaded(
      [
        { id: "survey", kind: "llm", role: "scout" },
        { id: "findings", kind: "llm", role: "reasoner", dependsOn: ["survey"] },
      ],
      { survey: "Survey text", findings: "Summary of: {{survey}}" }
    );
    const wf = generateN8nWorkflow(loaded);
    const node = wf.nodes.find((n) => n.name === "findings")!;
    const prompt = node.parameters.prompt as string;
    assert.ok(prompt.startsWith("="));
    assert.ok(prompt.includes(`$("survey").first().json.output`), "llm step → .json.output");
  });

  it("check step ancestor placeholder → upstream node stdout reference", () => {
    const loaded = makeLoaded(
      [
        { id: "runTests", kind: "check", command: "pnpm test" },
        { id: "analyst", kind: "llm", role: "worker", dependsOn: ["runTests"] },
      ],
      { analyst: "Test output: {{runTests}}" }
    );
    const wf = generateN8nWorkflow(loaded);
    const node = wf.nodes.find((n) => n.name === "analyst")!;
    const prompt = node.parameters.prompt as string;
    assert.ok(prompt.startsWith("="));
    assert.ok(prompt.includes(`$("runTests").first().json.stdout`), "check step → .json.stdout");
  });

  it("dotted step id is safely quoted via JSON.stringify", () => {
    const loaded: LoadedPipeline = {
      def: {
        id: "test-pipeline",
        version: 1,
        description: "Test",
        inputs: [],
        steps: [
          { id: "verify.synthesis", kind: "llm", role: "reasoner" },
          {
            id: "consumer",
            kind: "llm",
            role: "worker",
            dependsOn: ["verify.synthesis"],
          },
        ],
      },
      prompts: {
        "verify.synthesis": "Synthesis text",
        consumer: "Based on: {{verify.synthesis}}",
      },
    };
    const wf = generateN8nWorkflow(loaded);
    const node = wf.nodes.find((n) => n.name === "consumer")!;
    const prompt = node.parameters.prompt as string;
    assert.ok(prompt.includes(`$("verify.synthesis").first().json.output`));
  });

  it("stray braces in literal segments are escaped with String.fromCharCode", () => {
    const loaded = makeLoaded([{ id: "stepA", kind: "llm", role: "worker" }], {
      stepA: "Do {{request}} with {json: true}",
    });
    const wf = generateN8nWorkflow(loaded);
    const prompt = wf.nodes.find((n) => n.name === "stepA")!.parameters.prompt as string;
    assert.ok(prompt.startsWith("="));
    assert.ok(prompt.includes("String.fromCharCode(123)"), "{ must be escaped");
    assert.ok(prompt.includes("String.fromCharCode(125)"), "} must be escaped");
    // After the expression, the literal segments must contain no bare braces
    // (other than n8n expression delimiters {{ and }}).
    const withoutExprs = prompt.replace(/\{\{[^}]*\}\}/g, "");
    assert.ok(!withoutExprs.includes("{"), "no bare { in literal segments");
    assert.ok(!withoutExprs.includes("}"), "no bare } in literal segments");
  });

  it("placeholder-free prompt is emitted as plain string", () => {
    const loaded = makeLoaded([{ id: "stepA", kind: "llm", role: "worker" }], {
      stepA: "No placeholders here",
    });
    const wf = generateN8nWorkflow(loaded);
    const prompt = wf.nodes.find((n) => n.name === "stepA")!.parameters.prompt as string;
    assert.equal(prompt, "No placeholders here");
  });

  it("placeholder-free prompt starting with = is wrapped to prevent accidental expression", () => {
    const loaded = makeLoaded([{ id: "stepA", kind: "llm", role: "worker" }], {
      stepA: "=some literal text",
    });
    const wf = generateN8nWorkflow(loaded);
    const prompt = wf.nodes.find((n) => n.name === "stepA")!.parameters.prompt as string;
    assert.ok(prompt.startsWith("={{"), "must be wrapped as expression");
    assert.ok(prompt.includes('"=some literal text"'), "original text must be JSON-stringified");
  });
});

// ---------------------------------------------------------------------------
// FR-005: renamed parameters and dropped fields
// ---------------------------------------------------------------------------

describe("generateN8nWorkflow — FR-005 parameter names", () => {
  it("emits workspaceAccess from permissions.contents", () => {
    const loaded = makeLoaded(
      [{ id: "s", kind: "llm", role: "worker", permissions: { contents: "read" } }],
      { s: "prompt" }
    );
    const wf = generateN8nWorkflow(loaded);
    const node = wf.nodes.find((n) => n.name === "s")!;
    assert.equal(node.parameters.workspaceAccess, "read");
  });

  it("emits workspaceAccess: write for permissions.contents write (FR-009 round-trip)", () => {
    const loaded = makeLoaded(
      [{ id: "impl", kind: "llm", role: "worker", permissions: { contents: "write" } }],
      { impl: "Implement" }
    );
    const wf = generateN8nWorkflow(loaded);
    const node = wf.nodes.find((n) => n.name === "impl")!;
    assert.equal(node.parameters.workspaceAccess, "write");
  });

  it("emits workspaceAccess: none when permissions absent", () => {
    const loaded = makeLoaded([{ id: "s", kind: "llm", role: "worker" }], { s: "p" });
    const wf = generateN8nWorkflow(loaded);
    const node = wf.nodes.find((n) => n.name === "s")!;
    assert.equal(node.parameters.workspaceAccess, "none");
  });

  it("emits workspaceDirectory as WORKSPACE_DIR_EXPR", () => {
    const loaded = makeLoaded([{ id: "s", kind: "llm", role: "worker" }], { s: "p" });
    const wf = generateN8nWorkflow(loaded);
    const node = wf.nodes.find((n) => n.name === "s")!;
    assert.equal(node.parameters.workspaceDirectory, WORKSPACE_DIR_EXPR);
  });

  it("WORKSPACE_DIR_EXPR references the Inputs node", () => {
    assert.ok(WORKSPACE_DIR_EXPR.includes("$('Inputs')"), "must reference Inputs node, not $json");
  });

  it("does not emit contentsAccess, workspaceDir, or skills", () => {
    const loaded = makeLoaded([{ id: "s", kind: "llm", role: "worker", skills: ["git"] }], {
      s: "p",
    });
    const wf = generateN8nWorkflow(loaded);
    const node = wf.nodes.find((n) => n.name === "s")!;
    assert.equal(node.parameters.contentsAccess, undefined);
    assert.equal(node.parameters.workspaceDir, undefined);
    assert.equal(node.parameters.skills, undefined);
  });

  it("emits timeoutMs from step.timeoutMs when set", () => {
    const loaded = makeLoaded([{ id: "impl", kind: "llm", role: "worker", timeoutMs: 0 }], {
      impl: "p",
    });
    const wf = generateN8nWorkflow(loaded);
    const node = wf.nodes.find((n) => n.name === "impl")!;
    assert.equal(node.parameters.timeoutMs, 0);
  });

  it("emits timeoutMs: 0 (no limit) when step declares no timeoutMs", () => {
    const loaded = makeLoaded([{ id: "s", kind: "llm", role: "worker" }], { s: "p" });
    const wf = generateN8nWorkflow(loaded);
    const node = wf.nodes.find((n) => n.name === "s")!;
    assert.equal(node.parameters.timeoutMs, 0);
  });
});

// ---------------------------------------------------------------------------
// Regression: no generated workflow carries a hardcoded 600000 timeout
// ---------------------------------------------------------------------------

describe("generateN8nWorkflow — no hardcoded 600000 timeout regression", () => {
  it("investigate.yaml generates no node with timeoutMs 600000", () => {
    const loaded = loadPipeline(investigateYaml);
    const wf = generateN8nWorkflow(loaded);
    for (const node of wf.nodes) {
      assert.notEqual(
        node.parameters.timeoutMs,
        600_000,
        `Node "${node.name}" carries a hardcoded 600000 timeout — spec 024 forbids this`
      );
    }
  });

  it("a step with no declared timeoutMs produces a node with timeoutMs 0", () => {
    const loaded = makeLoaded([{ id: "step", kind: "llm", role: "worker" }], { step: "p" });
    const wf = generateN8nWorkflow(loaded);
    const node = wf.nodes.find((n) => n.name === "step")!;
    assert.equal(node.parameters.timeoutMs, 0, "no-timeout step must emit 0, not 600000");
  });
});

// ---------------------------------------------------------------------------
// FR-001: Inputs node graph shape — investigate.yaml
// ---------------------------------------------------------------------------

describe("generateN8nWorkflow — investigate.yaml graph shape (FR-001)", () => {
  const loaded = loadPipeline(investigateYaml);
  const wf = generateN8nWorkflow(loaded);

  it("contains Manual Trigger → Inputs → survey → findings", () => {
    assert.deepEqual(wf.connections["Manual Trigger"], {
      main: [[{ node: "Inputs", type: "main", index: 0 }]],
    });
    assert.deepEqual(wf.connections.Inputs, {
      main: [[{ node: "survey", type: "main", index: 0 }]],
    });
    assert.deepEqual(wf.connections.survey, {
      main: [[{ node: "findings", type: "main", index: 0 }]],
    });
  });

  it("Inputs node has fields 'request' and 'projectDir'", () => {
    const fields = getInputsFieldNames(wf);
    assert.ok(fields.includes("request"), "missing 'request'");
    assert.ok(fields.includes("projectDir"), "missing 'projectDir'");
  });

  it("survey and findings carry workspaceAccess / workspaceDirectory, not contentsAccess / workspaceDir / skills", () => {
    for (const name of ["survey", "findings"]) {
      const node = wf.nodes.find((n) => n.name === name)!;
      assert.ok("workspaceAccess" in node.parameters, `${name} missing workspaceAccess`);
      assert.ok("workspaceDirectory" in node.parameters, `${name} missing workspaceDirectory`);
      assert.equal(
        node.parameters.contentsAccess,
        undefined,
        `${name} must not have contentsAccess`
      );
      assert.equal(node.parameters.workspaceDir, undefined, `${name} must not have workspaceDir`);
      assert.equal(node.parameters.skills, undefined, `${name} must not have skills`);
    }
  });

  it("prompts no longer contain literal {{...}} placeholders", () => {
    for (const name of ["survey", "findings"]) {
      const node = wf.nodes.find((n) => n.name === name)!;
      const prompt = node.parameters.prompt as string;
      // The prompt is an expression (starts with =) when it had placeholders.
      // There must be no raw {{word}} patterns that look like unparsed placeholders.
      // The only {{ }} that may appear are n8n expression delimiters (valid expressions).
      // A literal canon placeholder like {{request}} would not contain a function call.
      assert.ok(
        !/\{\{[\w.]+\}\}/u.exec(prompt),
        `${name} prompt must not contain literal canon placeholders`
      );
    }
  });

  it("produces 4 nodes total (trigger + Inputs + 2 steps)", () => {
    assert.equal(wf.nodes.length, 4);
  });

  it("serialises to JSON without throwing", () => {
    assert.doesNotThrow(() => JSON.stringify(wf));
  });
});

// ---------------------------------------------------------------------------
// FR-006: spec-creation.yaml fails to generate (references assemble-spec NoOp)
// ---------------------------------------------------------------------------

describe("generateN8nWorkflow — spec-creation.yaml fails under FR-006", () => {
  const loaded = loadPipeline(specCreationYaml);

  it("throws because an llm prompt references an assemble-spec (NoOp) step", () => {
    assert.throws(
      () => generateN8nWorkflow(loaded),
      (err: Error) => {
        assert.ok(err instanceof Error);
        assert.ok(
          err.message.includes("assemble-spec") || err.message.includes("assemble"),
          `expected error mentioning assemble-spec, got: ${err.message}`
        );
        return true;
      }
    );
  });
});

// ---------------------------------------------------------------------------
// Check step → executeCommand node
// ---------------------------------------------------------------------------

describe("generateN8nWorkflow — check step", () => {
  const loaded = makeLoaded([{ id: "runTests", kind: "check", command: "pnpm test" }]);
  const wf = generateN8nWorkflow(loaded);
  const byName = new Map(wf.nodes.map((n) => [n.name, n]));

  it("check step maps to n8n-nodes-base.executeCommand", () => {
    assert.equal(byName.get("runTests")?.type, "n8n-nodes-base.executeCommand");
  });

  it("executeCommand node carries the command in parameters", () => {
    assert.equal(byName.get("runTests")?.parameters.command, "pnpm test");
  });

  it("serialises to JSON without throwing", () => {
    assert.doesNotThrow(() => JSON.stringify(wf));
  });
});

// ---------------------------------------------------------------------------
// FR-010: parameter contract — Binding C emitted params == node-read params
// ---------------------------------------------------------------------------

describe("FR-010 — parameter contract: emitted params equal node-read params", () => {
  /**
   * The complete set of parameters the AgentFlowsAgent node reads in its execute method
   * (getNodeParameter calls, lines 371-376 of AgentFlowsAgent.node.ts).
   * This list is the authoritative node-side contract.
   */
  const NODE_READ_PARAMS = Object.freeze([
    "role",
    "model",
    "workspaceAccess",
    "workspaceDirectory",
    "prompt",
    "timeoutMs",
  ]);

  it("LLM_STEP_PARAMS equals the node-read params set exactly", () => {
    const emitted = new Set(LLM_STEP_PARAMS);
    const nodeReads = new Set(NODE_READ_PARAMS);

    const onlyInEmitted = [...emitted].filter((k) => !nodeReads.has(k));
    const onlyInNode = [...nodeReads].filter((k) => !emitted.has(k));

    assert.deepEqual(
      onlyInEmitted,
      [],
      `Binding C emits parameters the node does not read: ${onlyInEmitted.join(", ")}`
    );
    assert.deepEqual(
      onlyInNode,
      [],
      `Node reads parameters Binding C does not emit: ${onlyInNode.join(", ")}`
    );
  });

  it("a generated llm node's parameter keys equal LLM_STEP_PARAMS", () => {
    const loaded = makeLoaded([{ id: "impl", kind: "llm", role: "worker" }], { impl: "Do it" });
    const wf = generateN8nWorkflow(loaded);
    const node = wf.nodes.find((n) => n.name === "impl")!;
    const emittedKeys = new Set(Object.keys(node.parameters));
    const expectedKeys = new Set(LLM_STEP_PARAMS);

    const extra = [...emittedKeys].filter((k) => !expectedKeys.has(k));
    const missing = [...expectedKeys].filter((k) => !emittedKeys.has(k));

    assert.deepEqual(
      extra,
      [],
      `Generated node has unexpected parameter keys: ${extra.join(", ")}`
    );
    assert.deepEqual(
      missing,
      [],
      `Generated node is missing parameter keys: ${missing.join(", ")}`
    );
  });
});
