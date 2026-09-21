// Provider failover for Binding B llm steps (spec 039): deciding whether a
// failure is worth a second provider, and walking the active profile's fallback
// chain when it is. Extracted from buildSteps.ts; the only caller is the llm
// step builder there.

import { checkPortability } from "../../canon/portability.js";
import { getProfile, resolveStepModel } from "../../canon/registry.js";
import { emitStepEvent } from "../../canon/stepLogEvents.js";
import { TransportFailureError } from "../../canon/stepRuntime.js";
import type { BuildDeps } from "./buildSteps.js";
import type { PortabilityOptions } from "../../canon/portability.js";
import type { ModelEntry, ProviderProfile } from "../../canon/registry.js";
import type { runLlmStep, StepRunnerDeps } from "../../canon/runStep.js";
import type { StepDef } from "../../canon/types.js";

// ── Provider failover (spec 039) ──────────────────────────────────────────────

/**
 * claude result subtypes that describe the REQUEST rather than the transport.
 * A second provider handed the same prompt reaches the same place, so the chain
 * is skipped rather than spending a whole step proving it.
 *
 * Only subtypes identifiable positively are listed. `error_during_execution` is
 * deliberately absent: it also covers a session that crashed, which another
 * provider may well survive.
 */
const REQUEST_SHAPED_SUBTYPES: ReadonlySet<string> = new Set(["error_max_turns"]);

/**
 * Syscall codes that mean a child or a socket never delivered anything.
 *
 * An allowlist rather than `typeof err.code === "string"`: every Node `ERR_*`
 * error carries a string `code` too, so the broad test made a programming
 * mistake look like a transport failure and spent a second provider on it.
 */
const TRANSPORT_SYSCALL_CODES: ReadonlySet<string> = new Set([
  "ENOENT",
  "EACCES",
  "EPIPE",
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EAI_AGAIN",
]);

/**
 * Whether another provider is worth asking after this failure.
 *
 * Yes for transport failures and deadlines: they say nothing about the request,
 * so a different provider may well answer it. No for anything else — an operator
 * cancellation, a spent budget, a watchdog that already spent its retry on the
 * same model, a request the model itself could not complete — where a second
 * provider would either repeat the outcome or override a deliberate decision.
 *
 * Decided on the error TYPE, never on its message: the adapters carry
 * TransportFailureError with `exitCode`/`subtype` as fields, so renaming an
 * error string can no longer silently disable failover.
 */
export function isFailoverWorthy(err: unknown, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted === true) return false;
  if (!(err instanceof Error)) return false;
  switch (err.name) {
    case "AbortError":
    case "StepBudgetExceededError":
    case "StepWatchdogError":
    case "WatchdogTrip":
      return false;
    case "StepTimeoutError":
      return true;
    default:
      break;
  }
  if (err instanceof TransportFailureError) {
    return err.subtype === undefined || !REQUEST_SHAPED_SUBTYPES.has(err.subtype);
  }
  // A child that could never be spawned rejects with the raw system error.
  const code = (err as NodeJS.ErrnoException).code;
  return typeof code === "string" && TRANSPORT_SYSCALL_CODES.has(code);
}

/** Registry id plus transport, as recorded for the run state and the step log. */
export function describeModel(entry: ModelEntry): string {
  return `${entry.id} (${entry.transport}${entry.cli?.bin ? ":" + entry.cli.bin : ""})`;
}

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
