// Per-run step log sink (spec 036 D3).
//
// Same shape as stepIntrospection: a module map keyed by Mastra's `runId`, which
// the builders and the run service write into and the server reads back. The
// file is the record — subscribers are notified only after the line is on disk,
// so a live reader can never see an event the backfill route would miss.
//
// Imports downward only (canon/ and node builtins), so no runtime → canon →
// runtime edge exists and the no-cycle lint rule stays quiet.

import { appendFileSync, createReadStream, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CREDENTIAL_DENY_PATTERNS } from "../canon/denyPatterns.js";
import {
  MAX_EVENTS_PER_RUN,
  MAX_LOG_BYTES_PER_RUN,
  boundStepLogEvent,
} from "../canon/stepLogEvents.js";
import { matchesDenyPattern } from "../canon/workspace/denyMatch.js";
import type { StepLogEvent, StepLogEventInput } from "../canon/stepLogEvents.js";

/** Listener signature for live delivery (the SSE `log` channel). */
export type StepLogListener = (event: StepLogEvent) => void;

/** Per-run caps, injectable through openRunLog so tests need not write 20 000 events. */
export interface RunLogCaps {
  events: number;
  bytes: number;
}

interface RunLogEntry {
  dir: string;
  pipelineId: string;
  file: string;
  outputsDir: string;
  seq: number;
  bytes: number;
  truncated: boolean;
  listeners: Set<StepLogListener>;
  /** callIds of denied tool calls, awaiting their result to redact (D8). */
  pendingRedactions: Set<string>;
  /** Step ids that already have a terminal `step.result` line (D2). */
  settledSteps: Set<string>;
  caps: RunLogCaps;
}

const runs = new Map<string, RunLogEntry>();

/**
 * Kinds dropped once a per-run cap is reached (D5). Everything else — the
 * structure of the run and every decision — keeps being written, so a capped
 * log still says what happened, only not what was said inside each step.
 */
const BULK_KINDS = new Set<StepLogEventInput["kind"]>([
  "message",
  "tool.call",
  "tool.result",
  "check.output",
]);

/** Tool input keys whose values are paths (D8). An allowlist, not a structural rule. */
const TOOL_PATH_KEYS = ["file_path", "path", "notebook_path"];

const RE_SAFE_STEP_ID = /^[A-Za-z0-9_.-]+$/u;

/** True when a step id is safe to use as a filename (D6). */
export function isSafeStepId(stepId: string): boolean {
  return RE_SAFE_STEP_ID.test(stepId) && !stepId.includes("..");
}

function assertSafeStepId(stepId: string): void {
  if (!isSafeStepId(stepId)) {
    throw new RangeError(`stepLog: step id ${JSON.stringify(stepId)} is not a safe file name`);
  }
}

/**
 * The pipeline id is the file name stem beside the run directory, and a
 * persisted artifact — which a route reads it from — is as untrusted as any
 * other file on disk, so it is held to the same character class as a step id.
 */
function assertSafePipelineId(pipelineId: string): void {
  if (!isSafeStepId(pipelineId)) {
    throw new RangeError(
      `stepLog: pipeline id ${JSON.stringify(pipelineId)} is not a safe file name`
    );
  }
}

/** Path of a run's events file. Throws RangeError for an unsafe pipeline id. */
export function runLogFile(dir: string, pipelineId: string): string {
  assertSafePipelineId(pipelineId);
  return join(dir, `${pipelineId}.events.jsonl`);
}

/** Path of one step's persisted output. Throws RangeError for an unsafe id. */
export function stepOutputFile(dir: string, pipelineId: string, stepId: string): string {
  assertSafePipelineId(pipelineId);
  assertSafeStepId(stepId);
  return join(dir, `${pipelineId}.outputs`, `${stepId}.json`);
}

/** Log path and message, never the content: an event may hold repository content. */
function reportIoError(path: string, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[agent-flows] step log write failed at ${path}: ${msg}`);
}

// ── Registration ──────────────────────────────────────────────────────────────

/**
 * Register a run and create its events file (D1).
 *
 * Called at run start rather than at settlement so a run that is cancelled or
 * crashes mid-step still has its log on disk. A chained stage writes into the
 * anchor run's directory, so an existing file's lines are counted and the run
 * continues their numbering instead of restarting at 1.
 */
export function openRunLog(
  runId: string,
  opts: { dir: string; pipelineId: string; caps?: Partial<RunLogCaps> }
): void {
  const { dir, pipelineId } = opts;
  const file = runLogFile(dir, pipelineId);
  let seq = 0;
  let bytes = 0;

  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    let existing = "";
    try {
      existing = readFileSync(file, "utf8");
    } catch {
      // Absent: create it now so FR-001 holds before the first step starts.
      writeFileSync(file, "", { mode: 0o600 });
    }
    // From the last parseable line, not from the line count: a run interrupted
    // mid-write leaves a torn last line, which counting would turn into a gap.
    seq = nextSeqFromFile(file) - 1;
    bytes = Buffer.byteLength(existing, "utf8");
  } catch (err) {
    reportIoError(file, err);
  }

  runs.set(runId, {
    dir,
    pipelineId,
    file,
    outputsDir: join(dir, `${pipelineId}.outputs`),
    seq,
    bytes,
    truncated: false,
    listeners: new Set<StepLogListener>(),
    pendingRedactions: new Set<string>(),
    settledSteps: new Set<string>(),
    caps: {
      events: opts.caps?.events ?? MAX_EVENTS_PER_RUN,
      bytes: opts.caps?.bytes ?? MAX_LOG_BYTES_PER_RUN,
    },
  });
}

/**
 * The directory a run's durable files live in, or undefined for an unknown run.
 * A step that writes an artefact of its own writes it beside the events file.
 */
export function runArtifactDir(runId: string | undefined): string | undefined {
  if (runId === undefined || runId === "") return undefined;
  return runs.get(runId)?.dir;
}

/** Drop a run's entry. The file stays: it is the durable record. */
export function closeRunLog(runId: string): void {
  runs.delete(runId);
}

/** Subscribe to events appended from now on. No-op for an unknown run. */
export function subscribeRunLog(runId: string, listener: StepLogListener): () => void {
  const entry = runs.get(runId);
  if (entry === undefined) return () => undefined;
  entry.listeners.add(listener);
  return () => {
    entry.listeners.delete(listener);
  };
}

// ── Appending ─────────────────────────────────────────────────────────────────

/**
 * Defence in depth (D8): a tool call naming a credential file is recorded as an
 * attempt, with its input reduced to the matched path and its result stripped of
 * the excerpt. The CLI deny rules (spec 031) already block the read, so this is
 * only ever observed when that guard has failed.
 */
function deniedPath(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const record = input as Record<string, unknown>;
  const candidates: string[] = [];
  for (const key of TOOL_PATH_KEYS) {
    const value = record[key];
    if (typeof value === "string") candidates.push(value);
  }
  if (Array.isArray(record.paths)) {
    for (const value of record.paths) {
      if (typeof value === "string") candidates.push(value);
    }
  }
  // A shell call names its files inside one string. Every whitespace-separated
  // token is tried, so `cat /x/.env | head` is caught like a Read of the same
  // path; surrounding quotes are stripped so `cat "/x/.env"` matches too. This
  // is a net, not a parser: redirections and shell expansion are not resolved.
  if (typeof record.command === "string") {
    for (const token of record.command.split(/\s+/u)) {
      const unquoted = token.replace(/^["']+|["']+$/gu, "");
      if (unquoted !== "") candidates.push(unquoted);
    }
  }
  // Each candidate is matched as given: every CREDENTIAL_DENY_PATTERNS entry
  // begins with `**/`, which path.matchesGlob matches against an absolute path
  // too (probed 2026-09-14), so no leading-slash variant is needed.
  return candidates.find((path) => matchesDenyPattern(path, CREDENTIAL_DENY_PATTERNS));
}

function applyCredentialGuard(entry: RunLogEntry, input: StepLogEventInput): StepLogEventInput {
  if (input.kind === "tool.call") {
    const path = deniedPath(input.input);
    if (path === undefined) return input;
    if (input.callId !== undefined) entry.pendingRedactions.add(input.callId);
    return { ...input, input: { path }, denied: true };
  }
  if (
    input.kind === "tool.result" &&
    input.callId !== undefined &&
    entry.pendingRedactions.has(input.callId)
  ) {
    entry.pendingRedactions.delete(input.callId);
    const { excerpt: _dropped, ...rest } = input;
    return { ...rest, redacted: true };
  }
  return input;
}

function writeEvent(
  entry: RunLogEntry,
  runId: string,
  stepId: string,
  input: StepLogEventInput
): StepLogEvent {
  const event: StepLogEvent = {
    ...boundStepLogEvent(input),
    seq: ++entry.seq,
    at: new Date().toISOString(),
    runId,
    pipelineId: entry.pipelineId,
    stepId,
  };
  const line = `${JSON.stringify(event)}\n`;
  try {
    appendFileSync(entry.file, line, { mode: 0o600 });
  } catch (err) {
    reportIoError(entry.file, err);
  }
  entry.bytes += Buffer.byteLength(line, "utf8");
  // Notified after the append, so a subscriber never sees a line the file lacks.
  for (const listener of entry.listeners) {
    try {
      listener(event);
    } catch {
      // One broken subscriber must not stop the others or the run.
    }
  }
  return event;
}

/**
 * Append one event for a step. Returns the stamped event, or undefined when the
 * run is unknown (like recordStep, an unknown run is dropped rather than an
 * error), when a per-run cap has already dropped this kind, or when the step
 * already has its terminal event.
 *
 * A step gets exactly one `step.result` (D2). On the cancel path two emitters
 * race for it — the run service synthesises one when it closes the run out, and
 * the step builder emits its own once the child process finally dies — and
 * which of them lands first depends on Mastra's `run.cancel()` ordering, so the
 * second is dropped here rather than left to timing.
 */
export function appendStepLog(
  runId: string | undefined,
  stepId: string,
  input: StepLogEventInput
): StepLogEvent | undefined {
  if (runId === undefined || runId === "") return undefined;
  const entry = runs.get(runId);
  if (entry === undefined) return undefined;

  if (input.kind === "step.result") {
    if (entry.settledSteps.has(stepId)) return undefined;
    entry.settledSteps.add(stepId);
  }

  const guarded = applyCredentialGuard(entry, input);

  if (!entry.truncated && (entry.seq >= entry.caps.events || entry.bytes >= entry.caps.bytes)) {
    entry.truncated = true;
    writeEvent(entry, runId, stepId, {
      kind: "log.truncated",
      events: entry.seq,
      bytes: entry.bytes,
    });
  }
  if (entry.truncated && BULK_KINDS.has(guarded.kind)) return undefined;

  return writeEvent(entry, runId, stepId, guarded);
}

/**
 * Append straight to a run's file when the sink no longer holds the run.
 *
 * `resolveGate`'s superseded branch fires after settlement has already closed
 * the log, and FR-005 requires that decision to be recorded like any other. The
 * sequence continues from the last parseable line; no subscribers exist at that
 * point by definition.
 */
export function appendRunLogFileEvent(
  dir: string,
  pipelineId: string,
  runId: string,
  stepId: string,
  input: StepLogEventInput
): StepLogEvent | undefined {
  const file = runLogFile(dir, pipelineId);
  const event: StepLogEvent = {
    ...boundStepLogEvent(input),
    seq: nextSeqFromFile(file),
    at: new Date().toISOString(),
    runId,
    pipelineId,
    stepId,
  };
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    appendFileSync(file, `${JSON.stringify(event)}\n`, { mode: 0o600 });
  } catch (err) {
    reportIoError(file, err);
    return undefined;
  }
  return event;
}

function nextSeqFromFile(file: string): number {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return 1;
  }
  const lines = raw.split("\n").filter((line) => line !== "");
  // From the end: a run interrupted mid-write can leave a torn last line.
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(lines[i]) as { seq?: number };
      if (typeof parsed.seq === "number") return parsed.seq + 1;
    } catch {
      continue;
    }
  }
  return 1;
}

// ── Reading ───────────────────────────────────────────────────────────────────

/**
 * The `seq` of a raw line, read without parsing it. The key can only appear
 * after `{` or `,` — inside a string value both quotes are escaped — so a
 * crafted message text cannot forge one. A tool input can still carry a nested
 * `{"seq":…}` object of its own, so the LAST match is the stamp: writeEvent
 * serialises `seq, at, runId, pipelineId, stepId` after the payload.
 */
const RE_LINE_SEQ = /[{,]"seq":(\d+)/gu;

function seqOfLine(line: string): number | undefined {
  RE_LINE_SEQ.lastIndex = 0;
  let last: string | undefined;
  for (let match = RE_LINE_SEQ.exec(line); match !== null; match = RE_LINE_SEQ.exec(line)) {
    last = match[1];
  }
  return last === undefined ? undefined : Number(last);
}

/**
 * Read a run's events file. Returns an empty list when the file is absent — a
 * run recorded before this spec simply has no log. A final line without its
 * newline is a write in progress and is dropped rather than parsed.
 *
 * A line below `after` is skipped on its seq alone, so a long backfill does not
 * parse the whole history to throw it away.
 */
export function readRunLog(file: string, opts: { after?: number } = {}): StepLogEvent[] {
  const after = opts.after ?? 0;
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return [];
  }

  const lines = raw.split("\n");
  // The tail is either the empty string after a complete line or a torn line;
  // dropping it covers both.
  lines.pop();

  const events: StepLogEvent[] = [];
  for (const line of lines) {
    const seq = seqOfLine(line);
    if (seq === undefined || seq <= after) continue;
    try {
      events.push(JSON.parse(line) as StepLogEvent);
    } catch {
      // Unparseable line: skip rather than fail the whole read.
    }
  }
  return events;
}

/**
 * Stream a run's events file to a sink, one line at a time (D4).
 *
 * The backfill route uses this rather than readRunLog: a log may be tens of
 * megabytes, and materialising every event as an object per request would hold
 * the whole run in memory. Lines are forwarded verbatim — re-serialising a
 * parsed event would produce the same bytes — and an absent file yields an
 * empty body, as for a run recorded before this spec.
 */
export async function pipeRunLog(
  file: string,
  out: { write: (chunk: string) => unknown },
  opts: { after?: number } = {}
): Promise<void> {
  const after = opts.after ?? 0;
  const stream = createReadStream(file, { encoding: "utf8" });

  await new Promise<void>((resolve) => {
    let pending = "";
    const emit = (line: string): void => {
      const seq = seqOfLine(line);
      if (seq === undefined || seq <= after) return;
      out.write(`${line}\n`);
    };
    stream.on("data", (chunk) => {
      pending += String(chunk);
      let nl = pending.indexOf("\n");
      while (nl !== -1) {
        emit(pending.slice(0, nl));
        pending = pending.slice(nl + 1);
        nl = pending.indexOf("\n");
      }
    });
    // Whatever is left has no newline: the empty tail of a complete file, or a
    // torn line from an interrupted write. Both are dropped.
    stream.on("end", () => resolve());
    stream.on("error", () => resolve());
  });
}

// ── Step outputs (D6) ─────────────────────────────────────────────────────────

/** What one llm step returned, in full — never the excerpt the run state keeps. */
export interface StepOutputPayload {
  kind: "text" | "json";
  schema?: string;
  output: unknown;
}

/**
 * Write one step's full output beside the events file. Never throws: a disk
 * problem must not fail a step that already produced its answer.
 */
export function writeStepOutput(
  runId: string | undefined,
  stepId: string,
  payload: StepOutputPayload
): void {
  if (runId === undefined || runId === "") return;
  const entry = runs.get(runId);
  if (entry === undefined) return;
  assertSafeStepId(stepId);

  const path = join(entry.outputsDir, `${stepId}.json`);
  const body = {
    runId,
    pipelineId: entry.pipelineId,
    stepId,
    kind: payload.kind,
    ...(payload.schema !== undefined ? { schema: payload.schema } : {}),
    output: payload.output,
  };
  try {
    mkdirSync(entry.outputsDir, { recursive: true, mode: 0o700 });
    writeFileSync(path, JSON.stringify(body), { encoding: "utf8", mode: 0o600 });
  } catch (err) {
    reportIoError(path, err);
  }
}

/**
 * Write the raw text a schema-gated step produced, beside its outputs. Never
 * throws, for the same reason writeStepOutput does not — and one more: this is
 * called on the failure path, where the real error must be the one that
 * propagates.
 *
 * `writeStepOutput` is only reached when a step succeeds, so before this a
 * failed parse left nothing on disk at all and the text that broke it could
 * only be guessed at from the error message's 200-character excerpt.
 */
export function writeStepRawOutput(
  runId: string | undefined,
  stepId: string,
  attempts: readonly string[]
): void {
  if (runId === undefined || runId === "") return;
  const entry = runs.get(runId);
  if (entry === undefined) return;
  if (!isSafeStepId(stepId)) return;

  const path = join(entry.outputsDir, `${stepId}.raw.txt`);
  const body = attempts.map((text, i) => `=== attempt ${i + 1} ===\n${text}`).join("\n\n");
  try {
    mkdirSync(entry.outputsDir, { recursive: true, mode: 0o700 });
    writeFileSync(path, body, { encoding: "utf8", mode: 0o600 });
  } catch (err) {
    reportIoError(path, err);
  }
}

/** Path of one step's persisted raw text. Throws RangeError for an unsafe id. */
export function stepRawOutputFile(dir: string, pipelineId: string, stepId: string): string {
  assertSafePipelineId(pipelineId);
  assertSafeStepId(stepId);
  return join(dir, `${pipelineId}.outputs`, `${stepId}.raw.txt`);
}

/** Read one persisted step output. Returns undefined when it is absent or unreadable. */
export function readStepOutput(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}
