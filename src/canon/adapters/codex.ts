// Codex CLI adapter (spec 031 D1/D2).
//
// codex is always confined; the grant is the sanitized copy or an empty dir.
// `-s` is never emitted: probe 2026-09-13 (codex-cli 0.152.1) showed
// `-s read-only` constrains writes and network only, leaving every readable path
// readable, and the vendor docs forbid combining `sandbox_mode` with
// `default_permissions`. Confinement is the composed `agent_flows` permission
// profile (codexConfinementArgs) plus a single `read` grant on the directory the
// step runs in — the sanitized copy for a `contents: read` step, a fresh empty
// directory for a text-only step, so neither can read the real disk.
//
// `--ignore-user-config` is passed so the operator's own `~/.codex/config.toml`
// cannot re-open what the profile closes. Probed 2026-09-13 on codex-cli
// 0.152.1: subscription auth still succeeds with the flag (exit 0), and `-c`
// overrides are still parsed and enforced under it (a `-c` naming an undefined
// profile fails identically with and without the flag), so the composed
// confinement is not silently dropped.

import { spawn as defaultSpawn } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emitStepEvent } from "../stepLogEvents.js";
import { DEFAULT_STEP_TIMEOUT_MS, resolveWorkspaceDir, withDeadline } from "../stepRuntime.js";
import { codexConfinementArgs } from "../workspace/codexProfile.js";
import { materializeSanitizedWorkspace, sweepStaleWorkspaces } from "../workspace/sanitize.js";
import { DEFAULT_ADAPTER_CONFIG } from "./types.js";
import type { ModelEntry } from "../registry.js";
import type { StepLogEventInput } from "../stepLogEvents.js";
import type { StepRunnerDeps } from "../stepRuntime.js";
import type { AdapterCapabilities, AdapterConfig, ProviderAdapter } from "./types.js";
import type { SanitizedWorkspace } from "../workspace/sanitize.js";

// ── Child environment ─────────────────────────────────────────────────────────

/**
 * Environment variable names the codex child receives. An allowlist, for the
 * same reason `runCheckStep` switched to one: codex grants its agent a shell
 * tool, so a prompt-injected repository can run `env`, and a denylist that
 * removes three provider keys still hands over GH_TOKEN, AWS_*, NPM_TOKEN and
 * every other secret in the daemon's environment.
 *
 * Only what codex itself needs: PATH to find its own helpers, HOME so
 * `~/.codex` auth resolves, TMPDIR for its scratch files, the locale/terminal
 * variables that shape its output, the identity variables git reads, and
 * CODEX_HOME for a non-default config location. Names beyond this set must be
 * added deliberately, not inherited.
 */
export const CODEX_ENV_ALLOWLIST: ReadonlySet<string> = new Set([
  "PATH",
  "HOME",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "TERM",
  "SHELL",
  "USER",
  "LOGNAME",
  "CODEX_HOME",
]);

/** Project variables are forwarded by prefix so a step can read its own run context. */
const AGENT_FLOWS_PREFIX = "AGENT_FLOWS_";

/** Builds the codex child environment from the allowlist plus AGENT_FLOWS_* names. */
export function buildCodexEnv(rawEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(rawEnv)) {
    if (value === undefined) continue;
    if (CODEX_ENV_ALLOWLIST.has(key) || key.startsWith(AGENT_FLOWS_PREFIX)) {
      env[key] = value;
    }
  }
  return env;
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

// ── Stream event mapping (spec 036 D2) ────────────────────────────────────────

/** The item shapes seen in the captured fixtures (codex-cli 0.152.1). */
interface CodexItem {
  id?: string;
  type?: string;
  text?: string;
  command?: string;
  aggregated_output?: string;
  exit_code?: number | null;
  status?: string;
  changes?: { path: string; kind: string }[];
}

/**
 * Maps one `codex exec --json` line onto step log events. Item types absent
 * from the fixtures (`reasoning`, `mcp_tool_call`) are skipped until captured;
 * there is no raw passthrough. Exported for direct unit testing (spec 036 V2).
 */
export function codexStreamLineToEvents(line: string): StepLogEventInput[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return []; // non-JSON line (header noise) — skip
  }
  if (typeof parsed !== "object" || parsed === null) return [];
  const event = parsed as {
    type?: string;
    item?: CodexItem;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  const item = event.item;
  const callId = typeof item?.id === "string" ? { callId: item.id } : {};

  if (event.type === "item.started" && item?.type === "command_execution") {
    const input = { command: item.command };
    return [{ kind: "tool.call", ...callId, name: "command", input }];
  }
  if (event.type === "item.completed" && item?.type === "command_execution") {
    return [
      {
        kind: "tool.result",
        ...callId,
        ok: item.exit_code === 0,
        ...(item.aggregated_output !== undefined ? { excerpt: item.aggregated_output } : {}),
      },
    ];
  }
  if (event.type === "item.started" && item?.type === "file_change") {
    const input = { changes: item.changes };
    return [{ kind: "tool.call", ...callId, name: "file_change", input }];
  }
  if (event.type === "item.completed" && item?.type === "file_change") {
    return [{ kind: "tool.result", ...callId, ok: item.status === "completed" }];
  }
  if (event.type === "item.completed" && item?.type === "agent_message") {
    return [{ kind: "message", role: "assistant", text: item.text ?? "" }];
  }
  if (event.type === "turn.completed") {
    // Codex reports tokens only — no cost figure and no turn count.
    const usage = event.usage;
    const tokens =
      typeof usage?.input_tokens === "number" && typeof usage.output_tokens === "number"
        ? { usage: { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens } }
        : {};
    return [{ kind: "usage", ...tokens }];
  }
  return [];
}

/**
 * The exact argv every codex step is spawned with. Exported so the live
 * preflight test exercises this array rather than a hand-written copy of it —
 * a flag that only exists in the test proves nothing about the adapter.
 */
export function codexExecArgs(grantDir: string, model?: string): string[] {
  return [
    "exec",
    "--ephemeral",
    "--json",
    // The operator's own config must not be able to widen what the profile closes.
    "--ignore-user-config",
    // The grant directory is never a git repository — the sanitized copy omits
    // `.git` by design (D2) and the text-only grant is an empty temp dir — so
    // codex's trusted-directory check would otherwise refuse every step with
    // "Not inside a trusted directory and --skip-git-repo-check was not specified."
    "--skip-git-repo-check",
    "-C",
    grantDir,
    ...codexConfinementArgs(grantDir),
    ...(model ? ["-m", model] : []),
  ];
}

function runCodexCli(
  prompt: string,
  model: string | undefined,
  deps: StepRunnerDeps,
  signal: AbortSignal | undefined,
  grantDir: string
): Promise<string> {
  const spawnFn = deps.spawn ?? defaultSpawn;
  const env = buildCodexEnv(deps.env ?? process.env);
  const args = codexExecArgs(grantDir, model);

  return new Promise((resolve, reject) => {
    const child = spawnFn("codex", args, { env, cwd: grantDir });

    let stdout = "";
    let stderr = "";
    let lineBuffer = ""; // partial last line, completed by a later chunk

    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;

      // The answer is still extracted from the whole stdout on close; this loop
      // exists so the log sees each item as it happens rather than at the end.
      lineBuffer += text;
      const newlineIdx = lineBuffer.lastIndexOf("\n");
      if (newlineIdx === -1) return;
      const completeLines = lineBuffer.slice(0, newlineIdx + 1);
      lineBuffer = lineBuffer.slice(newlineIdx + 1);
      for (const line of completeLines.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        for (const event of codexStreamLineToEvents(trimmed)) emitStepEvent(deps.onEvent, event);
      }
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

/** The grant a codex step runs under: a directory plus its removal. */
type CodexGrant = Pick<SanitizedWorkspace, "dir" | "cleanup">;

/**
 * The grant for a step that declared no workspace: an empty directory, so the
 * profile's single `read` entry opens nothing. Shares the sanitized-copy prefix
 * so the stale sweep reclaims it too if a crash skips cleanup.
 */
function emptyGrant(): CodexGrant {
  // The sanitized-copy path sweeps on every materialization; this path creates
  // the same kind of directory and must reclaim after a crash the same way.
  sweepStaleWorkspaces(tmpdir());
  const dir = mkdtempSync(join(tmpdir(), "agent-flows-ws-empty-"));
  let removed = false;
  return {
    dir: realpathSync(dir),
    cleanup() {
      if (removed) return;
      removed = true;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function resolveGrant(workspaceDir: string | undefined): CodexGrant {
  if (workspaceDir === undefined) return emptyGrant();

  const workspace = materializeSanitizedWorkspace(workspaceDir);
  const { denied, symlinks, gitlinks } = workspace.skipped;
  // No logger travels in StepRunnerDeps; one line on stderr keeps the exclusions
  // visible — a copy that silently loses a source directory is the failure mode
  // this project has been bitten by before.
  console.error(
    `codex: sanitized workspace ${workspace.dir} — skipped ${denied.length} denied, ` +
      `${symlinks.length} symlink(s), ${gitlinks.length} gitlink(s)`
  );
  return workspace;
}

async function runCodexStep(
  prompt: string,
  entry: ModelEntry,
  deps: StepRunnerDeps,
  config: AdapterConfig = DEFAULT_ADAPTER_CONFIG
): Promise<string> {
  // Validate repo access before creating any deadline, exactly as the claude path does.
  const resolvedWorkspaceDir = resolveWorkspaceDir(deps);

  return withDeadline(deps, DEFAULT_STEP_TIMEOUT_MS, async (effectiveSignal) => {
    // FR-007: maxBudgetUsd is a claude-CLI flag; codex has no equivalent
    if (deps.maxBudgetUsd !== undefined) {
      throw new Error(
        `runLlmStep: maxBudgetUsd is not supported for codex transport — ` +
          `codex exec has no --max-budget-usd flag`
      );
    }
    if (deps.contentsAccess === "write") {
      throw new Error(
        `runLlmStep: permissions.contents "write" is not supported for codex — codex always runs read-only`
      );
    }
    // Confinement itself is unconditional — the flags below are always composed.
    // What `codexConfinement` decides is whether workspace read is OFFERED, and
    // `capabilities()` reports exactly that. Refusing here too means a caller who
    // bypasses checkPortability still cannot get an unconfinable read.
    if (deps.contentsAccess === "read" && !config.codexConfinement) {
      throw new Error(
        `runLlmStep: permissions.contents "read" is not supported for codex when the ` +
          `agent_flows permission profile is disabled — without it codex cannot confine reads ` +
          `at all (\`-s read-only\` constrains writes and network only)`
      );
    }

    const grant = resolveGrant(resolvedWorkspaceDir);
    try {
      return await runCodexCli(prompt, entry.cli?.model, deps, effectiveSignal, grant.dir);
    } finally {
      // Removed on every exit — success, throw, or abort.
      grant.cleanup();
    }
  });
}

export const codexAdapter: ProviderAdapter = {
  id: "codex",
  capabilities(_entry: ModelEntry, config: AdapterConfig): AdapterCapabilities {
    // Read is only confinable when the `agent_flows` permission profile is
    // composed (D2): `-s read-only` alone does not confine reads, so without the
    // profile there is no boundary at all. Write is never offered on codex.
    return {
      workspaceRead: config.codexConfinement,
      workspaceWrite: false,
      budgetCap: false,
    };
  },
  run: runCodexStep,
};
