import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { parse } from "yaml";
import { GraphError, pipelineAncestors, pipelineLevels } from "./graph.js";
import { expandNested } from "./nest.js";
import { extractPlaceholders } from "./render.js";
import {
  BUILD_CONFIG_DENY_PATTERNS,
  CREDENTIAL_DENY_PATTERNS,
  normalisePattern,
} from "./runStep.js";
import { canonSchemas } from "./schemas.js";
import type { LoadedPipeline, PipelineDef, Role } from "./types.js";

const VALID_ROLES: Role[] = ["reasoner", "worker", "scout"];

// Returns true when an allow entry removes a given deny pattern.
// Accepts the convenient form where an entry without the leading glob prefix
// matches if it equals the trailing path segment of the deny pattern.
// ".env.local" matches the deny pattern for that file because ".env.local"
// is its last segment. This is safe — the removal is limited to that exact
// named pattern, so no broader access is silently granted than intended.
function allowEntryMatches(entry: string, deniedPattern: string): boolean {
  const normEntry = normalisePattern(entry);
  const normDenied = normalisePattern(deniedPattern);
  if (normEntry === normDenied) return true;
  const lastSegment = normDenied.split("/").pop() ?? normDenied;
  return normEntry === lastSegment;
}

// Returns the deny pattern most likely intended by an unrecognised allow entry.
// Finds the first pattern whose trailing segment contains the entry as a
// substring, or whose segment is contained within the entry. Returns undefined
// when nothing plausible is found; callers fall back to listing all patterns.
function findSuggestion(entry: string, patterns: readonly string[]): string | undefined {
  const low = normalisePattern(entry).toLowerCase();
  return patterns.find((p) => {
    const last = (normalisePattern(p).split("/").pop() ?? normalisePattern(p)).toLowerCase();
    return last.includes(low) || low.includes(last);
  });
}

/** Fields that are illegal on every non-llm step kind. */
const NON_LLM_FORBIDDEN = ["prompt", "model", "schema", "permissions", "skills"] as const;

/** Fields that are illegal on every step kind OTHER than "check". */
const NON_CHECK_FORBIDDEN = ["env"] as const;

/** Runs pipelineLevels and re-throws GraphError as a plain Error (preserving the message). */
function assertLevels(steps: PipelineDef["steps"]): void {
  try {
    pipelineLevels(steps);
  } catch (err) {
    if (err instanceof GraphError) {
      throw new Error(err.message, { cause: err });
    }
    throw err;
  }
}

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
    // Migration guard: the deprecated `workspace` key was renamed to `permissions`.
    if ((step as unknown as Record<string, unknown>).workspace !== undefined) {
      throw new Error(
        `Step "${step.id}": "workspace" has been renamed to "permissions". ` +
          `Replace:\n  workspace: read|write\nwith:\n  permissions:\n    contents: read|write`
      );
    }
  }

  // Validate defaultMaxBudgetUsd if present
  const defBudget = (def as unknown as Record<string, unknown>).defaultMaxBudgetUsd;
  if (defBudget !== undefined) {
    if (typeof defBudget !== "number" || defBudget <= 0) {
      throw new Error(
        `Pipeline "${def.id}": defaultMaxBudgetUsd must be a positive number; got ${JSON.stringify(defBudget)}`
      );
    }
  }

  // Every name in optionalInputs must also be declared in inputs.
  if (def.optionalInputs) {
    const inputSet = new Set(def.inputs);
    for (const name of def.optionalInputs) {
      if (!inputSet.has(name)) {
        throw new Error(
          `optionalInputs entry "${name}" is not listed in inputs. ` +
            `Declared inputs: ${def.inputs.join(", ") || "(none)"}`
        );
      }
    }
  }

  // When any step uses dependsOn, validate the full graph via the shared module.
  const hasDependsOn = def.steps.some((s) => s.dependsOn !== undefined);
  if (hasDependsOn) assertLevels(def.steps);

  const prompts: Record<string, string> = {};

  for (const step of def.steps) {
    if (
      step.kind === "pipeline" ||
      step.kind === "loop" ||
      step.kind === "check" ||
      step.kind === "gate" ||
      step.kind === "assemble-spec" ||
      step.kind === "persist-ticket" ||
      step.kind === "export-spec"
    ) {
      for (const field of NON_LLM_FORBIDDEN) {
        if ((step as unknown as Record<string, unknown>)[field] !== undefined) {
          throw new Error(`Step "${step.id}": ${step.kind} step cannot set ${field}`);
        }
      }
      // maxBudgetUsd is llm-only; reject on all other step kinds
      if ((step as unknown as Record<string, unknown>).maxBudgetUsd !== undefined) {
        throw new Error(`Step "${step.id}": maxBudgetUsd is only allowed on llm steps`);
      }
      // env is only valid on check steps; reject it on all other non-llm kinds.
      if (step.kind !== "check") {
        for (const field of NON_CHECK_FORBIDDEN) {
          if ((step as unknown as Record<string, unknown>)[field] !== undefined) {
            throw new Error(`Step "${step.id}": ${step.kind} step cannot set ${field}`);
          }
        }
      }
      if (step.role !== undefined) {
        throw new Error(`Step "${step.id}": role is only allowed on llm steps`);
      }
      // manualOnly is only valid on gate steps (FR-013).
      if (
        step.kind !== "gate" &&
        (step as unknown as Record<string, unknown>).manualOnly !== undefined
      ) {
        throw new Error(`Step "${step.id}": manualOnly is only allowed on gate steps`);
      }

      if (step.kind === "pipeline") {
        if (!step.pipeline) {
          throw new Error(`Step "${step.id}": pipeline step requires pipeline`);
        }
        continue;
      }

      if (step.kind === "loop") {
        if (!step.pipeline) {
          throw new Error(`Step "${step.id}": loop step requires pipeline`);
        }
        if (
          !step.maxIterations ||
          !Number.isInteger(step.maxIterations) ||
          step.maxIterations <= 0
        ) {
          throw new Error(
            `Step "${step.id}": loop step requires maxIterations to be a positive integer`
          );
        }
        if (!step.until) {
          throw new Error(`Step "${step.id}": loop step requires until`);
        }
        continue;
      }

      if (step.kind === "check") {
        if (!step.command) {
          throw new Error(`Step "${step.id}": check step requires command`);
        }
        // FR-004: {{checkCommand}} is the only supported placeholder in a command.
        // Any other {{...}} would reach /bin/sh literally; reject it loudly so the
        // author discovers the mistake at load time rather than at runtime.
        for (const ph of extractPlaceholders(step.command)) {
          if (ph !== "checkCommand") {
            throw new Error(
              `Step "${step.id}": command contains unknown placeholder "{{${ph}}}" — only {{checkCommand}} is supported`
            );
          }
        }
        // Validate the optional env allowlist field.
        const envField = (step as unknown as Record<string, unknown>).env;
        if (envField !== undefined) {
          if (!Array.isArray(envField) || (envField as unknown[]).length === 0) {
            throw new Error(
              `Step "${step.id}": env must be a non-empty array of environment variable name strings`
            );
          }
          for (const entry of envField as unknown[]) {
            if (
              typeof entry !== "string" ||
              entry.trim() === "" ||
              !/^[A-Za-z_][A-Za-z0-9_]*$/.test(entry)
            ) {
              throw new Error(
                `Step "${step.id}": env entries must be valid environment variable names ` +
                  `(letters, digits, underscore; must start with a letter or underscore); ` +
                  `got: ${JSON.stringify(entry)}`
              );
            }
          }
        }
        continue;
      }

      if (step.kind === "export-spec") {
        if (!step.path) {
          throw new Error(`Step "${step.id}": export-spec step requires path`);
        }
        continue;
      }

      if (step.kind === "gate") {
        const manualOnlyField = (step as unknown as Record<string, unknown>).manualOnly;
        if (manualOnlyField !== undefined && typeof manualOnlyField !== "boolean") {
          throw new Error(
            `Step "${step.id}": manualOnly must be a boolean; got ${JSON.stringify(manualOnlyField)}`
          );
        }
        continue;
      }

      // assemble-spec / persist-ticket: validated above; skip llm checks.
      continue;
    }

    if (step.kind === "llm") {
      // manualOnly is only valid on gate steps (FR-013).
      if ((step as unknown as Record<string, unknown>).manualOnly !== undefined) {
        throw new Error(`Step "${step.id}": manualOnly is only allowed on gate steps`);
      }
      // env is only valid on check steps; reject it on llm steps too.
      for (const field of NON_CHECK_FORBIDDEN) {
        if ((step as unknown as Record<string, unknown>)[field] !== undefined) {
          throw new Error(`Step "${step.id}": llm step cannot set ${field}`);
        }
      }

      // Validate maxBudgetUsd if present
      const budgetField = (step as unknown as Record<string, unknown>).maxBudgetUsd;
      if (budgetField !== undefined) {
        if (typeof budgetField !== "number" || budgetField <= 0) {
          throw new Error(
            `Step "${step.id}": maxBudgetUsd must be a positive number; got ${JSON.stringify(budgetField)}`
          );
        }
      }

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

    if (step.permissions !== undefined) {
      const perms = step.permissions as unknown as Record<string, unknown>;
      const unknownScopes = Object.keys(perms).filter(
        (k) => k !== "contents" && k !== "allow" && k !== "deny"
      );
      if (unknownScopes.length > 0) {
        throw new Error(
          `Step "${step.id}": permissions contains unknown scope(s) "${unknownScopes.join('", "')}" — ` +
            `only "contents" is supported`
        );
      }
      const contentsValue = perms.contents;
      if (
        contentsValue !== undefined &&
        contentsValue !== "read" &&
        contentsValue !== "write" &&
        contentsValue !== "none"
      ) {
        const safeValue =
          typeof contentsValue === "string" ? contentsValue : JSON.stringify(contentsValue);
        throw new Error(
          `Step "${step.id}": permissions.contents "${safeValue}" is invalid — ` +
            `must be "read", "write", or "none"`
        );
      }

      // allow and deny are only meaningful when contents is declared — an exception
      // to a deny list that is not applied is a silent no-op, so we reject this.
      for (const field of ["allow", "deny"] as const) {
        const fieldValue = perms[field];
        if (fieldValue === undefined) continue;
        if (contentsValue === undefined) {
          throw new Error(
            `Step "${step.id}": permissions.${field} requires permissions.contents to be set — ` +
              `an exception to a deny list that is not applied is a silent no-op`
          );
        }
        if (!Array.isArray(fieldValue) || (fieldValue as unknown[]).length === 0) {
          throw new Error(
            `Step "${step.id}": permissions.${field} must be a non-empty array of strings`
          );
        }
        for (const entry of fieldValue as unknown[]) {
          if (typeof entry !== "string" || entry.trim() === "") {
            throw new Error(
              `Step "${step.id}": permissions.${field} entries must be non-blank strings`
            );
          }
        }
      }

      // Validate that each allow entry actually matches a deny pattern it could
      // remove. An entry that removes nothing is a silent no-op and the
      // operator must be told — this is exactly the class of bug this project
      // has been bitten by before ("declared but silently dropped").
      if (perms.allow !== undefined) {
        const stepDenyEntries = Array.isArray(perms.deny) ? (perms.deny as string[]) : [];
        const effectiveDenyPatterns: readonly string[] = [
          ...CREDENTIAL_DENY_PATTERNS,
          ...BUILD_CONFIG_DENY_PATTERNS,
          ...stepDenyEntries,
        ];
        for (const entry of perms.allow as string[]) {
          if (!effectiveDenyPatterns.some((p) => allowEntryMatches(entry, p))) {
            const suggestion = findSuggestion(entry, effectiveDenyPatterns);
            const hint =
              suggestion != null
                ? `did you mean "${suggestion}"?`
                : `available patterns: ${[...effectiveDenyPatterns].map((p) => `"${p}"`).join(", ")}`;
            throw new Error(
              `Step "${step.id}": permissions.allow entry "${entry}" does not match any deny pattern — ${hint}`
            );
          }
        }
      }
    }

    if (step.skills !== undefined) {
      if (step.skills.length === 0) {
        throw new Error(`Step "${step.id}": skills must not be empty`);
      }
      for (const skill of step.skills) {
        if (typeof skill !== "string" || skill.trim() === "") {
          throw new Error(`Step "${step.id}": skills entries must be non-blank strings`);
        }
      }
    }
  }

  // Resolve and expand nested pipelines. The resolve callback loads a sibling
  // YAML from the same directory as the parent, recursively validated.
  const pipelineDir = dirname(resolve(yamlPath));
  const resolveNested = (pipelineId: string): LoadedPipeline =>
    loadPipeline(join(pipelineDir, `${pipelineId}.yaml`), deps);

  const expanded = expandNested({ def, prompts }, resolveNested);

  // Graph validity is enforced on the expanded result.
  const expandedHasDependsOn = expanded.def.steps.some((s) => s.dependsOn !== undefined);
  if (expandedHasDependsOn) assertLevels(expanded.def.steps);

  // Validate prompt placeholders against the keys each step can actually see
  // at runtime: pipeline inputs plus transitive ancestor step ids.
  // Uses extractPlaceholders from render.ts so the pattern cannot diverge.
  const ancestorMap = pipelineAncestors(expanded.def.steps);
  const alwaysAvailable = new Set([...expanded.def.inputs, "models"]);
  for (const step of expanded.def.steps) {
    const promptText = expanded.prompts[step.id];
    if (promptText === undefined) continue;
    const stepAncestors = ancestorMap.get(step.id) ?? new Set<string>();
    const available = new Set([...alwaysAvailable, ...stepAncestors]);
    for (const ph of extractPlaceholders(promptText)) {
      if (!available.has(ph)) {
        const availList = [...expanded.def.inputs, ...stepAncestors].join(", ");
        throw new Error(
          `Step "${step.id}": prompt references unknown placeholder "{{${ph}}}" — available: ${availList}`
        );
      }
    }
  }

  return expanded;
}

export function listPipelines(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
    .map((f) => join(dir, f));
}
