// Binding B — MCP stdio server.
// MUST be the very first line: disable Mastra telemetry before any @mastra import.
process.env.MASTRA_TELEMETRY_DISABLED = "1";

import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createTool } from "@mastra/core/tools";
import { MCPServer } from "@mastra/mcp";
import { z } from "zod";
import { loadCatalog, resolveCanonDir } from "./pipelineLoader.js";
import { resolveProjectDir } from "./projectDir.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ── Daemon URL (FR-005) ───────────────────────────────────────────────────────
// The MCP tools proxy to the HTTP daemon so all three surfaces (MCP stdio, HTTP,
// and the web editor) share the same RunService registry. Default port matches
// server.ts. Override with AGENT_FLOWS_PORT.

const DAEMON_PORT = process.env.AGENT_FLOWS_PORT ?? "7411";
const DAEMON_BASE = `http://127.0.0.1:${DAEMON_PORT}`;

async function daemonFetch(path: string, init?: RequestInit): Promise<Response> {
  const url = `${DAEMON_BASE}${path}`;
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `agent-flows MCP: cannot reach daemon at ${DAEMON_BASE} — start it with ` +
        `"agent-flows serve" before using run tools. (${msg})`,
      { cause: err }
    );
  }
  return res;
}

// ── Project directory (step execution cwd) ────────────────────────────────────

const projectDir = resolveProjectDir();
// Log to stderr so the MCP stdio channel (stdout) is not polluted.
console.error(`agent-flows MCP server: running steps in ${projectDir}`);

// ── Load pipelines ────────────────────────────────────────────────────────────

const { pipelinesDir, source: pipelinesSource } = resolveCanonDir(projectDir);
console.error(`agent-flows MCP server: pipelines from ${pipelinesSource} (${pipelinesDir})`);

// ── MCP custom tools ──────────────────────────────────────────────────────────

const listPipelinesTool = createTool({
  id: "list_pipelines",
  description: "List all loaded pipelines with their IDs and descriptions.",
  inputSchema: z.object({}),
  execute: async () => {
    // Still reads from disk so newly added pipelines are visible without restart.
    const catalog = loadCatalog(pipelinesDir);
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
    gateMode: z
      .enum(["manual", "auto"])
      .optional()
      .describe(
        'Gate evaluation mode. "manual" (default): gates wait for human approval. "auto": a judge model evaluates each gate; falls back to manual on judge failure.'
      ),
  }),
  execute: async (inputData) => {
    const { pipeline, inputs, models, gateMode } = inputData;
    const body = {
      pipeline,
      inputs,
      ...(models ? { models } : {}),
      ...(gateMode ? { gateMode } : {}),
    };

    // POST to the daemon — fails loudly if the daemon is not running.
    const startRes = await daemonFetch("/api/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!startRes.ok) {
      const e = (await startRes.json().catch(() => ({}))) as { error?: string };
      return { error: e.error ?? `daemon POST /api/runs returned HTTP ${startRes.status}` };
    }
    const { runId } = (await startRes.json()) as { runId: string };

    // Poll until the run leaves "running" — preserves the blocking contract (FR-005).
    for (;;) {
      await new Promise<void>((resolve) => setTimeout(resolve, 1_000));
      const getRes = await daemonFetch(`/api/runs/${encodeURIComponent(runId)}`);
      if (!getRes.ok) {
        return { error: `daemon GET /api/runs/${runId} returned HTTP ${getRes.status}` };
      }
      const state = (await getRes.json()) as {
        status: string;
        gateMessage?: string;
        spec?: unknown;
        result?: unknown;
      };
      if (state.status === "running") continue;
      if (state.status === "awaiting_approval" || state.status === "suspended") {
        return {
          runId,
          status: "awaiting_approval",
          gateMessage: state.gateMessage,
          spec: state.spec,
        };
      }
      if (state.status === "success") {
        return { runId, status: "success", result: state.result };
      }
      return { runId, status: "failed" };
    }
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
    const res = await daemonFetch(`/api/runs/${encodeURIComponent(runId)}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ approved }),
    });
    const data = (await res.json()) as {
      error?: string;
      status?: string;
      result?: unknown;
    };
    if (!res.ok || data.error) {
      return { error: data.error ?? `HTTP ${res.status}` };
    }
    if (data.status === "success") {
      return { runId, status: "success", result: data.result };
    }
    return { runId, status: "failed" };
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
    const res = await daemonFetch(`/api/runs/${encodeURIComponent(inputData.runId)}`);
    if (res.status === 404) {
      return { error: `No run found for runId "${inputData.runId}"` };
    }
    if (!res.ok) {
      return { error: `daemon GET /api/runs/${inputData.runId} returned HTTP ${res.status}` };
    }
    const got = (await res.json()) as {
      runId: string;
      pipelineId: string;
      status: string;
      result?: unknown;
      gateMessage?: string;
      spec?: unknown;
    };
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
