import { ASSEMBLE_JS } from "../canon/assembleSource.js";
import { pipelineLevels } from "../canon/graph.js";
import {
  defaultRegistry,
  getActiveProfile,
  resolveStepModel,
  type ModelRegistry,
  type ProviderProfile,
} from "../canon/registry.js";
import { CODE_REVIEW_FINDING, FINDING } from "../canon/schemas.js";
import type { LoadedPipeline, StepDef, StepKind } from "../canon/types.js";

// Step kinds that Binding A can fully execute. All others produce a loud refusal.
const SUPPORTED_STEP_KINDS = new Set<StepKind>(["llm", "assemble-spec"]);

// Canon schema name → the JS constant name emitted into the generated script.
// Keep in sync with canonSchemas; a missing entry would silently emit `undefined`.
//
// `codeReviewDelivery` has no emitter below, and that is deliberate. The only
// step that declares it is `delivery` in code-review.yaml, and code-review is
// Binding-A-unsupported (see the refusal in generateWorkflowScript), so the
// branch that used to emit CODE_REVIEW_DELIVERY_SCHEMA was unreachable for every
// pipeline we ship. The entry stays because this Record is total over
// StepDef["schema"] and dropping it fails the typecheck — it is a placeholder,
// not wiring. Adding a Binding-A-supported pipeline with this schema means
// restoring the emitter here; nothing mechanical catches that today.
const SCHEMA_CONST_BY_NAME: Record<NonNullable<StepDef["schema"]>, string> = {
  weaknesses: "WEAK_SCHEMA",
  securityFindings: "SEC_SCHEMA",
  codeReviewFindings: "CODE_REVIEW_SCHEMA",
  codeReviewDelivery: "CODE_REVIEW_DELIVERY_SCHEMA",
};

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Emit a JS single-quoted string literal. */
function sq(s: string): string {
  return "'" + s.replace(/\\/g, "\\\\").replace(/'/g, "\\'") + "'";
}

/** Emit an object key: bare when the id is a valid identifier, quoted otherwise. */
function objKey(id: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(id) ? id : sq(id);
}

/** Convert a dotted step id (e.g. "verify.synthesis") to a valid JS identifier segment. */
function safeId(id: string): string {
  return id.replace(/\./g, "_");
}

function modelVar(id: string): string {
  return "m" + id.split(".").map(capitalize).join("");
}

/**
 * The `, schema: X` fragment for a step's agent() options, or "" when the step
 * declares no schema. Shared by the parallel and sequential emit paths — a step
 * alone in its dependency level must be schema-gated exactly like a parallel one.
 */
function schemaArg(step: StepDef): string {
  return step.schema ? `, schema: ${SCHEMA_CONST_BY_NAME[step.schema]}` : "";
}

/**
 * Convert a prompt template string into a JS template-literal body.
 *
 * Steps (order matters):
 *   1. Escape backslashes, backticks, and existing `${` in the raw text.
 *   2. Replace `{{name}}` with `${name}` (input vars) or `${r_name}` (step results).
 *      These substituted `${…}` sequences are intentionally NOT escaped.
 */
function convertPromptTemplate(template: string, inputVars: Set<string>): string {
  const escaped = template.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");

  return escaped.replace(/\{\{([\w.]+)\}\}/g, (_match, name: string) => {
    return inputVars.has(name) ? `\${${name}}` : `\${r_${safeId(name)}}`;
  });
}

/**
 * Derive meta phases from levelled DAG steps.
 *
 * Each level that contains at least one llm step becomes one phase entry.
 * The phase title is derived from the first step id in the level (capitalized),
 * which preserves declaration order and produces a meaningful label rather than
 * a generic "Level0" index.
 */
function computePhasesForDependsOn(
  steps: StepDef[],
  levels: readonly (readonly string[])[]
): { title: string }[] {
  const stepById = new Map(steps.map((s) => [s.id, s]));
  const phases: { title: string }[] = [];
  for (const level of levels) {
    if (level.some((id) => stepById.get(id)?.kind === "llm")) {
      phases.push({ title: capitalize(level[0]) });
    }
  }
  return phases;
}

export function generateWorkflowScript(
  loaded: LoadedPipeline,
  profile?: ProviderProfile,
  registry?: ModelRegistry
): string {
  // Profile and registry are resolved at generation time and baked into the script —
  // correct for Binding A which always runs under Claude Code with the active provider profile.
  const resolvedProfile = profile ?? getActiveProfile();
  const resolvedRegistry = registry ?? defaultRegistry();
  const { def, prompts } = loaded;

  // Refuse loudly rather than silently emit a NoOp comment for unsupported step kinds.
  //
  // `code-review` is refused here as of spec 044, and that is a decision, not an
  // oversight: its `material` step runs git in the daemon through spawnSync argv
  // arrays (see runtime/reviewMaterial.ts), and Binding A emits a Claude Code
  // workflow script whose only primitive is `agent()`. There is nothing in a
  // generated script that can run git without handing a shell string to a model,
  // which is the injection D3 of that spec refuses. So code-review is
  // Binding-A-unsupported for as long as it captures its own material, and the
  // partition in claudeCode.test.ts pins that — a kind added to the set above
  // without moving a pipeline across it goes red.
  for (const step of def.steps) {
    if (!SUPPORTED_STEP_KINDS.has(step.kind)) {
      throw new Error(
        `Pipeline '${def.id}': step '${step.id}' (kind: '${step.kind}') is not implemented by Binding A — ` +
          `Binding A only executes 'llm' and 'assemble-spec' steps.`
      );
    }
  }

  const inputVars = new Set<string>(def.inputs);
  const llmSteps = def.steps.filter((s) => s.kind === "llm");

  const dependsOnLevels = pipelineLevels(def.steps);
  const phases = computePhasesForDependsOn(def.steps, dependsOnLevels);

  const out: string[] = [];

  // ── permissions banner ────────────────────────────────────────────────────
  // The Claude Code dynamic-workflow agent() API (as of the current CLI) accepts
  // only { label, phase, model, schema?, skills? }. It has no permissions option.
  // Any per-step permissions: { contents: ... } declared in the canon are NOT
  // enforced by Binding A — steps run with the host session's access level.
  out.push("// NOTICE: per-step permissions declared in the pipeline canon (permissions.contents)");
  out.push("// are NOT enforced by Binding A. The Claude Code workflow agent() API does not");
  out.push("// accept a permission-restriction option. Every step in this workflow runs with");
  out.push("// the host Claude Code session's access level. Use Binding B (Mastra) for");
  out.push("// per-step permission enforcement.");
  out.push("");

  // ── meta ──────────────────────────────────────────────────────────────────
  out.push("export const meta = {");
  out.push(`  name: ${sq(def.id)},`);
  out.push(`  description: ${sq(def.description)},`);
  out.push("  phases: [");
  for (const ph of phases) {
    out.push(`    { title: ${sq(ph.title)} },`);
  }
  out.push("  ],");
  out.push("}");
  out.push("");

  // ── args guard for each declared input ───────────────────────────────────
  for (const inp of def.inputs) {
    out.push(`const ${inp} = args && typeof args.${inp} === 'string' ? args.${inp}.trim() : ''`);
    out.push(`if (!${inp}) {`);
    out.push(
      `  throw new Error('args.${inp} is required and must be non-empty — refusing to run without it')`
    );
    out.push(`}`);
  }
  out.push(`const models = (args && args.models) || {}`);

  // ── model variable per llm step ───────────────────────────────────────────
  for (const step of llmSteps) {
    const entry = resolveStepModel(step, resolvedProfile, resolvedRegistry);
    const concreteModel = entry.cli?.model ?? entry.api?.model ?? entry.id;
    out.push(`const ${modelVar(step.id)} = models[${sq(step.id)}] || ${sq(concreteModel)}`);
  }
  out.push("");

  // ── schema constants (emitted once, before the first parallel block) ──────
  const usedSchemas = new Set(def.steps.map((s) => s.schema).filter(Boolean) as string[]);

  if (usedSchemas.size > 0) {
    out.push(`const FINDING = ${JSON.stringify(FINDING, null, 2)}`);

    if (usedSchemas.has("weaknesses")) {
      out.push("const WEAK_SCHEMA = {");
      out.push("  type: 'object',");
      out.push("  properties: { weaknesses: { type: 'array', items: FINDING } },");
      out.push("  required: ['weaknesses'],");
      out.push("  additionalProperties: false,");
      out.push("}");
    }

    if (usedSchemas.has("securityFindings")) {
      out.push("const SEC_SCHEMA = {");
      out.push("  type: 'object',");
      out.push("  properties: { securityFindings: { type: 'array', items: FINDING } },");
      out.push("  required: ['securityFindings'],");
      out.push("  additionalProperties: false,");
      out.push("}");
    }

    if (usedSchemas.has("codeReviewFindings")) {
      out.push(`const CODE_REVIEW_FINDING = ${JSON.stringify(CODE_REVIEW_FINDING, null, 2)}`);
      out.push("const CODE_REVIEW_SCHEMA = {");
      out.push("  type: 'object',");
      out.push(
        "  properties: { codeReviewFindings: { type: 'array', items: CODE_REVIEW_FINDING } },"
      );
      out.push("  required: ['codeReviewFindings'],");
      out.push("  additionalProperties: false,");
      out.push("}");
    }

    out.push("");
  }

  // ── steps ─────────────────────────────────────────────────────────────────
  const stepVarNames = new Map<string, string>(); // step id → JS result variable name
  const emittedLlmIds: string[] = []; // llm step ids in emission order
  {
    // dependsOn path: derive step groups from pipelineLevels, emit one phase() per level.
    const stepById = new Map(def.steps.map((s) => [s.id, s]));
    let isFirstSingleLlm = true; // null-guard only on the first single-step llm level

    for (const level of dependsOnLevels) {
      const stepsInLevel = level.map((id) => stepById.get(id)!);
      const llmInLevel = stepsInLevel.filter((s) => s.kind === "llm");
      const nonLlmInLevel = stepsInLevel.filter((s) => s.kind !== "llm");

      if (llmInLevel.length > 0) {
        // Phase title = capitalize of the level's first step id (declaration order preserved
        // by pipelineLevels). Using step id rather than level index gives a meaningful label.
        const phaseTitle = capitalize(level[0]);
        out.push(`phase(${sq(phaseTitle)})`);
        out.push(`log('Running ${phaseTitle.toLowerCase()} steps…')`);
        out.push("");

        if (llmInLevel.length > 1) {
          // Parallel block — mirrors the existing phase-path parallel block exactly.
          const resultVars = llmInLevel.map((gs) => `${safeId(gs.id)}Res`);
          for (const gs of llmInLevel) {
            stepVarNames.set(gs.id, `${safeId(gs.id)}Res`);
            emittedLlmIds.push(gs.id);
          }

          out.push(`const [${resultVars.join(", ")}] = await parallel([`);
          for (const gs of llmInLevel) {
            const converted = convertPromptTemplate(prompts[gs.id], inputVars);
            const skillsArg = gs.skills?.length ? `, skills: ${JSON.stringify(gs.skills)}` : "";
            out.push("  () =>");
            out.push("    agent(");
            out.push("      `" + converted + "`,");
            out.push(
              `      { label: '${gs.id}', phase: '${phaseTitle}', model: ${modelVar(gs.id)}${schemaArg(gs)}${skillsArg} },`
            );
            out.push("    ),");
          }
          out.push("])");
          out.push("");

          // Null-guard extractions for schema fields
          for (const gs of llmInLevel) {
            if (gs.schema) {
              out.push(`const ${gs.schema} = (${gs.id}Res && ${gs.id}Res.${gs.schema}) || []`);
            }
          }
          out.push("");

          // A parallel level has run first: no subsequent single-step level should
          // carry the null-guard, because none of them is genuinely "first".
          isFirstSingleLlm = false;
        } else {
          // Sequential — single llm step in this level.
          const step = llmInLevel[0];
          const stepVar = `r_${safeId(step.id)}`;
          stepVarNames.set(step.id, stepVar);
          emittedLlmIds.push(step.id);
          const converted = convertPromptTemplate(prompts[step.id], inputVars);
          const skillsArg = step.skills?.length ? `, skills: ${JSON.stringify(step.skills)}` : "";
          out.push(`const ${stepVar} = await agent(`);
          out.push("  `" + converted + "`,");
          out.push(
            `  { label: '${step.id}', phase: '${phaseTitle}', model: ${modelVar(step.id)}${schemaArg(step)}${skillsArg} },`
          );
          out.push(")");
          if (isFirstSingleLlm) {
            out.push(`if (!${stepVar}) throw new Error('${step.id} agent failed')`);
            isFirstSingleLlm = false;
          }
          out.push("");
        }
      }

      // Emit non-llm steps that land in this level.
      // At this point all steps are guaranteed to be in SUPPORTED_STEP_KINDS (the
      // guard at the top of generateWorkflowScript throws before we get here otherwise).
      for (const step of nonLlmInLevel) {
        if (step.kind === "assemble-spec") {
          const allLlm = def.steps.filter((s) => s.kind === "llm");
          out.push("const _assembleInput = {");
          for (const s of allLlm) {
            const varName = stepVarNames.get(s.id) ?? `r_${safeId(s.id)}`;
            out.push(`  ${sq(s.id)}: ${varName},`);
          }
          out.push("}");
          out.push("const spec = (function(input) {");
          for (const line of ASSEMBLE_JS.split("\n")) {
            out.push("  " + line);
          }
          out.push("})(_assembleInput)");
          out.push("");
          out.push(
            "const blocking = [...spec.weaknesses, ...spec.securityFindings].filter(f => f.blocking).length"
          );
          out.push(
            "log(`Assembled: ${spec.requirements.length} requirements, ${spec.acceptanceCriteria.length} AC, ${spec.weaknesses.length} weaknesses, ${spec.securityFindings.length} security findings (${blocking} blocking)`)"
          );
          out.push("");
        }
      }
    }
  }

  // ── return ────────────────────────────────────────────────────────────────
  // `spec` and `blocking` are only declared by an assemble-spec step. A pipeline
  // without one must not reference them — the script would throw on an undefined
  // identifier before any step ran.
  const hasAssembleSpec = def.steps.some((s) => s.kind === "assemble-spec");

  out.push("");
  out.push("return {");
  if (hasAssembleSpec) {
    out.push("  spec,");
    out.push("  summary: {");
    out.push("    title: spec.title,");
    out.push("    requirements: spec.requirements.length,");
    out.push("    acceptanceCriteria: spec.acceptanceCriteria.length,");
    out.push("    weaknesses: spec.weaknesses.length,");
    out.push("    securityFindings: spec.securityFindings.length,");
    out.push("    blocking,");
    out.push("  },");
  } else {
    // No assembler: the honest result is the last step's own output, plus the
    // step ids that produced it. Nothing else is known at this layer.
    const finalId = emittedLlmIds[emittedLlmIds.length - 1];
    if (finalId !== undefined) {
      out.push(`  ${objKey(finalId)}: ${stepVarNames.get(finalId)!},`);
    }
    out.push("  summary: {");
    out.push(`    pipeline: ${sq(def.id)},`);
    out.push(`    steps: [${emittedLlmIds.map(sq).join(", ")}],`);
    if (finalId !== undefined) {
      out.push(`    finalStep: ${sq(finalId)},`);
    }
    out.push("  },");
  }
  out.push("}");

  return out.join("\n");
}
