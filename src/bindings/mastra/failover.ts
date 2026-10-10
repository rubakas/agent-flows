// Provider failover for Binding B llm steps (spec 039): walking the active
// profile's fallback chain once a step's call has failed. Extracted from
// buildSteps.ts; the only caller is the llm step builder there.

import { checkPortability } from "../../canon/portability.js";
import { getProfile, resolveStepModel } from "../../canon/registry.js";
import { emitStepEvent } from "../../canon/stepLogEvents.js";
import type { BuildDeps } from "./buildSteps.js";
import type { PortabilityOptions } from "../../canon/portability.js";
import type { ModelEntry, ProviderProfile } from "../../canon/registry.js";
import type { runLlmStep, StepRunnerDeps } from "../../canon/runStep.js";
import type { StepDef } from "../../canon/types.js";

/** Outcome of walking a fallback chain: an answer, or why each candidate did not give one. */
export type FailoverOutcome =
  | { ok: true; raw: string; profileId: string; entry: ModelEntry }
  | { ok: false; attempts: string[] };

/**
 * Walks the active profile's fallback chain after a step's call failed, trying
 * each candidate once, in order. A candidate is skipped — never attempted — when
 * it cannot enforce what the step declares: that guard is what stops a
 * repo-grounded step silently continuing on a text-only model.
 *
 * On exhaustion the caller reports the ORIGINAL error, because the chain's last
 * error describes a provider the operator never chose.
 */
export async function runFailoverChain(params: {
  step: StepDef;
  profile: ProviderProfile;
  entry: ModelEntry;
  deps: BuildDeps;
  prompt: string;
  runner: typeof runLlmStep;
  runnerDeps: StepRunnerDeps;
  portabilityOpts: PortabilityOptions;
  reason: string;
  /** When the step's first attempt began, for the remaining-time allowance. */
  startedAt: number;
  /** What the step has cost so far, from the usage events the adapters emit. */
  spentUsd: () => number;
}): Promise<FailoverOutcome> {
  const { step, profile, entry, deps, prompt, runner, runnerDeps, portabilityOpts } = params;
  const attempts: string[] = [];

  // A declared timeout and budget bound the STEP, not each attempt. Every
  // runner() call builds a fresh full-length deadline of its own, so without
  // decrementing here an N-long chain would multiply both by N+1 — and this
  // project's stated position is that a stall is caught by a cost ceiling and
  // event silence, neither of which a chain may quietly widen.
  const declaredTimeoutMs = runnerDeps.timeoutMs ?? runnerDeps.defaultTimeoutMs;
  const declaredBudgetUsd = runnerDeps.maxBudgetUsd;

  for (const candidateId of profile.fallback ?? []) {
    if (runnerDeps.signal?.aborted === true) break;

    let candidate: ProviderProfile;
    try {
      candidate = getProfile(candidateId, deps.providerProfiles);
    } catch {
      attempts.push(`${candidateId}: skipped (unknown profile)`);
      continue;
    }

    const candidateEntry = resolveStepModel(step, candidate, deps.registry);
    if (candidateEntry.id === entry.id) {
      attempts.push(`${candidateId}: skipped (resolves to the same model "${entry.id}")`);
      continue;
    }

    const portability = checkPortability(step, candidateEntry, candidate.id, portabilityOpts);
    if (!portability.ok) {
      attempts.push(`${candidateId}: skipped (${portability.reason})`);
      continue;
    }

    const attemptDeps: StepRunnerDeps = { ...runnerDeps };
    if (declaredTimeoutMs !== undefined && declaredTimeoutMs > 0) {
      const remainingMs = declaredTimeoutMs - (Date.now() - params.startedAt);
      if (remainingMs <= 0) {
        attempts.push(
          `${candidateId}: skipped (the step's ${declaredTimeoutMs}ms deadline is spent)`
        );
        break;
      }
      attemptDeps.timeoutMs = remainingMs;
    }
    if (declaredBudgetUsd !== undefined) {
      const remainingUsd = declaredBudgetUsd - params.spentUsd();
      if (remainingUsd <= 0) {
        attempts.push(`${candidateId}: skipped (the step's $${declaredBudgetUsd} budget is spent)`);
        break;
      }
      attemptDeps.maxBudgetUsd = remainingUsd;
    }

    emitStepEvent(runnerDeps.onEvent, {
      kind: "failover",
      stepId: step.id,
      fromProfile: profile.id,
      toProfile: candidate.id,
      reason: params.reason,
    });

    try {
      const raw = await runner(candidateEntry, prompt, attemptDeps);
      return { ok: true, raw, profileId: candidate.id, entry: candidateEntry };
    } catch (err) {
      attempts.push(`${candidateId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { ok: false, attempts };
}
