export const meta = {
  name: 'ship',
  description: 'Gate, commit, and open a pull request after human approval',
  phases: [
  ],
}

const plan = args && typeof args.plan === 'string' ? args.plan.trim() : ''
if (!plan) {
  throw new Error('args.plan is required and must be non-empty — refusing to run without it')
}
const models = (args && args.models) || {}

// gate 'approve': handled in chat by the orchestrating session
// check 'commit': run `git add -A && git commit -m "feat: apply approved plan"`
// check 'pr': run `gh pr create --fill`

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