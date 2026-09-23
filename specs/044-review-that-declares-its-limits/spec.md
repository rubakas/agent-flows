# 044. A review that declares its limits

| Field        | Value                                                                                                                |
| ------------ | -------------------------------------------------------------------------------------------------------------------- |
| Feature Name | Review that declares its limits                                                                                      |
| Branch       | `main`                                                                                                               |
| Status       | In progress 2026-09-22 — schema, prompt and validation changes under construction; material and delivery steps built |
| Created      | 2026-09-22                                                                                                           |

## Context

One real `code-review` run (id `403e87a4-d85d-4d6b-aecd-25a7c88e7b87`) reviewed 13 commits / 36 files
(+427/-111) in a Rails repo through the pipeline's 6 LLM steps
(`radius → falsifiability → correctness/security → verify → synthesis`, `pipelines/code-review.yaml:17-77`),
took 16m01s, spent 27,636,349 units (26,171,608 of them cache reads), and closed with:

> Change is ready to merge — zero blocking findings

An external brief written against that run's transcript found the verdict wrong in three ways the
pipeline had no way to catch:

- Two of the 13 commits closed their tickets without doing what the ticket asked.
- One "question for owners" carried a verifier rationale that admitted it could not settle the claim
  either way — the defining condition of `UNVERIFIABLE` (`prompts/code-review-verify.md:6`) — yet it
  was routed to a human instead. Two ordinary `git` commands refute the underlying claim.
- A remedy was recommended across three call sites. One of those sites stores a fee, not
  price × shares; applying the remedy there would silently change what the stored quantity means.

**Three claims in that brief were checked against HEAD and do not hold.** They are recorded here so
the correction is not re-litigated:

- _The run page lists only settled runs._ False. `RunService.list()` maps every registry entry
  regardless of status (`src/runtime/runService.ts:798-815`) and `GET /api/runs` applies no filter on
  top of it (`src/serve/server.ts:1982-1988`). `RunService` is constructed with one `runsDir`
  (`src/runtime/runService.ts:396`), so the real defect behind the brief's observation is that
  `/api/runs` serves one project's runs directory, not run status — a run-page scoping question, out
  of scope here (see below).
- _Per-step usage is uninstrumented._ Overstated. `UsagePayload`
  (`src/canon/stepLogEvents.ts:71-79`) carries `costUsd`, `turns`, `durationMs` and
  `usage.{inputTokens,outputTokens}`, emitted by all three adapters (`src/canon/runClaudeCli.ts:345`,
  `src/canon/adapters/codex.ts:184`, `src/canon/adapters/api.ts:79`) into the durable step event log.
  It is simply never aggregated onto the run record — `SettledResult`
  (`src/runtime/runService.ts:129-135`) and the summaries `RunService.list()` builds
  (`src/runtime/runService.ts:798-807`) carry no usage field at all.
- _Review steps should get git tools to answer provenance questions._ Impossible by design, not an
  oversight — see D2.

## Decisions

**D1 — A new axis is a schema slot, not a sentence in a prompt.** Spec 040 measured two prompt-only
fixes on this same pipeline and both failed to move retained-baseline-findings — the metric that
matters (`specs/040-code-review-execution/spec.md:189-197`): "Prose guidance moved a quantitative
behaviour … but moved neither structural behaviour. … Where the wanted behaviour is structural, the
instrument has to be a contract." This spec follows that rule: `evidenceBasis`, `remedyScope` and
`sites` are added to `CODE_REVIEW_FINDING` (`schemas.ts:39-113`), ajv-rejected when a step omits them
(`validateOutput.ts:115-122`). Every axis this spec adds — the one closed in FR-004, and anything a
`material` or `delivery` step produces — follows the same rule.

**D2 — Review steps do not get git, ever.** `contents: read` maps to exactly `Read`, `Glob`, `Grep`
(`src/canon/adapters/claude.ts:64-78`), and `src/canon/types.ts:63` states plainly: "Bash/shell is
never granted — that is the separate concern of kind: \"check\"." Granting a review step shell access
to answer provenance questions would widen the grant model for every LLM step in the canon. Instead
git runs in runtime code and its OUTPUT becomes the step's input.

**D3 — The material step is a new deterministic step kind, not a `check` step.** Check commands are
deliberately not placeholder-rendered — `pipelines/ship.yaml:16-19` gives the reason in the codebase's
own words: "interpolating model output into a shell string is command injection" — and
`src/canon/load.ts:142-148` rejects every placeholder in a check command but `{{checkCommand}}`.
`baseline` is caller-supplied, so `git diff {{baseline}}...HEAD` as a shell string is precisely that
injection. The new kind runs git through `spawnSync("git", [args])` with no shell, the way
`src/runtime/gateMaterial.ts:28-48` and `src/canon/workspace/sanitize.ts:146` already do.

**D4 — Material is written to disk and bounded into context.** A real diff exceeds any sane prompt.
The step writes full artefacts to the run directory and puts bounded text plus the artefacts' absolute
paths into its ctx value; every review step already holds `contents: read` and can open the rest. The
cap mirrors `CHECK_OUTPUT_CAP = 65_536` (`src/canon/runStep.ts:159`). Unlike a `check` step's raw
stdout, the material step's output stays a single string value keyed to the step id, the same shape
every existing step already exposes as `{{stepId}}` — no dotted sub-field convention exists in any
current prompt (`render.ts:8` would parse one, but nothing uses it), so this spec does not introduce
one either.

**D5 — Unverifiable is a verdict, not a question for a human.** This spec adds `UNVERIFIABLE` to the
`verdict` enum (`schemas.ts:46`) and makes `evidenceBasis` a required field (`schemas.ts:48-58`):
`file-content | absence-of-file | commit-message | identifier-name | comment | none`.
`validateOutput.ts:89-95` refuses `CONFIRMED` on anything but the first two. A finding resting on a
commit message, an identifier name or a comment cannot pass as `CONFIRMED` — which is exactly the
failure mode the brief's owner-question exhibited. V1 locks this in with a regression fixture so it
cannot regress unnoticed.

**D6 — Delivery is its own dimension, and "silently decided" is its own outcome.** A new `delivery`
step and a new optional pipeline input `specSources` carrying the ticket bodies, following the
existing `inputs` / `optionalInputs` pattern (`pipelines/code-review.yaml:10-16`). Each requirement is
classified `implemented | partial | not-implemented | replaced-by-prose | silently-decided |
correctly-deferred`, **and that classification is a declared schema slot, not a sentence in the
prompt** — D1 applies to this axis exactly as it applies to `evidenceBasis`. `CODE_REVIEW_DELIVERY_SCHEMA`
(`schemas.ts`) declares one entry per requirement — `requirement`, `source`, `classification`,
`evidence`, `decisionTaken`, `optionsForeclosed`, all required, `additionalProperties: false` — plus a
top-level `specSourcesProvided` boolean, so a run given no ticket bodies is distinguishable from a run
that read them and found nothing; both produce an empty array and only the first means the dimension
never ran against anything. `decisionTaken` and `optionsForeclosed` are required on every entry because
a field a model may omit is a field it omits; an entry that took no decision carries the exact words
`not a decision` in both, and `crossFieldErrors` refuses that pair on a `silently-decided` entry — the
class this dimension exists for is meaningless without naming which decision was made silently. Left as
prose, `silently-decided` was mechanically indistinguishable from `implemented`: both were a sentence
inside a free-text claim, and the highest-value part of this dimension was decorative. `correctly-deferred`
exists so a ticket that said "needs a product decision" is reported as
correctly left alone rather than as a gap — the failure mode is the two commits in the reviewed run
that closed their tickets without doing what the ticket asked, and neither `correctness` nor `security`
nor `falsifiability` is positioned to check a commit against its own ticket.

**D7 — A remedy is validated per site or it is not validated.** This spec adds `remedyScope`
(`single-site | all-sites-verified | sites-differ`) and `sites[]` (`file`, `line`, `remedySafe`,
`remedyNote`) to the schema (`schemas.ts:59-76`), and enforces the relationship between them in
`crossFieldErrors` (`validateOutput.ts:78-107`), a post-validation pass that runs after ajv: today it
rejects `all-sites-verified` contradicted by any `remedySafe: false` site (`validateOutput.ts:96-104`).
FR-004 adds the direction that closes the gap: `sites.length > 1` combined with `remedyScope:
"single-site"` is rejected. Today that combination is only prompt-discouraged —
`prompts/code-review-verify.md:28` tells the model a multi-location finding "MUST populate `sites`" and
use `single-site` only for one location — but nothing mechanical stops a model from naming three sites
and marking the scope `single-site` anyway. That is precisely the reviewed run's fee-vs-price×shares
defect: a remedy proposed at three call sites with no per-site check.

The rule lives in `crossFieldErrors`, not as an ajv `if`/`then` in the schema, for the reason the
module's own comment states (`validateOutput.ts:72-76`): ajv can express the same dependency, but its
rejection on a failed `if`/`then` is the fixed string `must match "then" schema`, naming neither the
conflicting `remedyScope` value nor which site broke it. `validateCanonOutput`'s return value is
embedded verbatim into `retryNote`, "what the one retry tells the model" (`buildSteps.ts:196-222`) — an
opaque message gives the retry nothing to act on. `crossFieldErrors` composes its own message naming
the actual conflicting values instead.

**D8 — The verdict states its own coverage, and stays prompt-enforced — the weakest decision here.**
This spec adds a `Dropped` section, a `Questions for owners` section, a separate `Unverifiable` section
(never merged into either of the other two — "the gap is in the reviewer's reach and not in the owner's
intent"), a `Searched and not found` section per dimension, and a verdict line required to "name, by
name, both the axes that ran and the axes that did not" (`prompts/code-review-synthesis.md:30-38`). It
stays prompt-enforced rather than schema-enforced: synthesis emits free prose under no schema, so
nothing stops a coverage sentence from being wrong about what actually ran. A deterministic assertion is
deferred, not designed — say plainly that this is the weakest decision in this spec.

**D9 — The material step does not run the target repository's tests and does not create worktrees.**
Executing a mutation for real — the brief's R3 — is the only proposal that writes and executes inside
another repository, and spec 040 already scoped that as its own, separately-deferred Phase 2 work:
"Probe execution never lets a model author a shell command" and "Probes run in a git worktree with
dependencies linked in" (`specs/040-code-review-execution/spec.md:228-241`, Phase 2 D7-D8, deferred and
unapproved). This spec's `material` step stays read-only — diff, commit list, and the two named
git-history probes — and does not reopen that boundary.

## Functional Requirements

- **FR-001.** `StepKind` (`src/canon/types.ts:16-24`) gains `review-material` — named for what it
  captures rather than for the bare word `material`, which reads as a generic noun beside kinds like
  `check` and `gate`; the step id in `code-review.yaml` stays `material`, so prompts still read
  `{{material}}`. A `review-material` step runs
  `git diff {{baseline}}...HEAD`, the commit list between `baseline` and `HEAD`, the changed-file
  list, and two named git-history probes — `git log --all --diff-filter=A|D -- <paths>` and
  `git show --stat <sha>` — each via `spawnSync("git", [args])`, never a shell string (D2, D3).
- **FR-002.** `pipelines/code-review.yaml` gains a `material` step at dependency level -1, ahead of
  `radius` and `falsifiability`. It replaces the caller-supplied `introducedCommits` optional input
  (currently declared at `pipelines/code-review.yaml:13-16`, consumed at
  `prompts/code-review-verify.md:18,37`) with a pipeline-computed value; `baseline` stays the required
  input naming the ref.
- **FR-003.** `material`'s output is one ctx string keyed to the step id (D4): bounded text — cap
  mirrors `CHECK_OUTPUT_CAP = 65_536` (`runStep.ts:159`) — plus the absolute paths of the full
  artefacts written under the run directory, for any `contents: read` step to open the rest.
- **FR-004.** `crossFieldErrors` (`validateOutput.ts:78-107`) gains one rule: a finding whose `sites`
  array has more than one entry and whose `remedyScope` is `"single-site"` is rejected. This closes the
  gap named in D7 — today only `prompts/code-review-verify.md:28` asks for this, mechanically
  unchecked.
- **FR-005.** A new `delivery` step (`kind: llm`) and a new optional pipeline input `specSources`
  (ticket bodies), following the existing `optionalInputs` pattern (`pipelines/code-review.yaml:10-16`).
  Each requirement in `specSources` is classified `implemented | partial | not-implemented |
replaced-by-prose | silently-decided | correctly-deferred` (D6).
- **FR-005a.** The `delivery` step declares `schema: codeReviewDelivery`, registered in `canonSchemas`
  (`schemas.ts`) and enforced by `validateCanonOutput`. `crossFieldErrors` gains the rules that make the
  vocabulary cost something to write: `silently-decided` requires a non-empty `decisionTaken` and
  `optionsForeclosed` (neither answered with the `not a decision` convention); `implemented` and
  `partial` require `evidence` naming a file; `correctly-deferred` requires the deferring spec line
  quoted in `requirement`; and `specSourcesProvided: false` requires an empty entry array, so a report
  cannot invent requirements out of the diff. Each message names both conflicting values, for the reason
  D7 gives about ajv `if`/`then` (D1).
- **FR-006.** With `specSources` absent, `delivery` still runs and still completes the pipeline; its
  output states it had nothing to check against — `specSourcesProvided: false` with no entries — rather
  than omitting the section or failing the step.
- **FR-007.** The synthesis prompt keeps the `Unverifiable` section separate from the prioritised list
  and from `Questions for owners`, and requires the verdict line to state its own coverage
  (`prompts/code-review-synthesis.md:30-38`, D8). V2 is the regression fixture that keeps this from
  drifting once shipped.

## Verification

Fixture-based, not a live re-run — a live run against the real target repository cost ~27.6M units over
16m01s (see Context); that cost is not paid twice to verify a documentation and validation change.

- **V1.** A fixture `codeReviewFindings` entry with `verdict: CONFIRMED` and `evidenceBasis:
"commit-message"` is rejected by `validateCanonOutput("codeReviewFindings", …)` (D5) — the fixture is
  the regression guard that keeps this from drifting once shipped.
- **V2.** A fixture synthesis transcript with a finding merged into `Questions for owners` that the
  verifier marked `UNVERIFIABLE` fails a fixture assertion checking the two sections stay disjoint
  (D8, FR-007) — the same kind of regression guard.
- **V3.** A fixture finding with `sites: [siteA, siteB]` and `remedyScope: "single-site"` passes
  `crossFieldErrors` today (proven false per D7's own citation — the rule does not exist yet) and must
  be rejected once FR-004 ships. This is the fee-vs-price×shares defect from the reviewed run, reduced
  to a fixture.
- **V4.** The `delivery` step, invoked with `specSources` omitted, completes rather than throwing or
  suspending (FR-006), proven against a fixture pipeline invocation.
- **V4a.** A fixture `codeReviewDelivery` payload classified `silently-decided` with an empty
  `decisionTaken` is rejected, and the same payload with the decision named passes; a payload carrying
  entries while `specSourcesProvided` is `false` is rejected (FR-005a). The two undelivered tickets from
  the reviewed run are pinned as `replaced-by-prose` entries that validate, against the `implemented`
  shape the run actually emitted, which does not.
- **V5.** The `material` step's git invocation is proven to reach `spawnSync` argv, never
  `/bin/sh -c` — a `baseline` value containing a shell metacharacter (e.g. `$(rm -rf /)`) must not
  reach a shell, mirroring the precedent already proven this way at `sanitize.ts:146` and
  `gateMaterial.ts:28-33`.
- **V6.** Every gate this spec adds is proven able to fail by neutering the mechanism it guards, before
  it is trusted to pass — the same standard `specs/043-gate-summary/spec.md:138` records having met for
  its own V1-V3.

## Out of scope

- The brief's R3 — executing a mutation for real, inside a worktree of the target repository (D9).
- The brief's R6 — deterministic anchor/quote checking (verifying a cited line still says what a
  finding claims, mechanically rather than by model re-reading).
- The brief's R8/R9/R10 — usage aggregation onto the run record, `get_run`'s projection of it, and
  run-page status scoping/disclosure. Corrected as overstated in Context, but the underlying features
  stay out of scope here.
- The ADR-0019 renames.

## Risks

- **A required schema field is answerable with a plausible string.** `evidenceBasis`,
  `remedyScope` and the `delivery` classification each force a claim, but none can force the claim to
  be true — a model can write `file-content` without having opened the file, and `evidence` naming a
  file is checked for a path-shaped token, never for the path being real or the line saying what the
  entry claims. The schema catches omission, never fabrication.
- **The delivery entry has no slot for the reading it relied on.** `prompts/code-review-delivery.md`
  requires a requirement whose classification depends on an interpretation to say so, and to mark it
  `ungrounded` when nothing supports the reading. That now lives inside `evidence` as prose, which is
  the shape D1 says does not hold. A dedicated slot is the obvious next move and is not taken here.
- **A seventh LLM step raises per-run cost** on a pipeline already at 27,636,349 units per run
  (`material` is deterministic and does not count against this, but `delivery` is `kind: llm`, per
  FR-005).
- **`UNVERIFIABLE` is a place to put findings.** A model under time or context pressure can mark
  something `UNVERIFIABLE` to avoid the harder work of `CONFIRMED`/`DECLINED`, and nothing in this spec
  distinguishes a genuine reach limit from a convenient one.
