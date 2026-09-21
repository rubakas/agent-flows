// Cross-project daemon enumeration for the page (spec 042 D2, D3, FR-001).
//
// Two agent-flows daemons once ran for over two days — one from a global
// install, one from a checkout — with the owner aware of neither, reading a
// page served by a stale build. This module is what makes them visible: every
// per-project state directory on the machine, the daemon each one recorded, and
// whether that record still names a live process.
//
// A record is never trusted on its own. Pids are recycled by the operating
// system, so a stale daemon.json naming a pid that now belongs to someone else's
// process would otherwise be reported as a running daemon and offered a Stop
// button wired to a stranger. The port is probed with `GET /api/daemon` and the
// answer's pid AND project must both match the record — the same rule
// `stopProjectDaemon` enforces before it signals anything (`stop.ts:94-124`).
//
// Reading is all this does. It never writes into another project's state
// directory and never dispatches a run there; the only cross-project mutation
// in this spec is the explicit stop route, which delegates to stop.ts.

import { basename } from "node:path";

import { probeDaemon, readDaemonRecord, sameProject } from "../runtime/daemonRecord.js";
import { listProjectStateDirs } from "./stop.js";
import type { DaemonIdentity } from "../runtime/daemonRecord.js";

/** One project's recorded daemon, as `GET /api/daemons` reports it (FR-001). */
export interface DaemonListEntry {
  /** The per-project state directory holding this record. */
  stateDir: string;
  /** Its directory name — the key the stop route addresses this project by. */
  projectKey: string;
  projectDir: string;
  pid: number;
  port: number;
  startedAt: string;
  version: string;
  /** True only when the probe's pid and projectDir both match the record (D3). */
  live: boolean;
  /**
   * True when this record names the daemon serving the page (D9). Stopping it
   * succeeds at the process level but leaves the page with nobody to ask for a
   * fresh state, so the UI must not claim a `stopped` it cannot observe.
   */
  self: boolean;
  /** Why the record is not live, in the operator's words. Absent when it is. */
  staleReason?: string;
}

/** Seam so the probe is testable without binding real ports. */
export interface ListDaemonsDeps {
  probe?: (port: number) => Promise<DaemonIdentity | undefined>;
  /** The caller's own identity, so its row can be marked `self` (D9). */
  self?: { pid: number; projectDir: string };
}

/**
 * Verify one state directory's record against the process at its recorded port.
 *
 * Mirrors `stopProjectDaemon`'s three refusal branches — nothing answering, a
 * different pid, a different project — because a row the page offers a Stop on
 * must have passed exactly the checks the stop itself will repeat.
 */
async function classify(
  stateDir: string,
  probe: (port: number) => Promise<DaemonIdentity | undefined>,
  self: { pid: number; projectDir: string } | undefined
): Promise<DaemonListEntry | undefined> {
  const record = readDaemonRecord(stateDir);
  if (record === undefined) return undefined;

  const base: Omit<DaemonListEntry, "live"> = {
    stateDir,
    projectKey: basename(stateDir),
    projectDir: record.projectDir,
    pid: record.pid,
    port: record.port,
    startedAt: record.startedAt,
    version: record.version,
    self: self?.pid === record.pid && sameProject(self.projectDir, record.projectDir),
  };

  const identity = await probe(record.port);
  if (identity === undefined) {
    return {
      ...base,
      live: false,
      staleReason: `nothing answered on port ${record.port}`,
    };
  }
  if (identity.pid !== record.pid) {
    return {
      ...base,
      live: false,
      staleReason: `port ${record.port} is held by pid ${identity.pid}, not the recorded ${record.pid}`,
    };
  }
  if (!sameProject(identity.projectDir, record.projectDir)) {
    return {
      ...base,
      live: false,
      staleReason: `the daemon on port ${record.port} serves ${identity.projectDir}, not ${record.projectDir}`,
    };
  }
  return { ...base, live: true };
}

/**
 * Every recorded daemon under `stateHome`, verified (FR-001, D2, D3).
 *
 * A project with no readable `daemon.json` has nothing to report and is omitted;
 * a project whose record is present but unverifiable is reported with
 * `live: false` and never omitted, because a stale record left by a crashed
 * daemon is precisely the thing the operator needs to see.
 *
 * Probes run concurrently: each carries its own two-second timeout, and a dozen
 * dead ports serialised would make the page wait half a minute.
 */
export async function listDaemons(
  stateHome: string,
  deps: ListDaemonsDeps = {}
): Promise<DaemonListEntry[]> {
  const probe = deps.probe ?? ((port: number) => probeDaemon(port));
  const dirs = listProjectStateDirs({ AGENT_FLOWS_HOME: stateHome });
  const entries = await Promise.all(dirs.map((dir) => classify(dir, probe, deps.self)));
  return entries.filter((e): e is DaemonListEntry => e !== undefined);
}
