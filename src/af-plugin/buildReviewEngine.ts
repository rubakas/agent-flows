// Generates plugin/workflows/review-engine.js (spec 046 D2, D5).
//
// A Claude dynamic workflow cannot read files, so the eight step prompts, their model
// tiers (all from pipelines/code-review.yaml) and the two output schemas are embedded into
// the script. They are embedded with JSON.stringify - never spliced into a template
// literal - so no character in a prompt can break out of the string it lives in. The
// output is deterministic: a test compares the committed script with buildWorkflow(), so
// editing the generated file by hand fails the build.
//
//   pnpm plugin:generate

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { pipelineAncestors } from "../canon/graph.js";
import { bundledPipelines } from "../canon/pipelines.js";
import { getProfile } from "../canon/registry.js";
import { extractPlaceholders } from "../canon/render.js";
import { workflowSchema } from "../canon/schemaRules.js";
import type { LoadedPipeline, Role } from "../canon/types.js";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const reference = join(root, "plugin", "skills", "review", "references");
export const WORKFLOW_PATH = join(root, "plugin", "workflows", "review-engine.js");

/** The pipeline the engine is generated from: code-review.yaml and its prompts. */
function codeReview(): LoadedPipeline {
  const found = bundledPipelines().get("code-review");
  if (found.kind !== "ok") throw new Error("the bundled code-review pipeline does not load");
  return found.loaded;
}

/** The eight review steps, in the pipeline's order. */
export const STEPS: string[] = codeReview()
  .def.steps.filter((step) => step.kind === "llm")
  .map((step) => step.id);

/** Placeholders the script fills from its own arguments, whatever a step depends on. */
const PROVIDED_INPUTS = ["plan", "specSources"];

/** Structural isolation: the synthesis step may see the verifier's output and nothing else. */
const ISOLATED: Record<string, string[]> = { synthesis: ["verify"] };

/** The tiers the Claude workflow runtime accepts as an agent's `model`. */
const CLAUDE_TIERS = ["opus", "sonnet", "haiku"];

/** The plugin's schema files, by the canon key each one is generated from. */
const SCHEMA_FILE = { codeReviewFindings: "findings", codeReviewDelivery: "delivery" } as const;

interface EngineTables {
  steps: string[];
  prompts: Record<string, string>;
  models: Record<string, string>;
  schemas: Record<string, object>;
}

/**
 * What the script takes from the pipeline: the llm steps, their prompts, their model tier
 * and their output schema. The generator refuses a pipeline the hand-written schedule in
 * the script cannot run. The tiers are the anthropic profile's, never the active
 * provider's, so the committed script does not depend on who regenerates it.
 */
export function reviewEngineTables(
  loaded: LoadedPipeline = codeReview(),
  roles: Record<Role, string> = getProfile("anthropic").roles
): EngineTables {
  const steps = loaded.def.steps;
  const provided = [
    ...PROVIDED_INPUTS,
    ...steps.filter((st) => st.kind === "review-material").map((st) => st.id),
  ];
  const ancestors = pipelineAncestors(steps);
  const tables: EngineTables = { steps: [], prompts: {}, models: {}, schemas: {} };

  for (const step of steps) {
    if (step.kind === "review-material") continue;
    if (step.kind !== "llm") {
      throw new Error(`step ${step.id} has kind ${step.kind}; the engine runs llm steps only`);
    }
    if (step.role === undefined) throw new Error(`step ${step.id} has no role`);
    const model = roles[step.role];
    if (!CLAUDE_TIERS.includes(model)) {
      throw new Error(
        `step ${step.id}: role ${step.role} maps to ${model}, outside ${CLAUDE_TIERS.join(", ")}`
      );
    }
    if (step.schema !== undefined) {
      if (!Object.hasOwn(SCHEMA_FILE, step.schema)) {
        throw new Error(
          `step ${step.id} declares schema ${step.schema}, which has no plugin schema file`
        );
      }
      tables.schemas[step.id] = workflowSchema(step.schema as keyof typeof SCHEMA_FILE);
    }

    const prompt = loaded.prompts[step.id];
    const names = [...new Set(extractPlaceholders(prompt))];
    const fillable = [...provided, ...(ancestors.get(step.id) ?? [])];
    const unknown = names.filter((name) => !fillable.includes(name));
    if (unknown.length > 0) {
      throw new Error(
        `prompt of ${step.id} uses placeholder(s) the engine cannot fill: ${unknown.join(", ")}`
      );
    }
    const isolated = ISOLATED[step.id];
    const extra = isolated === undefined ? [] : names.filter((name) => !isolated.includes(name));
    if (extra.length > 0) {
      throw new Error(
        `prompt of ${step.id} uses placeholder(s) beyond {{${isolated.join("}}, {{")}}}: ${extra.join(", ")} — ${step.id} must see only the verifier's output`
      );
    }

    tables.steps.push(step.id);
    tables.prompts[step.id] = prompt;
    tables.models[step.id] = model;
  }
  return tables;
}

/**
 * The generated schema files, keyed by absolute path. They are formatted the way
 * `prettier --write .` would leave them, so the repo's format check never rewrites them.
 */
export async function buildSchemaFiles(): Promise<Record<string, string>> {
  const prettier = await import("prettier");
  const files: Record<string, string> = {};
  for (const [key, name] of Object.entries(SCHEMA_FILE)) {
    const path = join(reference, "schemas", `${name}.json`);
    const config = await prettier.resolveConfig(path);
    files[path] = await prettier.format(
      JSON.stringify(workflowSchema(key as keyof typeof SCHEMA_FILE), null, 2),
      { ...config, filepath: path }
    );
  }
  return files;
}

const HEADER = `// GENERATED FILE - DO NOT EDIT.
// Source: pipelines/code-review.yaml, its prompts and src/canon/schemaRules.ts (generated by src/af-plugin/buildReviewEngine.ts)
// Regenerate with: pnpm plugin:generate
`;

const META = `export const meta = {
  name: 'review-engine',
  description:
    'Engine behind the af review skill: brief, parallel review dimensions, independent verification, synthesis. Do not start it directly - run /af:review, which captures the change first and passes {runDir, plan, hasSpecs}.',
  phases: [
    { title: 'Brief', detail: 'what the change is and what it is for' },
    { title: 'Review', detail: 'blast radius, falsifiability, delivery, correctness, security' },
    { title: 'Verify', detail: 'an independent check of every claim against the files' },
    { title: 'Synthesis', detail: 'one prioritised report from the verified findings only' },
  ],
}
`;

// String.raw keeps the script's backslashes as written; a backtick inside it is spelled \x60.
const BODY = String.raw`
// args may arrive as the caller's raw JSON string; accept both.
const ARGS =
  typeof args === 'string'
    ? (() => {
        try {
          return JSON.parse(args)
        } catch (e) {
          return undefined
        }
      })()
    : args

if (!ARGS || !ARGS.runDir) {
  throw new Error('review-engine requires args {runDir, plan?, hasSpecs} - start it through /af:review')
}
const runDir = String(ARGS.runDir)
const hasSpecs = ARGS.hasSpecs === true

const NO_SPECS = '{"specSourcesProvided":false,"codeReviewDelivery":[]}'

// The pointers below are substituted for EVERY occurrence of their placeholder, prose
// mentions included, so each reads as a noun phrase.
const MATERIAL =
  'the review material in the file \x60' + runDir + '/material.md\x60 (the baseline, diff, commits, changed files, ' +
  'paths withheld by credential policy, history probes and spec sources of the change under review; read ALL of it - ' +
  'page through it with Read offset/limit until the end - and open the full artefact files its section headings name)'
const PLAN = ARGS.plan ? String(ARGS.plan) : ''
const SPEC_SOURCES = hasSpecs
  ? 'the "## spec sources" sections of \x60' + runDir + '/material.md\x60 (read all of them) and the full spec files in \x60' +
    runDir + '/specs/\x60'
  : '(no spec sources were provided)'

// Byte-identical port of unavailableStepMarker in src/bindings/mastra/buildSteps.ts: what a
// failed step leaves for the steps after it, and what the verify prompt knows how to record.
function unavailableStepMarker(stepId, reason) {
  return (
    '## ' + stepId + ' unavailable\n' +
    'The "' + stepId + '" step failed, so this dimension was NOT examined.\n' +
    'Reason: ' + reason + '\n' +
    'Treat it as not run: it is not an empty result, it is not a pass, and nothing here may be read as evidence that this dimension is clean.'
  )
}

function placeholdersIn(template) {
  return [...template.matchAll(/\{\{([\w.]+)\}\}/g)].map((match) => match[1])
}

// A placeholder with no value is a wiring bug, not an empty section: fail loudly.
function render(template, vars) {
  const missing = placeholdersIn(template).filter(
    (name) => !Object.prototype.hasOwnProperty.call(vars, name)
  )
  if (missing.length > 0) throw new Error('prompt placeholder(s) with no value: ' + missing.join(', '))
  return template.replace(/\{\{([\w.]+)\}\}/g, (_, name) => vars[name])
}

function text(value) {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2)
}

function options(name, phaseTitle, model, extra) {
  return Object.assign({ agentType: 'af:reviewer', label: name, phase: phaseTitle, model: model }, extra)
}

// The brief and every worker may fail without ending the review: a null result or a thrown
// agent() (a schema still failing after its retries) becomes the marker. The prompt is
// rendered outside the try so a wiring error is never mistaken for a step failure.
async function optional(name, phaseTitle, model, vars, extra) {
  const prompt = render(PROMPTS[name], vars)
  let reason
  try {
    const out = await agent(prompt, options(name, phaseTitle, model, extra))
    if (out !== null && out !== undefined) return out
    reason = 'the step returned no output'
  } catch (err) {
    reason = err && err.message ? String(err.message) : String(err)
  }
  log(name + ' failed (' + reason + ') - continuing without it')
  return unavailableStepMarker(name, reason)
}

const worker = (name, vars, extra) => optional(name, 'Review', MODELS[name], vars, extra)

// radius and verify are required, as in af: radius feeds correctness and security, and verify
// has no placeholder through which a marker for radius could reach it, so a failed radius
// would vanish silently. A null result or a thrown agent() ends the run.
async function required(name, phaseTitle, model, vars, extra) {
  const out = await agent(render(PROMPTS[name], vars), options(name, phaseTitle, model, extra))
  if (out === null || out === undefined) {
    throw new Error(name + ' returned no output - the review cannot continue without it')
  }
  return out
}

phase('Brief')
const brief = text(
  await optional('brief', 'Brief', MODELS.brief, { material: MATERIAL, plan: PLAN, specSources: SPEC_SOURCES })
)

phase('Review')
const base = { material: MATERIAL, plan: PLAN, specSources: SPEC_SOURCES, brief: brief }

// correctness and security wait for radius only, never for falsifiability or delivery.
const [blast, falsifiabilityOut, deliveryOut] = await parallel([
  async () => {
    const radiusOut = await required('radius', 'Review', MODELS.radius, base)
    const withRadius = Object.assign({}, base, { radius: text(radiusOut) })
    const [correctnessOut, securityOut] = await parallel([
      () => worker('correctness', withRadius),
      () => worker('security', withRadius),
    ])
    return { radiusOut: radiusOut, correctnessOut: correctnessOut, securityOut: securityOut }
  },
  () => worker('falsifiability', base),
  () => (hasSpecs ? worker('delivery', base, { schema: SCHEMAS.delivery }) : Promise.resolve(NO_SPECS)),
])

phase('Verify')
const verify = await required(
  'verify',
  'Verify',
  MODELS.verify,
  Object.assign({}, base, {
    radius: text(blast.radiusOut),
    correctness: text(blast.correctnessOut),
    security: text(blast.securityOut),
    falsifiability: text(falsifiabilityOut),
    delivery: text(deliveryOut),
  }),
  { schema: SCHEMAS.verify }
)

// Synthesis is handed the verifier's output and nothing else, by construction.
phase('Synthesis')
const synthesis = await agent(
  render(PROMPTS.synthesis, { verify: text(verify) }),
  options('synthesis', 'Synthesis', MODELS.synthesis)
)
if (synthesis === null || synthesis === undefined) log('synthesis returned no output')

// The delivery worker's own output, for the caller to check against its schema. A failed
// worker leaves a marker string and a review with no spec sources leaves NO_SPECS: neither
// is delivery output, so neither is returned as such.
const result = { synthesis: synthesis, verify: verify }
if (hasSpecs && deliveryOut !== null && typeof deliveryOut === 'object') result.delivery = deliveryOut
return result
`;

export function buildWorkflow(loaded: LoadedPipeline = codeReview()): string {
  const { prompts, models, schemas } = reviewEngineTables(loaded);
  return (
    HEADER +
    META +
    "\nconst PROMPTS = " +
    JSON.stringify(prompts, null, 2) +
    "\n\nconst MODELS = " +
    JSON.stringify(models, null, 2) +
    "\n\nconst SCHEMAS = " +
    JSON.stringify(schemas, null, 2) +
    "\n" +
    BODY
  );
}

/** Writes the generated script and schema files; src/af-plugin/generate.ts is the entry. */
export async function writeGenerated(): Promise<void> {
  writeFileSync(WORKFLOW_PATH, buildWorkflow());
  process.stdout.write(`wrote ${WORKFLOW_PATH}\n`);
  for (const [path, text] of Object.entries(await buildSchemaFiles())) {
    writeFileSync(path, text);
    process.stdout.write(`wrote ${path}\n`);
  }
}
