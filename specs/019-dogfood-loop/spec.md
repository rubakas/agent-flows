# 019. Dogfood loop

| Field        | Value              |
| ------------ | ------------------ |
| Feature Name | Dogfood loop       |
| Branch       | `019-dogfood-loop` |
| Status       | Draft              |
| Created      | 2026-09-07         |

## Question

The tool automates a software-development lifecycle, but its own defects only surface when it runs against **real code with real specs**. A live run today against a throwaway 50-line scaffold proved the point: `investigate` ran and its output was discarded (now fixed), the resulting spec was ungrounded, `develop.implement` correctly refused to execute it, the test suite stayed green because nothing changed, and the run therefore reported `status: success` while implementing nothing. `build`, `converge`, and `review` were never meaningfully exercised.

How can the tool develop the tool itself, under supervision, so that every lifecycle stage is exercised on real requirements and all step outputs are observable?

## Evidence

The scaffolding-based testing approach (small synthetic requests) does not catch composition defects. The `spec-creation` pipeline, the `develop` phase, and the `build-round` loop have all been audited and tested individually — each works in isolation. But the _assembly_ of a cycle from these pieces, running against a real spec file with the full plan-develop-build-review spine, has not been validated against defects in cross-step coordination, context threading, or step-output consumption. A sandbox environment where agent-flows develops specs from the agent-flows codebase itself, with every step's output captured and each diff graded before porting to the real repository, closes that gap.

## Verdict

**IMPLEMENT** — add a supervised dogfood loop that:

1. Clones the real repository into an isolated sandbox.
2. Runs a complete cycle (plan→develop→build→review) against a real spec.
3. Captures all step outputs for inspection.
4. Grades the resulting diff against an explicit rubric.
5. Ports the diff to the real repository only after grading passes and re-verification succeeds.

## Design

### Overview

A **supervised cycle** runs in the background against a sandbox copy of the agent-flows repository. Each run is seeded with a real spec file (e.g., `specs/016-provider-profiles/spec.md`). Every step's output is captured to a file and accessible via the run's accumulated context. After the cycle completes, a human operator reads the diff, grades it against a rubric, and decides whether to port it to the real repository.

### Functional Requirements

| ID     | Requirement                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FR-001 | The sandbox is a git clone of the base repository at `/Users/en3e/code/rubakas/agent-flows-sandbox`, which carries full `.git` history (so `git status --porcelain` and `git diff` work inside it), with dependencies installed by `pnpm install` under node 22, plus the gitignored local file `docs/agent-flows-harness-research-and-design.md` copied in by hand.                                                 |
| FR-002 | The sandbox has no `origin` remote, so nothing in it can reach GitHub; its single remote `base` points at the local base checkout and exists only so the sandbox can be re-synced. The `ship` stage's `approve` gate is `manualOnly: true`, so a commit or pull request never happens without the owner answering. The `ship` stage's `pr` step refuses to run on `main`, and a freshly cloned sandbox is on `main`. |
| FR-003 | The daemon runs from the real repository as its working directory with `AGENT_FLOWS_PROJECT_DIR` pointing at the sandbox, so the canon under test is the real one and every write lands in the sandbox.                                                                                                                                                                                                              |
| FR-004 | The task given to a cycle is a real spec already on disk (the first is `specs/016-provider-profiles/spec.md`), not a synthetic prompt.                                                                                                                                                                                                                                                                               |
| FR-005 | Every step is observable while the run is in flight and after it: the SSE stream at `GET /api/runs/:id/events` is captured to a file, and after completion `GET /api/runs/:id` returns `result` — the full accumulated context keyed by step id, so each step's output is inspectable.                                                                                                                               |
| FR-006 | The sandbox is re-cloned from the real repository before each run, so runs never compound on each other.                                                                                                                                                                                                                                                                                                             |
| FR-007 | A diff produced in the sandbox is ported to the real repository only after it passes the grading rubric below, and is re-verified in the real repository before being committed.                                                                                                                                                                                                                                     |

### Grading Rubric

A sandbox diff is accepted only when ALL of these hold, each checked explicitly:

1. **Spec Coverage** — Every FR in the driving spec is implemented. Enumerate all FRs and mark each as ✓ or ✗.
2. **Test Quality** — Tests were added that fail without the change, and the full test suite (`pnpm test`) is green.
3. **Linting and Correctness** — `pnpm lint`, `pnpm typecheck`, and `pnpm canon:check` are clean (no errors or warnings).
4. **Scope** — No changes beyond the driving spec. Anything extra is reported, not silently kept.
5. **No AI Attribution** — No "Generated by", "Co-Authored-By", model names, robot emoji, or AI-tool signatures in code, comments, docs, or commit text.
6. **No Test Degradation** — No existing test is weakened, skipped (`skip`, `xit`), or deleted to achieve green.

### Procedure

1. **Reset Sandbox** — Delete `/Users/en3e/code/rubakas/agent-flows-sandbox` if present; `git clone /Users/en3e/code/rubakas/agent-flows /Users/en3e/code/rubakas/agent-flows-sandbox`; `git remote rename origin base` so the sandbox's only remote is `base` pointing at the local base checkout and there is **no `origin`**, which prevents a dogfood run from reaching GitHub; copy the gitignored `docs/agent-flows-harness-research-and-design.md` in; then `pnpm install` under node 22.
2. **Start Daemon** — Run the daemon from the real repository with `AGENT_FLOWS_PROJECT_DIR=/Users/en3e/code/rubakas/agent-flows-sandbox`.
3. **Create Run** — POST to `/api/runs` with the spec file path (e.g., `specs/016-provider-profiles/spec.md`) as the input request. This seeds the `cycle-dev` pipeline, which runs the plan→develop→build→review chain described in the overview; the full `cycle` pipeline adds a `ship` stage that commits and opens pull requests, which is outside the dogfood loop.
4. **Capture SSE Stream** — While the run is in flight, subscribe to `GET /api/runs/:id/events` and save all events to a file (e.g., `/tmp/run-<id>-events.jsonl`).
5. **Inspect Step Output** — As each step lands in the SSE stream, read its output from the accumulated context (via `GET /api/runs/:id`) and verify it is sensible (not empty, not erroneous).
6. **Monitor for Completion** — When `GET /api/runs/:id` returns a terminal status, the run is done.
7. **Read Accumulated Context** — Fetch `GET /api/runs/:id` and extract `result` — the full step-by-step output, keyed by step id.
8. **Compute Sandbox Diff** — In the sandbox, run `git diff --no-index /dev/null /dev/null > /tmp/run-<id>-diff.patch` (or equivalent) to capture all file changes.
9. **Grade Against Rubric** — For each rubric criterion, check the diff:
   - Enumerate FRs from the driving spec in the diff; mark ✓/✗.
   - Run `pnpm test`, `pnpm lint`, `pnpm typecheck`, `pnpm canon:check` in the sandbox; verify green.
   - Scan the diff for scope creep.
   - Scan commit text and code for AI attribution; flag and reject if present.
   - Verify no test is weakened or deleted.
10. **Reject or Approve** — If any rubric criterion fails, reject and report the failure to the operator. If all pass, approve.
11. **Port to Real Repo** — If approved, apply the diff to the real repository using `git apply /tmp/run-<id>-diff.patch` or equivalent.
12. **Re-Verify in Real Repo** — In the real repository, re-run `pnpm test`, `pnpm lint`, `pnpm typecheck`, and `pnpm canon:check` to confirm the same green state in the real repository.
13. **Commit** — Create a commit with the standard format (`#<ticket> type(scope): description`) and push.

## Why sandbox isolation

The sandbox isolation prevents:

- Accidental commits or pushes to the real repository (remote is removed).
- Compound failures from successive runs (sandbox is re-copied each time).
- Unvetted diffs landing in the real codebase (grading gate before port).
- Observations of the cycle being masked by concurrent changes in the real repository (canon under test is the real one, writes land in the sandbox).

## Out of scope

- **ship** — No commit and no PR is ever made directly from a sandbox run; all work is ported to the real repo and verified there before committing.
- **Automating the grading** — A human-supervised read of the diff against the rubric is the point of this loop, not automation of the judgment.
- **Concurrent cycles** — Running more than one sandbox cycle concurrently against the same sandbox is not supported. Runs are sequential.

## Test plan

A reader proves the loop itself works by verifying:

1. **Sandbox initialization** — After reset, verify: (a) `git -C /Users/en3e/code/rubakas/agent-flows-sandbox rev-parse HEAD` equals `git -C /Users/en3e/code/rubakas/agent-flows rev-parse HEAD`; (b) `git remote -v` in the sandbox lists only `base` and no `origin`; (c) `git status --porcelain` in the sandbox is empty; (d) `pnpm check` in the sandbox is green with the same test count as base.
2. **Sandbox isolation** — A run writes files to the sandbox and nowhere in the real repository. Verify: after completion, `git status --porcelain` in the sandbox shows all changes; `git status --porcelain` in the real repository shows no changes.
3. **SSE completeness** — The captured SSE trace lists every expected step id from the spec. Verify: extract all `step_id` values from the events file and compare against the spec's step graph; all must be present.
4. **Context accumulation** — The accumulated context at `GET /api/runs/:id` contains a key per step, with non-empty output. Verify: for each step id, `result[step_id]` is present and is not null or empty string.
