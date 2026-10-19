// Generates plugin/workflows/review-engine.js (spec 046 D2, D5).
//
// A Claude dynamic workflow cannot read files, so the eight step prompts and the two
// output schemas are embedded into the script. They are embedded with JSON.stringify
// — never spliced into a template literal — so no character in a prompt can break out
// of the string it lives in. The output is deterministic: a test compares the committed
// script with buildWorkflow(), so editing the generated file by hand fails the build.
//
//   pnpm plugin:generate

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const reference = join(root, "plugin", "skills", "review", "references");
export const WORKFLOW_PATH = join(root, "plugin", "workflows", "review-engine.js");

export const STEPS: string[] = [
  "brief",
  "radius",
  "falsifiability",
  "delivery",
  "correctness",
  "security",
  "verify",
  "synthesis",
];

/** Every placeholder the generated script knows how to fill. */
const KNOWN_PLACEHOLDERS = [
  "material",
  "plan",
  "specSources",
  "brief",
  "radius",
  "falsifiability",
  "delivery",
  "correctness",
  "security",
  "verify",
];

/** Structural isolation: the synthesis step may see the verifier's output and nothing else. */
const SYNTHESIS_PLACEHOLDERS = ["verify"];

function placeholdersIn(template: string): string[] {
  return [...new Set([...template.matchAll(/\{\{([\w.]+)\}\}/g)].map((match) => match[1]))];
}

function readPrompts(promptsDir: string): Record<string, string> {
  const prompts: Record<string, string> = {};
  for (const step of STEPS) {
    const template = readFileSync(join(promptsDir, `${step}.md`), "utf8");
    const unknown = placeholdersIn(template).filter((name) => !KNOWN_PLACEHOLDERS.includes(name));
    if (unknown.length > 0) {
      throw new Error(
        `prompt ${step}.md uses placeholder(s) the engine cannot fill: ${unknown.join(", ")}`
      );
    }
    prompts[step] = template;
  }
  const extra = placeholdersIn(prompts.synthesis).filter(
    (name) => !SYNTHESIS_PLACEHOLDERS.includes(name)
  );
  if (extra.length > 0) {
    throw new Error(
      `synthesis.md uses placeholder(s) beyond {{verify}}: ${extra.join(", ")} — synthesis must see only the verifier's output`
    );
  }
  return prompts;
}

function readSchemas(): { findings: unknown; delivery: unknown } {
  const read = (name: string): unknown =>
    JSON.parse(readFileSync(join(reference, "schemas", `${name}.json`), "utf8"));
  return { findings: read("findings"), delivery: read("delivery") };
}

const HEADER = `// GENERATED FILE - DO NOT EDIT.
// Source: plugin/skills/review/references/{prompts,schemas}/ and src/af-plugin/buildReviewEngine.ts
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

const worker = (name, vars, extra) => optional(name, 'Review', 'sonnet', vars, extra)

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
  await optional('brief', 'Brief', 'haiku', { material: MATERIAL, plan: PLAN, specSources: SPEC_SOURCES })
)

phase('Review')
const base = { material: MATERIAL, plan: PLAN, specSources: SPEC_SOURCES, brief: brief }

// correctness and security wait for radius only, never for falsifiability or delivery.
const [blast, falsifiabilityOut, deliveryOut] = await parallel([
  async () => {
    const radiusOut = await required('radius', 'Review', 'sonnet', base)
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
  'opus',
  Object.assign({}, base, {
    radius: text(blast.radiusOut),
    correctness: text(blast.correctnessOut),
    security: text(blast.securityOut),
    falsifiability: text(falsifiabilityOut),
    delivery: text(deliveryOut),
  }),
  { schema: SCHEMAS.findings }
)

// Synthesis is handed the verifier's output and nothing else, by construction.
phase('Synthesis')
const synthesis = await agent(
  render(PROMPTS.synthesis, { verify: text(verify) }),
  options('synthesis', 'Synthesis', 'opus')
)
if (synthesis === null || synthesis === undefined) log('synthesis returned no output')

return { synthesis: synthesis, verify: verify }
`;

/** @param promptsDir where the eight step prompts live (a test points it elsewhere) */
export function buildWorkflow(promptsDir = join(reference, "prompts")): string {
  const prompts = readPrompts(promptsDir);
  const schemas = readSchemas();
  return (
    HEADER +
    META +
    "\nconst PROMPTS = " +
    JSON.stringify(prompts, null, 2) +
    "\n\nconst SCHEMAS = " +
    JSON.stringify(schemas, null, 2) +
    "\n" +
    BODY
  );
}

/** Writes the generated script; src/af-plugin/generate.ts is the command-line entry. */
export function writeWorkflow(): void {
  writeFileSync(WORKFLOW_PATH, buildWorkflow());
  process.stdout.write(`wrote ${WORKFLOW_PATH}\n`);
}
