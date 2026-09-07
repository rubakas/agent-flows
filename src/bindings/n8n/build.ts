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
const IF_NODE_TYPE = "n8n-nodes-base.if";
const WAIT_NODE_TYPE = "n8n-nodes-base.wait";
const HTTP_REQUEST_NODE_TYPE = "n8n-nodes-base.httpRequest";

// typeVersions verified from installed n8n-nodes-base 2.22.6:
//   IF defaultVersion: 2.3 (uses IfV2)
//   Wait version: [1, 1.1] → 1.1
//   HTTP Request defaultVersion: 4.4 (uses HttpRequestV3 internally)
const IF_TYPE_VERSION = 2.3;
const WAIT_TYPE_VERSION = 1.1;
const HTTP_REQUEST_TYPE_VERSION = 4.4;

/**
 * Default daemon base URL. n8n's HTTP Request node will POST to this URL + /api/gate-judge.
 * The operator can override it in the generated workflow's Inputs node (agentFlowsDaemonUrl).
 * 7411 is the daemon's default port (server.ts ServeOptions.port default).
 */
export const DEFAULT_DAEMON_URL = "http://127.0.0.1:7411";

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

/**
 * Step kinds whose output cannot be referenced by llm prompts in Binding C.
 * Gate steps are real HITL/branch subgraphs (FR-011) and not NoOps, but their
 * output is still not a usable text value for downstream prompts — the
 * restriction therefore stays (spec FR-011: "the prompt-reference restriction
 * for gate outputs stays").
 */
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
 * When `hasGates` is true, `gateMode` (default: "manual") and `agentFlowsDaemonUrl`
 * (default: DEFAULT_DAEMON_URL) are added so gate subgraph nodes can reference them.
 */
function makeInputsNode(
  inputs: readonly string[],
  position: [number, number],
  hasGates = false
): N8nNode {
  const allFields = [...inputs, "projectDir"];
  const extraAssignments: { name: string; value: string; type: string }[] = [];
  if (hasGates) {
    extraAssignments.push({ name: "gateMode", value: "manual", type: "string" });
    extraAssignments.push({
      name: "agentFlowsDaemonUrl",
      value: DEFAULT_DAEMON_URL,
      type: "string",
    });
  }
  return {
    id: randomUUID(),
    name: "Inputs",
    type: SET_NODE_TYPE,
    typeVersion: 3.4,
    position,
    parameters: {
      mode: "manual",
      assignments: {
        assignments: [
          ...allFields.map((name) => ({ name, value: "", type: "string" })),
          ...extraAssignments,
        ],
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
        const detail =
          kind === "gate"
            ? `gate steps emit a HITL branch subgraph; their output is not a text value`
            : `${kind} steps are emitted as NoOps in Binding C (not yet implemented); ` +
              `a NoOp passes its input through, so this reference would resolve to the wrong upstream data. ` +
              `This pipeline needs ${kind} implemented in Binding C first`;
        throw new Error(
          `Step "${referringStepId}": prompt references "{{${key}}}" which is a ${kind} step. ` +
            `${detail}.`
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
// Gate subgraph builder (FR-011)
// ---------------------------------------------------------------------------

/**
 * Describes the multi-node subgraph emitted for a gate step.
 *
 * Predecessors connect to `entryName`. Successors receive connections from
 * the true (port 0) branches of every node listed in `exitNames`. The false
 * (port 1) branches of exit nodes are intentionally left unconnected so that
 * a rejection makes all downstream nodes unreachable by construction.
 */
interface GateSubgraph {
  /** First node name — predecessors and Inputs connect here. */
  entryName: string;
  /** Node names whose port 0 (true/approved) connects to successors. */
  exitNames: string[];
  /** All nodes in the subgraph. */
  nodes: N8nNode[];
  /** Internal connections within the subgraph (not including → successors). */
  connections: Record<string, { main: N8nConnection[][] }>;
}

/**
 * Build an IF-node condition parameters block (n8n-nodes-base.if typeVersion 2.3).
 * Verified against n8n-nodes-base 2.22.6 / IfV2 source (defaultVersion 2.3).
 */
function makeIfConditions(
  conditions: {
    leftValue: string;
    rightValue?: unknown;
    operator: { type: string; operation: string };
  }[]
): Record<string, unknown> {
  return {
    conditions: {
      combinator: "and" as const,
      conditions,
      options: {
        caseSensitive: true,
        leftValue: "",
        typeValidation: "strict",
        version: 2,
      },
    },
    options: {},
  };
}

/**
 * Build the multi-node subgraph for a single gate step (FR-011).
 *
 * Non-manualOnly gate emits:
 *   modeIf → (true/manual) wait → approvedIf
 *         → (false/auto)  http → verdictIf
 *
 * manualOnly gate emits (FR-013: no auto branch, no HTTP Request node):
 *   wait → approvedIf
 *
 * The reject/false branch of every IF exit node has no outgoing connection,
 * making downstream nodes unreachable on rejection by construction.
 *
 * Schema notes (verified from installed n8n-nodes-base 2.22.6):
 *   - IF typeVersion 2.3: conditions use filter schema with combinator/conditions/options
 *   - Wait typeVersion 1.1: resume: "webhook" puts the POST body at $json.body in the next node
 *     (inherits Webhook.node.js output: { headers, params, query, body })
 *     ASSUMPTION: $json.body.approved is where the resume caller's "approved" field lands.
 *     This assumption could not be verified without a live n8n runtime; flagged in spec Design G.
 *   - HTTP Request typeVersion 4.4: sendBody+contentType+specifyBody+jsonBody for POST JSON
 *     Response body for application/json is placed directly in $json of the next node.
 */
function buildGateSubgraph(
  step: StepDef,
  position: [number, number],
  pipelineId: string
): GateSubgraph {
  const id = step.id;
  const [x, y] = position;
  const manualOnly = step.manualOnly === true;

  const gateMessage = step.message ?? "Approve this gate?";

  if (manualOnly) {
    // ── manualOnly: only the manual branch ──────────────────────────────────
    const waitName = `${id} wait`;
    const approvedIfName = `${id} approved-if`;

    const waitNode = makeNode(
      waitName,
      WAIT_NODE_TYPE,
      [x, y],
      { resume: "webhook", options: {} },
      undefined,
      WAIT_TYPE_VERSION
    );

    const approvedIfNode = makeNode(
      approvedIfName,
      IF_NODE_TYPE,
      [x + 200, y],
      // ASSUMPTION: resume webhook POST body fields are at $json.body.*
      makeIfConditions([
        {
          leftValue: "={{ $json.body.approved }}",
          operator: { type: "boolean", operation: "true" },
        },
      ]),
      undefined,
      IF_TYPE_VERSION
    );

    return {
      entryName: waitName,
      exitNames: [approvedIfName],
      nodes: [waitNode, approvedIfNode],
      connections: {
        [waitName]: { main: [[{ node: approvedIfName, type: "main", index: 0 }]] },
        // approvedIf → successors is wired by generateN8nWorkflow (port 0 only)
      },
    };
  }

  // ── Full (non-manualOnly) gate: mode-IF → wait branch + HTTP branch ────────
  const modeIfName = `${id} mode-if`;
  const waitName = `${id} wait`;
  const approvedIfName = `${id} approved-if`;
  const httpName = `${id} http`;
  const verdictIfName = `${id} verdict-if`;

  const modeIfNode = makeNode(
    modeIfName,
    IF_NODE_TYPE,
    [x, y],
    makeIfConditions([
      {
        leftValue: "={{ $('Inputs').first().json.gateMode }}",
        rightValue: "manual",
        operator: { type: "string", operation: "equals" },
      },
    ]),
    undefined,
    IF_TYPE_VERSION
  );

  // Manual branch nodes
  const waitNode = makeNode(
    waitName,
    WAIT_NODE_TYPE,
    [x + 200, y - 100],
    { resume: "webhook", options: {} },
    undefined,
    WAIT_TYPE_VERSION
  );

  const approvedIfNode = makeNode(
    approvedIfName,
    IF_NODE_TYPE,
    [x + 400, y - 100],
    makeIfConditions([
      {
        leftValue: "={{ $json.body.approved }}",
        operator: { type: "boolean", operation: "true" },
      },
    ]),
    undefined,
    IF_TYPE_VERSION
  );

  // Auto branch nodes
  const daemonUrlExpr = `={{ $('Inputs').first().json.agentFlowsDaemonUrl }}/api/gate-judge`;
  const judgeBody = JSON.stringify({ gateMessage, pipelineId });
  const httpNode = makeNode(
    httpName,
    HTTP_REQUEST_NODE_TYPE,
    [x + 200, y + 100],
    {
      method: "POST",
      url: daemonUrlExpr,
      sendBody: true,
      contentType: "json",
      specifyBody: "json",
      jsonBody: judgeBody,
    },
    undefined,
    HTTP_REQUEST_TYPE_VERSION
  );

  const verdictIfNode = makeNode(
    verdictIfName,
    IF_NODE_TYPE,
    [x + 400, y + 100],
    makeIfConditions([
      {
        leftValue: "={{ $json.verdict }}",
        rightValue: "approve",
        operator: { type: "string", operation: "equals" },
      },
    ]),
    undefined,
    IF_TYPE_VERSION
  );

  return {
    entryName: modeIfName,
    exitNames: [approvedIfName, verdictIfName],
    nodes: [modeIfNode, waitNode, approvedIfNode, httpNode, verdictIfNode],
    connections: {
      // mode-IF: port 0 (true/manual) → wait; port 1 (false/auto) → http
      [modeIfName]: {
        main: [
          [{ node: waitName, type: "main", index: 0 }],
          [{ node: httpName, type: "main", index: 0 }],
        ],
      },
      [waitName]: { main: [[{ node: approvedIfName, type: "main", index: 0 }]] },
      [httpName]: { main: [[{ node: verdictIfName, type: "main", index: 0 }]] },
      // approvedIf and verdictIf → successors wired by generateN8nWorkflow (port 0 only)
    },
  };
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Generate an n8n workflow object from a loaded canon pipeline.
 *
 * The result is a plain JS object that serialises to valid n8n workflow JSON.
 * One n8n node is emitted per non-gate step, plus a Manual Trigger entry node and
 * an Inputs (Set) node. Gate steps emit multi-node HITL branch subgraphs (FR-011).
 * Connections mirror the canon DAG (dependsOn edges); gate subgraph reject branches
 * are unconnected so downstream nodes are unreachable on rejection by construction.
 *
 * Throws if:
 * - any step id collides with reserved node names ("Manual Trigger", "Inputs") — FR-007
 * - any llm prompt references a step that Binding C cannot produce output for — FR-006
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
  const hasGates = def.steps.some((s) => s.kind === "gate");

  // ── Assign positions ──────────────────────────────────────────────────────
  // Manual Trigger sits at [100, 300].
  // Inputs node sits at [350, 300].
  // Steps: x = 600 + 250 * levelIndex, y = 100 + 150 * indexWithinLevel.
  // Gate subgraph nodes are placed relative to the gate step's anchor position.
  const positionByStepId = new Map<string, [number, number]>();
  for (let li = 0; li < levels.length; li++) {
    const x = 600 + 250 * li;
    for (let ii = 0; ii < levels[li].length; ii++) {
      positionByStepId.set(levels[li][ii], [x, 100 + 150 * ii]);
    }
  }

  // ── Build gate subgraphs (FR-011) ─────────────────────────────────────────
  const gateSubgraphs = new Map<string, GateSubgraph>();
  for (const step of def.steps) {
    if (step.kind === "gate") {
      gateSubgraphs.set(step.id, buildGateSubgraph(step, positionByStepId.get(step.id)!, def.id));
    }
  }

  // ── stepEntryName: the node name that predecessors connect to for a step ──
  // For regular steps it equals the step id; for gate steps it is the subgraph entry.
  function stepEntryName(stepId: string): string {
    return gateSubgraphs.get(stepId)?.entryName ?? stepId;
  }

  // ── Build nodes ───────────────────────────────────────────────────────────
  const triggerNode = makeNode("Manual Trigger", MANUAL_TRIGGER_TYPE, [100, 300], {});
  const inputsNode = makeInputsNode(def.inputs, [350, 300], hasGates);

  const regularNodes: N8nNode[] = [];
  const subgraphNodes: N8nNode[] = [];
  for (const step of def.steps) {
    if (step.kind === "gate") {
      subgraphNodes.push(...gateSubgraphs.get(step.id)!.nodes);
    } else {
      regularNodes.push(
        buildStepNode(
          step,
          positionByStepId.get(step.id)!,
          prompts[step.id] ?? "",
          pipelineInputs,
          stepKindById
        )
      );
    }
  }
  const nodes = [triggerNode, inputsNode, ...regularNodes, ...subgraphNodes];

  // ── Build connections ─────────────────────────────────────────────────────
  // n8n connections keyed by source node name: { main: [[{node, type, index}…]] }
  // The outer array is indexed by output port; IF nodes use port 0 (true) and port 1 (false).
  const connections: Record<string, { main: N8nConnection[][] }> = {};

  // Manual Trigger → Inputs
  connections["Manual Trigger"] = {
    main: [[{ node: "Inputs", type: "main", index: 0 }]],
  };

  // Inputs → every level-0 step entry (preserve declaration order).
  // Gate steps redirect to their subgraph entry node.
  const level0Targets: N8nConnection[] = levels[0].map((id) => ({
    node: stepEntryName(id),
    type: "main",
    index: 0,
  }));
  connections.Inputs = { main: [level0Targets] };

  // Build forward edges: source stepId → [entry node names of successor steps].
  // Using entry names ensures predecessors wire to the gate subgraph's first node.
  const forwardEdges = new Map<string, string[]>();
  for (const step of def.steps) {
    for (const dep of step.dependsOn ?? []) {
      if (!forwardEdges.has(dep)) forwardEdges.set(dep, []);
      forwardEdges.get(dep)!.push(stepEntryName(step.id));
    }
  }

  // Emit connections in declaration order for determinism.
  for (const step of def.steps) {
    if (step.kind === "gate") {
      const subgraph = gateSubgraphs.get(step.id)!;
      // Add internal subgraph connections.
      Object.assign(connections, subgraph.connections);

      // Connect each exit node's port 0 (true/approved) to successor steps.
      // Port 1 (false/rejected) is intentionally left unconnected —
      // downstream nodes are unreachable on rejection by construction (FR-011).
      const successorTargets = forwardEdges.get(step.id);
      if (successorTargets && successorTargets.length > 0) {
        const targetConns: N8nConnection[] = successorTargets.map((t) => ({
          node: t,
          type: "main" as const,
          index: 0 as const,
        }));
        for (const exitName of subgraph.exitNames) {
          // port 0 (approved/true) → successors; port 1 (rejected/false) → intentionally empty
          connections[exitName] = { main: [targetConns, []] };
        }
      }
    } else {
      const targets = forwardEdges.get(step.id);
      if (targets && targets.length > 0) {
        connections[step.id] = {
          main: [targets.map((tid) => ({ node: tid, type: "main" as const, index: 0 as const }))],
        };
      }
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
