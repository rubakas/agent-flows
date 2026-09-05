import { ASSEMBLE_JS } from "../canon/assembleSource.js";
import { pipelineLevels } from "../canon/graph.js";
import {
  defaultRegistry,
  getActiveProfile,
  resolveStepModel,
  type ProviderProfile,
} from "../canon/registry.js";
import { FINDING } from "../canon/schemas.js";
import type { LoadedPipeline, StepDef } from "../canon/types.js";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Emit a JS single-quoted string literal. */
function sq(s: string): string {
  return "'" + s.replace(/\\/g, "\\\\").replace(/'/g, "\\'") + "'";
}

function modelVar(id: string): string {
  return "m" + capitalize(id);
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

  return escaped.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => {
    return inputVars.has(name) ? `\${${name}}` : `\${r_${name}}`;
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

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export function generateWorkflowScript(loaded: LoadedPipeline, profile?: ProviderProfile): string {
  // Profile is resolved at generation time and baked into the script — correct for
  // Binding A which always runs under Claude Code with the active provider profile.
  const resolvedProfile = profile ?? getActiveProfile();
  const registry = defaultRegistry();
  const { def, prompts } = loaded;
  const inputVars = new Set<string>(def.inputs);
  const llmSteps = def.steps.filter((s) => s.kind === "llm");

  const dependsOnLevels = pipelineLevels(def.steps);
  const phases = computePhasesForDependsOn(def.steps, dependsOnLevels);

  const out: string[] = [];

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
    const entry = resolveStepModel(step, resolvedProfile, registry);
    const concreteModel = entry.cli?.model ?? entry.api?.model ?? entry.id;
    out.push(`const ${modelVar(step.id)} = models.${step.id} || '${concreteModel}'`);
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

    out.push("");
  }

  // ── steps ─────────────────────────────────────────────────────────────────
  {
    // dependsOn path: derive step groups from pipelineLevels, emit one phase() per level.
    const stepById = new Map(def.steps.map((s) => [s.id, s]));
    const stepVarNames = new Map<string, string>(); // step id → JS result variable name
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
          const resultVars = llmInLevel.map((gs) => `${gs.id}Res`);
          for (const gs of llmInLevel) stepVarNames.set(gs.id, `${gs.id}Res`);

          out.push(`const [${resultVars.join(", ")}] = await parallel([`);
          for (const gs of llmInLevel) {
            const converted = convertPromptTemplate(prompts[gs.id], inputVars);
            const schemaArg = gs.schema
              ? `, schema: ${gs.schema === "weaknesses" ? "WEAK_SCHEMA" : "SEC_SCHEMA"}`
              : "";
            const skillsArg = gs.skills?.length ? `, skills: ${JSON.stringify(gs.skills)}` : "";
            out.push("  () =>");
            out.push("    agent(");
            out.push("      `" + converted + "`,");
            out.push(
              `      { label: '${gs.id}', phase: '${phaseTitle}', model: ${modelVar(gs.id)}${schemaArg}${skillsArg} },`
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
          stepVarNames.set(step.id, `r_${step.id}`);
          const converted = convertPromptTemplate(prompts[step.id], inputVars);
          const skillsArg = step.skills?.length ? `, skills: ${JSON.stringify(step.skills)}` : "";
          out.push(`const r_${step.id} = await agent(`);
          out.push("  `" + converted + "`,");
          out.push(
            `  { label: '${step.id}', phase: '${phaseTitle}', model: ${modelVar(step.id)}${skillsArg} },`
          );
          out.push(")");
          if (isFirstSingleLlm) {
            out.push(`if (!r_${step.id}) throw new Error('${step.id} agent failed')`);
            isFirstSingleLlm = false;
          }
          out.push("");
        }
      }

      // Emit non-llm steps that land in this level.
      for (const step of nonLlmInLevel) {
        if (step.kind === "assemble-spec") {
          const allLlm = def.steps.filter((s) => s.kind === "llm");
          out.push("const _assembleInput = {");
          for (const s of allLlm) {
            const varName = stepVarNames.get(s.id) ?? `r_${s.id}`;
            out.push(`  ${s.id}: ${varName},`);
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
        } else if (step.kind === "gate") {
          out.push(`// gate '${step.id}': handled in chat by the orchestrating session`);
        } else if (step.kind === "persist-ticket") {
          out.push("// persist: pipe result.spec into 'pnpm persist'");
        } else if (step.kind === "export-spec") {
          out.push(`// export-spec '${step.id}': write spec.md to '${step.path}'`);
        } else if (step.kind === "loop") {
          out.push(
            `// loop '${step.id}': body pipeline '${step.pipeline}', cap ${step.maxIterations} iterations — Binding A does not implement the loop`
          );
        } else if (step.kind === "check") {
          out.push(`// check '${step.id}': run \`${step.command}\``);
        }
      }
    }
  }

  // ── return ────────────────────────────────────────────────────────────────
  out.push("");
  out.push("return {");
  out.push("  spec,");
  out.push("  summary: {");
  out.push("    title: spec.title,");
  out.push("    requirements: spec.requirements.length,");
  out.push("    acceptanceCriteria: spec.acceptanceCriteria.length,");
  out.push("    weaknesses: spec.weaknesses.length,");
  out.push("    securityFindings: spec.securityFindings.length,");
  out.push("    blocking,");
  out.push("  },");
  out.push("}");

  return out.join("\n");
}
