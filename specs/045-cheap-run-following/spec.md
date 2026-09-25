# 045. A cheap way to follow a run

| Field        | Value                                                                                     |
| ------------ | ----------------------------------------------------------------------------------------- |
| Feature Name | Persisted step lifecycle, `get_run_events`, and a disk fallback for an unreachable daemon |
| Branch       | `main`                                                                                    |
| Status       | Implemented, uncommitted at spec-writing time — written after the code (see Origin)       |
| Created      | 2026-09-26                                                                                |

## Origin

This spec was written after the implementation it describes, not before it. The standing rule in
this repo is spec-first; this file does not pretend that happened here. It exists so the decisions
below — two of which were tried, rejected, and are recorded with why — are not re-derived the next
time someone touches this surface.

## Context

A calling agent holding a `runId` had two ways to follow a run, and both were bad. It could poll
`get_run`, which re-sends `invocation`, per-step output excerpts and, at a gate, the whole spec
payload on every call — the cost problem spec 044's `get_run` compaction already named for a
different field set. Or it could read Mastra's own LibSQL-backed run snapshot directly: undocumented,
coupled to Mastra's internal storage shape rather than this project's own vocabulary, and prone to
simply never firing again once a poller's assumptions about the blob's shape drifted.

Worse, the transitions that would answer "where is this run right now" without that cost existed only
in memory. `run.watch` accumulated per-step state on the in-process `RunRecord`, but a structural
step's entry into and exit from a state — a gate, `persist-ticket`, `export-spec`, a synthetic merge
step — was never written to the events file the way an `llm` or `check` step's own builder already
writes its `step.start`/`step.result` (spec 036 D1/D2). A run whose daemon restarted, or was read from
disk after the in-process registry lost it, could never again answer what stage it was at. And one
transition had no log representation at all, in memory or on disk: a gate's suspension. The comment
now at `src/canon/stepLogEvents.ts:97-103` states the gap plainly — "Mastra's stream reports the
suspension, but nothing wrote it to the log, so a run waiting on a human read as a run that had simply
stopped emitting."

## Decisions

**D1 — Structural lifecycle lines are identified by inclusion, not by enumerating structural kinds.**
`builderLoggedStepIds` (`src/runtime/runService.ts:337-354`) walks a pipeline's declared steps plus
every loop body's steps, recursively, and collects the ids whose kind is in `BUILDER_LOGGED_KINDS`
(`llm`, `check`, `review-material`; `runService.ts:315-319`). Everything else — gate,
`persist-ticket`, `export-spec`, and Mastra's own synthetic ids (`__merge_level_N`, a loop's outcome
step) — is structural. The comment at `runService.ts:325-331` gives the reason this runs backwards
from what would be simpler: "the structural side cannot be enumerated: Mastra also reports ids no
pipeline author wrote... Anything absent from this set is therefore treated as structural, which is
the safe direction." `builderLoggedStepIds` returns `undefined` when the caller named no pipeline
steps, and `isStructural` (`runService.ts:380-383`) then writes nothing rather than guess — a wrong
guess would double every `llm` step's own log lines.

**D2 — One shared translator, not two copies of the same mapping.** `stepTransitionOf`
(`src/canon/stepTransition.ts:40-58`) is the only place that reads a Mastra stream event and decides
what step transition it describes. It is a leaf module — no imports — so both `run.watch` callbacks
in `RunService` can depend on it without a cycle: the record-level watch registered once per run in
`start()` (`runService.ts:650-652`, wrapped as `transitionOrReport`, `runService.ts:362-377`) and the
per-subscriber watch in `subscribe()` (`runService.ts:1650-1651`). Before this, the module header
explains, the translation "used to be written out twice... and two copies of a mapping table are two
answers to the same question as soon as one of them is edited." `stepTransitionOf` throws
`UnknownStepStatusError` on a status it does not recognise rather than returning `undefined`; only
`transitionOrReport`, on the run path, catches it, logs it with `console.error`, and returns
`undefined` — a test (`stepTransition.test.ts`) sees the raw throw.

**D3 — `step.suspended` is a real event, and it is written before the suspend, not after.**
`StepLogKind` gains `step.suspended` (`stepLogEvents.ts:17`, payload at `stepLogEvents.ts:104-109`).
`buildGateStep` writes it via `appendStepLog` immediately before `await suspend(...)`
(`src/bindings/mastra/buildSteps.ts:838-841`), because Mastra's `suspend()` throws internally to
unwind the step — anything written after it never runs. This is the one gap named in Context that had
no representation at all, in memory or on disk, before this change.

**D4 — A separate `<pipelineId>.progress.jsonl` was considered and rejected.** `BULK_KINDS`
(`stepLog.ts:64-69` — `message`, `tool.call`, `tool.result`, `check.output`) is the only set dropped
once a run's log hits its cap; `step.start` and `step.result` already survive truncation. A second
file bought no truncation safety it did not already have, and `StepResultPayload.status`
(`stepLogEvents.ts:84-95`) was already a 1:1 mapping onto `succeeded | failed | cancelled`. Two files
would have meant two step timelines for one run, with no documented rule for which one to believe when
they disagreed — which they eventually would, being two write paths for the same fact.

**D5 — A `notifyCommand`/`notifyFile` push mechanism was considered and rejected.** The daemon's HTTP
API carries no authentication (spec 042 D10, still true and still not closed by this spec). A shell
command the daemon runs on every transition is remote code execution for anyone who can reach the
port; a caller-supplied file path the daemon appends to is an arbitrary-write primitive with the same
reach. Neither exists in this codebase. The path a caller can act on —
`eventsPath`/`X-Run-Events-Path` — is daemon-derived only: it names the file the daemon already
created under its own state directory (`stepLog.ts` `runLogFile`), never a path a caller supplies.

**D6 — The disk fallback never reports a stale `running`.** When the daemon cannot be reached,
`status` in the MCP read tools' response is always the literal string `"unknown"`
(`daemonDownFields`, `daemonTools.ts:625-636`) — never the value persisted on disk. The persisted
value is quarantined under `lastPersistedStatus`, `lastPersistedAt` and `staleSeconds`
(`readRunFromDisk`, `daemonTools.ts:575-613`), and a persisted `running` or `awaiting_approval` maps
to `"orphaned"` (`ORPHANED_ON_DISK`, `daemonTools.ts:530`), because no daemon is left to ever advance
either of them. The rule the comment at `daemonTools.ts:493-496` states directly: "a daemon that died
mid-run leaves `running` on disk and nothing will ever update it, so reporting that as `status` would
make a polling caller wait forever on a run that stopped hours ago."

**D7 — Mutating tools keep no disk fallback.** `approveRun` and `cancelRun`
(`daemonTools.ts:750-776`, `783-801`) call `daemonFetch` with no `catch` that reaches for disk; an
unreachable daemon propagates as a thrown error, the same as before this spec. The comment on
`approveRun` states why: "a write that quietly reports success is a worse lie than a read that says
'unknown'." Only the read tools (`get_run`, `get_run_events`) gained the fallback.

**D8 — An auto-started daemon's own output now lands somewhere.** `spawnDetachedDaemon`
(`src/bindings/mastra/daemonResolver.ts:138-157`) used to pipe both streams to `/dev/null`
(`stdio: "ignore"`); it now opens `<stateDir>/daemon.log` with
`O_APPEND | O_CREAT | O_WRONLY | O_NOFOLLOW`, mode `0600` (`daemonLogFd`,
`daemonResolver.ts:110-126`), and wires it to both `stdout` and `stderr`. `O_NOFOLLOW` is deliberate:
the state directory is owner-only, but the log's path is predictable, and appending through a symlink
someone else planted there would send the daemon's own output wherever that symlink pointed. This
path only applies to a daemon spawned by `spawnDetachedDaemon` — the MCP auto-start path carrying
`AGENT_FLOWS_AUTOSTART=1` — not to `agent-flows serve` run by hand, which keeps its inherited stdio.

## Functional Requirements

- **FR-001.** `StepLogKind` gains `step.suspended`; `buildGateStep` writes it via `appendStepLog`
  before `await suspend(...)` (D3).
- **FR-002.** The record-level `run.watch` registered in `RunService.start()` writes a structural
  step's `step.start` (`logStructuralStart`, `runService.ts:838-845`) on `workflow-step-start` and its
  terminal `step.result` (`logStructuralResult`, `runService.ts:852-877`) on a finishing or failing
  `workflow-step-result`, gated by `isStructural` (D1). A suspension is explicitly not treated as
  terminal here — `logStructuralResult` returns without writing when the transition is
  `step-suspended`, because the gate's own `step.suspended` line (FR-001) already covers it and the
  step resumes later rather than ending.
- **FR-003.** `stepTransitionOf` (`src/canon/stepTransition.ts`) is the one Mastra-stream-to-lifecycle
  translation, called from both `run.watch` callbacks through the shared `transitionOrReport` wrapper
  (D2). It throws `UnknownStepStatusError` on a step-result status it does not recognise; the run path
  catches and logs it rather than letting the run die, and the pure function itself still throws for
  its own test.
- **FR-004.** `GET /api/runs/:id/log?after=<seq>` gains a `kinds=` query parameter: a comma-separated
  allowlist matched against `RE_LOG_KIND` (`server.ts:166`, applied at `server.ts:2090-2101`), rejecting an
  invalid entry with `400 { error: "invalid kinds" }`. `pipeRunLog` (`stepLog.ts:512-548`) filters on
  each raw line's `kind`, read without a full JSON parse (`kindOfLine`, `stepLog.ts:419-423`), before
  deciding whether to write it to the response.
- **FR-005.** The response carries `X-Run-Max-Seq`: the run's own highest seq
  (`lastSeqOfFile(file)`, `server.ts:2129`), not the highest seq the filtered body actually returned.
  A poller using `kinds=` advances its cursor past every line the filter dropped, not just the ones it
  saw — otherwise a chatty run's filtered poller would re-scan the same unreturned lines on every call.
- **FR-006.** A new MCP tool `get_run_events(runId, sinceSeq?)`
  (`src/bindings/mastra/daemonTools.ts:690-740`, registered in `src/bindings/mastra/server.ts:156-170,
237`) calls the log route with `kinds=` fixed to `LIFECYCLE_KINDS`
  (`step.start, step.result, step.suspended`; `daemonTools.ts:645`) and returns one
  `{seq, at, stepId, kind, status?}` line per transition, plus a `nextSeq` cursor computed from
  `X-Run-Max-Seq` (`nextSeqOf`, `daemonTools.ts:678-681`) — never from the highest seq in the
  filtered body.
- **FR-007.** When the daemon is unreachable, `get_run` and `get_run_events` fall back to reading the
  run's own directory on disk: `status` is always `"unknown"`, `lastPersistedStatus` /
  `lastPersistedAt` / `staleSeconds` carry what the run's artifact or manifest last recorded, and a
  persisted `running` or `awaiting_approval` is reported as `"orphaned"` (D6). `get_run_events`'s disk
  path additionally reads the run's own events file directly (`readRunLog`) and applies the same
  `LIFECYCLE_KINDS` filter in-process, since there is no daemon left to filter it.
- **FR-008.** `approveRun` and `cancelRun` gained no disk fallback; an unreachable daemon still
  surfaces as a thrown error from both (D7).
- **FR-009.** A daemon spawned by `spawnDetachedDaemon` (the MCP auto-start path) redirects its
  `stdout`/`stderr` to `<stateDir>/daemon.log`, opened `O_APPEND | O_CREAT | O_WRONLY | O_NOFOLLOW`
  at mode `0600`, replacing the previous `stdio: "ignore"` (D8).

## Verification

- **V1.** `src/canon/stepTransition.test.ts` — a table asserting `stepTransitionOf` maps every event
  kind this project has seen, plus a separate assertion that an unrecognised `step-result` status
  throws `UnknownStepStatusError` naming the offending status, rather than silently returning
  `undefined`.
- **V2.** `src/bindings/mastra/buildSteps.test.ts:2326-2362` — "writes step.suspended BEFORE
  suspending, so the line survives": a gate step is driven to suspension and the events file is read
  back to confirm the `step.suspended` line, its `message` and its `manualOnly` flag are present.
- **V3.** `src/runtime/runService.test.ts:2735` (`"RunService — structural steps reach the events
file"`) — a gate and a `persist-ticket` step produce their own `step.start`/`step.result` lines
  while a sibling `llm` step's builder-owned lines are not duplicated (`:2754`); a run started with no
  declared pipeline steps writes nothing structural at all, D1's `undefined` branch (`:2776`); and a
  loop body's `llm` step is confirmed builder-logged rather than structural (`:2846`).
- **V4.** `src/serve/server.test.ts:905-942` — `kinds=step.start,step.result` returns only those two
  kinds on the wire, `X-Run-Max-Seq` reflects the run's true highest seq even though the filtered body
  carries far fewer lines, and `kinds=step.start,../../etc` is rejected with `400`.
- **V5.** `src/bindings/mastra/daemonTools.test.ts:770-869` (`"get_run_events — lifecycle lines,
nothing else"`) — the cursor advances past every line the filter dropped, not just the ones
  returned; a cursor ahead of the run's own highest seq never moves backwards or forwards; and the
  response is asserted to carry none of `invocation`, `spec`, `plan`, `result`, `steps`,
  `gateMessage`, or `prompt` — nor any event field beyond `seq`, `at`, `stepId`, `kind`, `status`.

## Out of scope

- Fixing the `settledSteps` loop-body limitation below — documented in the tool description
  (`daemonTools.ts:159`), not fixed.
- Giving `pipeRunLog` a seek offset so a filtered backfill does not re-read the file from byte 0 on
  every request.
- Authentication for the daemon's HTTP API — unchanged from spec 042 D10; `get_run_events` reaches
  the same unauthenticated surface every other read route already does.
- A push mechanism for run transitions (D5, rejected).
- A second, structural-only log file (D4, rejected).

## Risks

- **A loop-body step reads as permanently in flight.** `settledSteps` (`stepLog.ts:53`) is keyed by
  bare `stepId` for the life of the run: `appendStepLog` accepts a step's first `step.result` and
  silently drops every later one for the same id (`stepLog.ts:316-319`). A step inside a `loop` body
  emits one `step.start` per iteration but only the first iteration's `step.result` is ever written —
  every subsequent iteration's finish is dropped. `get_run_events`'s own tool description names this
  plainly rather than hiding it: "do not infer from that that it hung." Pre-existing behaviour, not
  introduced here, and not fixed here.
- **`pipeRunLog` re-reads from byte 0 on every request.** `createReadStream(file, ...)` opens the
  whole file with no start offset (`stepLog.ts:519`); a poller asking for `after=<seq>` still pays to
  stream past everything below it. This spec ships `get_run_events`, a tool whose whole purpose is to
  encourage exactly that kind of polling, without addressing the read cost it multiplies. Deliberately
  deferred, not overlooked.
- **The daemon's HTTP API is still unauthenticated.** `get_run_events` and the `kinds=`/
  `X-Run-Max-Seq` additions to the log route reach the same unauthenticated local surface every other
  route already does; this spec adds no new exposure beyond what spec 042 D10 already recorded as
  open.

---

Note: `pnpm format:check` covers `specs/**.md`; this file has not been run through prettier and must
be formatted before commit.
