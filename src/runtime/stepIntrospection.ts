// Per-run step introspection channel (spec 033 D6).
//
// Steps are built once and shared by every concurrent run on that workflow
// (BuildDeps is build-time, D1), so a step cannot hand its rendered prompt back
// through its build deps without one run overwriting another's. Instead each
// executing step writes into this module-level map keyed by Mastra's per-run
// `runId`, which the run service reads, merges into the run state and clears
// once the run settles.
//
// Leaf module by construction: it imports nothing from runtime, serve or
// bindings, so both sides can depend on it without an import cycle.

/**
 * The provider that ACTUALLY answered a step, recorded only when a failover
 * moved it off the profile the run was started under (spec 039).
 *
 * Structurally a `StepProvenance` plus the profile id; declared here rather than
 * imported so this module stays a leaf and both sides can depend on it.
 */
export interface StepActualProvider {
  /** Fallback profile that answered, e.g. "openai". */
  profileId: string;
  transport: "cli" | "api";
  /** Registry entry id, e.g. "codex" — an identifier, never a credential. */
  modelId: string;
  /** Human-readable model name from the registry entry. */
  model?: string;
}

/** What one executing step records about how it was invoked (spec 033 FR-017). */
export interface StepIntrospection {
  /** Rendered prompt text as sent to the model, including any schema suffix (llm steps). */
  prompt?: string;
  /** The shell command as executed, after {{checkCommand}} substitution (check steps). */
  command?: string;
  /** Resolved model: registry id plus transport (and CLI binary when there is one). */
  model?: string;
  /** Present only when a failover moved the step onto another provider. */
  actual?: StepActualProvider;
}

const runs = new Map<string, Record<string, StepIntrospection>>();

/**
 * Record how a step was invoked, merging into anything already recorded for it.
 *
 * A missing runId is a no-op rather than an error: steps are also executed
 * directly (tests, the smoke harness) with no Mastra run around them, and an
 * introspection channel must never be the reason a step fails.
 */
export function recordStep(
  runId: string | undefined,
  stepId: string,
  info: StepIntrospection
): void {
  if (runId === undefined || runId === "") return;
  const existing = runs.get(runId) ?? {};
  existing[stepId] = { ...existing[stepId], ...info };
  runs.set(runId, existing);
}

/** Everything recorded for a run so far, or undefined when nothing was recorded. */
export function getRun(runId: string): Record<string, StepIntrospection> | undefined {
  return runs.get(runId);
}

/** Drop a run's entry. Called once the run service has copied it into the record. */
export function clearRun(runId: string): void {
  runs.delete(runId);
}
