// Finds — or starts — the HTTP daemon that belongs to THIS project
// (spec 038 D8, FR-013/FR-014/FR-015).
//
// Lives in its own module so the whole resolution can be unit-tested: the MCP
// server calls MCPServer.startStdio() at import time, so anything defined there
// is unreachable from a test.

import { spawn } from "node:child_process";
import { closeSync, constants, mkdirSync, openSync, rmSync, statSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { packageVersion } from "../../packageRoot.js";
import {
  classifyIdentity,
  daemonBaseUrl,
  probeDaemon,
  readDaemonRecord,
  sleep,
  type DaemonIdentity,
} from "../../runtime/daemonRecord.js";
import { resolveProjectState } from "../../runtime/projectState.js";

import { resolveProjectDir } from "./projectDir.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** How long auto-start waits for a matching daemon before giving up. */
export const DEFAULT_START_TIMEOUT_MS = 30_000;

/** Delay between polls while waiting for a daemon to come up. */
export const DEFAULT_START_POLL_MS = 150;

/** Age past which a start lock is treated as abandoned by a crashed starter. */
export const DEFAULT_LOCK_STALE_MS = 60_000;

/** Lock file name in the project's state directory (FR-014). */
export const START_LOCK_FILE = "daemon.start.lock";

/**
 * A daemon of OUR project is running a DIFFERENT version of agent-flows.
 *
 * Distinct from every other failure because the resolution is not allowed to
 * recover from it: killing the daemon is forbidden (it may be mid-run) and
 * reusing it would silently run the user's pipelines on the other version's
 * code. The only way out is the user stopping it (FR-015).
 */
export class DaemonVersionMismatchError extends Error {
  constructor(
    readonly runningVersion: string,
    readonly expectedVersion: string,
    readonly projectDir: string
  ) {
    super(
      `agent-flows MCP: a daemon for ${projectDir} is already running version ` +
        `${runningVersion}, but this package is version ${expectedVersion}. ` +
        `It was left running. Run "agent-flows stop" in that project, then retry.`
    );
    this.name = "DaemonVersionMismatchError";
  }
}

/** Injection seams; production callers pass nothing. */
export interface ResolveDaemonDeps {
  projectDir?: string;
  env?: NodeJS.ProcessEnv;
  version?: string;
  probe?: (port: number) => Promise<DaemonIdentity | undefined>;
  /** Starts a detached daemon for `projectDir`. Must not block. */
  spawnDaemon?: (projectDir: string, env: NodeJS.ProcessEnv) => void;
  timeoutMs?: number;
  pollMs?: number;
}

function pinnedPort(env: NodeJS.ProcessEnv): number | undefined {
  const raw = env.AGENT_FLOWS_PORT;
  if (raw === undefined || raw === "") return undefined;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined;
  return port;
}

/**
 * The environment an auto-started daemon is given.
 *
 * AGENT_FLOWS_PORT is dropped on purpose: an auto-started daemon always takes an
 * ephemeral port (FR-012), so it can never collide with whatever is holding the
 * conventional or pinned port (FR-015).
 */
export function daemonChildEnv(projectDir: string, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const { AGENT_FLOWS_PORT: _pinned, ...rest } = env;
  return {
    ...rest,
    AGENT_FLOWS_PROJECT_DIR: projectDir,
    AGENT_FLOWS_AUTOSTART: "1",
    MASTRA_TELEMETRY_DISABLED: "1",
  };
}

/**
 * An append fd on `<stateDir>/daemon.log`, or "ignore" when it cannot be opened.
 *
 * Previously both streams went to /dev/null, so an auto-started daemon's own
 * account of why it stopped — the idle-retirement line above all — was thrown
 * away, and the only remaining symptom was a tool call that could not connect.
 * Deliberately unrotated and unformatted: this is a place for the daemon's
 * output to land, not a logging system.
 */
function daemonLogFd(projectDir: string, env: NodeJS.ProcessEnv): number | "ignore" {
  try {
    const { dir } = resolveProjectState(projectDir, env);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // O_NOFOLLOW: the state dir is owner-only, but a log path is a predictable
    // name and appending through a symlink someone else planted would write the
    // daemon's output wherever it pointed.
    return openSync(
      join(dir, "daemon.log"),
      constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600
    );
  } catch {
    // A daemon that cannot write a log must still start.
    return "ignore";
  }
}

/**
 * Spawn `agent-flows serve` for `projectDir`, detached and unreferenced.
 *
 * The entry point is resolved from this module's own location — the sibling
 * `serve/server` module, run by the interpreter already running us — rather than
 * by looking up `agent-flows` on PATH. A harness spawns the MCP command with its
 * own minimal environment, where PATH may not carry the global bin at all, and
 * `process.execPath` is by construction an interpreter that could load this
 * package (it is running it), so it is also one that can run the daemon.
 */
function spawnDetachedDaemon(projectDir: string, env: NodeJS.ProcessEnv): void {
  const ext = __filename.endsWith(".ts") ? ".ts" : ".js";
  const serverModule = join(__dirname, "..", "..", "serve", `server${ext}`);
  const loader = ext === ".ts" ? ["--import", "tsx/esm"] : [];
  const logFd = daemonLogFd(projectDir, env);
  try {
    const child = spawn(process.execPath, [...loader, serverModule], {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: daemonChildEnv(projectDir, env),
    });
    // Unreferenced so the MCP process can exit while the daemon keeps running.
    child.unref();
  } finally {
    // The child holds its own duplicate; leaving ours open would leak one fd
    // per auto-start for the lifetime of the MCP process — including when the
    // spawn itself throws.
    if (logFd !== "ignore") closeSync(logFd);
  }
}

/**
 * Take the start lock, or report that someone else holds a fresh one (FR-014).
 *
 * `wx` is O_EXCL: the create either wins or fails with EEXIST, atomically across
 * processes. A lock older than `staleMs` was left by a starter that died before
 * releasing it — without reclaiming those, one crash would wedge the project's
 * auto-start forever.
 */
export function acquireStartLock(lockPath: string, staleMs: number): boolean {
  const take = (): boolean => {
    try {
      const fd = openSync(lockPath, "wx", 0o600);
      try {
        writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
      } finally {
        closeSync(fd);
      }
      return true;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      return false;
    }
  };

  if (take()) return true;

  let heldSince: number;
  try {
    heldSince = statSync(lockPath).mtimeMs;
  } catch {
    // Released between the failed create and the stat — try once more.
    return take();
  }
  if (Date.now() - heldSince < staleMs) return false;

  rmSync(lockPath, { force: true });
  return take();
}

/**
 * Probe the ports this project could be on and return the one that is ours.
 *
 * AGENT_FLOWS_PORT, when set, is probed first so an explicitly configured daemon
 * keeps working; the recorded port is probed next, which is how an auto-started
 * daemon on an ephemeral port is found at all. Anything that answers with a
 * different project — or does not answer — is simply not ours.
 */
export async function findOurDaemon(deps: ResolveDaemonDeps = {}): Promise<number | undefined> {
  const env = deps.env ?? process.env;
  const projectDir = deps.projectDir ?? resolveProjectDir();
  const version = deps.version ?? packageVersion();
  const probe = deps.probe ?? ((port: number) => probeDaemon(port));
  const state = resolveProjectState(projectDir, env);

  const candidates: number[] = [];
  const pinned = pinnedPort(env);
  if (pinned !== undefined) candidates.push(pinned);
  const record = readDaemonRecord(state.dir);
  if (record !== undefined && !candidates.includes(record.port)) candidates.push(record.port);

  for (const port of candidates) {
    const identity = await probe(port);
    if (identity === undefined) continue;
    const verdict = classifyIdentity(identity, { projectDir, version });
    if (verdict === "match") return port;
    if (verdict === "other-version") {
      throw new DaemonVersionMismatchError(identity.version, version, projectDir);
    }
  }
  return undefined;
}

/**
 * The port of this project's daemon, starting one if there is none (FR-013/FR-014).
 *
 * Racing MCP processes are serialized by the state dir's start lock: the winner
 * spawns, the loser waits for the winner's daemon instead of starting a second
 * one. Both then poll the same identity check, so neither returns until a daemon
 * that is provably ours is answering.
 */
export async function resolveDaemonPort(deps: ResolveDaemonDeps = {}): Promise<number> {
  const env = deps.env ?? process.env;
  const projectDir = deps.projectDir ?? resolveProjectDir();
  const version = deps.version ?? packageVersion();
  const timeoutMs = deps.timeoutMs ?? DEFAULT_START_TIMEOUT_MS;
  const pollMs = deps.pollMs ?? DEFAULT_START_POLL_MS;
  const spawnDaemon = deps.spawnDaemon ?? spawnDetachedDaemon;
  const search = { ...deps, env, projectDir, version };

  const found = await findOurDaemon(search);
  if (found !== undefined) return found;

  const state = resolveProjectState(projectDir, env);
  mkdirSync(state.dir, { recursive: true, mode: 0o700 });
  const lockPath = join(state.dir, START_LOCK_FILE);
  const holdsLock = acquireStartLock(lockPath, DEFAULT_LOCK_STALE_MS);

  try {
    if (holdsLock) spawnDaemon(projectDir, env);

    const deadline = Date.now() + timeoutMs;
    for (;;) {
      await sleep(pollMs);
      const port = await findOurDaemon(search);
      if (port !== undefined) return port;
      if (Date.now() >= deadline) break;
    }
  } finally {
    if (holdsLock) rmSync(lockPath, { force: true });
  }

  throw new Error(
    `agent-flows MCP: no daemon for ${projectDir} after ${timeoutMs}ms. ` +
      `Tried: the port recorded in ${join(state.dir, "daemon.json")}` +
      `${pinnedPort(env) !== undefined ? `, AGENT_FLOWS_PORT=${String(pinnedPort(env))}` : ""}, ` +
      `and ${holdsLock ? "starting one" : "waiting for another process that was starting one"}. ` +
      `Start it by hand with "agent-flows serve" in that project to see why it fails.`
  );
}

/**
 * Memoized per (project, pinned port) so the tools resolve once per process and
 * every later call is a plain lookup — a chat session makes many tool calls and
 * must not re-probe (or re-race the start lock) on each one. A failed resolution
 * is not cached: the next tool call gets a fresh attempt.
 */
const inFlight = new Map<string, Promise<number>>();

export async function resolveDaemonBase(deps: ResolveDaemonDeps = {}): Promise<string> {
  const env = deps.env ?? process.env;
  const projectDir = deps.projectDir ?? resolveProjectDir();
  const key = `${projectDir}|${env.AGENT_FLOWS_PORT ?? ""}`;
  let pending = inFlight.get(key);
  if (pending === undefined) {
    pending = resolveDaemonPort({ ...deps, env, projectDir });
    inFlight.set(key, pending);
    pending.catch(() => inFlight.delete(key));
  }
  return daemonBaseUrl(await pending);
}

/** Drop the memoized resolutions. Exported for tests. */
export function clearDaemonBaseCache(): void {
  inFlight.clear();
}
