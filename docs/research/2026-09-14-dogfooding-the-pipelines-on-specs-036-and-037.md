# Dogfooding the pipelines on specs 036 and 037

Research date: 2026-09-14 · The owner asked to use agent-flows' own pipelines — `decide_entry_point`,
`investigate`, `audit`, `correct-plan`, `build`, `test`, `code-review` — while building spec 036 (step
logs and decisions) and spec 037 (developer page), so real use would produce test results rather than
a synthetic exercise. This note reads the resulting session log,
`scratchpad/dogfood-036.md` (full path in §Sources), the only source. Each finding states what was
run (probe), what happened (observation), and the log's own assessment (verdict).

---

## 1. `decide_entry_point` routing

- **Probe:** a free-text request for per-step logs and decisions was fed to `decide_entry_point`.
- **Observation:** it routed to `investigate`, with reason string "free text routes to formulation as
  the conservative default".
- **Verdict:** OK — correct choice; the reason string is honest about being a default, not an
  inference.

## 2. The `investigate` run (`eddb9594-97f0-4273-9b62-fa75f5dbcd52`)

- **Probe:** `MCP run_pipeline {pipeline: investigate, inputs: {request}}`; the MCP call moved to
  background after 120 s (harness) and completed via notification.
- **Observation:** two steps, survey (haiku, 1 m 59 s) → findings (haiku, 38 s), total 2 m 37 s,
  succeeded; artifact `investigate.json` written under the project state dir. Mostly consistent with
  an independent explorer pass; it found the artifact-dir computation (`runService.ts:1283-1286`) that
  the explorer had missed. Gaps: the survey claimed "no dedicated SSE test visible" when
  `server.test.ts:489` has one — it read a bounded range and generalised; run-detail steps are an
  object keyed by id, not an array (page and MCP both cope); while the run was live there was no run
  directory on disk at all (artifact written only at settle) — exactly what spec 036 D1 fixes by
  creating the dir at start; the live "findings" step showed only status/startedAt, the black box 036
  addresses; `outputTruncated=true` on survey, full text only in `result` after success (036 D6).
- **Verdict:** PASS as a pipeline; the report was useful as spec input (8 open questions, all
  answerable).

## 3. Why `spec-creation` was not used

- **Probe:** `spec-creation` was considered for spec 036 before falling back to `audit`.
- **Observation:** the intake prompt forces "3-7 requirement bullets," which would flatten a detailed
  design; the pipeline is a feature-request hardener, not a design reviewer. `audit` (plan →
  correctness + security → synthesis, with repo read access) was judged the fit and used instead (§4).
- **Verdict:** deliberate substitution, not a defect — `spec-creation` stays scoped to feature
  requests; `audit` covers design review.

## 4. The `audit` run on spec 036 (`7b909ee8-20a3-4c3e-856e-a41f34aeed4c`)

- **Probe:** `POST /api/runs {pipeline: audit, inputs: {plan: <spec text 20.9 KB>}}`, started via curl
  because `MCP run_pipeline` blocks the turn for 120 s; curl + poll loop was judged the ergonomic path
  from a session.
- **Observation:** succeeded in 8 m 37 s — correctness (sonnet, 7 m 58 s), security (sonnet, 5 m 56 s),
  synthesis (opus, 39 s). 2 blocking, 4 major, 4 minor findings, all judged real. Two blocking findings
  were already covered by the draft checklist (types in canon leaf; sink stamps `pipelineId`); the
  rest changed the spec: env-secret scrub for `check.output`, an escaping rule with testable render
  helpers, builder-owned `step.start`/`step.result` plus an adapter `usage` kind, late decision append
  after close, per-run caps, an absolute-path deny test, and an allowlist note. Findings cited
  `file:line` matching the explorer's facts; synthesis accounted for every finding and dropped none.
- **Verdict:** PASS — the audit pipeline is the right tool for reviewing a design; it replaced what
  would otherwise have been a `devil` dispatch.

## 5. The `correct-plan` run on spec 036

- **Probe:** `POST /api/runs {pipeline: correct-plan, inputs: {plan: spec, findings: directives + audit
synthesis}}` (run id recorded in `scratchpad/correct-plan-036-runid`).
- **Observation:** succeeded — revise step (opus), 60 s; output 34.3 KB vs. 23.8 KB input; structure
  preserved; every directive applied; it also added grounded facts of its own (close-handler reject
  lines, `buildCheckEnv`, `denyMatch` normalize) plus V5 renderer tests and a builder-level test; no
  rejections. Accepted verbatim as the spec, committed as `e06ae03`.
- **Verdict:** PASS — `correct-plan` is usable as the spec editor when the lead supplies resolution
  directives.

## 6. The `build` run on plan 036-A (backend)

- **Probe:** `POST /api/runs {pipeline: build, inputs: {plan: checklist (points at the spec),
checkCommand: "pnpm check"}, models: {"develop.implement": "opus"}}` (run id in
  `scratchpad/build-036-A-runid`); tree clean at `c8a8739` before start.
- **Observation:** FAILED at `develop.implement` after 12 min (01:31→01:43, opus). The step had
  already written every checklist file (15 modified + 4 new) when the claude CLI exited 1. The daemon
  error was "claude exited with code 1" with empty stderr — the reason was lost at that layer, and
  recovered only from the step's own transcript (`~/.claude/projects/<key>/902a093f….jsonl`): "You've
  hit your session limit · resets 3:10am (Europe/Kiev)." `converge`/`review` never ran. Partial tree:
  `pnpm lint` 0 errors (7 import-order warnings), `tsc --noEmit` clean, prettier failed on 2 files,
  tests not reached (`format:check` runs first).
- **Verdict:** PARTIAL — the pipeline did real, typed, lint-clean work at scale; the failure was
  external (a session/usage limit), but the reporting of it was the defect. Three findings for the
  tool: (1) on a non-zero exit, the close handler must carry the last `result` event's subtype/text
  into the error — folded into plan A as item D; (2) a usage/session limit is recoverable and should
  surface as a distinct blocked state with the reset time, not a plain failure (027 follow-up); (3)
  `build` has no resume — a second run restarts `develop.implement` from scratch on a dirty tree (027
  follow-up: resume from a partial tree or a "continue" input). Fallback: a coder finished the
  checklist by hand; `code-review` was scheduled for once the window reopened (03:10).

## 7. Coder finish and the mutation ledger

- **Probe:** a coder finished plan A on the partial tree left by the failed `build` run.
- **Observation:** the pipeline's implement step had already done all 14 checklist items; the coder
  added formatting, import order, the non-zero-exit message (item D), and one test. `pnpm check`: 1409
  tests, 0 failures (verified directly). The mutation ledger returned 2 red mutants and 1
  unfalsifiable one — the leading-slash retry branch was found to be dead code, since `**/` globs
  already match absolute paths — so that branch was removed and spec item D8 amended.
- **Verdict:** the checklist was completed correctly, and the mutation ledger caught one over-broad
  spec claim (the leading-slash retry) before it shipped as untested dead code.

## 8. Live `test`, `investigate`, and cancelled `code-review` runs as event-log evidence

- **Probe:** three further live runs against the restarted daemon, used as direct evidence for spec
  036's new per-step event log: `test` pipeline (run `e7505941`), `code-review` on the 036 commits
  (run `6bcebb30`, deliberately cancelled), and `investigate` (run `c62d336e`).
- **Observation:**
  - `test` (`e7505941`): events file `test.events.jsonl` written 0600 in the run dir; event kinds
    `check.output` (stdout+stderr, ordered, monotonic `seq`) and `step.result`; `GET
/api/runs/:id/log` returned 200 `application/x-ndjson` with `nosniff`, `after=` honoured,
    `after=x` → 400; output route 404 for a check step, 400 for a traversal id. Finding: `checkCommand`
    was ignored — ran the project's configured `pnpm check` instead (resolved §11). The run reported
    `succeeded` overall while the check step's own `step.result` was `failed` (prettier exit 1) — by
    design the pipeline records pass/fail as output, but the page should show step-result status
    distinctly.
  - `code-review` (`6bcebb30`) was launched on the 036 commits while Ship 1a was still editing the
    tree, then cancelled deliberately (see §12). FR-014 evidence: `code-review.events.jsonl` ended with
    `step.result {status: cancelled, error: "Run cancelled: …"}` for both reviewers, after 46 events in
    47 s. Relaunched after the 1a commit (see §9).
  - `investigate` (`c62d336e`, haiku): 50 events, `seq` 1..50 contiguous; survey emitted `step.start
{model: "haiku (cli:claude)", transport: "cli"}`, 19 `tool.call`/`tool.result` pairs (Read/Glob; an
    EISDIR read surfaced as `ok: false` with an error excerpt), 8 `message` events; usage `{costUsd:
0.2648, turns: 20, durationMs: 72970, tokens: 97/5744, denials: 0}`; `step.result` succeeded at
    73905 ms. `investigate.outputs/survey.json` written 0600 (7995 B); `GET …/steps/survey/output` →
    `kind: text`, 7741 chars.
- **Verdict:** PASS for the `investigate` run explicitly; all three runs together confirmed the new
  event log (per-event kinds, byte-order `seq`, ndjson streaming, cancel propagation) worked live.

## 9. The `code-review` run on the merged 036 commits (`019137e5`)

- **Probe:** `code-review` dispatched on the 036 commits with a clean tree at `e415a40`.
- **Observation:** 10 m 03 s total — correctness (sonnet, 6 m), security (sonnet, 7.5 m), verify
  (opus, 2 m), synthesis (opus, 27 s). 7 findings, all minor, all CONFIRMED/PARTIAL by the verifier,
  none dropped; verdict "ready to merge." Findings: byte cap counted UTF-16 units; `seq` regex could
  hit an input key; reopen seeded `seq` by line count; a duplicate `step.result` could fire on cancel;
  command-token quoting; a scrub-chunk carry bug; a D3 prose/signature mismatch. Two owner questions
  (Mastra cancel ordering; off-schema tool keys) were made moot by the fixes chosen (dedup set;
  tail-anchored `seq`). Fix round committed as `878a495` (5 new tests, 3 mutation proofs); targeted
  suites 192/192. `pnpm check` on the whole tree left pending Ship 1b's in-progress edits.
- **Verdict:** PASS — the review was worth its ~10 min; it found issues the agent security pass on 036
  had not (the UTF-16 byte units, `seq` forgery, the seed gap, the double terminal event).

## 10. Security passes: 036 backend, 037 spec, Ship 2, Ship 3

- **Probe:** dedicated security-focused agent passes after the 036 backend implementation, the 037
  spec draft, and each of Ship 2 and Ship 3.
- **Observation:**
  - 036 backend: 1 major (scrub applied only at the log sink; `outputExcerpt`/artifact/SSE/MCP still
    carried raw env values) plus 5 minor. `audit` had already flagged the check-output secret class,
    but the spec's fix had been placed at the wrong layer — a lesson for both the log author and
    `correct-plan`, which had accepted that directive verbatim. Fix round dispatched.
  - 037 spec: `devil` + security together found 4 blocking issues (a prompt write could target
    `providers.yaml`; one-click install hides the catalogue; nested-expansion step ids; preamble tests
    lost) plus a template-bundle allowlist gap; folded into the revised spec, committed `2bbf952`, with
    a four-ship delivery order.
  - Ship 2 (catalogue/workflows/diagram): 1 BLOCKING (allowlist normalisation-blind —
    `prompts/../config.json` could reach and execute `checkCommand`), 1 major (preview could hide check
    commands the same way), 3 minor (template-write symlink/TOCTOU, exportBundle containment, echoed
    keys). Fix round dispatched before commit. The spec's `audit` had already required an allowlist +
    realpath check, but the implementation still got the normalisation wrong — a spec-level guard is
    not a code-level proof.
  - Ship 3 (editor): 1 blocking + 2 major, two of them **proven exploits** in pre-existing generator
    code made reachable by regenerating on save — a `def.id` path-traversal and a JS-injection from
    YAML. Decision: save never regenerates Binding A output; generator/loader hardened; prompts GET
    contained like the PUT. Fix round dispatched.
- **Verdict:** each ship's security pass caught real, distinct issues before commit; Ship 3's pass
  proved two exploits rather than merely flagging theoretical ones.

## 11. `checkCommand` is inert at run time — by design

- **Probe:** the `test` run `e7505941` (§8) had passed `inputs.checkCommand` explicitly; the finding
  was then checked against the build code.
- **Observation:** the run used the project's configured `pnpm check` from `config.json` instead of
  the supplied `inputs.checkCommand`. Resolution: `checkCommand` as a run input is inert by design —
  it is a build-time substitution (`buildSteps.test.ts:194-219`); spec 032 V5's "`checkCommand: true`"
  evidence had proved nothing about run-time inputs. This also explains why `build`'s converge loop
  runs the configured command regardless of what a run passes.
- **Verdict:** not a bug — confirmed by-design behavior, traced to `buildSteps.test.ts:194-219`.

## 12. Cancel needs the JSON content-type preamble

- **Probe:** `POST /api/runs/:id/cancel` against the live `code-review` run `6bcebb30`, first bare,
  then with a JSON content-type preamble.
- **Observation:** the bare POST returned 403; with the content-type preamble it returned 204.
- **Verdict:** confirms FR-014 cancel behavior live; the content-type header is required to authorize
  the cancel, not merely conventional.

## 13. The extension page-idle mystery

- **Probe:** after Ship 1b landed and gated the runs poller, a fresh `#/workflows` tab was opened and
  probed with the Chrome extension (screenshot and `read_page`).
- **Observation:** the tab held no connection to the daemon (`lsof`), yet the extension still timed
  out waiting for `document_idle`. The cause is not the poller; it remains unknown. CSP is `script-src
'self' 'unsafe-inline'`, and the extension's isolated world should be exempt from it.
- **Verdict:** unresolved — cause unknown; the owner's visual pass stays the gate, and spec 037 V4 was
  reworded to reflect that.

## 14. Draft-route guard gap found by a curl smoke

- **Probe:** after Ship 3 landed, one-line curl checks against the bundled-mode daemon for the
  pipeline mutation routes, including prompts GET and drafts POST.
- **Observation:** prompts GET on the bundled catalogue correctly returned 403. But `POST
/api/pipelines/:id/drafts`, `PUT /api/drafts/:id`, and `POST /api/drafts/:id/save` had **no**
  bundled-catalogue 403 — create/delete/prompts routes had the guard, these three did not — meaning a
  loopback caller could edit the shipped catalogue through a draft even though the page never exposed
  that path (Edit is project-only in the UI). A fix coder was dispatched.
- **Verdict:** a real guard gap, caught only by the curl smoke — not by any of the agent security
  passes. Lesson recorded: a one-line curl per mutating route against the bundled-mode daemon is a
  cheap gate, worth adding to the standard smoke list.

## 15. Prettier binary mismatch

- **Probe:** `pnpm -s prettier` and `./node_modules/.bin/prettier` run against the same spec files
  during Ship 2.
- **Observation:** the two disagreed once on the spec files.
- **Verdict:** use the local binary explicitly, per the log's own resolution.

## 16. Node 20 vs. 22

- **Probe:** coder reports from the same session (secondary, §Sources) checked the ambient node
  version against `package.json` `engines` and the test runner script.
- **Observation:** ambient shell `node --version` is v20.18.3, while `package.json` `engines` requires
  `>=22`. `scripts/test.sh` sources `~/.nvm/nvm.sh` and runs `nvm use 22` because `better-sqlite3` is
  built for the Node 22 ABI. Running a test file directly with the ambient node
  (`./node_modules/.bin/tsx --test src/serve/server.test.ts`) fails every server test at once with no
  useful message; plain `node` also lacks `path.matchesGlob`. Correct usage: `bash scripts/test.sh
<file>`. pnpm's `WARN Unsupported engine` line is cosmetic.
- **Verdict:** not a defect — a footgun for agents bypassing `scripts/test.sh`; `pnpm check` unaffected.

---

## What to change in the tool (owner decisions, no implementation)

- Surface usage/session limits as a distinct **blocked** state with the reset time, not a plain run
  failure (§6; tagged 027 follow-up in the log).
- Add a resume/continue input to `build` so a second run does not restart `develop.implement` from
  scratch on a dirty tree (§6; tagged 027 follow-up in the log).
- Keep `spec-creation` scoped to feature requests; use `audit` for reviewing an existing design (§3).
- Add a per-route, bundled-mode curl smoke to the release checklist — it caught the draft-route guard
  gap the agent security passes missed (§14).

---

## Sources consulted

**Primary — the session log, and the run ids / commit shas it names.**

- `/private/tmp/claude-501/-Users-en3e-code-rubakas-agent-flows/ce7c13d5-1202-4c3f-ab78-37e36d90f2dc/scratchpad/dogfood-036.md` — the sole source for every finding above.
- Run ids: `eddb9594-97f0-4273-9b62-fa75f5dbcd52` (investigate), `7b909ee8-20a3-4c3e-856e-a41f34aeed4c` (audit), `e7505941` (test), `6bcebb30` (code-review, cancelled), `c62d336e` (investigate), `019137e5` (code-review on merged commits). The `correct-plan` and `build` run ids are recorded in the log only as scratchpad file references (`scratchpad/correct-plan-036-runid`, `scratchpad/build-036-A-runid`), not as literal ids.
- Commit shas: `e06ae03` (correct-plan output accepted as spec), `c8a8739` (tree before the `build` run), `989c3f8..607eb53` (Ship 1b), `e415a40` (tree before the code-review run), `878a495` (fix round for the code-review findings), `2bbf952` (037 revised spec), `4fe9279..0dd41ec` (Ship 2 + security fixes), `d9c4545..a67e924` (Ship 3 + security fixes).

**Secondary — session agent reports (coder reports from the same working session, cited for §16 only).**
