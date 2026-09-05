import { GraphError } from "./graph.js";
import type { LoadedPipeline, StepDef } from "./types.js";

/**
 * Rewrites `{{name}}` placeholders in a prompt string at expansion time:
 *
 * - Pipeline inputs present in `withMapping` → replaced by the mapped parent key.
 * - Pipeline inputs NOT in `withMapping` → left unchanged (validated later by load.ts).
 * - Sibling step ids (that are not pipeline inputs) → namespaced to
 *   `{{nestingStepId.name}}`.
 * - Anything else → left unchanged.
 */
function rewritePromptPlaceholders(
  promptText: string,
  siblingIds: Set<string>,
  pipelineInputs: Set<string>,
  nestingStepId: string,
  withMapping: Record<string, string>
): string {
  return promptText.replace(/\{\{([\w.]+)\}\}/g, (_match, name: string) => {
    if (pipelineInputs.has(name)) {
      return name in withMapping ? `{{${withMapping[name]}}}` : _match;
    }
    if (siblingIds.has(name)) {
      return `{{${nestingStepId}.${name}}}`;
    }
    return _match;
  });
}

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

  const hasNested = loaded.def.steps.some((s) => s.kind === "pipeline" || s.kind === "loop");
  if (!hasNested) return loaded;

  // Maps each nesting step id → the namespaced ids of its terminal steps, so
  // parent steps that depended on the nesting step can be rewired.
  // Loop steps are kept intact, so they never enter this map.
  const terminalMap = new Map<string, string[]>();
  const rawSteps: StepDef[] = [];
  const expandedPrompts: Record<string, string> = { ...loaded.prompts };
  const bodies: Record<string, LoadedPipeline> = {};

  for (const step of loaded.def.steps) {
    if (step.kind === "loop") {
      // Loop bodies are resolved and stored in the bodies map but the loop step
      // itself is kept intact in the step list — expanding it would destroy the
      // loop boundary the binding needs.
      const bodyPipelineId = step.pipeline!;

      const cycleIdx = stack.indexOf(bodyPipelineId);
      if (cycleIdx !== -1) {
        const chain = [...stack.slice(cycleIdx), bodyPipelineId].join(" -> ");
        throw new GraphError(`cycle detected in nested pipelines: ${chain}`);
      }

      const bodyLoaded = resolve(bodyPipelineId);
      const bodyExpanded = expand(
        bodyLoaded,
        resolve,
        [...stack, bodyPipelineId],
        maxDepth,
        depth + 1
      );
      bodies[step.id] = bodyExpanded;
      rawSteps.push(step);
      continue;
    }

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

    // Validate with keys against the nested pipeline's declared inputs before expanding.
    if (step.with) {
      const nestedInputSet = new Set(nestedLoaded.def.inputs);
      for (const key of Object.keys(step.with)) {
        if (!nestedInputSet.has(key)) {
          throw new Error(
            `Step "${step.id}": with key "${key}" is not a declared input of pipeline "${nestedPipelineId}". Declared inputs: ${[...nestedInputSet].join(", ") || "(none)"}`
          );
        }
      }
    }

    const nestedExpanded = expand(
      nestedLoaded,
      resolve,
      [...stack, nestedPipelineId],
      maxDepth,
      depth + 1
    );
    const nestedSteps = nestedExpanded.def.steps;

    // Precompute sets for placeholder rewriting.
    const siblingIds = new Set(nestedSteps.map((s) => s.id));
    const pipelineInputs = new Set(nestedExpanded.def.inputs);
    const withMapping = step.with ?? {};

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

      const { id: _id, dependsOn: _dep, pipeline: _pip, with: _with, ...rest } = ns;
      rawSteps.push({
        id: namespacedId,
        ...(dependsOn !== undefined ? { dependsOn } : {}),
        ...rest,
      });

      if (nestedExpanded.prompts[ns.id] !== undefined) {
        expandedPrompts[namespacedId] = rewritePromptPlaceholders(
          nestedExpanded.prompts[ns.id],
          siblingIds,
          pipelineInputs,
          step.id,
          withMapping
        );
      }
    }

    // Forward loop bodies from the nested pipeline, namespacing their keys to
    // match the step ids produced above. A loop step with id `foo` inside
    // nested pipeline `bar` becomes `bar.foo` in the parent; its body must
    // follow under the same key so buildLevelsOntoBuilder can find it.
    if (nestedExpanded.bodies) {
      for (const [bodyKey, body] of Object.entries(nestedExpanded.bodies)) {
        bodies[`${step.id}.${bodyKey}`] = body;
      }
    }
  }

  // Rewrite any dependsOn reference that names a pipeline nesting step to
  // reference that step's terminal steps. Loop steps stay intact, so their
  // ids are never in terminalMap and pass through unchanged.
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

  const result: LoadedPipeline = {
    def: { ...loaded.def, steps: finalSteps },
    prompts: expandedPrompts,
  };
  if (Object.keys(bodies).length > 0) {
    result.bodies = bodies;
  }
  return result;
}
