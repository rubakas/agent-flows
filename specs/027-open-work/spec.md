# 027. Open work and session state

| Field        | Value                       |
| ------------ | --------------------------- |
| Feature Name | Open work and session state |
| Branch       | `027-open-work`             |
| Status       | Living document             |
| Created      | 2026-09-07                  |

This is a handoff record, not a feature spec. It exists so the working context can be cleared without losing what was decided, what was found, and what is still open. Everything below was verified against the tree on 2026-09-07 unless marked otherwise.

## Verified state

| Fact          | Value                                                                                      |
| ------------- | ------------------------------------------------------------------------------------------ |
| HEAD          | `5f7790d test(security): pin deny-list contents, traversal guards and gate rejection`      |
| Unpushed      | 119 commits ahead of `origin/main` — **nothing has been pushed; that is the owner's call** |
| Remote        | `git@github.com:rubakas/agent-flows.git`                                                   |
| Tests         | 943 total, 942 pass, 0 fail, 1 skipped by design                                           |
| `pnpm check`  | green (lint, typecheck, format:check, test)                                                |
| Test duration | ~2.3 s                                                                                     |
| Specs         | 23 directories under `specs/`                                                              |

Session start was 612 tests. The local checkout directory is still named `yoke`; the project and its remote are `agent-flows`. Two spec files deliberately keep the literal path `/Users/en3e/code/rubakas/yoke` because it is real — `specs/017-investigation-wiring/spec.md:34` and `specs/019-dogfood-loop/spec.md:99`. **They must be updated when the directory is renamed.**

## Running environment

- **Daemon**: pid 94777, port 7411. Runs **base code** from `/Users/en3e/code/rubakas/yoke` with `AGENT_FLOWS_PROJECT_DIR=/Users/en3e/code/rubakas/newfolder`. This separation is the owner's explicit instruction: the stable installation is the instrument, the sandbox is the target of development. Do not run the daemon from the sandbox's own code.
- **Sandbox**: `/Users/en3e/code/rubakas/newfolder`, synced to base, clean.
- **n8n**: the owner's instance on port 5678. Not configured in agent-flows — `~/.agent-flows/n8n.json` does not exist, so `GET /api/n8n/status` returns `{"configured":false}` and the redirect buttons are inert. Enabling it requires an API key **the owner enters themselves**; never read, log, or store its value.
- **LiteLLM**: unreachable on port 4000 (`pnpm doctor` reports it as a warning, not a failure).
- Browser tabs the owner watches: `localhost:7411` (our UI) and `localhost:5678` (n8n).

## Specs written but not implemented

| Spec | Subject                                  | State                                                                         |
| ---- | ---------------------------------------- | ----------------------------------------------------------------------------- |
| 026  | Run visibility, cancellation, onboarding | **Nothing implemented.** Highest value: there is no way to stop a run at all. |

Specs 016, 020, 021, 022, 023, 024, 025 are implemented. Specs 001–015 describe earlier designs, some superseded.

## Known defects found and NOT fixed

Ranked by consequence. Each was verified; none is speculative.

1. **No way to stop a run.** No cancel path exists anywhere — a runaway run ends only when the daemon dies. Spec 026 FR-001 through FR-007 designs the fix on top of the abort chain that already exists at step level.
2. **`runClaudeCli`'s operator-abort sends SIGTERM with no SIGKILL escalation** (`src/canon/runClaudeCli.ts` around :386), unlike the watchdog path which escalates (`:291-292`). A child ignoring SIGTERM would survive a future stop button. Spec 026 FR-004.
3. **n8n executions are invisible** to our UI. No reference to n8n's executions API exists in `src/`. Spec 026 FR-008/FR-009 designs poll-and-deep-link, explicitly **without** stop parity — there is no public stop endpoint to call.
4. **`RunService.approve(runId, approved)` has no `reason` parameter**, so a human rejection carries no explanation into `gateDecisions`. Found when a test could not assert reason threading. Spec 026 FR-005 territory.
5. **Binding C does not implement 3 step kinds** — `TODO(binding-c)` markers remain in `src/bindings/n8n/build.ts` for loop, assemble-spec and related. Consequence: `cycle`, `cycle-dev` and `spec-creation` refuse to export to n8n. This is correct behaviour (loud refusal), but it means n8n cannot host the main workflows.
6. **Binding A implements only `llm` and `assemble-spec`.** It now refuses everything else loudly and 7 generated workflows were deleted; 4 survive (`audit`, `correct-plan`, `develop`, `investigate`). Its generated scripts carry a banner saying per-step `permissions` are NOT enforced — the Claude Code workflow `agent()` API has no permission option (verified: the CLI is a native binary with no inspectable type declarations).
7. **Cost is invisible.** `total_cost_usd` arrives in every `result` event (a trivial 2-turn probe measured $0.0546) and is not surfaced anywhere. The owner cannot see what a run cost.
8. **Runs do not survive a daemon restart** — in-process registry, intended per spec 020 FR-008. Completed-run history is lost on restart.

## Audits in flight when context was cleared

Two read-only audits were dispatched and their results may be lost:

- **Spec-to-code drift** across all 26 specs — status honesty, false factual claims, contradictions between specs. Motivated by two stale claims already caught by accident (spec 025's Context §4 wrongly asserted `GET /api/runs` did not exist).
- **Billable and unbounded paths** — which developer commands can reach a real model, network, or git; what bounds each blocking path; whether cost is captured; whether the run registry, step outputs or SSE subscribers are ever released; whether concurrent runs are limited.

**Both are worth re-running.** Neither should ever need write permission or the ability to run anything billable; if an agent asks for that, it has overstepped.

## Decisions the owner made — do not re-litigate

- **`ship` is always manual.** `pipelines/ship.yaml` declares `manualOnly: true`; run-level `gateMode: "auto"` does not override it. Accepted consequence: an unattended auto run halts at `ship` forever. That is intended.
- **Gate modes are a branch, not a skip.** Manual waits for the human; auto has an **independent agent** evaluate and answer in the human's place. Auto is never "auto-approve".
- **Trust boundary stays where it is.** A project-supplied `checkCommand` is executed as a shell command; the owner reviewed this and declined a confirmation prompt, because the tool already executes repo-controlled scripts by design (`pnpm test` runs the target repo's own `package.json`). Gating only `checkCommand` would be theatre.
- **No duration limits on steps.** A local model may legitimately run for hours. Liveness is guarded by the watchdog (stdout silence, tool-call repetition), never by a wall-clock deadline. Any reintroduced default deadline is a regression.
- **Surface division**: our UI is the inventory and monitor; **n8n is where new workflows are authored**; the edit button redirects there; a finished n8n workflow can be saved back into global templates. The UI's old canvas editor was removed for this reason — do not restore it.
- **No AI attribution anywhere** — commits, code comments, docs, PR bodies. This overrides any harness default.

## Standing working rules that produced today's results

- **Spec before every action.** The spec is the truth; implement against it, then grade the diff against it.
- **A gate must be able to fail, and that must be proven by mutation** — break the implementation, observe RED, restore, observe GREEN. Every claim not verified this way turned out at least partly false today. Two green checks were found that could not turn red; one of them was guarding another.
- **Hunt the signature defect**: a field declared in the canon and silently dropped by a binding. Found at least ten times.
- **Ask whether the artifact does what it says about itself.** `ship.js` advertised "commit and open a pull request" in its own metadata and contained three comments.

## The self-improvement loop

The owner named this the mechanism: ask these questions, implement what they find.

1. What would make this check fail? If nothing, the gate is broken.
2. Does this binding honour what the canon declares, or silently drop it?
3. Is this field declared **and** read, end to end?
4. Does the documentation match observed behaviour, or only claimed behaviour?
5. Is our gate weaker than the project's real gate?
6. Did a later change silently delete an earlier one?
7. Does this artifact do what it says about itself?
8. Can the user see it, and can the user stop it?

Questions 1, 2, 3 and 7 each found real defects today. Question 8 is what spec 026 exists to answer.

## Immediate next steps

1. Implement spec 026, starting with cancellation (FR-001 … FR-007) — it is the largest control gap.
2. Re-run the two audits listed above.
3. Decide on pushing 119 commits to `origin/main`.
4. Rename the local checkout to `agent-flows` and update the two spec files that cite the real path.
