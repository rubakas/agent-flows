import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { parse } from "yaml";
import { GraphError, pipelineLevels } from "./graph.js";
import { expandNested } from "./nest.js";
import { canonSchemas } from "./schemas.js";
import type { LoadedPipeline, PipelineDef, Role } from "./types.js";

const VALID_ROLES: Role[] = ["reasoner", "worker", "scout"];

/** Thrown when a prompt path fails the containment check. Distinct from fs errors. */
class PromptPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PromptPathError";
  }
}

export function loadPipeline(
  yamlPath: string,
  deps?: { readFile?: (p: string) => string }
): LoadedPipeline {
  const readFile = deps?.readFile ?? ((p: string) => readFileSync(p, "utf8"));

  const yamlContent = readFile(yamlPath);
  const def = parse(yamlContent) as PipelineDef;

  // Repo root = parent of the yaml file's directory
  const repoRoot = dirname(dirname(resolve(yamlPath)));
  const resolvedRoot = resolve(repoRoot);
  const rootWithSep = resolvedRoot.endsWith(sep) ? resolvedRoot : resolvedRoot + sep;

  const ids = new Set<string>();
  for (const step of def.steps) {
    if (ids.has(step.id)) {
      throw new Error(`Duplicate step id "${step.id}"`);
    }
    ids.add(step.id);
  }

  // When any step uses dependsOn, validate the full graph via the shared module.
  const hasDependsOn = def.steps.some((s) => s.dependsOn !== undefined);
  if (hasDependsOn) {
    try {
      pipelineLevels(def.steps);
    } catch (err) {
      if (err instanceof GraphError) {
        throw new Error(err.message, { cause: err });
      }
      throw err;
    }
  }

  const prompts: Record<string, string> = {};

  for (const step of def.steps) {
    if (step.kind === "pipeline") {
      if (!step.pipeline) {
        throw new Error(`Step "${step.id}": pipeline step requires pipeline`);
      }
      if (step.prompt !== undefined) {
        throw new Error(`Step "${step.id}": pipeline step cannot set prompt`);
      }
      if (step.role !== undefined) {
        throw new Error(`Step "${step.id}": role is only allowed on llm steps`);
      }
      if (step.model !== undefined) {
        throw new Error(`Step "${step.id}": pipeline step cannot set model`);
      }
      if (step.schema !== undefined) {
        throw new Error(`Step "${step.id}": pipeline step cannot set schema`);
      }
      if (step.workspace !== undefined) {
        throw new Error(`Step "${step.id}": pipeline step cannot set workspace`);
      }
      continue;
    }

    if (step.kind === "llm") {
      if (!step.role && !step.model) {
        throw new Error(`Step "${step.id}": llm step requires role or model`);
      }
      if (step.role && step.model) {
        throw new Error(`Step "${step.id}": step cannot set both role and model`);
      }
      if (step.role && !VALID_ROLES.includes(step.role)) {
        throw new Error(`Step "${step.id}": unknown role "${step.role}"`);
      }
      if (!step.prompt) {
        throw new Error(`Step "${step.id}": llm step requires prompt`);
      }
      const resolvedPromptPath = resolve(repoRoot, step.prompt);
      if (!resolvedPromptPath.startsWith(rootWithSep)) {
        throw new PromptPathError(
          `Step "${step.id}": prompt path "${step.prompt}" escapes the pipeline root`
        );
      }
      try {
        const realPromptPath = realpathSync(resolvedPromptPath);
        if (!realPromptPath.startsWith(rootWithSep)) {
          throw new PromptPathError(
            `Step "${step.id}": prompt path "${step.prompt}" resolves outside the pipeline root via symlink`
          );
        }
      } catch (err) {
        if (err instanceof PromptPathError) throw err;
        // ENOENT or other fs error: file does not exist, let readFile handle below
      }
      try {
        prompts[step.id] = readFile(resolvedPromptPath);
      } catch {
        throw new Error(`Step "${step.id}": prompt file "${step.prompt}" not found`);
      }
    }

    if (step.schema !== undefined && !(step.schema in canonSchemas)) {
      throw new Error(`Step "${step.id}": unknown schema "${String(step.schema)}"`);
    }

    if (step.role !== undefined && step.kind !== "llm") {
      throw new Error(`Step "${step.id}": role is only allowed on llm steps`);
    }

    if (step.workspace !== undefined && step.workspace !== "read") {
      throw new Error(
        `Step "${step.id}": invalid workspace value "${String(step.workspace)}" — only "read" is supported`
      );
    }
  }

  // Resolve and expand nested pipelines. The resolve callback loads a sibling
  // YAML from the same directory as the parent, recursively validated.
  const pipelineDir = dirname(resolve(yamlPath));
  const resolveNested = (pipelineId: string): LoadedPipeline =>
    loadPipeline(join(pipelineDir, `${pipelineId}.yaml`), deps);

  const expanded = expandNested({ def, prompts }, resolveNested);

  // Gate count and graph validity are enforced on the expanded result.
  let gateCount = 0;
  for (const step of expanded.def.steps) {
    if (step.kind === "gate") {
      gateCount++;
      if (gateCount > 1) {
        throw new Error(`Step "${step.id}": v1 pipelines may have at most one gate`);
      }
    }
  }

  const expandedHasDependsOn = expanded.def.steps.some((s) => s.dependsOn !== undefined);
  if (expandedHasDependsOn) {
    try {
      pipelineLevels(expanded.def.steps);
    } catch (err) {
      if (err instanceof GraphError) {
        throw new Error(err.message, { cause: err });
      }
      throw err;
    }
  }

  return expanded;
}

export function listPipelines(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
    .map((f) => join(dir, f));
}
