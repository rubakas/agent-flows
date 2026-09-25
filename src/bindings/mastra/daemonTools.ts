// Binding B — daemon-proxy logic behind the MCP run tools.
//
// Extracted from server.ts, which cannot be imported by a test because it calls
// MCPServer.startStdio() at module load. Everything here is a plain function
// over the daemon's HTTP API so the tool behaviour is unit-testable against a
// fake daemon.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { isSafeRunId } from "../../runtime/artifactStore.js";
import { resolveProjectState } from "../../runtime/projectState.js";
import { readRunLog, runLogFile } from "../../runtime/stepLog.js";
import { resolveDaemonBase } from "./daemonResolver.js";
import { resolveProjectDir } from "./projectDir.js";
import type { StepLogEvent } from "../../canon/stepLogEvents.js";

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
    // Deliberately does NOT assert a crash: an auto-started daemon retires by
    // design after about 15 minutes with no runs, and calling that a crash sent
    // callers hunting a fault that was never there.
    throw new Error(
      `agent-flows MCP: cannot reach the daemon at ${base}. An auto-started daemon ` +
        `retires after about 15 minutes with no runs; the next call starts a new one. ` +
        `(${msg})`,
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
  /** True when `outputExcerpt` is a prefix of a longer output. */
  outputTruncated?: boolean;
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
  outputTruncated?: boolean;
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
  /** Daemon-derived path of the run's events file; never caller-supplied. */
  eventsPath?: string;
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
    // Without this flag the excerpt reads as the whole output, and a caller that
    // believes it is whole treats what was cut as absent (spec 033 D3).
    ...(state.outputTruncated !== undefined ? { outputTruncated: state.outputTruncated } : {}),
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
async function postRun(
  input: StartRunInput
): Promise<{ runId: string; eventsPath?: string } | { error: string }> {
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
  const { runId, eventsPath } = (await res.json()) as { runId: string; eventsPath?: string };
  return { runId, ...(eventsPath !== undefined ? { eventsPath } : {}) };
}

/**
 * The two push handles a caller can use instead of polling: the events file to
 * tail, and the SSE stream to subscribe to. Both are derived from the daemon's
 * own base and the daemon's own path — nothing a caller supplies reaches
 * either, because the daemon is unauthenticated and a caller-named path or
 * command would be a write primitive.
 *
 * A reader tailing the file must skip a final line with no trailing newline: it
 * is a write in progress, not an event.
 */
async function pushHandles(
  runId: string,
  eventsPath: string | undefined
): Promise<Record<string, string>> {
  let eventsUrl: string | undefined;
  try {
    eventsUrl = `${await resolveDaemonBase()}/api/runs/${encodeURIComponent(runId)}/events`;
  } catch {
    // No daemon to name a URL on; the file is still the durable record.
  }
  return {
    ...(eventsPath !== undefined ? { eventsPath } : {}),
    ...(eventsUrl !== undefined ? { eventsUrl } : {}),
  };
}

/**
 * `start_run` body: start the run and hand the id back at once, so a chat client
 * can poll `get_run` and show progress while the run is still in flight.
 */
export async function startRun(input: StartRunInput): Promise<Record<string, unknown>> {
  const started = await postRun(input);
  if ("error" in started) return started;
  return {
    runId: started.runId,
    status: "running",
    ...(await pushHandles(started.runId, started.eventsPath)),
  };
}

/** `run_pipeline` body: start the run, then block on it until it stops advancing. */
export async function runPipeline(input: StartRunInput): Promise<Record<string, unknown>> {
  const started = await postRun(input);
  if ("error" in started) return started;
  return pollRunUntilTerminal(started.runId);
}

/**
 * The compact per-step view: what a poller needs to know a step exists, where it
 * is, and whether it broke. Timestamps are left out because `progress` already
 * carries elapsed time, and the excerpt is left out because it is the single
 * biggest cost of polling (up to OUTPUT_EXCERPT_LIMIT = 2048 chars per step).
 */
function toCompactStepViews(steps: Record<string, DaemonStepState> | undefined): RunStepView[] {
  if (!steps) return [];
  return Object.entries(steps).map(([id, state]) => ({
    id,
    status: state.status,
    ...(state.error !== undefined ? { error: state.error } : {}),
  }));
}

/**
 * Build the compact `get_run` payload.
 *
 * Every field dropped here is named in `omitted` together with the route or call
 * that returns it: a compact response that silently hides data leaves the caller
 * believing the run has none, which is worse than the token cost it saves.
 */
function compactRunState(
  runId: string,
  got: DaemonRunState,
  push: Record<string, string>
): Record<string, unknown> {
  const omitted: Record<string, string> = {
    // Not a key of its own: `omitted` names data this payload dropped, and a
    // pointer to a cheaper tool is not that. It rides on `mode`, which is the
    // entry about how to read the response rather than about any one field.
    mode:
      "Compact by default — call get_run again with verbose:true for the full payload " +
      "(step output excerpts, full invocation inputs, gate spec, result). For progress " +
      "alone, call get_run_events, tail `eventsPath`, or subscribe to `eventsUrl` — all " +
      "three are cheaper than polling this.",
  };
  if (got.steps !== undefined && Object.keys(got.steps).length > 0) {
    omitted.stepOutput =
      `GET /api/runs/${runId}/steps/<stepId>/output returns a step's whole output; ` +
      "get_run with verbose:true returns the truncated excerpts.";
  }
  if (got.invocation?.inputs !== undefined) {
    omitted.invocationInputs = "get_run with verbose:true, or the run artifact.";
  }
  if (got.spec !== undefined) {
    omitted.spec =
      "The gate spec can be tens of thousands of characters; get_run with verbose:true " +
      "returns it inline, and the run page shows it rendered.";
  }
  if (got.result !== undefined) {
    omitted.result = "get_run with verbose:true.";
  }

  // The invocation minus `inputs`: pipeline, gate mode, provider and start time
  // are a handful of characters each and are what identifies the run.
  const invocation =
    got.invocation === undefined
      ? undefined
      : Object.fromEntries(Object.entries(got.invocation).filter(([key]) => key !== "inputs"));

  return {
    runId: got.runId,
    pipelineId: got.pipelineId,
    status: got.status,
    progress: formatRunProgress(got),
    ...(got.gateMessage !== undefined ? { gateMessage: got.gateMessage } : {}),
    ...(invocation !== undefined ? { invocation } : {}),
    steps: toCompactStepViews(got.steps),
    ...(got.artifactPath !== undefined ? { artifactPath: got.artifactPath } : {}),
    ...(got.cancelled !== undefined ? { cancelled: got.cancelled } : {}),
    ...push,
    omitted,
  };
}

/**
 * `get_run` body: the run's status plus the per-step progress the daemon tracks.
 *
 * Compact by default: polling a run used to cost many thousands of tokens per
 * call, because every response carried the full `invocation.inputs`, a 2048-char
 * excerpt per step and — at a gate — the whole spec inline. `verbose` restores
 * that payload for the one call that actually needs it.
 */
export async function getRunState(
  runId: string,
  verbose = false
): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await daemonFetch(`/api/runs/${encodeURIComponent(runId)}`);
  } catch {
    // A retired daemon must not turn a status question into an exception — but
    // nothing read from disk may be presented as current. This is a READ tool;
    // approve and cancel_run still fail loudly, because a write that quietly
    // reports success is a far worse lie than a read that says "unknown".
    const disk = readRunFromDisk(runId);
    return {
      runId,
      ...(disk.pipelineId !== undefined ? { pipelineId: disk.pipelineId } : {}),
      ...diskEventsPathField(disk),
      ...daemonDownFields(disk),
    };
  }
  if (res.status === 404) {
    return { error: `No run found for runId "${runId}"` };
  }
  if (!res.ok) {
    return { error: `daemon GET /api/runs/${runId} returned HTTP ${res.status}` };
  }
  const got = (await res.json()) as DaemonRunState;
  const push = await pushHandles(runId, got.eventsPath);
  if (!verbose) return compactRunState(runId, got, push);
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
    // Verbose must be a superset of compact, or "verbose returns everything" is
    // false and a caller that drops down to it loses a field. Adding a key
    // breaks nobody — consumers ignore keys they do not read.
    ...(got.artifactPath !== undefined ? { artifactPath: got.artifactPath } : {}),
    ...(got.cancelled !== undefined ? { cancelled: got.cancelled } : {}),
    ...push,
  };
}

// ── Reading a run with no daemon to ask ───────────────────────────────────────

/**
 * What a run's own directory can still say once the daemon is gone.
 *
 * Every field is named for what it is: the LAST PERSISTED state, not the
 * current one. A daemon that died mid-run leaves `running` on disk and nothing
 * will ever update it, so reporting that as `status` would make a polling
 * caller wait forever on a run that stopped hours ago.
 */
interface DiskRun {
  dir: string;
  /** Undefined when the directory names no events file and no artifact. */
  pipelineId?: string;
  lastPersistedStatus: string;
  lastPersistedAt?: string;
  staleSeconds?: number;
}

/** The note every daemon-down payload carries, so the caller reads it as one. */
const DAEMON_DOWN_NOTE =
  "The daemon is not running — an auto-started one retires after about 15 minutes with " +
  'no runs. Nothing here is current: `status` is "unknown" and `lastPersistedStatus` is ' +
  "what the run's own directory last recorded. Start a run, or open the page, to bring a " +
  "daemon back.";

function readJsonFile(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * The run's last recorded status, or "orphaned".
 *
 * "orphaned" covers both a run whose artifact says `running` — no daemon is
 * left to advance it, so that word describes a state that no longer exists —
 * and a run that persisted no terminal status at all. Neither can be reported
 * as in-flight without inventing a run that is still going.
 */
const ORPHANED_ON_DISK: ReadonlySet<string> = new Set(["running", "awaiting_approval"]);

function lastPersistedStatusOf(dir: string, pipelineId: string | undefined): string {
  if (pipelineId === undefined) return "orphaned";
  const artifact = readJsonFile(join(dir, `${pipelineId}.json`)) as
    { status?: unknown } | undefined;
  const manifest = readJsonFile(join(dir, "manifest.json")) as
    { stages?: { stageId?: string; status?: string }[] } | undefined;
  const stage = manifest?.stages?.find((entry) => entry.stageId === pipelineId);
  const recorded =
    typeof artifact?.status === "string"
      ? artifact.status
      : typeof stage?.status === "string"
        ? stage.status
        : undefined;
  // `awaiting_approval` is as dead as `running`: RunService holds suspended runs
  // in memory only, so no daemon is left to accept the approval this status
  // invites. Reporting it verbatim sends the caller to `approve` for a throw.
  if (recorded === undefined || ORPHANED_ON_DISK.has(recorded)) return "orphaned";
  return recorded;
}

/** When anything in the run's directory last changed, as an ISO timestamp. */
function lastWriteOf(dir: string, entries: readonly string[]): number | undefined {
  const times = entries
    .map((name) => {
      try {
        return statSync(join(dir, name)).mtimeMs;
      } catch {
        return undefined;
      }
    })
    .filter((ms): ms is number => ms !== undefined);
  return times.length === 0 ? undefined : Math.max(...times);
}

/**
 * Locate a run's directory under this project's state and read what it says.
 *
 * The pipeline id comes from the events file's own name: that file is created
 * at run start (stepLog D1), so it is there for an in-flight run too, which
 * neither the artifact nor the manifest can claim. Throws when the directory
 * does not exist — a wrong run id is a different failure from a retired daemon
 * and must not read like one.
 */
function readRunFromDisk(runId: string): DiskRun {
  // The run id arrives from an MCP caller as a bare string and is about to be
  // joined onto a filesystem path. Without this, "../../.config/x" turns the
  // fallback — which fires whenever the daemon is retired, i.e. routinely —
  // into a directory-existence, filename, mtime and JSON-status oracle for any
  // path on the machine. The HTTP side has always guarded this; the guard is
  // shared rather than restated.
  if (!isSafeRunId(runId)) {
    throw new Error(
      `agent-flows MCP: run id ${JSON.stringify(runId.slice(0, 80))} is not a run id.`
    );
  }
  const { runsDir } = resolveProjectState(resolveProjectDir());
  const dir = join(runsDir, runId);
  if (!existsSync(dir)) {
    throw new Error(
      `agent-flows MCP: the daemon is unreachable and run "${runId}" has no directory ` +
        `under ${runsDir}, so there is nothing to report. Check the run id.`
    );
  }
  const entries = readdirSync(dir);
  const events = entries.find((name) => name.endsWith(".events.jsonl"));
  const pipelineId =
    events !== undefined
      ? events.slice(0, -".events.jsonl".length)
      : entries.find((name) => name.endsWith(".json") && name !== "manifest.json")?.slice(0, -5);
  const lastWriteMs = lastWriteOf(dir, entries);
  return {
    dir,
    pipelineId,
    lastPersistedStatus: lastPersistedStatusOf(dir, pipelineId),
    ...(lastWriteMs !== undefined
      ? {
          lastPersistedAt: new Date(lastWriteMs).toISOString(),
          staleSeconds: Math.max(0, Math.round((Date.now() - lastWriteMs) / 1_000)),
        }
      : {}),
  };
}

/**
 * The run's events file, or `{}` when the directory named no pipeline. Handing
 * back a path that does not exist tells the caller to tail nothing.
 */
function diskEventsPathField(disk: DiskRun): { eventsPath?: string } {
  if (disk.pipelineId === undefined) return {};
  return { eventsPath: runLogFile(disk.dir, disk.pipelineId) };
}

/** The daemon-down half of any read tool's payload. Never used by a mutating tool. */
function daemonDownFields(disk: DiskRun): Record<string, unknown> {
  return {
    // Never the persisted value: an agent reads `status` as current, and no
    // wording next to it undoes that.
    status: "unknown",
    lastPersistedStatus: disk.lastPersistedStatus,
    ...(disk.lastPersistedAt !== undefined ? { lastPersistedAt: disk.lastPersistedAt } : {}),
    ...(disk.staleSeconds !== undefined ? { staleSeconds: disk.staleSeconds } : {}),
    daemonUnreachableAt: new Date().toISOString(),
    note: DAEMON_DOWN_NOTE,
  };
}

// ── get_run_events ────────────────────────────────────────────────────────────

/**
 * The kinds that describe where a run is, as opposed to what was said inside
 * it. The default for `get_run_events`: everything else in an events file is
 * transcript, and a poller asking for it defeats the point of the tool.
 */
export const LIFECYCLE_KINDS: readonly string[] = ["step.start", "step.result", "step.suspended"];

/** One lifecycle line as MCP callers see it — nothing from the run's content. */
export interface RunEventView {
  seq: number;
  at: string;
  stepId: string;
  kind: string;
  /** Present on step.result: "succeeded" | "failed" | "cancelled". */
  status?: string;
}

function toEventView(event: StepLogEvent): RunEventView {
  const status = (event as { status?: unknown }).status;
  return {
    seq: event.seq,
    at: event.at,
    stepId: event.stepId,
    kind: event.kind,
    ...(typeof status === "string" ? { status } : {}),
  };
}

/**
 * The cursor for the next poll.
 *
 * Taken from the run's HIGHEST seq, not from the highest seq RETURNED: the
 * filter drops most of a chatty run's lines, so advancing only past what came
 * back would leave the cursor pinned near the start and every later poll would
 * re-scan the same megabytes forever — which is precisely what this tool exists
 * to avoid. Every line at or below `maxSeq` has been considered, so skipping
 * past them loses nothing.
 */
function nextSeqOf(maxSeq: number | undefined, sinceSeq: number): number {
  if (maxSeq === undefined || maxSeq < sinceSeq) return sinceSeq;
  return maxSeq + 1;
}

/**
 * `get_run_events` body: the run's lifecycle lines beyond `sinceSeq`.
 *
 * Deliberately minimal — no invocation, no spec, no result, no output excerpts
 * — because the whole point is a call cheap enough to make every few seconds,
 * and `eventsPath` exists so a caller need not make it at all.
 */
export async function getRunEvents(
  runId: string,
  sinceSeq?: number
): Promise<Record<string, unknown>> {
  const since = sinceSeq ?? 0;
  const query = `after=${since}&kinds=${encodeURIComponent(LIFECYCLE_KINDS.join(","))}`;

  let res: Response;
  try {
    res = await daemonFetch(`/api/runs/${encodeURIComponent(runId)}/log?${query}`);
  } catch {
    const disk = readRunFromDisk(runId);
    const wanted = new Set(LIFECYCLE_KINDS);
    const path = diskEventsPathField(disk);
    const all = path.eventsPath === undefined ? [] : readRunLog(path.eventsPath, { after: since });
    const events = all.filter((event) => wanted.has(event.kind)).map(toEventView);
    const maxSeq = all.length === 0 ? undefined : Math.max(...all.map((event) => event.seq));
    return {
      runId,
      ...(disk.pipelineId !== undefined ? { pipelineId: disk.pipelineId } : {}),
      events,
      nextSeq: nextSeqOf(maxSeq, since),
      ...path,
      ...daemonDownFields(disk),
    };
  }

  if (res.status === 404) {
    return { error: `No run found for runId "${runId}"` };
  }
  if (!res.ok) {
    return { error: `daemon GET /api/runs/${runId}/log returned HTTP ${res.status}` };
  }

  const body = await res.text();
  const events = body
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => toEventView(JSON.parse(line) as StepLogEvent));
  const encodedPath = res.headers.get("x-run-events-path");
  const rawMaxSeq = Number(res.headers.get("x-run-max-seq"));
  return {
    runId,
    pipelineId: res.headers.get("x-run-pipeline-id") ?? "",
    status: res.headers.get("x-run-status") ?? "unknown",
    events,
    nextSeq: nextSeqOf(Number.isFinite(rawMaxSeq) ? rawMaxSeq : undefined, since),
    ...(encodedPath ? { eventsPath: decodeURIComponent(encodedPath) } : {}),
    daemonReachableAt: new Date().toISOString(),
  };
}

/**
 * `approve` body: proxy to `POST /api/runs/:id/approve`.
 *
 * Lives here rather than inline in the MCP server so it is reachable by a test.
 * It is a mutating tool, so it has no disk fallback and must keep throwing when
 * the daemon is unreachable: a write that quietly reports success is a worse
 * lie than a read that says "unknown".
 */
export async function approveRun(
  runId: string,
  approved: boolean,
  reason?: string
): Promise<Record<string, unknown>> {
  const res = await daemonFetch(`/api/runs/${encodeURIComponent(runId)}/approve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ approved, ...(reason !== undefined ? { reason } : {}) }),
  });
  const data = (await res.json()) as { error?: string; status?: string; result?: unknown };
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
