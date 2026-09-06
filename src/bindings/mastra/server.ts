// Binding B — MCP stdio server.
// MUST be the very first line: disable Mastra telemetry before any @mastra import.
process.env.MASTRA_TELEMETRY_DISABLED = "1";

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Mastra } from "@mastra/core/mastra";
import { createTool } from "@mastra/core/tools";
import { LibSQLStore } from "@mastra/libsql";
import { MCPServer } from "@mastra/mcp";
import { z } from "zod";
import { defaultRegistry } from "../../canon/registry.js";
import { makeDb } from "../../db/index.js";
import { RunService } from "../../runtime/runService.js";
import { DrizzleTicketStore } from "../../store/sqlite.js";
import { buildPipelineWorkflow, validateModelOverrides } from "./build.js";
import { mastraDbPath } from "./paths.js";
import { loadCatalog } from "./pipelineLoader.js";
import { resolveProjectDir } from "./projectDir.js";
import type { PipelineCatalog } from "./pipelineLoader.js";
import type { MastraLike } from "../../runtime/runService.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = join(__dirname, "..", "..", "..");

// ── Parse --db flag ──────────────────────────────────────────────────────────

const dbFlagIdx = process.argv.indexOf("--db");
const ticketDbPath =
  dbFlagIdx !== -1 && process.argv[dbFlagIdx + 1]
    ? process.argv[dbFlagIdx + 1]
    : join(repoRoot, "agent-flows.sqlite");

const mastraDb = mastraDbPath(ticketDbPath);

// ── Storage ──────────────────────────────────────────────────────────────────

const mastraStorage = new LibSQLStore({
  id: "agent-flows-mastra",
  url: `file:${mastraDb}`,
});

const db = makeDb(ticketDbPath);
const store = new DrizzleTicketStore(db);
const registry = defaultRegistry();

// ── Project directory (step execution cwd) ────────────────────────────────────

const projectDir = resolveProjectDir();
// Log to stderr so the MCP stdio channel (stdout) is not polluted.
console.error(`agent-flows MCP server: running steps in ${projectDir}`);

// ── Load pipelines ────────────────────────────────────────────────────────────

const pipelinesDir = join(repoRoot, "pipelines");

function buildFreshMastra(catalog: PipelineCatalog): Mastra {
  const workflows: Record<string, unknown> = {};
  for (const loaded of catalog.loaded) {
    workflows[loaded.def.id] = buildPipelineWorkflow(loaded, { registry, store, cwd: projectDir });
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new Mastra({ storage: mastraStorage, workflows: workflows as Record<string, any> });
}

// Mutable reference to the current Mastra instance; rebuilt on each tool call
// so newly added or edited pipelines are visible without restarting the server.
let activeMastra = buildFreshMastra(loadCatalog(pipelinesDir));

// Proxy so RunService always delegates to the latest activeMastra.
// Suspended runs keep their original run objects tied to the Mastra that
// created them; only new starts use the refreshed instance.
const mastraProxy = {
  getWorkflow: (id: string) => activeMastra.getWorkflow(id),
} as unknown as MastraLike;

// ── Run ownership ──────────────────────────────────────────────────────────────
// RunService owns run state so that MCP, HTTP and the web editor all share
// the same runs. The public run id is Mastra's own run id (FR-011).

const runService = new RunService(mastraProxy);

// ── MCP custom tools ──────────────────────────────────────────────────────────

const listPipelinesTool = createTool({
  id: "list_pipelines",
  description: "List all loaded pipelines with their IDs and descriptions.",
  inputSchema: z.object({}),
  execute: async () => {
    const catalog = loadCatalog(pipelinesDir);
    activeMastra = buildFreshMastra(catalog);
    return {
      pipelines: catalog.loaded.map((p) => ({
        id: p.def.id,
        description: p.def.description,
        inputs: p.def.inputs,
      })),
      errors: catalog.errors.map((e) => ({ file: e.file, error: e.error })),
    };
  },
});

const runPipelineTool = createTool({
  id: "run_pipeline",
  description:
    "Start a pipeline run. Returns immediately. If the pipeline suspends at a gate, returns status='awaiting_approval' with the spec for review. If it completes, returns the final result.",
  inputSchema: z.object({
    pipeline: z.string().describe("Pipeline id (e.g. 'spec-creation')"),
    inputs: z.record(z.string(), z.string()).describe("Pipeline input values"),
    models: z
      .record(z.string(), z.string())
      .optional()
      .describe("Optional per-step model overrides (step id → registry model id)"),
  }),
  execute: async (inputData) => {
    // Reload pipelines from disk before starting the run so newly added
    // or edited pipelines are visible without restarting the server.
    activeMastra = buildFreshMastra(loadCatalog(pipelinesDir));

    const { pipeline, inputs, models } = inputData;
    if (models) {
      const err = validateModelOverrides(models, registry);
      if (err) return { error: err };
    }
    const wfInput = { ...inputs, ...(models ? { models } : {}) };
    // start() is non-blocking — fires the run in the background and returns a runId.
    // waitForSettled() blocks here so the MCP tool remains blocking from the chat
    // client's perspective, preserving the existing contract.
    const { runId } = await runService.start(pipeline, wfInput);
    const settled = await runService.waitForSettled(runId);
    if (!settled) return { error: `Run ${runId} lost before settling` };
    if (settled.status === "awaiting_approval") {
      return {
        runId,
        status: "awaiting_approval",
        gateMessage: settled.gateMessage,
        spec: settled.spec,
      };
    }
    if (settled.status === "success") {
      return { runId, status: "success", result: settled.result };
    }
    return { runId, status: "failed" };
  },
});

const approveTool = createTool({
  id: "approve",
  description:
    "Resume a suspended pipeline run with an approval decision. approved=true persists the ticket; approved=false discards it.",
  inputSchema: z.object({
    runId: z.string().describe("Run ID returned by run_pipeline"),
    approved: z.boolean().describe("true to approve and persist, false to discard"),
  }),
  execute: async (inputData) => {
    const { runId, approved } = inputData;
    const result = await runService.approve(runId, approved);
    if (result.error) return { error: result.error };
    if (result.status === "success") {
      return { runId: result.runId, status: "success", result: result.result };
    }
    return { runId: result.runId, status: "failed" };
  },
});

const getRunTool = createTool({
  id: "get_run",
  description:
    "Get the current status and result of a pipeline run. When the run is suspended at an approval gate, also returns the gate message and spec so the caller can review them before approving.",
  inputSchema: z.object({
    runId: z.string().describe("Run ID returned by run_pipeline"),
  }),
  execute: async (inputData) => {
    const got = runService.get(inputData.runId);
    if (!got) return { error: `No run found for runId "${inputData.runId}"` };
    return {
      runId: got.runId,
      pipelineId: got.pipelineId,
      status: got.status,
      result: got.result,
      gateMessage: got.gateMessage,
      spec: got.spec,
    };
  },
});

// ── Start MCP server ──────────────────────────────────────────────────────────

const server = new MCPServer({
  id: "agent-flows-mastra",
  name: "Agent Flows Mastra Binding",
  version: "1.0.0",
  tools: {
    list_pipelines: listPipelinesTool,
    run_pipeline: runPipelineTool,
    approve: approveTool,
    get_run: getRunTool,
  },
});

await server.startStdio();
