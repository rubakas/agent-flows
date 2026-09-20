// Binding B helpers: context/parsing helpers and per-kind Mastra step builders.
// Consumed by buildLevelsOntoBuilder in build.ts.

import { spawnSync } from "node:child_process";
import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";
import { assembleSpec } from "../../canon/assemble.js";
import { writeSpecKitSpec } from "../../canon/exportSpec.js";
import { persistTicket } from "../../canon/persistTicket.js";
import { checkPortability } from "../../canon/portability.js";
import { getActiveProfile, getProfile, resolveStepModel } from "../../canon/registry.js";
import { renderPrompt } from "../../canon/render.js";
import { runCheckStep, runLlmStep } from "../../canon/runStep.js";
import { canonSchemas } from "../../canon/schemas.js";
import { emitStepEvent } from "../../canon/stepLogEvents.js";
import { TransportFailureError } from "../../canon/stepRuntime.js";
import { validateCanonOutput } from "../../canon/validateOutput.js";
import { recordStep } from "../../runtime/stepIntrospection.js";
import { appendStepLog, writeStepOutput } from "../../runtime/stepLog.js";
import type { PortabilityOptions } from "../../canon/portability.js";
import type { ModelEntry, ModelRegistry, ProviderProfile } from "../../canon/registry.js";
import type { CheckResult, StepRunnerDeps } from "../../canon/runStep.js";
import type { StepLogEventInput } from "../../canon/stepLogEvents.js";
import type { HardenedSpec, LoadedPipeline, PipelineDef, StepDef } from "../../canon/types.js";
import type { TicketStore } from "../../module/seams.js";

// Flexible context record used as input/output schema for all steps.
export const ctx = z.record(z.string(), z.unknown());
type Ctx = Record<string, unknown>;

/** The terminal outcomes a step's `step.result` log event can report (spec 036 D1). */
type StepResultStatus = "succeeded" | "failed" | "cancelled";

/**
 * Default convergence gate command, used when no checkCommand is configured in
 * .agent-flows/config.json. Must mirror the project's own `check` script in
 * package.json exactly: a default weaker than the project's real gate can
 * converge on code the project rejects. Confirmed by a live self-run
 * (2026-09-07) that produced a refactor with passing tests and clean typecheck
 * but failing format:check — the old default declared that run converged.
 */
export const DEFAULT_CHECK_COMMAND =
  "pnpm lint && pnpm typecheck && pnpm format:check && pnpm test";

/**
 * How many trailing output lines a failing `required` check quotes in the error it
 * throws. The error travels in API responses (spec 023 FR-009), so it is capped for
 * the same reason the dirty-workspace listing is: check output is unbounded.
 */
const CHECK_ERROR_OUTPUT_LINES = 20;

/** Returns the last `max` lines of `text`, prefixed with a marker when truncated. */
function lastLines(text: string, max: number): string {
  const lines = text.trimEnd().split("\n");
  if (lines.length <= max) return lines.join("\n");
  return `…\n${lines.slice(lines.length - max).join("\n")}`;
}

/**
 * Runs `git status --porcelain` in cwd via spawnSync and returns a human-readable
 * message describing the workspace state. Called from the daemon process (not a
 * sandboxed step) when a write step fails, so the operator knows what was left behind.
 */
function workspaceDirtyMessage(cwd: string): string {
  const result = spawnSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8" });
  // git exits 128 when the directory is not a git repository.
  if (result.error !== undefined || result.status === 128) {
    return "Workspace may contain partial writes; not a git repository, dirty-file listing unavailable.";
  }
  const lines = (result.stdout ?? "")
    .trim()
    .split("\n")
    .filter((l) => l.length > 0);
  const cap = 20;
  if (lines.length <= cap) {
    return `Workspace may contain partial writes:\n${lines.join("\n")}`;
  }
  return `Workspace may contain partial writes:\n${lines.slice(0, cap).join("\n")}\n…and ${lines.length - cap} more`;
}

export interface BuildDeps {
  registry: ModelRegistry;
  store: TicketStore;
  /** The daemon's startup profile: the fallback when a run names no `provider`. */
  profile?: ProviderProfile;
  /**
   * Project-declared profiles from providers.yaml, searched before the built-ins
   * when a run names a `provider`. Without them a project profile the daemon
   * loaded at startup is unknown at execute time.
   */
  providerProfiles?: ProviderProfile[];
  runner?: typeof runLlmStep;
  /**
   * Runner deps shared by every step of the built workflow. Build-time and
   * therefore shared by every concurrent run on that workflow, so it must never
   * carry a per-run `signal` (D1/FR-013): one run's cancellation would abort the
   * others. The per-run signal is Mastra's `abortSignal`, read from the execute
   * params and combined with this one via `combineSignals()` at execute time.
   */
  runnerDeps?: StepRunnerDeps;
  /** Working directory for check step commands. Defaults to process.cwd(). */
  cwd?: string;
  /**
   * Per-project convergence gate command, resolved once at daemon startup from
   * <projectDir>/.agent-flows/config.json (checkCommand key).
   * Substituted into check step commands containing {{checkCommand}} at build time.
   * When absent, defaults to DEFAULT_CHECK_COMMAND.
   */
  checkCommand?: string;
  /**
   * Pipeline-level cost cap fallback for claude-transport llm steps (FR-007).
   * Applied when the step does not declare its own maxBudgetUsd. Step-level
   * value overrides this. Typically set from PipelineDef.defaultMaxBudgetUsd.
   */
  defaultMaxBudgetUsd?: number;
}

/** Callback type for compiling a nested pipeline body onto a Mastra builder. */
export type LevelBuilder = (
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  builder: any,
  def: PipelineDef,
  prompts: Record<string, string>,
  deps: BuildDeps,
  bodies: Record<string, LoadedPipeline>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
) => any;

// ── Namespace helpers ─────────────────────────────────────────────────────────

/**
 * Derives a namespaced context key from a step id and a bare key name.
 * The namespace is the prefix before the last dot in `stepId`.
 *
 * Examples:
 *   nsKey("plan.assemble", "spec")  → "plan.spec"
 *   nsKey("assemble",      "spec")  → "spec"      (no prefix — standalone pipeline)
 */
function nsKey(stepId: string, bare: string): string {
  const dot = stepId.lastIndexOf(".");
  return dot === -1 ? bare : `${stepId.slice(0, dot)}.${bare}`;
}

function stripFences(text: string): string {
  return text
    .replace(/^```(?:json)?\s*\n?/im, "")
    .replace(/\n?```\s*$/im, "")
    .trim();
}

function ctxModelOverride(stepId: string, ctxData: Ctx): string | undefined {
  const models = ctxData.models as Record<string, string> | undefined;
  return models?.[stepId];
}

function ctxProviderOverride(ctxData: Ctx): string | undefined {
  const provider = ctxData.provider;
  return typeof provider === "string" && provider.length > 0 ? provider : undefined;
}

/**
 * The profile this execution runs under: the run's own `provider` when it named
 * one, else the daemon's startup profile. Resolved per call — a value captured at
 * build time is shared by every concurrent run on the workflow.
 */
function resolveRunProfile(stepId: string, ctxData: Ctx, deps: BuildDeps): ProviderProfile {
  const requested = ctxProviderOverride(ctxData);
  if (requested === undefined) return deps.profile ?? getActiveProfile();
  try {
    return getProfile(requested, deps.providerProfiles);
  } catch (err) {
    // Falling back to the default here would run the step on a provider the
    // caller did not ask for — the opposite of what naming one means.
    throw new Error(`Step "${stepId}": ${err instanceof Error ? err.message : String(err)}`, {
      cause: err,
    });
  }
}

function ctxVars(ctxData: Ctx): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const [k, v] of Object.entries(ctxData)) {
    if (k === "models" || k === "provider") continue;
    let serialized: string;
    if (typeof v === "string") {
      serialized = v;
    } else if (v !== null && v !== undefined) {
      serialized = JSON.stringify(v);
    } else {
      continue;
    }
    vars[k] = serialized;
  }
  return vars;
}

// Try to parse a schema-gated step output; returns ok/error so callers can retry.
// `retryNote` is what the one retry tells the model; `error` is what a failed step
// reports. A schema violation names the field and the constraint in both.
function tryParseSchemaOutput(
  raw: string,
  schemaKey: string
): { ok: true; value: unknown } | { ok: false; error: string; retryNote: string } {
  const stripped = stripFences(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped) as unknown;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return { ok: false, error, retryNote: `Your previous output was not valid JSON (${error}).` };
  }
  if (typeof parsed !== "object" || parsed === null || !(schemaKey in parsed)) {
    const error = `output missing required key "${schemaKey}". Got: ${stripped.slice(0, 200)}`;
    return { ok: false, error, retryNote: `Your previous output was not valid JSON (${error}).` };
  }
  const violations = validateCanonOutput(schemaKey, parsed);
  if (violations !== undefined) {
    return {
      ok: false,
      error: `output does not match schema "${schemaKey}": ${violations}. Got: ${stripped.slice(0, 200)}`,
      retryNote:
        `Your previous output did not match the required JSON Schema` + ` (${violations}).`,
    };
  }
  return { ok: true, value: parsed };
}

/**
 * Combines the build-time signal (if any) with the per-run `abortSignal` Mastra
 * hands to execute (FR-013). Either side aborting aborts the result. Returns
 * undefined only when neither exists, so a step built without BuildDeps.runnerDeps
 * still honours cancellation.
 */
function combineSignals(
  buildSignal: AbortSignal | undefined,
  runSignal: AbortSignal | undefined
): AbortSignal | undefined {
  if (!buildSignal) return runSignal;
  if (!runSignal) return buildSignal;
  return AbortSignal.any([buildSignal, runSignal]);
}

/**
 * FR-013: a step whose execute begins after the run was cancelled must not spawn
 * anything. Mastra still starts queued steps after `run.cancel()`, so the guard
 * lives at the top of each executing step rather than in the runner.
 */
function assertNotCancelled(stepId: string, runSignal: AbortSignal | undefined): void {
  if (runSignal?.aborted) throw new Error(`run cancelled before step ${stepId} started`);
}

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
function isFailoverWorthy(err: unknown, signal: AbortSignal | undefined): boolean {
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
function describeModel(entry: ModelEntry): string {
  return `${entry.id} (${entry.transport}${entry.cli?.bin ? ":" + entry.cli.bin : ""})`;
}

/** Outcome of walking a fallback chain: an answer, or why each candidate did not give one. */
type FailoverOutcome =
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
async function runFailoverChain(params: {
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

/** Builds the runner-deps base shared by every step kind (timeout and budget fields). */
function baseRunnerDeps(
  step: StepDef,
  deps: BuildDeps,
  defaultTimeoutMs: number | undefined
): StepRunnerDeps {
  // Step-level budget overrides pipeline-level budget (FR-007)
  const effectiveBudget = step.maxBudgetUsd ?? deps.defaultMaxBudgetUsd;
  return {
    ...(deps.runnerDeps ?? {}),
    ...(step.timeoutMs !== undefined ? { timeoutMs: step.timeoutMs } : {}),
    ...(defaultTimeoutMs !== undefined ? { defaultTimeoutMs } : {}),
    ...(effectiveBudget !== undefined ? { maxBudgetUsd: effectiveBudget } : {}),
  };
}

// visibleKeys, when provided, limits which context keys are visible to the
// prompt renderer (FR-005). The full accumulated context is always returned
// so later steps can apply their own filter.
// defaultTimeoutMs is the pipeline-level fallback; step.timeoutMs takes precedence.
export function buildLlmStep(
  step: StepDef,
  prompts: Record<string, string>,
  deps: BuildDeps,
  defaultTimeoutMs: number | undefined,
  visibleKeys?: Set<string>
) {
  const runner = deps.runner ?? runLlmStep;
  return createStep({
    id: step.id,
    inputSchema: ctx,
    outputSchema: ctx,
    execute: async ({ inputData, abortSignal, runId }) => {
      assertNotCancelled(step.id, abortSignal);
      const rawCtx = inputData as Ctx;
      const ctxData: Ctx = visibleKeys
        ? (Object.fromEntries(Object.entries(rawCtx).filter(([k]) => visibleKeys.has(k))) as Ctx)
        : rawCtx;
      const profile = resolveRunProfile(step.id, ctxData, deps);
      const override = ctxModelOverride(step.id, ctxData);
      const entry = override
        ? deps.registry.resolve(override)
        : resolveStepModel(step, profile, deps.registry);

      // D3: refuse an unportable step before any model call. The adapters throw
      // for the same combinations, but only after a subprocess has been shaped.
      const portabilityOpts = {
        ...(deps.defaultMaxBudgetUsd !== undefined
          ? { defaultMaxBudgetUsd: deps.defaultMaxBudgetUsd }
          : {}),
      };
      const portability = checkPortability(step, entry, profile.id, portabilityOpts);
      if (!portability.ok) throw new Error(portability.reason);

      let prompt = renderPrompt(prompts[step.id], ctxVars(ctxData));

      // For schema-gated steps: append a strict JSON format instruction so the
      // model knows not to wrap output in markdown fences or add commentary.
      if (step.schema) {
        const schema = canonSchemas[step.schema as keyof typeof canonSchemas];
        if (schema) {
          prompt +=
            `\n\nReturn ONLY a valid JSON object matching this JSON Schema` +
            ` (no markdown, no code fences, no commentary):\n${JSON.stringify(schema)}`;
        }
      }

      // Tell the agent which skills are available and how to invoke them.
      if (step.skills?.length) {
        prompt += `\n\nAvailable skills: ${step.skills.join(", ")}. Invoke with /skill-name.`;
      }

      // D6: hand the prompt and resolved model to the per-run introspection
      // channel keyed by Mastra's runId — never onto BuildDeps, which is shared
      // by every concurrent run on this workflow.
      const model = describeModel(entry);
      recordStep(runId, step.id, { prompt, model });

      // Thread per-step and pipeline-level timeouts into the runner deps.
      // runLlmStep resolves the effective timeout as: timeoutMs ?? defaultTimeoutMs.
      // The declared permissions travel with them: without it the canon's
      // `permissions.contents: read|write` would be silently dropped and the agent
      // would run with no repo access at all.
      // skills travel the same way — a canon declaration dropped here is the exact
      // bug class this project has hit before.
      const contentsValue = step.permissions?.contents;
      const hasContentsAccess = contentsValue !== undefined && contentsValue !== "none";
      // FR-013: the per-run signal comes from the execute params, never from the
      // build-time BuildDeps.runnerDeps shared across concurrent runs.
      const signal = combineSignals(deps.runnerDeps?.signal, abortSignal);
      let spentUsd = 0;
      const runnerDeps: StepRunnerDeps = {
        ...baseRunnerDeps(step, deps, defaultTimeoutMs),
        ...(signal ? { signal } : {}),
        // Spec 036 D2: the sink is bound per execution, exactly like recordStep —
        // never through BuildDeps, which every concurrent run shares.
        onEvent: (event: StepLogEventInput) => {
          // The chain's remaining-budget allowance is computed from what the
          // failed attempts already reported spending.
          if (event.kind === "usage" && typeof event.costUsd === "number") {
            spentUsd += event.costUsd;
          }
          appendStepLog(runId, step.id, event);
        },
        ...(hasContentsAccess
          ? {
              contentsAccess: contentsValue,
              ...(deps.cwd !== undefined ? { workspaceDir: deps.cwd } : {}),
            }
          : {}),
        ...(step.skills?.length ? { skills: step.skills } : {}),
        // denyPatterns travels the same path as contentsAccess — a canon
        // declaration dropped here is the bug class this project has hit before.
        // It is gated on the SAME condition: a deny list for a step that declared
        // no file access is a silent no-op.
        ...(hasContentsAccess && step.permissions?.deny?.length
          ? { denyPatterns: step.permissions.deny }
          : {}),
      };

      // Spec 036 D2: the builder owns step.start and the single terminal
      // step.result, so the watchdog's second attempt cannot double-count a step
      // and no failure path can end a step's log without a terminal event.
      appendStepLog(runId, step.id, { kind: "step.start", model, transport: entry.transport });
      const startedAt = Date.now();
      // Set only when a failover moved the step: step.start already named the
      // model this step was PLANNED to run on, and that event is never rewritten.
      let actualEntry: ModelEntry | undefined;
      const finishStepLog = (status: StepResultStatus, error?: string): void => {
        appendStepLog(runId, step.id, {
          kind: "step.result",
          status,
          durationMs: Date.now() - startedAt,
          ...(actualEntry !== undefined
            ? { model: describeModel(actualEntry), transport: actualEntry.transport }
            : {}),
          ...(error !== undefined ? { error } : {}),
        });
      };

      try {
        // FR-007: wrap any runner error with the step id so the failure surface
        // (RunRecord.error, GET /api/runs/:id) names the failing step.
        // FR-008: for write steps, append workspace state before rethrowing —
        // the operator needs to know what was left behind after a timeout or crash.
        let raw: string;
        try {
          raw = await runner(entry, prompt, runnerDeps);
        } catch (err) {
          const baseMsg = err instanceof Error ? err.message : String(err);
          // The chain is walked only for failures another provider could plausibly
          // answer; everything else fails here, as it did before.
          // An explicit per-run `models[stepId]` is a deliberate choice about
          // WHICH model answers; the chain resolves candidates from their own
          // profiles and would silently discard it (spec 039 review).
          // `failover: false` is the step's own refusal to cross vendors: the
          // prompt a candidate would receive carries this step's upstream
          // outputs, and a pinned step fails rather than hand them elsewhere.
          const pinned = step.failover === false;
          const worthy = isFailoverWorthy(err, signal);
          const outcome: FailoverOutcome =
            !pinned && override === undefined && worthy
              ? await runFailoverChain({
                  step,
                  profile,
                  entry,
                  deps,
                  prompt,
                  runner,
                  runnerDeps,
                  portabilityOpts,
                  reason: baseMsg,
                  startedAt,
                  spentUsd: () => spentUsd,
                })
              : { ok: false, attempts: [] };

          if (outcome.ok) {
            raw = outcome.raw;
            // The step did not run on what step.start named. Correct every
            // surface that reports the model — the run state, the introspection
            // channel and, through it, the artifact's provenance — or the run
            // claims a provider that never answered.
            actualEntry = outcome.entry;
            const actualModelName = outcome.entry.cli?.model ?? outcome.entry.api?.model;
            recordStep(runId, step.id, {
              model: describeModel(outcome.entry),
              actual: {
                profileId: outcome.profileId,
                transport: outcome.entry.transport,
                modelId: outcome.entry.id,
                ...(actualModelName !== undefined ? { model: actualModelName } : {}),
              },
            });
          } else {
            // An operator reading a failed run must not have to guess whether the
            // chain was empty, exhausted or refused — name the reason here, on the
            // message that becomes the step.result error.
            const tried =
              outcome.attempts.length > 0
                ? `\nFailover exhausted: ${outcome.attempts.join("; ")}`
                : pinned && worthy
                  ? `\nFailover refused: the step sets failover: false, so it stayed pinned to profile "${profile.id}" and no other provider was tried.`
                  : "";
            const stepMsg = `Step "${step.id}": ${baseMsg}${tried}`;
            if (step.permissions?.contents === "write" && deps.cwd !== undefined) {
              throw new Error(`${stepMsg}\n${workspaceDirtyMessage(deps.cwd)}`, { cause: err });
            }
            throw new Error(stepMsg, { cause: err });
          }
        }

        let value: unknown = raw;
        if (step.schema) {
          const r1 = tryParseSchemaOutput(raw, step.schema);
          if (!r1.ok) {
            // One retry with explicit error feedback.
            const retryPrompt = `${prompt}\n\n${r1.retryNote} Return ONLY the JSON object.`;
            let retryRaw: string;
            try {
              retryRaw = await runner(entry, retryPrompt, runnerDeps);
            } catch (err) {
              const baseMsg = err instanceof Error ? err.message : String(err);
              const stepMsg = `Step "${step.id}": ${baseMsg}`;
              // FR-008: mirror the write-step workspace report onto the retry path —
              // a write step that fails during schema retry must also expose workspace state.
              if (step.permissions?.contents === "write" && deps.cwd !== undefined) {
                throw new Error(`${stepMsg}\n${workspaceDirtyMessage(deps.cwd)}`, { cause: err });
              }
              throw new Error(stepMsg, { cause: err });
            }
            const r2 = tryParseSchemaOutput(retryRaw, step.schema);
            if (!r2.ok) {
              throw new Error(`Step "${step.id}": ${r2.error}`);
            }
            value = r2.value;
          } else {
            value = r1.value;
          }
        }

        // D6: the full value lives on disk per step; the run state keeps only
        // the 2048-character excerpt.
        try {
          writeStepOutput(runId, step.id, {
            kind: step.schema ? "json" : "text",
            ...(step.schema !== undefined ? { schema: step.schema } : {}),
            output: value,
          });
        } catch (err) {
          // A step id that cannot be a file name is refused by the sink. That is
          // worth reporting, but never worth failing a step that already answered.
          console.error(`[agent-flows] step "${step.id}": output not persisted: ${String(err)}`);
        }
        finishStepLog("succeeded");
        return { ...rawCtx, [step.id]: value };
      } catch (err) {
        finishStepLog(
          signal?.aborted === true ? "cancelled" : "failed",
          err instanceof Error ? err.message : String(err)
        );
        throw err;
      }
    },
  });
}

export function buildParallelMergeStep(phaseName: string, phaseSteps: StepDef[]) {
  // After .parallel([s1, s2]), the next step receives { s1: s1Output, s2: s2Output }.
  // Each parallel step output carries the full accumulated context (accumulator pattern).
  // The merge step folds them back into a single context:
  //   base = first step's full context output
  //   overlay each subsequent step's own key from its output
  const mergeInputShape: Record<string, z.ZodTypeAny> = {};
  for (const s of phaseSteps) {
    mergeInputShape[s.id] = ctx;
  }

  return createStep({
    id: `__merge_${phaseName}`,
    // z.object(mergeInputShape) infers a specific shape; cast to allow dynamic construction.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    inputSchema: z.object(mergeInputShape) as z.ZodObject<any>,
    outputSchema: ctx,
    execute: ({ inputData }) => {
      const mergeInput = inputData as Record<string, Ctx>;
      const firstId = phaseSteps[0].id;
      const base = { ...(mergeInput[firstId] ?? {}) };
      for (const s of phaseSteps.slice(1)) {
        base[s.id] = mergeInput[s.id]?.[s.id];
      }
      return Promise.resolve(base);
    },
  });
}

export function buildAssembleStep(stepId: string) {
  return createStep({
    id: stepId,
    inputSchema: ctx,
    outputSchema: ctx,
    execute: ({ inputData }) => {
      const ctxData = inputData as Ctx;
      const pfx = (bare: string) => nsKey(stepId, bare);
      const spec = assembleSpec({
        request: ctxData.request as string | undefined,
        intake: ctxData[pfx("intake")] as string,
        enrich: ctxData[pfx("enrich")] as string,
        critic: ctxData[pfx("critic")] as { weaknesses: [] },
        security: ctxData[pfx("security")] as { securityFindings: [] },
      });
      // Write at the step id key (ancestor-trackable, valid `with` mapping target)
      // and at the conventional <ns>.spec key (read by gate and persist-ticket via nsKey).
      return Promise.resolve({ ...ctxData, [stepId]: spec, [pfx("spec")]: spec });
    },
  });
}

/**
 * Thrown by the gate step when the run is rejected (approved === false).
 * Propagates through the Mastra workflow failure path, stopping all downstream
 * steps — commit, pr, etc. — by construction (FR-006).
 */
export class GateRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GateRejectedError";
  }
}

export function buildGateStep(step: StepDef) {
  // Each gate writes its decision to a key derived from its own full step id
  // (not from the namespace prefix). This prevents key collision when two
  // gates share the same namespace prefix (or both have bare ids without dots):
  //   gate1 → "gate1.approved"
  //   gate2 → "gate2.approved"
  //   plan.approve → "plan.approve.approved"
  // Persist and export-spec steps read via the gateId passed at build time.
  const approvedKey = `${step.id}.approved`;
  return createStep({
    id: step.id,
    inputSchema: ctx,
    outputSchema: ctx,
    resumeSchema: z.object({
      approved: z.boolean(),
      reason: z.string().optional(),
      mode: z.string().optional(),
    }),
    suspendSchema: z.object({
      message: z.string(),
      spec: z.unknown(),
      manualOnly: z.boolean(),
    }),
    execute: async ({ inputData, resumeData, suspend }) => {
      const ctxData = inputData as Ctx;
      if (resumeData) {
        if (resumeData.approved === false) {
          const mode = resumeData.mode ?? "manual";
          const reason = resumeData.reason ?? "no reason given";
          throw new GateRejectedError(`Gate "${step.id}" rejected (${mode}): ${reason}`);
        }
        return { ...ctxData, [approvedKey]: resumeData.approved };
      }
      await suspend({
        message: step.message ?? "Approve this spec?",
        spec: ctxData[nsKey(step.id, "spec")],
        manualOnly: step.manualOnly ?? false,
      });
      // unreachable — suspend() throws internally; satisfies TypeScript return type
      return ctxData;
    },
  });
}

export function buildPersistStep(stepId: string, store: TicketStore, gateId: string) {
  // Reads the approval decision from the gate's own unique key (gateId + ".approved")
  // rather than a namespace-derived key. This ensures that when two gates share the
  // same namespace prefix the correct gate's decision is always read.
  const approvedKey = `${gateId}.approved`;
  return createStep({
    id: stepId,
    inputSchema: ctx,
    outputSchema: ctx,
    execute: async ({ inputData }) => {
      const ctxData = inputData as Ctx;
      const specKey = nsKey(stepId, "spec");
      const spec = ctxData[specKey] as HardenedSpec;
      const { ticketId } = await persistTicket(store, spec);
      return { ...ctxData, [nsKey(stepId, "ticketId")]: ticketId, [approvedKey]: true };
    },
  });
}

export function buildExportSpecStep(stepId: string, outDir: string, _gateId: string) {
  return createStep({
    id: stepId,
    inputSchema: ctx,
    outputSchema: ctx,
    execute: async ({ inputData }) => {
      const ctxData = inputData as Ctx;
      const specKey = nsKey(stepId, "spec");
      const spec = ctxData[specKey] as HardenedSpec;
      const writtenPath = await writeSpecKitSpec(
        spec,
        { input: ctxData.request as string | undefined },
        outDir
      );
      return { ...ctxData, [stepId]: { path: writtenPath } };
    },
  });
}

// Resolves a dot-separated path into a nested context value.
// "test.passed" → ctx["test"]["passed"]; single-segment paths behave as before.
function resolveDotPath(ctx: Ctx, path: string): unknown {
  const parts = path.split(".");
  let cur: unknown = ctx;
  for (const p of parts) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Ctx)[p];
  }
  return cur;
}

export function buildCheckStep(
  step: StepDef,
  deps: BuildDeps,
  defaultTimeoutMs: number | undefined
) {
  // FR-004: substitute {{checkCommand}} at build time from BuildDeps — before any run
  // exists — so run context (pipeline inputs, step outputs) cannot influence the value.
  // Any other {{...}} in the command is a load error caught by load.ts before we get here.
  const resolvedCommand = step.command!.replace(
    /\{\{checkCommand\}\}/g,
    deps.checkCommand ?? DEFAULT_CHECK_COMMAND
  );
  return createStep({
    id: step.id,
    inputSchema: ctx,
    outputSchema: ctx,
    execute: async ({ inputData, abortSignal, runId }) => {
      assertNotCancelled(step.id, abortSignal);
      const rawCtx = inputData as Ctx;
      // D6: record the command actually executed, per run (see buildLlmStep).
      recordStep(runId, step.id, { command: resolvedCommand });
      // FR-013: per-run signal from the execute params, combined with any
      // build-time one; BuildDeps.runnerDeps must not carry a per-run signal.
      const signal = combineSignals(deps.runnerDeps?.signal, abortSignal);

      // Spec 036 D2: start and terminal result belong to the builder, as for llm steps.
      appendStepLog(runId, step.id, { kind: "step.start", model: "check", transport: "shell" });
      const startedAt = Date.now();
      const finishStepLog = (status: StepResultStatus, error?: string): void => {
        appendStepLog(runId, step.id, {
          kind: "step.result",
          status,
          durationMs: Date.now() - startedAt,
          ...(error !== undefined ? { error } : {}),
        });
      };

      let result: CheckResult;
      try {
        result = await runCheckStep(resolvedCommand, {
          ...baseRunnerDeps(step, deps, defaultTimeoutMs),
          ...(signal ? { signal } : {}),
          onEvent: (event: StepLogEventInput) => {
            appendStepLog(runId, step.id, event);
          },
          cwd: deps.cwd,
          ...(step.env?.length ? { envAllowlist: step.env } : {}),
        });
      } catch (err) {
        finishStepLog(
          signal?.aborted === true ? "cancelled" : "failed",
          err instanceof Error ? err.message : String(err)
        );
        throw err;
      }

      if (signal?.aborted === true) {
        finishStepLog("cancelled");
      } else if (result.passed) {
        finishStepLog("succeeded");
      } else {
        finishStepLog("failed", `exit ${result.exitCode}`);
        // A required check is the run's last word on the tree it produced: a
        // non-zero exit must fail the run, not be recorded in the context and
        // ignored. Cancellation is not a check failure — it is reported above.
        if (step.required === true) {
          throw new Error(
            `Step "${step.id}": required check failed (exit ${result.exitCode}): ${resolvedCommand}\n` +
              lastLines(result.output, CHECK_ERROR_OUTPUT_LINES)
          );
        }
      }
      return { ...rawCtx, [step.id]: result };
    },
  });
}

// Builds the loop body as a committed child workflow and returns the body,
// condition, and outcome step that are chained by buildLevelsOntoBuilder.
//
// State is carried in the data flow rather than a closure so that concurrent
// runs on the same built workflow cannot overwrite each other's state.
export function buildLoopStep(
  step: StepDef,
  body: LoadedPipeline,
  deps: BuildDeps,
  levelBuilder: LevelBuilder
): {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  bodyWorkflow: any;
  condition: (params: { inputData: unknown; iterationCount: number }) => Promise<boolean>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  outcomeStep: any;
} {
  const iterKey = `__${step.id}_iterations`;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let bodyBuilder: any = createWorkflow({
    id: `${step.id}__body`,
    inputSchema: ctx,
    outputSchema: ctx,
  });
  bodyBuilder = levelBuilder(bodyBuilder, body.def, body.prompts, deps, body.bodies ?? {});

  // Append a counter step so the iteration count travels in the data flow.
  bodyBuilder = bodyBuilder.then(
    createStep({
      id: `__${step.id}_counter`,
      inputSchema: ctx,
      outputSchema: ctx,
      execute: async ({ inputData }) => {
        const rawCtx = inputData as Ctx;
        const prev = (rawCtx[iterKey] as number | undefined) ?? 0;
        return { ...rawCtx, [iterKey]: prev + 1 };
      },
    })
  );

  const bodyWorkflow = bodyBuilder.commit();

  const condition = async ({
    inputData,
    iterationCount,
  }: {
    inputData: unknown;
    iterationCount: number;
  }): Promise<boolean> =>
    Boolean(resolveDotPath(inputData as Ctx, step.until!)) || iterationCount >= step.maxIterations!;

  const outcomeStep = createStep({
    id: `__${step.id}_outcome`,
    inputSchema: ctx,
    outputSchema: ctx,
    execute: async ({ inputData }) => {
      const rawCtx = inputData as Ctx;
      const converged = Boolean(resolveDotPath(rawCtx, step.until!));
      const iterations = (rawCtx[iterKey] as number | undefined) ?? 0;
      const { [iterKey]: _dropped, ...rest } = rawCtx;
      return { ...rest, [step.id]: { converged, iterations } };
    },
  });

  return { bodyWorkflow, condition, outcomeStep };
}
