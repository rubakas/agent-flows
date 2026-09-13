# 033. Run control (cancel, progress, port)

| Field        | Value                    |
| ------------ | ------------------------ |
| Feature Name | Run control              |
| Branch       | `033-run-control`        |
| Status       | Implemented — 2026-09-13 |
| Created      | 2026-09-13               |

## Problem

A running run cannot be stopped: no HTTP route, no MCP tool, no CLI verb, no signal handler
(grepping `cancel|abort|stop` across `src/serve`, `src/runtime`, `src/bindings/mastra/server.ts`,
`src/cli.ts` finds none). The only lever is rejecting at the next gate
(`RunService.approve(runId, false, reason)`, `src/runtime/runService.ts:474-535`), and killing the
daemon drops the in-memory registry (`registry = new Map<string, RunRecord>()`,
`runService.ts:253`) with it.

The chat tool `get_run` (`src/bindings/mastra/server.ts:207-239`) returns only
`runId, pipelineId, status, result, gateMessage, spec`, dropping the daemon's own per-step `steps`
map (`GetResult.steps`, `runService.ts:140`) which the daemon already accumulates from
`run.watch()` (`runService.ts:350-378`).

`README.md:84` says `AGENT_FLOWS_PORT` overrides the serve port, but the CLI entrypoint reads only
`--port` (`getArgValue("--port", "7411")`, `src/serve/server.ts:1710`) — the MCP client is the only
reader of `AGENT_FLOWS_PORT` (`DAEMON_PORT`, `src/bindings/mastra/server.ts:21`). A second daemon on
a taken port fails via the raw `server.on("error", reject)` handler (`server.ts:487`) with no
operator-facing message.

## Goals / Non-goals

**Goal.** An operator can stop an in-flight run from HTTP, MCP, or the UI, as a real abort that
kills spawned children and cleans up sanitized copies — not a status flip. `get_run` reports the
same per-step progress the daemon already tracks. The daemon's port config matches what the README
and the MCP client already assume.

**Non-goals.** Run deletion/retention; a `cancel` CLI verb (follow-up); new supervision mechanisms
beyond the existing `deps.signal` (D1); changes to Bindings A or C.

## Decisions

**D1 — Cancel = abort.** `RunService.cancel(runId, reason?)` aborts the run's `AbortController` —
the same `deps.signal` that `withDeadline` (`src/canon/stepRuntime.ts:203-235`) and every adapter's
spawn already honour (claude: `runClaudeCli.ts:467-475` `child.kill("SIGTERM")` on abort; codex:
`adapters/codex.ts:177-183` same, sanitized copy removed via `grant.cleanup()` in the existing
`finally` at `:264-266`) — so children die and copies are swept with no new per-adapter code.
`cancel()` marks the run `"cancelled"` (new terminal value in the `status` unions on `GetResult`,
`RunSummary`, `RunRecord` — `runService.ts:136,167,199`; the UI's `statusClass()`,
`src/serve/ui.html:976-983`, already maps `"cancelled"` into its `failed` bucket, so this decision
makes that branch reachable for the first time), records `cancelledAt`/`reason`, emits a
`step-cancelled` event for the in-flight step (new `StepEvent["kind"]` member, `runService.ts:81`),
and persists the artifact via the existing `persistArtifact` path (`:965-1010`) so the manifest
reflects it. The per-run signal is Mastra's: `RunService.cancel()` calls `record.run.cancel()`,
whose `abortController` fires the `abortSignal` that Mastra hands to every step's execute context.
`BuildDeps.runnerDeps` is build-time and shared across concurrent runs, so it must never carry a
signal. See FR-013.

**D2 — Surfaces.** `POST /api/runs/:id/cancel` → 204 when the run was `running` or
`awaiting_approval`, 409 with the current status when the run exists in an uncancellable status
(mirrors `approve`'s 409 shape, `server.ts:1165-1169`), 404 for an unknown id. MCP tool
`cancel_run { runId, reason? }` → `{ runId, status }`, added beside `approveTool`
(`src/bindings/mastra/server.ts:165-205`). A Cancel button in the UI's run detail
panel (`renderRunDetail`, `ui.html:1122-1193`), shown for `running`/`awaiting_approval`. Cancelling
an `awaiting_approval` run resolves the pending gate via the existing reject path (reusing
`GateRejectedError` handling, `runService.ts:571-578`), but the recorded terminal status is
`cancelled`, never `rejected` — see FR-006.

**D3 — `get_run` progress.** `get_run` forwards the daemon's `steps` map
(`id → { status, startedAt, finishedAt, outputExcerpt, error }`) and a new `updatedAt` field
(`src/bindings/mastra/server.ts:207-239`, today reads/returns only the subset at `:222-237`).
`startedAt`/`finishedAt`/`error` are new fields on `StepState` (today `{ status, outputExcerpt?,
outputTruncated? }`, `runService.ts:125-131`). `run_pipeline`'s polling loop
(`server.ts:129-161`) is unchanged — it already polls `GET /api/runs/:id` and inspects `status`
only.

**D4 — Port.** The CLI entrypoint reads `AGENT_FLOWS_PORT` as the default and lets `--port`
override it: `getArgValue("--port", process.env.AGENT_FLOWS_PORT ?? "7411")` replacing
`server.ts:1710`. This makes `README.md:84`'s existing claim true and matches the MCP client, which
already reads the same var (`server.ts` mastra binding `:21`) — no README edit needed. On
`EADDRINUSE` from `startServer()`'s `listen()`, the CLI's `await startServer(...)` call (`:1796`)
is wrapped to print `port <n> is already in use — is another agent-flows daemon running? pass
--port <other> or stop it` to stderr and exit 1, with no stack trace. The `listen` error handler is
scoped to the listen phase; after a successful listen it is removed so a later socket error cannot
reject a settled promise.

**D5 — Cancel is not delete.** A cancelled run stays in `list()`'s output (`runService.ts:451-458`)
like any other terminal run; deletion/retention is out of scope.

## Functional Requirements

- **FR-001.** `cancel()` aborts the run's `AbortController`, propagating through `deps.signal` into
  every adapter's `withDeadline`, killing claude/codex children via their existing `SIGTERM` abort
  listeners; the codex sanitized copy is removed by its `finally` cleanup as a side effect, not a
  new explicit call.
- **FR-002.** `cancel()` sets `record.status` to a new terminal value `"cancelled"` on the `status`
  type shared by `GetResult`, `RunSummary`, `RunRecord`, and records `cancelledAt` + optional
  `reason` on the record.
- **FR-003.** `cancel()` emits a `step-cancelled` `StepEvent` (new `StepEvent["kind"]` member) for
  the step in flight, delivered over SSE the same way `step-failed`/`step-suspended` are today
  (`STEP_STATUS` map, `server.ts:78-83`, gains a `"step-cancelled": "cancelled"` entry).
- **FR-004.** `cancel()` calls `persistArtifact()` after the status transition so the artifact and
  chain manifest entry (`upsertManifestEntry`, `runService.ts:1001-1008`) show `status: "cancelled"`.
- **FR-005.** `POST /api/runs/:id/cancel` returns 204 when the pre-call status was `running` or
  `awaiting_approval`. An unknown run id returns 404. 409 is returned only when the run exists but
  is not cancellable, with `{ error, status }` carrying the current status: "cannot be cancelled
  now" and "no such run" are different facts, and collapsing them would make a typo'd id
  indistinguishable from a finished run.
- **FR-006.** Cancelling an `awaiting_approval` run sets a `cancelled` flag on the record before
  resolving the gate via the reject path, and `applyWorkflowResult` (runService.ts ~:573-577) leaves
  the status as `cancelled` when that flag is set; the terminal status is `cancelled`, never
  `rejected`.
- **FR-007.** MCP tool `cancel_run { runId, reason? }` proxies to `POST /api/runs/:id/cancel` and
  returns `{ runId, status }` on success or `{ error }` on failure, following the existing
  `daemonFetch` proxy pattern (`server.ts:24-38`).
- **FR-008.** The UI's run detail panel shows a Cancel button when `status` is `running` or
  `awaiting_approval`, confirms before sending (same pattern as the existing Reject button,
  `ui.html:1181`), and calls the cancel route.
- **FR-009.** `GetResult` gains `steps: Record<string, StepState>` with `startedAt`, `finishedAt`,
  `error` added to `StepState`, and a top-level `updatedAt`, populated by the existing
  `run.watch()` accumulator with new timestamp/error bookkeeping.
- **FR-010.** The MCP `get_run` tool forwards `steps` and `updatedAt` from the daemon's response in
  addition to the fields it already returns; `run_pipeline`'s terminal-status set gains `cancelled`
  so a cancelled run stops the poll; every hand-written `status === "running"` / terminal-set
  comparison in runService.ts, server.ts, mastra/server.ts and ui.html is enumerated in the
  implementation and covered by V6.
- **FR-011.** The daemon CLI reads `AGENT_FLOWS_PORT` as the default port, with `--port` taking
  precedence when both are set (`server.ts:1710`); `README.md:84` requires no edit once this lands.
- **FR-012.** On `EADDRINUSE` from `startServer()`'s `listen()`, the CLI prints the FR-covered
  message to stderr and exits 1, with no stack trace surfaced.
- **FR-013.** `buildLlmStep`, `buildCheckStep` and every other executing step destructure
  `abortSignal` from Mastra's execute params and pass it as `StepRunnerDeps.signal` (combined with
  any existing signal via `AbortSignal.any`). Two concurrent runs on one built workflow have
  independent signals. A step whose execute begins after the run was cancelled throws immediately
  without spawning.
- **FR-014.** `runCheckStep` honours `deps.signal` even when no deadline is created: the
  SIGTERM/SIGKILL listener attaches to `deps.signal` directly when `effectiveTimeoutMs <= 0`.
- **FR-015.** `runCheckStep` spawns with `detached: true` and kills the process group
  (`process.kill(-pid, "SIGTERM")`, then `SIGKILL` after the escalation delay), so forked
  grandchildren die with the shell.

## Verification

- **V1.** Unit: start a run whose in-flight step is a fake `spawn` that never exits, call
  `cancel()`, assert status `"cancelled"`, the fake child received `SIGTERM`, and (codex path) the
  sanitized copy directory no longer exists. Two concurrent runs on the same built workflow:
  cancelling A leaves B running and B completes. Mutations: (a) drop `run.cancel()` → red; (b) move
  the signal into `BuildDeps.runnerDeps` → the two-run test goes red.
- **V2.** Route tests: `POST /api/runs/:id/cancel` on a running run → 204, a second call on the
  same id → 409 with `"cancelled"`; a call on an already-`"succeeded"` run → 409.
- **V3.** MCP tests against a fake daemon: `cancel_run` returns `{ runId, status: "cancelled" }` on
  204 and `{ error }` on 409; `get_run` returns a `steps` object matching the fake daemon's response
  verbatim, including `startedAt`/`finishedAt`/`error` per step.
- **V4.** Port: bind a socket on a free port to reserve it, start the daemon with `AGENT_FLOWS_PORT`
  set to that port and no `--port` → exact FR-012 stderr message, exit code 1. Separately: set both
  `AGENT_FLOWS_PORT=X` and `--port=Y` → the daemon binds `Y` (FR-011 precedence).
- **V5.** Live: in a temp project, write `.agent-flows/config.json` holding
  `{"checkCommand": "sleep 60"}`. The check command reaches the step through `{{checkCommand}}`
  substitution at _build time_ from that file, never from run inputs — interpolating run context
  into a shell string is command injection (`buildCheckStep`). Start the daemon against that
  project, `POST /api/runs {pipeline:"test", inputs:{}}`, then `POST /api/runs/:id/cancel` after
  2s. Within 5s: `GET /api/runs/:id` reports `"cancelled"`, `pgrep -f "sleep 60"` empty, artifact
  `status` is `"cancelled"`; repeat with `{"checkCommand": "sh -c 'sleep 60 & wait'"}` proving the
  grandchild dies.
- **V6.** `pnpm check` green with `"cancelled"` and `step-cancelled` threaded through every
  exhaustive match on the `status`/`StepEvent["kind"]` unions (only `STEP_STATUS` at
  server.ts:78-83 is exhaustive; the enumerated comparisons from FR-010 each get an assertion).

## Risks

- Mastra may keep its own run-level status independent of the registry; per `README.md:86` the
  daemon's registry is the source of truth, so `cancel()` does not query any Mastra-side cancel API.

## Follow-ups

- Research Mastra's/T2's `requiredActions` as an alternative progress surface on the run resource.
- Run deletion/retention policy (D5 leaves cancelled runs listable indefinitely).
- An `agent-flows cancel <runId>` CLI verb once the HTTP route (D2) exists to proxy to.

## Verification log (2026-09-13)

V5 live: `sleep 60` and `sh -c 'sleep 60 & wait'` check steps were both cancelled through the route in
about 2 s with no surviving processes; the artifact and the manifest stage carry `cancelled`,
`cancelledAt` and `reason`, and the chain status is `cancelled`. A second cancel returns 409 and an
unknown run id returns 404. Mutations a–g are all red, with g proven red-not-hang after the test fix.
Two defects surfaced only by the live run and were fixed: a late result resurrecting a cancelled step,
and the manifest chain status ignoring `cancelled`.
