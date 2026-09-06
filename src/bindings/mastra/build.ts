// Binding B: build a Mastra workflow from a neutral LoadedPipeline.
//
// Design: accumulator context pattern.
//   - All steps share a single Record<string, unknown> input/output schema.
//   - Each step receives the full accumulated context and returns it extended with its output.
//   - Parallel phase steps each carry the full context forward; a synthetic merge step
//     combines them back into a single context after the parallel block.
//   - The workflow input is the pipeline's declared inputs + optional models override map.

import { createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";
import { pipelineAncestors, pipelineLevels } from "../../canon/graph.js";
import {
  type BuildDeps,
  type LevelBuilder,
  buildAssembleStep,
  buildCheckStep,
  buildExportSpecStep,
  buildGateStep,
  buildLlmStep,
  buildLoopStep,
  buildParallelMergeStep,
  buildPersistStep,
  ctx,
} from "./buildSteps.js";
import type { ModelRegistry } from "../../canon/registry.js";
import type { LoadedPipeline, PipelineDef, StepDef } from "../../canon/types.js";

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

/**
 * Walks `stepId`'s dependency tree (breadth-first, preferring the order
 * declared in `dependsOn`) and returns the nearest ancestor whose kind is
 * "gate", or undefined when none is found.
 *
 * Used by buildLevelsOntoBuilder to wire persist-ticket and export-spec steps
 * to the specific gate whose decision they must respect. Passing the gate id
 * rather than deriving it from a shared namespace key prevents two gates that
 * share a namespace prefix from overwriting each other's decision.
 */
function findGateAncestor(stepId: string, stepById: Map<string, StepDef>): string | undefined {
  const step = stepById.get(stepId);
  if (!step) return undefined;
  for (const dep of step.dependsOn ?? []) {
    const depStep = stepById.get(dep);
    if (depStep?.kind === "gate") return dep;
    const deeper = findGateAncestor(dep, stepById);
    if (deeper !== undefined) return deeper;
  }
  return undefined;
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
  const ancestorMap = pipelineAncestors(def.steps);
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
        const gateId = findGateAncestor(step.id, stepById);
        if (gateId === undefined) {
          throw new Error(
            `Step "${step.id}": persist-ticket requires a preceding gate step in its dependency chain`
          );
        }
        builder = builder.then(buildPersistStep(step.id, deps.store, gateId));
      } else if (step.kind === "loop") {
        const body = bodies[step.id];
        if (!body) {
          throw new Error(
            `Step "${step.id}": loop body not resolved — call expandNested before buildPipelineWorkflow`
          );
        }
        const { bodyWorkflow, condition, outcomeStep } = buildLoopStep(
          step,
          body,
          deps,
          buildLevelsOntoBuilder as LevelBuilder
        );
        builder = builder.dountil(bodyWorkflow, condition);
        builder = builder.then(outcomeStep);
      } else if (step.kind === "check") {
        builder = builder.then(buildCheckStep(step, deps, def.defaultTimeoutMs));
      } else if (step.kind === "export-spec") {
        const gateId = findGateAncestor(step.id, stepById);
        if (gateId === undefined) {
          throw new Error(
            `Step "${step.id}": export-spec requires a preceding gate step in its dependency chain`
          );
        }
        builder = builder.then(buildExportSpecStep(step.id, step.path!, gateId));
      } else {
        // Without this, an unhandled kind contributes no Mastra step and the run
        // silently skips it. `pipeline` steps in particular must already be gone.
        throw new Error(
          `Step "${step.id}": kind "${step.kind}" is not executable — pipeline steps must be expanded before buildPipelineWorkflow`
        );
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

export type { BuildDeps } from "./buildSteps.js";
