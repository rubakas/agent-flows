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