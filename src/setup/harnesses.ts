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

export const SERVER_NAME = "agent-flows";

/** The harnesses this tool knows how to reach. */
export type HarnessId = "claude-code" | "codex" | "opencode" | "t3-code";

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

export type SetupStatus =
  | "registered"
  | "already-registered"
  | "removed"
  | "not-registered"
  | "not-installed"
  | "not-applicable"
  | "refused"
  | "failed";

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

export function codexConfigPath(home: string): string {
  return join(home, ".codex", "config.toml");
}

function opencodeConfigDir(home: string): string {
  return join(home, ".config", "opencode");
}

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
const OPENCODE_RIVAL_FILES = ["opencode.jsonc", "config.json"] as const;

// ── The command that gets registered ─────────────────────────────────────────

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    // Not there, not a file, or not executable: not a candidate.
    return false;
  }
}

/** Every executable named `bin` on PATH, in PATH order, without spawning anything. */
export function whichAllOnPath(bin: string, env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.PATH ?? "")
    .split(delimiter)
    .filter((dir) => dir !== "")
    .map((dir) => join(dir, bin))
    .filter(isExecutableFile);
}

/** First executable named `bin` on PATH. */
export function whichOnPath(bin: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return whichAllOnPath(bin, env)[0];
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
 *
 * The limit that follows from that: only single-line `command =` and `args =`
 * entries are recognised, which is the shape `codex mcp add` itself writes.
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
function opencodeEntry(command: string[]): Record<string, unknown> {
  return { type: "local", command, enabled: true };
}

/**
 * The indentation unit an existing JSON file uses, so an inserted member is
 * indented the way the rest of the file is (FR-031).
 */
function detectIndentUnit(text: string): string {
  const match = /\n([ \t]+)"/u.exec(text);
  return match ? match[1] : "  ";
}

function writeConfigText(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, "utf8");
}

/** The rival config file present in OpenCode's directory, if any (D10). */
function opencodeRivalConfig(home: string): string | undefined {
  for (const name of OPENCODE_RIVAL_FILES) {
    const path = join(opencodeConfigDir(home), name);
    if (existsSync(path)) return path;
  }
  return undefined;
}

// ── The harnesses ────────────────────────────────────────────────────────────

/**
 * One harness, as `setup`, `setup --remove` and the reach report all see it.
 *
 * `addArgs`/`removeArgs` are absent for a harness whose configuration `setup`
 * merge-edits instead of driving a CLI (OpenCode), and `note` marks one with no
 * registration of its own (T3 Code), whose `read` therefore never finds one.
 */
interface Harness {
  id: HarnessId;
  label: string;
  bin: string;
  read: (home: string) => Registration | undefined;
  addArgs?: (command: string[]) => string[];
  removeArgs?: string[];
  note?: string;
}

/** A harness registered through its own `mcp add` / `mcp remove`. */
type CliHarness = Harness & {
  addArgs: (command: string[]) => string[];
  removeArgs: string[];
};

/** T3 Code runs another harness and inherits its configuration (research §4). */
const T3_NOTE = "inherits the configuration of whichever harness it runs — nothing to register";

const HARNESSES: Harness[] = [
  {
    id: "claude-code",
    label: "Claude Code",
    bin: "claude",
    read: readClaudeRegistration,
    addArgs: (command) => ["mcp", "add", SERVER_NAME, "--scope", "user", "--", ...command],
    removeArgs: ["mcp", "remove", SERVER_NAME, "--scope", "user"],
  },
  {
    id: "codex",
    label: "Codex CLI",
    bin: "codex",
    read: readCodexRegistration,
    addArgs: (command) => ["mcp", "add", SERVER_NAME, "--", ...command],
    removeArgs: ["mcp", "remove", SERVER_NAME],
  },
  { id: "opencode", label: "OpenCode", bin: "opencode", read: readOpencodeRegistration },
  { id: "t3-code", label: "T3 Code", bin: "t3", read: () => undefined, note: T3_NOTE },
];

function hasOwnCli(harness: Harness): harness is CliHarness {
  return harness.addArgs !== undefined && harness.removeArgs !== undefined;
}

/** Fills in the harness and the label of every line one harness produces. */
function resultFor(
  harness: Harness
): (status: SetupStatus, detail: string, configPath?: string) => HarnessResult {
  return (status, detail, configPath) => ({
    harness: harness.id,
    label: harness.label,
    status,
    detail,
    configPath,
  });
}

function noteResult(harness: Harness, note: string): HarnessResult {
  return resultFor(harness)("not-applicable", note);
}

function firstLine(result: RunResult): string {
  const text = (result.stderr || result.stdout).trim();
  return text === "" ? `exit code ${result.code}` : text.split("\n")[0];
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
  return HARNESSES.map((harness) => {
    if (harness.note !== undefined) return noteResult(harness, harness.note);
    return hasOwnCli(harness) ? setupCliHarness(env, harness) : setupOpencode(env, harness);
  });
}

/**
 * Claude Code and Codex are registered through their own documented CLIs rather
 * than by editing their files: both own formats this tool has no business
 * rewriting (`~/.claude.json` holds the user's whole Claude Code state).
 */
function setupCliHarness(env: SetupEnv, harness: CliHarness): HarnessResult {
  const result = resultFor(harness);
  if (env.which(harness.bin) === undefined) {
    return result("not-installed", `${harness.bin} is not on PATH`);
  }

  const existing = harness.read(env.home);
  if (existing !== undefined && sameCommand(existing.command, env.command)) {
    return result(
      "already-registered",
      `already registered in ${existing.configPath}`,
      existing.configPath
    );
  }

  // An entry naming a different command is a leftover from an earlier install
  // location; leaving it would keep the harness spawning a command that no
  // longer exists, so it is replaced rather than duplicated.
  const replaced = existing !== undefined;
  if (existing !== undefined) {
    const removal = env.run(harness.bin, harness.removeArgs);
    if (removal.code !== 0) {
      return result(
        "failed",
        `could not replace the existing entry: ${firstLine(removal)}`,
        existing.configPath
      );
    }
  }

  const added = env.run(harness.bin, harness.addArgs(env.command));
  if (added.code !== 0) {
    return result("failed", `${harness.bin} mcp add failed: ${firstLine(added)}`);
  }
  const written = harness.read(env.home);
  return result(
    "registered",
    replaced
      ? `replaced a stale entry with ${env.command.join(" ")}`
      : `registered ${env.command.join(" ")}`,
    written?.configPath
  );
}

/**
 * OpenCode is registered by a merge-edit, because its `mcp add` has no
 * documented non-interactive form. Only `mcp["agent-flows"]` is written; every
 * other key keeps its value, its order and the file's indentation.
 */
function setupOpencode(env: SetupEnv, harness: Harness): HarnessResult {
  const result = resultFor(harness);
  if (env.which(harness.bin) === undefined) {
    return result("not-installed", `${harness.bin} is not on PATH`);
  }

  const rival = opencodeRivalConfig(env.home);
  if (rival !== undefined) {
    return result(
      "refused",
      `your OpenCode configuration is ${rival}; writing ${opencodeConfigPath(env.home)} ` +
        `would create a second config that OpenCode also loads. Add this to ${rival} by hand: ` +
        `"mcp": { "${SERVER_NAME}": ${JSON.stringify(opencodeEntry(env.command))} }`,
      rival
    );
  }

  const configPath = opencodeConfigPath(env.home);
  const exists = existsSync(configPath);
  const text = exists ? readFileSync(configPath, "utf8") : "{}\n";
  const config = parseJsonText(text);
  const open = rootObjectStart(text);
  if (config === undefined || open === -1) {
    return result("failed", `${configPath} is not a JSON object — left it alone`, configPath);
  }

  const existing = readOpencodeRegistration(env.home);
  if (existing !== undefined && sameCommand(existing.command, env.command)) {
    return result("already-registered", `already registered in ${configPath}`, configPath);
  }

  // One backup, before the first edit ever made to an existing file. Written
  // once: a second setup must not overwrite the pre-agent-flows copy with a
  // post-agent-flows one.
  if (exists) {
    const backup = backupPath(configPath);
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

  return result("registered", `registered ${env.command.join(" ")} in ${configPath}`, configPath);
}

// ── setup --remove ───────────────────────────────────────────────────────────

/** Reverse exactly what `runSetup` wrote, per harness (FR-031). */
export function runRemove(env: SetupEnv): HarnessResult[] {
  return HARNESSES.map((harness) => {
    if (harness.note !== undefined) return noteResult(harness, harness.note);
    return hasOwnCli(harness) ? removeCliHarness(env, harness) : removeOpencode(env, harness);
  });
}

function removeCliHarness(env: SetupEnv, harness: CliHarness): HarnessResult {
  const result = resultFor(harness);
  const existing = harness.read(env.home);
  if (existing === undefined) return result("not-registered", "no entry to remove");
  if (env.which(harness.bin) === undefined) {
    return result(
      "failed",
      `${existing.configPath} still holds an entry, but ${harness.bin} is not on PATH to remove it — ` +
        `delete the "${SERVER_NAME}" entry by hand`,
      existing.configPath
    );
  }
  const removal = env.run(harness.bin, harness.removeArgs);
  if (removal.code !== 0) {
    return result(
      "failed",
      `${harness.bin} mcp remove failed: ${firstLine(removal)}`,
      existing.configPath
    );
  }
  return result("removed", `removed from ${existing.configPath}`, existing.configPath);
}

/** The copy `setup` takes of an OpenCode config before its first edit. */
function backupPath(configPath: string): string {
  return `${configPath}.bak`;
}

/**
 * Delete only `mcp["agent-flows"]` from the OpenCode config.
 *
 * An `mcp` object left empty by that deletion is removed too, a config file
 * that `setup` itself created — the case with no `.bak` beside it — is deleted
 * outright, and the backup setup took goes once the file it restores matches it
 * again. All three exist so that setup-then-remove leaves the directory exactly
 * as it was found, rather than leaving evidence that agent-flows was once here.
 */
function removeOpencode(env: SetupEnv, harness: Harness): HarnessResult {
  const result = resultFor(harness);
  const configPath = opencodeConfigPath(env.home);
  if (!existsSync(configPath)) return result("not-registered", "no OpenCode config to edit");
  const text = readFileSync(configPath, "utf8");
  const config = parseJsonText(text);
  const open = rootObjectStart(text);
  if (config === undefined || open === -1) {
    return result("failed", `${configPath} is not a JSON object — left it alone`, configPath);
  }
  const mcpSpan = findMember(text, open, "mcp");
  if (mcpSpan === undefined || findMember(text, mcpSpan.valueStart, SERVER_NAME) === undefined) {
    return result("not-registered", "no entry to remove", configPath);
  }

  let next = deleteMember(text, mcpSpan.valueStart, SERVER_NAME);
  // The backup is the only record of which `mcp` object this was: one the user
  // already had stays, even when it is now empty; one setup introduced goes.
  const backup = backupPath(configPath);
  const hadBackup = existsSync(backup);
  const mcpWasOurs = !hadBackup || asObject(parseJsonText(readSafely(backup))?.mcp) === undefined;
  const remainingMcp = asObject(parseJsonText(next)?.mcp);
  if (mcpWasOurs && remainingMcp !== undefined && Object.keys(remainingMcp).length === 0) {
    next = deleteMember(next, rootObjectStart(next), "mcp");
  }

  if (!hadBackup && Object.keys(parseJsonText(next) ?? {}).length === 0) {
    rmSync(configPath);
    return result("removed", `removed ${configPath}, which setup had created`, configPath);
  }

  writeConfigText(configPath, next);
  const kept = hadBackup ? discardBackup(backup, next) : "";
  return result("removed", `removed from ${configPath}${kept}`, configPath);
}

/**
 * Drop the backup `setup` took, now that the entry it was taken for is gone.
 *
 * Only when the restored file matches it byte for byte: a file edited between
 * setup and remove differs, and then the backup is the only copy of what was
 * there before agent-flows, so it stays and the result line says where.
 */
function discardBackup(backup: string, restored: string): string {
  if (readSafely(backup) === restored) {
    rmSync(backup, { force: true });
    return "";
  }
  return `; kept ${backup}, which no longer matches the restored file`;
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
  return HARNESSES.map((harness): HarnessReach => {
    const registration = harness.read(env.home);
    return {
      harness: harness.id,
      label: harness.label,
      binaryPath: env.which(harness.bin),
      configPath: registration?.configPath,
      command: registration?.command,
      registered: registration !== undefined,
      stale: registration !== undefined && !commandResolves(registration.command[0], env.which),
      note: harness.note,
    };
  });
}

/** One operator-facing line per harness. */
export function formatHarnessResult(result: HarnessResult): string {
  return `  ${result.label.padEnd(12)} ${result.status.padEnd(18)} ${result.detail}`;
}
