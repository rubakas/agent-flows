# 040. Code review execution

| Field        | Value                                                                                                         |
| ------------ | ------------------------------------------------------------------------------------------------------------- |
| Feature Name | Code review execution                                                                                         |
| Branch       | `feat/040-code-review-execution` (not yet created)                                                            |
| Status       | Phase 1 approved, in progress — amended 2026-09-20 (first benchmark run). Phase 2 designed, **not approved**. |
| Created      | 2026-09-20                                                                                                    |

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

`codeReviewFindings` (`src/canon/schemas.ts:26-73`) requires, per finding: `claim`, `file`, `line`,
`quote`, `verdict` (`CONFIRMED | PARTIAL | DECLINED`), `citationAccurate`, `scope`
(`introduced | pre-existing | undetermined`), `kind` (`defect | business-decision |
external-confirmation`), `severity` (`blocking | major | minor`), `probes`
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

- Every prompt that consumes another step's output states the order and the relationship explicitly: the
  reviewer's own review comes first and must be complete on its own terms, and the new surface is
  additive — it may never narrow, replace, or consume the budget for that review.
- Every benchmark comparison reports retained baseline findings alongside added ones. A run that adds
  four findings and loses one is not a strict improvement, and a count that only goes up hides that.

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
  as required context for their own review, not as optional colour (D2). **Amended 2026-09-20 (D12):**
  they also state the order and the relationship — the worker's own review of the change comes first and
  must be complete on its own terms, including the structural questions a diff alone raises (is the
  invariant this change relies on enforced anywhere else; what is absent that should be present), and
  `{{radius}}` is additional surface layered on top of it that may not narrow, replace, or consume the
  budget for that review. Working through every radius entry remains required. `prompts/audit-correctness.md`,
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
  own words. No schema change: the `severity` enum is untouched (FR-010).
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
- **FR-010.** `pipelines/audit.yaml` and its three `audit-*.md` prompts are unmodified; `codeReviewFindings`
  (`src/canon/schemas.ts:26-73`) is unmodified — no new field, no changed enum — for the duration of
  Phase 1 (D1).

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
net loss, not a win, regardless of whether the two missed defects above are caught.

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

## Out of scope / Risks

- Phase 2 (D7-D10, FR-011-FR-014) is designed, not approved, and not implemented on this branch. Its
  git-worktree primitive does not exist anywhere in `src/` today (verified) and its schema change
  (`codeReviewFindings` evidence grade) is a canon change, not a Phase 1 prompt/YAML edit.
  Approving Phase 1's benchmark results does not itself approve Phase 2.
- No changes to `pipelines/audit.yaml` or the three `audit-*.md` prompts (`docs/...` unaffected); they
  must stay byte-identical, verified with `git diff --exit-code`, matching spec 030's own out-of-scope
  guarantee.
- No new tool grant, no Bash access, for any Phase 1 step.
- No schema change in Phase 1; `codeReviewFindings`'s field set, enums and `additionalProperties: false`
  are unchanged.
- `radius` and `falsifiability` add two more `llm` calls per run over spec 030's four-step graph; cost
  impact is not separately budgeted here and should be read off the benchmark's own run costs.
- The falsifiability dimension's own precision (does it add real findings or noise) is exactly what the
  benchmark's decline-rate comparison is for; this spec does not presume the answer.
