# 040. Code review execution

| Field        | Value                                                                                                                                              |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Feature Name | Code review execution                                                                                                                              |
| Branch       | `feat/040-code-review-execution` (not yet created)                                                                                                 |
| Status       | Phase 1 approved, in progress — amended 2026-09-20 (second benchmark run; prompt prose replaced by structure). Phase 2 designed, **not approved**. |
| Created      | 2026-09-20                                                                                                                                         |

## Context

`code-review` (spec 030) is precise but blind to anything outside the diff and to anything execution
would settle. This spec raises what one real pull request review can catch, without losing the
precision the pipeline already has. It has two phases: Phase 1 (approved, implementing now) is
YAML-and-prompt-only — new worker steps and prompt content, no new canon primitives. Phase 2 (designed,
not approved) adds execution — a probe step that runs something and an adjudication step that can act
on the result — and is recorded here so its design does not have to be re-derived later, but it is not
graded as part of this spec's acceptance criteria.

### Evidence base

Two production runs of `code-review` against PR #1332 in a Rails financial app, each compared
independently to a hand-built multi-agent review of the same diff:

- **Run `780c2f42`** (2-commit diff): 1 blocker found correctly. Dropped 4 findings at `verify`; every
  drop held up independently, and one beat the competing human-led review by proving a false finding
  false. **Missed a blocker**: a change that invalidated a load-bearing comment in a file the diff did
  not touch.
- **Run `d0ce9d9c`** (2-commit diff): 4 minors, verdict "ready to merge". **Missed a major**: a refusal
  message that also renders on the create path, asserting two false things there. It did catch a
  factual error in the operator's own brief, which no human reviewer did.
- **Control**: a 9-slice hand-built review of the full 528-file diff found 2 blockers and 12 majors.
  Both blockers needed either running code or reading files outside the diff. Ten findings had a
  covering spec that could not fail: a spec asserting the implementation's own formula as expected
  value; one creating a single row where the bug needs two; one pinning both sides of an inconsistency
  in one example; one pinning documentation copy by substring so it locks in a false statement.

**Diagnosis, in priority order:**

1. No execution — every argument-settling piece of evidence in the control review came from running
   something.
2. It reviews the diff, not the blast radius.
3. It inherits the operator's framing completely — run 2's brief said "update/destroy paths", and
   workers and verifier both stayed inside that frame.
4. Severity under-calls: "ready to merge" falls out of "nothing survived" rather than being argued.

Phase 1 addresses (2), (3) and (4). It only partially addresses (1): a falsifiability dimension without
execution is reasoning _about_ falsifiability, and the control data itself says that catches some but
not all of the ten unfalsifiable-spec findings — the ones needing running code stay uncaught until
Phase 2.

### Current pipeline, verified against the code

`pipelines/code-review.yaml` declares `inputs: [plan, baseline, introducedCommits]`,
`optionalInputs: [baseline, introducedCommits]` (both default `""`). Four `llm` steps:

- `correctness` and `security` — `role: worker`, `permissions.contents: read`, no `dependsOn`, prompts
  `prompts/audit-correctness.md` / `prompts/audit-security.md` (shared, byte-identical with the `audit`
  pipeline — spec 030 out-of-scope, unchanged since).
- `verify` — `role: reasoner`, `permissions.contents: read`, `dependsOn: [correctness, security]`,
  prompt `prompts/code-review-verify.md`, `schema: codeReviewFindings`.
- `synthesis` — `role: reasoner`, `permissions.contents: read`, `dependsOn: [verify]`, prompt
  `prompts/code-review-synthesis.md`. Receives `{{verify}}` only.

`codeReviewFindings` (`src/canon/schemas.ts:26-68`) requires, per finding: `claim`, `file`, `line`,
`quote`, `verdict` (`CONFIRMED | PARTIAL | DECLINED`), `citationAccurate`, `scope`
(`introduced | pre-existing | undetermined`), `kind` (`defect | business-decision |
external-confirmation`), `severity` (`blocking | major | minor`), `severityRationale` (added
2026-09-20 by D13/FR-016, the one exception FR-010 grants), `probes`
(`guard, reachability, remedy, callers, scope`), `correctedWording`. `additionalProperties: false` on
both the finding object and the wrapper.

### Canon constraints that shape both phases

- **`permissions.contents: read` grants `Read,Glob,Grep`, never Bash** (`src/canon/adapters/claude.ts:
64-79`); the no-permissions fallback stays `Read,Glob`. No `llm` step in this pipeline can run a
  command, in either phase — a probe (Phase 2) is a different step kind for this reason.
- **The canon has no conditionals.** `pipelines/build-round.yaml:14-17`: "the canon has no
  conditionals, so a step cannot be skipped on the strength of a sibling's result." The only existing
  precedent for a step degrading to a no-op is prompt-level: `prompts/build-fix.md:4,24` instructs the
  model to reply `"All checks passed — no changes needed."` and edit nothing when there is nothing to
  fix. Every new step in this spec needs the equivalent instruction, because the pipeline graph cannot
  route around a step that found nothing.
- **`check` step commands are fixed at build time, deliberately.** `{{checkCommand}}` is the one
  placeholder resolved from `BuildDeps` before any run exists — "before any run exists — so run context
  (pipeline inputs, step outputs) cannot influence the value" (`src/bindings/mastra/buildSteps.ts:
844-850`); `src/canon/load.ts` rejects any other placeholder in a `check` command at load time. This is
  the precedent Phase 2's probe-command composition (D7) follows.
- **`materializeSanitizedWorkspace`** (`src/canon/workspace/sanitize.ts:88-143`) copies
  `git ls-files -co --exclude-standard` into a flat temp directory, excluding `.git`, credential deny
  patterns, symlinks and gitlinks (submodule-shaped directories). It is not a git repository and carries
  no gitignored dependency tree, so it cannot run a test suite — the reason Phase 2 needs a different
  execution surface (D8).
- **No git worktree machinery exists anywhere in `src/`.** Phase 2's probe execution (D8) is a new
  primitive; Phase 1 introduces none.
- **`renderPrompt`/`extractPlaceholders`** (`src/canon/render.ts`) substitute only placeholder names
  literally present in a template string; an unmapped placeholder is a hard throw. `visibleKeys` for an
  `llm` step (`src/bindings/mastra/build.ts:99-101`) is built from `pipelineAncestors`
  (`src/canon/graph.ts:144-164`), which is **transitive** — so a step's vars map can carry ancestor
  outputs its own prompt never names. What keeps `synthesis` from seeing `{{correctness}}`/`{{security}}`
  today is that `prompts/code-review-synthesis.md` contains neither placeholder, not a structural
  isolation the graph itself enforces. Recorded here as a constraint on Phase 1's own prompt edits (D6):
  the isolation is an interface convention enforced by prompt content, and any future edit to
  `code-review-synthesis.md` must not introduce a placeholder for a worker step's raw output.

## Decisions

**D1 — Phase 1 ships with no new canon primitives; pipeline YAML and prompt edits only.** No new step
kind, no new tool grant, no schema field. It is measured against the benchmark (Verification, below)
before Phase 2 is approved. Rationale: Phase 1 is where the precision risk lives — new finding sources
against a must-not-regress bar; Phase 2 is where cost and blast radius live. Measuring them separately
keeps a regression attributable to one phase, not the combination.

**D2 — A new `radius` step runs first and feeds `correctness` and `security`.** `role: worker`,
`permissions.contents: read`, no `dependsOn` — same level as the pipeline's other unblocked step,
`falsifiability` (D3). It answers what the change's correctness depends on that is not in the diff:
callers of changed methods, comments anywhere asserting an invariant the change alters, siblings
implementing the same pattern differently, state transitions newly made possible. New prompt
`prompts/code-review-radius.md`.

Because the shared `prompts/audit-correctness.md`/`prompts/audit-security.md` must stay byte-identical
with the `audit` pipeline (spec 030 out-of-scope), `correctness` and `security` fork into new,
code-review-specific prompts — `prompts/code-review-correctness.md` and `prompts/code-review-security.md`
— that add `{{radius}}` consumption and the framing-defence instructions (D4). This closes the follow-up
spec 030 recorded and deferred ("fork `audit-correctness.md`/`audit-security.md` into code-specific
variants") rather than opening a new one. `audit.yaml` and the three `audit-*.md` prompts are untouched;
verified with `git diff --exit-code` the same way spec 030 verified it.

**D3 — Test-falsifiability is its own worker step, `falsifiability`, not a section inside
`correctness`.** `role: worker`, `permissions.contents: read`, no `dependsOn`. New prompt
`prompts/code-review-falsifiability.md`. It reads the diff's own tests/specs against the change and
flags a covering spec that cannot fail, checked against the four concrete shapes the control review
found: a spec asserting the implementation's own formula as its expected value; a spec creating a
single row where the bug needs two to surface; a spec pinning both sides of an inconsistency into one
example; a spec pinning documentation copy by substring, locking in a false statement. Separating this
from `correctness` makes its contribution to finding count and decline rate independently measurable —
not via a schema change (D1), but by comparing `verify`'s output with and without this step present, per
the Verification section.

**D4 — Framing defence lives in the worker prompts.** `code-review-correctness.md`,
`code-review-security.md`, `code-review-falsifiability.md` and `code-review-radius.md` each restate the
brief's implicit scope, then deliberately review one thing outside it. Out-of-frame findings are
expected to land as `scope: undetermined` or `pre-existing` and be scoped by `verify` — the existing
schema already carries both values; no schema change.

**D5 — `synthesis` must argue the merge verdict affirmatively.** It states what classes of defect were
searched for and not found, rather than emitting "ready to merge" because nothing survived `verify`. A
verdict that cannot distinguish "we looked and it's clean" from "we didn't look" is not a gate. Stands
as written; benchmark run 1 confirmed it works. Its placement was incomplete, not wrong — see D11.

**D6 — Preservation: `verify` stays separate and keeps its decline authority; `synthesis` keeps
receiving `{{verify}}` only.** `verify`'s ability to `DECLINE` with written reasons is the pipeline's
most valuable behaviour (spec 030) and is not diluted by adding sources ahead of it — its
`dependsOn` widens to `[correctness, security, falsifiability]` (`radius`'s output reaches `verify` only
indirectly, through `correctness`/`security`, per D2), but it remains the one step, run by a different
agent than the ones raising findings, that adjudicates every claim. `synthesis`'s `dependsOn` stays
`[verify]` and `prompts/code-review-synthesis.md` gains no new placeholder — per the render/visibleKeys
constraint above, this is what keeps the isolation real rather than accidental.

**D11 (amendment, 2026-09-20) — severity is argued at `verify`, not only at `synthesis`.** D5 aimed the
"argue the verdict" fix one step too late. `synthesis` can only argue from the severities `verify` hands
it, so a silent downgrade inside `verify` decides the merge verdict before `synthesis` ever sees the
finding: in benchmark run 1 all 13 findings arrived `minor`, including a `falsifiability` finding raised
`major` with a neutering-edit argument, and "ready to merge" followed with nothing to argue against.
`prompts/code-review-verify.md` therefore carries the worker's proposed severity forward unless the
verifier has a stated reason to move it, and states that reason in the finding's own words for any move,
up or down. This is not licence to inflate — a worker's severity is a proposal, not a verdict, and
judging it against the repository remains the verifier's job. What is forbidden is the silent downgrade.
The `severity` enum (`blocking | major | minor`) is unchanged; FR-010 still holds. D5's requirement on
`synthesis` stands unchanged — the argued verdict was run 1's clearest win.

**D12 (amendment, 2026-09-20) — a new review dimension is checked for what it DISPLACES, not only for
what it adds.** Benchmark run 1 lost a baseline finding — the most structural one in the set — while its
`correctness` output grew longer, so nothing ran out of room: the dimension moved the worker's attention
rather than crowding out its words. A dimension handed to an existing reviewer as required context
converts that reviewer into a processor of the dimension. Two consequences, both general:

- ~~Every prompt that consumes another step's output states the order and the relationship explicitly:
  the reviewer's own review comes first and must be complete on its own terms, and the new surface is
  additive — it may never narrow, replace, or consume the budget for that review.~~ **Tried in run 2 and
  REVERTED — see D13 and D14.** The prose went into both worker prompts verbatim and the displaced
  finding stayed displaced, while retention fell. The diagnosis in this decision still stands; the
  instrument it proposed does not.
- Every benchmark comparison reports retained baseline findings alongside added ones. A run that adds
  four findings and loses one is not a strict improvement, and a count that only goes up hides that.
  **This is the metric that matters** — not raised-count, not decline rate. Run 2 improved both of those
  while losing baseline findings, and reading either alone would have scored a regression as a win.

**D13 (amendment, 2026-09-20) — where prose has failed twice, the instrument becomes a contract.** Run
2 is the controlled test of D11's and D12's prompt-level fixes: same brief, same diff, same repository,
prompts the only variable. Both fixes failed on their own targets. The durable finding, stated
generally because it is not about these two prompts:

> Prose guidance moved a quantitative behaviour — the verifier's hedging rate — but moved neither
> structural behaviour. Asking a model to think about something is not the same instrument as requiring
> it to emit something. Where the wanted behaviour is structural, the instrument has to be a contract:
> a required output slot, or a field that cannot be left silent, not an instruction.

Two contracts follow, and they are the whole of this amendment's new surface:

- **A required output slot** for the displaced dimension. `prompts/code-review-correctness.md`'s
  `<output_format>` carries a section headed exactly `Invariants relied on`, which the model must fill:
  each invariant the change relies on, and the layer that enforces it — or `enforced nowhere`, which is
  a finding, not an omission. This is the displaced baseline finding's own shape (`db/schema.rb:764`,
  "no second layer enforces `paid_on implies pricing closed`"), turned from something the worker was
  asked to consider into something the worker must produce. `prompts/code-review-security.md` carries
  the same instrument in its own tracing voice, headed `Constraints relied on`, because the security
  prompt already asks what constrains each value on the way and the section is where that answer lands.
- **A field that cannot be left silent** for severity. `codeReviewFindings` gains
  `severityRationale`, required, `additionalProperties: false` unchanged. D11's prose stays as the
  field's companion — it is what tells the verifier _what to write there_ — but the enforcement is now
  the schema, which a model cannot satisfy by omission the way it satisfied a paragraph.

Cost of the exception: one more required string per finding, and `prompts/code-review-synthesis.md`
reprints it beside every severity, so a reader sees whether a finding was argued down or merely
recorded low.

**D14 (amendment, 2026-09-20) — run 2's worker-prompt tightening is REVERTED to the run-1 wording.**
`prompts/code-review-correctness.md` and `prompts/code-review-security.md` are restored to their state
at `c7f6dfc`: the "This review of yours comes first…" / "These traces of yours come first…" paragraphs
are removed and the original "required context, not colour" radius paragraphs come back. Rationale:
retention. Run 1's wording retained 3 of the baseline's 4 findings; run 2's tightening retained about 2
and additionally lost the TOCTOU spec finding, while adding nothing on its target. A change that makes
the measured-worse thing worse is reverted even though its raised-count and decline-rate read better —
those are not the bar (D12). The reverted prose is not replaced by more prose; it is replaced by the
required slot in D13.

**D7 — (Phase 2, deferred) Probe execution never lets a model author a shell command.** The threat model
is that `code-review` runs on a diff the operator did not write, so a model-authored command string
reaching a shell is remote code execution via prompt injection in a pull request. Instead a model emits
a structured probe request from a closed vocabulary, and agent-flows composes the command from a
repo-configured template plus validated arguments, spawned as an argv array, never `/bin/sh -c`. This
follows the same precedent `check` steps already set — the command is fixed from configuration, not from
anything the run produces — and preserves the "no `llm` step gets Bash" property intact.

**D8 — (Phase 2, deferred) Probes run in a git worktree with dependencies linked in.** Not the
operator's working tree, not the sanitized copy. The sanitized copy cannot run a suite (it is a flat
temp directory, no `.git`, no gitignored dependency tree — see `materializeSanitizedWorkspace` above);
probing in the operator's own working tree risks leaving it dirty — in the control review a sub-agent
dirtied `db/schema.rb` running a spec against a stale test database.

**D9 — (Phase 2, deferred) Probes must be able to change a verdict, and `synthesis` must not re-judge.**
Phase 2 inserts an adjudication step: `verify → probe → adjudicate → synthesis`. The finding schema
gains an evidence grade distinguishing `CONFIRMED-BY-EXECUTION` from `CONFIRMED-BY-READING` — a canon
change (`src/canon/schemas.ts`), same category as spec 030's own D2, not a same-phase addition to Phase 1.

**D10 — (Phase 2, deferred) Probe capability is optional per repo and degrades to a no-op where no
usable check command is configured.** No dependency on a specific language or test runner.

## Functional Requirements — Phase 1

- **FR-001.** `pipelines/code-review.yaml` gains two new `llm` steps and rewires the existing graph to
  five dependency levels: level 0 — `radius`, `falsifiability` (both `role: worker`, no `dependsOn`);
  level 1 — `correctness`, `security` (`dependsOn: [radius]`); level 2 — `verify` (`dependsOn:
[correctness, security, falsifiability]`); level 3 — `synthesis` (`dependsOn: [verify]`, unchanged).
  All new and changed steps keep `permissions.contents: read`; no step in either phase-1 addition
  declares more.
- **FR-002.** `prompts/code-review-radius.md` (new) instructs the model to name, from repo-wide search:
  callers of every method the diff changes, comments anywhere asserting an invariant the diff alters,
  siblings implementing the same pattern with a different rule, and state transitions the diff newly
  makes reachable (D2).
- **FR-003.** `prompts/code-review-correctness.md` and `prompts/code-review-security.md` (new, forked
  from `prompts/audit-correctness.md`/`prompts/audit-security.md`) reference `{{radius}}` and treat it
  as required context for their own review, not as optional colour (D2). **Amended 2026-09-20 (D14),
  superseding the D12 amendment:** both prompts are restored to their `c7f6dfc` wording — the
  order-and-relationship paragraphs run 2 added are removed, because they cost retention and moved
  nothing on their target. The structural completeness they asked for is required instead by FR-015's
  output slot. Working through every radius entry remains required. `prompts/audit-correctness.md`,
  `prompts/audit-security.md`, `pipelines/audit.yaml`, and the other two `audit-*.md` prompts stay
  byte-identical, verified with `git diff --exit-code`.
- **FR-004.** `prompts/code-review-falsifiability.md` (new) instructs the model to check each test or
  spec covering a diff-introduced change against the four shapes named in D3, and to report a finding in
  the same free-form worker shape `correctness`/`security` already produce, for `verify` to structure
  (D3).
- **FR-005.** `code-review-radius.md`, `code-review-correctness.md`, `code-review-security.md` and
  `code-review-falsifiability.md` each restate the brief's implicit scope and instruct a deliberate,
  named look outside it; findings from that look are not filtered before reaching `verify` (D4).
- **FR-006.** `prompts/code-review-synthesis.md` states, for at least each of correctness, security,
  falsifiability and blast-radius, what was searched for and not found, before stating the merge
  verdict; the verdict text itself argues from that list, not from "nothing survived verify" alone (D5).
- **FR-007.** `verify`'s `dependsOn` becomes `[correctness, security, falsifiability]`; its schema
  (`codeReviewFindings`), its role (`reasoner`, distinct from every worker feeding it) and its decline
  authority are unchanged; `prompts/code-review-verify.md` gains `{{falsifiability}}` alongside its
  existing placeholders (D6). **Amended 2026-09-20 (D11):** `prompts/code-review-verify.md` additionally
  makes `severity` an argued decision — the worker's proposed severity carries forward unless the
  verifier states a reason to move it, and every move, up or down, carries that reason in the finding's
  own words. **Amended 2026-09-20 (D13):** that paragraph stays, but it is no longer the mechanism — it
  is the instruction for what to write in the `severityRationale` field FR-016 makes required. The
  `severity` enum itself is still untouched.
- **FR-008.** `synthesis`'s `dependsOn` stays `[verify]`; `prompts/code-review-synthesis.md` gains no
  placeholder for `{{correctness}}`, `{{security}}`, `{{falsifiability}}` or `{{radius}}` — a load-time
  assertion (`extractPlaceholders` over the file) proves this, matching the mechanism spec 030 FR-008
  already relies on (D6).
- **FR-009.** `code-review-radius.md` and `code-review-falsifiability.md` each instruct a literal,
  parseable "nothing found" reply for the case where the search turns up nothing (mirroring
  `prompts/build-fix.md`'s `"All checks passed — no changes needed."` precedent); `code-review-
correctness.md`/`code-review-security.md` treat that literal reply as "the check ran and found
  nothing," never as "the check did not run" — required because the canon has no conditionals to skip a
  downstream step on an upstream no-op.
- **FR-010.** `pipelines/audit.yaml` and its three `audit-*.md` prompts are unmodified. **Amended
  2026-09-20 (D13):** `codeReviewFindings` (`src/canon/schemas.ts:26-68`) takes exactly one change for
  the duration of Phase 1 — the addition of the required `severityRationale` string (FR-016). No other
  field, no changed enum, `additionalProperties: false` unchanged on both the finding object and the
  wrapper. The exception is granted because two controlled runs established that the behaviour FR-007
  asks for cannot be obtained from the prompt: the same finding arrived `major` and left `minor` with an
  empty explanation in both runs, including the one whose prompt forbade exactly that. A field the
  schema requires is the only instrument left that a model cannot satisfy by omission. It is granted for
  this field only; Phase 2's evidence-grade field (FR-013) remains deferred and unapproved, and D1's bar
  otherwise stands.

### Added 2026-09-20 (D13, D14)

- **FR-015.** `prompts/code-review-correctness.md`'s `<output_format>` requires a section headed
  exactly `Invariants relied on`, never empty, with one entry per invariant the change relies on: the
  invariant stated so it could be false, and the enforcing layer with the line quoted — or
  `enforced nowhere` with the searches that came back empty named. `enforced nowhere` must also be
  raised as a finding in the list above, with its own location and severity. The enforcement the change
  itself adds does not count as enforcement of the invariant that change relies on. The heading is
  literal so the section's presence is checkable. `prompts/code-review-security.md` carries the same
  instrument as `Constraints relied on`, in its tracing voice: one entry per externally-influenced value,
  the bounding line quoted or `constrained nowhere`. Both prompts' "the review is done when" lines name
  the section, so an unfilled slot is an incomplete review rather than a style lapse (D13).
- **FR-016.** `codeReviewFindings` carries a required `severityRationale: string`, in `properties` and in
  `required`, `additionalProperties: false` unchanged. `prompts/code-review-verify.md` enumerates it
  among the per-finding fields and states its semantics: it names the severity the worker proposed and
  what the verifier did with it — a confirmation when unchanged, and when changed in either direction the
  reason, grounded in what was read in the repository. Naming the proposed severity is part of the
  contract, so the entry says what was moved from as well as what it was moved to.
  `prompts/code-review-synthesis.md` reprints it verbatim beside every retained finding's severity (D13).
- **FR-017.** A `code-review-severity` eval makes the silent downgrade falsifiable.
  `src/evals/fixtures/code-review-severity.ts` seeds ONE hand-written `falsifiability` finding, raised
  `major` with a neutering-edit argument, against files that exist in this repository
  (`src/evals/persistRun.ts`, `src/evals/persistRun.test.ts`). Because the graded event is a downgrade
  and no live worker can be compelled to raise a given finding at a given severity, the eval runs the
  real `verify` step alone — real prompt, real schema, real read access — over seeded worker text, via a
  verify-only reduction of `code-review.yaml` built in `src/evals/run.ts`; `assertReadOnly` is applied to
  the whole pipeline before the reduction. `reviewSeverity` in `src/evals/scorers.ts` FAILS a finding
  emitted below the proposed severity whose `severityRationale` does not account for the drop, and a
  finding the key cannot locate at all; it PASSES a severity kept, or lowered with a reason that names
  what it moved from. The scorer is unit-tested without a model in `src/evals/scorers.test.ts`, and that
  test is proven able to fail by neutering `severityDropAccountedFor` (D13).

## Functional Requirements — Phase 2 (DEFERRED — NOT APPROVED)

- **FR-011 (DEFERRED).** A model emits a probe request from a closed, enumerated vocabulary (not free
  text); agent-flows composes the actual command from a repo-configured template plus validated
  arguments and spawns it as an argv array, never through a shell (D7).
- **FR-012 (DEFERRED).** Probe commands run inside a git worktree created for the run, with the
  project's dependencies linked in, distinct from both the operator's working tree and the sanitized
  workspace copy; the worktree is torn down at the end of the run regardless of outcome (D8).
- **FR-013 (DEFERRED).** The pipeline graph gains an `adjudicate` step: `verify → probe → adjudicate →
synthesis`; `codeReviewFindings` gains an evidence-grade field distinguishing
  `CONFIRMED-BY-EXECUTION` from `CONFIRMED-BY-READING`; `synthesis` continues to see only the
  adjudicated output, never `probe`'s raw result directly (D9, D6's isolation principle carried
  forward).
- **FR-014 (DEFERRED).** Probe capability is configured per repository and no-ops (skips straight to
  adjudication with no execution evidence) where no usable check command is configured; nothing in the
  pipeline requires a specific language or test runner (D10).

## Verification

Benchmark: three runs of the Phase-1 pipeline in `/Users/en3e/code/domcap/ascent-portal` on branch
`feature/1143_eloc`, each against the unmodified `code-review` pipeline as its own before/after
baseline:

- **`230a2cc6...0cd08a10`** (full range) — targets: a nil term-version lookup that silently skips a
  4.99% ownership compliance gate, and a change-tracking `if:` keyed on the wrong attribute that moves
  warrant exercise capacity 10×. Surfacing at least one is success.
- **`c16f22ca..e9e206fa`** — target: the `AdvanceFunder` pre-lock stale read.
- **`e9e206fa..0cd08a10`** — target: the funded-tail message rendering on the create path.

**Precision bar.** Both prior production runs together produced roughly 12 findings total with nothing
discardable as noise. Report findings-per-run and `verify`'s decline rate before (unmodified pipeline)
and after (this spec) each of the three ranges. Tripling the finding count with half of it junk is a
net loss, not a win, regardless of whether the two missed defects above are caught. **Amended
2026-09-20 (D12, confirmed by run 2):** report retained baseline findings alongside both, and read that
number first. Findings-per-run and decline rate are precision proxies that move independently of
whether the review still finds what it used to: run 2 raised fewer findings and declined a larger share
of them — which reads as improved precision — while retaining half as many baseline findings as run 1.
A run is not an improvement on a metric that went the wrong way.

**What this measures and what it does not.** These three benchmark runs and their diagnosis (2)
(blast-radius), (3) (framing) and (4) (verdict argument) fixes are inside Phase 1's scope. Diagnosis (1)
— no execution — is only partially addressed by the falsifiability dimension, which reasons about
whether a spec could fail without running it; the control review's own data says reasoning catches some
but not all of its ten unfalsifiable-spec findings. The remainder stays uncaught until Phase 2 is
approved and built.

### First benchmark run (2026-09-20)

Run `c209f8d2`, the six-step Phase-1 pipeline, against baseline run `d0ce9d9c`, the unmodified four-step
pipeline. Identical brief, identical diff, identical repository — the pipeline is the only variable.

| Measure                | Baseline `d0ce9d9c` | Run 1 `c209f8d2` |
| ---------------------- | ------------------- | ---------------- |
| Findings retained      | 4                   | 7                |
| Of the baseline 4      | —                   | 3 kept, 1 lost   |
| Added findings         | —                   | 4                |
| `verify` decline rate  | 25%                 | 15%              |
| `PARTIAL` verdicts     | 1                   | 6                |
| Findings above `minor` | 0                   | 0                |

The next run regresses against these numbers, retained findings included.

**Finding 1 — the new dimension displaced an existing finding.** The baseline's most structural item —
"no second layer enforces `paid_on implies pricing closed`", at `db/schema.rb:764` — is absent from run 1.
Run 1's `correctness` output is longer than the baseline's (7,566 vs 5,993 characters) yet mentions
`schema.rb`, `constraint` and `database` zero times, where the baseline mentioned all three; two of its
six entries are explicitly radius-derived, one headed `**Location:** blast radius`. It did not run out of
room — its attention moved. Cause: `prompts/code-review-correctness.md` called the blast-radius report
"required context, not colour" and told the worker to "work through it entry by entry", which turned an
independent reviewer into a radius-processor. The radius consumption itself is sound and is kept — three
of the four added findings came from it. Fixed in the worker prompts per D12 and FR-003; recorded as a
general rule because it applies to every future dimension, not just this one.

**Finding 2 — the severity downgrade is in `verify`, not `synthesis`.** The `falsifiability` worker
raised its finding `major` with a neutering-edit argument: a user-facing operational claim shipped in the
diff and echoed in `config/locales/help.en.yml`, with no test that verifies it. `verify` recorded it
`minor` with no stated reason. All 13 findings came back `minor`, so `synthesis` had no blocking finding
to argue from and emitted "ready to merge" for the second run running. D5 aimed the fix at `synthesis`;
the downgrade happens one step earlier. Fixed in `prompts/code-review-verify.md` per D11 and FR-007.

### Second benchmark run (2026-09-20)

Run `70703f60`, the six-step pipeline with D11's and D12's prompt fixes applied (`ccbb89a`), against run
`c209f8d2` and the same four-step baseline `d0ce9d9c`. Identical brief, identical diff, identical
repository — the prompts are the only variable between run 1 and run 2.

| Measure                     | Baseline `d0ce9d9c` | Run 1 `c209f8d2` | Run 2 `70703f60` |
| --------------------------- | ------------------- | ---------------- | ---------------- |
| Findings retained           | 4                   | 7                | 4                |
| **Of the baseline 4, kept** | —                   | **3**            | **~2**           |
| `verify` decline rate       | 25%                 | 15%              | higher           |
| Findings above `minor`      | 0                   | 0                | 0                |

**Both prompt-level fixes failed on their targets.**

- **Severity (D11).** The `falsifiability` worker proposed `major` for
  `spec/models/share_sale_spec.rb:321` in run 1 AND in run 2. `verify` wrote `minor` in both, with
  `correctedWording` empty and no probe mentioning the decision — in run 2 despite
  `prompts/code-review-verify.md` now carrying an explicit "severity is argued, never assigned in
  silence" paragraph forbidding precisely that. The prose was read and not acted on.
- **Displacement (D12).** The baseline finding "no second layer enforces `paid_on implies pricing
closed`" (`db/schema.rb:764`) is absent from run 1 AND run 2. `correctness` mentions `schema.rb`,
  `constraint` and `database` zero times in both, where the four-step baseline mentioned all three.
  Run 2's "your own review comes first / the radius report is additive" paragraphs did not move it.
- **The tightening made retention worse.** Run 2 kept about 2 of the baseline's 4 findings against run
  1's 3, additionally losing the TOCTOU spec finding, while raising fewer findings and declining a
  larger share. On raised-count and decline-rate alone run 2 reads as the better run; on retained
  baseline findings — the metric that matters (D12) — it is the worse one. Reverted by D14.

What the pair establishes is not about these two prompts: prose moved the one quantitative behaviour in
the set (hedging) and neither structural one. That is the finding recorded as D13, and the instruments
that replace the prose — FR-015's required slot, FR-016's required field, FR-017's eval — are what the
third run measures.

## Out of scope / Risks

- Phase 2 (D7-D10, FR-011-FR-014) is designed, not approved, and not implemented on this branch. Its
  git-worktree primitive does not exist anywhere in `src/` today (verified) and its schema change
  (`codeReviewFindings` evidence grade) is a canon change, not a Phase 1 prompt/YAML edit.
  Approving Phase 1's benchmark results does not itself approve Phase 2.
- No changes to `pipelines/audit.yaml` or the three `audit-*.md` prompts (`docs/...` unaffected); they
  must stay byte-identical, verified with `git diff --exit-code`, matching spec 030's own out-of-scope
  guarantee.
- No new tool grant, no Bash access, for any Phase 1 step.
- ~~No schema change in Phase 1; `codeReviewFindings`'s field set, enums and
  `additionalProperties: false` are unchanged.~~ **Amended 2026-09-20 (D13/FR-010):** exactly one field,
  `severityRationale`, is added, for the reason FR-010 records. Enums and `additionalProperties: false`
  are unchanged, and no further schema change is in scope for Phase 1.
- `radius` and `falsifiability` add two more `llm` calls per run over spec 030's four-step graph; cost
  impact is not separately budgeted here and should be read off the benchmark's own run costs.
- The falsifiability dimension's own precision (does it add real findings or noise) is exactly what the
  benchmark's decline-rate comparison is for; this spec does not presume the answer.
