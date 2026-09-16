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

interface DaemonRunState {
  runId: string;
  pipelineId: string;
  status: string;
  result?: unknown;
  gateMessage?: string;
  spec?: unknown;
  artifactPath?: string;
  invocation?: unknown;
  steps?: Record<string, DaemonStepState>;
  cancelled?: { at: string; reason?: string };
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
