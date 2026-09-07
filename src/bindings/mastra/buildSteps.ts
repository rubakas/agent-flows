// Binding B helpers: context/parsing helpers and per-kind Mastra step builders.
// Consumed by buildLevelsOntoBuilder in build.ts.

import { spawnSync } from "node:child_process";
import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";
import { assembleSpec } from "../../canon/assemble.js";
import { writeSpecKitSpec } from "../../canon/exportSpec.js";
import { persistTicket } from "../../canon/persistTicket.js";
import { getActiveProfile, resolveStepModel } from "../../canon/registry.js";
import { renderPrompt } from "../../canon/render.js";
import { runCheckStep, runLlmStep } from "../../canon/runStep.js";
import { canonSchemas } from "../../canon/schemas.js";
import type { ModelRegistry, ProviderProfile } from "../../canon/registry.js";
import type { StepRunnerDeps } from "../../canon/runStep.js";
import type { HardenedSpec, LoadedPipeline, PipelineDef, StepDef } from "../../canon/types.js";
import type { TicketStore } from "../../module/seams.js";

// Flexible context record used as input/output schema for all steps.
export const ctx = z.record(z.string(), z.unknown());
type Ctx = Record<string, unknown>;

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
  profile?: ProviderProfile;
  runner?: typeof runLlmStep;
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

function ctxVars(ctxData: Ctx): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const [k, v] of Object.entries(ctxData)) {
    if (k === "models") continue;
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
function tryParseSchemaOutput(
  raw: string,
  schemaKey: string
): { ok: true; value: unknown } | { ok: false; error: string } {
  const stripped = stripFences(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped) as unknown;
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  if (typeof parsed !== "object" || parsed === null || !(schemaKey in parsed)) {
    return {
      ok: false,
      error: `output missing required key "${schemaKey}". Got: ${stripped.slice(0, 200)}`,
    };
  }
  return { ok: true, value: parsed };
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
  const profile = deps.profile ?? getActiveProfile();
  return createStep({
    id: step.id,
    inputSchema: ctx,
    outputSchema: ctx,
    execute: async ({ inputData }) => {
      const rawCtx = inputData as Ctx;
      const ctxData: Ctx = visibleKeys
        ? (Object.fromEntries(Object.entries(rawCtx).filter(([k]) => visibleKeys.has(k))) as Ctx)
        : rawCtx;
      const override = ctxModelOverride(step.id, ctxData);
      const entry = override
        ? deps.registry.resolve(override)
        : resolveStepModel(step, profile, deps.registry);
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

      // Thread per-step and pipeline-level timeouts into the runner deps.
      // runLlmStep resolves the effective timeout as: timeoutMs ?? defaultTimeoutMs.
      // The declared permissions travel with them: without it the canon's
      // `permissions.contents: read|write` would be silently dropped and the agent
      // would run with no repo access at all.
      // skills travel the same way — a canon declaration dropped here is the exact
      // bug class this project has hit before.
      const contentsValue = step.permissions?.contents;
      const runnerDeps: StepRunnerDeps = {
        ...baseRunnerDeps(step, deps, defaultTimeoutMs),
        ...(contentsValue && contentsValue !== "none"
          ? {
              contentsAccess: contentsValue,
              ...(deps.cwd !== undefined ? { workspaceDir: deps.cwd } : {}),
            }
          : {}),
        ...(step.skills?.length ? { skills: step.skills } : {}),
        // allowPatterns and denyPatterns travel the same path as contentsAccess —
        // a canon declaration dropped here is the bug class this project has hit before.
        ...(step.permissions?.allow?.length ? { allowPatterns: step.permissions.allow } : {}),
        ...(step.permissions?.deny?.length ? { denyPatterns: step.permissions.deny } : {}),
      };

      // FR-007: wrap any runner error with the step id so the failure surface
      // (RunRecord.error, GET /api/runs/:id) names the failing step.
      // FR-008: for write steps, append workspace state before rethrowing —
      // the operator needs to know what was left behind after a timeout or crash.
      let raw: string;
      try {
        raw = await runner(entry, prompt, runnerDeps);
      } catch (err) {
        const baseMsg = err instanceof Error ? err.message : String(err);
        const stepMsg = `Step "${step.id}": ${baseMsg}`;
        if (step.permissions?.contents === "write" && deps.cwd !== undefined) {
          throw new Error(`${stepMsg}\n${workspaceDirtyMessage(deps.cwd)}`, { cause: err });
        }
        throw new Error(stepMsg, { cause: err });
      }

      let value: unknown = raw;
      if (step.schema) {
        const r1 = tryParseSchemaOutput(raw, step.schema);
        if (!r1.ok) {
          // One retry with explicit error feedback.
          const retryPrompt =
            `${prompt}\n\nYour previous output was not valid JSON (${r1.error}).` +
            ` Return ONLY the JSON object.`;
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

      return { ...rawCtx, [step.id]: value };
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
    execute: async ({ inputData }) => {
      const rawCtx = inputData as Ctx;
      const result = await runCheckStep(resolvedCommand, {
        ...baseRunnerDeps(step, deps, defaultTimeoutMs),
        cwd: deps.cwd,
        ...(step.env?.length ? { envAllowlist: step.env } : {}),
      });
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
