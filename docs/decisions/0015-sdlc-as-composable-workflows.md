# 0015. The SDLC is a library of composable workflows

Status: Accepted (2026-09-05)

## Context

Yoke's purpose is automating the owner's repeated development lifecycle. A primary-source survey of
Anthropic's workflow guidance and GitHub's Spec Kit framework (`docs/research/2026-09-04-agentic-dev-workflow-patterns.md`)
found two independent vendors documenting the same lifecycle spine: `research → plan → verify-plan →
correct-plan → [human gate] → develop → test → audit → converge`. Verification appears twice — once on
the plan (before any code), once on the code (after). Both vendors document this pattern as the
recommended shape for any agentic software-development lifecycle. The requirement is that this
lifecycle can run as **one end-to-end pipeline** OR as **separate, independently-runnable workflows**.

## Decision

1. **The lifecycle is not one monolithic pipeline; it is a library of small, independently-runnable
   workflows, composed by the self-nesting `pipeline` step (ADR-0012).**

2. **Seven leaf workflows, each runnable standalone, with this contract:**

| Workflow       | Does                                                                                   | Repo access       | Human gate                            | Justifying pattern                                              |
| -------------- | -------------------------------------------------------------------------------------- | ----------------- | ------------------------------------- | --------------------------------------------------------------- |
| `investigate`  | Understand the request against the real repo; no edits                                 | `workspace: read` | no                                    | A1 chaining; A7 read-only agent                                 |
| `plan`         | Draft implementation plan → adversarial critique + security → correct → assembled spec | read              | optional (review plan before approve) | Plan phase; A1 chaining                                         |
| `verify-plan`  | Independent check that plan is complete/consistent in a fresh context                  | read-only         | no (feeds gate)                       | A6 evaluator-optimizer; Spec Kit `/analyze`                     |
| `correct-plan` | Fold verify-plan feedback back into the plan; loop until clean                         | canon-write       | no                                    | A6 optimizer half; Spec Kit `/clarify` remediation              |
| `develop`      | Execute the approved plan; write code + tests                                          | write             | no (runs post-gate)                   | Implement phase; A5 orchestrator-workers; A7                    |
| `test`         | Run the runnable check (tests/build/lint); emit pass/fail + evidence                   | write or read     | no (feeds converge loop)              | "Give Claude a check it can run" (Anthropic best-practices); A6 |
| `audit`        | Adversarial diff review in a fresh context; correctness/requirements gaps only         | read-only         | no (feeds converge loop)              | Adversarial-review subagent; A4 voting                          |

3. **Composite workflows compose these via self-nesting:**
   - `build` = `develop` → bounded loop(`test` → `audit` → correct-until-clean)
   - `cycle` = `plan` → [human gate] → `build` → `ship`
   - Future: `full-sdlc` = `investigate` → `plan` → [gate] → `build` → `ship`

4. **State plainly: `spec-creation` as it exists today IS the `plan` workflow.** Its present
   implementation (intake → enrich → critic+security-in-parallel → assemble → gate → persist) is
   exactly the `plan` stage contract above. This proves the decomposition is not speculative.

## Principles

These four principles fall directly from the surveyed primary sources (see
`docs/research/2026-09-04-agentic-dev-workflow-patterns.md` section B and D):

1. **Read is separated from write; the transition is gated by a human.** The first repo-writing
   workflow (`develop`) runs only after the `plan` gate. This is Anthropic's explore-before-code
   discipline and Yoke's Charter rule (ADR-0011).

2. **Verification happens twice, each in a fresh context.** Once on the plan (stage `verify-plan`)
   and once on the code (stage `audit`). A reviewer running in a fresh context sees only the diff
   and the criteria it is given, not the reasoning that produced the change, so it evaluates the
   result on its own terms. The canon's `dependsOn` edges (ADR-0014 §6) scope context to ancestors'
   outputs, which achieves exactly this property.

3. **Correction is a BOUNDED loop with a concrete termination signal.** `build`'s test→audit→correct
   loop ends when tests pass AND audit is clean, mirroring Spec Kit's "repeat until Converged."
   Scope corrections to correctness/requirements gaps, or the loop over-engineers (Anthropic
   best-practices caveat).

4. **Keep the default simple.** Per Anthropic's simplicity-first rule, a one-line change may bypass
   `plan`; over-structuring a trivial fix is an anti-pattern the primary source explicitly names.

## Consequences

**Until four canon primitives are implemented, the library is design, not product. Only `plan` is
runnable today.** The obstacles and their rationale:

1. **Self-nesting execution is the linchpin.** ADR-0012 decision 2 declares the ontology — a future
   step `kind` that references another pipeline id — but no binding executes it. Without it, there
   is no composition, only separate files. Blocker: `src/canon/runStep.ts` and each binding need
   execution support.

2. **Bounded-loop construct does not exist.** The canon is deliberately acyclic (ADR-0014). `build`'s
   test→audit→correct loop cannot be expressed today without a graph cycle. Requires an explicit
   bounded-retry step kind with a max-iteration cap and a pass/fail termination signal — not general
   graph cycles.

3. **`workspace: write` is not implemented.** Only `workspace: read` exists in
   `src/canon/runStep.ts`. Bindings need to support agent execution with repo write permissions.

4. **A `check` / `command` step kind does not exist.** `test` is not an `llm` step; it is a
   structured step that runs a shell command and yields pass/fail. The canon has no such kind.

**Existing `spec-creation` pipeline is the proof.** The migration from `phase:` to `dependsOn:` edges
(ADR-0014) is already done; its executed shape (intake fan-out, `critic` and `security` in parallel
converging on `assemble`) matches the `plan` stage contract above. This verifies the decomposition
against real behavior, not guesswork.

## Alternatives Rejected

- **One monolithic pipeline running the full lifecycle.** This works but sacrifices reuse: `audit`
  could validate any PR, but only runs at the end of the full cycle. `investigate` could be its own
  workflow (e.g., called from chat to understand a folder without building), but is baked into the
  main flow. Spec Kit's stage decomposition and Anthropic's pattern catalogue both treat stages as
  composable, not concatenated. Demoting stages to sub-steps removes that flexibility.

- **Stages as steps within a single pipeline, with optional branching.** The canon is a DAG
  (ADR-0014). Optional stages would require conditional edges (if this variable, skip stage X),
  which ADR-0014 §6 explicitly rejected. Conditional logic in bindings sidesteps the problem but
  forces each binding to re-implement the same conditional rules, breaking Charter rule 3 (canon
  stays neutral).
