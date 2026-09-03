export const meta = {
  name: 'spec-creation',
  description: 'Harden a feature request into an adversarially reviewed spec',
  phases: [
    { title: 'Intake' },
    { title: 'Enrich' },
    { title: 'Critic' },
  ],
}

const request = args && typeof args.request === 'string' ? args.request.trim() : ''
if (!request) {
  throw new Error('args.request is required and must be non-empty — refusing to run without it')
}
const models = (args && args.models) || {}
const mIntake = models.intake || 'sonnet'
const mEnrich = models.enrich || 'sonnet'
const mCritic = models.critic || 'opus'
const mSecurity = models.security || 'opus'

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

Feature request: ${request}
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
  intake: r_intake,
  enrich: r_enrich,
  critic: criticRes,
  security: securityRes,
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

// gate 'approve': handled in chat by the orchestrating session
// persist: pipe result.spec into 'pnpm persist'

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