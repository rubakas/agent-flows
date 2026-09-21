// When an auto-started daemon is allowed to stop (spec 042 D11).
//
// The MCP process spawns a daemon for a project that has none, detached and
// unreferenced, so the run survives the chat that started it. Nothing then ever
// stops it: the chat exits, its ephemeral port is never dialled again, and the
// daemon runs until the machine reboots. Two such daemons once ran for two days
// unnoticed, which is the incident the daemons panel already exists to surface —
// this is the other half, so they stop accumulating in the first place.
//
// A daemon a human started with `agent-flows serve` is never a candidate. That
// one has an owner who expects it to stay up, and its port is the conventional
// one they will dial again.

/** Milliseconds of quiet before an auto-started daemon with no work stops. */
export const DEFAULT_IDLE_MS = 15 * 60_000;

/** How often the check runs. Coarse on purpose: this is housekeeping, not a deadline. */
export const IDLE_CHECK_MS = 60_000;

/**
 * Overrides the idle span, in milliseconds.
 *
 * Exists because the exit path ends the process, so it can only be observed
 * from outside — a test has to spawn a real daemon and cannot pass options to
 * it. Not a documented knob.
 */
export const IDLE_MS_ENV = "AGENT_FLOWS_IDLE_MS";

/**
 * How often to check, for a given span.
 *
 * Never less often than the span itself: a 60s cadence against a 400ms span
 * would make the span meaningless, and that is exactly the shape a test uses.
 */
export function idleCheckIntervalMs(idleMs: number): number {
  return Math.max(1, Math.min(IDLE_CHECK_MS, idleMs));
}

export interface IdleInputs {
  /** True only for a daemon the MCP process spawned (`AGENT_FLOWS_AUTOSTART=1`). */
  autostarted: boolean;
  /** Milliseconds since the last HTTP request this daemon served. */
  msSinceLastRequest: number;
  /**
   * Runs this process is still carrying: executing, or suspended at a gate.
   *
   * A run waiting for a human counts. Exiting under it would leave a gate that
   * can never be approved, which is worse than an idle process.
   */
  inFlight: number;
  idleMs: number;
}

/**
 * Whether this daemon should stop now.
 *
 * Pure so the policy can be tested without timers, sockets or a clock.
 */
export function shouldExitWhenIdle(i: IdleInputs): boolean {
  if (!i.autostarted) return false;
  if (i.inFlight > 0) return false;
  return i.msSinceLastRequest >= i.idleMs;
}

/** What `RunService.list()` reports, narrowed to the two fields this policy reads. */
export interface RunLike {
  status: string;
  source: string;
}

/**
 * Count the runs that must keep this process alive.
 *
 * Only `live` runs count. A run persisted as `running` by a process that was
 * killed mid-step stays `running` on disk forever; counting those would pin
 * every future daemon for that project open on the strength of an old crash.
 */
export function countInFlight(runs: readonly RunLike[]): number {
  return runs.filter(
    (r) => r.source === "live" && (r.status === "running" || r.status === "awaiting_approval")
  ).length;
}
