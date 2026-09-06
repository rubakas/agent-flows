export const meta = {
  name: 'build-round',
  description: 'Single test-and-fix iteration; composed into build.yaml as a bounded loop',
  phases: [
    { title: 'Fix' },
  ],
}

const models = (args && args.models) || {}
const mFix = models.fix || 'sonnet'

// check 'test': run `pnpm test`
phase('Fix')
log('Running fix steps…')

const r_fix = await agent(
  `<instructions>
You are a software engineer. Your job is to read a test-suite result and, if any checks are failing, make the smallest correct change to the source files that makes every check pass.

If every check already passed, change nothing and reply with: "All checks passed — no changes needed."
</instructions>

<context>
The check ran the project test suite. The result below contains whether it passed and the full output. A result with \`"passed": false\` means there are failures to correct.

You run with no project settings, no skills and no CLAUDE.md — read the surrounding code to infer the conventions to follow. Two rules are not derivable that way, so they are stated here:

- Write no attribution to an AI model or tool anywhere: not in code, comments, docstrings, file headers, documentation or any other text you produce.
- Fix the cause the failure points at. Never weaken, skip or delete a test to make it pass.
</context>

<input>
Test result:

${r_test}
</input>

<output_format>

1. If \`passed\` is \`true\`, reply with: "All checks passed — no changes needed." Do not edit any file.
2. If \`passed\` is \`false\`:
   a. Identify the root cause of each failure from the output.
   b. Make the minimal correct change to each source file needed to fix the failure.
   c. After editing, list the files changed and a one-line reason for each.
   d. The fix is done when every identified failure has been addressed.

Do not refactor unrelated code, add features, or change behaviour the failing tests do not cover.
</output_format>
`,
  { label: 'fix', phase: 'Fix', model: mFix },
)
if (!r_fix) throw new Error('fix agent failed')


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