// Provider-agnostic step executor for Binding B.

import { spawn as defaultSpawn } from "node:child_process";
import { statSync } from "node:fs";
import { runClaudeCli, SCRUBBED_KEYS } from "./runClaudeCli.js";
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

/**
 * Files a workspace step may never read OR write, even when
 * `permissions.contents` is granted. Applied via `--disallowedTools` as both
 * `Read(pattern)` and `Edit(pattern)` entries on every claude CLI invocation
 * that declares a `contentsAccess`.
 *
 * Named files and file types only — deliberately no keyword wildcards. A
 * pattern like `*token*` reads as thorough but denies ordinary source such as
 * `tokenizer.ts`, so an investigation silently loses part of the codebase it
 * was asked to study. A miss here is visible and fixable by adding a line; a
 * wildcard's damage is invisible.
 *
 * Add a line when a project keeps secrets somewhere this does not name.
 *
 * Separate from BUILD_CONFIG_DENY_PATTERNS: credential files must be unreadable
 * as well as unwritable. Build config files must stay readable (steps
 * legitimately need to understand them) but must not be editable.
 */
export const CREDENTIAL_DENY_PATTERNS: readonly string[] = [
  // Environment files. Each real variant is named; `.env.example`,
  // `.env.sample` and `.env.template` are deliberately absent — a template
  // holds placeholders, and a step needs it to understand configuration.
  "**/.env",
  "**/.env.production",
  "**/.env.staging",
  "**/.env.local",
  "**/.env.development",
  "**/.env.test",

  "**/credentials",
  "**/credentials.production",
  "**/credentials.staging",
  "**/credentials.json",
  "**/credentials.toml",
  "**/credentials.yaml",
  "**/secrets.json",
  "**/secrets.yaml",
  "**/secrets.yml",
  "**/service-account*.json",

  // Key material by extension.
  "**/*.key",
  "**/*.pem",
  "**/*.p12",
  "**/*.pfx",
  "**/*.jks",
  "**/*.keystore",
  "**/*.truststore",

  // SSH private keys carry no extension, so the rules above miss them —
  // `id_rsa` is the most common private-key filename on disk.
  "**/id_rsa*",
  "**/id_ed25519*",
  "**/id_ecdsa*",
  "**/id_dsa*",
];

/**
 * Files a workspace step may never EDIT (but may read). Applied via
 * `--disallowedTools` as `Edit(pattern)` entries — Read is intentionally absent
 * so steps can still inspect these files.
 *
 * These are build/execution artifacts: editing them lets an injected step
 * rewrite the test script or CI pipeline and have those rewrites executed
 * inside the same run. A step reading `package.json` to understand dependencies
 * is legitimate; a step rewriting `test` to `echo PWNED` is the attack.
 *
 * Separate from CREDENTIAL_DENY_PATTERNS, which denies both read and edit.
 * The distinction is intentional and the whole point: Read stays allowed here
 * so investigation steps retain full visibility into the build configuration.
 */
export const BUILD_CONFIG_DENY_PATTERNS: readonly string[] = [
  "**/package.json",
  "**/Makefile",
  "**/.github/workflows/**",
  "**/.git/**",
  "**/.husky/**",
  "**/*.config.*",
];

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
   * - "read": grants Read and Glob only (`--tools Read,Glob --allowedTools Read,Glob`).
   *   The agent can inspect the project but cannot modify any file.
   * - "write": adds Edit and Write (`--tools Read,Glob,Edit,Write`). Bash is never
   *   granted in either mode.
   *
   * Not supported for api transport or codex (both will throw at runtime).
   */
  contentsAccess?: "read" | "write";
  /**
   * Per-step exceptions to the effective deny set built from CREDENTIAL_DENY_PATTERNS
   * and BUILD_CONFIG_DENY_PATTERNS. Each entry is a plain path glob (NOT a vendor
   * rule string like `Read(...)`). The binding turns them into CLI deny-list subtractions.
   *
   * Matching rule: an entry A removes a deny pattern P when
   * `normalisePattern(A) === normalisePattern(P)`. Normalisation: trim, convert
   * backslash to forward-slash, strip leading `./`. This is exact string equality
   * on the pattern strings — NOT file-path glob expansion. Consequently:
   *   - `"**\/*.pem"` removes the stored pattern `"**\/*.pem"` (they are equal).
   *   - `"fixtures/sample.pem"` does NOT remove `"**\/*.pem"` — the strings differ,
   *     so `**\/*.pem` remains in the deny set and the specific file is still denied.
   *   To allow a specific file covered by a broad default glob, that broad glob
   *   string must appear verbatim in `allowPatterns`. This is intentional: removing
   *   a narrow path silently while leaving the broad glob would make the allow
   *   appear to work in the canon but do nothing in practice — the worst outcome.
   *
   * Key names `allow`/`deny` are adopted from Claude Code's own
   * `permissions.allow`/`permissions.deny` settings format; the canon stays
   * provider-neutral and this binding turns them into `--disallowedTools` subtractions.
   *
   * `allowPatterns` can never widen the tool set beyond `contentsAccess`: a step
   * with `contentsAccess: "read"` still gets only Read and Glob in `--tools` —
   * the allow list only affects which paths appear in `--disallowedTools`, not
   * the granted tool set.
   *
   * Only meaningful when `contentsAccess` is set (validated at canon load time).
   */
  allowPatterns?: string[];
  /**
   * Additional deny patterns for this step only, prepended to the project defaults
   * before `allowPatterns` subtraction. Plain path globs (not vendor rule strings).
   * Applied as both Read and Edit denials (same as CREDENTIAL_DENY_PATTERNS).
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

// ── Pattern normalisation ─────────────────────────────────────────────────────

/**
 * Normalises a deny/allow pattern string for set membership comparison.
 * Strips leading whitespace, converts backslashes to forward-slashes, and
 * removes a leading `./` so that user-written `./fixtures/sample.pem` and
 * the stored `fixtures/sample.pem` are treated as the same pattern.
 */
export function normalisePattern(p: string): string {
  return p.trim().replace(/\\/g, "/").replace(/^\.\//, "");
}

/**
 * Returns true when an allow entry removes a given deny pattern.
 * Mirrors the semantics of allowEntryMatches() in load.ts so that an entry
 * accepted at load time is also effective at runtime:
 *   - exact match: normalise(entry) === normalise(denied)
 *   - shorthand:   normalise(entry) === last path segment of normalise(denied)
 *     e.g. ".env.local" matches "**\/.env.local"
 */
function allowEntryRemoves(entry: string, deniedPattern: string): boolean {
  const normEntry = normalisePattern(entry);
  const normDenied = normalisePattern(deniedPattern);
  if (normEntry === normDenied) return true;
  const lastSegment = normDenied.split("/").pop() ?? normDenied;
  return normEntry === lastSegment;
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

/** Returns a shallow copy of `rawEnv` with all SCRUBBED_KEYS removed.
 * Used by the codex and API transports which do not run a shell and
 * therefore do not need the full check-step allowlist approach. */
function scrubEnv(rawEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...rawEnv };
  for (const key of SCRUBBED_KEYS) delete env[key];
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
  const env = scrubEnv(deps.env ?? process.env);

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

  return new Promise<CheckResult>((resolve) => {
    const child = spawnFn("/bin/sh", ["-c", command], { env, cwd });

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
      if (deadline?.signal.aborted) {
        const reason = deadline.signal.reason as { name?: string } | undefined;
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

    if (deadline) {
      deadline.signal.addEventListener(
        "abort",
        () => {
          child.kill("SIGTERM");
          // Escalate to SIGKILL after a grace period; unref so the timer does not
          // prevent the process from exiting once the promise resolves.
          const esc = setTimeout(() => child.kill("SIGKILL"), CHECK_KILL_ESCALATION_MS);
          if (typeof (esc as { unref?: () => void }).unref === "function") {
            (esc as { unref: () => void }).unref();
          }
        },
        { once: true }
      );
    }
  });
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function runLlmStep(
  entry: ModelEntry,
  prompt: string,
  deps: StepRunnerDeps = {}
): Promise<string> {
  // Validate and resolve repo access before creating any deadline.
  // Fail fast on configuration errors rather than timing out or running silently
  // against the wrong directory.
  let resolvedWorkspaceDir: string | undefined;
  if (deps.contentsAccess === "read" || deps.contentsAccess === "write") {
    if (entry.transport === "api") {
      throw new Error(
        `runLlmStep: permissions.contents "${deps.contentsAccess}" is not supported for api transport — ` +
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
        `runLlmStep: permissions.contents "${deps.contentsAccess}" declared but workspaceDir "${dir}" is not a valid directory`
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
        const hasSkills = (deps.skills?.length ?? 0) > 0;

        // Determine the tool set for this step. The three axes are mutually exclusive:
        // pure text (no contentsAccess, no skills), read, or write — plus an optional
        // Skill suffix when skills are declared.
        let baseTools: string;
        if (deps.contentsAccess === "read") {
          baseTools = "Read,Glob";
        } else if (deps.contentsAccess === "write") {
          // "write": add Edit and Write; Bash is deliberately excluded.
          baseTools = "Read,Glob,Edit,Write";
        } else {
          // No file access declared (pure text step or skills-only).
          baseTools = "";
        }
        const toolSet = hasSkills ? (baseTools ? `${baseTools},Skill` : "Skill") : baseTools;

        // Hardening is unconditional. Every claude invocation gets --restricted and
        // --strict-mcp-config regardless of whether the step declares permissions or
        // skills. Without this, a step with no permissions gets the full default tool
        // set (Bash, WebFetch, etc.) and loads the operator's personal settings —
        // inverting the security model so the least-declared step is the most privileged.
        //
        // --restricted makes the CLI ignore user/project/local settings files and
        // confines file tools to the working directory, so a target repo's own
        // .claude/settings.json cannot widen the granted tool set.
        // --strict-mcp-config extends that guarantee to MCP servers declared in the
        // target repo.
        //
        // Tool-set selection for no-permissions steps:
        // The CLI help documents `--tools ""` as disabling all tools. Empirically it
        // does not: with `--tools ""`, the CLI ignores the flag and still grants the
        // full file-tool set (Read, Edit, Write, Glob, Grep) and critically re-enables
        // Bash even under `--restricted`. The nearest safe alternative is "Read,Glob" —
        // confirmed to limit the session to read-only file operations with no Bash,
        // no WebFetch, and no Edit/Write. A pure text step getting read access is a
        // minor deviation from ideal "no tools at all" but is vastly safer than Bash.
        const effectiveToolSet = toolSet || "Read,Glob";
        extraArgs.push("--restricted", "--strict-mcp-config", "--tools", effectiveToolSet);
        extraArgs.push("--allowedTools", effectiveToolSet);

        // Per-step exceptions:
        //   effective deny = (CREDENTIAL_DENY_PATTERNS ∪ denyPatterns ∪ BUILD_CONFIG_DENY_PATTERNS) − allowPatterns
        //
        // Subtraction uses allowEntryRemoves() which accepts both exact matches and the
        // convenient trailing-segment shorthand (e.g. ".env.local" removes "**/.env.local").
        // This matches the semantics validated at load time in allowEntryMatches() so that
        // an entry accepted by canon:check is also effective at runtime.
        //
        // CREDENTIAL_DENY_PATTERNS: deny both Read and Edit — credential files must never
        // be visible to a step. Emitted unconditionally when Read is in the tool set (which
        // it always is — even no-permissions steps get Read,Glob as the safe hardened
        // fallback). Without this, a pure text step can read .env, *.pem, id_rsa from the
        // daemon's working directory with no deny list at all.
        //
        // BUILD_CONFIG_DENY_PATTERNS: deny Edit only — Read stays allowed so steps can
        // inspect the build configuration; editing these files would let an injected prompt
        // rewrite the test script or CI pipeline and have it executed inside the same run.
        // Only emitted when workspace access is declared (Edit requires a workspace).
        const allowPatterns = deps.allowPatterns ?? [];

        const effectiveCredentialPatterns = [
          ...CREDENTIAL_DENY_PATTERNS,
          ...(deps.denyPatterns ?? []),
        ].filter((p) => !allowPatterns.some((a) => allowEntryRemoves(a, p)));

        if (resolvedWorkspaceDir !== undefined) {
          // "Edit(pattern)" rules cover all file-editing tools (including Write);
          // "Write(pattern)" is not a valid file permission deny rule and produces CLI warnings.
          const effectiveBuildConfigPatterns = BUILD_CONFIG_DENY_PATTERNS.filter(
            (p) => !allowPatterns.some((a) => allowEntryRemoves(a, p))
          );
          const credentialDenyEntries = ["Read", "Edit"].flatMap((tool) =>
            effectiveCredentialPatterns.map((pat) => `${tool}(${pat})`)
          );
          const buildConfigDenyEntries = effectiveBuildConfigPatterns.map((pat) => `Edit(${pat})`);
          const disallowedToolsValue = [...credentialDenyEntries, ...buildConfigDenyEntries].join(
            ","
          );
          extraArgs.push("--disallowedTools", disallowedToolsValue);
        } else {
          // No workspace declared: emit credential Read denials only. Edit denials and
          // build-config denials are not needed without write access.
          const credentialReadEntries = effectiveCredentialPatterns.map((pat) => `Read(${pat})`);
          extraArgs.push("--disallowedTools", credentialReadEntries.join(","));
        }

        if (hasSkills) {
          const rawEnv = deps.env ?? process.env;
          const skillsDir = rawEnv.AGENT_FLOWS_SKILLS_DIR ?? `${rawEnv.HOME ?? ""}/.claude`;
          extraArgs.push("--plugin-dir", skillsDir);
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
        if (deps.contentsAccess === "write") {
          throw new Error(
            `runLlmStep: permissions.contents "write" is not supported for codex — codex always runs read-only`
          );
        }
        if (deps.contentsAccess === "read") {
          // codex exec has no --disallowedTools or file-deny mechanism (confirmed via
          // `codex exec --help`: only -s read-only|workspace-write|danger-full-access).
          // Without a deny list, credential files (.env, *.pem, id_rsa) in the workspace
          // are readable by the agent. A silent gap is not acceptable; the loader must
          // refuse this combination. Use the claude transport with contents: read for
          // controlled workspace access with CREDENTIAL_DENY_PATTERNS enforcement.
          throw new Error(
            `runLlmStep: permissions.contents "read" is not supported for codex — ` +
              `codex exec has no file-deny mechanism, so credential files (.env, *.pem, id_rsa) ` +
              `cannot be excluded from the workspace. Use the claude transport with ` +
              `permissions.contents: read for workspace access with credential deny lists.`
          );
        }
        return await runCodexCli(prompt, entry.cli?.model, deps, effectiveSignal, undefined);
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
