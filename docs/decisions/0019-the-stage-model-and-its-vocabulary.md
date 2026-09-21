# 0019. The stage model and its vocabulary

Status: Accepted — 2026-09-21

> **Amendment (2026-09-21):** By owner directive, **no workflow may push anything or create a pull
> request — all work happens locally.** `pipelines/ship.yaml`'s `pr` step (`gh pr create --fill`,
> with its `env: [GH_TOKEN]` declaration) is removed, and `ship`'s description becomes "Gate and
> commit locally after human approval". The reason is trust, not capability: the tool is not yet
> trusted for unattended operation, and a pull request is the first irreversible, publicly visible
> side effect a mis-stepped run can produce. A local commit can be amended or reset by the owner; a
> PR cannot be unpublished. No stage touches the remote at all until that trust is established —
> publishing a commit is the operator's own `git push`, outside any pipeline. The `ship` row in D1
> and the PR bullet in Consequences are amended below; the `ship` description quoted in Context is
> the pre-amendment one, left as the snapshot that motivated this ADR.

## Context

The owner's goal is to automate software development from an initial prompt through to a PR, while
keeping the ability to run any part independently — draft a spec alone, develop a ticket locally
with no commit/PR/remote branch, run a code review that produces a local report, and so on.
ADR-0015 already established that the lifecycle is a library of small, independently-runnable
workflows composed by `kind: pipeline`, not one monolith. That capability exists today
(`pipelines/*.yaml`). The vocabulary naming it does not match it, and nothing declares the stage
model itself, so names have drifted as the catalogue grew past ADR-0015's original seven:

- `investigate` — "Read the real repo and surface what matters before any code is written"
- `spec-creation` — "Harden a feature request into an adversarially reviewed spec"
- `develop` — "Execute an approved implementation plan by writing code and tests"
- `build` — "Execute the approved plan then loop test-and-fix until the suite passes"; composed of
  `develop` → `converge` (loop over `build-round` until `test.passed`) → `review` (nested `audit`)
  → `verify` (a required check)
- `build-round` — "Single test-and-fix iteration; composed into build.yaml as a bounded loop"
- `audit` — "Adversarial read-only review of a plan; fans out to correctness and security then
  converges"
- `code-review` — "Adversarial review of a code change, with every finding verified against the
  repo"
- `correct-plan` — "Fold verification findings back into a plan, producing a complete revised plan"
- `test` — "Run the project test suite and emit a pass/fail result"
- `ship` — "Gate, commit, and open a pull request after human approval"
- `cycle` — "Full development lifecycle — investigate, plan, build, and ship"
- `cycle-dev` — "Full development lifecycle — investigate, plan, and build (stops before ship; no
  commit, no PR)"

Five concrete problems follow from this drift:

1. **`build` is the wrong word.** It contains implement → test/fix loop → review → verify. In
   software, "build" means compile/package, not "write code and review it."
2. **"dev" carries two unrelated meanings** in one catalogue: `develop` is a single step that writes
   code; `cycle-dev` uses "dev" to mean "stops before shipping."
3. **`audit` vs `code-review` hides the real distinction** — one reviews a PLAN, the other reviews a
   DIFF. This is the exact confusion that forced a prompt fork in spec 040:
   `prompts/audit-correctness.md` is shared by `audit`, and `audit` is nested inside `build`,
   `spec-creation`, `cycle` and `cycle-dev`, so a diff-shaped instruction could not be added to it —
   `prompts/code-review-correctness.md` had to be created instead (`pipelines/code-review.yaml:34-36`).
4. **Verbs and nouns are mixed with no rule.** `investigate`/`develop`/`audit`/`ship` are verbs;
   `code-review`/`build-round`/`cycle-dev`/`spec-creation` are nouns or compounds.
5. **Nothing declares the stage vocabulary** — no single place states what the lifecycle stages are,
   what each guarantees, and what each refuses to do.

## Decision

**D1 — The stage model.** A stage takes a named input artifact, guarantees a named output artifact,
and REFUSES a named class of side effect. The refusal is the load-bearing column — it is what makes
"run any part independently" safe to promise:

| Stage           | Input                        | Output                                    | Refuses                                                                                                                                        |
| --------------- | ---------------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `investigate`   | `request`                    | `findings`                                | Writes nothing; `permissions.contents: read` on every step                                                                                     |
| `spec-creation` | `request`, `findings?`       | approved, hardened spec (`artifact.spec`) | Writes no repo files; gated by a human `approve` step before persisting                                                                        |
| `develop`       | `plan`                       | code + tests written to the repo          | Runs no tests, no review, no git commands                                                                                                      |
| `build-round`   | (implicit, from `build`)     | one test-and-fix iteration                | Only loop iteration; never decides convergence itself (`build` does)                                                                           |
| `build`         | `plan`                       | a tree that passes `{{checkCommand}}`     | Never touches git history or the remote — no commit, no branch, no PR                                                                          |
| `audit`         | `plan`                       | a verdict + findings on the PLAN          | Read-only (`permissions.contents: read`); changes no code                                                                                      |
| `code-review`   | `plan` (a diff), `baseline?` | verified findings on the DIFF             | Read-only; no shell access on any step (findings come from text search)                                                                        |
| `correct-plan`  | `plan`, `findings`           | a revised, complete plan                  | Writes no repo files; output is plan text, not code                                                                                            |
| `test`          | (none)                       | pass/fail + evidence                      | Runs `{{checkCommand}}` only; no repair, no review                                                                                             |
| `ship`          | `plan`                       | a local commit                            | Never touches the remote — no push, no PR; the only stage that touches git history at all, and gated by a human `approve` (amended 2026-09-21) |
| `cycle`         | `request`                    | investigate → plan → build → ship         | Nothing beyond what its stages already refuse                                                                                                  |
| `cycle-dev`     | `request`                    | investigate → plan → build (stops)        | Never commits, never opens a PR — the one difference from `cycle`                                                                              |

This table is descriptive of the pipelines as they exist today (`pipelines/*.yaml`); it does not
introduce new stages.

**D2 — Every stage is independently runnable, as a first-class property.** This is not a side
effect of composition — it is why the catalogue is a set of small pipelines wired by `kind: pipeline`
(ADR-0015) rather than one pipeline with flags. Any stage can be entered directly with its input
artifact supplied by a human or carried over from a previous run (spec 029's stage-handoff). This is
what lets the owner run `code-review` alone against a diff, or `develop` alone against an
already-approved plan, without paying for the stages around it.

**D3 — The naming rule.**

- Stage pipelines are named verb or verb-object, lowercase-hyphenated.
- A review pipeline encodes its TARGET in the name (`review-plan`, `review-code`) so the plan/diff
  distinction from D1 is visible at the call site, not just in the description string.
- A composite pipeline encodes WHERE IT STOPS, since that is its only meaningful difference from a
  sibling composite (`cycle` vs `cycle-dev` today).
- An inner pipeline that exists only to be looped is suffixed `-round`.

**D4 — The renames that follow (decided, not yet executed).**

| Current        | Renamed to        |
| -------------- | ----------------- |
| `build`        | `implement`       |
| `build-round`  | `implement-round` |
| `audit`        | `review-plan`     |
| `code-review`  | `review-code`     |
| `correct-plan` | `revise-plan`     |

`investigate`, `develop`, `ship`, and `test` already satisfy the rule and are unchanged. The
`cycle`/`cycle-dev` pair is renamed so the difference is the stopping point, per D3, rather than the
word "dev" — the exact new names are chosen when the rename is executed, not here.

This ADR records the decision; it does not perform the rename. Pipeline ids appear in specs, tests,
templates, MCP `list_pipelines` output (`src/bindings/mastra/listPipelines.ts`), and nested
`kind: pipeline` references inside other pipeline files (e.g. `pipelines/build.yaml`'s `review` step
nests `pipeline: audit`; `pipelines/spec-creation.yaml`'s `verify` and `correct` steps nest
`pipeline: audit` and `pipeline: correct-plan`) — the blast radius spans all of these and must be
swept in one pass, not renamed piecemeal.

**D5 — `cycle` and `cycle-dev` must remain two pipelines.** This is not sloppiness. The canon has no
conditionals: `pipelines/build-round.yaml:14-17` states plainly that "the canon has no conditionals,
so a step cannot be skipped on the strength of a sibling's result." A single pipeline therefore
cannot conditionally skip its `ship` step based on a flag or a prior result — ADR-0014 already
rejected conditional edges for the same reason. Two pipelines, differing only in the trailing `ship`
step, is the correct expression of "stops before shipping"; the names must carry that difference
(D3) instead of relying on a shared id plus a mode argument.

**D6 — agent-flows must not depend on agent-notes internals.** `agent-notes` is in production use and
must not break; `agent-flows` is still being shaped. ADR-0018 already divides the machine by install
footprint — `agent-flows` owns package/daemon/pipelines/MCP, `agent-notes` owns every harness
dot-directory. This ADR extends that division to content: `agent-flows` may borrow `agent-notes`'
_patterns_ (its role-budget model-selection approach is a good one to imitate), but must never read
`agent-notes`' files, roles, or resolver at runtime or build time. A refactor inside a production
tool would otherwise break a tool that is meant to ship standalone. `agent-flows` owns its own role
vocabulary (`role: worker | reasoner | scout`, seen throughout `pipelines/*.yaml`) and its own model
resolution.

## Consequences

- The stage table in D1 becomes the reference for "what does X refuse to do" — future pipelines are
  checked against it before being added to the catalogue.
- The D4 rename is real, cross-cutting work: every `pipeline: audit`, `pipeline: build`,
  `pipeline: correct-plan` reference inside `pipelines/*.yaml`, every id string in specs and tests,
  and the MCP `list_pipelines` output all move together, in one pass.
- Until the rename lands, `prompts/audit-*.md` and `prompts/code-review-*.md` remain two forked
  prompt families for the same reason spec 040 forked them — a diff-shaped instruction cannot be
  added to a plan-reviewing prompt without corrupting `audit`'s callers (`build`, `spec-creation`,
  `cycle`, `cycle-dev`).
- `ship` still produces a fixed commit message (`git add -u && git commit -m "feat: apply approved
plan"`, `pipelines/ship.yaml`) — this is a known, separately-tracked gap, not fixed here. (Amended
  2026-09-21: the PR whose title/body `gh pr create --fill` derived from that message no longer
  exists; the fixed-message gap is now about the commit alone.) The fixed string exists for a
  sound reason recorded in the same file: check commands are not placeholder-rendered, and
  interpolating model output into a shell string is command injection. The eventual fix is a step
  that writes a real commit message to a run-scoped file and a check that commits with
  `git commit -F <file>` instead of `-m`, so the message can vary without going through shell
  interpolation.

## Alternatives rejected

- **Rename now, in the same change as this ADR.** Rejected: the rename touches specs, tests,
  templates, and every nested `pipeline:` reference at once (D4); mixing that mechanical, wide-blast
  edit into the same commit as declaring the model makes the model's rationale harder to review on
  its own and the rename harder to revert independently if a reference is missed.
- **Fold plan-review and code-review into one pipeline with a `target: plan | diff` parameter.**
  Rejected for the same reason as D5: the canon has no conditionals, so the pipeline could not branch
  its prompts on `target` without duplicating the steps anyway; two named pipelines is what the canon
  already supports cleanly.
- **Let `agent-flows` import `agent-notes`' resolver directly since the pattern is already proven
  there.** Rejected per D6: `agent-notes` is production infrastructure and any coupling makes a
  refactor there a breaking change here, which is the dependency direction ADR-0018 was written to
  prevent.
