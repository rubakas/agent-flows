// n8n workflow JSON → canon files importer.
//
// Inverse of build.ts: maps supported n8n node types back to canon step kinds.
// FR-007: only agentFlowsAgent, executeCommand, manualTrigger, and the structural
// "Inputs" set node are accepted; any other type or name fails loudly with the
// node name and type so the operator knows exactly which node to fix.
// FR-008: expression inversion is the exact inverse of what build.ts emits
// (reconciled with spec 021 FR-002/FR-003).
// FR-009: llm prompt text is split to prompts/<pipelineId>/<stepId>.md.
// FR-010: validation-first via loadPipeline in a temp dir; nothing is written
// on failure.

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { stringify } from "yaml";

import { loadPipeline } from "../../canon/load.js";
import { AGENT_FLOWS_NODE_TYPE } from "./build.js";
import type { BundleFile } from "../../install/bundle.js";

// ── Constants ────────────────────────────────────────────────────────────────

const MANUAL_TRIGGER_TYPE = "n8n-nodes-base.manualTrigger";
const EXECUTE_COMMAND_TYPE = "n8n-nodes-base.executeCommand";
const SET_NODE_TYPE = "n8n-nodes-base.set";

/** The structural Inputs node name emitted by build.ts — consumed silently. */
const INPUTS_NODE_NAME = "Inputs";

// ── Types ─────────────────────────────────────────────────────────────────────

interface N8nImportConnection {
  node: string;
  type: string;
  index: number;
}

interface N8nImportNode {
  name: string;
  type: string;
  /** y-position used for topo-sort tie-breaking, mirroring build.ts:143-152. */
  position?: [number, number];
  parameters: Record<string, unknown>;
}

export interface N8nImportWorkflow {
  name: string;
  nodes: N8nImportNode[];
  connections: Record<string, { main: N8nImportConnection[][] }>;
  id?: string;
}

export interface ImportResult {
  /** The pipeline id (slugified workflow name). */
  pipelineId: string;
  /** Files to write: pipeline YAML + prompt .md files (BundleFile-compatible paths). */
  files: BundleFile[];
}

// ── Slug helper ──────────────────────────────────────────────────────────────

/**
 * Slugify a workflow name to a valid pipeline id:
 * lowercase; runs of characters outside [a-z0-9-] replaced with a single hyphen;
 * leading/trailing hyphens trimmed.
 */
export function slugifyWorkflowName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-") // collapse consecutive hyphens (from adjacent special chars)
    .replace(/^-+|-+$/g, ""); // trim leading/trailing hyphens
  return slug || "pipeline";
}

// ── Expression inversion (FR-008) ────────────────────────────────────────────

/**
 * Invert a single expression region (the content inside `{{ ... }}`).
 *
 * Supported forms (exact inverses of what build.ts emits per spec 021):
 *   $('Inputs').first().json["key"]   → placeholder {{key}}
 *   $('Inputs').first().json['key']   → placeholder {{key}}
 *   $("stepId").first().json.output   → placeholder {{stepId}}  (llm step ref)
 *   $('stepId').first().json.output   → placeholder {{stepId}}  (llm step ref)
 *   $("stepId").first().json.stdout   → placeholder {{stepId}}  (check step ref)
 *   $('stepId').first().json.stdout   → placeholder {{stepId}}  (check step ref)
 *   $json.name                        → placeholder {{name}} (step ref if node name, else input)
 *   String.fromCharCode(123)          → literal {
 *   String.fromCharCode(125)          → literal }
 *
 * Any other expression syntax → throws loudly naming the node and parameter.
 */
function invertExpressionRegion(
  expr: string,
  nodeName: string,
  paramName: string
): { kind: "literal"; char: string } | { kind: "placeholder"; name: string } {
  const e = expr.trim();

  if (e === "String.fromCharCode(123)") return { kind: "literal", char: "{" };
  if (e === "String.fromCharCode(125)") return { kind: "literal", char: "}" };

  // $('Inputs').first().json["key"] or $('Inputs').first().json['key']
  const inputsBracketMatch = /^\$\(['"]Inputs['"]\)\.first\(\)\.json\[(['"])([^\]]+)\1\]$/.exec(e);
  if (inputsBracketMatch) {
    return { kind: "placeholder", name: inputsBracketMatch[2] };
  }

  // $(stepId).first().json.output  (llm step)
  const stepOutputMatch = /^\$\((['"])([^'"]+)\1\)\.first\(\)\.json\.output$/.exec(e);
  if (stepOutputMatch) {
    return { kind: "placeholder", name: stepOutputMatch[2] };
  }

  // $(stepId).first().json.stdout  (check step)
  const stepStdoutMatch = /^\$\((['"])([^'"]+)\1\)\.first\(\)\.json\.stdout$/.exec(e);
  if (stepStdoutMatch) {
    return { kind: "placeholder", name: stepStdoutMatch[2] };
  }

  // $json.name  (simple form; step ref or input determined by caller)
  const jsonDotMatch = /^\$json\.([a-zA-Z_]\w*)$/.exec(e);
  if (jsonDotMatch) {
    return { kind: "placeholder", name: jsonDotMatch[1] };
  }

  throw new Error(
    `Node "${nodeName}" parameter "${paramName}": unsupported n8n expression syntax ` +
      `"{{ ${e} }}" — ` +
      `only $('Inputs').first().json[...], $("step").first().json.output/stdout, ` +
      `$json.<name>, and String.fromCharCode(123/125) are supported`
  );
}

/**
 * Invert an n8n expression string back to a canon prompt string.
 *
 * If `raw` does not start with "=" it is returned as-is (plain string, no placeholders).
 * If `raw` is `={{ JSON.stringify(text) }}` (the wrapping for prompts that start with "="),
 * the JSON-decoded text is returned.
 * Otherwise the mixed template is parsed: text outside {{ }} is literal,
 * text inside {{ }} is an expression that is inverted per `invertExpressionRegion`.
 *
 * @throws if any expression region cannot be inverted.
 */
export function invertPromptExpression(raw: string, nodeName: string, paramName: string): string {
  if (!raw.startsWith("=")) return raw;

  // ={{ JSON.stringify("...") }} — wrapping for a prompt that starts with "="
  const jsonStringifyMatch = /^=\{\{\s*JSON\.stringify\(("(?:[^"\\]|\\.)*")\)\s*\}\}$/.exec(raw);
  if (jsonStringifyMatch) {
    try {
      return JSON.parse(jsonStringifyMatch[1]) as string;
    } catch {
      // Not valid JSON stringify form — fall through to general parsing
    }
  }

  // Parse the mixed expression body (everything after the leading "=")
  const body = raw.slice(1);
  const EXPR_RE = /\{\{([\s\S]*?)\}\}/g;
  const parts: string[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = EXPR_RE.exec(body)) !== null) {
    // Append the literal text segment before this expression
    parts.push(body.slice(lastIndex, match.index));

    const result = invertExpressionRegion(match[1], nodeName, paramName);
    if (result.kind === "literal") {
      parts.push(result.char);
    } else {
      parts.push(`{{${result.name}}}`);
    }

    lastIndex = match.index + match[0].length;
  }

  // Trailing literal segment
  parts.push(body.slice(lastIndex));
  return parts.join("");
}

// ── Placeholder collection ────────────────────────────────────────────────────

/**
 * Collect all unique placeholder names from a canon prompt string.
 * Uses the same `[\w.]+` regex as extractPlaceholders (render.ts:8).
 */
function collectPlaceholders(promptText: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  const re = /\{\{([\w.]+)\}\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(promptText)) !== null) {
    if (!seen.has(m[1])) {
      seen.add(m[1]);
      result.push(m[1]);
    }
  }
  return result;
}

// ── Topological sort ─────────────────────────────────────────────────────────

/**
 * Build a reverse-edge map: targetNodeName → [sourceNodeNames].
 * Only considers nodes in `knownNodes`.
 */
function buildReverseEdges(
  connections: N8nImportWorkflow["connections"],
  knownNodes: Set<string>
): Map<string, string[]> {
  const reverse = new Map<string, string[]>();
  for (const [sourceName, { main }] of Object.entries(connections)) {
    if (!main) continue;
    for (const port of main) {
      if (!port) continue;
      for (const conn of port) {
        if (!knownNodes.has(conn.node)) continue;
        if (!reverse.has(conn.node)) reverse.set(conn.node, []);
        reverse.get(conn.node)!.push(sourceName);
      }
    }
  }
  return reverse;
}

/**
 * Topological sort of step nodes by connection order.
 * Ties broken by y-position then name (mirrors pipelineLevels, build.ts:143-152).
 */
function topoSortStepNodes(
  stepNodes: N8nImportNode[],
  reverseEdges: Map<string, string[]>,
  stepNameSet: Set<string>
): N8nImportNode[] {
  const nodeByName = new Map(stepNodes.map((n) => [n.name, n]));

  // Compute in-degree (only counting edges from other step nodes)
  const inDegree = new Map<string, number>();
  const forwardEdges = new Map<string, string[]>();
  for (const n of stepNodes) {
    inDegree.set(n.name, 0);
    forwardEdges.set(n.name, []);
  }
  for (const n of stepNodes) {
    const stepPreds = (reverseEdges.get(n.name) ?? []).filter((s) => stepNameSet.has(s));
    inDegree.set(n.name, stepPreds.length);
    for (const pred of stepPreds) {
      forwardEdges.get(pred)!.push(n.name);
    }
  }

  // Kahn's algorithm; ties broken by y-position (ascending) then name (alphabetical)
  const tiebreak = (a: N8nImportNode, b: N8nImportNode): number => {
    const ay = a.position?.[1] ?? 0;
    const by = b.position?.[1] ?? 0;
    return ay !== by ? ay - by : a.name.localeCompare(b.name);
  };

  const ready: N8nImportNode[] = stepNodes.filter((n) => inDegree.get(n.name) === 0).sort(tiebreak);

  const result: N8nImportNode[] = [];
  while (ready.length > 0) {
    const node = ready.shift()!;
    result.push(node);
    const readySuccs: N8nImportNode[] = [];
    for (const succName of forwardEdges.get(node.name) ?? []) {
      const newDeg = inDegree.get(succName)! - 1;
      inDegree.set(succName, newDeg);
      if (newDeg === 0) readySuccs.push(nodeByName.get(succName)!);
    }
    ready.push(...readySuccs.sort(tiebreak));
  }

  return result;
}

// ── Main importer ─────────────────────────────────────────────────────────────

/**
 * Import an n8n workflow JSON object into canon files.
 *
 * Throws loudly (FR-007) if:
 * - Any node type other than agentFlowsAgent, executeCommand, manualTrigger,
 *   or the structural Inputs (set) node is present — naming node name and type.
 * - Any prompt expression cannot be inverted — naming node and parameter.
 * - loadPipeline rejects the assembled canon — naming the validation error.
 *
 * Returns the pipelineId and BundleFile entries for the pipeline YAML and
 * all prompt files. No filesystem writes happen inside this function;
 * the caller writes files (or delegates to importBundle/exportBundle).
 *
 * Validation-first (FR-010): all canon files are written to a temp directory
 * and loadPipeline is called before this function returns. The temp directory
 * is always deleted whether or not validation passes.
 */
export function importN8nWorkflow(workflow: N8nImportWorkflow): ImportResult {
  const { name: workflowName, nodes, connections } = workflow;

  // ── Classify nodes ──────────────────────────────────────────────────────────
  let triggerNode: N8nImportNode | undefined;
  const stepNodes: N8nImportNode[] = [];

  for (const node of nodes) {
    if (node.type === MANUAL_TRIGGER_TYPE) {
      if (triggerNode !== undefined) {
        throw new Error(
          `Workflow "${workflowName}": multiple manualTrigger nodes found — only one is allowed`
        );
      }
      triggerNode = node;
    } else if (node.type === SET_NODE_TYPE && node.name === INPUTS_NODE_NAME) {
      // Structural Inputs node emitted by build.ts — consumed silently.
      // It carries input field definitions that we recover from expression inversion.
    } else if (node.type === AGENT_FLOWS_NODE_TYPE || node.type === EXECUTE_COMMAND_TYPE) {
      stepNodes.push(node);
    } else {
      throw new Error(
        `Node "${node.name}" (type: "${node.type}") cannot be imported — ` +
          `only agentFlowsAgent and executeCommand nodes are supported; ` +
          `this node type cannot yet be re-imported`
      );
    }
  }

  if (triggerNode === undefined) {
    throw new Error(
      `Workflow "${workflowName}": no manualTrigger node found — ` +
        `a single manualTrigger is required as the entry node`
    );
  }

  // ── Build name sets and dependency graph ────────────────────────────────────
  const allNodeNames = new Set(nodes.map((n) => n.name));
  const stepNameSet = new Set(stepNodes.map((n) => n.name));
  const reverseEdges = buildReverseEdges(connections, allNodeNames);

  // dependsOn for each step = step predecessors in the connection graph
  const dependsOnByName = new Map<string, string[]>();
  for (const node of stepNodes) {
    const preds = (reverseEdges.get(node.name) ?? []).filter((s) => stepNameSet.has(s));
    dependsOnByName.set(node.name, preds);
  }

  // ── Topological sort (FR-010) ────────────────────────────────────────────────
  const sortedStepNodes = topoSortStepNodes(stepNodes, reverseEdges, stepNameSet);

  // ── Compute pipeline id (FR-009) ────────────────────────────────────────────
  const pipelineId = slugifyWorkflowName(workflowName);

  // ── Convert each step node to a canon step + prompt file ────────────────────
  const collectedInputs = new Set<string>();
  const promptFiles: BundleFile[] = [];
  const steps: Record<string, unknown>[] = [];

  for (const node of sortedStepNodes) {
    const stepId = node.name;
    const deps = dependsOnByName.get(stepId) ?? [];

    if (node.type === EXECUTE_COMMAND_TYPE) {
      // check step (FR-007: inverse of build.ts:286-289)
      const command = node.parameters.command;
      if (typeof command !== "string" || command.trim() === "") {
        throw new Error(`Node "${node.name}": check step requires a non-empty "command" parameter`);
      }
      const step: Record<string, unknown> = { id: stepId, kind: "check", command };
      if (deps.length > 0) step.dependsOn = deps;
      steps.push(step);
      continue;
    }

    // llm step (agentFlowsAgent — FR-007: inverse of build.ts:274-283)
    const params = node.parameters as {
      role?: unknown;
      model?: unknown;
      workspaceAccess?: unknown;
      workspaceDirectory?: unknown;
      prompt?: unknown;
      timeoutMs?: unknown;
    };

    // Invert prompt expression (FR-008)
    const promptRaw = typeof params.prompt === "string" ? params.prompt : "";
    const promptText = invertPromptExpression(promptRaw, stepId, "prompt");

    // Classify placeholders: step refs vs pipeline inputs (FR-008)
    for (const ph of collectPlaceholders(promptText)) {
      if (!stepNameSet.has(ph)) {
        collectedInputs.add(ph);
      }
    }

    // Write prompt file (FR-009): prompts/<pipelineId>/<stepId>.md
    const promptPath = `prompts/${pipelineId}/${stepId}.md`;
    promptFiles.push({ path: promptPath, content: promptText });

    // Build canon step definition
    const step: Record<string, unknown> = { id: stepId, kind: "llm" };
    if (typeof params.role === "string" && params.role !== "") step.role = params.role;
    if (typeof params.model === "string" && params.model !== "") step.model = params.model;

    // workspaceAccess → permissions.contents (inverse of build.ts:279)
    const access = typeof params.workspaceAccess === "string" ? params.workspaceAccess : "none";
    if (access !== "none" && access !== "") {
      step.permissions = { contents: access };
    }

    step.prompt = promptPath;
    if (deps.length > 0) step.dependsOn = deps;
    steps.push(step);
  }

  // ── Assemble pipeline YAML ──────────────────────────────────────────────────
  const inputs = [...collectedInputs].sort();
  const pipelineDef: Record<string, unknown> = {
    id: pipelineId,
    version: 1,
    description: workflowName,
    inputs,
    steps,
  };
  const pipelineYaml = stringify(pipelineDef);

  // ── Validation-first: write to temp dir and call loadPipeline (FR-010) ──────
  // realpathSync resolves macOS /tmp → /private/tmp symlink so loadPipeline's
  // containment check (which also uses realpathSync) does not reject the path.
  const tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), "agent-flows-n8n-import-")));
  try {
    const pipelinePath = join(tmpRoot, "pipelines", `${pipelineId}.yaml`);
    mkdirSync(dirname(pipelinePath), { recursive: true });
    writeFileSync(pipelinePath, pipelineYaml, "utf8");

    for (const pf of promptFiles) {
      const pfPath = join(tmpRoot, pf.path);
      mkdirSync(dirname(pfPath), { recursive: true });
      writeFileSync(pfPath, pf.content, "utf8");
    }

    try {
      loadPipeline(pipelinePath);
    } catch (err) {
      throw new Error(
        `Imported workflow "${workflowName}" failed canon validation: ` +
          `${(err as Error).message}`,
        { cause: err }
      );
    }
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }

  // ── Return result (no filesystem writes here) ────────────────────────────────
  const files: BundleFile[] = [
    { path: `pipelines/${pipelineId}.yaml`, content: pipelineYaml },
    ...promptFiles,
  ];

  return { pipelineId, files };
}
