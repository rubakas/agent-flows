# 030. Code review as a verified pipeline

| Field        | Value                                                              |
| ------------ | ------------------------------------------------------------------ |
| Feature Name | Code review                                                        |
| Branch       | `030-code-review`                                                  |
| Status       | Implemented — amended 2026-09-13 (eval fixes, spec 031 dependency) |
| Created      | 2026-09-13                                                         |

## Context

This spec responds to `docs/verified-code-review-brief.md`, a two-day, human-in-the-loop review of a
large financial-application PR (Rails, ~500 changed files, five review rounds). The final round was
measured precisely: 4 findings reviewed, 4/4 real defects, nothing withdrawn — but ~15 supporting
details were wrong, and every one of the four findings contained at least one assertion the author
could have falsified with a single grep. Discovery is not the bottleneck; citation accuracy is.
Corrections must be ranked by "can the author disprove this in one grep?", not by severity — a wrong
line number is cosmetic, a false load-bearing sentence guarding a real finding is the expensive
failure, because the finding dies with it.

The existing `audit` pipeline (`pipelines/audit.yaml`) has no step that checks a finding against the
artifact after the agent that authored it. Its `synthesis` step reconciles two text blobs blind
(no `permissions:` block, no repo access); its worker prompts do carry a guard check, but it is put to
the agent that wants to report the finding — self-certification, the wrong party for the question.

**Domain: what code review is here, distinct from `audit`.**

- `audit` checks whether an _intent_ is internally coherent. Code review checks whether a _claim about
  an artifact_ is true of that artifact. Different question, different inputs, different verification
  method — not two intensities of one job. That is why they stay separate pipelines; `audit` is not
  modified by this spec.
- Unit of work: one changeset (a diff) measured against a prior state. Not a plan, not a standalone
  snippet.
- Input artifact: the diff, plus a baseline ref establishing what existed before.
- Output contract per finding: `file`, `line`, a verbatim quote of the actual cited source, a `verdict`
  (`CONFIRMED` | `PARTIAL` | `DECLINED`) reached by an agent _other_ than the one that raised it, a
  `scope` (`introduced` | `pre-existing`) reported as a fact, and a `kind`
  (`defect` | `business-decision` | `external-confirmation`).
- What makes it review, not discovery: every finding is checked against something that exists
  independently of the claiming agent — an openable file, a quotable line — by a different agent
  empowered to disprove it. `audit`'s guard check is self-certification: the same agent that wants to
  report the finding is asked whether a guard already closes it.
- Explicitly not code review: anything no amount of repo-reading settles — a business-owner policy
  call, a contract clause. One owner, one question, in a permanently separate non-blocking section,
  classified once and exited. Never adjudicated, re-scored, or recirculated.

## Functional Requirements

| ID     | Requirement                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FR-001 | **`pipelines/code-review.yaml` defines four `llm` steps, no fewer, no more, in this dependency graph.** `correctness` (`worker`, `contents: read`, `prompts/audit-correctness.md`, reused unchanged) and `security` (`worker`, `contents: read`, `prompts/audit-security.md`, reused unchanged) run at the first level with no `dependsOn`. `verify` (`reasoner`, `contents: read`, `dependsOn: [correctness, security]`, `prompts/code-review-verify.md`, new) runs at the second level. `synthesis` (`reasoner`, `contents: read`, `dependsOn: [verify]`, `prompts/code-review-synthesis.md`, new) runs at the third level. Step kinds are restricted to the closed set `llm \| gate \| assemble-spec \| persist-ticket \| export-spec \| pipeline \| loop \| check` (`src/canon/types.ts:16-24`); all four steps here are `kind: llm`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| FR-002 | **`synthesis` declares `contents: read`, where `audit`'s synthesis declares none.** This lets `synthesis` open a file itself to adjudicate a cross-dimension duplicate finding, rather than reconciling two text blobs blind. Post-D1, `contents: read` grants the step tools `Read,Glob,Grep` (`runStep.ts:744-749`) and resolves a validated workspace directory used as `cwd` (`runStep.ts:699-712`, `:842`); Bash is never granted at any level (`types.ts:63`: "Bash/shell is never granted"), which is what FR-005 rests on. FR-002's point is unchanged by D1: `synthesis` declares `contents: read` where `audit`'s synthesis declares none.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| FR-003 | **`verify` takes each finding from `correctness` and `security` and tries to disprove it, not merely check it over.** It receives `{{plan}}`, `{{baseline}}`, `{{introducedCommits}}`, `{{correctness}}`, `{{security}}` and runs five explicit probes per finding — **Guard** (does a validator, constraint, type, schema, or parent-level rule already close this — checked at the parent and the caller, not only the named file), **Reachability** (name the entry point and whether anything server-side clamps the value first), **Remedy** (if the finding claims none exists, search for one and check whether it actually excludes this case), **Callers** (does every symbol the finding leans on have a production caller, not only a test), **Scope** (introduced vs. pre-existing, reported as a fact — see FR-005 for how, since no step here has shell access). It emits per finding: `verdict` (`CONFIRMED` \| `PARTIAL` \| `DECLINED`), corrected citation, quoted source, the five probe answers, and — for `PARTIAL` — exactly which sub-claim failed and the accurate wording. A finding may be `CONFIRMED` as a defect while its supporting details are `DECLINED`; these are separate judgements and must stay separate in the output.                                                                                                                                                                                          |
| FR-004 | **`synthesis` preserves `audit-synthesis.md`'s anti-loss rules verbatim** (nothing vanishes silently; synthesis is the only place a real defect can be lost; retention is the default), and adds: `DECLINED` findings go to the dropped list carrying the verifier's quoted evidence, never synthesis's own judgement; `PARTIAL` findings are promoted using the verifier's corrected wording, never the worker's original; `business-decision` and `external-confirmation` items are emitted in a separate section, each as one question with a named owner, excluded from the blocking count; the remaining corrections are ordered by falsifiability, not severity.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| FR-005 | **Scope is determined from the diff text, not from git, because no `llm` step can run a shell command.** A line present as an addition in `{{plan}}` is `introduced`; a line appearing as unchanged context is `pre-existing`; `verify` quotes the hunk header as evidence for its claim. `introducedCommits` is an optional input carrying a precomputed commit list for commit-level attribution when a caller can supply it; when it is empty, `verify` reports scope as determined-from-diff and never guesses.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| FR-006 | **`code-review.yaml` declares `inputs: [plan, baseline, introducedCommits]` and `optionalInputs: [baseline, introducedCommits]`.** `optionalInputs` produces `z.string().optional().default("")` for these two (`types.ts:182-188`, `build.ts:172-176`), but only because `code-review` is run top-level in this phase. That mechanism does not rescue an unmapped input on a nested `kind: pipeline` mount (`nest.ts:20-28` performs a load-time textual placeholder rewrite from the parent's `with:`, and an input the parent does not map is a hard load error, `load.ts:108-119`) — a future nested mount of `code-review` must map every one of these three inputs explicitly or the pipeline fails to load.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| FR-007 | **`prompts/code-review-verify.md` and `prompts/code-review-synthesis.md` follow house prompt style**: the 4-tag skeleton `<instructions>`, `<context>`, `<input>`, `<output_format>` in that order, target 30-36 lines and under 400 words (matching the 8 existing tagged prompts' 24-36 line, 203-403 word range).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| FR-008 | **`synthesis` receives `{{verify}}` and nothing else.** It is not given `{{correctness}}` or `{{security}}`. This is structural enforcement of FR-004, not an economy: synthesis is required to take `DECLINED` verdicts on the verifier's quoted evidence, never on synthesis's own judgement, and withholding the raw worker findings makes that rule impossible to violate rather than merely forbidden — synthesis cannot re-judge a finding it cannot see. The anti-loss guarantee is correspondingly relocated along the chain: `verify` must account for every finding it was given, and `synthesis` must account for every verdict `verify` emitted.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| FR-009 | **`prompts/code-review-verify.md` defines all three verdicts, closing the gap that let an unguarded case fall to PARTIAL by default.** CONFIRMED: the defect is real as claimed. DECLINED: not real, or fully closed by an existing guard. PARTIAL: the defect is real in a narrower form than the claim — some paths, some inputs, or a guard covering part of the cases — with the narrowed claim recorded in `correctedWording`. PARTIAL requires positive evidence of narrowing, never absence of evidence: unverified probes never lower a verdict, and a defect that reads real from the diff alone is CONFIRMED, with any probe that could not run marked `unverified`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| FR-010 | **The eval fixture's finding list splits into two graded sets, `expectations` and `conditional`.** `expectations`: findings that must be raised; verdict and kind graded, 100% threshold unchanged. `conditional`: four-state, keyed on two patterns — `want` (what a correct adjudication looks like) and optional `forbid` (the adjudication that fails). Over every finding a key claims: `misrouted` if any hit matches `forbid` (must be 0), else `routed` if at least one hit matches `want`, else `inconclusive` (raised, but the key swept only neighbouring findings — reported, never gating), else `notRaised` (unraised; reported INCONCLUSIVE, never scored as a pass). A decoy is `want: { verdict: "DECLINED" }, forbid: { verdict: "CONFIRMED", kind: "defect" }` — only a rubber stamp fails it, never a neighbour's PARTIAL; the business-decision item moves here with `want: { kind: "business-decision" }` and no `forbid`, since no worker prompt can originate it and it reaches the verifier only through reclassification of a raised item. Keyword matching for both sets is scoped to `claim + file + quote + correctedWording`, never `probes` — a JSON-path guarantee only, since prose output has no fields and the prose parser matches the whole block; every key requires two or more keywords, enforced by an anti-rot test. A key claims every finding it matches; a bait raised by two workers is still one bait. |
| FR-011 | **`src/evals/run.ts` persists every step's raw output to a run directory and prints its path.** Verify JSON, correctness and security prose, and synthesis output are each written to `<AGENT_FLOWS_EVAL_OUT or os.tmpdir()>/agent-flows-evals/<fixture>/<ISO timestamp>/<step>.(json\|md)`, printed on the report's first line. Nothing is written inside the repo by default.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

## Design

**A. Four fixed steps, not per-finding fan-out.** The step graph mirrors `audit`'s shape
(two parallel workers, one reconciler) plus one verification layer, because the brief's own numbers
(4 findings, 4/4 real, ~15 wrong details) show the defect is in citation accuracy, not in discovery
breadth or in verification throughput. A fixed four-step graph is the cheapest structure that lets one
independent agent (`verify`) check every finding raised by the other two before `synthesis` sees them.

**B. Rejected alternatives.**

- (a) _Split `verify` by dimension_ into `verify-correctness` / `verify-security` — rejected: it
  introduces kebab-case step ids against house style (step ids are always single lowercase words),
  duplicates a ~35-line contract across two prompt files, and lets two verifiers reach contradictory
  verdicts on one finding that spans both dimensions, forcing `synthesis` to adjudicate verdicts — the
  exact collapse the brief names as the most common failure mode. It also costs a fifth model call for
  a context problem not evidenced at 4 findings per round.
- (b) _Probe-parallel split_, one step per probe type (Guard, Reachability, Remedy, Callers, Scope) —
  rejected: it does not reduce the real cost driver, which is opening the cited files, and it fragments
  the per-finding judgement across steps that each see only one probe's answer.
- (c) _Scout-role triage before `verify`_ — rejected: an unverified cheap-tier model would decide what
  the verifier never sees, which is a second self-certification layer stacked upstream of the one this
  spec is fixing.
- (d) _More discovery dimensions_ — rejected by the brief directly: discovery scored 4/4; a third or
  fourth axis would find nothing new and add reports nobody verifies.

**C. Scale: this pipeline does not scale by fan-out.** Fan-out width is fixed at authoring time and
cannot depend on the number of findings a round produces; `loop` is retry-shaped
(`maxIterations`, `until`, `load.ts:172-189`), not an iterator, and there is no `map`/`forEach` step
kind to run one verifier per finding in parallel. The measured trigger for building that kind (Phase 3,
see Follow-ups) is: findings per round routinely exceed roughly 10, or `verify`'s output degrades
detectably as finding count grows — not before either signal is observed.

## Corrections to the source brief

The brief asked to be verified rather than trusted (its own closing line). These corrections were
found against the current tree:

1. **§3.2's Scope probe, `git merge-base --is-ancestor`, is inexecutable.** No `llm` step is granted
   Bash (`runStep.ts:744-752`, `types.ts:63`: "Bash/shell is never granted"). FR-005 resolves scope
   from the diff text instead, with `introducedCommits` as an optional escape hatch for a caller that
   precomputes it outside this pipeline.
2. **§3.4's `with: { plan: <the diff>, baseline: <merge-base ref> }` is inexpressible.** `with:` on a
   `kind: pipeline` step is `Record<string,string>` of reference names, resolved by a load-time textual
   placeholder rewrite (`types.ts:150`, `nest.ts:20-28`) — it cannot carry inline content such as a diff
   literal or a ref literal; both must already be bound to a name the parent pipeline can reference.
3. **§3.4's claim that "one existing line changes" is false.** Adding an input to `code-review` forces
   the same addition onto `build.yaml`, `cycle.yaml`, and `cycle-dev.yaml`, because `optionalInputs`
   does not rescue an unmapped input on a nested mount (`build.ts:172-176` vs. `nest.ts:20-28`) — see
   FR-006. This is a multi-file change, not a one-liner, whenever `code-review` is mounted rather than
   run top-level.
4. **§3.6's finding schema is not Phase 2 work.** `schema:` is a closed union,
   `"weaknesses" | "securityFindings"` (`types.ts:34`), validated against `canonSchemas` at load time
   (`load.ts:309-310`, throws `unknown schema`) and forbidden on non-`llm` kinds (`load.ts:44`). A
   richer schema for code-review findings requires extending `canonSchemas` in `src/canon/schemas.ts`
   — a canon change, tracked as D2 below, not a same-phase addition.
5. **§2's claim that "synthesis cannot open a cited file" is imprecise.** A step with no
   `permissions:` block still receives `Read,Glob` via the `toolSet || "Read,Glob"` default
   (`runStep.ts:779`); what it actually lacks is Grep and a pinned `cwd`, because only
   `contents: read|write` resolves a validated workspace directory (`runStep.ts:699-712`, `:842`)
   and only a declared grant adds Grep. The brief's remedy —
   declare `contents: read` on `synthesis` — is still the correct fix (FR-002), just for the precise
   reason that it pins the working directory, not because tools were entirely absent.
6. **The brief did not anticipate that `contents: read` granted no content search.** Guard and Callers
   are definitionally repo-wide searches ("check the parent and the caller, not only the file the
   finding names"; "does every symbol have a production caller"). Under the pre-D1 grant of
   `Read,Glob`, `verify` was structurally unable to run its two highest-value probes and would have
   emitted confident answers for them regardless — worse than not asking. This was resolved by D1 in
   this same change: `contents: read` now grants `Read,Glob,Grep`, with credential deny entries
   extended to `Grep(...)` so the new tool opens no path around the `Read` denials. See the Decisions
   section, D1.
7. **An expectation is collectable only if some producer can emit it.** Audit's worker prompts omit
   non-defects by instruction (`prompts/audit-correctness.md:29`), so a business-decision item reaches
   `verify` only as a misclassified defect, never as itself. Grading it unconditionally reds the eval
   for reasons unrelated to verification quality — see FR-010's `conditional` set.
8. **A three-value enum with two defined values is an underdetermined instruction.** `PARTIAL` was
   live in the schema (`src/canon/schemas.ts:33`) but the string never occurred in
   `prompts/code-review-verify.md`; with no rule selecting it, an unguarded case fell into it by
   default instead of the correct `CONFIRMED`. See FR-009.

9. **A fixture must make its planted defect unambiguous — a verifier that narrows an over-claimed
   consequence is right, not wrong; hunk headers must match the body or the verifier will doubt the
   listing; bait keys sweep neighbouring findings, so a bait fails only on a rubber stamp
   (CONFIRMED defect), never on a neighbour's PARTIAL.**

## Decisions for the owner

D1 and D2 were accepted by the owner on 2026-09-13 and are implemented on this branch. D3 remains
deferred.

- **D1 — accepted and implemented.** `contents: read` now grants `Read,Glob,Grep`; `contents: write`
  grants `Read,Glob,Grep,Edit,Write` (`src/canon/runStep.ts`). The no-permissions fallback deliberately
  remains `Read,Glob` — a step that declares nothing keeps the minimum grant, and that asymmetry is
  now meaningful. **Security consequence handled in the same change:** granting Grep opened a path to
  searching inside credential files for content that `Read` denials already blocked, so credential deny
  entries are now emitted for `Grep(...)` alongside `Read(...)` (and `Edit(...)` in the workspace
  branch). A new test loops `CREDENTIAL_DENY_PATTERNS` asserting a `Grep(pat)` deny entry exists, and
  was proven falsifiable by reverting the deny list and watching it go red. **Verified live, not
  assumed:** a probe on 2026-09-13 against claude CLI 2.1.270 established that `Grep(<glob>)` is a rule
  name the CLI's file-permission checks recognise (the CLI warns out loud on names they do not match —
  it does so for `Write(pattern)` and stays silent for `Grep(pattern)`) and that the rule is actually
  enforced (a denied file yielded matches in the control arm and none in the test arm). Recorded as F7
  and F8 in `docs/research/2026-09-06-workflow-security-prompt-injection.md` §5. D1's security
  consequence is therefore verified, not inferred.
- **Noted characteristic of the deny mechanism (F8).** The CLI silently filters denied paths out of
  results rather than refusing: the agent sees "no matches", not "blocked", and the denied file also
  disappears from `Glob` output. A denied file is indistinguishable from an absent one to the step. No
  prompt in this pipeline may ask a step to conclude anything from an empty search — "not found" cannot
  be read as "does not exist". This silent-filtering behaviour is specific to `Grep` and `Glob` — the
  `Read` tool does emit an explicit "denied by your permission settings" message, so the
  denied-vs-absent ambiguity applies to searching and listing, not to opening a known path.
- **D2 — accepted and implemented.** `codeReviewFindings` added to the `schema:` union
  (`src/canon/types.ts`) and registered in `canonSchemas` (`src/canon/schemas.ts`). The `verify` step
  carries `schema: codeReviewFindings`. Fields: `claim`, `file`, `line`, `quote`, `verdict`,
  `citationAccurate`, `scope`, `kind`, `severity`, `probes` (`guard`, `reachability`, `remedy`,
  `callers`, `scope`), `correctedWording`. In `src/bindings/claudeCode.ts` the schema-name→constant
  mapping was changed from a two-way ternary to an exhaustive `Record`, so a future union member
  becomes a typecheck error rather than a silently-wrong emitted constant.
- **D3 — still deferred, unchanged.** `build.yaml` wiring, including the live `plan: plan` defect at
  `pipelines/build.yaml:30-35` (post-build `review` currently re-audits the spec instead of the code,
  because it mounts `audit` with `plan: plan` rather than the diff). Recommendation: wire it once
  `code-review` is proven on a real change, as its own spec — the wiring touches `build.yaml`. `audit`
  has exactly two direct mounts: `pipelines/build.yaml:30-35` (`review`, `with: {plan: plan}`) and
  `pipelines/spec-creation.yaml:39-44` (`verify`, `with: {plan: assemble}`). `cycle.yaml` and
  `cycle-dev.yaml` contain no `pipeline: audit` step at all; they reach both mounts transitively by
  mounting `build` and `spec-creation`.

## Out of scope

- No edits to `pipelines/audit.yaml` or the three `audit-*.md` prompts; they must stay byte-identical,
  verified with `git diff`, not recollection.
- No edits to `build.yaml`, `cycle.yaml`, or `cycle-dev.yaml` this phase (D3).
- No new discovery dimensions beyond `correctness` and `security` — discovery scored 4/4 in the field
  evidence.
- No raised iteration counts — the field rounds were spent correcting citations, not finding more bugs.
- No write access for any new step — verification is read-only.
- Brief §3.5 (forking `audit-correctness.md`/`audit-security.md` into code-specific variants) and §3.7
  (gating `build.yaml`'s `converge` on re-verification rather than on `test.passed`) are deferred.

## Verification

Items 1-6 are implemented and checkable now. Item 7 is partly proven: the pipeline has been run live
(see First live run below), but the three seeded-bad-citation cases it names remain formally unproven
end to end — see its entry below.

1. **[Implemented] Pipeline loads with the correct graph.** Load `pipelines/code-review.yaml`. Assert
   it defines exactly 4 steps and produces dependency levels `[[correctness, security], [verify],
[synthesis]]`.
2. **[Implemented] All four steps declare `contents: read`.** Assert `permissions.contents === "read"`
   on `correctness`, `security`, `verify`, and `synthesis`.
3. **[Implemented] The new prompts' placeholder sets resolve with no load error.**
   `prompts/code-review-verify.md` references only `{{plan}}`, `{{baseline}}`, `{{introducedCommits}}`,
   `{{correctness}}`, `{{security}}`; `prompts/code-review-synthesis.md` references exactly
   `{{verify}}` (FR-008). An unknown placeholder is a hard throw at load time (`load.ts:431-434`) and
   at render time (`render.ts:18`) — the pipeline must load without either firing.
4. **[Implemented] An offline scorer asserts verdict classification.** `reviewVerdicts`
   (`src/evals/scorers.ts:420-459`) grades per-finding verdicts and the blocking count with no model
   call — the same discipline as `auditDefectsFound` (`src/evals/scorers.ts:187-217`), pure matching
   over the parsed output. It is asserted offline in `src/evals/scorers.test.ts` and was proven
   falsifiable by mutation: forcing every parsed finding's verdict to `CONFIRMED` turned 9 tests red
   (JSON path, prose path, both blocking-count exclusions and the code-fence case); restoring the
   parsers turned all of them green, 0 failures.
5. **[Implemented] `git diff --exit-code` is empty for `pipelines/audit.yaml` and the three
   `audit-*.md` prompts.**
6. **[Implemented] `pnpm check` is green** (lint + typecheck + format:check + test).
7. **[Unproven] Acceptance criteria 1-3 of the source brief are behavioural** — a finding whose cited `file:line`
   does not support it comes out `DECLINED` with the real lines quoted; a finding closed by a
   parent-level validation comes out `DECLINED` naming the guard; a finding claiming no remedy exists
   where one does comes out `PARTIAL` with the remedy named. These can only be proven by a live model
   run via `tsx src/evals/run.ts <fixture>` (`run.ts:171-189`), which is not part of `pnpm test`
   (`scripts/test.sh` globs only `src/**/*.test.ts`). **The coverage split is structural, not a
   shortcut.** `src/evals/fixtures/code-review-citations.ts` does NOT cover all five acceptance
   criteria and cannot: criteria 1, 2 and 5 require the verifier to adjudicate a claim the reviewer got
   WRONG, and nothing seeds such a claim — `verify`'s only upstream inputs are the `correctness` and
   `security` outputs, which no fixture input controls, and a competent reviewer will not invent a
   false claim on demand. The fixture covers exactly what the pipeline can emit end to end: one
   `CONFIRMED` defect adjudicated on the merits, and one `business-decision` excluded from the blocking
   count (criterion 4). Criteria 1, 2 and 5 are covered offline instead, by `reviewVerdicts` unit tests
   in `src/evals/scorers.test.ts` against synthetic `verify` output — the right place for them, since
   they grade the treatment of a wrong claim and need no model at all. The live run below demonstrated
   verdict quality on real findings; it did not exercise the seeded-bad-citation cases, so criteria 1-3
   remain formally unproven end to end.

### First live run

Run on 2026-09-13 against this change's own diff (1,911 lines), with `baseline` = `81ba774`,
`introducedCommits` empty, and `cwd` pinned to this repo. 4 model calls.

- **5 verdicts**: 1 blocking defect, 2 `PARTIAL` with corrected wording, 1 minor, and 1 routed to
  "Questions for owners" as an `external-confirmation` and correctly excluded from the blocking count
  (FR-004).
- The pipeline found a real blocking defect **in its own change** — the `src/evals/run.ts:247` bug that
  read a schema-gated step's output as a string, so every live code-review eval exited 1 before any
  verdict was scored. A code review and a security audit had both missed it.
- It marked a finding `CONFIRMED` with `citationAccurate: false` and supplied the corrected citation —
  the behaviour acceptance criterion 5 requires, observed in a live run.
- Item 7's behavioural criteria 1-3 remain formally unproven. The run demonstrated verdict quality on
  real findings; it did not present the verifier with the seeded bad citations those criteria grade.

## Follow-ups

- Provider portability of `contents: read` for this pipeline is specified in spec 031.
- D3 — wire `build.yaml`'s `review` step at `code-review` with a real diff and baseline, once this
  pipeline is proven on a real change.
- Brief §3.5 — fork `audit-correctness.md`/`audit-security.md` into code-specific variants requiring a
  verbatim quote per finding and a required `guards I checked and why they do not close this` field.
- Brief §3.7 — gate `build.yaml`'s `converge` on re-verification of the findings a round was opened to
  fix, not on `test.passed` alone.
- Phase 3 canon change — a `map`/`forEach` step kind for per-finding parallel verification, gated on
  the measured trigger in Design item C (findings per round routinely exceed ~10, or `verify` output
  degrades detectably as finding count grows).
- **Closed — the credential deny list's gaps.** `CREDENTIAL_DENY_PATTERNS` (`src/canon/runStep.ts`)
  grew from 34 to 92 entries and now covers, beyond the original env/secrets/key-extension set: SSH and
  GnuPG key material by location (`**/.ssh/**`, `**/.gnupg/**`) and PuTTY/OpenPGP forms (`*.ppk`,
  `*.gpg`, `*.asc`, `*.pgp`); the certificate and keystore formats that were missing (`*.der`, `*.crt`,
  `*.cer`, `*.p8`); tool auth files (`.npmrc`, `.netrc`, `_netrc`, `.pgpass`, `.htpasswd`, `htpasswd`);
  cloud and cluster credentials (`**/.aws/**`, `**/.azure/**`, `**/.config/gcloud/**`,
  `application_default_credentials.json`, `**/.kube/config`, `kubeconfig`); further env, credential and
  token filename variants including `.envrc`; the terraform variable files that conventionally carry
  secrets (`secrets.tfvars`, `*.auto.tfvars`); and case-varied duplicates for APFS, following the
  `.Agent-flows` precedent in `BUILD_CONFIG_DENY_PATTERNS`. No keyword wildcards were added — the
  constant's own comment rejects them because `*token*` would also deny `tokenizer.ts`. A coverage test
  in `src/canon/runStep.test.ts` asserts a representative path per form is matched, and a
  must-stay-readable list (`tokenizer.ts`, `.env.example`) keeps the assertions meaningful; both were
  proven falsifiable by deleting one pattern and watching the suite go red.
- **Recorded characteristic — `--restricted` drops the operator's own deny rules.** Verified live on
  2026-09-13 against claude CLI 2.1.270 and recorded as F9 in
  `docs/research/2026-09-06-workflow-security-prompt-injection.md` §6: a `permissions.deny` rule in a
  settings file blocks a plain `claude -p` read, and the same read succeeds under the flags agent-flows
  passes. `--restricted` is all-or-nothing about settings files, so it discards the operator's denials
  along with the repo's grants. Consequence: inside an agent-flows step `CREDENTIAL_DENY_PATTERNS` is
  the sole control, not a supplement to `~/.claude/settings.json`, which is why the gaps above had to be
  closed rather than assumed covered by the operator's own configuration.
- **Open, unverified — `permissions.allow` cancels credential denials outright, with no authorization
  gate.** In `src/canon/runStep.ts` the deny computation filters `CREDENTIAL_DENY_PATTERNS` through
  `allowPatterns` via `allowEntryRemoves`, so one `allow` entry removes the `Read`, `Grep` and `Edit`
  denials for the matched pattern together. Load-time validation in `src/canon/load.ts` only checks
  that each allow entry matches something in the deny list — a typo guard, not an authorization gate.
  A pipeline author writing `permissions: {contents: read, allow: ["*.pem"]}` re-opens every matching
  file. No pipeline in `pipelines/` uses `allow` today, so this is latent, not live. Consider requiring
  something stronger than a YAML line for allow entries that match credential patterns, while
  continuing to accept them for build-config patterns.
- **Open, unverified — `pipelines/**` is absent from `BUILD_CONFIG_DENY_PATTERNS`**
  (`src/canon/runStep.ts`). That list covers `**/package.json`, `**/Makefile`,
  `**/.github/workflows/**`, `**/.git/**`, `**/.husky/**`, `**/*.config.*` and `**/.agent-flows/**`,
  and its comments reason explicitly about a step editing its own run configuration mid-run. The same
  reasoning was never extended to the pipeline definitions themselves: a `contents: write` step can
  author or edit a pipeline that grants itself an `allow` entry, and a later run of that pipeline reads
  the secret. Combines with the `permissions.allow` follow-up above.
- **Open, unverified — `CREDENTIAL_DENY_PATTERNS` has no case-varied duplicates**, unlike
  `BUILD_CONFIG_DENY_PATTERNS`, which carries them deliberately for macOS case-insensitive
  filesystems. On APFS a file named `.ENV` may therefore evade a case-sensitive matcher while still
  being readable on disk. Grep inherits the same gap.
- **Closed, not open: `Grep(<glob>)` deny rules are valid and enforced.** Probed live on 2026-09-13
  against claude CLI 2.1.270; recorded as F7/F8 in
  `docs/research/2026-09-06-workflow-security-prompt-injection.md` §5 and folded into D1.
- **Scope attribution when `introducedCommits` is empty** — consider requiring `undetermined` rather
  than `pre-existing`, since diff-derived attribution is not independently checkable.
- **Pre-existing bug found while implementing D2, not fixed here.** In `src/bindings/claudeCode.ts`
  (Binding A), `schemaArg` is constructed only in the parallel branch (multiple `llm` steps sharing a
  DAG level). A schema-gated step that is alone in its dependency level emits no `schema` key at all,
  while its schema constant is still declared at the top of the generated script — an unused constant
  and no JSON gating. `code-review.yaml`'s `verify` step is alone in its level, so under Binding A the
  D2 schema silently does nothing. Binding B (Mastra), the complete executor, is unaffected.
