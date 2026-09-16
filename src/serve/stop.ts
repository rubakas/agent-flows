// `agent-flows stop` / `agent-flows stop --all` (spec 038 D9, FR-016).
//
// Auto-started daemons (D8) outlive the chat session that spawned them, hold an
// open sqlite handle, and after an upgrade keep serving old code forever. This
// verb is how they are accounted for.
//
// A recorded pid is never killed on the strength of the record alone: pids are
// recycled by the operating system, so a stale daemon.json naming a pid that now
// belongs to someone else's process would otherwise make `stop` a random
// process killer. The process at the recorded port must first answer
// `GET /api/daemon` with the recorded pid and project.

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveProjectDir } from "../bindings/mastra/projectDir.js";
import {
  daemonRecordPath,
  probeDaemon,
  readDaemonRecord,
  removeDaemonRecordIfOwned,
  sameProject,
  sleep,
  type DaemonIdentity,
} from "../runtime/daemonRecord.js";
import { resolveProjectState, stateRoot, type StateEnv } from "../runtime/projectState.js";

/**
 * How certain we are that no daemon is holding this project's state.
 *
 * `no-daemon` means that was established — there is no record, or nothing
 * answers the recorded port. `unresolved` means it could not be: a malformed
 * record, a port held by someone we cannot identify, or a daemon that outlived
 * its SIGTERM. A caller about to delete the state directory must treat
 * `unresolved` as "a live daemon may still own this" (D10).
 */
export type StopOutcome = "stopped" | "no-daemon" | "unresolved";

/** What happened to one project's recorded daemon. */
export interface StopReport {
  stateDir: string;
  stopped: boolean;
  outcome: StopOutcome;
  reason: string;
  projectDir?: string;
  port?: number;
  pid?: number;
}

/** Seams so the kill path and the wait loop are testable without real daemons. */
export interface StopDeps {
  probe?: (port: number) => Promise<DaemonIdentity | undefined>;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  /** Total time to wait for a terminated daemon to stop answering. */
  waitMs?: number;
  /** Delay between liveness polls while waiting. */
  pollMs?: number;
}

const DEFAULT_WAIT_MS = 5_000;
const DEFAULT_LIVENESS_POLL_MS = 100;

/**
 * Verify, terminate and forget the daemon recorded in one state directory.
 *
 * Never throws for an ordinary refusal: a missing record, an unanswered port and
 * an identity mismatch are all reported, because `stop --all` must keep going
 * across every project on the machine.
 */
export async function stopProjectDaemon(
  stateDir: string,
  deps: StopDeps = {}
): Promise<StopReport> {
  const probe = deps.probe ?? ((port: number) => probeDaemon(port));
  const kill = deps.kill ?? ((pid: number, signal: NodeJS.Signals) => process.kill(pid, signal));
  const waitMs = deps.waitMs ?? DEFAULT_WAIT_MS;
  const pollMs = deps.pollMs ?? DEFAULT_LIVENESS_POLL_MS;

  const record = readDaemonRecord(stateDir);
  if (record === undefined) {
    const present = existsSync(daemonRecordPath(stateDir));
    return {
      stateDir,
      stopped: false,
      outcome: present ? "unresolved" : "no-daemon",
      reason: present
        ? `${daemonRecordPath(stateDir)} is unreadable or malformed — left it alone`
        : "no daemon.json — no daemon was recorded for this project",
    };
  }

  const base = { stateDir, projectDir: record.projectDir, port: record.port, pid: record.pid };
  const identity = await probe(record.port);
  if (identity === undefined) {
    return {
      ...base,
      stopped: false,
      outcome: "no-daemon",
      reason:
        `nothing answered GET /api/daemon on port ${record.port} — ` +
        `the record is stale and pid ${record.pid} was NOT signalled`,
    };
  }
  if (identity.pid !== record.pid) {
    return {
      ...base,
      stopped: false,
      outcome: "unresolved",
      reason:
        `port ${record.port} is held by pid ${identity.pid}, not the recorded pid ` +
        `${record.pid} — nothing was signalled`,
    };
  }
  if (!sameProject(identity.projectDir, record.projectDir)) {
    return {
      ...base,
      stopped: false,
      outcome: "unresolved",
      reason:
        `the daemon on port ${record.port} serves ${identity.projectDir}, not the recorded ` +
        `${record.projectDir} — nothing was signalled`,
    };
  }

  kill(record.pid, "SIGTERM");

  const deadline = Date.now() + waitMs;
  for (;;) {
    const still = await probe(record.port);
    if (still?.pid !== record.pid) break;
    if (Date.now() >= deadline) {
      return {
        ...base,
        stopped: false,
        outcome: "unresolved",
        reason: `pid ${record.pid} was sent SIGTERM but is still answering on port ${record.port}`,
      };
    }
    await sleep(pollMs);
  }

  // The daemon removes its own record on a graceful exit; this covers the case
  // where it died before reaching that path. Ownership is re-checked, so a
  // daemon that has already replaced the record keeps it.
  removeDaemonRecordIfOwned(stateDir, record.pid);
  return {
    ...base,
    stopped: true,
    outcome: "stopped",
    reason: `stopped pid ${record.pid} serving ${record.projectDir} on port ${record.port}`,
  };
}

/** Every per-project state directory under the state root, in listing order. */
export function listProjectStateDirs(env: StateEnv = process.env): string[] {
  const projectsDir = join(stateRoot(env), "projects");
  let entries: string[];
  try {
    entries = readdirSync(projectsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => join(projectsDir, e.name));
  } catch {
    return [];
  }
  return entries.sort((a, b) => a.localeCompare(b));
}

/** `stop --all`: the same verification and termination for every project (FR-016). */
export async function stopAllDaemons(
  env: StateEnv = process.env,
  deps: StopDeps = {}
): Promise<StopReport[]> {
  const reports: StopReport[] = [];
  for (const dir of listProjectStateDirs(env)) {
    reports.push(await stopProjectDaemon(dir, deps));
  }
  return reports;
}

/** One operator-facing line per project. */
export function formatStopReport(report: StopReport): string {
  return `agent-flows stop: ${report.stopped ? "stopped" : "skipped"} ${report.stateDir}: ${report.reason}`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const all = process.argv.includes("--all");
  const reports = all
    ? await stopAllDaemons()
    : [await stopProjectDaemon(resolveProjectState(resolveProjectDir()).dir)];

  if (reports.length === 0) {
    console.log("agent-flows stop: no project state directories found — nothing to stop");
  }
  for (const report of reports) console.log(formatStopReport(report));
}
