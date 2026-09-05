import { GraphError } from "./graph.js";
import type { LoadedPipeline, StepDef } from "./types.js";

/**
 * Expands all `kind: "pipeline"` steps in `loaded` into flat step lists,
 * depth-first, so callers (including bindings) see a plain pipeline with no
 * nesting steps.
 *
 * @param resolve - Dependency-injected loader; must return the LoadedPipeline
 *   for the given pipeline id. Mirrors the `deps?: { readFile }` convention
 *   used in load.ts — no filesystem access occurs inside this module.
 */
export function expandNested(
  loaded: LoadedPipeline,
  resolve: (pipelineId: string) => LoadedPipeline,
  opts?: { maxDepth?: number }
): LoadedPipeline {
  const maxDepth = opts?.maxDepth ?? 10;
  return expand(loaded, resolve, [loaded.def.id], maxDepth, 0);
}

function expand(
  loaded: LoadedPipeline,
  resolve: (pipelineId: string) => LoadedPipeline,
  // Pipeline ids currently on the expansion stack; used for cycle detection.
  stack: readonly string[],
  maxDepth: number,
  depth: number
): LoadedPipeline {
  if (depth >= maxDepth) {
    throw new GraphError(`nested pipeline max depth (${maxDepth}) exceeded`);
  }

  const hasNested = loaded.def.steps.some((s) => s.kind === "pipeline");
  if (!hasNested) return loaded;

  // Maps each nesting step id → the namespaced ids of its terminal steps, so
  // parent steps that depended on the nesting step can be rewired.
  const terminalMap = new Map<string, string[]>();
  const rawSteps: StepDef[] = [];
  const expandedPrompts: Record<string, string> = { ...loaded.prompts };

  for (const step of loaded.def.steps) {
    if (step.kind !== "pipeline") {
      rawSteps.push(step);
      continue;
    }

    const nestedPipelineId = step.pipeline!;

    const cycleIdx = stack.indexOf(nestedPipelineId);
    if (cycleIdx !== -1) {
      const chain = [...stack.slice(cycleIdx), nestedPipelineId].join(" -> ");
      throw new GraphError(`cycle detected in nested pipelines: ${chain}`);
    }

    const nestedLoaded = resolve(nestedPipelineId);
    const nestedExpanded = expand(
      nestedLoaded,
      resolve,
      [...stack, nestedPipelineId],
      maxDepth,
      depth + 1
    );
    const nestedSteps = nestedExpanded.def.steps;

    // Entry steps: those with no declared dependencies inside the nested pipeline.
    // Terminal steps: those no other nested step depends on.
    const dependedOn = new Set<string>();
    for (const ns of nestedSteps) {
      for (const d of ns.dependsOn ?? []) {
        dependedOn.add(d);
      }
    }
    const entryIds = new Set(nestedSteps.filter((s) => !s.dependsOn?.length).map((s) => s.id));
    const terminalIds = nestedSteps.filter((s) => !dependedOn.has(s.id)).map((s) => s.id);
    terminalMap.set(
      step.id,
      terminalIds.map((t) => `${step.id}.${t}`)
    );

    for (const ns of nestedSteps) {
      const namespacedId = `${step.id}.${ns.id}`;

      let dependsOn: readonly string[] | undefined;
      if (entryIds.has(ns.id)) {
        // Entry steps inherit the nesting step's dependsOn.
        dependsOn = step.dependsOn?.length ? step.dependsOn : undefined;
      } else {
        // Internal edges are namespaced.
        dependsOn = ns.dependsOn!.map((d) => `${step.id}.${d}`);
      }

      const { id: _id, dependsOn: _dep, pipeline: _pip, ...rest } = ns;
      rawSteps.push({
        id: namespacedId,
        ...(dependsOn !== undefined ? { dependsOn } : {}),
        ...rest,
      });

      if (nestedExpanded.prompts[ns.id] !== undefined) {
        expandedPrompts[namespacedId] = nestedExpanded.prompts[ns.id];
      }
    }
  }

  // Rewrite any dependsOn reference that names a nesting step to instead
  // reference that step's terminal steps.
  const finalSteps: StepDef[] = rawSteps.map((s) => {
    if (!s.dependsOn?.length) return s;
    const newDeps: string[] = [];
    for (const dep of s.dependsOn) {
      const terminals = terminalMap.get(dep);
      if (terminals) {
        newDeps.push(...terminals);
      } else {
        newDeps.push(dep);
      }
    }
    return { ...s, dependsOn: newDeps };
  });

  return {
    def: { ...loaded.def, steps: finalSteps },
    prompts: expandedPrompts,
  };
}
