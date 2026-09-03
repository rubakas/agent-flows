export interface GraphStep {
  readonly id: string;
  readonly dependsOn?: readonly string[];
}

export class GraphError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GraphError";
  }
}

function validate(steps: readonly GraphStep[]): void {
  // Check duplicate ids
  const seen = new Set<string>();
  for (const s of steps) {
    if (seen.has(s.id)) {
      throw new GraphError(`duplicate step id: '${s.id}'`);
    }
    seen.add(s.id);
  }

  const idSet = new Set(steps.map((s) => s.id));

  // Check unknown references
  for (const s of steps) {
    for (const dep of s.dependsOn ?? []) {
      if (!idSet.has(dep)) {
        throw new GraphError(`step '${s.id}' references unknown id '${dep}' in dependsOn`);
      }
    }
  }

  // Build a lookup map for the DFS
  const depMap = new Map<string, readonly string[]>();
  for (const s of steps) {
    depMap.set(s.id, s.dependsOn ?? []);
  }

  // Detect cycles via DFS; traverse dependsOn edges (step → its dependencies).
  // A back-edge to a node still on the current path means a cycle.
  const visited = new Set<string>();
  const onPath = new Set<string>();
  const path: string[] = [];

  const dfs = (id: string): string[] | null => {
    onPath.add(id);
    path.push(id);

    for (const dep of depMap.get(id)!) {
      if (onPath.has(dep)) {
        // Extract the cycle portion and close it for the error message.
        const start = path.indexOf(dep);
        const cycle = path.slice(start);
        return [...cycle, cycle[0]];
      }
      if (!visited.has(dep)) {
        const cycle = dfs(dep);
        if (cycle) return cycle;
      }
    }

    path.pop();
    onPath.delete(id);
    visited.add(id);
    return null;
  };

  for (const s of steps) {
    if (!visited.has(s.id)) {
      const cycle = dfs(s.id);
      if (cycle) {
        throw new GraphError(`cycle detected: ${cycle.join(" → ")}`);
      }
    }
  }
}

/**
 * Core levelling loop with no validation.
 *
 * Exported only for defence-in-depth testing. All production callers must run
 * `validate()` first; calling this on unvalidated input can produce an
 * infinite loop if a cycle is present — which is exactly the failure mode the
 * guard inside the loop is designed to convert into a loud throw.
 *
 * @internal
 */
export function _computeLevels(steps: readonly GraphStep[]): readonly (readonly string[])[] {
  if (steps.length === 0) return [];

  const done = new Set<string>();
  const remaining = new Set(steps.map((s) => s.id));
  const levels: (readonly string[])[] = [];

  while (remaining.size > 0) {
    const level: string[] = [];
    for (const s of steps) {
      if (!remaining.has(s.id)) continue;
      const deps = s.dependsOn ?? [];
      if (deps.every((d) => done.has(d))) {
        level.push(s.id);
      }
    }

    // Defence-in-depth: if no step is ready, a cycle is present that
    // validate() should have caught. A hang here takes down the yoke serve
    // daemon (ADR-0014), so throw loudly rather than spin.
    if (level.length === 0) {
      const stuck = [...remaining].join(", ");
      throw new GraphError(`cycle detected — cannot level remaining steps: ${stuck}`);
    }

    for (const id of level) {
      remaining.delete(id);
      done.add(id);
    }
    levels.push(level);
  }

  return levels;
}

/**
 * Topologically levels a DAG of steps.
 *
 * Level 0 contains every step with no dependencies. Level N contains every
 * step all of whose dependencies appear in levels < N. Within each level the
 * input declaration order is preserved so that binder output is deterministic.
 */
export function pipelineLevels(steps: readonly GraphStep[]): readonly (readonly string[])[] {
  validate(steps);
  return _computeLevels(steps);
}

/**
 * Maps canon step declarations to a flat node/edge representation.
 *
 * One edge per `dependsOn` entry: `from` is the dependency, `to` is the
 * dependent step. No topology is inferred — the graph is exactly what the
 * steps declare. Node order follows declaration order; edge order follows node
 * order then dependency list order.
 */
export function pipelineToGraph(steps: readonly GraphStep[]): {
  nodes: { id: string }[];
  edges: { from: string; to: string }[];
} {
  validate(steps);

  const nodes = steps.map((s) => ({ id: s.id }));
  const edges: { from: string; to: string }[] = [];

  for (const s of steps) {
    for (const dep of s.dependsOn ?? []) {
      edges.push({ from: dep, to: s.id });
    }
  }

  return { nodes, edges };
}
