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

**The library is runnable.** Two canon primitives are implemented, one obstacle is resolved, and two
labeled "primitives" are not:

1. **Self-nesting execution — implemented.** Load-time expansion (commit `1ea9c5b`, `src/canon/nest.ts`)
   splices `kind: "pipeline"` steps into the parent step list with namespaced ids and rewired `dependsOn`
   edges. No binding changes required.

2. **Bounded-loop construct — implemented.** `kind: "loop"` with `maxIterations` and `until` (commit
   `d872114`) executes via Mastra's `.dountil()` as a child workflow. Body expansion is deferred to
   runtime (not load-time) to preserve the loop boundary.

3. **Single-gate limit — resolved.** `RunService` (commit `256aed3`) was hardcoding the approve step
   name; self-nesting exposed the bug. Multiple gates per run are now supported.

4. **`workspace: write` — not a new primitive.** It is one line: widen `extraArgs` in
   `src/canon/runStep.ts` from `"Read,Glob"` to `"Read,Glob,Edit,Write"`, and change the
   `workspace?:` type in `src/canon/types.ts` to `"read" | "write"`. Directory plumbing and
   permission handling already support both modes (see `docs/research/2026-09-05-existing-capabilities-vs-new-primitives.md` Question 1).

**The `check` step kind: justified, not required.** The loop can close today with an `llm` step,
structured output schema `{passed, output}`, and an `until:` condition — no new kind needed. But the
research audit shows a trust issue: when Bash denies a command, the model fabricates an exit code to
satisfy the schema, not report the denial. A loop can converge on a well-formed lie (see
`docs/research/2026-09-05-existing-capabilities-vs-new-primitives.md` Question 2, TEST C). A `check`
kind (~15 lines) grounds termination in the actual process exit code, not the model's report.
Justified on _determinism and trust_, not capability gap.

**Existing workflows validate the decomposition.** The `spec-creation` pipeline instantiates the
`plan` stage: intake fan-out, critic + security in parallel, assemble, persist. Its execution
matches the plan stage contract above.

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
