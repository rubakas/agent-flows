# 027. Open work and session state

| Field        | Value                       |
| ------------ | --------------------------- |
| Feature Name | Open work and session state |
| Branch       | `027-open-work`             |
| Status       | Living document             |
| Created      | 2026-09-07                  |

This is a handoff record, not a feature spec. It exists so the working context can be cleared without losing what was decided, what was found, and what is still open. Everything below was verified against the tree on 2026-09-07 unless marked otherwise.

## Verified state

| Fact          | Value                                                                                                     |
| ------------- | --------------------------------------------------------------------------------------------------------- |
| Working tree  | Snapshot 2026-09-07. Clean and in sync with `origin/main`. Live: `git status -sb`, `git log --oneline -1` |
| Remote        | `git@github.com:rubakas/agent-flows.git`                                                                  |
| Tests         | 943 total, 942 pass, 0 fail, 1 skipped by design                                                          |
| `pnpm check`  | green (lint, typecheck, format:check, test)                                                               |
| Test duration | ~2.3 s                                                                                                    |
| Specs         | 23 directories under `specs/`                                                                             |

Session start was 612 tests, now 943 total (942 pass, 1 skipped). The local checkout is `/Users/en3e/code/rubakas/agent-flows` and the dogfood sandbox is `/Users/en3e/code/rubakas/agent-flows-sandbox`, both renamed on 2026-09-07 from `yoke` and `newfolder`.

## Running environment

- **Daemon**: pid 21164 (tsx parent), 21171 (node child), port 7411. Runs **base code** from `/Users/en3e/code/rubakas/agent-flows` with `AGENT_FLOWS_PROJECT_DIR=/Users/en3e/code/rubakas/agent-flows-sandbox`. This separation is the owner's explicit instruction: the stable installation is the instrument, the sandbox is the target of development. Do not run the daemon from the sandbox's own code.
- **Sandbox**: `/Users/en3e/code/rubakas/agent-flows-sandbox`, freshly cloned at d8baa27, `pnpm check` green (943 tests), remote `base` only, no `origin`.
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

## 2026-09-13 — code-review finished, provider-portable workspace shipped

Verified against the tree on 2026-09-13; see specs/030-code-review/spec.md and
specs/031-provider-portable-workspace/spec.md for the full verification logs.

**DONE:**

- **Spec 030 code-review.** `PARTIAL` verdict defined, closing the gap where an unguarded case fell to
  it by default (FR-009). Eval expectations split into required `expectations` and four-state
  `conditional` want/forbid keys (FR-010). Every eval run persists step outputs to a run dir and prints
  its path (FR-011). Live run on the change's own diff found a real blocking defect in
  `src/evals/run.ts` that a code review and a security audit had both missed.
- **Spec 031 provider-portable workspace.** `runLlmStep` is dispatch-only over
  `src/canon/adapters/{claude,codex,api}.ts`; supervision moved inside each adapter (non-positive
  `timeoutMs` is clamped for codex/api at the adapter layer; the loader separately rejects any
  non-positive `timeoutMs`, including 0, in pipeline YAML). Codex is confined by a sanitized workspace
  copy (`src/canon/workspace/sanitize.ts`) plus a `-c` permission profile (`codexProfile.ts`), an env
  allowlist, `--ignore-user-config`, and `--skip-git-repo-check`. `checkPortability` runs at run start
  before any model call; `pnpm canon:check` prints the pipeline × profile matrix with no model calls.
  `permissions.allow` was removed (loader now hard-rejects it). The golden Claude argv is
  byte-identical through the extraction (fixture sha1 `193ec7f665c25f230f7f6a4e9db77d6c07d8cfc2`).
- **`code-review-citations` eval passes end to end under anthropic and under
  `AGENT_FLOWS_PROVIDER=openai`/codex** (EVAL PASSED, verdictAccuracy 100%, misrouted 0 on both; see the
  spec 030 verification log and spec 031 V6) — proves the pipeline is provider-portable, not just
  Claude-shaped.
- **Proven facts worth keeping:** `codex exec -s read-only` does **not** confine reads, only
  writes/network; a `[permissions.<name>]` profile passed via `-c` does confine reads, at kernel level;
  a `deny` entry on `/` aborts the sandboxed process (SIGABRT); `sandbox_permissions` is a confirmed
  no-op in codex 0.152.1.

**DONE (later the same day):**

- **Spec 032 project state location** — implemented (commit 004ffe4 plus a follow-up fix round):
  machine-local state under `${AGENT_FLOWS_HOME ?? ~/.agent-flows}/projects/<key>/` (runs, manifests,
  `agent-flows.sqlite`, `agent-flows-mastra.db`, project `n8n.json`); canon stays in
  `<project>/.agent-flows/`; key = escaped realpath (+ 8-hex sha256 suffix beyond 200 chars),
  `AGENT_FLOWS_PROJECT_KEY` override; legacy `<project>/.agent-flows/runs` copied once via
  `runs.partial` + rename, never deleted; the runtime no longer edits the project's `.gitignore`;
  `scripts/install.sh` now exports `AGENT_FLOWS_PROJECT_DIR`; `ServeOptions.state` is required so
  tests cannot fall through to the real home. Verified live: daemon run on a temp project wrote
  artifact + manifest under the state dir and left the project untouched.
- **Spec 033 run control** — implemented: `RunService.cancel` (Mastra `run.cancel()` + per-run
  `abortSignal` forwarded from each step's execute context into runner deps; `BuildDeps.runnerDeps`
  never carries a per-run signal), new `cancelled` terminal status everywhere,
  `POST /api/runs/:id/cancel` (204/409/404), MCP `cancel_run`, `get_run` now returns per-step `steps`
  with `startedAt/finishedAt/error`, UI Cancel button, `runCheckStep` honours the signal without a
  deadline and kills the process group (detached spawn), daemon honours `AGENT_FLOWS_PORT` with
  `--port` overriding and prints a clear EADDRINUSE message, bounded MCP poll
  (`AGENT_FLOWS_POLL_MAX_MS`). Verified live: a `sleep 60 & wait` check step cancelled in ~2 s, no
  survivors, artifact and manifest stage record `cancelled`/`cancelledAt`/`reason`. Found only by the
  live run and fixed: a late Mastra result event resurrecting a cancelled step to "succeeded"; the
  chain manifest's overall status not knowing `cancelled`.
- **n8n, checked in the browser 2026-09-13**: n8n shows per-node progress for workflows it executes
  (canvas ticks, item counts, Executions list), but the agent node spawns the `claude` CLI directly
  and never talks to the daemon, so those executions are invisible to `get_run` and bypass the
  adapters/confinement; every pipeline with a `check` step is unrunnable there ("Unrecognized node
  type: n8n-nodes-base.executeCommand"); 12 workflows are pushed, some duplicated.

**OPEN — owner decisions needed:**

1. Binding A (`src/bindings/claudeCode.ts`, `.claude/workflows/*.js`): its generated scripts bypass
   step permissions by their own header, and it is the only daemon-free entry point. Delete it after
   adding daemon auto-start to the MCP `run_pipeline` tool, or keep it as a documented,
   non-guaranteed export? **Recommendation: delete after adding daemon auto-start.**
2. Binding C (n8n): deleting it would contradict ADR-0013's supersession and a live daemon route
   (`src/serve/routes/n8n.ts`). **Recommendation: write an ADR before any change** — do not delete
   without one.
3. Collapsing `assemble-spec` / `persist-ticket` / `export-spec`: `persist-ticket` re-asserts a gate
   key on its own unique key (`buildSteps.ts` ~:412-424), so it is not a pure rename.
   **Recommendation: only worth a spec of its own, not a quick refactor.**
4. n8n as an executor needs an ADR: either the agent node calls the daemon (`POST /api/runs`) so runs
   are observable and confined, or n8n stays authoring-only; `check` steps need a node the instance
   actually has.

**OPEN — follow-ups, no decision needed, ordered by value:**

- `contents: write` on codex: an `extends=":workspace"` profile on a writable copy, with diff-back.
- An api-transport tool loop (Mastra-native Read/Glob/Grep with in-process deny) so ollama/litellm can
  run repo-grounded steps; until then the `local` profile is refused for every pipeline declaring
  `contents`.
- Container adapter (ADR-0007) as the provider-agnostic boundary for any CLI agent.
- Research doc items T1–T5 (`docs/research/2026-09-13-openai-agents-platform-vs-agent-flows.md` §3):
  failure-code enum, pending actions on the run resource, network policy on check steps, versioned
  artifacts, run-level budget.
- `AGENT_FLOWS_LIVE_TESTS=1` runs the codex preflight test (one model call) — run it in the
  pre-release check; it is the only assertion that catches a codex CLI preflight change.
- `src/canon/runStep.test.ts`'s `repoRoot` points at the repo's parent (pre-existing quirk).
- D3 from spec 030: `build.yaml` still mounts `audit` with `plan: plan` (post-build review re-audits
  the spec, not the code); wiring code-review into build/cycle forces new inputs onto those pipelines.
- The two 2026-09-03 bugs (prompt path containment in `load.ts`; `models` override passthrough) —
  verify whether still open.
- `.n8n-workflows/` export covers 8 of 12 pipelines; regenerate or document why.
- `agent-flows where` CLI verb (print project dir, state dir, db path, port).
- Retention/pruning for `~/.agent-flows/projects/<key>/runs`.
- Worktree-shared key option (`git rev-parse --git-common-dir`).
- The daemon started earlier on this machine (pid from `pgrep -f "serve/server"`) was launched with
  `--db` pointing at a scratchpad sqlite; restart it plainly before real use.

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

## 2026-09-14 — web page

Spec 033 amendment plus spec 034, all committed; 1361 tests green.

**DONE:** Run details (Attach → Details) header shows workflow name + run id, with a "How it was
run" panel (chat call and curl); per-step prompt/command/model recorded via
`src/runtime/stepIntrospection.ts` keyed on Mastra's execute-context `runId`, read-through in
`RunService.get()`, persisted in the artifact; `get_run` returns invocation + model/command, never
prompts. Page split into hash-routed views (`src/serve/ui-route.js`): Runs, run view, Workflows,
Templates, Settings; split layout ≥1200px for Runs and Settings. `GET /api/runs` lists persisted
runs from `<stateDir>/runs/*` after a restart; `GET /api/runs/:id` opens them from the artifact;
cancel/approve return 409; proven by a restart test. n8n runtime card: `GET /api/n8n/runtime`
(`/healthz` probe, 2 s timeout, no credentials sent), `POST /api/n8n/start`/`stop` (detached
npx/PATH launch, `n8n.pid` 0600, only kills our own owned pid), Connect prefill opens
`<baseUrl>/settings/api` — the key is still pasted once by the owner. Security review: XSS surface
closed (escaped or `textContent`), artifact paths 0700/0600 and containment-checked, n8n base URL
validated and scheme-checked before `window.open`.

**ACCEPTED RISK:** the loopback API serves prompts/inputs to any local process without auth,
accepted on a single-user 0700-state-dir machine; a token would not stop a same-user process.

**OPEN:** V3/V8 visual pass is the owner's (extension can't render an open event stream); a
"Run…" form on workflow rows; n8n-through-daemon still needs the 2026-09-13 ADR; the `projectState`
review's 7 minors are all fixed, none outstanding (2ae2140).

## 2026-09-14 — n8n retired

ADR-0017 retires the n8n hybrid. The daemon is the only executor and the daemon's page is the
editor (spec 037). This closes every open n8n item recorded above; nothing above is deleted, it is
the record of how the decision was reached.

- **Line 118-125, "Binding C (n8n)" and "n8n as an executor needs an ADR":** closed. The ADR was
  written (ADR-0017) and the answer is neither branch — `src/bindings/n8n/`, `src/serve/routes/n8n.ts`,
  `src/serve/routes/n8nRuntime.ts`, every `/api/n8n/*` route, `POST /api/pipelines/:id/n8n`,
  `POST /api/templates/from-n8n`, the `generate n8n` CLI target and the `bindings:n8n` script are
  deleted. `src/serve/no-n8n.test.ts` keeps them deleted.
- **Line 145, "`.n8n-workflows/` export covers 8 of 12 pipelines":** closed, not fixed. The partial
  coverage is one of ADR-0017's reasons; the export is gone and `.n8n-workflows/` is dead output the
  owner can delete.
- **Line 167, "n8n is where new workflows are authored":** superseded. The page is the authoring
  surface — spec 037 D3/D4/D6, shipping in Ships 2 and 3.
- **Lines 203-214, the runtime card and "n8n-through-daemon still needs the 2026-09-13 ADR":** the
  card and its routes are deleted; the ADR is written; spec 035 is Withdrawn.
- **Leftovers on this machine:** `~/.agent-flows/n8n.json` and `<stateDir>/n8n.json` hold a base URL
  and an API key that nothing reads any more. Deleting them is the owner's call (ADR-0017).

## 2026-09-14 — step logs, developer page

**State:** spec 036 is Implemented (backend add6e2d..5f9e933, review fixes 878a495; page half via
037 Ship 1b). Spec 037 Ships 1a (6fe091b, 3230ddd, c8428f3), 1b (989c3f8, 350796b, a1424a3, 607eb53),
2 (4fe9279, a56462a, 8fce0a7, 0dd41ec), 3 (d9c4545, 7fb6ff8, a67e924, guard 35f4415) are merged; Ship
4 (restyle) is in progress on 2026-09-14 and its commits are listed in spec 037's Delivery section
when it lands. Tests: 1379 before Ship 4. n8n retired (ADR-0017). Daemon on 7411 restarted from HEAD
after each ship.

**OPEN — owner decisions needed:**

- **Usage/session limits.** The `build` run's implement step was cut off by the subscription window
  after finishing every file; the daemon reported only "claude exited with code 1" (fixed: the reason
  is now carried) and treated it as a failure. Decide whether a limit becomes a distinct `blocked`
  state with the reset time, and whether `build` gets a resume/continue input instead of restarting
  `develop.implement` on a dirty tree.
- **Binding A.** `saveDraftAndRegenerate` now has no production caller (save must not regenerate —
  spec 037 D6; the generator built its output path from `def.id` and emitted YAML strings into JS,
  both hardened in d9c4545). Decide whether Binding A stays as a CLI export, and whether
  `agent-flows generate claude` should refuse pipelines it cannot express instead of erroring per
  step.
- **Claude CLI `--allowedTools` in print mode gates nothing** (probe 2026-09-14 inside a Claude Code
  session; re-run from a plain terminal before changing the golden argv).
- **`{{checkCommand}}` is build-time only** (`config.json` or the default gate); a run input named
  `checkCommand` is inert by design (`buildSteps.test.ts:194-219`). Spec 032 V5's evidence proved
  nothing about inputs. Decide whether a per-run check command is wanted (it would need a validated
  route field, never the workflow context).
- **`POST /api/drafts/:id/preview` stays usable against the bundled catalogue** (read-only); the
  bundled-mode guard expression is repeated at eight sites in `server.ts` — extract when next
  touched.
- **The Claude-in-Chrome extension cannot capture the page** (`document_idle` never reached, cause
  unknown, not the poller); the owner's visual pass is the gate for 034/036/037 (request file:
  scratchpad `visual-pass-request.md` from Ship 4).

**Follow-ups (not decisions):**

- Block-form step editing on top of the YAML tab (037 follow-up).
- `/api/models` per-profile list for the Run… dialog.
- Log retention/rotation.
- Codex `reasoning`/`mcp_tool_call` item shapes.
- Hard links inside `prompts/` undetected.
- Shell-expansion in command tokens not matched by the deny guard.
- `src/runtime/artifact.test.ts` two import-order warnings.
- `pnpm -s prettier` vs `./node_modules/.bin/prettier` disagreement seen once — always use the local
  binary.
- Leftover `~/.agent-flows/n8n.json` and `<stateDir>/n8n.json` files (ADR-0017 says safe to delete).

## Immediate next steps

1. Implement spec 026, starting with cancellation (FR-001 … FR-007) — it is the largest control gap.
2. Re-run the two audits listed above.
