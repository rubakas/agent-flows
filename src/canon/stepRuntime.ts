// Supervision primitives and runner deps shared by runStep.ts and every provider adapter.
//
// Extracted from runStep.ts (spec 031 D1) so `adapters/*` can supervise their own
// child processes without importing runStep.ts, which imports the adapters.

import { statSync } from "node:fs";
import type { SpawnFn, WatchdogTrip } from "./runClaudeCli.js";
import type { StepEventSink } from "./stepLogEvents.js";

/**
 * Built-in deadline applied when neither the step nor its pipeline declares a
 * timeout. Applies to: check steps, api-transport llm steps, codex-transport llm
 * steps. Claude-transport llm steps use the progress watchdog instead and have
 * no built-in duration limit — use timeoutMs/defaultTimeoutMs for an explicit cap.
 *
 * 10 minutes: generous for a reasoner on a large prompt; short enough that a
 * wedged non-streaming process does not hold a daemon slot for a working day.
 * Override at the step level (timeoutMs) or pipeline level (defaultTimeoutMs).
 * Set either to 0 to remove the deadline entirely.
 */
export const DEFAULT_STEP_TIMEOUT_MS = 600_000;

/** Thrown when a step's deadline fires before the transport completes. */
export class StepTimeoutError extends Error {
  readonly timeoutMs: number;
  constructor(timeoutMs: number) {
    super(`Step timed out after ${timeoutMs}ms`);
    this.name = "StepTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Thrown when the progress watchdog interrupts a claude-transport llm step on
 * both attempts (stall or loop on attempt 1, any pathology on attempt 2), or
 * when attempt 2 returns a BLOCKED: report (FR-006).
 */
export class StepWatchdogError extends Error {
  readonly trips: WatchdogTrip[];
  constructor(trips: WatchdogTrip[]) {
    const desc = trips.map((t) => `${t.pathology}: ${t.detail}`).join("; ");
    super(`Step interrupted by watchdog after ${trips.length} attempts (${desc})`);
    this.name = "StepWatchdogError";
    this.trips = trips;
  }
}

export interface StepRunnerDeps {
  spawn?: SpawnFn;
  fetchFn?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  /** Receives provider-neutral inner step events; optional (spec 036 D2). */
  onEvent?: StepEventSink;
  /**
   * Per-step deadline in milliseconds. Takes precedence over defaultTimeoutMs.
   * Set to 0 to disable the deadline for this step (explicit escape hatch).
   */
  timeoutMs?: number;
  /** Pipeline-level fallback deadline, used when timeoutMs is absent. */
  defaultTimeoutMs?: number;
  /**
   * @internal Override DEFAULT_STEP_TIMEOUT_MS in tests so the built-in path
   * can be exercised without waiting 10 minutes.
   */
  _builtInTimeoutMs?: number;
  /**
   * @internal Override STALL_SILENCE_MS in tests so the stall detector can be
   * exercised without waiting 15 minutes.
   */
  _stallSilenceMs?: number;
  /**
   * Per-step cost cap for claude-transport llm steps (FR-007). Passed as
   * --max-budget-usd to the CLI. No default; absent → flag is not emitted.
   * Overrides any pipeline-level defaultMaxBudgetUsd (resolved in buildSteps.ts).
   * Rejected at runtime on api/codex transports.
   */
  maxBudgetUsd?: number;
  /**
   * Absolute path to the project workspace root. Supplied by the caller; required
   * when contentsAccess is set. Defaults to process.cwd() when absent and
   * contentsAccess is "read".
   */
  workspaceDir?: string;
  /**
   * Named Agent Skills to make available to this step's agent. Requires claude CLI
   * transport. The runtime adds `Skill` to the granted tool set and passes `--plugin-dir`
   * pointing to the skills directory so the named skills are resolvable under `--restricted`.
   * Skills grant instructions, not permissions — file access still requires `permissions`.
   * The directory is read from the `AGENT_FLOWS_SKILLS_DIR` env var; defaults to `$HOME/.claude`.
   */
  skills?: string[];
  /**
   * Restricts the claude CLI to a specific tool set when accessing the repo.
   * Maps from the canon's `permissions.contents` scope value.
   *
   * Both modes add `--restricted --strict-mcp-config` so the target repository's
   * own `.claude/settings.json` (and any MCP server it declares) cannot widen
   * the granted tool set. `--restricted` is a vendor-supported flag that ignores
   * user/project/local settings files and confines file tools to the working
   * directory. `--strict-mcp-config` extends that guarantee to MCP servers.
   *
   * The direction matters, and it is asymmetric. Settings can never WIDEN the grant:
   * `--restricted` ignores user/project/local settings files, so nothing a repo (or the
   * operator) writes there can add a tool or re-open a denied path. But the CLI ignores
   * them in BOTH directions, so an operator `permissions.deny` rule that blocks a plain
   * `claude -p` read is silently dropped here too (verified as F9 in
   * docs/research/2026-09-06-workflow-security-prompt-injection.md). That half is not
   * acceptable, so operatorDenyRules() re-applies the operator's USER-level
   * `permissions.deny` entries through `--disallowedTools` — they can still NARROW the
   * grant. `permissions.allow` is never read from settings, and the target repo's own
   * settings are never read at all. CREDENTIAL_DENY_PATTERNS remains self-sufficient
   * rather than a supplement to any settings file.
   *
   * - "read": grants Read, Glob and Grep only
   *   (`--tools Read,Glob,Grep --allowedTools Read,Glob,Grep`).
   *   The agent can inspect and search the project but cannot modify any file.
   * - "write": adds Edit and Write (`--tools Read,Glob,Grep,Edit,Write`). Bash is never
   *   granted in either mode.
   *
   * Not supported for api transport or codex (both will throw at runtime).
   */
  contentsAccess?: "read" | "write";
  /**
   * Additional deny patterns for this step only, prepended to the project defaults.
   * Plain path globs (not vendor rule strings). Applied as both Read and Edit
   * denials (same as CREDENTIAL_DENY_PATTERNS).
   *
   * Only meaningful when `contentsAccess` is set (validated at canon load time).
   */
  denyPatterns?: string[];
  /**
   * Per-step extension to `CHECK_ENV_ALLOWLIST` for `runCheckStep`. Names the
   * additional environment variable names (beyond the base allowlist) that the
   * check step's shell command may receive. Corresponds to `StepDef.env`.
   *
   * Any variable not in `CHECK_ENV_ALLOWLIST` and not listed here is stripped before
   * `/bin/sh -c` is invoked. Only meaningful in `runCheckStep`; ignored by `runLlmStep`.
   */
  envAllowlist?: string[];
}

// ── Deadline helper ───────────────────────────────────────────────────────────

export interface DeadlineHandle {
  signal: AbortSignal;
  cancel: () => void;
  timeoutMs: number;
}

/**
 * Returns an AbortSignal that fires after timeoutMs milliseconds.
 * Any parent signal abort is propagated into the returned signal.
 * Call cancel() — invoked from the caller's finally block — to clear the timer
 * the moment the step resolves or rejects, preventing the timer from keeping
 * the process alive after the step is done.
 */
export function createDeadline(timeoutMs: number, parentSignal?: AbortSignal): DeadlineHandle {
  const controller = new AbortController();

  const timer = setTimeout(() => {
    controller.abort(new DOMException(`Step timed out after ${timeoutMs}ms`, "TimeoutError"));
  }, timeoutMs);

  // cancel() is called in the caller's finally block to remove the timer the moment
  // the step resolves or rejects. This prevents the timer from keeping the process
  // alive after the step is done — the classic leak in this pattern.
  const cancel = () => clearTimeout(timer);

  if (parentSignal) {
    if (parentSignal.aborted) {
      clearTimeout(timer);
      controller.abort(parentSignal.reason);
    } else {
      parentSignal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          controller.abort(parentSignal.reason);
        },
        { once: true }
      );
    }
  }

  return { signal: controller.signal, cancel, timeoutMs };
}

/**
 * Runs `body` under the step's deadline and maps a fired deadline onto
 * StepTimeoutError. Every adapter routes its transport call through this, so a
 * caller cannot construct an unsupervised adapter call (FR-002).
 *
 * `builtInFallbackMs` is the transport's own fallback when neither the step nor
 * the pipeline declares a timeout, and doubles as the declaration of whether the
 * transport supervises itself: 0 means it does (claude's progress watchdog),
 * DEFAULT_STEP_TIMEOUT_MS means it does not (no live event stream to watch).
 *
 * A non-positive timeout is therefore an escape hatch only where something else
 * is still watching. On codex and api it would mean no supervision at all — a
 * hung child would run forever and the adapter's `finally` (which removes the
 * sanitized copy) would never fire — so it is clamped back to the transport's
 * own fallback. The loader also rejects a non-positive `timeoutMs`, making this
 * the second of two layers rather than the only one.
 */
export async function withDeadline<T>(
  deps: StepRunnerDeps,
  builtInFallbackMs: number,
  body: (signal: AbortSignal | undefined) => Promise<T>
): Promise<T> {
  const requestedTimeoutMs =
    deps.timeoutMs ?? deps.defaultTimeoutMs ?? deps._builtInTimeoutMs ?? builtInFallbackMs;
  // `_builtInTimeoutMs` is the test seam for the fallback, so the clamp honours it.
  const transportFallbackMs = deps._builtInTimeoutMs ?? builtInFallbackMs;
  const effectiveTimeoutMs = requestedTimeoutMs > 0 ? requestedTimeoutMs : transportFallbackMs;

  let deadline: DeadlineHandle | undefined;
  let effectiveSignal: AbortSignal | undefined = deps.signal;

  if (effectiveTimeoutMs > 0) {
    deadline = createDeadline(effectiveTimeoutMs, deps.signal);
    effectiveSignal = deadline.signal;
  }

  try {
    return await body(effectiveSignal);
  } catch (err) {
    if (deadline?.signal.aborted) {
      const reason = deadline.signal.reason as { name?: string } | undefined;
      if (reason?.name === "TimeoutError") {
        throw new StepTimeoutError(deadline.timeoutMs);
      }
    }
    throw err;
  } finally {
    deadline?.cancel();
  }
}

// ── Workspace resolution ──────────────────────────────────────────────────────

/**
 * Validates and resolves repo access before any deadline is created, so a
 * configuration error fails fast rather than timing out or running silently
 * against the wrong directory. Returns undefined when the step declares no
 * workspace access.
 */
export function resolveWorkspaceDir(deps: StepRunnerDeps): string | undefined {
  if (deps.contentsAccess !== "read" && deps.contentsAccess !== "write") return undefined;

  const dir = deps.workspaceDir ?? process.cwd();
  let isDir = false;
  try {
    isDir = statSync(dir).isDirectory();
  } catch {
    // ENOENT or other fs error — isDir stays false
  }
  if (!isDir) {
    throw new Error(
      `runLlmStep: permissions.contents "${deps.contentsAccess}" declared but workspaceDir "${dir}" is not a valid directory`
    );
  }
  return dir;
}
