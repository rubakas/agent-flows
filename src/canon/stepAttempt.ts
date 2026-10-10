// One llm step, attempted: the request the adapter is handed, the provider
// failover chain when the call fails, and the one corrective retry when the
// answer breaks the step's output contract. A caller says WHAT to ask and which
// model to ask it of; this module owns everything between that and an answer.
//
// Not here: rendering the prompt, run state, step logs' start/result pair,
// raw-output persistence, workspace reporting — those belong to the caller.

import { DEFAULT_ADAPTER_CONFIG, adapterFor } from "./adapters/index.js";
import { checkPortability, effectiveBudget } from "./portability.js";
import { getProfile, resolveStepModel } from "./registry.js";
import { emitStepEvent } from "./stepLogEvents.js";
import { TransportFailureError } from "./stepRuntime.js";
import type { OutputContract } from "./outputContract.js";
import type { ModelEntry, ModelRegistry, ProviderProfile } from "./registry.js";
import type { StepEventSink, StepLogEventInput } from "./stepLogEvents.js";
import type { StepRunnerDeps } from "./stepRuntime.js";
import type { StepDef } from "./types.js";

/** What of a step an attempt reads. A gate's synthetic step needs only an id. */
export type AttemptStep = Pick<
  StepDef,
  "id" | "model" | "role" | "permissions" | "skills" | "maxBudgetUsd" | "timeoutMs" | "failover"
>;

/** One call to a model: the seam between this module and the transports. */
export type Dispatch = (entry: ModelEntry, prompt: string, deps: StepRunnerDeps) => Promise<string>;

/**
 * Dispatches to the adapter for the entry's transport (FR-001). Supervision — the
 * deadline, the StepTimeoutError mapping, the claude watchdog and its
 * reformulation retry — lives inside each adapter's run(), so no caller can
 * construct an unsupervised call (FR-002).
 */
export const defaultDispatch: Dispatch = (entry, prompt, deps) =>
  adapterFor(entry).run(prompt, entry, deps, DEFAULT_ADAPTER_CONFIG);

export interface AttemptRequest {
  step: AttemptStep;
  /** The final text sent to the model. */
  prompt: string;
  model: {
    entry: ModelEntry;
    /** The profile `entry` was resolved under; the failover chain is its `fallback`. */
    profile: ProviderProfile;
    /**
     * The caller chose this model deliberately (a per-run override). The chain
     * would resolve candidates from their own profiles and silently discard that
     * choice, so a pinned request is never failed over — and says nothing about it.
     */
    pinned?: true;
  };
  /** Present for a schema-gated step: the answer is parsed and corrected once. */
  output?: OutputContract;
}

export interface AttemptContext {
  registry: ModelRegistry;
  /** Searched, before the built-ins, when resolving a failover candidate's profile. */
  providerProfiles?: ProviderProfile[];
  /** The pipeline's `defaultMaxBudgetUsd`: the cap a step inherits when it declares none. */
  defaultMaxBudgetUsd?: number;
  /** The pipeline's fallback deadline; the step's own `timeoutMs` takes precedence. */
  defaultTimeoutMs?: number;
  /** Project root, handed to the adapter when the step declares file access. */
  workspaceDir?: string;
  /** The run's cancellation signal. Never carried on `base`: that is shared by every run. */
  signal?: AbortSignal;
  /** Receives the adapters' events plus the attempt's own `failover` and `retry`. */
  onEvent?: StepEventSink;
  /** spawn / env / fetchFn / test hooks, passed to the adapter untouched. */
  base?: StepRunnerDeps;
  /** Defaults to the adapter for the entry's transport. */
  dispatch?: Dispatch;
}

export interface AttemptResult {
  /** The parsed value when the request had an output contract, else the raw answer. */
  value: unknown;
  /**
   * Who actually answered. `entry` is the request's own object unless a failover
   * moved the step, so `answeredBy.entry !== req.model.entry` is the test for it.
   */
  answeredBy: { entry: ModelEntry; profileId: string };
}

export class StepAttemptError extends Error {
  /**
   * `unportable`: refused before any dispatch. `failed`: the transport gave no
   * answer. `output`: the answer broke the contract twice.
   */
  readonly kind: "unportable" | "failed" | "output";
  /** Which call failed: the first, or the corrective retry after an unusable answer. */
  readonly stage: "dispatch" | "retry";
  /** The message without the `Step "<id>":` prefix. `message` is the full text. */
  readonly detail: string;
  /** Every answer received, in order — what the caller leaves on disk to diagnose with. */
  readonly raw: readonly string[];
  /** Set only once a call was answered: the failover candidate, when one answered. */
  readonly answeredBy?: AttemptResult["answeredBy"];

  constructor(init: {
    kind: StepAttemptError["kind"];
    stage: StepAttemptError["stage"];
    message: string;
    detail: string;
    raw?: readonly string[];
    answeredBy?: AttemptResult["answeredBy"];
    cause?: unknown;
  }) {
    super(init.message, init.cause !== undefined ? { cause: init.cause } : undefined);
    this.name = "StepAttemptError";
    this.kind = init.kind;
    this.stage = init.stage;
    this.detail = init.detail;
    this.raw = init.raw ?? [];
    if (init.answeredBy !== undefined) this.answeredBy = init.answeredBy;
  }
}

// ── Failover (spec 039) ───────────────────────────────────────────────────────

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

/** Outcome of walking a fallback chain: an answer, or why each candidate did not give one. */
type ChainOutcome =
  | { ok: true; raw: string; profileId: string; entry: ModelEntry }
  | { ok: false; attempts: string[] };

// ── The attempt ───────────────────────────────────────────────────────────────

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Attempts one llm step. A failed attempt throws a `StepAttemptError`. The one
 * exception is `resolveStepModel` inside the failover walk, which can throw its
 * own error unwrapped.
 *
 * 1. Refuses before any dispatch when the model cannot enforce what the step
 *    declares.
 * 2. Dispatches. A failure another provider could plausibly answer walks the
 *    primary profile's fallback chain, unless the request is pinned or the step
 *    sets `failover: false`.
 * 3. With an output contract, parses the answer; an unusable one gets exactly
 *    one retry, sent to whichever model answered.
 */
export async function attemptStep(
  req: AttemptRequest,
  ctx: AttemptContext
): Promise<AttemptResult> {
  const { step, prompt, output } = req;
  const { entry, profile } = req.model;
  const dispatch = ctx.dispatch ?? defaultDispatch;
  const startedAt = Date.now();

  const portabilityOpts = {
    ...(ctx.defaultMaxBudgetUsd !== undefined
      ? { defaultMaxBudgetUsd: ctx.defaultMaxBudgetUsd }
      : {}),
  };
  const portability = checkPortability(step, entry, profile.id, portabilityOpts);
  if (!portability.ok) {
    throw new StepAttemptError({
      kind: "unportable",
      stage: "dispatch",
      message: portability.reason,
      detail: portability.reason,
    });
  }

  // What the failed attempts already reported spending, for the chain's
  // remaining-budget allowance.
  let spentUsd = 0;
  const onEvent: StepEventSink = (event: StepLogEventInput) => {
    if (event.kind === "usage" && typeof event.costUsd === "number") spentUsd += event.costUsd;
    emitStepEvent(ctx.onEvent, event);
  };

  // The declared permissions travel with the request: without them the canon's
  // `permissions.contents: read|write` would be silently dropped and the agent
  // would run with no repo access at all. Skills and the deny list travel the
  // same way — a canon declaration dropped here is the bug class this project
  // has hit before.
  const contentsValue = step.permissions?.contents;
  const hasContentsAccess = contentsValue !== undefined && contentsValue !== "none";
  const budget = effectiveBudget(step, ctx.defaultMaxBudgetUsd);
  const deps: StepRunnerDeps = {
    ...(ctx.base ?? {}),
    ...(step.timeoutMs !== undefined ? { timeoutMs: step.timeoutMs } : {}),
    ...(ctx.defaultTimeoutMs !== undefined ? { defaultTimeoutMs: ctx.defaultTimeoutMs } : {}),
    ...(budget !== undefined ? { maxBudgetUsd: budget } : {}),
    ...(ctx.signal ? { signal: ctx.signal } : {}),
    onEvent,
    ...(hasContentsAccess
      ? {
          contentsAccess: contentsValue,
          ...(ctx.workspaceDir !== undefined ? { workspaceDir: ctx.workspaceDir } : {}),
        }
      : {}),
    ...(step.skills?.length ? { skills: step.skills } : {}),
    // Structured output for the transports that have it: the claude adapter turns
    // this into --json-schema, the others ignore it and keep the prompt's JSON
    // instruction as their only guarantee.
    ...(output?.jsonSchema !== undefined ? { outputJsonSchema: output.jsonSchema } : {}),
    // Gated on the SAME condition as contentsAccess: a deny list for a step that
    // declared no file access is a silent no-op.
    ...(hasContentsAccess && step.permissions?.deny?.length
      ? { denyPatterns: step.permissions.deny }
      : {}),
  };

  let answeredBy: AttemptResult["answeredBy"] = { entry, profileId: profile.id };
  let raw: string;
  try {
    raw = await dispatch(entry, prompt, deps);
  } catch (err) {
    const baseMsg = errorMessage(err);
    // The chain is walked only for failures another provider could plausibly
    // answer; everything else fails here.
    // `failover: false` is the step's own refusal to cross vendors: the prompt a
    // candidate would receive carries this step's upstream outputs, and a pinned
    // step fails rather than hand them elsewhere.
    const refused = step.failover === false;
    const worthy = isFailoverWorthy(err, deps.signal);
    const outcome: ChainOutcome =
      !refused && req.model.pinned !== true && worthy
        ? await walkFailoverChain({
            req,
            ctx,
            dispatch,
            deps,
            portabilityOpts,
            reason: baseMsg,
            startedAt,
            spentUsd: () => spentUsd,
          })
        : { ok: false, attempts: [] };

    if (!outcome.ok) {
      // An operator reading a failed run must not have to guess whether the
      // chain was empty, exhausted or refused — name the reason on the message.
      const tried =
        outcome.attempts.length > 0
          ? `\nFailover exhausted: ${outcome.attempts.join("; ")}`
          : refused && worthy
            ? `\nFailover refused: the step sets failover: false, so it stayed pinned to profile "${profile.id}" and no other provider was tried.`
            : "";
      throw new StepAttemptError({
        kind: "failed",
        stage: "dispatch",
        message: `Step "${step.id}": ${baseMsg}${tried}`,
        detail: `${baseMsg}${tried}`,
        cause: err,
      });
    }
    raw = outcome.raw;
    answeredBy = { entry: outcome.entry, profileId: outcome.profileId };
  }

  if (!output) return { value: raw, answeredBy };

  const first = output.parse(raw);
  if (first.ok) return { value: first.value, answeredBy };

  // A retry is otherwise only inferable from two `usage` events under one
  // step.start/step.result pair — a run that paid twice reads as one expensive call.
  emitStepEvent(onEvent, {
    kind: "retry",
    stepId: step.id,
    reason: first.reason,
    detail: first.error,
  });
  // One retry with explicit error feedback. After a failover the primary is the
  // model that just failed; the correction goes to the one that answered.
  let retryRaw: string;
  try {
    retryRaw = await dispatch(answeredBy.entry, `${prompt}\n\n${first.retryNote}`, deps);
  } catch (err) {
    const baseMsg = errorMessage(err);
    throw new StepAttemptError({
      kind: "failed",
      stage: "retry",
      message: `Step "${step.id}": ${baseMsg}`,
      detail: baseMsg,
      raw: [raw],
      answeredBy,
      cause: err,
    });
  }
  const second = output.parse(retryRaw);
  if (!second.ok) {
    throw new StepAttemptError({
      kind: "output",
      stage: "retry",
      message: `Step "${step.id}": ${second.error}`,
      detail: second.error,
      raw: [raw, retryRaw],
      answeredBy,
    });
  }
  return { value: second.value, answeredBy };
}

/**
 * Walks the primary profile's fallback chain after a call failed, trying each
 * candidate once, in order. A candidate is skipped — never attempted — when it
 * cannot enforce what the step declares: that guard is what stops a
 * repo-grounded step silently continuing on a text-only model.
 *
 * On exhaustion the caller reports the ORIGINAL error, because the chain's last
 * error describes a provider the operator never chose.
 */
async function walkFailoverChain(params: {
  req: AttemptRequest;
  ctx: AttemptContext;
  dispatch: Dispatch;
  deps: StepRunnerDeps;
  portabilityOpts: { defaultMaxBudgetUsd?: number };
  reason: string;
  /** When the step's first attempt began, for the remaining-time allowance. */
  startedAt: number;
  /** What the step has cost so far, from the usage events the adapters emit. */
  spentUsd: () => number;
}): Promise<ChainOutcome> {
  const { req, ctx, dispatch, deps, portabilityOpts } = params;
  const { step, prompt } = req;
  const { entry, profile } = req.model;
  const attempts: string[] = [];

  // A declared timeout and budget bound the STEP, not each attempt. Every
  // dispatch builds a fresh full-length deadline of its own, so without
  // decrementing here an N-long chain would multiply both by N+1 — and this
  // project's stated position is that a stall is caught by a cost ceiling and
  // event silence, neither of which a chain may quietly widen.
  const declaredTimeoutMs = deps.timeoutMs ?? deps.defaultTimeoutMs;
  const declaredBudgetUsd = deps.maxBudgetUsd;

  for (const candidateId of profile.fallback ?? []) {
    if (deps.signal?.aborted === true) break;

    let candidate: ProviderProfile;
    try {
      candidate = getProfile(candidateId, ctx.providerProfiles);
    } catch {
      attempts.push(`${candidateId}: skipped (unknown profile)`);
      continue;
    }

    const candidateEntry = resolveStepModel(step, candidate, ctx.registry);
    if (candidateEntry.id === entry.id) {
      attempts.push(`${candidateId}: skipped (resolves to the same model "${entry.id}")`);
      continue;
    }

    const portability = checkPortability(step, candidateEntry, candidate.id, portabilityOpts);
    if (!portability.ok) {
      attempts.push(`${candidateId}: skipped (${portability.reason})`);
      continue;
    }

    const attemptDeps: StepRunnerDeps = { ...deps };
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

    emitStepEvent(deps.onEvent, {
      kind: "failover",
      stepId: step.id,
      fromProfile: profile.id,
      toProfile: candidate.id,
      reason: params.reason,
    });

    try {
      const raw = await dispatch(candidateEntry, prompt, attemptDeps);
      return { ok: true, raw, profileId: candidate.id, entry: candidateEntry };
    } catch (err) {
      attempts.push(`${candidateId}: ${errorMessage(err)}`);
    }
  }

  return { ok: false, attempts };
}
