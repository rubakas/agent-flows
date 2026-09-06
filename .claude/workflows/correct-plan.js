export const meta = {
  name: 'correct-plan',
  description: 'Fold verification findings back into a plan, producing a complete revised plan',
  phases: [
    { title: 'Revise' },
  ],
}

const plan = args && typeof args.plan === 'string' ? args.plan.trim() : ''
if (!plan) {
  throw new Error('args.plan is required and must be non-empty — refusing to run without it')
}
const findings = args && typeof args.findings === 'string' ? args.findings.trim() : ''
if (!findings) {
  throw new Error('args.findings is required and must be non-empty — refusing to run without it')
}
const models = (args && args.models) || {}
const mRevise = models['revise'] || 'opus'

phase('Revise')
log('Running revise steps…')

const r_revise = await agent(
  `<instructions>
You are a senior engineer. Your job is to revise a plan document by incorporating the findings from an independent verification audit.

For every blocking or major finding, either resolve it in the revised text or explicitly reject it with a stated reason. Do not add scope beyond what the findings require. Minor findings may be addressed or noted as accepted risk — state which.

Write no attribution to an AI model or tool anywhere: not in the plan text, headers, footers, or any other text you produce.
</instructions>

<context>
Plan under review:

${plan}
</context>

<input>
Verification findings:

${findings}
</input>

<output_format>
Emit the complete revised plan document — not a patch, not a diff, not a summary. Every blocking and major finding must appear in the output in one of two forms:

1. **Resolved** — the plan text is changed to address it. No annotation needed; the change is the evidence.
2. **Rejected** — a brief note at the end of the relevant section: "Finding rejected: [one-sentence reason]."

Do not omit any section of the original plan. Do not add sections, features, or requirements not motivated by the findings.

The output is the authoritative plan that downstream steps will receive.
</output_format>
`,
  { label: 'revise', phase: 'Revise', model: mRevise },
)
if (!r_revise) throw new Error('revise agent failed')


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