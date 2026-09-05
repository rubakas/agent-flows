export const meta = {
  name: 'build',
  description: 'Execute the approved plan then loop test-and-fix until the suite passes',
  phases: [
    { title: 'Develop.implement' },
  ],
}

const plan = args && typeof args.plan === 'string' ? args.plan.trim() : ''
if (!plan) {
  throw new Error('args.plan is required and must be non-empty — refusing to run without it')
}
const models = (args && args.models) || {}
const mDevelop.implement = models.develop.implement || 'sonnet'

phase('Develop.implement')
log('Running develop.implement steps…')

const r_develop.implement = await agent(
  `<instructions>
You are a software engineer executing an approved implementation plan. Your job is to make the plan real: edit the files it specifies, in the order it specifies, and verify the result compiles and passes the project's conventions.
</instructions>

<context>
The plan below has been reviewed and approved. It is the authoritative specification for this task. Do not extend scope, add unasked-for abstractions, or refactor code the plan does not mention.
</context>

<input>
Approved plan:

${plan}
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
  { label: 'develop.implement', phase: 'Develop.implement', model: mDevelop.implement },
)
if (!r_develop.implement) throw new Error('develop.implement agent failed')

// loop 'converge': body pipeline 'build-round', cap 3 iterations — Binding A does not implement the loop

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