// Binding B: build a Mastra workflow from a neutral LoadedPipeline.
//
// Design: accumulator context pattern.
//   - All steps share a single Record<string, unknown> input/output schema.
//   - Each step receives the full accumulated context and returns it extended with its output.
//   - Parallel phase steps each carry the full context forward; a synthetic merge step
//     combines them back into a single context after the parallel block.
//   - The workflow input is the pipeline's declared inputs + optional models override map.

import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";
import { assembleSpec } from "../../canon/assemble.js";
import { pipelineLevels } from "../../canon/graph.js";
import { persistTicket } from "../../canon/persistTicket.js";
import { getActiveProfile, resolveStepModel } from "../../canon/registry.js";
import { renderPrompt } from "../../canon/render.js";
import { runLlmStep } from "../../canon/runStep.js";
import { canonSchemas } from "../../canon/schemas.js";
import type { ModelRegistry, ProviderProfile } from "../../canon/registry.js";
import type { StepRunnerDeps } from "../../canon/runStep.js";
import type { HardenedSpec, LoadedPipeline, PipelineDef, StepDef } from "../../canon/types.js";
import type { TicketStore } from "../../module/seams.js";

// ── Path helpers ──────────────────────────────────────────────────────────────

/** Derive the Mastra LibSQL db path from the ticket db path.
 *
 * Strips a trailing `.sqlite` or `.db` extension (anchored at end, so
 * directory components containing `.db` are unaffected) then appends
 * `-mastra.db`. Paths with no recognised extension get the suffix appended
 * directly.
 */
export function mastraDbPath(ticketDbPath: string): string {
  return ticketDbPath.replace(/\.(sqlite|db)$/, "") + "-mastra.db";
}

// Flexible context record used as input/output schema for all steps.
const ctx = z.record(z.string(), z.unknown());
type Ctx = Record<string, unknown>;

export interface BuildDeps {
  registry: ModelRegistry;
  store: TicketStore;
  profile?: ProviderProfile;
  runner?: typeof runLlmStep;
  runnerDeps?: StepRunnerDeps;
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
    if (typeof v === "string") {
      vars[k] = v;
    } else if (v !== null && v !== undefined) {
      vars[k] = JSON.stringify(v);
    }
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

// Returns the transitive ancestor set for every step in the pipeline.
// Must only be called after pipelineLevels has validated the graph (no cycles).
function computeAncestors(steps: readonly StepDef[]): Map<string, Set<string>> {
  const depMap = new Map<string, readonly string[]>(steps.map((s) => [s.id, s.dependsOn ?? []]));
  const cache = new Map<string, Set<string>>();

  function getAncestors(id: string): Set<string> {
    const cached = cache.get(id);
    if (cached !== undefined) return cached;
    const set = new Set<string>();
    for (const dep of depMap.get(id) ?? []) {
      set.add(dep);
      for (const anc of getAncestors(dep)) set.add(anc);
    }
    cache.set(id, set);
    return set;
  }

  for (const s of steps) getAncestors(s.id);
  return cache;
}

// visibleKeys, when provided, limits which context keys are visible to the
// prompt renderer (FR-005). The full accumulated context is always returned
// so later steps can apply their own filter.
// defaultTimeoutMs is the pipeline-level fallback; step.timeoutMs takes precedence.
function buildLlmStep(
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

      // Thread per-step and pipeline-level timeouts into the runner deps.
      // runLlmStep resolves the effective timeout as: timeoutMs ?? defaultTimeoutMs.
      const runnerDeps: StepRunnerDeps = {
        ...(deps.runnerDeps ?? {}),
        ...(step.timeoutMs !== undefined ? { timeoutMs: step.timeoutMs } : {}),
        ...(defaultTimeoutMs !== undefined ? { defaultTimeoutMs } : {}),
      };

      const raw = await runner(entry, prompt, runnerDeps);

      let value: unknown = raw;
      if (step.schema) {
        const r1 = tryParseSchemaOutput(raw, step.schema);
        if (!r1.ok) {
          // One retry with explicit error feedback.
          const retryPrompt =
            `${prompt}\n\nYour previous output was not valid JSON (${r1.error}).` +
            ` Return ONLY the JSON object.`;
          const retryRaw = await runner(entry, retryPrompt, deps.runnerDeps ?? {});
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

function buildParallelMergeStep(phaseName: string, phaseSteps: StepDef[]) {
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

function buildAssembleStep(stepId: string) {
  return createStep({
    id: stepId,
    inputSchema: ctx,
    outputSchema: ctx,
    execute: ({ inputData }) => {
      const ctxData = inputData as Ctx;
      const spec = assembleSpec({
        request: ctxData.request as string | undefined,
        intake: ctxData.intake as string,
        enrich: ctxData.enrich as string,
        critic: ctxData.critic as { weaknesses: [] },
        security: ctxData.security as { securityFindings: [] },
      });
      return Promise.resolve({ ...ctxData, spec });
    },
  });
}

function buildGateStep(step: StepDef) {
  return createStep({
    id: step.id,
    inputSchema: ctx,
    outputSchema: ctx,
    resumeSchema: z.object({ approved: z.boolean() }),
    suspendSchema: z.object({ message: z.string(), spec: z.unknown() }),
    execute: async ({ inputData, resumeData, suspend }) => {
      const ctxData = inputData as Ctx;
      if (resumeData) {
        return { ...ctxData, approved: resumeData.approved };
      }
      await suspend({ message: step.message ?? "Approve this spec?", spec: ctxData.spec });
      // unreachable — suspend() throws internally; satisfies TypeScript return type
      return ctxData;
    },
  });
}

function buildPersistStep(stepId: string, store: TicketStore) {
  return createStep({
    id: stepId,
    inputSchema: ctx,
    outputSchema: ctx,
    execute: async ({ inputData }) => {
      const ctxData = inputData as Ctx;
      if (ctxData.approved === false) {
        return { approved: false };
      }
      const spec = ctxData.spec as HardenedSpec;
      const { ticketId } = await persistTicket(store, spec);
      return { ...ctxData, ticketId, approved: true };
    },
  });
}

/**
 * Validates a caller-supplied models override map against known registry ids.
 * Returns an error string if any value is unknown, or null if all are valid.
 * Only registered ids are accepted — the registry passthrough is intentionally
 * not reachable from untrusted callers (e.g. MCP input).
 */
export function validateModelOverrides(
  models: Record<string, string>,
  registry: ModelRegistry
): string | null {
  const validIds = registry.list().map((e) => e.id);
  for (const [stepId, modelId] of Object.entries(models)) {
    if (!validIds.includes(modelId)) {
      return `Step "${stepId}": unknown model id "${modelId}". Valid ids: ${validIds.join(", ")}`;
    }
  }
  return null;
}

// Builds the loop body as a committed child workflow and returns the body,
// condition, and outcome step that are chained by buildLevelsOntoBuilder.
//
// State is carried in the data flow rather than a closure so that concurrent
// runs on the same built workflow cannot overwrite each other's state.
function buildLoopStep(
  step: StepDef,
  body: LoadedPipeline,
  deps: BuildDeps
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
  bodyBuilder = buildLevelsOntoBuilder(
    bodyBuilder,
    body.def,
    body.prompts,
    deps,
    body.bodies ?? {}
  );

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
    Boolean((inputData as Ctx)?.[step.until!]) || iterationCount >= step.maxIterations!;

  const outcomeStep = createStep({
    id: `__${step.id}_outcome`,
    inputSchema: ctx,
    outputSchema: ctx,
    execute: async ({ inputData }) => {
      const rawCtx = inputData as Ctx;
      const converged = Boolean(rawCtx[step.until!]);
      const iterations = (rawCtx[iterKey] as number | undefined) ?? 0;
      const { [iterKey]: _dropped, ...rest } = rawCtx;
      return { ...rest, [step.id]: { converged, iterations } };
    },
  });

  return { bodyWorkflow, condition, outcomeStep };
}

// Applies the topological levels of `def` onto `builder`, dispatching each
// step to its builder function. `bodies` provides resolved loop-body pipelines.
function buildLevelsOntoBuilder(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  builder: any,
  def: PipelineDef,
  prompts: Record<string, string>,
  deps: BuildDeps,
  bodies: Record<string, LoadedPipeline>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): any {
  const levels = pipelineLevels(def.steps);
  const stepById = new Map(def.steps.map((s) => [s.id, s]));
  const ancestorMap = computeAncestors(def.steps);
  const alwaysVisible = new Set([...def.inputs, "models"]);

  for (let i = 0; i < levels.length; i++) {
    const level = levels[i];
    const levelSteps = level.map((id) => stepById.get(id)!);

    if (levelSteps.length > 1) {
      // All steps in a multi-step level must be llm steps.
      const mastraSteps = levelSteps.map((step) => {
        if (step.kind !== "llm") {
          throw new Error(
            `Step "${step.id}" (kind "${step.kind}") is in a parallel level — only llm steps may be parallelised`
          );
        }
        const stepAncestors = ancestorMap.get(step.id) ?? new Set<string>();
        const visibleKeys = new Set([...alwaysVisible, ...stepAncestors]);
        return buildLlmStep(step, prompts, deps, def.defaultTimeoutMs, visibleKeys);
      });
      builder = builder.parallel(mastraSteps);
      builder = builder.then(buildParallelMergeStep(`level_${i}`, levelSteps));
    } else {
      const step = levelSteps[0];
      if (step.kind === "llm") {
        const stepAncestors = ancestorMap.get(step.id) ?? new Set<string>();
        const visibleKeys = new Set([...alwaysVisible, ...stepAncestors]);
        builder = builder.then(
          buildLlmStep(step, prompts, deps, def.defaultTimeoutMs, visibleKeys)
        );
      } else if (step.kind === "assemble-spec") {
        builder = builder.then(buildAssembleStep(step.id));
      } else if (step.kind === "gate") {
        builder = builder.then(buildGateStep(step));
      } else if (step.kind === "persist-ticket") {
        builder = builder.then(buildPersistStep(step.id, deps.store));
      } else if (step.kind === "loop") {
        const body = bodies[step.id];
        if (!body) {
          throw new Error(
            `Step "${step.id}": loop body not resolved — call expandNested before buildPipelineWorkflow`
          );
        }
        const { bodyWorkflow, condition, outcomeStep } = buildLoopStep(step, body, deps);
        builder = builder.dountil(bodyWorkflow, condition);
        builder = builder.then(outcomeStep);
      }
    }
  }

  return builder;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function buildPipelineWorkflow(loaded: LoadedPipeline, deps: BuildDeps): any {
  const { def, prompts } = loaded;

  // Workflow input schema: pipeline inputs as strings + optional models override.
  const inputShape: Record<string, z.ZodTypeAny> = {};
  for (const inp of def.inputs) {
    inputShape[inp] = z.string();
  }
  inputShape.models = z.record(z.string(), z.string()).optional();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let builder: any = createWorkflow({
    id: def.id,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    inputSchema: z.object(inputShape) as z.ZodObject<any>,
    outputSchema: ctx,
  });

  builder = buildLevelsOntoBuilder(builder, def, prompts, deps, loaded.bodies ?? {});
  return builder.commit();
}
