// The run and step status vocabulary, in one place (spec 047 FR-11).
//
// Pure: no I/O. Four readers used to hold their own copy of "which statuses
// mean what" — the idle self-exit, the MCP poll loop, the artifact handoff and
// the daemon-down fallback — and they could drift apart silently. They ask
// here instead.
//
// The predicates take `string`, not the unions: a status arrives from disk or
// the wire, and an artifact written by another version may carry one this
// build has never heard of. Such a status is simply none of the sets below.

/** A step's status in the record-level accumulator (see StepState in runService). */
export type StepStatus = "started" | "suspended" | "succeeded" | "failed" | "cancelled";

/** A run's status while the daemon holds it, or as its artifact recorded it. */
export type RunStatus =
  "running" | "awaiting_approval" | "succeeded" | "rejected" | "failed" | "cancelled";

/** What a reader can report: a run status, or "the artifact could not be parsed". */
export type ReadStatus = RunStatus | "unreadable";

/** Where a run's state came from: this daemon's registry, or its artifact on disk. */
export type RunSource = "live" | "disk";

/**
 * What a reader may conclude about a run.
 *
 * - live: executing in this daemon.
 * - awaiting: suspended at a gate in this daemon, so it can be approved.
 * - terminal: settled; nothing will change.
 * - restored: the artifact says running/awaiting but a daemon is up that does
 *   not hold the run — it cannot be advanced or approved.
 * - orphaned: same, with no daemon at all.
 * - unreadable: the artifact would not parse.
 */
export type RunPhase = "live" | "awaiting" | "terminal" | "restored" | "orphaned" | "unreadable";

const RUNNING_OR_AWAITING: ReadonlySet<string> = new Set(["running", "awaiting_approval"]);

const SETTLED: ReadonlySet<string> = new Set(["succeeded", "rejected", "failed", "cancelled"]);

/** The statuses an artifact may be handed to the next stage at (spec 029 FR-003). */
const CHAINABLE: ReadonlySet<string> = new Set([
  "succeeded",
  "awaiting_approval",
  "failed",
  "rejected",
]);

/**
 * Whether a run has stopped advancing on its own: at a gate, settled, or
 * unreadable. `run_pipeline` polls until this is true. "cancelled" belongs here
 * because a cancelled run never resumes (spec 033 FR-010), and "unreadable"
 * because a run whose artifact will not parse never changes either.
 */
export function hasStopped(status: string): boolean {
  return status === "awaiting_approval" || status === "unreadable" || SETTLED.has(status);
}

/**
 * Whether this run must keep its daemon alive: executing, or suspended at a
 * gate, AND held by this process. A run persisted as `running` by a process
 * that was killed stays `running` on disk forever; counting it would pin every
 * future daemon for the project open on the strength of an old crash.
 */
export function isInFlight(run: { status: string; source: string }): boolean {
  return run.source === "live" && RUNNING_OR_AWAITING.has(run.status);
}

/** Whether an artifact at this status may seed a following stage. */
export function isChainable(status: string): boolean {
  return CHAINABLE.has(status);
}

/**
 * Classify a run for a reader. `daemonUp` says whether a daemon is there to
 * answer at all; it only matters for a disk run that claims to be in flight.
 */
export function runPhase(run: { status: string; source: string }, daemonUp = true): RunPhase {
  if (run.status === "unreadable") return "unreadable";
  if (!RUNNING_OR_AWAITING.has(run.status)) return "terminal";
  if (run.source === "live") return run.status === "running" ? "live" : "awaiting";
  return daemonUp ? "restored" : "orphaned";
}
