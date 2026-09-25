// Binding B — MCP stdio server.
// MUST be the very first line: disable Mastra telemetry before any @mastra import.
process.env.MASTRA_TELEMETRY_DISABLED = "1";

import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createTool } from "@mastra/core/tools";
import { MCPServer } from "@mastra/mcp";
import { z } from "zod";
import { resolveLayers } from "../../canon/layers.js";
import {
  approveRun,
  cancelRun,
  daemonFetch,
  getRunEvents,
  getRunState,
  runPipeline,
  startRun,
} from "./daemonTools.js";
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
  description:
    "List all loaded pipelines with their IDs and descriptions. Each entry reports its " +
    "inputs and which of them are optional (`optionalInputs`), so the required set is " +
    "`inputs` minus `optionalInputs` — a pipeline with an empty required set can be " +
    "started with no input values at all.",
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
    .describe(
      "Pipeline input values, keyed by the input names list_pipelines reports for this " +
        "pipeline. A pipeline may declare every input optional and derive what it needs " +
        "on its own, so `{}` is a legitimate — and often the correct — call: check " +
        "list_pipelines, which marks each input required or optional, and pass values " +
        "only to override what the pipeline would otherwise work out for itself. Some " +
        "pipelines do have required inputs; those must be supplied here, or seeded from " +
        "a previous stage's artifact via artifact_path."
    ),
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
  execute: (inputData) => approveRun(inputData.runId, inputData.approved, inputData.reason),
});

const getRunTool = createTool({
  id: "get_run",
  description:
    "Get the current status and result of a pipeline run. This is the progress companion to start_run: poll it while a run is in flight. Show the `progress` string verbatim — it is the one-line 'pipeline · step (N of M) · elapsed' summary, and the thing to put in front of the user. COMPACT BY DEFAULT (this changed; earlier versions always returned the full payload): a default call returns runId, pipelineId, status, progress, the invocation without its inputs, one `{id, status, error}` per step, the artifact path, cancellation details — and an `omitted` object naming, for every field left out, the route or call that returns it. Pass verbose:true to get the full payload instead: full invocation inputs, per-step output excerpts with startedAt/finishedAt/outputTruncated/model/command, the run result, and the gate spec inline (which can be tens of thousands of characters). Poll with the default and ask for verbose:true once, when you actually need the content. For progress alone, use get_run_events instead of polling this: it returns only step transitions and is a fraction of the size. A step's whole output is also at GET /api/runs/:id/steps/:stepId/output. Rendered prompts are never returned in either mode — read them from the run page or artifact. When the run is suspended at an approval gate, both modes return the gate message; only verbose:true inlines the spec.",
  inputSchema: z.object({
    runId: z.string().describe("Run ID returned by run_pipeline"),
    verbose: z
      .boolean()
      .optional()
      .describe(
        "Optional, default false. false returns the compact status/progress payload; true returns the full one — step output excerpts, full invocation inputs, the result and the gate spec inline. Polling with verbose:true costs many thousands of tokens per call."
      ),
  }),
  execute: (inputData) => getRunState(inputData.runId, inputData.verbose),
});

const getRunEventsTool = createTool({
  id: "get_run_events",
  description:
    "Get a run's step transitions since a cursor - the cheap way to follow a run. Use this instead of polling get_run for progress: it returns one small {seq, at, stepId, kind, status} line per transition (step.start, step.result, step.suspended) and none of the run's content - no invocation, no spec, no result, no output excerpts. Poll it with sinceSeq set to the nextSeq of the previous call and you will never see the same line twice. Better still, do not poll at all: the response carries `eventsPath`, the absolute path of the run's events file, which exists from the moment the run starts and can be tailed or watched for push-style updates - an external reader must skip a final line that has no trailing newline, because that is a write in progress and not an event. `GET /api/runs/:id/events` is the documented SSE stream for the same thing over HTTP. One limitation when counting transitions: a step inside a `loop` body runs once per iteration and emits a step.start each time, but only ONE step.result for the whole loop, so such a step reads as permanently in flight - do not infer from that that it hung. If the daemon is not running, this returns the run's last persisted lines from disk with status 'unknown', a `lastPersistedStatus` and a `staleSeconds` - nothing there is current, and `lastPersistedStatus: \"orphaned\"` means the run was mid-flight when its daemon went away.",
  inputSchema: z.object({
    runId: z.string().describe("Run ID returned by start_run or run_pipeline"),
    sinceSeq: z
      .number()
      .optional()
      .describe(
        "Return only transitions with a higher seq. Pass the previous call's nextSeq to poll without overlap; omit it for the whole history."
      ),
  }),
  execute: (inputData) => getRunEvents(inputData.runId, inputData.sinceSeq),
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
        "Free text (feature request, task description, or a request to review existing work) or an absolute path to an existing artifact file"
      ),
    kind: z
      .enum(["feature-request", "task-description", "review-request"])
      .optional()
      .describe(
        'Optional explicit kind. "feature-request" routes to formulation (investigate); "task-description" routes to development (develop); "review-request" routes to review (code-review).'
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
    get_run_events: getRunEventsTool,
    cancel_run: cancelRunTool,
    decide_entry_point: decideEntryPointTool,
  },
});

await server.startStdio();
