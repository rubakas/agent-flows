import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { parse } from "yaml";
import { GraphError, pipelineAncestors, pipelineLevels } from "./graph.js";
import { expandNested } from "./nest.js";
import { extractPlaceholders } from "./render.js";
import { canonSchemas } from "./schemas.js";
import type { LoadedPipeline, PipelineDef, Role, StepDef } from "./types.js";

const VALID_ROLES: Role[] = ["reasoner", "worker", "scout"];

/** A declared input name must be a plain identifier — it is emitted as one. */
const RE_INPUT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;

/** Fields that are illegal on every non-llm step kind. */
const NON_LLM_FORBIDDEN = [
  "prompt",
  "model",
  "schema",
  "permissions",
  "skills",
  "produces",
] as const;

/** Fields that are illegal on every step kind OTHER than "check". */
const NON_CHECK_FORBIDDEN = ["env", "required"] as const;

/**
 * Step kinds OTHER THAN `llm` that may declare `required`: a failure of theirs
 * can fail the run. `llm` is validated in `validateLlmStep`, which never reaches
 * this set — there `required: false` means the opposite thing, a dimension that
 * may fail without ending the run.
 */
const REQUIRED_ALLOWED_KINDS = new Set(["check", "review-material"]);

/**
 * Rejects a deadline that is not a positive whole number of milliseconds.
 *
 * `0` used to be the documented escape hatch for "no deadline". It is refused
 * now because it silently removes the only supervisor a codex or api step has:
 * the claude transport keeps its progress watchdog, but those two would hang
 * forever, and the codex adapter's `finally` — which deletes the sanitized copy
 * of the repo — would never run. A step that genuinely needs longer must say how
 * much longer.
 */
function assertPositiveTimeout(subject: string, field: string, value: unknown): void {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(
      `${subject}: ${field} must be a positive integer number of milliseconds; ` +
        `got ${JSON.stringify(value)}. There is no "no deadline" value — on codex and api ` +
        `it would leave a hung step unsupervised.`
    );
  }
}

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

/** Injected dependencies of the loader. */
export interface LoadDeps {
  /** Reads one file; injected by the draft preview route so it can load unsaved text. */
  readFile?: (p: string) => string;
  /**
   * Maps a nested pipeline id to the YAML file that defines it (spec 038 D13,
   * FR-019). Absent means the legacy rule: a sibling file in the parent's own
   * directory. The merged view passes a resolver over all three layers, so a
   * forked parent can mount a child from another layer.
   */
  resolvePath?: (pipelineId: string) => string | undefined;
  /**
   * Pipeline ids currently being loaded, innermost last. Internal: set by the
   * loader itself when it recurses into a nested pipeline, so a cycle that spans
   * files — now reachable across layers, where an id collision plus a mount can
   * form one — is reported instead of exhausting the call stack.
   */
  loadStack?: readonly string[];
}

/**
 * Validates a step of any kind other than `llm`: the fields that are llm-only
 * are refused here, then the per-kind required fields are checked.
 */
function validateNonLlmStep(step: StepDef): void {
  const raw = step as unknown as Record<string, unknown>;
  for (const field of NON_LLM_FORBIDDEN) {
    if (raw[field] !== undefined) {
      throw new Error(`Step "${step.id}": ${step.kind} step cannot set ${field}`);
    }
  }
  // maxBudgetUsd is llm-only; reject on all other step kinds
  if (raw.maxBudgetUsd !== undefined) {
    throw new Error(`Step "${step.id}": maxBudgetUsd is only allowed on llm steps`);
  }
  // failover is llm-only: no other step kind is dispatched to a provider.
  if (raw.failover !== undefined) {
    throw new Error(`Step "${step.id}": failover is only allowed on llm steps`);
  }
  // env is only valid on check steps; required also on review-material steps.
  for (const field of NON_CHECK_FORBIDDEN) {
    if (raw[field] === undefined) continue;
    if (step.kind === "check") continue;
    if (field === "required" && REQUIRED_ALLOWED_KINDS.has(step.kind)) continue;
    throw new Error(`Step "${step.id}": ${step.kind} step cannot set ${field}`);
  }
  if (step.role !== undefined) {
    throw new Error(`Step "${step.id}": role is only allowed on llm steps`);
  }
  // manualOnly is only valid on gate steps (FR-013).
  if (step.kind !== "gate" && raw.manualOnly !== undefined) {
    throw new Error(`Step "${step.id}": manualOnly is only allowed on gate steps`);
  }

  if (step.kind === "pipeline") {
    if (!step.pipeline) {
      throw new Error(`Step "${step.id}": pipeline step requires pipeline`);
    }
    return;
  }

  if (step.kind === "loop") {
    if (!step.pipeline) {
      throw new Error(`Step "${step.id}": loop step requires pipeline`);
    }
    if (!step.maxIterations || !Number.isInteger(step.maxIterations) || step.maxIterations <= 0) {
      throw new Error(
        `Step "${step.id}": loop step requires maxIterations to be a positive integer`
      );
    }
    if (!step.until) {
      throw new Error(`Step "${step.id}": loop step requires until`);
    }
    return;
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
    // Validate the optional required flag: a terminal check that fails the run.
    const requiredField = raw.required;
    if (requiredField !== undefined && typeof requiredField !== "boolean") {
      throw new Error(
        `Step "${step.id}": required must be a boolean; got ${JSON.stringify(requiredField)}`
      );
    }
    // Validate the optional env allowlist field.
    const envField = raw.env;
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
    return;
  }

  if (step.kind === "review-material") {
    // Takes neither a command nor a prompt: what it captures is fixed, and the
    // only run-scoped value it reads — `baseline` — is validated against a
    // revision pattern at capture time, never rendered into anything.
    if (raw.command !== undefined) {
      throw new Error(`Step "${step.id}": review-material step cannot set command`);
    }
    const requiredField = raw.required;
    if (requiredField !== undefined && typeof requiredField !== "boolean") {
      throw new Error(
        `Step "${step.id}": required must be a boolean; got ${JSON.stringify(requiredField)}`
      );
    }
    return;
  }

  if (step.kind === "export-spec") {
    if (!step.path) {
      throw new Error(`Step "${step.id}": export-spec step requires path`);
    }
    return;
  }

  if (step.kind === "gate") {
    const manualOnlyField = raw.manualOnly;
    if (manualOnlyField !== undefined && typeof manualOnlyField !== "boolean") {
      throw new Error(
        `Step "${step.id}": manualOnly must be a boolean; got ${JSON.stringify(manualOnlyField)}`
      );
    }
    return;
  }

  // assemble-spec / persist-ticket: validated above; skip llm checks.
  return;
}

/**
 * Validates an `llm` step and returns the contents of its prompt file, which is
 * read here because the containment check and the read must see the same path.
 */
function validateLlmStep(
  step: StepDef,
  ctx: { repoRoot: string; rootWithSep: string; readFile: (p: string) => string }
): string {
  const { repoRoot, rootWithSep, readFile } = ctx;
  const raw = step as unknown as Record<string, unknown>;
  // manualOnly is only valid on gate steps (FR-013).
  if (raw.manualOnly !== undefined) {
    throw new Error(`Step "${step.id}": manualOnly is only allowed on gate steps`);
  }
  // env is only valid on check steps; reject it on llm steps too.
  for (const field of NON_CHECK_FORBIDDEN) {
    if (field === "required") continue;
    if (raw[field] !== undefined) {
      throw new Error(`Step "${step.id}": llm step cannot set ${field}`);
    }
  }

  // `required: false` makes an llm step an optional dimension: it may fail
  // without failing the run. The default stays true, so every pipeline that
  // does not say otherwise keeps the old behaviour.
  const requiredField = raw.required;
  if (requiredField !== undefined && typeof requiredField !== "boolean") {
    throw new Error(
      `Step "${step.id}": required must be a boolean; got ${JSON.stringify(requiredField)}`
    );
  }

  // Validate timeoutMs if present (same reasoning as defaultTimeoutMs above)
  const timeoutField = raw.timeoutMs;
  if (timeoutField !== undefined) {
    assertPositiveTimeout(`Step "${step.id}"`, "timeoutMs", timeoutField);
  }

  // `produces: spec` publishes the step's answer as the run's spec. The value is
  // an enum of one: a misspelling here is silent data loss — the gate would keep
  // showing the pre-revision spec — so it is refused at load time.
  const producesField = raw.produces;
  if (producesField !== undefined && producesField !== "spec") {
    throw new Error(
      `Step "${step.id}": produces must be "spec"; got ${JSON.stringify(producesField)}`
    );
  }

  // Validate the optional failover flag: false pins the step to one provider.
  const failoverField = raw.failover;
  if (failoverField !== undefined && typeof failoverField !== "boolean") {
    throw new Error(
      `Step "${step.id}": failover must be a boolean; got ${JSON.stringify(failoverField)}`
    );
  }

  const budgetField = raw.maxBudgetUsd;
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
    return readFile(resolvedPromptPath);
  } catch {
    throw new Error(`Step "${step.id}": prompt file "${step.prompt}" not found`);
  }
}

/** Validates the fields whose rules do not depend on the step kind. */
function validateStepCommon(step: StepDef): void {
  if (step.schema !== undefined && !(step.schema in canonSchemas)) {
    throw new Error(`Step "${step.id}": unknown schema "${String(step.schema)}"`);
  }

  if (step.role !== undefined && step.kind !== "llm") {
    throw new Error(`Step "${step.id}": role is only allowed on llm steps`);
  }

  if (step.permissions !== undefined) {
    const perms = step.permissions as unknown as Record<string, unknown>;
    // D5/FR-009: `allow` is not an unknown scope — it is a removed one, and the
    // operator needs the removal named rather than a generic "unknown scope".
    if (perms.allow !== undefined) {
      throw new Error("permissions.allow was removed (spec 031); deny is narrowing-only");
    }
    const unknownScopes = Object.keys(perms).filter((k) => k !== "contents" && k !== "deny");
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

    // deny is only meaningful when contents is declared — a deny list that is
    // not applied is a silent no-op, so we reject this.
    const denyValue = perms.deny;
    if (denyValue !== undefined) {
      if (contentsValue === undefined) {
        throw new Error(
          `Step "${step.id}": permissions.deny requires permissions.contents to be set — ` +
            `a deny list that is not applied is a silent no-op`
        );
      }
      if (!Array.isArray(denyValue) || (denyValue as unknown[]).length === 0) {
        throw new Error(`Step "${step.id}": permissions.deny must be a non-empty array of strings`);
      }
      for (const entry of denyValue as unknown[]) {
        if (typeof entry !== "string" || entry.trim() === "") {
          throw new Error(`Step "${step.id}": permissions.deny entries must be non-blank strings`);
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

export function loadPipeline(yamlPath: string, deps?: LoadDeps): LoadedPipeline {
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

  // A non-positive deadline used to mean "no deadline". It is rejected now: on a
  // transport with no watchdog (codex, api) it removes supervision entirely, so a
  // hung child runs forever and the sanitized copy is never removed.
  const defTimeout = (def as unknown as Record<string, unknown>).defaultTimeoutMs;
  if (defTimeout !== undefined) {
    assertPositiveTimeout(`Pipeline "${def.id}"`, "defaultTimeoutMs", defTimeout);
  }

  const defBudget = (def as unknown as Record<string, unknown>).defaultMaxBudgetUsd;
  if (defBudget !== undefined) {
    if (typeof defBudget !== "number" || defBudget <= 0) {
      throw new Error(
        `Pipeline "${def.id}": defaultMaxBudgetUsd must be a positive number; got ${JSON.stringify(defBudget)}`
      );
    }
  }

  // Declared input names become JavaScript identifiers in the generated Binding
  // A script and placeholder keys at render time, so anything that is not a
  // plain identifier is refused here rather than emitted into a script.
  for (const name of def.inputs ?? []) {
    if (typeof name !== "string" || !RE_INPUT_NAME.test(name)) {
      throw new Error(
        `Pipeline "${def.id}": input ${JSON.stringify(name)} is not a valid identifier — ` +
          `input names must match ${RE_INPUT_NAME.source}`
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
      step.kind === "review-material" ||
      step.kind === "gate" ||
      step.kind === "assemble-spec" ||
      step.kind === "persist-ticket" ||
      step.kind === "export-spec"
    ) {
      validateNonLlmStep(step);
      continue;
    }

    if (step.kind === "llm") {
      prompts[step.id] = validateLlmStep(step, { repoRoot, rootWithSep, readFile });
    }

    validateStepCommon(step);
  }

  // Resolve and expand nested pipelines. Without an injected resolver the child
  // is a sibling YAML in the parent's own directory; with one (the merged view)
  // it is whichever layer owns that id, and its prompts resolve against that
  // layer's prompts/ directory because the child is loaded from its own path.
  const pipelineDir = dirname(resolve(yamlPath));
  const loadStack: readonly string[] = [...(deps?.loadStack ?? []), def.id];
  const resolveNested = (pipelineId: string): LoadedPipeline => {
    // A cycle is detected here as well as inside expandNested: by the time the
    // child comes back it is already expanded, so the stack expandNested keeps
    // never sees the grandchild that closes the loop.
    const cycleIdx = loadStack.indexOf(pipelineId);
    if (cycleIdx !== -1) {
      const chain = [...loadStack.slice(cycleIdx), pipelineId].join(" -> ");
      throw new GraphError(`cycle detected in nested pipelines: ${chain}`);
    }
    const childPath = deps?.resolvePath
      ? deps.resolvePath(pipelineId)
      : join(pipelineDir, `${pipelineId}.yaml`);
    if (childPath === undefined) {
      throw new Error(
        `Pipeline "${def.id}": nested pipeline "${pipelineId}" is not defined in any workflow layer`
      );
    }
    return loadPipeline(childPath, { ...deps, loadStack });
  };

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
