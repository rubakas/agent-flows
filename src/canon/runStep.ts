// Provider-agnostic step executor for Binding B.

import { spawn as defaultSpawn } from "node:child_process";
import { statSync } from "node:fs";
import { runClaudeCli } from "./runClaudeCli.js";
import type { ModelEntry } from "./registry.js";
import type { SpawnFn } from "./runClaudeCli.js";

export type { SpawnFn } from "./runClaudeCli.js";

/**
 * Built-in deadline applied to every step when neither the step nor its pipeline
 * declares a timeout. 10 minutes: generous enough for a reasoner-role step on a
 * large prompt, short enough that a wedged CLI does not hold a daemon slot for a
 * working day. Override at the step level (timeoutMs) or pipeline level
 * (defaultTimeoutMs). Set either to 0 to remove the deadline entirely.
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

export interface StepRunnerDeps {
  spawn?: SpawnFn;
  fetchFn?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
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
   * Absolute path to the project workspace root. Supplied by the caller; required
   * when workspaceAccess is set. Defaults to process.cwd() when absent and
   * workspaceAccess is "read".
   */
  workspaceDir?: string;
  /**
   * When "read", the spawned CLI agent runs with cwd=workspaceDir and is restricted
   * to read-only file access via the CLI sandbox flag (--allowedTools for claude,
   * the existing -s read-only for codex). Not supported for api transport — will
   * throw at runtime because sandbox enforcement requires a CLI subprocess.
   */
  workspaceAccess?: "read";
}

// ── Deadline helper ───────────────────────────────────────────────────────────

interface DeadlineHandle {
  signal: AbortSignal;
  cancel: () => void;
  timeoutMs: number;
}

/**
 * Returns an AbortSignal that fires after timeoutMs milliseconds.
 * Any parent signal abort is propagated into the returned signal.
 * Call cancel() — invoked from runLlmStep's finally block — to clear the timer
 * the moment the step resolves or rejects, preventing the timer from keeping
 * the process alive after the step is done.
 */
function createDeadline(timeoutMs: number, parentSignal?: AbortSignal): DeadlineHandle {
  const controller = new AbortController();

  const timer = setTimeout(() => {
    controller.abort(new DOMException(`Step timed out after ${timeoutMs}ms`, "TimeoutError"));
  }, timeoutMs);

  // cancel() is called in runLlmStep's finally block to remove the timer the moment
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

// ── codex exec JSON event shape ───────────────────────────────────────────────

interface CodexItemCompleted {
  type: "item.completed";
  item: { type: string; text?: string };
}

function isItemCompleted(line: string): CodexItemCompleted | null {
  try {
    const obj = JSON.parse(line) as { type?: string; item?: { type?: string; text?: string } };
    if (obj.type === "item.completed" && obj.item?.type === "agent_message") {
      return obj as CodexItemCompleted;
    }
  } catch {
    // non-JSON line (header noise) — skip
  }
  return null;
}

function extractCodexAnswer(stdout: string): string {
  let last: string | undefined;
  for (const line of stdout.split("\n")) {
    const ev = isItemCompleted(line.trim());
    if (ev?.item.text !== undefined) last = ev.item.text;
  }
  if (last === undefined) {
    throw new Error(
      `codex exec: no agent_message found in output.\nRaw stdout (last 500 chars):\n${stdout.slice(-500)}`
    );
  }
  return last;
}

// ── API transport (OpenAI chat-completions compatible) ────────────────────────

interface ChatCompletion {
  choices: { message: { content: string | null } }[];
}

async function runApiStep(
  entry: ModelEntry,
  prompt: string,
  deps: StepRunnerDeps,
  signal: AbortSignal | undefined
): Promise<string> {
  const endpoint = entry.api!.endpoint;
  const model = entry.api!.model;
  const keyEnv = entry.api!.keyEnv;
  const env = deps.env ?? process.env;
  const fetchFn = deps.fetchFn ?? fetch;

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (keyEnv) {
    const key = env[keyEnv];
    if (key) headers.Authorization = `Bearer ${key}`;
  }

  const body = JSON.stringify({
    model,
    messages: [{ role: "user", content: prompt }],
  });

  let res: Response;
  try {
    res = await fetchFn(endpoint, { method: "POST", headers, body, signal });
  } catch (err) {
    throw new Error(`api step: fetch failed for ${endpoint}: ${String(err)}`, { cause: err });
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "(unreadable)");
    throw new Error(`api step: ${endpoint} returned ${res.status}: ${text.slice(0, 300)}`);
  }

  let json: ChatCompletion;
  try {
    json = (await res.json()) as ChatCompletion;
  } catch {
    throw new Error(`api step: response from ${endpoint} is not valid JSON`);
  }

  const content = json.choices?.[0]?.message?.content;
  if (typeof content !== "string") {
    throw new Error(`api step: missing choices[0].message.content in response from ${endpoint}`);
  }
  return content;
}

// ── codex CLI transport ───────────────────────────────────────────────────────

function runCodexCli(
  prompt: string,
  model: string | undefined,
  deps: StepRunnerDeps,
  signal: AbortSignal | undefined,
  cwd?: string
): Promise<string> {
  const spawnFn = deps.spawn ?? defaultSpawn;
  const env = deps.env ?? process.env;

  const args = [
    "exec",
    "--ephemeral",
    "--json",
    "-s",
    "read-only",
    ...(model ? ["-m", model] : []),
  ];

  return new Promise((resolve, reject) => {
    const child = spawnFn("codex", args, { env, ...(cwd !== undefined ? { cwd } : {}) });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.stdin.write(prompt);
    child.stdin.end();

    child.on("error", (err) => {
      reject(new Error(`codex exec: spawn error: ${err.message}`));
    });

    child.on("close", (code) => {
      // codex exits non-zero on auth/model errors but also emits JSON events; try parse first.
      try {
        resolve(extractCodexAnswer(stdout));
      } catch {
        const tail = stderr.slice(-400);
        reject(
          new Error(
            `codex exec: exit ${code ?? -1}; no agent_message found.\nstderr: ${tail}\nstdout: ${stdout.slice(-400)}`
          )
        );
      }
    });

    if (signal) {
      if (signal.aborted) {
        child.kill("SIGTERM");
        reject(new DOMException("codex exec aborted before start", "AbortError"));
        return;
      }
      signal.addEventListener("abort", () => child.kill("SIGTERM"), { once: true });
    }
  });
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function runLlmStep(
  entry: ModelEntry,
  prompt: string,
  deps: StepRunnerDeps = {}
): Promise<string> {
  // Validate and resolve workspace access before creating any deadline.
  // Fail fast on configuration errors rather than timing out or running silently
  // against the wrong directory.
  let resolvedWorkspaceDir: string | undefined;
  if (deps.workspaceAccess === "read") {
    if (entry.transport === "api") {
      throw new Error(
        `runLlmStep: workspace "read" is not supported for api transport — ` +
          `sandbox enforcement requires a CLI subprocess; api transport has no equivalent`
      );
    }
    const dir = deps.workspaceDir ?? process.cwd();
    let isDir = false;
    try {
      isDir = statSync(dir).isDirectory();
    } catch {
      // ENOENT or other fs error — isDir stays false
    }
    if (!isDir) {
      throw new Error(
        `runLlmStep: workspace "read" declared but workspaceDir "${dir}" is not a valid directory`
      );
    }
    resolvedWorkspaceDir = dir;
  }

  // Precedence: step-level > pipeline-level > built-in constant.
  // A value of 0 at any level is the explicit escape hatch: no deadline is created.
  const effectiveTimeoutMs =
    deps.timeoutMs ?? deps.defaultTimeoutMs ?? deps._builtInTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;

  let deadline: DeadlineHandle | undefined;
  let effectiveSignal: AbortSignal | undefined = deps.signal;

  if (effectiveTimeoutMs > 0) {
    deadline = createDeadline(effectiveTimeoutMs, deps.signal);
    effectiveSignal = deadline.signal;
  }

  try {
    if (entry.transport === "cli") {
      const bin = entry.cli?.bin ?? "claude";

      if (bin === "claude") {
        const extraArgs: string[] = [];
        if (resolvedWorkspaceDir !== undefined) {
          // Restrict to read-only tools: Read (read file contents) and Glob (find files).
          // This is the real mechanism from `claude --help --allowedTools`.
          // Edit, Write, and Bash are not in the allowlist and are therefore denied.
          extraArgs.push("--allowedTools", "Read,Glob");
        }
        const result = await runClaudeCli(
          prompt,
          {
            model: entry.cli?.model,
            signal: effectiveSignal,
            cwd: resolvedWorkspaceDir,
            extraArgs,
          },
          deps
        );
        return result.stdout.trim();
      }

      if (bin === "codex") {
        // codex already spawns with -s read-only unconditionally; workspace: "read"
        // adds the cwd so the sandbox is rooted at the project directory.
        return await runCodexCli(
          prompt,
          entry.cli?.model,
          deps,
          effectiveSignal,
          resolvedWorkspaceDir
        );
      }

      throw new Error(`runLlmStep: unknown cli bin "${String(bin)}"`);
    }

    if (entry.transport === "api") {
      return await runApiStep(entry, prompt, deps, effectiveSignal);
    }

    throw new Error(`runLlmStep: unknown transport "${String(entry.transport)}"`);
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
