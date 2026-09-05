import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { loadPipeline } from "../../canon/load.js";
import { WORKSPACE_DIR_EXPR, YOKE_NODE_TYPE, generateN8nWorkflow } from "./build.js";
import type { LoadedPipeline, StepDef } from "../../canon/types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = join(__dirname, "..", "..", "..");
const specCreationYaml = join(repoRoot, "pipelines", "spec-creation.yaml");

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

  it("produces one node per step with correct types", () => {
    // 3 steps + 1 trigger
    assert.equal(wf.nodes.length, 4);
    const byName = new Map(wf.nodes.map((n) => [n.name, n]));
    assert.equal(byName.get("stepA")?.type, YOKE_NODE_TYPE, "stepA type");
    assert.equal(byName.get("stepB")?.type, YOKE_NODE_TYPE, "stepB type");
    assert.equal(byName.get("stepC")?.type, YOKE_NODE_TYPE, "stepC type");
  });

  it("llm nodes carry role, contentsAccess, workspaceDir, and prompt parameters", () => {
    const nodeA = wf.nodes.find((n) => n.name === "stepA")!;
    assert.equal(nodeA.parameters.role, "worker");
    assert.equal(nodeA.parameters.contentsAccess, "none");
    assert.equal(nodeA.parameters.workspaceDir, WORKSPACE_DIR_EXPR);
    assert.equal(nodeA.parameters.prompt, "Do A for {{request}}");
  });

  it("llm node with no prompt falls back to empty string", () => {
    const nodeC = wf.nodes.find((n) => n.name === "stepC")!;
    assert.equal(nodeC.parameters.prompt, "");
  });

  it("connections follow the linear DAG", () => {
    assert.deepEqual(wf.connections["Manual Trigger"], {
      main: [[{ node: "stepA", type: "main", index: 0 }]],
    });
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

  it("has 5 nodes (trigger + 4 steps)", () => {
    assert.equal(wf.nodes.length, 5);
  });

  it("trigger connects only to root (level 0)", () => {
    assert.deepEqual(wf.connections["Manual Trigger"], {
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
  const loaded = makeLoaded([
    { id: "llmStep", kind: "llm", role: "worker" },
    { id: "gateStep", kind: "gate", message: "Approve?", dependsOn: ["llmStep"] },
    { id: "assembleStep", kind: "assemble-spec", dependsOn: ["gateStep"] },
    { id: "persistStep", kind: "persist-ticket", dependsOn: ["assembleStep"] },
  ]);

  const wf = generateN8nWorkflow(loaded);
  const byName = new Map(wf.nodes.map((n) => [n.name, n]));

  it("llm → YOKE_NODE_TYPE", () => {
    assert.equal(byName.get("llmStep")?.type, YOKE_NODE_TYPE);
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
// spec-creation.yaml (real pipeline, 8 steps)
// ---------------------------------------------------------------------------

describe("generateN8nWorkflow — spec-creation.yaml", () => {
  const loaded = loadPipeline(specCreationYaml);
  const wf = generateN8nWorkflow(loaded);

  it("produces 9 nodes total (trigger + 8 steps)", () => {
    assert.equal(wf.nodes.length, 9, `expected 9 nodes, got ${wf.nodes.length}`);
  });

  it("has a manual trigger node", () => {
    const trigger = wf.nodes.find((n) => n.type === "n8n-nodes-base.manualTrigger");
    assert.ok(trigger, "manual trigger missing");
  });

  it("all llm steps use YOKE_NODE_TYPE", () => {
    const llmIds = ["intake", "enrich", "critic", "security"];
    const byName = new Map(wf.nodes.map((n) => [n.name, n]));
    for (const id of llmIds) {
      assert.equal(byName.get(id)?.type, YOKE_NODE_TYPE, `${id} should be ${YOKE_NODE_TYPE}`);
    }
  });

  it("non-llm steps use noOp", () => {
    const noopIds = ["assemble", "approve", "persist"];
    const byName = new Map(wf.nodes.map((n) => [n.name, n]));
    for (const id of noopIds) {
      assert.equal(byName.get(id)?.type, "n8n-nodes-base.noOp", `${id} should be noOp`);
    }
  });

  it("enrich fans out to critic and security", () => {
    const enrichConns = wf.connections.enrich?.main[0];
    assert.ok(enrichConns, "enrich has no connections");
    const targets = enrichConns.map((c) => c.node);
    assert.ok(targets.includes("critic"), "critic not in enrich fan-out");
    assert.ok(targets.includes("security"), "security not in enrich fan-out");
  });

  it("critic feeds assemble", () => {
    assert.deepEqual(wf.connections.critic, {
      main: [[{ node: "assemble", type: "main", index: 0 }]],
    });
  });

  it("security feeds assemble", () => {
    assert.deepEqual(wf.connections.security, {
      main: [[{ node: "assemble", type: "main", index: 0 }]],
    });
  });

  it("llm nodes carry workspaceDir as WORKSPACE_DIR_EXPR", () => {
    const llmNodes = wf.nodes.filter((n) => n.type === YOKE_NODE_TYPE);
    for (const n of llmNodes) {
      assert.equal(
        n.parameters.workspaceDir,
        WORKSPACE_DIR_EXPR,
        `${n.name} workspaceDir should be WORKSPACE_DIR_EXPR`
      );
    }
  });

  it("serialises to JSON without throwing", () => {
    assert.doesNotThrow(() => JSON.stringify(wf));
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
