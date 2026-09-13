// Provider-agnostic step executor for Binding B.

import { spawn as defaultSpawn } from "node:child_process";
import { DEFAULT_ADAPTER_CONFIG, adapterFor } from "./adapters/index.js";
import { DEFAULT_STEP_TIMEOUT_MS, createDeadline } from "./stepRuntime.js";
import type { ModelEntry } from "./registry.js";
import type { DeadlineHandle, StepRunnerDeps } from "./stepRuntime.js";

// Re-exported so existing importers keep a single entry point for the executor's
// vocabulary after the spec-031 extraction.
export type { SpawnFn } from "./runClaudeCli.js";
export {
  BUILD_CONFIG_DENY_PATTERNS,
  CREDENTIAL_DENY_PATTERNS,
  operatorDenyRules,
} from "./denyPatterns.js";
export { DEFAULT_STEP_TIMEOUT_MS, StepTimeoutError, StepWatchdogError } from "./stepRuntime.js";
export type { StepRunnerDeps } from "./stepRuntime.js";
export { WATCHDOG_DIGEST_CLOSE, WATCHDOG_DIGEST_OPEN } from "./adapters/index.js";

/**
 * Base set of environment variable names that every check step receives from the
 * parent process without needing an explicit declaration. These are standard
 * OS-level variables required by virtually any shell command; withholding them
 * would break basic toolchain operations.
 *
 * Determined empirically: `pnpm test` succeeds under `env -i PATH HOME TMPDIR
 * SHELL LANG` on macOS and Linux. The additional variables below are
 * widely expected by build tools and are safe to forward unconditionally because
 * they carry no credentials.
 *
 * Any variable not in this set must be declared on the step via `StepDef.env`.
 * A step that needs `GH_TOKEN` must declare `env: [GH_TOKEN]`.
 */
export const CHECK_ENV_ALLOWLIST: ReadonlySet<string> = new Set([
  // Core: required for any shell command to function
  "PATH",
  "HOME",
  "SHELL",
  "TMPDIR",
  // Locale: affects output encoding of many CLI tools
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  // Terminal: used by interactive-mode detection in some CLIs
  "TERM",
  // User identity: used by git (falls back to HOME/.gitconfig when names absent)
  "USER",
  "LOGNAME",
  // CI detection: read by test reporters and build tools
  "CI",
  // Node / pnpm toolchain:
  // PATH and HOME cover pnpm's binary discovery and store location in practice
  // (verified empirically above). NODE_OPTIONS and PNPM_HOME are included as
  // safety valves for steps that pass node flags or use a non-standard pnpm store.
  "NODE_OPTIONS",
  "PNPM_HOME",
]);

// ── Shared env helpers ────────────────────────────────────────────────────────

/**
 * Builds the child environment for a check step from the base allowlist plus
 * any per-step declared variable names. Variables not in either set are stripped.
 *
 * This is the allowlist replacement for the old `scrubEnv()` denylist. The old
 * approach removed only the three SCRUBBED_KEYS, allowing any other credential
 * (GH_TOKEN, LITELLM_MASTER_KEY, DATABASE_URL, etc.) to reach `/bin/sh -c`.
 * An allowlist closes that class of leak by default: a variable is absent unless
 * it is explicitly named.
 */
function buildCheckEnv(
  rawEnv: NodeJS.ProcessEnv,
  extraAllowed: readonly string[]
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of [...CHECK_ENV_ALLOWLIST, ...extraAllowed]) {
    const val = rawEnv[key];
    if (val !== undefined) env[key] = val;
  }
  return env;
}

// ── Check step runner ─────────────────────────────────────────────────────────

/** Maximum combined stdout+stderr retained in CheckResult.output (64 KB). */
export const CHECK_OUTPUT_CAP = 65_536;

/** Milliseconds between SIGTERM and SIGKILL when a check step is aborted. */
const CHECK_KILL_ESCALATION_MS = 3_000;

/** Returned by runCheckStep. `passed` is `exitCode === 0`. */
export interface CheckResult {
  passed: boolean;
  exitCode: number;
  output: string;
}

/**
 * Runs `command` via `/bin/sh -c` and returns a CheckResult. Never throws:
 * a non-zero exit is `passed: false`, a timeout is also `passed: false` with
 * the reason stated in `output`.
 *
 * Reuses: DEFAULT_STEP_TIMEOUT_MS, createDeadline, StepRunnerDeps, defaultSpawn.
 */
export async function runCheckStep(
  command: string,
  deps: StepRunnerDeps & { cwd?: string } = {}
): Promise<CheckResult> {
  const effectiveTimeoutMs =
    deps.timeoutMs ?? deps.defaultTimeoutMs ?? deps._builtInTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;

  let deadline: DeadlineHandle | undefined;
  if (effectiveTimeoutMs > 0) {
    deadline = createDeadline(effectiveTimeoutMs, deps.signal);
  }

  const spawnFn = deps.spawn ?? defaultSpawn;
  const env = buildCheckEnv(deps.env ?? process.env, deps.envAllowlist ?? []);

  const cwd = deps.cwd ?? process.cwd();

  // FR-014: without a deadline the step is still cancellable — the kill listener
  // attaches to deps.signal directly. Before spec 033 deps.signal was discarded
  // whenever effectiveTimeoutMs was non-positive.
  const abortSignal = deadline?.signal ?? deps.signal;

  return new Promise<CheckResult>((resolve) => {
    // FR-015: detached makes the shell a process-group leader so a forked
    // grandchild (`sleep 30 & wait`) dies with it instead of outliving the run.
    const child = spawnFn("/bin/sh", ["-c", command], { env, cwd, detached: true });

    // No stdin is needed; close it immediately so commands that read stdin don't hang.
    child.stdin.end();

    let combined = "";

    const append = (data: string) => {
      combined += data;
      // Keep only the last CHECK_OUTPUT_CAP chars to bound memory and context size.
      if (combined.length > CHECK_OUTPUT_CAP) {
        combined = combined.slice(combined.length - CHECK_OUTPUT_CAP);
      }
    };

    child.stdout.on("data", (chunk: Buffer) => append(chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => append(chunk.toString()));

    child.on("error", (err) => {
      deadline?.cancel();
      resolve({ passed: false, exitCode: -1, output: `spawn error: ${err.message}` });
    });

    child.on("close", (code) => {
      deadline?.cancel();
      if (abortSignal?.aborted) {
        const reason = abortSignal.reason as { name?: string } | undefined;
        const msg =
          reason?.name === "TimeoutError"
            ? `Step timed out after ${effectiveTimeoutMs}ms`
            : "Step was cancelled";
        resolve({ passed: false, exitCode: -1, output: msg });
        return;
      }
      const exitCode = code ?? -1;
      resolve({ passed: exitCode === 0, exitCode, output: combined });
    });

    // FR-015: signal the whole process group so forked grandchildren die too.
    // Falls back to the child alone when the pid is gone or the group no longer
    // exists (ESRCH), which is the normal race against an exiting child.
    const killTree = (signal: "SIGTERM" | "SIGKILL") => {
      const pid = child.pid;
      if (pid !== undefined) {
        try {
          process.kill(-pid, signal);
          return;
        } catch {
          // fall through to the direct kill below
        }
      }
      child.kill(signal);
    };

    if (abortSignal) {
      const onAbort = () => {
        killTree("SIGTERM");
        // Escalate to SIGKILL after a grace period; unref so the timer does not
        // prevent the process from exiting once the promise resolves.
        const esc = setTimeout(() => killTree("SIGKILL"), CHECK_KILL_ESCALATION_MS);
        if (typeof (esc as { unref?: () => void }).unref === "function") {
          (esc as { unref: () => void }).unref();
        }
      };
      if (abortSignal.aborted) {
        onAbort();
      } else {
        abortSignal.addEventListener("abort", onAbort, { once: true });
      }
    }
  });
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Executes one llm step by dispatching to the adapter for its transport (FR-001).
 * Supervision — the deadline, the StepTimeoutError mapping, the claude watchdog
 * and its reformulation retry — lives inside each adapter's run(), so no caller
 * can construct an unsupervised call (FR-002).
 */
export function runLlmStep(
  entry: ModelEntry,
  prompt: string,
  deps: StepRunnerDeps = {}
): Promise<string> {
  return adapterFor(entry).run(prompt, entry, deps, DEFAULT_ADAPTER_CONFIG);
}
