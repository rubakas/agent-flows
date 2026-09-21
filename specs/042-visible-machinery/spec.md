# 042. Visible machinery

| Field        | Value                                                |
| ------------ | ---------------------------------------------------- |
| Feature Name | Visible machinery                                    |
| Branch       | `feat/042-visible-machinery` (not yet created)       |
| Status       | Draft — design only, not approved for implementation |
| Created      | 2026-09-21                                           |

## Context

Owner ask, verbatim: "ui має показувати в якому проекті скільки демонів запущено, кожен демон ми
маємо мати можливість подивитись що там діється та мати можливість зупинити, бо так вони невидимі
для мене" — the UI must show, per project, how many daemons are running; each must be inspectable
and stoppable; right now they are invisible.

**The incident that proves it.** On 2026-09-21 two agent-flows daemons were found running for over
two days — pid 36859 from the global install and pid 54733 from the source checkout — with the
owner unaware of either. The consequence was not cosmetic: the owner was looking at a page served
by a stale build and could not understand why his changes were absent. Invisible machinery produced
a wrong mental model of the system.

The owner's framing for the page as a whole: **minimalism is the priority, plus workflow
precision**; the interface today is _"не дуже зрозумілий і дубльований"_ — unclear and duplicated.

### What already exists

- `src/serve/stop.ts` reads a per-project `daemon.json` recording `{projectDir, version, pid,
startedAt, port}` (`DaemonRecord`, `src/runtime/daemonRecord.ts:22-32`). Its header states the
  safety rule verbatim: "A recorded pid is never killed on the strength of the record alone: pids
  are recycled by the operating system, so a stale daemon.json naming a pid that now belongs to
  someone else's process would otherwise make `stop` a random process killer." The process at the
  recorded port is verified first by calling `GET /api/daemon` and matching the recorded pid and
  project (`stopProjectDaemon`, `stop.ts:71-153`; `probeDaemon`, `daemonRecord.ts`).
- `GET /api/daemon` (`server.ts:1069-1078`) returns `{projectDir, version, pid, startedAt}` —
  exactly `DaemonIdentity` (`daemonRecord.ts:22-27`), no port.
- Per-project state lives under `<stateRoot>/projects/<key>/` (spec 032;
  `src/runtime/projectState.ts:6,104-115`), one `daemon.json` per project directory when that
  project's daemon has been started at least once. `stop.ts`'s own `listProjectStateDirs`
  (`stop.ts:156-167`) already enumerates every such directory from disk via `readdirSync`; this
  spec's project list reuses that enumeration, not a new one.
- **One daemon serves one project.** The daemon resolves `projectDir` once, at process start
  (`opts.projectDir ?? process.cwd()`, `server.ts:588`), and every request handler reads the one
  closed-over `ctx.projectDir`. No route takes a project from the request. That was spec 039's
  central constraint (still Draft, unimplemented) and it still holds today.
- CLI verbs `stop [--all]` and `list` already exist (`src/cli.ts:46-59`, `stop.ts:186-196`).
- The page is a single static file, `src/serve/ui.html` (~3170 lines), plus small ESM helper
  modules served from an explicit allowlist, `STATIC_MODULES` (`server.ts:161-167`):
  `ui-route.js`, `ui-graph.js`, `ui-log.js`, `ui-tables.js`, `ui-providers.js`. Any new module must
  be registered there **and** in `scripts/copy-dist-assets.mjs`.
- Live run progress already streams over SSE at `GET /api/runs/:id/events`
  (`RE_RUN_EVENTS`, `server.ts:148,1861`); the runs list itself polls `GET /api/runs`
  (`server.ts:1852-1853`) every 4 seconds while the runs view is open (`ui.html:1926`).
- `GetResult.steps` (`src/runtime/runService.ts:194-211`) is `Record<string, StepState>`, keyed by
  step id, always present; `RunInvocation.pipeline` (`runService.ts:169-181`) names the pipeline. A
  pipeline's own declared step list is `PipelineDef.steps: StepDef[]` (`src/canon/types.ts:205`).
  Synthetic merge steps carry ids of the shape `__merge_level_<n>` and have no entry in a
  pipeline's own declared `steps` array (`src/runtime/runService.test.ts:968-986`) — they are
  Mastra's own bookkeeping for parallel branches, not a step the pipeline's author wrote.
- The Templates view is being deleted in separate, already-approved work — not specced here.

## Decisions

**D1 — The page opens on live state, not on a list.** Order: what is running now (daemons across
every project, then in-flight runs) → recent history → workflows and settings as subordinate
destinations. The product is a control surface for machinery running on the operator's own
machine; the most characteristic fact in that world is what is happening right now.

**D2 — Daemons are listed across ALL projects, not just the serving daemon's own.** Enumerated from
`<stateRoot>/projects/*/daemon.json`, reusing `listProjectStateDirs`'s enumeration
(`stop.ts:156-167`). This does not violate spec 039's one-daemon-one-project constraint: the page
only reads and reports other projects' records, it never dispatches a run against them. The daemon
serving the page has no route that accepts a foreign `projectDir` for execution, and this spec adds
none.

**D3 — A daemon record is never trusted on its own.** Before the page reports a project's daemon as
running, or offers to stop it, the record's port is probed with `GET /api/daemon` and the response's
`pid` and `projectDir` are matched against the record — the same rule `stopProjectDaemon` already
enforces (`stop.ts:94-124`), for the same reason: pids are recycled by the OS. A record whose port
answers with a mismatched pid or project, or does not answer at all, is reported as **stale**, not
as running, and is never offered a stop action wired to the recorded pid.

**D4 — Stop is an explicit, per-daemon action in the UI, reusing the existing stop path.** The page
does not gain a new kill mechanism; it drives `stopProjectDaemon` (`stop.ts:71-153`) — same
verification (D3), same SIGTERM, same wait-for-exit — through a new route, not a shell-out.

**D5 — Minimalism means no ornament, not little information.** This is an instrument panel for one
expert operator; density is a virtue. Monospaced tabular figures are used only for values that must
align in a column — pid, port, duration, cost — never for labels.

**D6 — A run's current step is visible without navigating into the run.** The runs list shows
pipeline, current step id, position (N of M) and elapsed time inline, sourced from the same
`GetResult` (`runService.ts:194-211`) the run detail view already reads — no new per-run endpoint.

**D7 — `__merge_level_*` steps are excluded from any "N of M" count and from "current step."** They
are Mastra's own synthetic bookkeeping for parallel merge branches, not a step the pipeline author
declared (`PipelineDef.steps`, `types.ts:205`) or a step an operator would recognise. M is the count
of the pipeline's own declared steps; "current step" is the most recent non-`__merge_level_*` step
with status `"running"` — if none is running (a merge is in flight, or the run is between steps),
the last step to leave `"running"` is shown, labelled as such, rather than showing a synthetic id.

**D8 — Destructive-action posture: confirm, no undo.** Stopping a daemon has no undo — the process
is gone once `stopProjectDaemon` confirms it stopped (`stop.ts:126-152`). The page requires an
explicit confirm step before issuing the stop (naming the project and pid being killed) and shows
the outcome (`stopped` / `no-daemon` / `unresolved`, `stop.ts:38`) inline afterward; it does not
retry or auto-resolve an `unresolved` outcome.

**D9 — A daemon cannot report itself as stopped, because the page is served by the daemon it just
killed.** Stopping the project the page's own serving daemon belongs to succeeds at the process
level (D4) but the page has no daemon left to ask for a fresh state — the UI marks that row
"stopping…" on request and then shows a disconnected/stale banner rather than a false "stopped"
confirmation it cannot actually observe. Stopping a _different_ project's daemon (the common case
under D2) has no such gap: the serving daemon stays up and reports the new state on its next poll.

**D10 — No authentication exists today; this spec does not add it.** `isAllowedOrigin`
(`server.ts`) defends against a browser, not against another local process — any process on the
machine can already call the daemon's HTTP API, including this spec's new stop route. Recorded here
as a risk (see Risks), not closed by this spec.

**D11 — An auto-started daemon reaps itself when idle; a human's daemon never does.** (Added
2026-09-22, after measuring it.) The MCP process spawns a daemon detached and unreferenced
(`daemonResolver.ts:117-121`) so a run survives the chat that started it — correct, and the reason
nothing stops it afterwards: the chat exits, its ephemeral port is never dialled again, and the
process runs until reboot. Measured end to end: a workflow started over MCP in a project with no
daemon left one answering on port 60478 with its run long finished and no client attached. The
daemons panel makes that visible; this closes the other half. Only a daemon carrying the
`AGENT_FLOWS_AUTOSTART` marker is a candidate, because a daemon started by hand has an owner who
expects it on the conventional port. A run that is executing **or suspended at a gate** keeps it
alive — exiting under a gate would strand an approval nobody can give. Only `live` runs count: a run
persisted as `running` by a process killed mid-step stays `running` on disk forever, and counting
those would pin every future daemon for that project open on the strength of an old crash.

**D12 — One page reads every project, by forwarding rather than by reworking the server.** (Added
2026-09-22 on the owner's ask: "мені не дуже подобається що я маю перемикатись між портами".) A
daemon binds one project at startup and no route takes a project from the request, so seeing two
projects meant opening two ports. Spec 039 fixes that properly — one daemon, a `project` parameter on
every route — and is a rework of ~40 routes. This is the cheap 90%: a request to
`/api/projects/:projectKey/api/...` is forwarded by the daemon whose page is open to that project's
own daemon, and the page prefixes every call with the project the operator picked.

The target port is never taken from the request — it is read from that project's `daemon.json` and
verified by the same probe D3 already requires, so this cannot be aimed at an arbitrary host or port.
A nested proxy path is refused, or two daemons could bounce a request between them. The response is
piped, not buffered, because the run view reads progress over SSE and a buffered forward would hang
the very view this exists to show. `GET /api/daemons` is the one call that is never forwarded: it is
machine-wide already, and its `self` flag is computed by whichever daemon answers, so forwarding it
would put "serving this page" on the wrong row.

**This is a stepping stone, not a substitute.** When spec 039 lands, the proxy route is deleted; the
page's picker and its one API seam are what survive.

## Functional Requirements

- **FR-001.** A new `GET /api/daemons` route enumerates every project state directory via
  `listProjectStateDirs` (`stop.ts:156-167`), reads each one's `daemon.json`
  (`readDaemonRecord`, `daemonRecord.ts`), and for each record present, probes `GET /api/daemon` on
  its recorded port and reports `{projectDir, pid, port, startedAt, live: boolean}` — `live` is
  `true` only when the probe's `pid` and `projectDir` match the record (D3); a present-but-stale
  record is reported with `live: false`, never omitted (D2, D3).
- **FR-002.** The page's landing view lists every project reported by FR-001 with a live daemon,
  showing project directory (basename plus full path), pid, port, uptime since `startedAt`, and a
  Stop action; a stale record (`live: false`) is shown distinctly (e.g. "not responding") with no
  Stop action wired to it, since D3 forbids signalling an unverified pid (D1, D2, D3, D5).
  A live daemon that is not the one serving the page carries its port as a link to its own page,
  which is the only place that daemon's runs can be read; the serving daemon's own port is not a
  link, because it leads back here, and a stale port is not a link, because nothing answers it.
- **FR-003.** A new `POST /api/daemons/:projectKey/stop` route (or equivalent scoped by the
  project's state-dir key) calls `stopProjectDaemon` (`stop.ts:71-153`) for exactly that project's
  state directory and returns its `StopReport` (`stop.ts:41-49`) verbatim; the page shows a confirm
  step before calling it, naming the project and pid, and renders the returned `outcome`
  (`stopped` / `no-daemon` / `unresolved`) after the call completes, with no automatic retry (D4,
  D8).
- **FR-004.** Stopping the project the serving daemon itself belongs to is not specially refused,
  but the page marks that row "stopping…" immediately on request and, once the connection to the
  serving daemon is lost, shows a disconnected/stale state rather than claiming `stopped` on the
  daemon's own authority (D9).
- **FR-005.** The runs list (`GET /api/runs` consumers) renders, per running run, the pipeline id
  (`RunInvocation.pipeline`), the current non-`__merge_level_*` step id per D7, its position as
  `N of M` where M excludes `__merge_level_*` entries and N is that step's 1-based index among the
  pipeline's own declared `steps` (`types.ts:205`), and elapsed time since the run's own start —
  without navigating into the run (D6, D7).
- **FR-006.** The empty state for "no daemons running" and for "no runs in progress" is an explicit
  invitation to act (e.g. a way to start a run / a pointer to Workflows), never a bare "nothing
  here" — consistent with D5's density-over-ornament framing applied to the one place there is
  nothing to be dense about.
- **FR-007.** `ui-daemons.js` (new) is added to `STATIC_MODULES` (`server.ts:161-167`) and to
  `scripts/copy-dist-assets.mjs`, matching the existing pattern of every other `ui-*.js` helper
  module.
- **FR-008.** A daemon started with `AGENT_FLOWS_AUTOSTART=1` exits 0 and removes its own
  `daemon.json` after 15 minutes during which it served no HTTP request and carried no `live` run in
  `running` or `awaiting_approval`. A daemon without that marker never exits on this path however
  long it is quiet. The span is overridable by `AGENT_FLOWS_IDLE_MS` — a test seam, not a documented
  knob, because the exit path ends the process and can only be observed from outside.
- **FR-009.** `GET|POST|PUT|DELETE /api/projects/:projectKey/api/...` forwards to the port recorded
  for `:projectKey`, streaming the response, and refuses with 502 naming the project when that key is
  unknown or its daemon is not answering. A nested `/api/projects/` path is not forwarded at all. The
  page carries the selected project in `?project=`, prefixes every API call with it, and leaves
  `GET /api/daemons` unprefixed.

## Verification

- **V1.** A stale `daemon.json` (port not answering, or answering with a different pid or
  `projectDir`) is reported `live: false` by `GET /api/daemons` and is never offered a Stop action
  wired to its recorded pid — proven by starting a probe against a closed port and against a
  mismatched identity, mirroring `stopProjectDaemon`'s own three refusal branches
  (`stop.ts:94-124`).
- **V2.** Stopping a project via the new route produces the same `StopReport.outcome` as calling
  `stopProjectDaemon` directly for that state directory — proven by comparing both call paths
  against the same fixture daemon.
- **V3.** `__merge_level_*` step ids never appear as "current step" and never count toward M in
  `N of M`, proven against a run record containing at least one such id (the fixture already used
  by `runService.test.ts:968-986`).
- **V4.** Stopping the serving daemon's own project does not render a false `stopped` state once the
  connection drops — proven by a test that stops the project under test and asserts the UI's own
  observed state is "disconnected," not "stopped."
- **V5.** The daemon list and the runs list both render an explicit call-to-action, not a bare
  empty string, when either is empty.

## Out of scope

- The scheduler (separate work).
- Authentication — the daemon stays unauthenticated; see Risks.
- Model autoselect (spec 041).
- The ADR-0019 renames.
- The Templates view (being deleted in separate, already-approved work).
- Spec 039's shared multi-project daemon — this spec is built against today's one-daemon-one-project
  shape and reads other projects' state from disk, exactly as `stop.ts` already does; it does not
  require or assume spec 039.

## Risks

- **No authentication.** Any local process can already call every daemon route, including this
  spec's new stop route; a stop button makes that reach concretely destructive for the first time
  in this UI (D10). Not closed here — spec 039 D15 designed a token for its own, different reason
  (a shared daemon accepting a project by name) and would cover this too if implemented, but that
  spec is still Draft.
- **The serving daemon cannot observe its own death.** D9/FR-004 is a UX accommodation, not a fix —
  there is no way for a process to truthfully report "I have stopped" after it has stopped.
- **Stale records may accumulate silently.** A crashed daemon that never removed its own
  `daemon.json` is exactly the case D3 must catch on every read, not once at page load; a page left
  open across a daemon crash-and-restart cycle must re-probe rather than cache `live: true`.
- **Cross-project read, not execution.** FR-001 reads another project's `daemon.json` and probes its
  port; it must never write into another project's state directory or dispatch a run there — this
  spec adds no route that does either, and any future change to `GET /api/daemons` must preserve
  that boundary explicitly, not by omission.

---

Note: `pnpm format:check` covers `specs/**.md`; this file has not been run through prettier and
must be formatted before commit.
