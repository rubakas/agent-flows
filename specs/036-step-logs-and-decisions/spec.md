# 036. Step logs and decisions

| Field        | Value                                                                          |
| ------------ | ------------------------------------------------------------------------------ |
| Feature Name | Step logs and decisions                                                        |
| Branch       | `main`                                                                         |
| Status       | Implemented (backend) — 2026-09-14; page half delivered under spec 037 Ship 1b |
| Created      | 2026-09-14                                                                     |

## Problem

In the run view (`src/serve/ui.html`, `#/runs/<id>`) a step is a black box between `started` and
`succeeded`: the page shows a status badge, the model, an output excerpt capped at 2048 characters
(`OUTPUT_EXCERPT_LIMIT`, `src/runtime/runService.ts:342`) and a collapsed prompt. Nothing shows what
the model did inside the step (files read, commands run, what it said between tool calls, whether
the watchdog tripped), nothing shows a check step's command output while it runs, and the decisions
the run accumulates are invisible: `gateDecisions` (human approvals and rejections with reasons,
judge verdicts in `gateMode: auto`) are recorded in `RunRecord` (`runService.ts:737-747`,
`844-851`, `975-981`, `1111-1120`), persisted in the artifact, and never rendered by `ui.html` (zero
references to `gateDecisions` in the page). A schema step's full structured output (for example the
verifier's per-finding verdicts in `code-review`) is cut to the excerpt in the step record and
survives only inside the whole-run `result` on success (`runService.ts:913-915`).

**Facts verified 2026-09-14** (explorer pass, checked against the tree at `c159866`):

- Claude stream parsing lives in `src/canon/runClaudeCli.ts`, not in the adapter:
  `processLineForLoopDetection` (`:332`) parses each stdout line as JSON, inspects only
  `type === "assistant"` (`:342`) and its `tool_use` content blocks (`:344-363`); `findResultEvent`
  (`:216`) finds the `type === "result"` event (`ClaudeResultEvent`: `type, subtype, is_error,
result, total_cost_usd, num_turns`, `:202-209`). `stdoutRaw` holds the full stream for the
  lifetime of one call (`:269`) and is discarded; only `rawTail` (500 chars) survives for error
  messages (`:271, 313`). The watchdog is internal (`resetStallTimer`/`tripWatchdog`, `:281-297`;
  `WatchdogTrip {pathology, detail, digest}`, `:28-40`). The close handler rejects without reaching
  `findResultEvent` on operator abort (`:403-406`), watchdog trip (`:409-412`) and non-zero exit
  (`:414-419`); the adapter reinvokes `runClaudeCli` for attempt 2 after a watchdog trip
  (`src/canon/adapters/claude.ts:165-190`).
- `src/canon/adapters/codex.ts`: `isItemCompleted` (`:82`) recognises
  `{type:"item.completed", item:{type:"agent_message", text}}`; `extractCodexAnswer` (`:94`) keeps
  the last `agent_message`; no watchdog; raw stdout is a local string (`:146-154`); the close
  handler rejects on failure (`:163-175`).
- `src/canon/adapters/api.ts`: one `fetch`, `choices[0].message.content` (`:55`); no stream; throws
  directly on failure (`:36-58`).
- `src/canon/stepRuntime.ts`: `StepRunnerDeps` (`:47`), `withDeadline` (`:203`) wraps every
  transport call; leaf module (no-cycle lint rule, `import-x/no-cycle: "error"`,
  `eslint.config.js:50`). `src/runtime/runService.ts:20` already imports `StepRunnerDeps` from
  `canon/runStep.js`, so any type the canon layer needs must be declared in `canon/`.
- `src/canon/runStep.ts`: `buildCheckEnv` (`:72-82`) forwards the base allowlist plus the step's
  declared variable names (`deps.envAllowlist`, used at `:119`) into `/bin/sh -c`, so a check step's
  child environment can hold real credentials (`GH_TOKEN` and the like). `CHECK_OUTPUT_CAP` is
  64 KiB in memory (`:87`).
- `src/runtime/runService.ts`: `StepState` (`:137-155`: `status, startedAt?, finishedAt?, error?,
outputExcerpt?, outputTruncated?, prompt?, command?, model?`); steps accumulate in `run.watch`
  (`:473-534`); `mergedSteps` (`:590-601`) merges `stepIntrospection` read-through;
  `finalizeSettlement` (`:611-618`); `persistArtifact` (`:1312-1373`) computes the artifact dir
  (`:1283-1286`, `<runsDir>/<runId>/` for a root run, `chainArtifactDir` for a seeded chain) and
  writes `<artifactDir>/<pipelineId>.json` through `writeRunArtifact`
  (`src/runtime/artifactStore.ts:101-124`, dir 0700, file 0600); `subscribe` (`:1403-1420`) fans
  `StepEvent`s to listeners; `GateDecision` (`:73-90`); `degradeToManual` (`:1128`) sets
  `judgeError` and records no decision. `resolveGate`'s superseded branch (`:968-978`) can push a
  `GateDecision` after the run has already settled, because human `approve()` reaches
  `finalizeSettlement` synchronously (`:754-755`, `:611-618`).
- `src/runtime/stepIntrospection.ts`: `recordStep(runId, stepId, {prompt?, command?, model?})`
  (`:32-41`), `getRun`, `clearRun`; called from `src/bindings/mastra/buildSteps.ts:262` (llm:
  prompt, model) and `:527` (check: command). The `runId` comes from Mastra's execute params
  (`{inputData, abortSignal, runId}`, `:208-221`, `:507-523`), never from build-time deps
  (`BuildDeps`, `:58-86`; spec 033 rule).
- `buildLlmStep` (`buildSteps.ts:208-348`) returns `{...rawCtx, [step.id]: value}` where `value` is
  the raw text or, with `step.schema`, the parsed object from `tryParseSchemaOutput` (`:144-162`);
  the full value lives only in Mastra's context and in the final `result`. Its `catch`
  (`:303-312`) is the one place that sees abort, watchdog exhaustion and transport failure alike.
- `src/serve/server.ts`: SSE `GET /api/runs/:id/events` (`RE_RUN_EVENTS` `:101`, handler
  `:1267-1324`) emits `event: snapshot` once (`:1286`), ends immediately for `source === "disk"`
  (`:1291-1294`), then `event: step` `{stepId, status, outputExcerpt?, outputTruncated?}`
  (`:1302-1310`) and a `: heartbeat` comment every 15 s (`:1313-1315`). `GET /api/runs/:id`
  (`:1359-1372`), `GET /api/runs/:id/manifest` (`:1326-1357`). No route serves the artifact file
  itself.
- `src/serve/ui.html`: `openRunView` (`:1627-1685`) fetches the snapshot, calls `renderRunDetail`
  (`:1827-1922`), opens the `EventSource` (`:1655`) unless disk; `stepRowHtml` (`:1800-1821`)
  renders `<div class="step-row" data-step-id>` with a `.run-status` badge, `.step-output` and a
  `<details class="step-detail">` prompt block; `updateStepRow` (`:1938-1968`) updates badge and
  excerpt and returns silently when no row exists for the step (`:1943-1946`) — a step that starts
  after the snapshot never appears until reload. The Cancel button is `#btn-cancel-run` (`:1864`).
  The page's escaping convention is explicit at `:1807` ("step output is untrusted model-produced
  text — use escH") and `:1825` ("All server data is escaped or written via textContent"), and the
  page is dominated by string concatenation that must carry it.
- `src/canon/workspace/denyMatch.ts`: `matchesDenyPattern(relPath, patterns)` is documented and
  tested as a case-insensitive glob match of a **repo-relative** path (`:1-21`); `normalize`
  lowercases, strips a leading `./` and trailing slashes, but does not strip a leading `/`.
- `src/db/schema.ts` has no table for run events or step logs; run state is in-memory plus the
  artifact files.
- Tests to extend: `src/runtime/runService.test.ts`, `src/serve/server.test.ts` (`"SSE
/api/runs/:id/events delivers step events for a running run"`, `:489`),
  `src/serve/ui-route.test.ts`, `src/runtime/artifact.test.ts`,
  `src/canon/adapters/claude.golden.test.ts`, `src/canon/adapters/codex.test.ts`,
  `src/canon/adapters/supervision.test.ts`, `src/canon/workspace/denyMatch.test.ts`.
- The `investigate` pipeline was run on this request (run
  `eddb9594-97f0-4273-9b62-fa75f5dbcd52`, artifact `investigate.json`, succeeded in 2 m 37 s on
  haiku); its open questions are answered by D1–D11 below. Its survey missed the existing SSE test
  at `server.test.ts:489`.
- **Audit**: run `7b909ee8-20a3-4c3e-856e-a41f34aeed4c` on 2026-09-14 (correctness + security on
  sonnet, synthesis on opus, 8 m 37 s) produced 2 blocking, 4 major and 4 minor findings against
  the draft; all are resolved in the decisions below.
- Probe 2026-09-14 (claude 2.1.270, `-p --restricted --strict-mcp-config --tools Read,Glob,Bash
--allowedTools Read,Glob`, prompt on stdin): a Bash call not listed in `--allowedTools`
  **executed** (`ls`, `echo`), and was refused only when a `--disallowedTools 'Bash(ls:*)'` pattern
  matched or when restricted-mode confinement blocked a file write. So `--allowedTools` denies
  nothing in print mode; the `--tools` set and the deny patterns are the gates. The daemon never
  names Bash in `--tools` (`contents: read` grants Read, Glob, Grep only,
  `src/canon/adapters/claude.ts:64-78`), so it is not exposed. Caveat: the probe ran as a child of
  an interactive Claude Code session; a re-run from a plain terminal is listed as a follow-up.
- Build 2026-09-14: the backend was implemented by the `build` pipeline's `develop.implement` step
  (opus, 12 min) until the CLI's usage window closed mid-step; the tree it left was lint-clean and
  type-clean, and a follow-up pass added only formatting, import order, the non-zero-exit message
  and one test. `pnpm check`: 1409 tests, 0 failing.

## Goals / Non-goals

**Goals.**

- G1 Every llm and check step writes an ordered, provider-neutral event log to disk as it runs.
- G2 The run view shows that log live for the running step and on demand for finished steps, and
  still shows it after a daemon restart.
- G3 Decisions are visible: a gate decisions table (human and judge, with reasons), judge
  degradation, and a schema step's structured output rendered as a table.
- G4 Full step outputs are kept on disk per step, not only the 2048-character excerpt, and are
  viewable from the run view.
- G5 No new SQLite table; the MCP surface is unchanged (`get_run` never returns logs, outputs or
  prompts).

**Non-goals.** Editing pipelines (next spec); n8n; token-by-token streaming of partial messages;
content-based secret redaction beyond the path rule in D8 and the declared-env scrub in D2/FR-015;
log retention and rotation after a run (tracked in specs/027); reconnecting SSE to disk runs (034
FR-011 stands); listing runs that were interrupted by a daemon restart before any artifact was
written (027 open item).

## Decisions

**D1 — Event log format and location.** One append-only NDJSON file per run and pipeline:
`<artifactDir>/<pipelineId>.events.jsonl`, next to the `<pipelineId>.json` artifact, where
`artifactDir` is exactly the directory `persistArtifact` resolves today (`runService.ts:1283-1286`),
created at run start (dir 0700, file 0600) instead of at settlement. Each line is one
`StepLogEvent`: `{ seq, at, runId, pipelineId, stepId, kind, ...payload }`. `seq` is monotonic per
run starting at 1; `at` is ISO-8601 with milliseconds. Kinds and payloads:

- `step.start` `{ model, transport }`
- `message` `{ role: "assistant", text, truncated? }`
- `tool.call` `{ callId?, name, input, nested?, denied? }` — `input` is the tool input as JSON,
  bounded per D5
- `tool.result` `{ callId?, name?, ok, excerpt?, truncated?, redacted? }`
- `check.output` `{ stream: "stdout" | "stderr", text, truncated? }`
- `watchdog` `{ pathology: "stall" | "loop", detail, attempt }`
- `usage` `{ costUsd?, turns?, durationMs?, usage?: { inputTokens, outputTokens }, denials? }` —
  whatever the provider reports about the call it just finished; emitted by the adapters, possibly
  more than once per step (one per transport attempt)
- `step.result` `{ status: "succeeded" | "failed" | "cancelled", durationMs, error? }` — the
  terminal event of a step, emitted exactly once by the step builder (D2)
- `decision` `{ gateStepId, mode, decidedBy: "human" | "agent", approved, reason?, judgeModelId?,
superseded? }` — appended whenever a `GateDecision` is pushed (`approve`, `cancel`,
  `resolveGate`)
- `judge.degraded` `{ gateStepId, error }` — appended when `degradeToManual` fires
- `log.truncated` `{ events, bytes }` — appended once when a per-run cap of D5 is reached

`denials` counts tool calls the CLI refused during the step (claude `permission_denials`); each
refused call is also visible as a `tool.call` followed by a `tool.result` with `ok: false`.

Provider events that map to none of these are not logged; there is no raw passthrough.

**D2 — Capture seam.** The event shape is declared in a new leaf module
`src/canon/stepLogEvents.ts` (imports node builtins only): `StepLogEvent`, `StepLogEventInput` (the
event without `seq/at/runId/pipelineId/stepId`), the kind union, the bounds constants of D5 and the
pure `boundStepLogEvent(input): StepLogEventInput` that applies them. `src/canon/stepRuntime.ts`
imports the type from there and `StepRunnerDeps` (`:47`) gains
`onEvent?: (event: StepLogEventInput) => void`; `src/runtime/stepLog.ts` imports downward from
`canon/` only, so no `runtime → canon → runtime` edge exists and `import-x/no-cycle` stays quiet.
`runLlmStep` passes `onEvent` through untouched. Adapters emit:

- claude (`runClaudeCli.ts`): from each stream-json line — `assistant` events (one content block per
  event in practice): every `text` block → `message`, every `tool_use` block → `tool.call {callId:
block.id, name: block.name, input: block.input}`, with `nested: true` when the event's
  `parent_tool_use_id` is non-null; `thinking` blocks are skipped. `user` events carrying
  `tool_result` blocks → `tool.result {callId: block.tool_use_id, ok: block.is_error !== true,
excerpt: block.content}` — `is_error` is optional in the stream (absent on a successful Read,
  `false` on a successful Bash, `true` on a refused or failed call) and `content` is a string. The
  `result` event → `usage {costUsd: total_cost_usd, turns: num_turns, durationMs: duration_ms,
usage: {inputTokens: usage.input_tokens, outputTokens: usage.output_tokens}, denials:
permission_denials.length}`; a refused tool call leaves the run-level `is_error` false, so
  `denials` is the only run-level signal. `system`, `stream_event`, `rate_limit_event` lines are
  skipped. Every watchdog trip → `watchdog`. The existing loop detector keeps consuming the same
  parsed line; parsing happens once. On a non-zero exit the thrown error carries the last `result`
  event's `subtype` and the first 300 characters of its `result` text (the interrupted build lost
  its reason — 'You've hit your session limit' — because the close handler discarded it); test
  `src/canon/runClaudeCli.test.ts` "keeps the result event's subtype and text when the CLI exits
  non-zero".
- codex (`codex.ts`), shapes taken from the captured fixtures (codex-cli 0.152.1): `item.started`
  with `item.type === "command_execution"` → `tool.call {callId: item.id, name: "command", input:
{command: item.command}}`; `item.completed` with `command_execution` → `tool.result {callId:
item.id, ok: item.exit_code === 0, excerpt: item.aggregated_output}`; `item.started` with
  `file_change` → `tool.call {callId: item.id, name: "file_change", input: {changes: item.changes}}`
  where each change is `{path, kind}`; `item.completed` with `file_change` → `tool.result {callId:
item.id, ok: item.status === "completed"}`; `item.completed` with `agent_message` → `message
{text: item.text}`; `turn.completed` → `usage {usage: {inputTokens: usage.input_tokens,
outputTokens: usage.output_tokens}}`. `thread.started`, `turn.started` and item types not present
  in the fixtures (`reasoning`, `mcp_tool_call`) are skipped until captured; there is no raw
  passthrough. Codex emits no partial text and no cost figure.
- api (`api.ts`): one `message` with the response content, then `usage` when the response carries a
  `usage` object.
- check (`src/canon/runStep.ts` `runCheckStep`): every stdout/stderr chunk → `check.output` in
  arrival order (chunks coalesced per read, bounded per D5), after the scrub below.

Adapters never emit `step.start` or `step.result`. Both are the step builder's job, so the
watchdog's second `runClaudeCli` invocation cannot double-count a step and no failure path can end a
step's log without a terminal event: `buildLlmStep` and `buildCheckStep` emit `step.start {model,
transport}` once before calling the runner, and exactly one `step.result {status, durationMs,
error?}` from a finally-style path around the call that sees success, failure, abort and watchdog
exhaustion alike — `status: "cancelled"` when the combined abort signal is aborted, `"failed"`
otherwise, `"succeeded"` on return. The builders bind `onEvent` to
`(e) => appendStepLog(runId, step.id, e)` with `runId` from Mastra's execute params, exactly like
`recordStep`; never through build-time `BuildDeps` (spec 033). `pipelineId` is not passed at the
call site and is not added to `BuildDeps` — the sink stamps it from the record `openRunLog` created
for that `runId` (D3).

**Scrubbing declared env values out of `check.output`.** `buildCheckEnv` (`runStep.ts:72-82`)
deliberately forwards the step's declared variable names into `/bin/sh -c`, so a `curl -v`, a
`set -x` or an error echoing argv can put a real credential on stdout or stderr. Before emitting a
`check.output` event, `runCheckStep` replaces every non-empty value of the variables the step
declares (the `deps.envAllowlist` names `buildCheckEnv` forwards, resolved against the same env it
built) with `[redacted:<NAME>]`. The scrub is applied at the source in `runCheckStep`, so the
retained `CheckResult.output` — which becomes the step's context value, the artifact's
`outputExcerpt`, the SSE `step` payload and MCP `get_run`'s `outputExcerpt` — carries the
placeholder too; a scrub at the log sink alone would have left three other exits (found by the
2026-09-14 security pass). A value split across two stdout reads is covered too: the scrubber holds
back the last `L-1` characters of each scrubbed chunk (`L` = the longest declared value) and
prepends them to the next one, per stream, flushing the tail when the child closes — so only a
complete occurrence can end inside an emitted chunk. Known limitation: a value the command
transforms before printing it (base64, a case change, an interpolation that splits it) is not
recognised, because the scrub is a literal match on the value. This scrub applies to no other kind:
llm steps never receive declared env values.

**D3 — Sink.** New leaf module `src/runtime/stepLog.ts` (imports downward only —
`canon/stepLogEvents`, `canon/denyPatterns`, `canon/workspace/denyMatch` and node builtins; nothing
from `serve/` and nothing else from `runtime/`; covered by the no-cycle lint rule), same shape as
`stepIntrospection`: a module map keyed by Mastra `runId`, each entry holding `{dir, pipelineId,
seq, events, bytes, truncated, subscribers}`. API:

- `openRunLog(runId, {dir, pipelineId, caps?})` — registers the run; `caps` is a
  `Partial<RunLogCaps>` (`{events?, bytes?}`) whose members default to the D5 constants, so a test
  can lower one cap without restating the other. Byte counts are UTF-8 byte lengths, not string
  lengths, so the cap bounds the file rather than its character count.
- `appendStepLog(runId, stepId, input): StepLogEvent | undefined` — stamps `seq`, `at`, `runId`,
  `pipelineId` (from the record) and `stepId`, bounds the payload with `boundStepLogEvent`,
  `appendFileSync`s the line, then notifies subscribers, so file order equals delivery order and a
  subscriber never sees a line the file does not have.
- `appendRunLogFileEvent(dir, pipelineId, runId, stepId, input): StepLogEvent | undefined` — the
  file-level path used when the sink no longer holds the run: it reads the last line of the events
  file to continue `seq`, then appends. No subscribers exist at that point by definition.
- `subscribeRunLog(runId, listener)`, `readRunLog(file, {after?}): StepLogEvent[]` (tolerates a torn
  last line by dropping it), `writeStepOutput(runId, stepId, payload)` (D6),
  `closeRunLog(runId)` (drops subscribers and the in-memory entry; the file stays).

Events for an unknown `runId` are dropped, like `recordStep`. `RunService.start` opens the log
before the workflow starts; `finalizeSettlement` closes it. `RunService` appends `decision` and
`judge.degraded` events at the three `GateDecision` push sites and in `degradeToManual` through a
helper that calls `appendStepLog` when the sink still holds the run and falls back to
`appendRunLogFileEvent` otherwise — `resolveGate`'s superseded branch (`runService.ts:968-978`)
fires after settlement has already closed the log, and FR-005 requires that push to be logged like
any other. Nothing about events is added to `RunRecord`, `StepState`, `GetResult` or the artifact.

**D4 — Delivery.** SSE `GET /api/runs/:id/events` gains `event: log` with `data` = the
`StepLogEvent` JSON, for every event appended after the subscription. New route
`GET /api/runs/:id/log?after=<seq>` returns `application/x-ndjson` lines with `seq > after`
(default 0) from the events file, for live and disk runs alike; 404 for an unknown run; 400 for a
non-integer or negative `after`; an empty 200 body for a run with no events file (runs recorded
before this spec). The page: open the SSE first and buffer `log` events, fetch the backfill, render
it, then apply buffered events with `seq` greater than the last rendered; every later event is
applied if its `seq` is greater than the last seen, otherwise dropped (no duplicates, no gaps). Disk
runs: the SSE still ends after the snapshot (034 FR-011); the page fetches the backfill only. The
response is bounded by the per-run caps of D5, which cap the file itself.

**D5 — Bounds.** Per event: `message.text` ≤ 8 KiB, serialized `tool.call.input` ≤ 2 KiB,
`tool.result.excerpt` ≤ 2 KiB, `check.output.text` ≤ 4 KiB; over-limit fields are cut and marked
`truncated: true`. Per run: `MAX_EVENTS_PER_RUN = 20000` and `MAX_LOG_BYTES_PER_RUN = 32 MiB`
(constants in `canon/stepLogEvents.ts`, overridable through `openRunLog`'s options for tests). When
either cap is reached the sink appends one `log.truncated {events, bytes}` marker and thereafter
drops `message`, `tool.call`, `tool.result` and `check.output` events while still writing `usage`,
`watchdog`, `step.start`, `step.result`, `decision` and `judge.degraded`, so the structure of the
run and every decision stay complete and both readers (`readRunLog`, the backfill route) stay
bounded. Nothing accumulates in memory per run beyond the subscriber set and the counters. The page
keeps at most 2000 rendered events per step and shows "N earlier events" above the list. The full
step output is never in the log (D6). The caps are enforced on the in-registry append path;
`appendRunLogFileEvent` (post-settlement decisions only) is bounded by the gate count instead.
File and directory modes are applied at creation only.

**D6 — Full outputs.** When an llm step returns, `buildLlmStep` calls
`writeStepOutput(runId, step.id, { kind: "text" | "json", schema?, output })` and the sink writes
`<artifactDir>/<pipelineId>.outputs/<stepId>.json` (dir 0700, file 0600) with
`{ runId, pipelineId, stepId, kind, schema?, output }`, where `output` is the full text or the
parsed schema object and `pipelineId`/`artifactDir` come from the `openRunLog` record. New route
`GET /api/runs/:id/steps/:stepId/output` serves that file (200 JSON; 404 when absent; 400 when
`stepId` is not `[A-Za-z0-9_.-]+` or contains `..`). The output is never included in
`GET /api/runs/:id`, in the SSE snapshot, or in MCP `get_run`.

**D7 — Restart.** Because both files are written incrementally, after a daemon restart the log and
output routes read from disk for `source: "disk"` runs; `readPersistedRun` and the artifact format
are unchanged. The routes resolve the run directory from the persisted run's `artifactPath` (its
`dirname`), which already passes the state-root containment check from 034. A run interrupted before
settlement keeps its partial events file on disk but is not listed (027 open item, unchanged).

**D8 — Credential guard on logs (defence in depth).** Before appending a `tool.call`, the sink
checks every string under the input keys `file_path`, `path`, `notebook_path` and every element of
`paths` against `CREDENTIAL_DENY_PATTERNS` using the existing matcher in
`src/canon/workspace/denyMatch.ts`. Strings are matched as given. Every entry in
`CREDENTIAL_DENY_PATTERNS` begins with `**/`, and Node's `path.matchesGlob` matches such a pattern
against an absolute path directly (probed 2026-09-14 with `/Users/x/proj/.env`, `/.env`,
`//users/x/.env`, `/users/x/id_rsa`, `/users/x/a.pem`, `/secrets.yaml`,
`/users/x/.aws/credentials`), so no relativisation step exists; a leading-slash retry was
implemented, found unfalsifiable by mutation, and removed. If a pattern without the `**/` prefix is
ever added, this paragraph must be revisited. On a match the event is appended with `denied: true`
and its input reduced to `{ path }`, and the `tool.result` with the same `callId` is appended with
`redacted: true` and no `excerpt`. The CLI deny rules (spec 031) already block the read, so a
redaction is observed only when that guard has failed, and the log then still shows that the
attempt happened. Codex command output is not scanned: codex runs in a sanitized copy that contains
no credential files (spec 031). Check step output is covered instead by the declared-env scrub of
D2 (FR-015); no other kind needs it, because llm steps never receive declared env values.
Command-shaped inputs are covered too: when `tool.call.input.command` is a string, each
whitespace-separated token is matched against the deny patterns, with surrounding single and double
quotes stripped first so `cat "/x/.env"` is caught like the bare token; a match is treated like a
path match. The guard relies on a `tool.call` (with `callId`) preceding its `tool.result`; the fixture
test asserts that ordering for every captured stream. `pipelineId` is validated with the same
character class as `stepId` before any path is built; the routes answer 404 for an unsafe id.

_Known limitation._ The key list is an allowlist of the argument names Claude's built-in tools use
today, not a structural rule, and it does not descend into nested objects. Command tokens are read
as literals: a path assembled by the shell — `$HOME/.env`, `"$DIR"/.env`, `cat /x/.en''v` — is not
resolved and so is not matched, because the guard tokenises a string rather than running a shell.
There is no bypass now —
Bash is never granted (`claude.ts:64-78`) and codex runs credential-free (spec 031 D2) — but a new
tool or adapter that names or nests a path argument differently gets no redaction, silently. Trigger
for revisiting the key list: any new tool granted to a transport, or any new adapter whose tool
inputs carry paths.

**D9 — Cost and turns.** Cost, turns, token usage and denials come from the step's `usage` events;
the step footer in the page reads the last `usage` event of the step and shows cost, turns and
tokens when present, alongside the duration from `step.result`. Claude reports all of them; codex
reports tokens only; api reports tokens when the response carries them.

**D10 — Run view.** Each step row gets an `Activity` `<details>` (open for the step currently
`started`, closed otherwise) rendering events in `seq` order: `tool.call` as one line — `Read
<file_path>`, `Grep "<pattern>" <path>`, `Glob <pattern>`, `Bash <command>`, `Edit <file_path>`,
other tools as `<name> <compact input>` — with `denied` styled as a warning; `tool.result` collapsed
under its call (matched by `callId`, otherwise its own line); `message` as a paragraph;
`check.output` as a terminal-style `<pre>` with stderr styled differently; `watchdog` as a warning
line; `log.truncated` as a warning line stating the caps; `step.result` plus the last `usage` as the
footer of D9. A `Decisions` section above the steps lists `gateDecisions` (gate step, decided by
human or judge, verdict, reason, judge model, time, superseded flag) and `judgeError` when present,
and updates live from `decision` and `judge.degraded` log events. A step with a persisted output
gets an `Output` `<details>` that fetches the output route on first open: `kind: "json"` with an
array of objects renders as a table (columns = union of keys in order of first appearance, cells cut
at 200 characters with expand), any other JSON as a pretty-printed `<pre>`, text as `<pre>`. Fix:
when `updateStepRow` finds no row for `stepId`, it re-fetches `GET /api/runs/:id` and re-renders the
steps section so late-starting steps appear.

**Escaping.** Every value on these paths is model-produced or repository-produced and reaches the
page through prompt injection or a hostile checkout, so each is built with `escH` or written via
`textContent`, per the page's existing convention (`ui.html:1807`, `:1825`): `message` text; the
tool name and every rendered part of `tool.call.input`; `tool.result.excerpt`; `check.output.text`;
`watchdog.detail`; a decision's `reason` and `judgeModelId`; the output table's column keys **and**
cell values; the output `<pre>`. Because the table-from-JSON-keys path is new logic with no
precedent in the page to copy, the new rendering helpers live in a plain ESM file
`src/serve/ui-log.js` served like `ui-route.js` (with a companion `.d.ts`) so they are unit-testable
outside the browser, and FR-011 carries the escaping test.

**D11 — MCP unchanged.** `toStepViews` in `src/bindings/mastra/daemonTools.ts` keeps dropping
`prompt`; no log, event or output field is added to any tool result.

## Functional Requirements

- **FR-001.** The events file exists (0600, in a 0700 dir) before the first step starts, and every
  appended line has a `seq` exactly one greater than the previous line's.
- **FR-002.** The claude adapter path emits the D2 kinds from a stream-json stream, including
  `usage` with `costUsd`, `turns` and `denials` from the `result` event and `watchdog` on every
  trip.
- **FR-003.** The codex adapter path emits the D2 kinds from an `item.completed` stream, including
  `usage` from `turn.completed`; the api adapter emits `message` and, when reported, `usage`.
- **FR-004.** `runCheckStep` emits `check.output` for stdout and stderr chunks in arrival order.
- **FR-005.** A `decision` event is appended for every `GateDecision` push (human approve, human
  reject, cancel, judge verdict), including a superseded verdict pushed after the run settled, and
  `judge.degraded` when the judge degrades to manual.
- **FR-006.** SSE `log` events reach a subscriber after the line is on disk, in `seq` order; a
  subscriber attached mid-run sees only later events (backfill is the route).
- **FR-007.** `GET /api/runs/:id/log` honours `after`, returns NDJSON, 404/400/empty-200 as in D4,
  and works for a disk run served by a fresh server over the same runs dir.
- **FR-008.** `GET /api/runs/:id/steps/:stepId/output` returns the persisted output, 404 when
  absent, 400 for an unsafe id; the file is written for every llm step that returns (text or parsed
  schema object).
- **FR-009.** Field bounds per D5 with `truncated: true`; on reaching a per-run cap the log gains
  one `log.truncated` event and thereafter carries only the structural kinds listed in D5.
- **FR-010.** Deny guard per D8, for repo-relative, absolute and nested absolute inputs.
- **FR-011.** The run view renders Activity, Decisions and Output per D10 with every new path
  escaped, and a step row missing from the snapshot appears on its first `step` event.
- **FR-012.** MCP `get_run` output has no `log`, `events`, `output` or `prompt` key (D11).
- **FR-013.** `RunRecord`, `StepState`, `GetResult` and the artifact JSON gain no event or output
  fields; appending 10 000 events changes none of them.
- **FR-014.** The events file of a run cancelled or failed mid-step is complete up to the last event
  and ends with that step's `step.result`, emitted by the step builder on every exit path
  (success, failure, abort, watchdog exhaustion).
- **FR-015.** `check.output` and the retained `CheckResult.output` never carry the value of a
  variable the step declared: the text is scrubbed to `[redacted:<NAME>]` before the event is
  appended or delivered.

## Verification

- **V1.** Unit tests for `stepLog.ts`: seq monotonic, append-then-notify order, torn last line
  dropped by `readRunLog`, `after` filtering, 0600 mode, unknown runId dropped, `closeRunLog`
  releases subscribers, `appendRunLogFileEvent` continues `seq` from the last line after
  `closeRunLog`, per-run caps (lowered through `openRunLog` options) produce one `log.truncated`
  and then drop only the bulk kinds.
- **V2.** Fixtures from real streams, captured 2026-09-14 from a scratch directory holding only
  `package.json` and `notes.txt` (no credentials), copied into `src/canon/adapters/__fixtures__/`:
  `claude-stream.jsonl` (claude 2.1.270; two Read calls with results, a text answer, a `result`
  event with cost and turns), `claude-denied-stream.jsonl` (a Bash call refused by a
  `--disallowedTools 'Bash(ls:*)'` rule: `tool_result` with `is_error: true` and one
  `permission_denials` entry `{tool_name, tool_use_id, tool_input}`), `codex-stream.jsonl` (one
  `command_execution` started and completed, two `agent_message`s, `turn.completed` usage) and
  `codex-write-stream.jsonl` (one `file_change` started and completed with `changes: [{path, kind:
"update"}]`, one `command_execution`, three `agent_message`s). Tests feed each fixture through the
  adapter's line parser with a recording `onEvent` and assert the exact event sequence — including
  that no `step.start` or `step.result` appears, the builders owning those. A separate builder-level
  test asserts one `step.start` and exactly one terminal `step.result` per step for success, thrown
  failure, abort (`cancelled`) and watchdog exhaustion, including the claude two-attempt path.
  Mutation: removing the `tool_result` branch (claude) or the `command_execution` branch (codex)
  turns the test red.
- **V3.** Server tests: SSE `log` events for a live run; backfill route ordering, `after`, 400, 404,
  empty-200; output route 200/404/400; a disk run read by a second `RunService`/server over the same
  runs dir returns the same log lines. Run-service test: settle a run, then push a superseded judge
  decision through `resolveGate`, assert the events file gained that `decision` line with the next
  `seq` (FR-005). Check-step test: declare an env name with a known value and run
  `printf "$NAME"`, assert the events file holds `[redacted:<NAME>]` and nowhere the value
  (FR-015). Deny-guard test: repo-relative `.env`, an absolute dotenv under `/Users/x/proj/` and a
  credential-named json under `/Users/x/proj/config/` all yield `denied: true` with the input
  reduced to `{path}` and a `redacted: true` result (FR-010).
- **V4.** MCP test: `get_run` result keys contain none of `log`, `events`, `output`, `prompt`.
- **V5.** Renderer tests against `src/serve/ui-log.js`: a `message` containing `<script>` and an
  output-table JSON key containing `<img onerror>` both render escaped (no live tag in the produced
  HTML); a tool input, a check-output chunk, a watchdog detail and a decision reason with markup
  likewise. Mutation: dropping `escH` from any one path turns the test red.
- **V6.** Live: run the `test` pipeline (its check command comes from the project config or the
  default gate; a run input named `checkCommand` is intentionally ignored, `buildSteps.ts:559-562`)
  and confirm `check.output` events on both streams in the file and over SSE; run `investigate` and
  confirm `tool.call`/`tool.result`/`message`/`usage`/`step.result` events with cost; run
  `code-review` and confirm the `verify` output renders as a table with a verdict column; owner
  visual pass of the page DEFERRED as in 034 V3.
- **V7.** Every new gate is mutation-proven once and the ledger is recorded in this spec under a
  "Verification log" heading (leave a placeholder list).

## Follow-ups

- Token streaming.
- Log retention.
- Secret content redaction beyond declared env values and deny-listed paths.
- MCP log access.
- Log search.
- Run listing for restart-interrupted runs.
- Re-run the `--allowedTools` probe from a plain terminal; if confirmed, decide in specs/027
  whether the claude argv keeps `--allowedTools` as documentation or drops it (golden fixture
  change).
- Codex `reasoning` and `mcp_tool_call` item shapes: capture and map when a pipeline uses them.
- Revisit D8's path-key allowlist whenever a transport is granted a new tool or a new adapter is
  added (trigger recorded in D8).

## Verification log

- [x] FR-001 seq monotonicity — `src/runtime/stepLog.test.ts` (15 tests)
- [x] FR-002 claude adapter events — `src/canon/adapters/streamEvents.test.ts`; mutation:
      `tool_result` branch removed → 3 red ("maps a two-Read turn onto tool calls, results, the answer
      and usage" :47, "carries the tool input and the result excerpt" :72, "reports a refused tool call
      as a failed result and a denial (FR-002)" :80); restored green
- [x] FR-003 codex/api adapter events — `streamEvents.test.ts`
- [x] FR-004 check step events — `src/canon/runStep.test.ts`
- [x] FR-005 decision / judge.degraded incl. post-settlement supersede —
      `src/runtime/runService.test.ts` "logs a superseded judge verdict after the run has settled
      (FR-005)"
- [x] FR-006 SSE log delivery order — `src/serve/server.test.ts`
- [x] FR-007 log backfill route incl. disk run via a second server — `server.test.ts` "serves a disk
      run's log from the runs dir this server never ran (FR-007)"
- [x] FR-008 output route — `server.test.ts`
- [x] FR-009 bounds and caps — `stepLog.test.ts`
- [x] FR-010 deny guard, relative/absolute/nested — `stepLog.test.ts`; mutation of the leading-slash
      retry stayed green → branch removed and D8 amended (see D8)
- [ ] FR-011 run view — spec 037 Ship 1b
- [x] FR-012 MCP surface unchanged — `src/bindings/mastra/daemonTools.test.ts:162`
- [x] FR-013 no new persisted fields — `runService.test.ts`
- [x] FR-014 events file complete on cancel/fail — `runService.test.ts`,
      `src/bindings/mastra/buildSteps.test.ts:937` (one terminal result, watchdog attempts [1,2])
- [x] FR-015 declared env scrub — `runStep.test.ts:1661`; mutation: scrub skipped → red at :1669;
      restored green
- [x] V6 live, part 1 (2026-09-14, run `e7505941-18c4-4a73-873d-878700374ae0` on the restarted
      daemon): `test.events.jsonl` created 0600 in the run dir; `check.output` on stdout (eslint, tsc,
      prettier) and stderr (prettier warnings) in arrival order with monotonic `seq`; final `step.result
{status: "failed", error: "exit 1"}`; `GET /api/runs/:id/log` → 200 `application/x-ndjson` +
      `nosniff`, `after=2` honoured, `after=x` → 400; output route → 404 for a check step and 400 for
      a traversal id.
- [ ] V6 live, part 2: `investigate` with tool events and cost — pending the CLI window;
      `code-review` verify table — Ship 1b.
- [x] Security pass 2026-09-14 (0 blocking, 1 major, 5 minor): major — scrub applied only at the
      log sink while `outputExcerpt` carried the value → fixed at the source; minor — `pipelineId`
      unvalidated in log paths → validated; command tokens not matched by the guard → matched;
      result-before-call ordering unasserted → asserted in the fixture test; whole-file parse per
      backfill → line-wise skip; caps not enforced on the post-settlement path → documented.
