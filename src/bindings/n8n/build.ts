import { randomUUID } from "node:crypto";
import { pipelineLevels } from "../../canon/graph.js";
import type { LoadedPipeline, StepDef } from "../../canon/types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** n8n node type for Yoke LLM steps. Change here when the node package finalises the type string. */
export const YOKE_NODE_TYPE = "n8n-nodes-yoke.yokeAgent";

/**
 * Single-source expression for the project directory.
 * Every Yoke node emits this so the operator sets the directory once on the
 * trigger and all steps inherit it automatically.
 */
export const WORKSPACE_DIR_EXPR = "={{ $json.projectDir }}";

const MANUAL_TRIGGER_TYPE = "n8n-nodes-base.manualTrigger";
const NOOP_TYPE = "n8n-nodes-base.noOp";

// ---------------------------------------------------------------------------
// Minimal n8n types (plain JS objects, JSON-serialisable)
// ---------------------------------------------------------------------------

interface N8nConnection {
  node: string;
  type: "main";
  index: 0;
}

interface N8nNode {
  id: string;
  name: string;
  type: string;
  typeVersion: number;
  position: [number, number];
  parameters: Record<string, unknown>;
  notes?: string;
}

export interface N8nWorkflow {
  name: string;
  nodes: N8nNode[];
  connections: Record<string, { main: N8nConnection[][] }>;
  active: boolean;
  settings: Record<string, unknown>;
  id: string;
}

export interface GenerateN8nWorkflowOpts {
  /** Override the workflow name. Defaults to the pipeline id. */
  name?: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function makeNode(
  name: string,
  type: string,
  position: [number, number],
  parameters: Record<string, unknown>,
  notes?: string
): N8nNode {
  const node: N8nNode = { id: randomUUID(), name, type, typeVersion: 1, position, parameters };
  if (notes !== undefined) node.notes = notes;
  return node;
}

function buildStepNode(step: StepDef, position: [number, number], promptText: string): N8nNode {
  if (step.kind === "llm") {
    // TODO(binding-c): interpolate pipeline inputs via n8n expressions
    return makeNode(step.id, YOKE_NODE_TYPE, position, {
      role: step.role ?? "",
      model: step.model ?? "",
      workspace: step.workspace ?? "none",
      workspaceDir: WORKSPACE_DIR_EXPR,
      prompt: promptText,
    });
  }

  if (step.kind === "gate") {
    // TODO(binding-c): map gate to a real HITL/Wait node
    return makeNode(step.id, NOOP_TYPE, position, {}, step.message);
  }

  // assemble-spec | persist-ticket
  // TODO(binding-c): these are yoke-runtime concerns; wire to a yoke node or sub-workflow later
  return makeNode(step.id, NOOP_TYPE, position, {});
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Generate an n8n workflow object from a loaded canon pipeline.
 *
 * The result is a plain JS object that serialises to valid n8n workflow JSON.
 * One n8n node is emitted per canon step plus a Manual Trigger entry node.
 * Connections mirror the canon DAG (dependsOn edges). Layout is deterministic:
 * nodes are placed left-to-right by topological level and top-to-bottom within
 * each level in declaration order.
 */
export function generateN8nWorkflow(
  loaded: LoadedPipeline,
  opts?: GenerateN8nWorkflowOpts
): N8nWorkflow {
  const { def, prompts } = loaded;
  const levels = pipelineLevels(def.steps);

  // ── Assign positions ──────────────────────────────────────────────────────
  // Manual Trigger sits at [100, 300].
  // Steps: x = 250 * (levelIndex + 1), y = 100 + 150 * indexWithinLevel.
  const positionByStepId = new Map<string, [number, number]>();
  for (let li = 0; li < levels.length; li++) {
    const x = 250 * (li + 1);
    for (let ii = 0; ii < levels[li].length; ii++) {
      positionByStepId.set(levels[li][ii], [x, 100 + 150 * ii]);
    }
  }

  // ── Build nodes ───────────────────────────────────────────────────────────
  const triggerNode = makeNode("Manual Trigger", MANUAL_TRIGGER_TYPE, [100, 300], {});
  const stepNodes = def.steps.map((step) =>
    buildStepNode(step, positionByStepId.get(step.id)!, prompts[step.id] ?? "")
  );
  const nodes = [triggerNode, ...stepNodes];

  // ── Build connections ─────────────────────────────────────────────────────
  // n8n connections keyed by source node name: { main: [[{node, type, index}…]] }
  // The outer array is indexed by output port; all targets share port 0.
  const connections: Record<string, { main: N8nConnection[][] }> = {};

  // Manual Trigger → every level-0 step (preserve declaration order).
  const level0Targets: N8nConnection[] = levels[0].map((id) => ({
    node: id,
    type: "main",
    index: 0,
  }));
  connections["Manual Trigger"] = { main: [level0Targets] };

  // Build forward edges: source stepId → dependent stepIds (declaration order).
  const forwardEdges = new Map<string, string[]>();
  for (const step of def.steps) {
    for (const dep of step.dependsOn ?? []) {
      if (!forwardEdges.has(dep)) forwardEdges.set(dep, []);
      forwardEdges.get(dep)!.push(step.id);
    }
  }

  // Emit step connections in declaration order for determinism.
  for (const step of def.steps) {
    const targets = forwardEdges.get(step.id);
    if (targets && targets.length > 0) {
      connections[step.id] = {
        main: [targets.map((tid) => ({ node: tid, type: "main" as const, index: 0 as const }))],
      };
    }
  }

  return {
    name: opts?.name ?? def.id,
    nodes,
    connections,
    active: false,
    settings: {},
    id: randomUUID(),
  };
}
