// NOTICE: per-step permissions declared in the pipeline canon (permissions.contents)
// are NOT enforced by Binding A. The Claude Code workflow agent() API does not
// accept a permission-restriction option. Every step in this workflow runs with
// the host Claude Code session's access level. Use Binding B (Mastra) for
// per-step permission enforcement.

export const meta = {
  name: 'code-review',
  description: 'Adversarial review of a code change, with every finding verified against the repo',
  phases: [
    { title: 'Correctness' },
    { title: 'Verify' },
    { title: 'Synthesis' },
  ],
}

const plan = args && typeof args.plan === 'string' ? args.plan.trim() : ''
if (!plan) {
  throw new Error('args.plan is required and must be non-empty — refusing to run without it')
}
const baseline = args && typeof args.baseline === 'string' ? args.baseline.trim() : ''
if (!baseline) {
  throw new Error('args.baseline is required and must be non-empty — refusing to run without it')
}
const introducedCommits = args && typeof args.introducedCommits === 'string' ? args.introducedCommits.trim() : ''
if (!introducedCommits) {
  throw new Error('args.introducedCommits is required and must be non-empty — refusing to run without it')
}
const models = (args && args.models) || {}
const mCorrectness = models['correctness'] || 'claude-sonnet-5'
const mSecurity = models['security'] || 'claude-sonnet-5'
const mVerify = models['verify'] || 'claude-opus-5'
const mSynthesis = models['synthesis'] || 'claude-opus-5'

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
const CODE_REVIEW_FINDING = {
  "type": "object",
  "properties": {
    "claim": {
      "type": "string"
    },
    "file": {
      "type": "string"
    },
    "line": {
      "type": [
        "string",
        "number"
      ]
    },
    "quote": {
      "type": "string"
    },
    "verdict": {
      "type": "string",
      "enum": [
        "CONFIRMED",
        "PARTIAL",
        "DECLINED"
      ]
    },
    "citationAccurate": {
      "type": "boolean"
    },
    "scope": {
      "type": "string",
      "enum": [
        "introduced",
        "pre-existing",
        "undetermined"
      ]
    },
    "kind": {
      "type": "string",
      "enum": [
        "defect",
        "business-decision",
        "external-confirmation"
      ]
    },
    "severity": {
      "type": "string",
      "enum": [
        "blocking",
        "major",
        "minor"
      ]
    },
    "probes": {
      "type": "object",
      "properties": {
        "guard": {
          "type": "string"
        },
        "reachability": {
          "type": "string"
        },
        "remedy": {
          "type": "string"
        },
        "callers": {
          "type": "string"
        },
        "scope": {
          "type": "string"
        }
      },
      "required": [
        "guard",
        "reachability",
        "remedy",
        "callers",
        "scope"
      ],
      "additionalProperties": false
    },
    "correctedWording": {
      "type": "string"
    }
  },
  "required": [
    "claim",
    "file",
    "line",
    "quote",
    "verdict",
    "citationAccurate",
    "scope",
    "kind",
    "severity",
    "probes",
    "correctedWording"
  ],
  "additionalProperties": false
}
const CODE_REVIEW_SCHEMA = {
  type: 'object',
  properties: { codeReviewFindings: { type: 'array', items: CODE_REVIEW_FINDING } },
  required: ['codeReviewFindings'],
  additionalProperties: false,
}

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


phase('Verify')
log('Running verify steps…')

const r_verify = await agent(
  `<instructions>
You are the verifier. Take each finding ONE AT A TIME and find why it is WRONG; assume it false until the repository forces you to concede.

Two judgements, never one: \`verdict\` judges whether the DEFECT is real, \`citationAccurate\` whether the citation supported it. A wrong citation NEVER lowers \`verdict\` — a real defect cited badly is \`CONFIRMED\` with \`citationAccurate: false\`. Collapsing them is how this step fails.

\`verdict\` takes three values. \`CONFIRMED\`: the defect is real as claimed. \`PARTIAL\`: the defect is real in a narrower form than claimed — some paths, some inputs, or a guard covers part of the cases; put the narrowed claim in \`correctedWording\`. PARTIAL needs positive evidence of narrowing, never absence of evidence. \`DECLINED\`: the claim is false — the guard exists, the code is unreachable, or the cited behaviour does not occur.
</instructions>

<context>
Open every cited path and quote the lines. If they do not support the finding, set \`citationAccurate: false\` with corrected \`file\`, \`line\`, \`quote\`.

Answer these five probes per finding. Any probe that turns on finding nothing concludes from absence, but an empty search never proves absence: your tools see only this workspace; a denied path returns "no matches", not an error — absent and invisible look identical. When a probe turns on finding nothing, name the search, report it empty, and mark that probe \`unverified\`; never DECLINE on an empty search, and no probe that turned up nothing may lower a verdict: a defect that reads real from the diff alone is \`CONFIRMED\` with those probes marked \`unverified\`.

- **Guard** — does a validator, constraint, type or parent rule already close this? Check parent and caller, not just the named file.
- **Reachability** — name the entry point, permitted inputs, and any clamp on it.
- **Remedy** — if the finding claims no remedy exists, find one and check it excludes this case.
- **Callers** — does every symbol the finding leans on have a production caller? One used only by tests is not load-bearing.
- **Scope** — you cannot run git: an added line is \`introduced\`, unchanged context \`pre-existing\`; quote the hunk header. \`${introducedCommits}\`, if non-empty, adds commit attribution; if empty, say so. Report \`undetermined\` ONLY if the diff omits the line.

Vagueness is failure: "may be an issue" is unfalsifiable; be specific enough to be provably wrong. Rank corrections by falsifiability: a wrong line number is cosmetic beside a false sentence guarding a real finding. A \`business-decision\` needs a named owner and one answerable question; an \`external-confirmation\` a named document or party. Classify once with \`kind\`; \`verdict: CONFIRMED\` when the question is real — \`kind\` keeps it out of the blocking count, not the verdict.
</context>

<input>
Change:
${plan}

Baseline: ${baseline} — commits: ${introducedCommits}

Correctness:
${r_correctness}

Security:
${r_security}
</input>

<output_format>
One entry per finding; none vanishes. Each carries: \`claim\`; corrected \`file\`, \`line\`, verbatim \`quote\`; \`verdict\`; \`citationAccurate\`; \`scope\`; \`kind\`; \`severity\`; \`probes\` (all five); \`correctedWording\` — always: the restatement when wording is wrong, empty when it stands.
</output_format>
`,
  { label: 'verify', phase: 'Verify', model: mVerify, schema: CODE_REVIEW_SCHEMA },
)

phase('Synthesis')
log('Running synthesis steps…')

const r_synthesis = await agent(
  `<instructions>
You are a senior reviewer turning a verified finding list into one prioritised, deduplicated report a developer can act on. You are given the verifier's verdicts and nothing else: you cannot re-judge a claim you cannot see, and that is deliberate.
</instructions>

<context>
Verified findings:

${r_verify}
</context>

<input>
Each entry carries a verdict, \`citationAccurate\`, a quote of the cited source, a scope, a kind and corrected wording. Treat them as settled.
</input>

<output_format>
Return a single prioritised list of findings:

1. Account for every verdict. Each entry ends in exactly one of three places: the prioritised list, the Questions for owners section, or the dropped list with the reason it was dropped. Nothing may vanish silently: you are the only place a real defect can be lost, and a defect lost here is never fixed.
2. Deduplicate: if two entries flag the same root issue, merge them into one and note both sources. Merging two reports of the same defect is not dropping; merging two DIFFERENT defects because they touch the same file is.
3. Retention is the default. Drop an entry only when the verifier DECLINED it, giving the verifier's quoted evidence as the reason, never your own judgement. If you are unsure whether an entry is real, keep it: a reader can dismiss a retained finding, but cannot recover one you deleted.
4. Whatever the verdict, use the verifier's corrected location and corrected wording whenever they are non-empty — never reprint the reviewer's original citation or claim. \`citationAccurate: false\` means correct the citation, not demote the finding.
5. Order by falsifiability, not severity: what one grep can disprove comes first.
6. For each retained finding, state:
   - **Title** — a short label.
   - **Severity** — blocking, major, or minor.
   - **Location** — file, line, and the verifier's quote.
   - **Scope** — introduced, pre-existing, or undetermined.
   - **Summary** — one to three sentences: the problem, the evidence, and what must change.

Then a "Dropped" section, each with the verifier's quoted evidence.

Then a separate "Questions for owners" section holding every business-decision and external-confirmation entry, each as one question with a named owner, excluded from the blocking count whatever its verdict.

End with a verdict line: "Change is ready to merge" if there are no blocking findings, or "Change has N blocking finding(s) — resolve before merge" if there are.
</output_format>
`,
  { label: 'synthesis', phase: 'Synthesis', model: mSynthesis },
)


return {
  synthesis: r_synthesis,
  summary: {
    pipeline: 'code-review',
    steps: ['correctness', 'security', 'verify', 'synthesis'],
    finalStep: 'synthesis',
  },
}