// Binding B — daemon-proxy logic behind the MCP run tools.
//
// Extracted from server.ts, which cannot be imported by a test because it calls
// MCPServer.startStdio() at module load. Everything here is a plain function
// over the daemon's HTTP API so the tool behaviour is unit-testable against a
// fake daemon.

import { resolveDaemonBase } from "./daemonResolver.js";

export async function daemonFetch(path: string, init?: RequestInit): Promise<Response> {
  // Resolved per call (spec 038 FR-013): the daemon is found by identity — this
  // project's daemon.json plus a GET /api/daemon handshake — and auto-started
  // when there is none, instead of the old fixed `AGENT_FLOWS_PORT ?? 7411`
  // guess, which could hand this project's run to another project's daemon.
  // The resolution itself is memoized, so this is one probe per process.
  const base = await resolveDaemonBase();
  const url = `${base}${path}`;
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `agent-flows MCP: cannot reach the daemon at ${base}; it answered the identity ` +
        `handshake earlier in this session, so it has since stopped or crashed. (${msg})`,
      { cause: err }
    );
  }
  return res;
}

/**
 * Statuses at which a run has stopped advancing on its own. `run_pipeline`
 * polls until it sees one of these; "cancelled" belongs here because a cancelled
 * run never resumes, so leaving it out makes the poll loop forever (spec 033
 * FR-010).
 */
export const TERMINAL_RUN_STATUSES: ReadonlySet<string> = new Set([
  "awaiting_approval",
  "succeeded",
  "rejected",
  "failed",
  "cancelled",
]);

/**
 * Wall-clock ceiling on `run_pipeline`'s poll loop. Runs are deliberately
 * unbounded in time, so this is not a run timeout — it is a backstop against a
 * daemon that stops advancing a run, which would otherwise hang the chat client
 * forever with no output. Override with AGENT_FLOWS_POLL_MAX_MS.
 */
export const DEFAULT_POLL_MAX_MS = 6 * 60 * 60 * 1_000;

function pollMaxMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.AGENT_FLOWS_POLL_MAX_MS;
  if (raw === undefined) return DEFAULT_POLL_MAX_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_POLL_MAX_MS;
}

/** One step as reported to MCP callers by `get_run` (spec 033 D3). */
export interface RunStepView {
  id: string;
  status: string;
  startedAt?: string;
  finishedAt?: string;
  outputExcerpt?: string;
  error?: string;
  /** Resolved model for llm steps (spec 033 D6). */
  model?: string;
  /** Shell command for check steps (spec 033 D6). */
  command?: string;
}

interface DaemonStepState {
  status: string;
  startedAt?: string;
  finishedAt?: string;
  outputExcerpt?: string;
  error?: string;
  /** Rendered prompt — deliberately never forwarded to chat (spec 033 D6). */
  prompt?: string;
  model?: string;
  command?: string;
}

export interface DaemonRunState {
  runId: string;
  pipelineId: string;
  status: string;
  result?: unknown;
  gateMessage?: string;
  spec?: unknown;
  artifactPath?: string;
  invocation?: { startedAt?: string; [key: string]: unknown };
  steps?: Record<string, DaemonStepState>;
  cancelled?: { at: string; reason?: string };
}

/**
 * Mastra's own synthetic bookkeeping for parallel merge branches. No pipeline
 * author declares one, so an operator would not recognise the id and it must
 * never be shown as the current step or counted in "N of M".
 */
const SYNTHETIC_STEP_ID = /^__merge_level_\d+$/u;

/** Elapsed time as one glanceable token: "42s", "3m12s", "1h04m". */
function compactElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1_000));
  const h = Math.floor(seconds / 3_600);
  const m = Math.floor((seconds % 3_600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}

/** Milliseconds for an ISO timestamp, or undefined when absent or unparseable. */
function isoMs(iso: string | undefined): number | undefined {
  if (iso === undefined) return undefined;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? undefined : ms;
}

/**
 * One glanceable line describing where a run is, for a chat client that cannot
 * show the `steps` array: `code-review · verify (4 of 6) · 3m12s` while it
 * advances, `code-review · succeeded · 6 steps · 4m01s` once it has stopped.
 *
 * Pure over the daemon's run state so it can be tested without a daemon; `now`
 * is a parameter for the same reason.
 *
 * A run at a gate is rendered in the stopped form: it is not advancing, so a
 * growing elapsed time and a "current step" would both be lies. There is no
 * cost segment because `GET /api/runs/:id` reports no per-run cost — `costUsd`
 * lives only on usage events in the run's events log, and aggregating it is not
 * this function's job.
 */
export function formatRunProgress(state: DaemonRunState, now: number = Date.now()): string {
  const steps = Object.entries(state.steps ?? {}).filter(([id]) => !SYNTHETIC_STEP_ID.test(id));
  const stopped = TERMINAL_RUN_STATUSES.has(state.status);

  const startMs =
    isoMs(state.invocation?.startedAt) ??
    steps.map(([, st]) => isoMs(st.startedAt)).find((ms) => ms !== undefined);
  const finishedMs = steps
    .map(([, st]) => isoMs(st.finishedAt))
    .filter((ms): ms is number => ms !== undefined);
  const endMs = stopped && finishedMs.length > 0 ? Math.max(...finishedMs) : now;
  const elapsed = compactElapsed(startMs === undefined ? 0 : endMs - startMs);

  if (stopped) {
    const count = `${steps.length} step${steps.length === 1 ? "" : "s"}`;
    return [state.pipelineId, state.status, count, elapsed].join(" · ");
  }

  // The running step, or — between steps, or while a synthetic merge is in
  // flight — the last one to finish, so the line never goes blank mid-run.
  let currentIndex = steps.findIndex(([, st]) => st.status === "running");
  if (currentIndex === -1) {
    for (let i = steps.length - 1; i >= 0; i--) {
      if (steps[i][1].finishedAt !== undefined) {
        currentIndex = i;
        break;
      }
    }
  }
  if (currentIndex === -1) return [state.pipelineId, "starting", elapsed].join(" · ");
  const position = `${steps[currentIndex][0]} (${currentIndex + 1} of ${steps.length})`;
  return [state.pipelineId, position, elapsed].join(" · ");
}

/**
 * Flatten the daemon's `steps` map into an array the chat client can print.
 *
 * `prompt` is dropped on purpose (spec 033 D6): a rendered prompt can be tens of
 * thousands of characters and would drown the chat transcript. It stays
 * available on the page and in the run artifact.
 */
function toStepViews(steps: Record<string, DaemonStepState> | undefined): RunStepView[] {
  if (!steps) return [];
  return Object.entries(steps).map(([id, state]) => ({
    id,
    status: state.status,
    ...(state.startedAt !== undefined ? { startedAt: state.startedAt } : {}),
    ...(state.finishedAt !== undefined ? { finishedAt: state.finishedAt } : {}),
    ...(state.outputExcerpt !== undefined ? { outputExcerpt: state.outputExcerpt } : {}),
    ...(state.error !== undefined ? { error: state.error } : {}),
    ...(state.model !== undefined ? { model: state.model } : {}),
    ...(state.command !== undefined ? { command: state.command } : {}),
  }));
}

/**
 * Poll `GET /api/runs/:id` until the run reaches a terminal status, then shape
 * the result for the chat client. Preserves the blocking contract `run_pipeline`
 * had before start() became non-blocking.
 */
export async function pollRunUntilTerminal(
  runId: string,
  intervalMs = 1_000,
  maxMs = pollMaxMs()
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + maxMs;
  for (;;) {
    if (Date.now() >= deadline) {
      throw new Error(
        `agent-flows MCP: run ${runId} did not reach a terminal status within ${maxMs}ms — ` +
          `check the daemon, then use get_run to inspect it.`
      );
    }
    await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
    const getRes = await daemonFetch(`/api/runs/${encodeURIComponent(runId)}`);
    if (!getRes.ok) {
      return { error: `daemon GET /api/runs/${runId} returned HTTP ${getRes.status}` };
    }
    const state = (await getRes.json()) as DaemonRunState;
    if (!TERMINAL_RUN_STATUSES.has(state.status)) continue;
    const artifactPathField =
      state.artifactPath !== undefined ? { artifactPath: state.artifactPath } : {};
    if (state.status === "awaiting_approval") {
      return {
        runId,
        status: "awaiting_approval",
        gateMessage: state.gateMessage,
        spec: state.spec,
        ...artifactPathField,
      };
    }
    if (state.status === "succeeded") {
      return { runId, status: "succeeded", result: state.result, ...artifactPathField };
    }
    if (state.status === "rejected") {
      return { runId, status: "rejected", ...artifactPathField };
    }
    if (state.status === "cancelled") {
      return {
        runId,
        status: "cancelled",
        ...(state.cancelled !== undefined ? { cancelled: state.cancelled } : {}),
        ...artifactPathField,
      };
    }
    return { runId, status: "failed" };
  }
}

/** What `start_run` and `run_pipeline` accept, before it is mapped to the daemon's wire shape. */
export interface StartRunInput {
  pipeline: string;
  inputs?: Record<string, string>;
  models?: Record<string, string>;
  provider?: string;
  gateMode?: "manual" | "auto";
  artifact_path?: string;
}

/**
 * POST `/api/runs` and return the new run's id. Shared by both start tools so
 * they cannot drift in how they build the request body — the only difference
 * between them is what they do with the id afterwards.
 */
async function postRun(input: StartRunInput): Promise<{ runId: string } | { error: string }> {
  const { pipeline, inputs, models, provider, gateMode, artifact_path } = input;
  const body = {
    pipeline,
    ...(inputs !== undefined ? { inputs } : {}),
    ...(models ? { models } : {}),
    ...(provider ? { provider } : {}),
    ...(gateMode ? { gateMode } : {}),
    ...(artifact_path ? { artifactPath: artifact_path } : {}),
  };

  // POST to the daemon — fails loudly if the daemon is not running.
  const res = await daemonFetch("/api/runs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const e = (await res.json().catch(() => ({}))) as { error?: string };
    return { error: e.error ?? `daemon POST /api/runs returned HTTP ${res.status}` };
  }
  const { runId } = (await res.json()) as { runId: string };
  return { runId };
}

/**
 * `start_run` body: start the run and hand the id back at once, so a chat client
 * can poll `get_run` and show progress while the run is still in flight.
 */
export async function startRun(input: StartRunInput): Promise<Record<string, unknown>> {
  const started = await postRun(input);
  if ("error" in started) return started;
  return { runId: started.runId, status: "running" };
}

/** `run_pipeline` body: start the run, then block on it until it stops advancing. */
export async function runPipeline(input: StartRunInput): Promise<Record<string, unknown>> {
  const started = await postRun(input);
  if ("error" in started) return started;
  return pollRunUntilTerminal(started.runId);
}

/** `get_run` body: the run's status plus the per-step progress the daemon tracks. */
export async function getRunState(runId: string): Promise<Record<string, unknown>> {
  const res = await daemonFetch(`/api/runs/${encodeURIComponent(runId)}`);
  if (res.status === 404) {
    return { error: `No run found for runId "${runId}"` };
  }
  if (!res.ok) {
    return { error: `daemon GET /api/runs/${runId} returned HTTP ${res.status}` };
  }
  const got = (await res.json()) as DaemonRunState;
  return {
    runId: got.runId,
    pipelineId: got.pipelineId,
    status: got.status,
    result: got.result,
    gateMessage: got.gateMessage,
    spec: got.spec,
    ...(got.invocation !== undefined ? { invocation: got.invocation } : {}),
    steps: toStepViews(got.steps),
    progress: formatRunProgress(got),
    ...(got.cancelled !== undefined ? { cancelled: got.cancelled } : {}),
  };
}

/**
 * `cancel_run` body: proxy to `POST /api/runs/:id/cancel` (spec 033 FR-007).
 * A 409 is a refusal, not a transport failure, so its status is surfaced in the
 * error text — the caller needs to know the run had already finished.
 */
export async function cancelRun(runId: string, reason?: string): Promise<Record<string, unknown>> {
  const res = await daemonFetch(`/api/runs/${encodeURIComponent(runId)}/cancel`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(reason !== undefined ? { reason } : {}),
  });
  if (res.status === 204) {
    return { runId, status: "cancelled" };
  }
  const data = (await res.json().catch(() => ({}))) as { error?: string; status?: string };
  if (res.status === 409) {
    return {
      error: data.error ?? `Run ${runId} cannot be cancelled (status: ${data.status ?? "unknown"})`,
    };
  }
  return {
    error: data.error ?? `daemon POST /api/runs/${runId}/cancel returned HTTP ${res.status}`,
  };
}
