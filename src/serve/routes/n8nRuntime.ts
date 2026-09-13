// n8n process lifecycle: is it installed, is it running, start it, stop it
// (spec 034 D10, FR-015..FR-020).
//
// A per-resource module: only ever invoked from server.ts's handleRequest,
// after the Host/content-type/Origin preamble has already run — so the POST
// routes here inherit the daemon's CSRF protection.
//
// Nothing in this module reads, writes or logs the n8n API key. It only needs
// the base URL, which readN8nConfig() validates.

import { spawn } from "node:child_process";
import {
  accessSync,
  constants,
  existsSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { json } from "../route-helpers.js";
import { readN8nConfig } from "./n8n.js";
import type { ServerResponse } from "node:http";

/** Where n8n listens when nothing is configured — n8n's own default. */
export const DEFAULT_N8N_BASE_URL = "http://localhost:5678";

/**
 * Health-probe budget (FR-016). A daemon that is starting up, wedged, or
 * answering on a port someone else holds must not hold this request open: the
 * Settings card polls this route every 5 s, so a probe without a ceiling would
 * queue requests faster than they drain.
 */
export const PROBE_TIMEOUT_MS = 2_000;

/** How long POST /api/n8n/start waits for a freshly spawned n8n to answer (FR-017). */
export const START_TIMEOUT_MS = 60_000;

/** Gap between health polls while waiting for a starting n8n. */
export const START_POLL_INTERVAL_MS = 1_000;

/** Grace period between SIGTERM and SIGKILL in stop (FR-018). */
export const STOP_GRACE_MS = 10_000;

/** How n8n would be launched on this machine. */
export interface N8nInstall {
  /** "path": a real `n8n` binary; "npx": launched through npx; "none": neither. */
  how: "path" | "npx" | "none";
  /** Human-readable detail — the resolved binary path, or what npx implies. */
  detail: string;
}

/** A command to spawn, split for `spawn()` so no shell is involved. */
export interface LaunchSpec {
  command: string;
  args: string[];
}

/** Injection points, so tests can start a stand-in process instead of real n8n. */
export interface N8nRuntimeDeps {
  /** What to spawn. Default: `n8n start` when on PATH, else `npx n8n start`. */
  resolveLaunch?: () => LaunchSpec | undefined;
  /** Overall wait for /healthz after spawning. Default START_TIMEOUT_MS. */
  startTimeoutMs?: number;
  /** Poll gap while waiting. Default START_POLL_INTERVAL_MS. */
  pollIntervalMs?: number;
  /** SIGTERM→SIGKILL grace. Default STOP_GRACE_MS. */
  stopGraceMs?: number;
}

/** Path of the pid file recording the n8n this daemon started (FR-018). */
export function pidFilePath(stateDir: string): string {
  return join(stateDir, "n8n.pid");
}

/** Path of the log file the spawned n8n's output is appended to. */
export function logFilePath(stateDir: string): string {
  return join(stateDir, "n8n.log");
}

/** Find an executable of this name on PATH, or undefined. */
function findOnPath(name: string, env: NodeJS.ProcessEnv): string | undefined {
  const pathValue = env.PATH ?? "";
  for (const dir of pathValue.split(":")) {
    if (!dir) continue;
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // not here, or not executable — keep looking
    }
  }
  return undefined;
}

/**
 * How n8n can be launched here (FR-015).
 *
 * Reports the npx path honestly: on this machine n8n is not installed globally,
 * so the first launch downloads it into the npx cache, which takes minutes and
 * would otherwise look like a hung Start button.
 */
export function detectN8nInstall(env: NodeJS.ProcessEnv = process.env): N8nInstall {
  const direct = findOnPath("n8n", env);
  if (direct) return { how: "path", detail: direct };
  const npx = findOnPath("npx", env);
  if (npx) {
    return {
      how: "npx",
      detail: `${npx} n8n start — npx downloads n8n on first use, which can take several minutes`,
    };
  }
  return { how: "none", detail: "neither n8n nor npx found on PATH" };
}

/** Default launch command, derived from the same detection the card shows. */
export function defaultLaunch(env: NodeJS.ProcessEnv = process.env): LaunchSpec | undefined {
  const install = detectN8nInstall(env);
  if (install.how === "path") return { command: install.detail, args: ["start"] };
  if (install.how === "npx") return { command: "npx", args: ["n8n", "start"] };
  return undefined;
}

/** The base URL to probe: the configured one (env or file) or n8n's default. */
export function resolveN8nBaseUrl(): string {
  // FR-020: AGENT_FLOWS_N8N_URL wins, and readN8nConfig applies that precedence.
  return readN8nConfig()?.baseUrl ?? DEFAULT_N8N_BASE_URL;
}

/**
 * Probe `<baseUrl>/healthz` (FR-016).
 *
 * No credentials are sent: /healthz is unauthenticated, and attaching the API
 * key to a URL that may point anywhere would leak it to whatever answers.
 */
export async function probeN8nHealth(
  baseUrl: string,
  timeoutMs: number = PROBE_TIMEOUT_MS
): Promise<{ running: boolean; probeMs: number }> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl}/healthz`, {
      signal: controller.signal,
      redirect: "manual",
    });
    return { running: res.ok, probeMs: Date.now() - started };
  } catch {
    // Refused, unreachable, or past the timeout — all mean "not running here".
    return { running: false, probeMs: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

/** True when a process with this pid exists and we may signal it. */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to someone else — which for a
    // pid file written under the 0700 state dir should never happen, and is not
    // a process this daemon may stop either way.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * The pid of the n8n this daemon started, if it is still alive.
 *
 * The pid file IS the ownership record (FR-018): it lives inside the state dir,
 * which is created 0700 and owner-only, so a pid file there was written by this
 * daemon (in this life or a previous one) and by nothing else. A pid that is no
 * longer alive is not owned — the number may have been recycled by an unrelated
 * process, and signalling it would kill a stranger.
 */
export function readOwnedPid(stateDir: string): number | undefined {
  const path = pidFilePath(stateDir);
  if (!existsSync(path)) return undefined;
  try {
    const pid = Number.parseInt(readFileSync(path, "utf8").trim(), 10);
    if (!Number.isInteger(pid) || pid <= 0) return undefined;
    return isPidAlive(pid) ? pid : undefined;
  } catch {
    return undefined;
  }
}

/** GET /api/n8n/runtime (FR-015/FR-016). */
export async function handleN8nRuntime(res: ServerResponse, stateDir: string): Promise<void> {
  const baseUrl = resolveN8nBaseUrl();
  const { running, probeMs } = await probeN8nHealth(baseUrl);
  const ownedPid = readOwnedPid(stateDir);
  json(res, 200, {
    installed: detectN8nInstall(),
    running,
    baseUrl,
    probeMs,
    ...(ownedPid !== undefined ? { ownedPid } : {}),
    ...(existsSync(logFilePath(stateDir)) ? { log: logFilePath(stateDir) } : {}),
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** POST /api/n8n/start (FR-017). */
export async function handleN8nStart(
  res: ServerResponse,
  stateDir: string,
  deps: N8nRuntimeDeps = {}
): Promise<void> {
  const baseUrl = resolveN8nBaseUrl();
  const already = await probeN8nHealth(baseUrl);
  if (already.running) {
    json(res, 409, { running: true, baseUrl, error: `n8n already answers at ${baseUrl}` });
    return;
  }

  const launch = (deps.resolveLaunch ?? (() => defaultLaunch()))();
  if (!launch) {
    json(res, 503, {
      error: "n8n cannot be started: neither n8n nor npx is on PATH",
      installed: detectN8nInstall(),
    });
    return;
  }

  const log = logFilePath(stateDir);
  let child;
  try {
    // Append: a restart must not erase the log of the crash that caused it.
    const logFd = openSync(log, "a", 0o600);
    child = spawn(launch.command, launch.args, {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      // No credentials are passed: n8n reads its own ~/.n8n, and our API key
      // has nothing to do with launching the process.
      env: process.env,
    });
    child.unref();
  } catch (err) {
    json(res, 500, { error: `Failed to spawn n8n: ${(err as Error).message}`, log });
    return;
  }

  const pid = child.pid;
  if (pid === undefined) {
    json(res, 500, { error: "n8n was spawned but reported no pid", log });
    return;
  }
  writeFileSync(pidFilePath(stateDir), String(pid), { encoding: "utf8", mode: 0o600 });

  const deadline = Date.now() + (deps.startTimeoutMs ?? START_TIMEOUT_MS);
  const interval = deps.pollIntervalMs ?? START_POLL_INTERVAL_MS;
  for (;;) {
    await sleep(interval);
    const probe = await probeN8nHealth(baseUrl);
    if (probe.running) {
      json(res, 200, { running: true, baseUrl, pid, log });
      return;
    }
    if (Date.now() >= deadline) break;
  }

  // 202: the process is ours and still alive, it just has not answered yet.
  // Through npx a first run downloads n8n, so this is an expected outcome, not
  // a failure — the log path is where the operator watches it finish.
  json(res, 202, { running: false, baseUrl, pid, log });
}

/** POST /api/n8n/stop (FR-018). */
export async function handleN8nStop(
  res: ServerResponse,
  stateDir: string,
  deps: N8nRuntimeDeps = {}
): Promise<void> {
  const path = pidFilePath(stateDir);
  const pid = readOwnedPid(stateDir);
  if (pid === undefined) {
    // Clear a stale record so the card stops offering Stop for a dead pid.
    if (existsSync(path)) rmSync(path, { force: true });
    json(res, 409, {
      error:
        "No n8n process started by this daemon is running — agent-flows only stops what it started",
    });
    return;
  }

  process.kill(pid, "SIGTERM");

  const deadline = Date.now() + (deps.stopGraceMs ?? STOP_GRACE_MS);
  while (isPidAlive(pid) && Date.now() < deadline) {
    await sleep(100);
  }
  let killed = false;
  if (isPidAlive(pid)) {
    process.kill(pid, "SIGKILL");
    killed = true;
  }
  rmSync(path, { force: true });
  json(res, 200, { stopped: true, pid, killed });
}
