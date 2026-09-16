// What `agent-flows uninstall` does (spec 038 D10, FR-031).
//
// Unregistering from every harness always happens — that is what the verb
// means. The two deletions are asked about, one question each, and the answer
// that keeps the data is the default: an empty line, a no, or anything that is
// not an explicit yes all keep it. Nothing here can delete a repository's own
// `.agent-flows` directory or anything inside the installed package.
//
// The prompt layer is injected rather than reached for: a suite that wired
// `process.stdin` would block forever on the first question, and a test that
// forgot to pin AGENT_FLOWS_HOME would offer to delete the developer's own
// workflow library and run history.

import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { userLibraryRoot } from "../canon/layers.js";
import { listPipelines } from "../canon/load.js";
import { stateRoot } from "../runtime/projectState.js";
import { listProjectStateDirs, stopAllDaemons } from "../serve/stop.js";
import { formatHarnessResult, runRemove } from "./harnesses.js";
import type { HarnessResult, SetupEnv } from "./harnesses.js";
import type { StateEnv } from "../runtime/projectState.js";
import type { StopReport } from "../serve/stop.js";

/** The command that removes the package itself — the user's own step afterwards. */
const PACKAGE_REMOVAL = "npm rm -g --prefix ~/.local @rubakas/agent-flows";

/**
 * The terminal, injected.
 *
 * `ask` is absent when standard input is not a terminal: a piped or scripted
 * run then asks nothing and deletes nothing, which is why there is no flag to
 * force a deletion — a script that wants these directories gone can remove them
 * itself.
 */
export interface UninstallIo {
  write: (line: string) => void;
  ask?: (question: string) => Promise<string>;
}

export interface UninstallDeps {
  setupEnv: SetupEnv;
  /** Where the state root is read from. Pinned in tests so no real home is reachable. */
  state: StateEnv;
  io: UninstallIo;
  /** The `stop --all` path, injected so tests never signal a real process. */
  stopAll?: (env: StateEnv) => Promise<StopReport[]>;
}

/** Kept, deleted, or never there to begin with. */
type Fate = "absent" | "kept" | "deleted" | "partly-deleted";

/** Only an explicit yes deletes (D10). */
function isYes(answer: string): boolean {
  const normalized = answer.trim().toLowerCase();
  return normalized === "y" || normalized === "yes";
}

/** How many workflows the personal library holds, counted as the merged view would. */
function countWorkflows(root: string): number {
  try {
    return listPipelines(join(root, "pipelines")).length;
  } catch {
    return 0;
  }
}

/** True when the directory exists and holds nothing. */
function isEmptyDir(path: string): boolean {
  try {
    return readdirSync(path).length === 0;
  } catch {
    return false;
  }
}

/**
 * Ask about the personal workflow library at `<stateRoot>/workflows`.
 *
 * The reassurance about repository workflows is part of the question, not a
 * footnote after it: it is the fact that makes a yes safe to give.
 */
async function offerLibrary(root: string, io: UninstallIo): Promise<Fate> {
  if (!existsSync(root)) return "absent";
  const count = countWorkflows(root);
  io.write("");
  io.write(`Personal workflow library: ${root} (${count} workflow${count === 1 ? "" : "s"})`);
  io.write(
    "Deleting it leaves every workflow committed inside a repository alone — those live in the"
  );
  io.write("repositories, not here, and are never touched by this command.");
  if (io.ask === undefined) return "kept";

  const answer = await io.ask("Delete the personal workflow library? [y/N] ");
  if (!isYes(answer)) return "kept";
  rmSync(root, { recursive: true, force: true });
  return "deleted";
}

/**
 * Ask about the per-project state at `<stateRoot>/projects`.
 *
 * A project whose daemon could not be identified and stopped keeps its state:
 * deleting a database directory out from under a live process is worse than
 * leaving it behind, and the line says which project and why.
 */
async function offerProjects(
  projectsDir: string,
  deps: UninstallDeps,
  io: UninstallIo
): Promise<Fate> {
  if (!existsSync(projectsDir)) return "absent";
  const projects = listProjectStateDirs(deps.state);
  io.write("");
  io.write(
    `Per-project state: ${projectsDir} (${projects.length} project${projects.length === 1 ? "" : "s"})`
  );
  io.write("It holds this machine's databases and the whole run history. Deleting it loses every");
  io.write("run record for every project, and cannot be undone.");
  if (io.ask === undefined) return "kept";

  const answer = await io.ask("Delete the per-project state? [y/N] ");
  if (!isYes(answer)) return "kept";

  const stopAll = deps.stopAll ?? ((env: StateEnv) => stopAllDaemons(env));
  const reports = await stopAll(deps.state);
  const blocked = new Map<string, string>();
  for (const report of reports) {
    if (report.outcome === "stopped") io.write(`  stopped a daemon: ${report.reason}`);
    if (report.outcome === "unresolved") blocked.set(report.stateDir, report.reason);
  }

  for (const dir of projects) {
    const reason = blocked.get(dir);
    if (reason !== undefined) {
      io.write(`  kept ${dir}: ${reason}`);
      continue;
    }
    rmSync(dir, { recursive: true, force: true });
  }

  if (blocked.size > 0) return "partly-deleted";
  // Only when it is empty: anything left is something this command did not put
  // there and has no mandate to remove.
  if (isEmptyDir(projectsDir)) rmSync(projectsDir, { recursive: true, force: true });
  return "deleted";
}

function fateLine(what: string, fate: Fate, path: string): string {
  switch (fate) {
    case "absent":
      return `agent-flows uninstall: ${what} — none at ${path}`;
    case "kept":
      return `agent-flows uninstall: ${what} kept at ${path}`;
    case "partly-deleted":
      return `agent-flows uninstall: ${what} partly deleted — ${path} still holds the projects named above`;
    case "deleted":
      return `agent-flows uninstall: ${what} deleted from ${path}`;
  }
}

/**
 * Unregister, offer the two deletions, and report. Returns the process exit code.
 */
export async function runUninstall(deps: UninstallDeps): Promise<number> {
  const { io } = deps;

  io.write("agent-flows uninstall: removing registrations");
  const results: HarnessResult[] = runRemove(deps.setupEnv);
  for (const result of results) io.write(formatHarnessResult(result));

  const root = stateRoot(deps.state);
  const libraryRoot = userLibraryRoot(deps.state);
  const projectsDir = join(root, "projects");

  if (io.ask === undefined) {
    io.write("");
    io.write("Standard input is not a terminal, so nothing was asked and nothing was deleted.");
  }

  const libraryFate = await offerLibrary(libraryRoot, io);
  const projectsFate = await offerProjects(projectsDir, deps, io);

  const unregistered = results.filter((r) => r.status === "removed").map((r) => r.label);
  io.write("");
  io.write(
    unregistered.length > 0
      ? `agent-flows uninstall: unregistered from ${unregistered.join(", ")}`
      : "agent-flows uninstall: unregistered from nothing — no harness held a registration"
  );
  io.write(fateLine("personal workflow library", libraryFate, libraryRoot));
  io.write(fateLine("per-project state", projectsFate, projectsDir));
  io.write("");
  io.write(
    `Removing the package itself is the next step, and is yours to run:\n  ${PACKAGE_REMOVAL}`
  );

  return results.some((r) => r.status === "failed" || r.status === "refused") ? 1 : 0;
}
