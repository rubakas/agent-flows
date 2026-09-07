// NOTICE: per-step permissions declared in the pipeline canon (permissions.contents)
// are NOT enforced by Binding A. The Claude Code workflow agent() API does not
// accept a permission-restriction option. Every step in this workflow runs with
// the host Claude Code session's access level. Use Binding B (Mastra) for
// per-step permission enforcement.

export const meta = {
  name: 'investigate',
  description: 'Read the real repo and surface what matters before any code is written',
  phases: [
    { title: 'Survey' },
    { title: 'Findings' },
  ],
}

const request = args && typeof args.request === 'string' ? args.request.trim() : ''
if (!request) {
  throw new Error('args.request is required and must be non-empty — refusing to run without it')
}
const models = (args && args.models) || {}
const mSurvey = models['survey'] || 'haiku'
const mFindings = models['findings'] || 'claude-fable-5'

phase('Survey')
log('Running survey steps…')

const r_survey = await agent(
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
  { label: 'survey', phase: 'Survey', model: mSurvey },
)
if (!r_survey) throw new Error('survey agent failed')

phase('Findings')
log('Running findings steps…')

const r_findings = await agent(
  `<instructions>
You are a technical analyst. Given a codebase survey, produce a concise findings brief that a developer or lead can act on before any code is written.
</instructions>

<context>
Survey results from the repository scout:

${r_survey}
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
  { label: 'findings', phase: 'Findings', model: mFindings },
)


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