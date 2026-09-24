// Spawn the local claude CLI for subscription-authenticated LLM calls.
// Uses --output-format stream-json for live supervision (spec-024, FR-001).

import { spawn as defaultSpawn } from "node:child_process";
import { emitStepEvent } from "./stepLogEvents.js";
import { TransportFailureError } from "./stepRuntime.js";
import type { StepEventSink, StepLogEventInput, UsagePayload } from "./stepLogEvents.js";

export type SpawnFn = typeof defaultSpawn;

// ── Constants ─────────────────────────────────────────────────────────────────

/** Milliseconds of stdout silence before declaring the child stalled (FR-002). */
export const STALL_SILENCE_MS = 900_000;

/** R1: consecutive identical tool_use pairs that trip the loop detector (FR-003). */
export const LOOP_CONSECUTIVE = 4;

/** R2: window of recent pairs examined for oscillation (FR-003). */
export const LOOP_WINDOW = 10;

/** R2: minimum distinct pairs required in the window to NOT trip (FR-003). */
export const LOOP_DISTINCT_MIN = 3;

/** Milliseconds between SIGTERM and SIGKILL on watchdog-triggered abort. */
const WATCHDOG_KILL_ESCALATION_MS = 3_000;

// ── Error classes ─────────────────────────────────────────────────────────────

/** Thrown by runClaudeCli when the stall or loop detector trips. */
export class WatchdogTrip extends Error {
  readonly pathology: "stall" | "loop";
  readonly detail: string;
  readonly digest: string;

  constructor(pathology: "stall" | "loop", detail: string, digest: string) {
    super(`Watchdog trip: ${pathology} — ${detail}`);
    this.name = "WatchdogTrip";
    this.pathology = pathology;
    this.detail = detail;
    this.digest = digest;
  }
}

/** Thrown when a --max-budget-usd limit is tripped by the CLI (FR-007). */
export class StepBudgetExceededError extends Error {
  readonly limitUsd: number;
  readonly estimatedUsd: number;

  constructor(limitUsd: number, estimatedUsd: number) {
    super(
      `Step exceeded budget limit of $${limitUsd.toFixed(4)} USD (estimated spend: $${estimatedUsd.toFixed(4)} USD)`
    );
    this.name = "StepBudgetExceededError";
    this.limitUsd = limitUsd;
    this.estimatedUsd = estimatedUsd;
  }
}

// ── Interfaces ────────────────────────────────────────────────────────────────

export interface RunCliOptions {
  model?: string;
  cwd?: string;
  signal?: AbortSignal;
  extraArgs?: string[];
  /** Emit --max-budget-usd <amount> when set (FR-007). */
  maxBudgetUsd?: number;
  /**
   * JSON Schema for the CLI's structured output (`--json-schema`). When set, the
   * model answers through a structured-output tool call and the terminal result
   * event carries pure JSON, so a narrated preamble or a markdown fence in the
   * assistant text can no longer reach the caller's JSON.parse.
   */
  jsonSchema?: unknown;
  /** Override STALL_SILENCE_MS in tests. */
  _stallSilenceMs?: number;
  /** Receives the stream's inner events as they are parsed (spec 036 D2). */
  onEvent?: StepEventSink;
  /** Which watchdog attempt this invocation is (1 or 2); stamped on watchdog events. */
  attempt?: number;
}

export interface RunCliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  /** Estimated USD cost from the result event (client-side estimate). */
  totalCostUsd?: number;
  /** Number of turns from the result event. */
  numTurns?: number;
}

export const SCRUBBED_KEYS = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "LITELLM_VIRTUAL_KEY"];

// ── Tool pair type (for loop detector) ───────────────────────────────────────

/** A single (name, canonicalJsonInput) pair extracted from a tool_use block. */
export interface ToolPair {
  name: string;
  /** Canonical JSON of the tool input: keys sorted for stable comparison. */
  input: string;
}

// ── Loop detector factory ─────────────────────────────────────────────────────

/**
 * Returns a stateful loop detector. Call `add(pair)` for each observed tool_use.
 * Returns a trip descriptor when R1 or R2 fires, or null otherwise.
 * Exported for direct unit testing (FR-010).
 */
export function makeLoopDetector(): {
  add: (pair: ToolPair) => { detail: string } | null;
  getPairs: () => ToolPair[];
} {
  const pairs: ToolPair[] = [];

  function add(pair: ToolPair): { detail: string } | null {
    pairs.push(pair);
    const key = `${pair.name}:${pair.input}`;

    // R1: 4 consecutive identical pairs
    if (pairs.length >= LOOP_CONSECUTIVE) {
      const last = pairs.slice(-LOOP_CONSECUTIVE);
      const firstKey = `${last[0].name}:${last[0].input}`;
      if (last.every((p) => `${p.name}:${p.input}` === firstKey)) {
        return {
          detail: `tool ${pair.name} called ${LOOP_CONSECUTIVE} times with identical input ${pair.input.slice(0, 200)}`,
        };
      }
    }

    // R2: once ≥10 pairs seen, last 10 contain ≤2 distinct pairs
    if (pairs.length >= LOOP_WINDOW) {
      const window = pairs.slice(-LOOP_WINDOW);
      const distinct = new Set(window.map((p) => `${p.name}:${p.input}`));
      if (distinct.size < LOOP_DISTINCT_MIN) {
        const summary = [...distinct]
          .map((k) => {
            const [name, inp] = k.split(/:(.+)/, 2);
            return `${name}(${(inp ?? "").slice(0, 60)})`;
          })
          .join(", ");
        return {
          detail: `oscillation detected: last ${LOOP_WINDOW} calls contained only ${distinct.size} distinct pair(s): ${summary}`,
        };
      }
    }

    void key; // prevent unused warning
    return null;
  }

  return { add, getPairs: () => pairs };
}

// ── Digest builder ────────────────────────────────────────────────────────────

/**
 * Builds a bounded action digest from observed tool pairs.
 * Includes only tool names and model-authored inputs (truncated), never tool results.
 * Exported for direct unit testing (FR-010).
 */
export function buildDigest(pairs: ToolPair[]): string {
  const MAX_TOTAL = 4096;
  const INPUT_TRUNCATE = 200;
  const LAST_N = 30;

  const recent = pairs.slice(-LAST_N);

  // Collapse consecutive identical pairs into a count
  const collapsed: { name: string; input: string; count: number }[] = [];
  for (const p of recent) {
    const last = collapsed[collapsed.length - 1];
    if (last?.name === p.name && last.input === p.input) {
      last.count++;
    } else {
      collapsed.push({ name: p.name, input: p.input.slice(0, INPUT_TRUNCATE), count: 1 });
    }
  }

  const lines = collapsed.map((c) =>
    c.count > 1 ? `${c.name}(${c.input}) ×${c.count}` : `${c.name}(${c.input})`
  );

  // Cap total size
  let total = 0;
  const kept: string[] = [];
  for (const line of lines) {
    if (total + line.length > MAX_TOTAL) break;
    kept.push(line);
    total += line.length + 1;
  }

  return kept.join("\n");
}

// ── Canonical JSON (sorted keys) ──────────────────────────────────────────────

function canonicalJson(value: unknown): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return JSON.stringify(value);
  }
  const sorted = Object.keys(value)
    .sort()
    .reduce<Record<string, unknown>>((acc, k) => {
      acc[k] = (value as Record<string, unknown>)[k];
      return acc;
    }, {});
  return JSON.stringify(sorted);
}

// ── Stream result extractor ───────────────────────────────────────────────────

/** Transport label carried on every TransportFailureError this module throws. */
const CLAUDE_TRANSPORT = "cli:claude";

/**
 * Synthetic subtype for the exit-0 unrecognized-model failure: the CLI reports
 * it in the result text rather than as a subtype, and the failover classifier
 * needs a field to read, not a message to match.
 */
export const UNRECOGNIZED_MODEL_SUBTYPE = "unrecognized_model";

interface ClaudeResultEvent {
  type: "result";
  subtype: string;
  is_error: boolean;
  result: string;
  total_cost_usd?: number;
  num_turns?: number;
}

/**
 * Scans all lines in rawStdout for a `type === "result"` event.
 * Returns the event or null if not found. Skips non-JSON lines (FR-009).
 * Exported for direct unit testing (FR-001, T-1).
 */
export function findResultEvent(rawStdout: string): ClaudeResultEvent | null {
  let found: ClaudeResultEvent | null = null;
  for (const line of rawStdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const ev = JSON.parse(trimmed) as Record<string, unknown>;
      if (ev.type === "result") {
        found = ev as unknown as ClaudeResultEvent;
        // Do NOT break: scan entire stream in case result appears before trailing events.
        // The last seen result event wins (there should only be one, but we're defensive).
      }
    } catch {
      // non-JSON line: skip (FR-009)
    }
  }
  return found;
}

// ── Stream event mapping (spec 036 D2) ────────────────────────────────────────

/** One content block of an assistant or user message, as the stream reports it. */
interface ClaudeContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

/** Parses one stdout line, or returns undefined for anything that is not a JSON object. */
function parseStreamLine(line: string): Record<string, unknown> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined; // non-JSON: skip, still counts as liveness (timer already reset)
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  return parsed as Record<string, unknown>;
}

function contentBlocksOf(event: Record<string, unknown>): ClaudeContentBlock[] {
  const message = event.message as { content?: unknown } | undefined;
  const content = message?.content;
  return Array.isArray(content) ? (content as ClaudeContentBlock[]) : [];
}

function usageFromResultEvent(event: Record<string, unknown>): UsagePayload {
  const payload: UsagePayload = {};
  if (typeof event.total_cost_usd === "number") payload.costUsd = event.total_cost_usd;
  if (typeof event.num_turns === "number") payload.turns = event.num_turns;
  if (typeof event.duration_ms === "number") payload.durationMs = event.duration_ms;
  const usage = event.usage as { input_tokens?: number; output_tokens?: number } | undefined;
  if (typeof usage?.input_tokens === "number" && typeof usage.output_tokens === "number") {
    payload.usage = { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens };
  }
  // A refused tool call leaves the run-level is_error false, so permission_denials
  // is the only run-level signal that the CLI blocked something.
  if (Array.isArray(event.permission_denials)) payload.denials = event.permission_denials.length;
  return payload;
}

/**
 * Maps one parsed stream-json event onto the provider-neutral kinds (spec 036 D2).
 * Events that map to none of them produce no output — there is no raw passthrough.
 */
function claudeEventToEvents(event: Record<string, unknown>): StepLogEventInput[] {
  if (event.type === "assistant") {
    // A subagent's turn carries the id of the tool call that spawned it.
    const nested = event.parent_tool_use_id != null;
    const events: StepLogEventInput[] = [];
    for (const block of contentBlocksOf(event)) {
      if (block.type === "text" && typeof block.text === "string") {
        events.push({ kind: "message", role: "assistant", text: block.text });
      } else if (block.type === "tool_use" && typeof block.name === "string") {
        events.push({
          kind: "tool.call",
          ...(typeof block.id === "string" ? { callId: block.id } : {}),
          name: block.name,
          input: block.input,
          ...(nested ? { nested: true } : {}),
        });
      }
      // `thinking` blocks are deliberately skipped: they are the model's private
      // reasoning, not an action, and carry a signature blob of no use to a reader.
    }
    return events;
  }

  if (event.type === "user") {
    const events: StepLogEventInput[] = [];
    for (const block of contentBlocksOf(event)) {
      if (block.type !== "tool_result") continue;
      const excerpt =
        typeof block.content === "string" ? block.content : JSON.stringify(block.content);
      events.push({
        kind: "tool.result",
        ...(typeof block.tool_use_id === "string" ? { callId: block.tool_use_id } : {}),
        // `is_error` is absent on a successful Read and false on a successful
        // Bash, so only an explicit true means the call failed or was refused.
        ok: block.is_error !== true,
        ...(excerpt !== undefined ? { excerpt } : {}),
      });
    }
    return events;
  }

  if (event.type === "result") {
    return [{ kind: "usage", ...usageFromResultEvent(event) }];
  }

  return [];
}

/**
 * Maps one raw stdout line onto step log events. Exported for direct unit
 * testing against captured streams (spec 036 V2).
 */
export function claudeStreamLineToEvents(line: string): StepLogEventInput[] {
  const event = parseStreamLine(line);
  return event === undefined ? [] : claudeEventToEvents(event);
}

// ── Main export ───────────────────────────────────────────────────────────────

export function runClaudeCli(
  prompt: string,
  opts: RunCliOptions = {},
  deps: { spawn?: SpawnFn; env?: NodeJS.ProcessEnv } = {}
): Promise<RunCliResult> {
  const {
    model,
    cwd,
    signal,
    extraArgs = [],
    maxBudgetUsd,
    jsonSchema,
    _stallSilenceMs,
    onEvent,
  } = opts;
  const spawnFn = deps.spawn ?? defaultSpawn;

  // Layer-0: scrub provider keys before passing env to child
  const rawEnv = deps.env ?? process.env;
  const env: NodeJS.ProcessEnv = { ...rawEnv };
  for (const key of SCRUBBED_KEYS) delete env[key];

  // FR-001: stream-json instead of text; partial messages for per-token liveness.
  // --include-hook-events is not passed: steps run --restricted and hooks never load.
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    ...(model ? ["--model", model] : []),
    ...(maxBudgetUsd !== undefined ? ["--max-budget-usd", String(maxBudgetUsd)] : []),
    ...(jsonSchema !== undefined ? ["--json-schema", JSON.stringify(jsonSchema)] : []),
    ...extraArgs,
  ];

  const stallMs = _stallSilenceMs ?? STALL_SILENCE_MS;
  const start = Date.now();

  return new Promise((resolve, reject) => {
    const child = spawnFn("claude", args, { env, cwd });

    let stdoutRaw = ""; // Full stdout accumulation for final parse
    let lineBuffer = ""; // Partial last-line buffer for live processing
    let rawTail = ""; // Last ~500 chars for error messages
    let stderr = "";

    // ── Watchdog state ────────────────────────────────────────────────────────
    let watchdogTrip: WatchdogTrip | null = null;
    const loopDetector = makeLoopDetector();

    // ── Stall timer ───────────────────────────────────────────────────────────
    let stallTimer: ReturnType<typeof setTimeout> | null = null;

    function clearStallTimer() {
      if (stallTimer !== null) {
        clearTimeout(stallTimer);
        stallTimer = null;
      }
    }

    function tripWatchdog(trip: WatchdogTrip) {
      if (watchdogTrip) return; // already tripped
      watchdogTrip = trip;
      emitStepEvent(onEvent, {
        kind: "watchdog",
        pathology: trip.pathology,
        detail: trip.detail,
        attempt: opts.attempt ?? 1,
      });
      child.kill("SIGTERM");
      const esc = setTimeout(() => child.kill("SIGKILL"), WATCHDOG_KILL_ESCALATION_MS);
      // Unref so the escalation timer does not prevent process exit if the promise resolves.
      if (typeof (esc as { unref?: () => void }).unref === "function") {
        (esc as { unref: () => void }).unref();
      }
    }

    function resetStallTimer() {
      clearStallTimer();
      stallTimer = setTimeout(() => {
        const detail = `no stdout for ${stallMs}ms`;
        tripWatchdog(new WatchdogTrip("stall", detail, buildDigest(loopDetector.getPairs())));
      }, stallMs);
    }

    resetStallTimer();

    // ── Stdout handler ────────────────────────────────────────────────────────
    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stdoutRaw += text;
      rawTail = (rawTail + text).slice(-500);

      // Any byte on stdout = process is alive: reset the stall timer (FR-002).
      resetStallTimer();

      // Line-buffer for live loop detection (FR-003)
      lineBuffer += text;
      const newlineIdx = lineBuffer.lastIndexOf("\n");
      if (newlineIdx === -1) return;
      const completeLines = lineBuffer.slice(0, newlineIdx + 1);
      lineBuffer = lineBuffer.slice(newlineIdx + 1);

      for (const line of completeLines.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        // Parsed once and handed to both consumers: the loop detector needs the
        // tool_use blocks, the log needs every mapped kind, and a second
        // JSON.parse per line would double the cost of a long stream.
        const event = parseStreamLine(trimmed);
        if (event === undefined) continue;
        processLineForLoopDetection(event);
        for (const logEvent of claudeEventToEvents(event)) emitStepEvent(onEvent, logEvent);
      }
    });

    function processLineForLoopDetection(event: Record<string, unknown>) {
      if (event.type !== "assistant") return;

      // Extract complete tool_use blocks from assistant messages
      const msg = event.message as
        | {
            content?: {
              type: string;
              name?: string;
              input?: unknown;
              parent_tool_use_id?: string | null;
            }[];
          }
        | undefined;
      const content = msg?.content ?? [];
      for (const block of content) {
        if (
          block.type === "tool_use" &&
          block.name != null &&
          block.input != null &&
          // Defensively exclude subagent-tagged messages (parent_tool_use_id non-null)
          (block.parent_tool_use_id == null || block.parent_tool_use_id === undefined)
        ) {
          const pair: ToolPair = {
            name: String(block.name),
            input: canonicalJson(block.input),
          };
          const trip = loopDetector.add(pair);
          if (trip && !watchdogTrip) {
            tripWatchdog(
              new WatchdogTrip("loop", trip.detail, buildDigest(loopDetector.getPairs()))
            );
          }
        }
      }
    }

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    // Deliver prompt via stdin so it never appears in process argv listings.
    child.stdin.write(prompt);
    child.stdin.end();

    const onAbort = () => {
      child.kill("SIGTERM");
    };

    child.on("error", (err) => {
      clearStallTimer();
      if (signal) signal.removeEventListener("abort", onAbort);
      // A child that never started says nothing about the prompt.
      reject(
        new TransportFailureError(`claude: spawn error: ${err.message}`, {
          transport: CLAUDE_TRANSPORT,
          cause: err,
        })
      );
    });

    child.on("close", (code) => {
      clearStallTimer();
      if (signal) signal.removeEventListener("abort", onAbort);

      const durationMs = Date.now() - start;

      // Operator cancel takes priority over watchdog trip
      if (signal?.aborted) {
        reject(new DOMException("Claude CLI aborted", "AbortError"));
        return;
      }

      // Watchdog trip: reject with the trip so runLlmStep can handle retry
      if (watchdogTrip) {
        reject(watchdogTrip);
        return;
      }

      const exitCode = code ?? -1;
      if (exitCode !== 0) {
        const tail = stderr.slice(-500);
        // A CLI that fails after emitting a result event carries the reason there
        // (a session limit, a refusal), not on stderr — losing it leaves the
        // operator with a bare exit code.
        const failure = findResultEvent(stdoutRaw);
        const why =
          failure === null
            ? ""
            : ` (subtype: ${String(failure.subtype ?? "error")}): ${String(
                failure.result ?? ""
              ).slice(0, 300)}`;
        reject(
          new TransportFailureError(`claude exited with code ${exitCode}${why}\nstderr: ${tail}`, {
            transport: CLAUDE_TRANSPORT,
            exitCode,
            ...(failure?.subtype !== undefined ? { subtype: String(failure.subtype) } : {}),
          })
        );
        return;
      }

      // Scan entire stream for the result event (FR-001: not positional, not last-line)
      const resultEvent = findResultEvent(stdoutRaw);

      if (!resultEvent) {
        reject(
          new TransportFailureError(
            `claude: no result event found in stream output.\nRaw stdout tail:\n${rawTail}`,
            { transport: CLAUDE_TRANSPORT, exitCode }
          )
        );
        return;
      }

      // Budget exceeded (FR-007)
      if (resultEvent.subtype === "error_max_budget_usd") {
        reject(new StepBudgetExceededError(maxBudgetUsd ?? 0, resultEvent.total_cost_usd ?? 0));
        return;
      }

      // Other error subtypes
      if (resultEvent.is_error || resultEvent.subtype !== "success") {
        const subtype = String(resultEvent.subtype ?? "error");
        const text = String(resultEvent.result ?? "");
        reject(
          new TransportFailureError(`claude: result subtype "${subtype}": ${text.slice(0, 300)}`, {
            transport: CLAUDE_TRANSPORT,
            exitCode,
            subtype,
          })
        );
        return;
      }

      const stdout = String(resultEvent.result ?? "");

      // claude exits 0 even for unrecognized models, embedding the error in result text.
      if (stdout.includes("[claude-code:unrecognized_model]")) {
        // A model alias the locally installed CLI does not know is a per-provider
        // problem, so it is the best failover candidate there is — it must carry
        // the transport type rather than reading as a request error.
        reject(
          new TransportFailureError(
            `claude CLI rejected model ${JSON.stringify(model ?? "(default)")}: ${stdout.trim().slice(0, 300)}`,
            { transport: CLAUDE_TRANSPORT, exitCode, subtype: UNRECOGNIZED_MODEL_SUBTYPE }
          )
        );
        return;
      }

      resolve({
        stdout,
        stderr,
        exitCode,
        durationMs,
        totalCostUsd: resultEvent.total_cost_usd,
        numTurns: resultEvent.num_turns,
      });
    });

    if (signal) {
      if (signal.aborted) {
        clearStallTimer();
        child.kill("SIGTERM");
        reject(new DOMException("Claude CLI aborted before start", "AbortError"));
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}
