import { randomUUID } from "node:crypto";
import { pipelineLevels } from "../../canon/graph.js";
import { extractPlaceholders } from "../../canon/render.js";
import type { LoadedPipeline, StepDef, StepKind } from "../../canon/types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** n8n node type for agent-flows LLM steps. Change here when the node package finalises the type string. */
export const AGENT_FLOWS_NODE_TYPE = "n8n-nodes-agent-flows.agentFlowsAgent";

/**
 * Single-source expression for the project directory.
 * Every agent-flows node emits this so the operator sets the directory once in the
 * Inputs node and all steps inherit it automatically.
 */
export const WORKSPACE_DIR_EXPR = "={{ $('Inputs').first().json.projectDir }}";

const MANUAL_TRIGGER_TYPE = "n8n-nodes-base.manualTrigger";
const SET_NODE_TYPE = "n8n-nodes-base.set";
const NOOP_TYPE = "n8n-nodes-base.noOp";

/**
 * The complete set of parameter keys that Binding C emits for llm steps.
 * Must equal the set of parameters the AgentFlowsAgent node reads in its execute method.
 * FR-010: contract test imports this constant to verify symmetry.
 */
export const LLM_STEP_PARAMS = Object.freeze([
  "role",
  "model",
  "workspaceAccess",
  "workspaceDirectory",
  "prompt",
  "timeoutMs",
]);

/** Step kinds that Binding C emits as NoOp nodes and therefore cannot be referenced by llm prompts. */
const NOOP_STEP_KINDS: ReadonlySet<StepKind> = new Set([
  "gate",
  "loop",
  "export-spec",
  "assemble-spec",
  "persist-ticket",
]);

/** Node names reserved by the generated graph structure. Step ids must not collide with these. */
const RESERVED_NODE_NAMES: ReadonlySet<string> = new Set(["Manual Trigger", "Inputs"]);

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
  notes?: string,
  typeVersion = 1
): N8nNode {
  const node: N8nNode = { id: randomUUID(), name, type, typeVersion, position, parameters };
  if (notes !== undefined) node.notes = notes;
  return node;
}

/**
 * Build the Inputs (Set) node.
 * Uses typeVersion 3.4 (Edit Fields / assignments style).
 * Each declared pipeline input plus `projectDir` is emitted as a string field defaulting to "".
 */
function makeInputsNode(inputs: readonly string[], position: [number, number]): N8nNode {
  const allFields = [...inputs, "projectDir"];
  return {
    id: randomUUID(),
    name: "Inputs",
    type: SET_NODE_TYPE,
    typeVersion: 3.4,
    position,
    parameters: {
      mode: "manual",
      assignments: {
        assignments: allFields.map((name) => ({
          name,
          value: "",
          type: "string",
        })),
      },
      includeOthers: false,
    },
  };
}

/**
 * Rewrite canon placeholders in a prompt string to n8n expression form.
 *
 * - Pipeline inputs → `$('Inputs').first().json["key"]`
 * - llm step ancestors → `$("stepId").first().json.output`
 * - check step ancestors → `$("stepId").first().json.stdout`
 * - NoOp step references and `{{models}}` → throw (FR-006)
 *
 * If the prompt contains at least one placeholder, the result starts with `=`
 * and all literal `{` / `}` outside placeholder regions are replaced with
 * `{{ String.fromCharCode(123) }}` / `{{ String.fromCharCode(125) }}`.
 *
 * A placeholder-free prompt is returned as-is, except if it starts with `=`
 * it is wrapped as `={{ JSON.stringify(text) }}` to prevent accidental expression mode.
 */
function rewritePrompt(
  promptText: string,
  referringStepId: string,
  pipelineInputs: ReadonlySet<string>,
  stepKindById: ReadonlyMap<string, StepKind>
): string {
  const placeholders = extractPlaceholders(promptText);

  if (placeholders.length === 0) {
    if (promptText.startsWith("=")) {
      return `={{ ${JSON.stringify(promptText)} }}`;
    }
    return promptText;
  }

  // Validate all placeholders and build n8n expression string.
  const PLACEHOLDER_RE = /\{\{([\w.]+)\}\}/g;
  const parts: string[] = ["="];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = PLACEHOLDER_RE.exec(promptText)) !== null) {
    const [full, key] = match;

    // Escape literal braces in the preceding literal segment.
    const literal = promptText.slice(lastIndex, match.index);
    parts.push(
      literal
        .replace(/{/g, "{{ String.fromCharCode(123) }}")
        .replace(/}/g, "{{ String.fromCharCode(125) }}")
    );

    // Classify the placeholder key.
    if (pipelineInputs.has(key)) {
      parts.push(`{{ $('Inputs').first().json[${JSON.stringify(key)}] }}`);
    } else if (key === "models") {
      throw new Error(
        `Step "${referringStepId}": prompt references {{models}} — ` +
          `the models context key is not supported in Binding C (n8n). ` +
          `This pipeline needs the models key implemented in Binding C first.`
      );
    } else {
      const kind = stepKindById.get(key);
      if (kind === undefined) {
        throw new Error(
          `Step "${referringStepId}": prompt references unknown key "{{${key}}}" — ` +
            `this should have been caught by load.ts placeholder validation`
        );
      }
      if (NOOP_STEP_KINDS.has(kind)) {
        throw new Error(
          `Step "${referringStepId}": prompt references "{{${key}}}" which is a ${kind} step. ` +
            `${kind} steps are emitted as NoOps in Binding C (not yet implemented); ` +
            `a NoOp passes its input through, so this reference would resolve to the wrong upstream data. ` +
            `This pipeline needs ${kind} implemented in Binding C first.`
        );
      }
      if (kind === "llm") {
        parts.push(`{{ $(${JSON.stringify(key)}).first().json.output }}`);
      } else if (kind === "check") {
        parts.push(`{{ $(${JSON.stringify(key)}).first().json.stdout }}`);
      } else {
        throw new Error(
          `Step "${referringStepId}": prompt references "{{${key}}}" which has unsupported kind "${kind}" in Binding C`
        );
      }
    }

    lastIndex = match.index + full.length;
  }

  // Escape trailing literal segment.
  const trailing = promptText.slice(lastIndex);
  parts.push(
    trailing
      .replace(/{/g, "{{ String.fromCharCode(123) }}")
      .replace(/}/g, "{{ String.fromCharCode(125) }}")
  );

  return parts.join("");
}

function buildStepNode(
  step: StepDef,
  position: [number, number],
  promptText: string,
  pipelineInputs: ReadonlySet<string>,
  stepKindById: ReadonlyMap<string, StepKind>
): N8nNode {
  if (step.kind === "llm") {
    const prompt = rewritePrompt(promptText, step.id, pipelineInputs, stepKindById);
    return makeNode(step.id, AGENT_FLOWS_NODE_TYPE, position, {
      role: step.role ?? "",
      model: step.model ?? "",
      workspaceAccess: step.permissions?.contents ?? "none",
      workspaceDirectory: WORKSPACE_DIR_EXPR,
      prompt,
      timeoutMs: step.timeoutMs ?? 0,
    });
  }

  if (step.kind === "check") {
    return makeNode(step.id, "n8n-nodes-base.executeCommand", position, {
      command: step.command ?? "",
    });
  }

  if (step.kind === "gate") {
    // TODO(binding-c): map gate to a real HITL/Wait node
    return makeNode(step.id, NOOP_TYPE, position, {}, step.message);
  }

  if (step.kind === "loop") {
    // TODO(binding-c): loop body is a sub-workflow; Binding C does not execute it yet
    return makeNode(
      step.id,
      NOOP_TYPE,
      position,
      {},
      `loop over ${step.pipeline} (maxIterations: ${step.maxIterations}); Binding C does not execute this yet`
    );
  }

  if (step.kind === "export-spec") {
    // TODO(binding-c): wire to an agent-flows node or file-write sub-workflow later
    return makeNode(
      step.id,
      NOOP_TYPE,
      position,
      {},
      `export-spec: writes spec.md to ${step.path}`
    );
  }

  // assemble-spec | persist-ticket
  // TODO(binding-c): these are agent-flows-runtime concerns; wire to an agent-flows node or sub-workflow later
  return makeNode(step.id, NOOP_TYPE, position, {});
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Generate an n8n workflow object from a loaded canon pipeline.
 *
 * The result is a plain JS object that serialises to valid n8n workflow JSON.
 * One n8n node is emitted per canon step, plus a Manual Trigger entry node and
 * an Inputs (Set) node. Connections mirror the canon DAG (dependsOn edges).
 * Layout is deterministic: nodes are placed left-to-right by topological level
 * and top-to-bottom within each level in declaration order.
 *
 * Throws if:
 * - any step id collides with reserved node names ("Manual Trigger", "Inputs") — FR-007
 * - any llm prompt references a step that Binding C emits as a NoOp — FR-006
 * - any llm prompt references the `{{models}}` context key — FR-006
 */
export function generateN8nWorkflow(
  loaded: LoadedPipeline,
  opts?: GenerateN8nWorkflowOpts
): N8nWorkflow {
  const { def, prompts } = loaded;
  const levels = pipelineLevels(def.steps);

  // ── FR-007: reject step ids that collide with reserved node names ─────────
  for (const step of def.steps) {
    if (RESERVED_NODE_NAMES.has(step.id)) {
      throw new Error(
        `Step id "${step.id}" collides with a reserved n8n node name. ` +
          `Reserved names are: ${[...RESERVED_NODE_NAMES].join(", ")}. ` +
          `Rename the step to avoid a silent reference rewiring.`
      );
    }
  }

  // ── Build lookup maps ─────────────────────────────────────────────────────
  const stepKindById = new Map<string, StepKind>(def.steps.map((s) => [s.id, s.kind]));
  const pipelineInputs = new Set<string>(def.inputs);

  // ── Assign positions ──────────────────────────────────────────────────────
  // Manual Trigger sits at [100, 300].
  // Inputs node sits at [350, 300].
  // Steps: x = 600 + 250 * levelIndex, y = 100 + 150 * indexWithinLevel.
  const positionByStepId = new Map<string, [number, number]>();
  for (let li = 0; li < levels.length; li++) {
    const x = 600 + 250 * li;
    for (let ii = 0; ii < levels[li].length; ii++) {
      positionByStepId.set(levels[li][ii], [x, 100 + 150 * ii]);
    }
  }

  // ── Build nodes ───────────────────────────────────────────────────────────
  const triggerNode = makeNode("Manual Trigger", MANUAL_TRIGGER_TYPE, [100, 300], {});
  const inputsNode = makeInputsNode(def.inputs, [350, 300]);
  const stepNodes = def.steps.map((step) =>
    buildStepNode(
      step,
      positionByStepId.get(step.id)!,
      prompts[step.id] ?? "",
      pipelineInputs,
      stepKindById
    )
  );
  const nodes = [triggerNode, inputsNode, ...stepNodes];

  // ── Build connections ─────────────────────────────────────────────────────
  // n8n connections keyed by source node name: { main: [[{node, type, index}…]] }
  // The outer array is indexed by output port; all targets share port 0.
  const connections: Record<string, { main: N8nConnection[][] }> = {};

  // Manual Trigger → Inputs
  connections["Manual Trigger"] = {
    main: [[{ node: "Inputs", type: "main", index: 0 }]],
  };

  // Inputs → every level-0 step (preserve declaration order).
  const level0Targets: N8nConnection[] = levels[0].map((id) => ({
    node: id,
    type: "main",
    index: 0,
  }));
  connections.Inputs = { main: [level0Targets] };

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
