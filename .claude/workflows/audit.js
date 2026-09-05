export const meta = {
  name: 'audit',
  description: 'Adversarial read-only review of a plan; fans out to correctness and security then converges',
  phases: [
    { title: 'Correctness' },
    { title: 'Synthesis' },
  ],
}

const plan = args && typeof args.plan === 'string' ? args.plan.trim() : ''
if (!plan) {
  throw new Error('args.plan is required and must be non-empty — refusing to run without it')
}
const models = (args && args.models) || {}
const mCorrectness = models.correctness || 'opus'
const mSecurity = models.security || 'opus'
const mSynthesis = models.synthesis || 'opus'

phase('Correctness')
log('Running correctness steps…')

const [correctnessRes, securityRes] = await parallel([
  () =>
    agent(
      `<instructions>
You are an adversarial correctness reviewer. You are given a plan and read access to the repository it is meant to apply to. Your job is to find every place where the plan is wrong, incomplete, or inconsistent with the codebase — before any code is written.
</instructions>

<context>
You have read access to the repository. Ground every finding in what you actually read: cite file paths and, where useful, line numbers or specific identifiers. Do not report issues you did not verify against the code.
</context>

<input>
Plan under review:

${plan}
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
      { label: 'correctness', phase: 'Correctness', model: mCorrectness },
    ),
  () =>
    agent(
      `<instructions>
You are an adversarial security reviewer. You are given a plan and read access to the repository it is meant to apply to. Your job is to find every security-relevant gap or risk the plan introduces or leaves open — before any code is written.
</instructions>

<context>
You have read access to the repository. Ground every finding in what you actually read: cite file paths and specific identifiers. Do not report risks you cannot connect to concrete code or plan text.
</context>

<input>
Plan under review:

${plan}
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
      { label: 'security', phase: 'Correctness', model: mSecurity },
    ),
])


phase('Synthesis')
log('Running synthesis steps…')

const r_synthesis = await agent(
  `<instructions>
You are a senior reviewer synthesising two independent audits of the same plan. Your job is to merge the findings into a single, prioritised, deduplicated list that a developer can act on.
</instructions>

<context>
Correctness audit:

${r_correctness}

Security audit:

${r_security}
</context>

<input>
Both audits above cover the same plan. Treat them as peer reviews from separate disciplines.
</input>

<output_format>
Return a single prioritised list of findings:

1. Deduplicate: if both audits flag the same root issue, merge them into one entry and note both sources.
2. Drop anything that is not a real defect: stylistic preferences, speculative improvements, and issues explicitly outside the plan's scope are excluded.
3. Order by severity: blocking findings first, then major, then minor. Within each tier, correctness and security findings are interleaved by their potential impact.
4. For each retained finding, state:
   - **Title** — a short label.
   - **Severity** — blocking, major, or minor.
   - **Source** — correctness, security, or both.
   - **Summary** — one to three sentences: the problem, the evidence, and what must change.

End with a verdict line: "Plan is ready to develop" if there are no blocking findings, or "Plan has N blocking finding(s) — resolve before development" if there are.
</output_format>
`,
  { label: 'synthesis', phase: 'Synthesis', model: mSynthesis },
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