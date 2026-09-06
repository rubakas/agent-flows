# 020. Run observability

| Field        | Value                    |
| ------------ | ------------------------ |
| Feature Name | Run observability        |
| Branch       | `020-run-observability`  |
| Status       | Draft                    |
| Created      | 2026-09-07               |

## Context

The intended product shape is: runs start from the host AI CLI chat, and the loopback web UI is where the operator watches and approves them. Today those two surfaces are not connected. Four verified gaps:

1. **The UI only ever shows runs it started itself.** `renderRunPanel()` hides the panel whenever `S.runId` and `S.runStatus` are both unset (`src/serve/ui.html:1424`), and `S.runId` is assigned in exactly one place — after the UI's own `POST /api/runs` succeeds (`src/serve/ui.html:1308`; the only other assignment is the reset to `null` at `:1388`). There is no run list, no picker, and no attach-by-id. A run started from chat or curl is invisible.

2. **The server cannot enumerate runs.** The run routes in `src/serve/server.ts` are: `POST /api/runs` (`:612`), `GET /api/runs/:id/events` SSE (`:647`), `GET /api/runs/:id` (`:694`), and `POST /api/runs/:id/approve` (`:711`). Nothing lists runs.

3. **The registry is in-process, non-enumerable, and per-process.** `RunService` holds runs in a private `Map` (`src/runtime/runService.ts:109`) with no listing method; records hold live `MastraRun` handles needed for `resume()`/`watch()` (`runService.ts:91-104`) and do not survive a daemon restart. Worse: the MCP stdio binding constructs its **own** `RunService` in a **separate process** (`src/bindings/mastra/server.ts:83`) and serves stdio only (`:203`) — it never touches the HTTP daemon. So a chat-started run is not merely hidden from the UI; it is not in the daemon's registry at all. The comment at `runService.ts:2-3` claims MCP, HTTP and the editor "all talk to the same state"; that is true only within one process. Mastra does persist run snapshots to LibSQL (`src/serve/server.ts:977`), but nothing rehydrates them into resumable runs.

4. **No per-step output while a run is in flight.** `GET /api/runs/:id` returns `{runId, pipelineId, status}` plus `error` on failure and `result` (the accumulated context keyed by step id) only on success (`runService.ts:76-87`, `:174-190`; `result` is set only at `:266`). The SSE relay forwards only `{stepId, status}` (`src/serve/server.ts:675`); `RunService.subscribe` itself already drops Mastra's step output, forwarding only id/status/suspendPayload (`runService.ts:300-308`). Spec 019 (FR-005) relies on inspecting step output mid-run — today that FR is satisfiable only after completion.

Secondary: at 1440px the UI wastes most of the window. The pipeline list is capped by `.list-body { max-width: 36rem }` (`ui.html:187-190`); in the editor, `.work` gives the canvas `minmax(0, 1fr)` next to a `19rem` sidebar (`ui.html:240-246`), but nodes inside `.band .row` (`ui.html:296-300`) are intrinsically sized flex items with only `min-width: 9.5rem` and no growth (`ui.html:303-315`), so a linear pipeline renders as a ~300px column against an empty stage.

## Functional Requirements

| ID     | Requirement |
| ------ | ---- |
| FR-001 | `RunService` gains a `list()` method returning, in creation order, one summary per registry entry: `{runId, pipelineId, status, createdAt}`. `RunRecord` gains a `createdAt` timestamp set in `start()`. |
| FR-002 | The daemon gains `GET /api/runs`, returning `{ runs: [...] }` from `RunService.list()`. Summaries carry only the four FR-001 fields — never `result`, `spec`, `gateMessage`, or step output (keeps the list light and shrinks the injection surface). |
| FR-003 | The UI shows the daemon's runs (fetched from `GET /api/runs` on page load, on editor open, and via a manual refresh control — no polling loop) and lets the operator attach to one. Attaching sets `S.runId`, opens the existing SSE stream (`openSse`, `ui.html:1326`), and renders the run panel. Attaching to a run of a different pipeline first opens that pipeline's editor view using the summary's `pipelineId`. |
| FR-004 | Attaching mid-run is complete: the SSE `snapshot` event (already `runService.get()`, `server.ts:666`) now includes per-step state (FR-006), so an attached client renders prior step statuses and, when `status` is `suspended`, renders the gate UI from the snapshot's `gateMessage` rather than only from live step events (today's gate text comes from `S.editedSteps`, `ui.html:1440-1441`, which is empty for an attached run). |
| FR-005 | Runs started from chat land in the daemon's registry: the MCP tools `run_pipeline`, `approve`, and `get_run` in `src/bindings/mastra/server.ts` become thin HTTP clients of the daemon at `http://127.0.0.1:<port>` (default 7411, `server.ts:335`), instead of running their own embedded Mastra + `RunService`. `run_pipeline` preserves its blocking contract by polling `GET /api/runs/:id` (~1 s interval) until status leaves `running`; `approve` already blocks daemon-side (`server.ts:728`). If the daemon is unreachable, the tool returns a clear error instructing the operator to start `agent-flows serve` — no silent fallback to an invisible embedded run. |
| FR-006 | Per-step output is observable in flight. `RunService.start()` attaches one record-level `watch` and accumulates `steps: Record<stepId, {status, outputExcerpt?, outputTruncated?}>` on the `RunRecord`, where `outputExcerpt` is the step output serialized and truncated to 2 048 characters. `GetResult` gains `steps`; the SSE `step` event gains `outputExcerpt`/`outputTruncated` on step finish. No new route. |
| FR-007 | Everything from FR-002/FR-004/FR-006 that reaches the DOM — run ids, pipeline ids, statuses, gate messages, and especially `outputExcerpt` — is rendered as text through the existing `escH()` (`ui.html:886`), never via unescaped `innerHTML` interpolation. Step output can contain content from an untrusted repository; treat every excerpt as hostile markup and hostile prompt text. The UI displays it; it never feeds it back into any request body. |
| FR-008 | Runs do NOT survive a daemon restart, and `GET /api/runs` after restart returns an empty list. This is deliberate — see Design. |
| FR-009 | Layout: `.list-body` max-width raised (36rem → 56rem) and `.node` gains `flex: 1 1 12rem; max-width: 24rem` so bands use available stage width. No other layout change. |

## Design

**Run list + picker (FR-001–FR-004).** The smaller alternative — an "attach by id" text field with no list route — was rejected: run ids are UUIDs the operator would have to copy out of chat, and the daemon already holds everything needed for a list; `list()` plus a ~15-line route is less friction than paste-a-UUID forever. The registry `Map` iterates in insertion order, so no sort machinery is needed. Unknown step ids in an attached run degrade safely — the canvas lookup already null-checks (`ui.html:1352-1356`).

**Chat visibility (FR-005).** This is the load-bearing decision. Two processes each owning a private registry can never show each other's runs; the comment "MCP, HTTP and the web editor all share the same runs" (`runService.ts:2-3`, `bindings/mastra/server.ts:80-81`) is only true per process today. Alternatives: (A) MCP tools proxy to the daemon's HTTP API — one registry, chat runs become listable, attachable, and approvable from either surface, and the MCP process actually *loses* code (its embedded Mastra build, LibSQL store, and RunService go away); (B) a cross-process registry via SQLite — rejected, because approving requires a live `MastraRun` handle (`runService.ts:216`) that cannot cross a process boundary without Mastra rehydration machinery. Commit to (A). Cost: chat runs now require the daemon to be up; for a personal tool where `serve` is the daemon anyway, an actionable error ("start agent-flows serve") is acceptable.

**Per-step output (FR-006).** The `GET /api/runs/:id/steps/:stepId` alternative was rejected: there is currently no per-step storage to read from, so either mechanism must add accumulation to `RunRecord` — after which a dedicated route adds a second endpoint, a second fetch path in the UI, and no capability the SSE event + snapshot don't already deliver. Attaching the accumulating watch in `start()` (not per SSE subscriber, as `subscribe()` does today at `runService.ts:287-311`) means output is captured even when no client is watching, which is what makes mid-run attach useful. The 2 048-char bound keeps SSE frames and snapshots small; the full accumulated context remains available from `result` after completion, unchanged — spec 019's FR-005 becomes fully satisfiable mid-run.

**Restart (FR-008).** No persistence, argued: a restart kills the background `run.start()` promise and its child step processes, so an "in-flight" run after restart is not resumable regardless of what a list claims — showing it would be a lie. Mastra's LibSQL snapshots exist (`server.ts:977`) but rehydrating them into resumable runs is exactly the machinery this single-operator tool does not need: the durable artifacts (written files, tickets in `agent-flows.sqlite`, captured SSE traces per spec 019) are already on disk. If a restarted daemon ever needs run history, that is a future read-only view over the Mastra store, not a registry feature.

**Layout (FR-009).** One paragraph, one decision: the pipeline list stops being capped at 36rem (`ui.html:187-190`), and nodes grow to share band width instead of hugging `min-width: 9.5rem` (`ui.html:303-315`). The `.work` grid (`ui.html:240-246`) and the ≤800px breakpoints stay as they are. Not a redesign.

## Backward compatibility

- All existing routes keep their shapes; `GetResult` and the SSE `step` event gain optional fields only, so current consumers (spec 019's capture procedure, `server.test.ts`) keep working.
- The MCP tool schemas (`run_pipeline`, `approve`, `get_run`, `list_pipelines`) are unchanged from the chat client's perspective; only their transport changes. `run_pipeline`'s blocking behaviour is preserved via polling.
- `POST /api/runs` from curl behaves as before; such runs simply become visible.
- New behaviour on failure: MCP tools error loudly when the daemon is down (previously they worked standalone). This is the one intentional break, stated in FR-005.

## Out of scope

- Persisting or rehydrating runs across daemon restarts (argued in Design).
- Multi-operator concerns: auth on `GET /api/runs`, per-user filtering. The daemon binds loopback only (`server.ts:335`).
- Streaming full step output or token-level streaming; the excerpt bound is fixed, not configurable.
- Any redesign of the canvas, bands, or inspector beyond FR-009's two CSS values.
- Cancelling/killing a run from the UI.

## Test plan

1. **List route shape and filtering** — start two runs via `POST /api/runs`, then `GET /api/runs`: exactly two summaries, in creation order, each with exactly `runId`, `pipelineId`, `status`, `createdAt` and — asserted explicitly — **no** `result`, `spec`, `gateMessage`, or `steps` keys.
2. **List rendering is escaped** — with a pipeline whose id contains `<b>&"'` (or a stubbed list response containing it), the rendered picker DOM contains the escaped entities and no injected element; same assertion for an `outputExcerpt` of `<img src=x onerror=alert(1)>` in the run panel. Both must pass only via `escH()` (`ui.html:886`).
3. **Attach to a foreign run** — start a run via curl (not the UI), open the UI, pick the run: panel unhides, snapshot populates prior step statuses, subsequent SSE `step` events update nodes.
4. **Attach to a suspended run** — start a gated run via curl, wait for `suspended`, attach: gate message and Approve/Reject render from the snapshot; approving resumes the run (single-flight guard still holds).
5. **Excerpt bounding** — a step producing > 2 048 chars of output yields `outputExcerpt.length === 2048` and `outputTruncated: true` in both the SSE event and the snapshot `steps`; the post-completion `result` still contains the full output.
6. **MCP proxy** — with the daemon up, `run_pipeline` via MCP returns the same settled shape as before and the run then appears in `GET /api/runs`; with the daemon down, the tool returns the actionable error and no run is created anywhere.
7. **Restart behaviour** — restart the daemon after a completed run: `GET /api/runs` returns `{ runs: [] }` and `GET /api/runs/:id` for the old id returns 404.
8. **Layout (manual)** — at 1440px the pipeline list and a linear pipeline's bands visibly use the available width; the ≤800px stack (`ui.html:247-251`, `:403-408`) is unchanged.
