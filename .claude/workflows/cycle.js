export const meta = {
  name: 'cycle',
  description: 'Full development lifecycle — investigate, plan, build, and ship',
  phases: [
    { title: 'Investigate.survey' },
    { title: 'Investigate.findings' },
    { title: 'Plan.intake' },
    { title: 'Plan.enrich' },
    { title: 'Plan.critic' },
    { title: 'Build.develop.implement' },
  ],
}

const request = args && typeof args.request === 'string' ? args.request.trim() : ''
if (!request) {
  throw new Error('args.request is required and must be non-empty — refusing to run without it')
}
const models = (args && args.models) || {}
const mInvestigate.survey = models.investigate.survey || 'haiku'
const mInvestigate.findings = models.investigate.findings || 'opus'
const mPlan.intake = models.plan.intake || 'sonnet'
const mPlan.enrich = models.plan.enrich || 'sonnet'
const mPlan.critic = models.plan.critic || 'opus'
const mPlan.security = models.plan.security || 'opus'
const mBuild.develop.implement = models.build.develop.implement || 'sonnet'

const FINDING = {
  "type": "object",
  "properties": {
    "text": {
      "type": "string"
    },
    "severity": {
      "type": "string",
      "enum": [
        "low",
        "medium",
        "high",
        "critical"
      ]
    },
    "blocking": {
      "type": "boolean"
    }
  },
  "required": [
    "text",
    "severity",
    "blocking"
  ],
  "additionalProperties": false
}
const WEAK_SCHEMA = {
  type: 'object',
  properties: { weaknesses: { type: 'array', items: FINDING } },
  required: ['weaknesses'],
  additionalProperties: false,
}
const SEC_SCHEMA = {
  type: 'object',
  properties: { securityFindings: { type: 'array', items: FINDING } },
  required: ['securityFindings'],
  additionalProperties: false,
}

phase('Investigate.survey')
log('Running investigate.survey steps…')

const r_investigate.survey = await agent(
  `<instructions>
You are a codebase scout. Your sole job is to locate, open, and report on the parts of the repository that are relevant to a given request. You do not plan or recommend — you map what exists.
</instructions>

<context>
You have read access to the repository. Every file path you mention must be one you actually opened during this task. Do not infer or guess paths; cite only what you read.
</context>

<input>
Request: ${request}
</input>

<output_format>
Return a survey report with three sections:

1. **Files and modules relevant to the request** — list each file path you opened, with one sentence explaining what it does and why it is relevant. Only include files you actually read.

2. **Existing overlap** — describe what the codebase already implements that overlaps with the request. Quote or paraphrase the exact lines or structures you found, with file paths and line numbers where useful.

3. **Gaps and unknowns** — list what the request touches that you could not find in the codebase: missing files, undefined interfaces, undocumented behaviour. Be specific about what is absent.

A complete survey covers every module the request plausibly touches and names at least one concrete file per relevant area. If a search turns up nothing, say so explicitly rather than omitting the area.
</output_format>
`,
  { label: 'investigate.survey', phase: 'Investigate.survey', model: mInvestigate.survey },
)
if (!r_investigate.survey) throw new Error('investigate.survey agent failed')

phase('Investigate.findings')
log('Running investigate.findings steps…')

const r_investigate.findings = await agent(
  `<instructions>
You are a technical analyst. Given a codebase survey, produce a concise findings brief that a developer or lead can act on before any code is written.
</instructions>

<context>
Survey results from the repository scout:

{{investigate.survey}}
</context>

<input>
The original request that prompted the survey is implicit in the survey above. Use it only to frame relevance — do not re-derive it independently.
</input>

<output_format>
Return a findings brief with four sections:

1. **What already exists** — summarise the relevant code the survey found. Be specific: name files, types, and behaviours. Avoid restating the survey verbatim; synthesise it.

2. **What is missing or under-specified** — list concrete gaps between the request and the current codebase. For each gap, state what is absent and why it matters for implementation.

3. **Contradictions** — list any places where the request conflicts with what the codebase already does or enforces. Include type mismatches, naming collisions, invariant violations, and architectural mismatches.

4. **Open questions for the human** — list only questions that a developer cannot resolve by reading the code: ambiguous scope, conflicting priorities, undocumented external constraints. Number them. Omit questions the survey already answered.

A findings brief is done when a developer reading it can write an implementation plan without revisiting the survey.
</output_format>
`,
  { label: 'investigate.findings', phase: 'Investigate.findings', model: mInvestigate.findings },
)

phase('Plan.intake')
log('Running plan.intake steps…')

const r_plan.intake = await agent(
  `You are a product analyst. Produce a concise software spec draft in markdown for the feature request below. Structure it EXACTLY as: one '# <Title>' heading line (a short feature title, not a sentence), one short description paragraph, a '## Requirements' section with 3-7 '- ' bullets, a '## Acceptance Criteria' section with 3-7 '- ' bullets. Return ONLY the markdown document — no commentary, no code fences.

Feature request: ${request}
`,
  { label: 'plan.intake', phase: 'Plan.intake', model: mPlan.intake },
)

phase('Plan.enrich')
log('Running plan.enrich steps…')

const r_plan.enrich = await agent(
  `Review the spec draft below. Return ONLY a markdown section that starts with the exact heading '## Enrichment additions', followed by '- ' bullets with ADDITIONAL edge cases, non-functional requirements, and clarifications that the draft is missing. Do NOT rewrite, repeat, or restructure the draft itself. No commentary, no code fences.

Draft:
{{plan.intake}}
`,
  { label: 'plan.enrich', phase: 'Plan.enrich', model: mPlan.enrich },
)

phase('Plan.critic')
log('Running plan.critic steps…')

const [plan.criticRes, plan.securityRes] = await parallel([
  () =>
    agent(
      `You are a ruthless, adversarial spec critic. Your job is to find every weakness in the spec below BEFORE development starts: ambiguities, untestable statements, contradictions, missing edge cases, unstated assumptions, scope gaps, unimplementable requirements. Judge the FULL spec (draft + enrichment additions). Mark a weakness blocking=true only if development should not start until it is resolved. Be concrete and specific to THIS spec — no generic advice.

Spec:
{{plan.intake}}

{{plan.enrich}}
`,
      { label: 'plan.critic', phase: 'Plan.critic', model: mPlan.critic, schema: WEAK_SCHEMA },
    ),
  () =>
    agent(
      `You are a security reviewer performing a pre-development security check of the spec below. Identify security-relevant gaps, risks, and missing security requirements: authn/authz, injection surfaces, data exposure, abuse/DoS vectors, auditability, secrets handling. Judge the FULL spec (draft + enrichment additions). Mark blocking=true only for findings that must be resolved before development. Be concrete and specific to THIS spec.

Spec:
{{plan.intake}}

{{plan.enrich}}
`,
      { label: 'plan.security', phase: 'Plan.critic', model: mPlan.security, schema: SEC_SCHEMA },
    ),
])

const weaknesses = (plan.criticRes && plan.criticRes.weaknesses) || []
const securityFindings = (plan.securityRes && plan.securityRes.securityFindings) || []

const _assembleInput = {
  investigate.survey: r_investigate.survey,
  investigate.findings: r_investigate.findings,
  plan.intake: r_plan.intake,
  plan.enrich: r_plan.enrich,
  plan.critic: plan.criticRes,
  plan.security: plan.securityRes,
  build.develop.implement: r_build.develop.implement,
}
const spec = (function(input) {
  const { intake, enrich, critic, security } = input;
  function sectionBullets(md, heading) {
    const re = new RegExp('^##\\s+' + heading + '\\s*$', 'i');
    const out = [];
    let inSection = false;
    for (const line of md.split('\n')) {
      if (re.test(line.trim())) { inSection = true; continue; }
      if (inSection && /^#{1,6}\s/.test(line.trim())) break;
      if (inSection) {
        const m = line.match(/^\s*(?:[-*]|\d+\.)\s+(.+)$/);
        if (m) out.push(m[1].trim());
      }
    }
    return out;
  }
  const lines = intake.split('\n');
  let title = '';
  for (const line of lines) {
    const m = line.match(/^#{1,2}\s+(.+)$/);
    if (m) { title = m[1].trim(); break; }
  }
  if (!title) title = (lines.find(function(l) { return l.trim(); }) || 'Untitled').trim().slice(0, 120);
  const requirements = sectionBullets(intake, 'Requirements');
  const acceptanceCriteria = sectionBullets(intake, 'Acceptance Criteria');
  const description = intake + '\n\n' + enrich;
  const weaknesses = (critic && critic.weaknesses) || [];
  const securityFindings = (security && security.securityFindings) || [];
  return { title, description, requirements, acceptanceCriteria, weaknesses, securityFindings };
})(_assembleInput)

const blocking = [...spec.weaknesses, ...spec.securityFindings].filter(f => f.blocking).length
log(`Assembled: ${spec.requirements.length} requirements, ${spec.acceptanceCriteria.length} AC, ${spec.weaknesses.length} weaknesses, ${spec.securityFindings.length} security findings (${blocking} blocking)`)

// gate 'plan.approve': handled in chat by the orchestrating session
// persist: pipe result.spec into 'pnpm persist'
// export-spec 'plan.export': write spec.md to 'specs/spec-creation'
phase('Build.develop.implement')
log('Running build.develop.implement steps…')

const r_build.develop.implement = await agent(
  `<instructions>
You are a software engineer executing an approved implementation plan. Your job is to make the plan real: edit the files it specifies, in the order it specifies, and verify the result compiles and passes the project's conventions.
</instructions>

<context>
The plan below has been reviewed and approved. It is the authoritative specification for this task. Do not extend scope, add unasked-for abstractions, or refactor code the plan does not mention.
</context>

<input>
Approved plan:

{{plan.assemble}}
</input>

<output_format>
Execute the plan item by item:

1. Work through each item in dependency order: complete items that others depend on before their dependents.
2. For each file you edit or create, make only the changes the plan specifies.
3. Add tests as directed by the plan. If the plan does not specify a test location or style, match the project's existing test conventions.
4. After completing all edits, report what you did:
   - A list of files changed, with a one-line description of each change.
   - Any plan item you could not execute, with the specific reason (missing file, type conflict, ambiguous instruction), so a human can correct the plan.

The implementation is done when every item in the plan is either executed or explicitly reported as blocked.
</output_format>
`,
  { label: 'build.develop.implement', phase: 'Build.develop.implement', model: mBuild.develop.implement },
)

// loop 'build.converge': body pipeline 'undefined', cap 3 iterations — Binding A does not implement the loop
// gate 'ship.approve': handled in chat by the orchestrating session
// check 'ship.commit': run `git add -A && git commit -m "feat: apply approved plan"`
// check 'ship.pr': run `gh pr create --fill`

return {
  spec,
  summary: {
    title: spec.title,
    requirements: spec.requirements.length,
    acceptanceCriteria: spec.acceptanceCriteria.length,
    weaknesses: spec.weaknesses.length,
    securityFindings: spec.securityFindings.length,
    blocking,
  },
}