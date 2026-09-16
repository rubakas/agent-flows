// Registering the agent-flows MCP server with each installed harness
// (spec 038 D10, D11, D17, FR-030/FR-031/FR-032).
//
// The MCP registration is the ONLY footprint agent-flows leaves in any
// harness's configuration (D17): `agent-notes` owns everything that lands in a
// harness dot-directory — the memory file, rules, agents, skills and settings
// hooks — and registers no MCP server at all. The two tools divide the machine
// on exactly that line, so nothing here may write a skill, an agent, a rule, an
// instruction file or a settings file.
//
// Every path this module reads or writes comes from the injected `home` of a
// SetupEnv rather than from `homedir()`, and every harness CLI call goes
// through the injected `run`. That is structural, not a convention: a test that
// forgets to redirect would otherwise edit the developer's real Claude Code,
// Codex and OpenCode configuration.

import { spawnSync } from "node:child_process";
import {
  accessSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, sep } from "node:path";

import { packageRoot } from "../packageRoot.js";
import { deleteMember, findMember, rootObjectStart, setMember } from "./jsonMember.js";

/** The name the server is registered under in every harness. */
export const SERVER_NAME = "agent-flows";

/** The harnesses this tool knows how to reach. */
export type HarnessId = "claude-code" | "codex" | "opencode" | "t3-code";

/** Human-facing name per harness, used by both `setup` and `doctor`. */
export const HARNESS_LABELS: Record<HarnessId, string> = {
  "claude-code": "Claude Code",
  codex: "Codex CLI",
  opencode: "OpenCode",
  "t3-code": "T3 Code",
};

/** Result of running a harness's own CLI. */
export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Everything `setup`, `setup --remove` and `doctor`'s reach report depend on.
 *
 * `home` is the root of every harness configuration path; `which` decides which
 * harnesses count as installed; `run` invokes a harness's own CLI; `command` is
 * the argv vector that gets registered.
 */
export interface SetupEnv {
  home: string;
  command: string[];
  which: (bin: string) => string | undefined;
  run: (bin: string, args: string[]) => RunResult;
}

/** What happened to one harness during `setup` or `setup --remove`. */
export type SetupStatus =
  | "registered"
  | "already-registered"
  | "removed"
  | "not-registered"
  | "not-installed"
  | "not-applicable"
  | "refused"
  | "failed";

/** One harness's outcome, one line of output. */
export interface HarnessResult {
  harness: HarnessId;
  label: string;
  status: SetupStatus;
  detail: string;
  configPath?: string;
}

/** What `doctor` reports per harness (FR-032). */
export interface HarnessReach {
  harness: HarnessId;
  label: string;
  binaryPath?: string;
  configPath?: string;
  command?: string[];
  registered: boolean;
  /** A registered command whose executable no longer resolves (D10). */
  stale: boolean;
  /** Set for harnesses that have no registration of their own (T3 Code). */
  note?: string;
}

// ── Configuration paths ──────────────────────────────────────────────────────

/** Claude Code's user-scope configuration (`claude mcp add --scope user`). */
export function claudeConfigPath(home: string): string {
  return join(home, ".claude.json");
}

/** Codex CLI's configuration. */
export function codexConfigPath(home: string): string {
  return join(home, ".codex", "config.toml");
}

/** OpenCode's global configuration directory. */
export function opencodeConfigDir(home: string): string {
  return join(home, ".config", "opencode");
}

/** The OpenCode config file this tool is willing to edit. */
export function opencodeConfigPath(home: string): string {
  return join(opencodeConfigDir(home), "opencode.json");
}

/**
 * Files OpenCode also loads from the same directory.
 *
 * Writing `opencode.json` next to one of these would create a SECOND config
 * that OpenCode also reads, so `setup` refuses instead (D10). Neither can be
 * merge-edited safely: `opencode.jsonc` carries comments that a JSON round-trip
 * would delete.
 */
export const OPENCODE_RIVAL_FILES = ["opencode.jsonc", "config.json"] as const;

// ── The command that gets registered ─────────────────────────────────────────

/** First executable named `bin` on PATH, without spawning anything. */
export function whichOnPath(bin: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (dir === "") continue;
    const candidate = join(dir, bin);
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not there, not a file, or not executable: not a candidate.
    }
  }
  return undefined;
}

/**
 * The argv vector registered with every harness: an ABSOLUTE path to the
 * launcher, plus `mcp`.
 *
 * Not the bare name `agent-flows`. A harness spawns its MCP servers with its
 * own environment, and the global bin directory of a node version manager is
 * only on PATH while that node version is selected — so `nvm use 20` would make
 * a bare `agent-flows` unresolvable in every harness at once, which is exactly
 * the failure this registration has to survive. The absolute path keeps
 * resolving regardless of the selected node, and `bin/agent-flows` re-execs
 * itself under an interpreter that can load the package (FR-003), so the
 * registration does not depend on the harness's node either.
 *
 * The path is resolved through its symlink: a global install puts a link in the
 * version's bin directory pointing at the package's own `bin/agent-flows`, and
 * the real file outlives any relinking of that shim.
 */
export function registeredCommand(
  which: (bin: string) => string | undefined = (bin) => whichOnPath(bin)
): string[] {
  const onPath = which(SERVER_NAME);
  const candidate = onPath ?? join(packageRoot(), "bin", SERVER_NAME);
  return [realPathOrSelf(candidate), "mcp"];
}

/** Resolve through symlinks, tolerating a path that is not there yet. */
function realPathOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** The default environment: the real home, the real PATH, real subprocesses. */
export function resolveSetupEnv(env: NodeJS.ProcessEnv = process.env): SetupEnv {
  const home = env.HOME !== undefined && env.HOME !== "" ? env.HOME : homedir();
  const which = (bin: string): string | undefined => whichOnPath(bin, env);
  return {
    home,
    which,
    command: registeredCommand(which),
    run: defaultRun,
  };
}

function defaultRun(bin: string, args: string[]): RunResult {
  const result = spawnSync(bin, args, { encoding: "utf8" });
  return {
    code: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? (result.error ? result.error.message : ""),
  };
}

// ── Reading what is registered ───────────────────────────────────────────────

/** A registration found in a harness's configuration file. */
export interface Registration {
  configPath: string;
  /** The executable and its arguments, flattened into one vector. */
  command: string[];
}

function parseJsonText(text: string): Record<string, unknown> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  return asObject(parsed);
}

function readJsonFile(path: string): Record<string, unknown> | undefined {
  return parseJsonText(readSafely(path));
}

function readSafely(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

/** Our entry in `~/.claude.json`, written by `claude mcp add --scope user`. */
export function readClaudeRegistration(home: string): Registration | undefined {
  const configPath = claudeConfigPath(home);
  const config = readJsonFile(configPath);
  const servers = config?.mcpServers;
  if (typeof servers !== "object" || servers === null) return undefined;
  const entry = (servers as Record<string, unknown>)[SERVER_NAME];
  if (typeof entry !== "object" || entry === null) return undefined;
  const { command, args } = entry as { command?: unknown; args?: unknown };
  if (typeof command !== "string") return undefined;
  return { configPath, command: [command, ...asStringArray(args)] };
}

/**
 * Our `[mcp_servers.agent-flows]` table in `~/.codex/config.toml`.
 *
 * Deliberately a targeted scan rather than a TOML parser: the only question is
 * whether our table exists and which command it names. Adding a TOML dependency
 * to answer that would put a parser in the dependency tree that nothing else
 * needs, and `codex mcp add`/`remove` — not this code — does every write.
 */
export function readCodexRegistration(home: string): Registration | undefined {
  const configPath = codexConfigPath(home);
  let text: string;
  try {
    text = readFileSync(configPath, "utf8");
  } catch {
    return undefined;
  }
  const lines = text.split("\n");
  const header = new RegExp(
    `^\\s*\\[mcp_servers\\.(?:"${SERVER_NAME}"|${SERVER_NAME})\\]\\s*$`,
    "u"
  );
  let inTable = false;
  let command: string | undefined;
  let args: string[] = [];
  for (const line of lines) {
    if (/^\s*\[/u.test(line)) {
      if (inTable) break;
      inTable = header.test(line);
      continue;
    }
    if (!inTable) continue;
    const commandMatch = /^\s*command\s*=\s*(".*")\s*$/u.exec(line);
    if (commandMatch) command = parseTomlString(commandMatch[1]);
    const argsMatch = /^\s*args\s*=\s*(\[.*\])\s*$/u.exec(line);
    if (argsMatch) args = parseTomlStringArray(argsMatch[1]);
  }
  if (command === undefined) return undefined;
  return { configPath, command: [command, ...args] };
}

function parseTomlString(literal: string): string | undefined {
  try {
    const value: unknown = JSON.parse(literal);
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

function parseTomlStringArray(literal: string): string[] {
  try {
    return asStringArray(JSON.parse(literal));
  } catch {
    return [];
  }
}

/** Our entry under `mcp` in the OpenCode global config. */
export function readOpencodeRegistration(home: string): Registration | undefined {
  const configPath = opencodeConfigPath(home);
  const config = readJsonFile(configPath);
  const mcp = config?.mcp;
  if (typeof mcp !== "object" || mcp === null) return undefined;
  const entry = (mcp as Record<string, unknown>)[SERVER_NAME];
  if (typeof entry !== "object" || entry === null) return undefined;
  const command = asStringArray((entry as { command?: unknown }).command);
  if (command.length === 0) return undefined;
  return { configPath, command };
}

function sameCommand(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((part, index) => part === b[index]);
}

// ── OpenCode config editing ──────────────────────────────────────────────────

/** The entry written under `mcp["agent-flows"]` — OpenCode's local server shape. */
export function opencodeEntry(command: string[]): Record<string, unknown> {
  return { type: "local", command, enabled: true };
}

/**
 * The indentation unit an existing JSON file uses, so an inserted member is
 * indented the way the rest of the file is (FR-031).
 */
export function detectIndentUnit(text: string): string {
  const match = /\n([ \t]+)"/u.exec(text);
  return match ? match[1] : "  ";
}

function writeConfigText(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, "utf8");
}

/** The rival config file present in OpenCode's directory, if any (D10). */
export function opencodeRivalConfig(home: string): string | undefined {
  for (const name of OPENCODE_RIVAL_FILES) {
    const path = join(opencodeConfigDir(home), name);
    if (existsSync(path)) return path;
  }
  return undefined;
}

// ── setup ────────────────────────────────────────────────────────────────────

/**
 * Register the MCP server with every harness whose binary is on PATH.
 *
 * Idempotent by construction: each harness's own configuration is read first,
 * and a harness that already names our command is reported and left alone —
 * its CLI is not invoked a second time (D10).
 */
export function runSetup(env: SetupEnv): HarnessResult[] {
  return [
    setupCliHarness(env, "claude-code", "claude", readClaudeRegistration, (command) => [
      "mcp",
      "add",
      SERVER_NAME,
      "--scope",
      "user",
      "--",
      ...command,
    ]),
    setupCliHarness(env, "codex", "codex", readCodexRegistration, (command) => [
      "mcp",
      "add",
      SERVER_NAME,
      "--",
      ...command,
    ]),
    setupOpencode(env),
    t3Result(),
  ];
}

/**
 * Claude Code and Codex are registered through their own documented CLIs rather
 * than by editing their files: both own formats this tool has no business
 * rewriting (`~/.claude.json` holds the user's whole Claude Code state).
 */
function setupCliHarness(
  env: SetupEnv,
  harness: HarnessId,
  bin: string,
  read: (home: string) => Registration | undefined,
  addArgs: (command: string[]) => string[]
): HarnessResult {
  const label = HARNESS_LABELS[harness];
  const binaryPath = env.which(bin);
  if (binaryPath === undefined) {
    return { harness, label, status: "not-installed", detail: `${bin} is not on PATH` };
  }

  const existing = read(env.home);
  if (existing !== undefined && sameCommand(existing.command, env.command)) {
    return {
      harness,
      label,
      status: "already-registered",
      detail: `already registered in ${existing.configPath}`,
      configPath: existing.configPath,
    };
  }

  // An entry naming a different command is a leftover from an earlier install
  // location; leaving it would keep the harness spawning a command that no
  // longer exists, so it is replaced rather than duplicated.
  const replaced = existing !== undefined;
  if (replaced) {
    const removal = env.run(bin, removeArgs(harness));
    if (removal.code !== 0) {
      return {
        harness,
        label,
        status: "failed",
        detail: `could not replace the existing entry: ${firstLine(removal)}`,
        configPath: existing.configPath,
      };
    }
  }

  const result = env.run(bin, addArgs(env.command));
  if (result.code !== 0) {
    return {
      harness,
      label,
      status: "failed",
      detail: `${bin} mcp add failed: ${firstLine(result)}`,
    };
  }
  const written = read(env.home);
  return {
    harness,
    label,
    status: "registered",
    detail: replaced
      ? `replaced a stale entry with ${env.command.join(" ")}`
      : `registered ${env.command.join(" ")}`,
    configPath: written?.configPath,
  };
}

function removeArgs(harness: HarnessId): string[] {
  return harness === "claude-code"
    ? ["mcp", "remove", SERVER_NAME, "--scope", "user"]
    : ["mcp", "remove", SERVER_NAME];
}

function firstLine(result: RunResult): string {
  const text = (result.stderr || result.stdout).trim();
  return text === "" ? `exit code ${result.code}` : text.split("\n")[0];
}

/**
 * OpenCode is registered by a merge-edit, because its `mcp add` has no
 * documented non-interactive form. Only `mcp["agent-flows"]` is written; every
 * other key keeps its value, its order and the file's indentation.
 */
function setupOpencode(env: SetupEnv): HarnessResult {
  const harness: HarnessId = "opencode";
  const label = HARNESS_LABELS[harness];
  const binaryPath = env.which("opencode");
  if (binaryPath === undefined) {
    return { harness, label, status: "not-installed", detail: "opencode is not on PATH" };
  }

  const rival = opencodeRivalConfig(env.home);
  if (rival !== undefined) {
    return {
      harness,
      label,
      status: "refused",
      detail:
        `your OpenCode configuration is ${rival}; writing ${opencodeConfigPath(env.home)} ` +
        `would create a second config that OpenCode also loads. Add this to ${rival} by hand: ` +
        `"mcp": { "${SERVER_NAME}": ${JSON.stringify(opencodeEntry(env.command))} }`,
      configPath: rival,
    };
  }

  const configPath = opencodeConfigPath(env.home);
  const exists = existsSync(configPath);
  // A file we create starts as an empty object, so one code path covers both
  // "edit the user's config" and "write the first one".
  const text = exists ? readFileSync(configPath, "utf8") : "{}\n";
  const config = parseJsonText(text);
  const open = rootObjectStart(text);
  if (config === undefined || open === -1) {
    return {
      harness,
      label,
      status: "failed",
      detail: `${configPath} is not a JSON object — left it alone`,
      configPath,
    };
  }

  const existing = readOpencodeRegistration(env.home);
  if (existing !== undefined && sameCommand(existing.command, env.command)) {
    return {
      harness,
      label,
      status: "already-registered",
      detail: `already registered in ${configPath}`,
      configPath,
    };
  }

  // One backup, before the first edit ever made to an existing file. Written
  // once: a second setup must not overwrite the pre-agent-flows copy with a
  // post-agent-flows one.
  if (exists) {
    const backup = `${configPath}.bak`;
    if (!existsSync(backup)) copyFileSync(configPath, backup);
  }

  const unit = detectIndentUnit(text);
  // Keep whatever else the user put on our entry (an `environment` block, say)
  // and only set the fields we own.
  const previous = asObject(asObject(config.mcp)?.[SERVER_NAME]) ?? {};
  const entry = { ...previous, ...opencodeEntry(env.command) };

  const mcpSpan = findMember(text, open, "mcp");
  const next =
    mcpSpan === undefined
      ? setMember(text, open, "mcp", { [SERVER_NAME]: entry }, unit)
      : setMember(text, mcpSpan.valueStart, SERVER_NAME, entry, unit);
  writeConfigText(configPath, next);

  return {
    harness,
    label,
    status: "registered",
    detail: `registered ${env.command.join(" ")} in ${configPath}`,
    configPath,
  };
}

/** T3 Code runs another harness and inherits its configuration (research §4). */
function t3Result(): HarnessResult {
  return {
    harness: "t3-code",
    label: HARNESS_LABELS["t3-code"],
    status: "not-applicable",
    detail:
      "nothing to register — T3 Code runs another harness and inherits whichever " +
      "configuration that harness uses",
  };
}

// ── setup --remove ───────────────────────────────────────────────────────────

/** Reverse exactly what `runSetup` wrote, per harness (FR-031). */
export function runRemove(env: SetupEnv): HarnessResult[] {
  return [
    removeCliHarness(env, "claude-code", "claude", readClaudeRegistration),
    removeCliHarness(env, "codex", "codex", readCodexRegistration),
    removeOpencode(env),
    t3Result(),
  ];
}

function removeCliHarness(
  env: SetupEnv,
  harness: HarnessId,
  bin: string,
  read: (home: string) => Registration | undefined
): HarnessResult {
  const label = HARNESS_LABELS[harness];
  const existing = read(env.home);
  if (existing === undefined) {
    return { harness, label, status: "not-registered", detail: "no entry to remove" };
  }
  const binaryPath = env.which(bin);
  if (binaryPath === undefined) {
    return {
      harness,
      label,
      status: "failed",
      detail:
        `${existing.configPath} still holds an entry, but ${bin} is not on PATH to remove it — ` +
        `delete the "${SERVER_NAME}" entry by hand`,
      configPath: existing.configPath,
    };
  }
  const result = env.run(bin, removeArgs(harness));
  if (result.code !== 0) {
    return {
      harness,
      label,
      status: "failed",
      detail: `${bin} mcp remove failed: ${firstLine(result)}`,
      configPath: existing.configPath,
    };
  }
  return {
    harness,
    label,
    status: "removed",
    detail: `removed from ${existing.configPath}`,
    configPath: existing.configPath,
  };
}

/**
 * Delete only `mcp["agent-flows"]` from the OpenCode config.
 *
 * An `mcp` object left empty by that deletion is removed too, and a config file
 * that `setup` itself created — the case with no `.bak` beside it — is deleted
 * outright. Both exist so that setup-then-remove leaves the directory exactly
 * as it was found, rather than leaving `{"mcp":{}}` files behind as evidence
 * that agent-flows was once here.
 */
function removeOpencode(env: SetupEnv): HarnessResult {
  const harness: HarnessId = "opencode";
  const label = HARNESS_LABELS[harness];
  const configPath = opencodeConfigPath(env.home);
  if (!existsSync(configPath)) {
    return { harness, label, status: "not-registered", detail: "no OpenCode config to edit" };
  }
  const text = readFileSync(configPath, "utf8");
  const config = parseJsonText(text);
  const open = rootObjectStart(text);
  if (config === undefined || open === -1) {
    return {
      harness,
      label,
      status: "failed",
      detail: `${configPath} is not a JSON object — left it alone`,
      configPath,
    };
  }
  const mcpSpan = findMember(text, open, "mcp");
  if (mcpSpan === undefined || findMember(text, mcpSpan.valueStart, SERVER_NAME) === undefined) {
    return { harness, label, status: "not-registered", detail: "no entry to remove", configPath };
  }

  let next = deleteMember(text, mcpSpan.valueStart, SERVER_NAME);
  // An `mcp` object that setup itself introduced goes with it; one the user
  // already had stays, even if it is now empty. The backup is the only record
  // of which of the two it was.
  const backup = `${configPath}.bak`;
  const hadBackup = existsSync(backup);
  const mcpWasOurs = !hadBackup || asObject(parseJsonText(readSafely(backup))?.mcp) === undefined;
  const remainingMcp = asObject(parseJsonText(next)?.mcp);
  if (mcpWasOurs && remainingMcp !== undefined && Object.keys(remainingMcp).length === 0) {
    next = deleteMember(next, rootObjectStart(next), "mcp");
  }

  // A file setup created — the case with no backup beside it — is removed
  // outright rather than left behind as an empty object.
  if (!hadBackup && Object.keys(parseJsonText(next) ?? {}).length === 0) {
    rmSync(configPath);
    return {
      harness,
      label,
      status: "removed",
      detail: `removed ${configPath}, which setup had created`,
      configPath,
    };
  }

  writeConfigText(configPath, next);
  return { harness, label, status: "removed", detail: `removed from ${configPath}`, configPath };
}

// ── doctor's reach report ────────────────────────────────────────────────────

/** Whether a registered executable still resolves (D10's staleness rule). */
export function commandResolves(
  executable: string,
  which: (bin: string) => string | undefined
): boolean {
  if (executable.includes(sep) || executable.startsWith(".")) return existsSync(executable);
  return which(executable) !== undefined;
}

/** Per-harness reach, as `doctor` prints it (FR-032). */
export function harnessReach(env: SetupEnv): HarnessReach[] {
  const entries: {
    harness: HarnessId;
    bin: string;
    read: (home: string) => Registration | undefined;
  }[] = [
    { harness: "claude-code", bin: "claude", read: readClaudeRegistration },
    { harness: "codex", bin: "codex", read: readCodexRegistration },
    { harness: "opencode", bin: "opencode", read: readOpencodeRegistration },
  ];

  const reach = entries.map(({ harness, bin, read }): HarnessReach => {
    const registration = read(env.home);
    return {
      harness,
      label: HARNESS_LABELS[harness],
      binaryPath: env.which(bin),
      configPath: registration?.configPath,
      command: registration?.command,
      registered: registration !== undefined,
      stale: registration !== undefined && !commandResolves(registration.command[0], env.which),
    };
  });

  reach.push({
    harness: "t3-code",
    label: HARNESS_LABELS["t3-code"],
    binaryPath: env.which("t3"),
    registered: false,
    stale: false,
    note: "inherits the configuration of whichever harness it runs — nothing to register",
  });
  return reach;
}

/** One operator-facing line per harness. */
export function formatHarnessResult(result: HarnessResult): string {
  return `  ${result.label.padEnd(12)} ${result.status.padEnd(18)} ${result.detail}`;
}
