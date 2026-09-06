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
    { title: 'Build.review.correctness' },
    { title: 'Build.review.synthesis' },
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
const mBuild.review.correctness = models.build.review.correctness || 'opus'
const mBuild.review.security = models.build.review.security || 'opus'
const mBuild.review.synthesis = models.build.review.synthesis || 'opus'

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
  build.review.correctness: r_build.review.correctness,
  build.review.security: r_build.review.security,
  build.review.synthesis: r_build.review.synthesis,
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

You run with no project settings, no skills and no CLAUDE.md — read the surrounding code to infer the conventions to follow. Two rules are not derivable that way, so they are stated here:

- Write no attribution to an AI model or tool anywhere: not in code, comments, docstrings, file headers, documentation or any other text you produce.
- Comment the reason for a decision, never the mechanics of code that already reads clearly.
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
phase('Build.review.correctness')
log('Running build.review.correctness steps…')

const [build.review.correctnessRes, build.review.securityRes] = await parallel([
  () =>
    agent(
      `<instructions>
You are an adversarial correctness reviewer. You are given the change under review — a plan, a diff, or source code — and read access to the repository it applies to. Your job is to find every place where it is wrong, incomplete, or inconsistent with the codebase.

When the input contains code, review it line by line. A concrete defect in the code in front of you outweighs any general observation about the design.
</instructions>

<context>
You have read access to the repository. Ground every finding in what you actually read: cite file paths and, where useful, line numbers or specific identifiers. Do not report issues you did not verify against the code.

Read what the code does and compare it against what its names, its callers and its surrounding contract promise. The gap between the two is where defects live. Give particular attention to the order in which alternatives are tried — which source wins when several supply a value, and whether that precedence is the one the caller would expect; to defaults and fallbacks that quietly substitute a value; to conditions that are inverted or negated; and to boundaries where a count, an index or an empty case changes behaviour.

Before reporting an issue, check whether something already prevents it — a validator, a type, a schema, an earlier guard — and say so. If an existing constraint makes the broken case unreachable, it is not a defect; leave it out. A reviewer told to find problems will usually report some even when the work is sound, and a false finding costs the reader as much as a missed one.
</context>

<input>
Plan under review:

{{plan.assemble}}
</input>

<output_format>
Return a list of correctness findings. For each finding:

- **Location** — the file path and, if applicable, the relevant plan section.
- **Issue** — what is wrong or missing, stated concisely.
- **Evidence** — what you read in the repository that supports the finding.
- **Severity** — one of: blocking (plan cannot proceed as written), major (will cause a defect), minor (worth fixing but not blocking).

Include only real defects: requirements gaps, logic errors, missing cases, type mismatches, broken invariants, or plan steps that contradict existing code. Do not include stylistic preferences, speculative improvements, or issues outside the plan's stated scope.

The review is done when every section of the plan has been checked against the relevant code.
</output_format>
`,
      { label: 'build.review.correctness', phase: 'Build.review.correctness', model: mBuild.review.correctness },
    ),
  () =>
    agent(
      `<instructions>
You are an adversarial security reviewer. You are given the change under review — a plan, a diff, or source code — and read access to the repository it applies to. Your job is to find every security-relevant risk it introduces or leaves open.

When the input contains code, review it line by line. A concrete defect in the code in front of you outweighs any general observation about the design.
</instructions>

<context>
You have read access to the repository. Ground every finding in what you actually read: cite file paths and specific identifiers. Do not report risks you cannot connect to concrete code or plan text.

Work by tracing data to where it lands. For every value the change handles that a user, a caller, a configuration file or a stored record can influence, follow it to the operation that consumes it, and state what constrains it on the way. Pay particular attention when such a value reaches an operation that interprets it rather than merely storing it — a shell or process invocation, a filesystem path, a query, a template, a deserialiser, or a dynamically evaluated expression. A value that reaches one of those without a constraint you can point to is a finding.

Before reporting a risk, check whether something already prevents it — a validator, a type, a schema, an earlier guard — and say so. If an existing constraint makes the dangerous case unreachable, it is not a finding; leave it out. Reporting a risk that cannot occur costs the reader as much as missing a real one.
</context>

<input>
Plan under review:

{{plan.assemble}}
</input>

<output_format>
Return a list of security findings. For each finding:

- **Location** — the file path or plan section where the risk originates.
- **Issue** — the security concern, stated concisely: authentication/authorisation gaps, injection surfaces, data exposure, abuse vectors, secrets handling, auditability.
- **Evidence** — what you read in the repository or plan text that supports the finding.
- **Severity** — one of: blocking (must be resolved before development), major (likely exploitable), minor (defence-in-depth improvement).

Include only findings grounded in the plan's scope and the existing codebase. Do not include generic security advice unrelated to what the plan proposes.

The review is done when every part of the plan that touches authentication, input handling, data storage, or external interfaces has been assessed.
</output_format>
`,
      { label: 'build.review.security', phase: 'Build.review.correctness', model: mBuild.review.security },
    ),
])


phase('Build.review.synthesis')
log('Running build.review.synthesis steps…')

const r_build.review.synthesis = await agent(
  `<instructions>
You are a senior reviewer synthesising two independent audits of the same plan. Your job is to merge the findings into a single, prioritised, deduplicated list that a developer can act on.
</instructions>

<context>
Correctness audit:

{{build.review.correctness}}

Security audit:

{{build.review.security}}
</context>

<input>
Both audits above cover the same plan. Treat them as peer reviews from separate disciplines.
</input>

<output_format>
Return a single prioritised list of findings:

1. Account for every finding. Each finding from either audit appears in your output exactly once — either in the prioritised list, or in the dropped list at the end with the reason it was dropped. Nothing may vanish silently: you are the only place a real defect can be lost, and a defect lost here is never fixed.
2. Deduplicate: if both audits flag the same root issue, merge them into one entry and note both sources. Merging two reports of the same defect is not dropping; merging two DIFFERENT defects because they touch the same file is.
3. Retention is the default. Drop a finding only when you can state why, and only for these reasons: it is a stylistic preference, it is speculative, it is outside the change's scope, or an existing validator, type, schema or earlier guard makes the broken case unreachable. Name that guard when you claim it. If you are unsure whether a finding is real, keep it — a reader can dismiss a retained finding, but cannot recover one you deleted.
4. Order by severity: blocking findings first, then major, then minor. Within each tier, correctness and security findings are interleaved by their potential impact.
5. For each retained finding, state:
   - **Title** — a short label.
   - **Severity** — blocking, major, or minor.
   - **Source** — correctness, security, or both.
   - **Summary** — one to three sentences: the problem, the evidence, and what must change.

Then a "Dropped" section listing every finding you excluded, each with the reason and, where the reason is an existing guard, the guard you found.

End with a verdict line: "Plan is ready to develop" if there are no blocking findings, or "Plan has N blocking finding(s) — resolve before development" if there are.
</output_format>
`,
  { label: 'build.review.synthesis', phase: 'Build.review.synthesis', model: mBuild.review.synthesis },
)

// gate 'ship.approve': handled in chat by the orchestrating session
// check 'ship.commit': run `git add -u && git commit -m "feat: apply approved plan"`
// check 'ship.pr': run `[ "$(git branch --show-current)" != "main" ] && gh pr create --fill`

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