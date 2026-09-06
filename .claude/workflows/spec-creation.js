export const meta = {
  name: 'spec-creation',
  description: 'Harden a feature request into an adversarially reviewed spec',
  phases: [
    { title: 'Intake' },
    { title: 'Enrich' },
    { title: 'Critic' },
    { title: 'Verify.correctness' },
    { title: 'Verify.synthesis' },
    { title: 'Correct.revise' },
  ],
}

const request = args && typeof args.request === 'string' ? args.request.trim() : ''
if (!request) {
  throw new Error('args.request is required and must be non-empty — refusing to run without it')
}
const findings = args && typeof args.findings === 'string' ? args.findings.trim() : ''
if (!findings) {
  throw new Error('args.findings is required and must be non-empty — refusing to run without it')
}
const models = (args && args.models) || {}
const mIntake = models['intake'] || 'sonnet'
const mEnrich = models['enrich'] || 'sonnet'
const mCritic = models['critic'] || 'opus'
const mSecurity = models['security'] || 'opus'
const mVerifyCorrectness = models['verify.correctness'] || 'opus'
const mVerifySecurity = models['verify.security'] || 'opus'
const mVerifySynthesis = models['verify.synthesis'] || 'opus'
const mCorrectRevise = models['correct.revise'] || 'opus'

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

phase('Intake')
log('Running intake steps…')

const r_intake = await agent(
  `You are a product analyst. Produce a concise software spec draft in markdown for the feature request below. Structure it EXACTLY as: one '# <Title>' heading line (a short feature title, not a sentence), one short description paragraph, a '## Requirements' section with 3-7 '- ' bullets, a '## Acceptance Criteria' section with 3-7 '- ' bullets. Return ONLY the markdown document — no commentary, no code fences.

If a codebase survey is provided, scope every requirement to what the code actually contains. Do NOT invent interfaces, roles, subsystems, or user-facing surfaces the survey did not report. If no survey is provided, derive scope from the request alone.

Feature request: ${request}

Codebase survey: ${findings}
`,
  { label: 'intake', phase: 'Intake', model: mIntake },
)
if (!r_intake) throw new Error('intake agent failed')

phase('Enrich')
log('Running enrich steps…')

const r_enrich = await agent(
  `Review the spec draft below. Return ONLY a markdown section that starts with the exact heading '## Enrichment additions', followed by '- ' bullets with ADDITIONAL edge cases, non-functional requirements, and clarifications that the draft is missing. Do NOT rewrite, repeat, or restructure the draft itself. No commentary, no code fences.

Draft:
${r_intake}
`,
  { label: 'enrich', phase: 'Enrich', model: mEnrich },
)

phase('Critic')
log('Running critic steps…')

const [criticRes, securityRes] = await parallel([
  () =>
    agent(
      `You are a ruthless, adversarial spec critic. Your job is to find every weakness in the spec below BEFORE development starts: ambiguities, untestable statements, contradictions, missing edge cases, unstated assumptions, scope gaps, unimplementable requirements. Judge the FULL spec (draft + enrichment additions). Mark a weakness blocking=true only if development should not start until it is resolved. Be concrete and specific to THIS spec — no generic advice.

Spec:
${r_intake}

${r_enrich}
`,
      { label: 'critic', phase: 'Critic', model: mCritic, schema: WEAK_SCHEMA },
    ),
  () =>
    agent(
      `You are a security reviewer performing a pre-development security check of the spec below. Identify security-relevant gaps, risks, and missing security requirements: authn/authz, injection surfaces, data exposure, abuse/DoS vectors, auditability, secrets handling. Judge the FULL spec (draft + enrichment additions). Mark blocking=true only for findings that must be resolved before development. Be concrete and specific to THIS spec.

Spec:
${r_intake}

${r_enrich}
`,
      { label: 'security', phase: 'Critic', model: mSecurity, schema: SEC_SCHEMA },
    ),
])

const weaknesses = (criticRes && criticRes.weaknesses) || []
const securityFindings = (securityRes && securityRes.securityFindings) || []

const _assembleInput = {
  'intake': r_intake,
  'enrich': r_enrich,
  'critic': criticRes,
  'security': securityRes,
  'verify.correctness': r_verify_correctness,
  'verify.security': r_verify_security,
  'verify.synthesis': r_verify_synthesis,
  'correct.revise': r_correct_revise,
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

phase('Verify.correctness')
log('Running verify.correctness steps…')

const [verify_correctnessRes, verify_securityRes] = await parallel([
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

${r_assemble}
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
      { label: 'verify.correctness', phase: 'Verify.correctness', model: mVerifyCorrectness },
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

${r_assemble}
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
      { label: 'verify.security', phase: 'Verify.correctness', model: mVerifySecurity },
    ),
])


phase('Verify.synthesis')
log('Running verify.synthesis steps…')

const r_verify_synthesis = await agent(
  `<instructions>
You are a senior reviewer synthesising two independent audits of the same plan. Your job is to merge the findings into a single, prioritised, deduplicated list that a developer can act on.
</instructions>

<context>
Correctness audit:

${r_verify_correctness}

Security audit:

${r_verify_security}
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
  { label: 'verify.synthesis', phase: 'Verify.synthesis', model: mVerifySynthesis },
)

phase('Correct.revise')
log('Running correct.revise steps…')

const r_correct_revise = await agent(
  `<instructions>
You are a senior engineer. Your job is to revise a plan document by incorporating the findings from an independent verification audit.

For every blocking or major finding, either resolve it in the revised text or explicitly reject it with a stated reason. Do not add scope beyond what the findings require. Minor findings may be addressed or noted as accepted risk — state which.

Write no attribution to an AI model or tool anywhere: not in the plan text, headers, footers, or any other text you produce.
</instructions>

<context>
Plan under review:

${r_assemble}
</context>

<input>
Verification findings:

${r_verify_synthesis}
</input>

<output_format>
Emit the complete revised plan document — not a patch, not a diff, not a summary. Every blocking and major finding must appear in the output in one of two forms:

1. **Resolved** — the plan text is changed to address it. No annotation needed; the change is the evidence.
2. **Rejected** — a brief note at the end of the relevant section: "Finding rejected: [one-sentence reason]."

Do not omit any section of the original plan. Do not add sections, features, or requirements not motivated by the findings.

The output is the authoritative plan that downstream steps will receive.
</output_format>
`,
  { label: 'correct.revise', phase: 'Correct.revise', model: mCorrectRevise },
)

// gate 'approve': handled in chat by the orchestrating session
// persist: pipe result.spec into 'pnpm persist'
// export-spec 'export': write spec.md to 'specs/spec-creation'

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