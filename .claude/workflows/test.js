export const meta = {
  name: 'test',
  description: 'Run the project test suite and emit a pass/fail result',
  phases: [
  ],
}

const models = (args && args.models) || {}

// check 'run': run `pnpm test`

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