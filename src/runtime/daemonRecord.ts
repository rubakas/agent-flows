// Daemon identity, its on-disk record, and the probe that verifies it
// (spec 038 D8, FR-011/FR-013/FR-015/FR-016).
//
// The daemon bakes its project directory in at process start: `resolveProjectDir()`
// runs once and every route reads `ctx.projectDir`; no route takes a project from
// the request. Reusing a daemon that belongs to a DIFFERENT project would
// therefore execute the caller's steps with the wrong working directory and write
// run artifacts into the wrong repository. The identity handshake below — the
// reported projectDir realpath AND the reported package version, both equal to
// the caller's own — is the only thing standing between the user and that.
//
// This module is shared by the daemon (which writes the record), the MCP process
// (which reads and probes it) and `agent-flows stop` (which verifies before it
// kills), so it imports nothing from any of them.

import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** What `GET /api/daemon` reports about the process answering it (FR-011). */
export interface DaemonIdentity {
  projectDir: string;
  version: string;
  pid: number;
  startedAt: string;
}

/** `<stateDir>/daemon.json`: the identity plus the port it is listening on (FR-011). */
export interface DaemonRecord extends DaemonIdentity {
  port: number;
}

/** File name of the record inside the per-project state directory. */
export const DAEMON_RECORD_FILE = "daemon.json";

/** Path of the record for a project's state directory. */
export function daemonRecordPath(stateDir: string): string {
  return join(stateDir, DAEMON_RECORD_FILE);
}

/** Realpath when the directory exists, lexical resolution otherwise. */
export function realPathOf(dir: string): string {
  try {
    return realpathSync(dir);
  } catch {
    return resolve(dir);
  }
}

/**
 * Write `<stateDir>/daemon.json` at listen time, mode 0600 (FR-011).
 *
 * The state directory is created if absent: `resolveProjectState` is pure, so a
 * daemon started against a never-used project would otherwise fail here.
 */
export function writeDaemonRecord(stateDir: string, record: DaemonRecord): void {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  writeFileSync(daemonRecordPath(stateDir), JSON.stringify(record, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
}

/**
 * Read the record, or undefined when it is absent, unreadable, malformed, or
 * not shaped like a record. A corrupt file means "no daemon we know of", never
 * an exception: every caller's next move is the same either way.
 */
export function readDaemonRecord(stateDir: string): DaemonRecord | undefined {
  const path = daemonRecordPath(stateDir);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const rec = parsed as Record<string, unknown>;
  if (
    typeof rec.projectDir !== "string" ||
    typeof rec.version !== "string" ||
    typeof rec.startedAt !== "string" ||
    typeof rec.pid !== "number" ||
    typeof rec.port !== "number"
  ) {
    return undefined;
  }
  return {
    projectDir: rec.projectDir,
    version: rec.version,
    pid: rec.pid,
    startedAt: rec.startedAt,
    port: rec.port,
  };
}

/**
 * Remove the record on graceful exit, but only when it is still ours (FR-011).
 *
 * A daemon that crashed leaves its record behind; the next daemon for the same
 * project overwrites it. If the crashed daemon's exit path ever ran afterwards —
 * or if a `stop` and a restart interleave — an unconditional unlink would delete
 * the live daemon's record and make it unreachable. Reading the file back and
 * comparing the pid is what makes removal safe to call at any time.
 */
export function removeDaemonRecordIfOwned(stateDir: string, pid: number): boolean {
  const record = readDaemonRecord(stateDir);
  if (record === undefined) return false;
  if (record.pid !== pid) return false;
  rmSync(daemonRecordPath(stateDir), { force: true });
  return true;
}

/** Loopback base URL for a daemon port. */
export function daemonBaseUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}

/**
 * Probe `GET /api/daemon` on a loopback port.
 *
 * Returns the identity when the port answers with our shape, and undefined for
 * every other outcome — connection refused, a timeout, a non-200, a body that is
 * not JSON, a JSON body that is not an identity. Whatever else is listening
 * there is not ours, and is left alone (FR-015).
 */
export async function probeDaemon(
  port: number,
  timeoutMs = 2_000
): Promise<DaemonIdentity | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${daemonBaseUrl(port)}/api/daemon`, { signal: controller.signal });
    if (!res.ok) return undefined;
    const body: unknown = await res.json();
    if (typeof body !== "object" || body === null) return undefined;
    const id = body as Record<string, unknown>;
    if (
      typeof id.projectDir !== "string" ||
      typeof id.version !== "string" ||
      typeof id.pid !== "number" ||
      typeof id.startedAt !== "string"
    ) {
      return undefined;
    }
    return {
      projectDir: id.projectDir,
      version: id.version,
      pid: id.pid,
      startedAt: id.startedAt,
    };
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/** Outcome of comparing a probed identity against what the caller expects. */
export type IdentityVerdict = "match" | "other-project" | "other-version";

/**
 * Compare a probed identity against the caller's project and version (FR-013).
 *
 * The project comparison is by realpath on both sides: `/tmp` is a symlink to
 * `/private/tmp` on macOS, so two spellings of the same directory must not read
 * as two different projects.
 */
export function classifyIdentity(
  identity: DaemonIdentity,
  expected: { projectDir: string; version: string }
): IdentityVerdict {
  if (realPathOf(identity.projectDir) !== realPathOf(expected.projectDir)) return "other-project";
  if (identity.version !== expected.version) return "other-version";
  return "match";
}

/** True when the state directory currently holds a record. */
export function hasDaemonRecord(stateDir: string): boolean {
  return existsSync(daemonRecordPath(stateDir));
}
