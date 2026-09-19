// Binding B — MCP stdio server.
// MUST be the very first line: disable Mastra telemetry before any @mastra import.
process.env.MASTRA_TELEMETRY_DISABLED = "1";

import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createTool } from "@mastra/core/tools";
import { MCPServer } from "@mastra/mcp";
import { z } from "zod";
import { resolveLayers } from "../../canon/layers.js";
import { cancelRun, daemonFetch, getRunState, runPipeline, startRun } from "./daemonTools.js";
import { instructionsFor } from "./instructions.js";
import { listPipelinesPayload } from "./listPipelines.js";
import { resolveProjectDir } from "./projectDir.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ── Daemon proxy (FR-005) ─────────────────────────────────────────────────────
// The MCP tools proxy to the HTTP daemon so all three surfaces (MCP stdio, HTTP,
// and the web editor) share the same RunService registry. The proxy bodies live
// in daemonTools.ts: this module calls startStdio() at load, so a test can only
// reach them from there.

// ── Project directory (step execution cwd) ────────────────────────────────────

const projectDir = resolveProjectDir();
// Log to stderr so the MCP stdio channel (stdout) is not polluted.
console.error(`agent-flows MCP server: running steps in ${projectDir}`);

// ── Load pipelines ────────────────────────────────────────────────────────────
// Log the initial resolution for the operator, but resolve per-call inside
// list_pipelines so newly-installed workflows are visible without a restart
// (spec 029 FR-010: resolve per call, the way the daemon now does).

const initialLayers = resolveLayers(projectDir);
console.error(
  `agent-flows MCP server: workflow layers ${initialLayers
    .map((l) => `${l.source} (${l.root})`)
    .join(", ")}`
);

// ── MCP custom tools ──────────────────────────────────────────────────────────

const listPipelinesTool = createTool({
  id: "list_pipelines",
  description: "List all loaded pipelines with their IDs and descriptions.",
  inputSchema: z.object({}),
  execute: async () => {
    // Resolved per call, and filtered by this project's visibility list (spec
    // 038 FR-026) — a hidden workflow is unlisted here and still runs when
    // run_pipeline names it by id.
    return listPipelinesPayload(projectDir);
  },
});

// Both start tools take the same inputs — only what they do after the run is
// started differs — so the schema is declared once.
const startInputSchema = z.object({
  pipeline: z.string().describe("Pipeline id (e.g. 'spec-creation')"),
  inputs: z
    .record(z.string(), z.string())
    .optional()
    .describe("Pipeline input values (optional when artifact_path is provided)"),
  models: z
    .record(z.string(), z.string())
    .optional()
    .describe("Optional per-step model overrides (step id → registry model id)"),
  provider: z
    .string()
    .optional()
    .describe(
      "Optional provider profile id for this run (e.g. 'anthropic', 'openai'). Defaults to the daemon's configured profile."
    ),
  gateMode: z
    .enum(["manual", "auto"])
    .optional()
    .describe(
      'Gate evaluation mode. "manual" (default): gates wait for human approval. "auto": a judge model evaluates each gate; falls back to manual on judge failure.'
    ),
  artifact_path: z
    .string()
    .optional()
    .describe(
      "Optional path to a previous stage's artifact file. When provided, seeds this run's inputs from the artifact (spec 029 FR-010)."
    ),
});

const startRunTool = createTool({
  id: "start_run",
  description:
    "Start a pipeline run and return its runId immediately, without waiting for it to finish. Poll get_run with that runId to show step-by-step progress while the run is in flight. The run keeps going on the daemon whether or not you keep polling; use cancel_run to stop it.",
  inputSchema: startInputSchema,
  execute: (inputData) => startRun(inputData),
});

const runPipelineTool = createTool({
  id: "run_pipeline",
  description:
    "Start a pipeline run and block until it reaches a terminal status, which can take hours. Use start_run plus get_run instead when you want to show progress while the run is in flight. Terminal statuses: 'awaiting_approval' (suspended at a gate, includes spec for review), 'succeeded' (completed successfully), 'rejected' (gate declined by human or judge), 'failed' (unexpected error), 'cancelled' (stopped by an operator via cancel_run).",
  inputSchema: startInputSchema,
  execute: (inputData) => runPipeline(inputData),
});

const approveTool = createTool({
  id: "approve",
  description:
    "Resume a suspended pipeline run with an approval decision. approved=true persists the ticket and continues the run; approved=false terminates it with status='rejected'. An optional free-text reason is stored with the gate decision.",
  inputSchema: z.object({
    runId: z.string().describe("Run ID returned by run_pipeline"),
    approved: z.boolean().describe("true to approve and persist, false to reject and terminate"),
    reason: z
      .string()
      .optional()
      .describe("Optional free-text reason for the decision, stored with the gate decision"),
  }),
  execute: async (inputData) => {
    const { runId, approved, reason } = inputData;
    const res = await daemonFetch(`/api/runs/${encodeURIComponent(runId)}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ approved, ...(reason !== undefined ? { reason } : {}) }),
    });
    const data = (await res.json()) as {
      error?: string;
      status?: string;
      result?: unknown;
    };
    // Only a 4xx/5xx response with no status field is a tool failure.
    // A rejection (status:"rejected") is a normal lifecycle outcome — no error.
    if (!res.ok && data.status === undefined) {
      return { error: data.error ?? `HTTP ${res.status}` };
    }
    if (data.status === "succeeded") {
      return { runId, status: "succeeded", result: data.result };
    }
    if (data.status === "rejected") {
      return { runId, status: "rejected" };
    }
    if (data.status === "awaiting_approval") {
      return { runId, status: "awaiting_approval" };
    }
    return { runId, status: "failed" };
  },
});

const getRunTool = createTool({
  id: "get_run",
  description:
    "Get the current status and result of a pipeline run. This is the progress companion to start_run: poll it while a run is in flight and its `steps` array carries each step's status and output excerpt as they arrive. Includes how it was invoked (pipeline, inputs, models, gate mode) and per-step progress (id, status, startedAt, finishedAt, output excerpt, error, resolved model for llm steps, command for check steps). Rendered prompts are not returned — read them from the run page or artifact. When the run is suspended at an approval gate, also returns the gate message and spec so the caller can review them before approving. When the run was cancelled, returns when it was cancelled and why.",
  inputSchema: z.object({
    runId: z.string().describe("Run ID returned by run_pipeline"),
  }),
  execute: (inputData) => getRunState(inputData.runId),
});

const cancelRunTool = createTool({
  id: "cancel_run",
  description:
    "Cancel an in-flight pipeline run. Aborts the running step — killing any spawned child processes — or, when the run is waiting at an approval gate, unwinds it. Returns status='cancelled'. A run that has already finished cannot be cancelled and the error names its current status.",
  inputSchema: z.object({
    runId: z.string().describe("Run ID returned by run_pipeline"),
    reason: z
      .string()
      .optional()
      .describe("Optional free-text reason, recorded on the run and in its artifact"),
  }),
  execute: (inputData) => cancelRun(inputData.runId, inputData.reason),
});

// ── decide_entry_point tool (spec 029 FR-010) ─────────────────────────────────

const decideEntryPointTool = createTool({
  id: "decide_entry_point",
  description:
    "Decide which pipeline stage to enter based on the input. Returns the recommended pipeline and the reason for the choice, so the operator can correct a wrong inference before starting a billed run.",
  inputSchema: z.object({
    input: z
      .string()
      .describe(
        "Free text (feature request or task description) or an absolute path to an existing artifact file"
      ),
    kind: z
      .enum(["feature-request", "task-description"])
      .optional()
      .describe(
        'Optional explicit kind. "feature-request" routes to formulation (investigate); "task-description" routes to development (develop).'
      ),
  }),
  execute: async (inputData) => {
    const res = await daemonFetch("/api/runs/decide", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(inputData),
    });
    if (!res.ok) {
      const e = (await res.json().catch(() => ({}))) as { error?: string };
      return {
        error: e.error ?? `daemon POST /api/runs/decide returned HTTP ${res.status}`,
      };
    }
    const data = (await res.json()) as { pipeline: string; reason: string };
    return { pipeline: data.pipeline, reason: data.reason };
  },
});

// ── Start MCP server ──────────────────────────────────────────────────────────

const server = new MCPServer({
  id: "agent-flows-mastra",
  name: "Agent Flows Mastra Binding",
  version: "1.0.0",
  // Scoped at startup (spec 038 D7/FR-010): the short pointer for a project
  // that has not customized anything, the full text once it has.
  instructions: instructionsFor(projectDir),
  tools: {
    list_pipelines: listPipelinesTool,
    start_run: startRunTool,
    run_pipeline: runPipelineTool,
    approve: approveTool,
    get_run: getRunTool,
    cancel_run: cancelRunTool,
    decide_entry_point: decideEntryPointTool,
  },
});

await server.startStdio();
