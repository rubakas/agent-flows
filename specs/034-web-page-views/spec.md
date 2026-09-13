# 034. Web page views

| Field        | Value                |
| ------------ | -------------------- |
| Feature Name | Web page views       |
| Branch       | `034-web-page-views` |
| Status       | Draft — 2026-09-13   |
| Created      | 2026-09-13           |

## Problem

`src/serve/ui.html` puts everything on one scrolling page: the header carries all n8n controls
(`Connect n8n`/`Disconnect n8n`/`New in n8n`/`Save from n8n…`, `ui.html:487-502`), then Active Runs
(`:508-514`, `loadRuns`, `:1042-1090`), then three workflow-tier sections — Project (`:517-523`,
`loadProjectTier`, `:733-812`), Templates (`:525-533`, `loadTemplateTier`, `:816-874`) and Bundled
(`:535-542`, `loadBundledTier`, `:878-919`) — with the run detail panel (`renderRunDetail`, `:1319`)
sliding in over all of it. The owner: "everything on 1 page is a bit messy." A concurrent change
(spec-033 amendment, D6/FR-019–021) is enriching that panel (workflow-name header, copyable run id,
"How it was run", per-step Model/Prompt/Command); this spec treats it as already built.

## Goals / Non-goals

**Goal.** Reorganize the same page into four hash-routed views so each concern (runs, workflows,
templates, settings) has its own screen, with no new dependency, build step, or backend route.

**Non-goals.** No new run-launch UI, no run retention/deletion, no light theme, no visual redesign
beyond splitting content into views (existing CSS/dark theme kept as-is).

## Decisions

**D1 — Routing.** One page, four views, hash-routed: `#/runs` (default), `#/runs/<id>`, `#/workflows`,
`#/templates`, `#/settings`. A top bar shows the app name, the project directory name (title = full
path from `env.projectDir`), the existing muted state-dir span (`ui.html:489`, populated at
`:1481-1486`), and the four tabs; the active tab is highlighted; Back/Forward work via `popstate`; an
unknown hash falls back to `#/runs`.

**D2 — Runs view.** A table of every run from `GET /api/runs` (`loadRuns`, `:1042-1090`): status,
workflow, started, duration/elapsed, one "Details" action. A filter chip row `Active | Finished | All`
(default `Active` = `running`/`awaiting_approval`) narrows the already-fetched rows client-side.
`awaiting_approval` rows keep a visible marker (existing gate-box/badge styling, `:1053-1057`,
`:438-446`). Clicking a row or Details navigates to `#/runs/<id>` instead of opening the in-page panel
(`attachToRun`'s `panel.classList.add("open")`, `:1131`, becomes a hash push).

**D3 — Run details view.** The spec-033 details panel (`renderRunDetail`, `:1319`, markup at `:546-552`)
becomes a full view: workflow-name header + status badge, copyable `Run <id>`, started/finished, the
gate box with Approve/Reject when `awaiting_approval`, Cancel while `running`/`awaiting_approval`, "How
it was run", the steps table with Model column and expandable Prompt/Command, and a Back link to
`#/runs`. The `EventSource` (`:1149`) opens only while this view is active and closes on leaving it
(`activeRunEs.close()`, already at `:632`/`:1119`, now triggered by the router too).

**D4 — Workflows view.** Two sections: Project (`loadProjectTier`, `:733-812` — View, Edit in n8n when
`n8nBaseUrl` is set, Delete with confirm) and Bundled catalog (`loadBundledTier`, `:878-919` — Install,
plus a new Install all POSTing `/api/install` with every available id). Each row shows id, description,
inputs (View reuses `showDetail`, `:638-668`); a note renders when Project has none installed and
Bundled is being served instead. **D5 — Templates view.** Global templates (`loadTemplateTier`,
`:816-874` — Install, Delete) plus "Save from n8n…" (`:499-501`, moved out of the header) and its
dialog (`:576-591`); hidden with a hint when `n8nBaseUrl` is unset (mirrors gating at `:689-701`).

**D6 — Settings view.** An n8n card: status badge, Connect/Disconnect, base URL shown, key never shown
(`loadN8nStatus`, `:676-706`, connect dialog `:554-573`). An Environment card reading `projectDir`,
`pipelinesSource`, `pipelinesDir`, `stateDir`, `runsDir`, `dbPath` from `GET /api/environment`
(`server.ts:1426-1437`), plus `port` and the active provider profile (`getActiveProfile`,
`server.ts:38`) added to that response. Skills/Agents lists render when the endpoint's existing
`skills`/`agents` arrays (`server.ts:1397-1421`) are non-empty. **D7 — No framework.** No bundler,
still one `ui.html`, existing styles and dark theme reused; a small `route()` function toggles
`hidden` on four view containers; every existing `fetch`/`EventSource` call keeps its current path
and payload — only its trigger and container move.

## Functional Requirements

- **FR-001.** With no hash or `#`, or any hash outside the five valid routes, the page shows the Runs
  view (`#/runs` tab active, its container visible, the other three hidden). A `popstate` listener
  re-runs `route()` from `location.hash`; Back after opening `#/runs/<id>` returns to `#/runs` without
  a full page reload.
- **FR-002.** The Runs view lists every run from `GET /api/runs` with Status, Workflow, Started, and a
  duration/elapsed column; the `Active | Finished | All` chip row (default `Active`) filters the
  already-fetched rows without an extra request; `awaiting_approval` rows keep a distinct marker;
  clicking a row or its Details button sets `location.hash` to `#/runs/<id>`.
- **FR-003.** The `#/runs/<id>` view renders `renderRunDetail`'s output: workflow name + status badge,
  copyable `Run <id>`, started/finished, gate box, Cancel control, "How it was run", the steps table
  with Model column and expandable Prompt/Command, and a Back link to `#/runs`.
- **FR-004.** The `EventSource` for a run opens only while `#/runs/<id>` is the active view and closes
  on navigating to any other view; `window.__afDebug` exposes `sseOpens`/`sseCloses` counters
  incremented on each open/close, so a test can assert one open and one close per visit without a live
  stream.
- **FR-005.** The Workflows view renders a Project section (View, Edit in n8n, Delete) and a Bundled
  section (Install, Install all); each row shows id, description, inputs; an empty Project section
  shows a note that bundled workflows are being served.
- **FR-006.** The Templates view lists global templates (Install, Delete) and hosts "Save from n8n…";
  the view is hidden with a hint when n8n is not connected.
- **FR-007.** The Settings view renders the n8n card (status, Connect/Disconnect, base URL, no key) and
  the Environment card (project dir, pipelines source/dir, state dir, runs dir, db path, port, provider
  profile), plus Skills/Agents lists when those arrays are non-empty.
- **FR-008.** The header's Connect n8n / Disconnect n8n / New in n8n buttons no longer appear in the
  header; Connect/Disconnect render in the Settings n8n card, New in n8n in the Workflows view, and
  "Save from n8n…" in the Templates view. The header keeps only the app name, project directory name
  (title = full path), the muted state-dir span, and the four tabs.
- **FR-009.** Pressing `Escape` while `#/runs/<id>` is active navigates to `#/runs`.

## Verification

- **V1.** Route test via the served HTML (`server.test.ts`): `GET /` contains all four view-container
  ids and all four tab ids, contains no `>Attach<`, and the n8n Connect/Disconnect button markup sits
  inside the settings view container (string checks, mirroring the existing FR-003/004/006 tests at
  `server.test.ts:2042-2084`).
- **V2.** If `route()` is extracted as a pure function into `src/serve/ui-route.js` (served next to
  `ui.html`, no build step) exposing `parseHash(hash) → { view, runId? }`, a DOM-free unit test covers
  FR-001: mutating the default-view fallback goes red.
- **V3.** Visual pass by the owner in the browser — DEFERRED pending operator; the extension cannot
  render a page holding an open SSE stream. **V4.** `pnpm check` green.

## Risks

- No test harness beyond string assertions and one pure-function unit test exists for this page;
  layout/interaction regressions are caught only by the owner's visual pass (V3).

## Follow-ups

- A "Run…" action on a workflow row opening an inputs form and POSTing `/api/runs`.
- Run retention controls (list is unbounded today, per spec-033 D5). A light theme.

## Amendment 2026-09-13 — persisted runs

**D8 — Persisted runs.** `GET /api/runs` lists only the in-memory registry (`RunService.list()`,
`runService.ts:616`), so a daemon restart empties the Runs tab even though every settled run left
`<pipeline>.json` + `manifest.json` under `<stateDir>/runs/<runId>/` (spec 029 FR-001/FR-006).
`listPersistedRuns`/`readPersistedRun` (`artifactStore.ts`, sync reads — `list()`/`get()` are
synchronous) rebuild run state from those files; the registry wins on an id collision because a live
run is always fresher than its last snapshot. Every run carries `source: "live" | "disk"`.

## Functional Requirements (amendment)

- **FR-010.** `GET /api/runs` merges persisted summaries (runId, pipelineId, status, createdAt,
  settledAt, `source:"disk"`) with the registry's; `GET /api/runs/:id` falls back to the artifact
  when the registry has no such id, returning status, invocation, steps (with prompts), result,
  gateDecisions and cancelledAt/reason as the artifact recorded them.
- **FR-011.** A disk run has no event stream: `GET /api/runs/:id/events` writes one `snapshot` and
  closes; cancel/approve answer 409 naming the status. The page marks the row `disk`, opens no
  `EventSource`, and hides Cancel/Approve.
- **FR-012.** An artifact that cannot be parsed is listed as status `unreadable` with its path and
  the parse error — never silently dropped, because a hidden run looks like a lost one.

**V5.** Unit: list/read round-trip, an unreadable artifact, registry-wins precedence, `get()`
fallback. Route: a fixture run dir appears in `GET /api/runs`, its events endpoint closes after one
snapshot, cancel is 409. Restart: a real run through a server, server stopped, a NEW server on the
same state dir still lists it and serves its invocation and step command. Mutation: drop the merge
in `list()` or the fallback in `get()` → red.

## Amendment 2026-09-14 — split view and n8n runtime

**D9 — Split view.** At viewport width ≥1200px the Runs view splits into two panes: the table on the
left (~45%), the selected run's details on the right; `#/runs/<id>` selects the row and fills the right
pane without leaving the list. Below 1200px today's full-view behaviour (details replace the list, Back
link) is unchanged. Settings mirrors this: Skills and Agents become a left-hand list; clicking one loads
`/api/skills/:name` or `/api/agents/:name` into a right-pane reader (monospace, scrollable, copy button);
narrow screens stack the reader below the list. The `EventSource` rule (D3/FR-004) is unchanged: it opens
only while a run is selected and closes on selection change or leaving the view.

**D10 — n8n runtime card.** A Settings card adds three facts and three actions on top of the existing
Connect/Disconnect (D6). Facts: Installed (`GET /api/n8n/runtime` reports npx-cache or PATH availability
and how it would launch), Running (daemon probes `<baseUrl or http://localhost:5678>/healthz` with a 2s
timeout), Connected (existing `/api/n8n/status`, unchanged — no key in the response). Actions: **Start**
(`POST /api/n8n/start` spawns `npx n8n start`, or `n8n start` when on PATH, detached, stdout/stderr to
`<stateDir>/n8n.log`, pid to `<stateDir>/n8n.pid` — both 0600 — then polls `/healthz` up to 60s and
returns `{ running, baseUrl, pid, log }`; 409 if already running); **Stop** (`POST /api/n8n/stop` sends
SIGTERM only to a pid this daemon itself started, never a foreign one; 409 otherwise); **Connect** (once
Running and not Connected: prefill the base URL from the probe, open `<baseUrl>/settings/api` in a new
tab and the existing Connect dialog with the URL filled, asking only for the API key; a stored key skips
the dialog). The card states in one line why the key is entered by hand: n8n issues keys per user in its
own UI, and agent-flows never handles n8n credentials. `AGENT_FLOWS_N8N_URL`/`AGENT_FLOWS_N8N_API_KEY`
still override the stored base URL/key.

## Functional Requirements (amendment 2026-09-14)

- **FR-013.** At ≥1200px the Runs view renders both panes at once; `#/runs/<id>` fills the right pane
  without hiding the table; below 1200px it replaces the list as today.
- **FR-014.** The Settings Skills/Agents reader mirrors FR-013's split behaviour into the right pane;
  the SSE open/close rule (FR-004) is unaffected by pane layout.
- **FR-015.** `GET /api/n8n/runtime` returns installed/launch-command info without reading or exposing
  the stored API key.
- **FR-016.** The daemon probes `/healthz` with a 2s timeout to report Running; a hanging probe never
  blocks the response past the timeout.
- **FR-017.** `POST /api/n8n/start` returns 409 when the pid file names a live process; otherwise it
  spawns, writes pid/log at 0600 under `<stateDir>`, and waits for `/healthz` up to 60s.
- **FR-018.** `POST /api/n8n/stop` sends SIGTERM only when the pid file was written by this daemon's
  own start; a pid this daemon did not start returns 409.
- **FR-019.** Connect, once Running and not Connected, opens `<baseUrl>/settings/api` and prefills the
  Connect dialog's base URL; an existing stored key skips the dialog.
- **FR-020.** `AGENT_FLOWS_N8N_URL`/`AGENT_FLOWS_N8N_API_KEY` take precedence over the stored config
  and the runtime probe's discovered base URL.

**V6.** Route tests against a fake n8n (`http` server answering `/healthz`): runtime/status shapes,
start returns 409 when already running, stop refuses a foreign pid (fixture pid file for a process the
daemon did not start), stop stops a child the test's own daemon started (injectable launcher spawning a
`node -e "setInterval(()=>{},1e3)"` stand-in), pid/log files 0600 under the state dir. Mutation: drop the
pid-ownership check → stop-foreign test red; drop the healthz timeout → a hanging fake must fail the test
on a race, not hang it. **V7.** Served HTML contains the split-view container ids, the runtime card ids,
and the one-line key-ownership explanation. **V8.** Visual pass by the owner — DEFERRED, extension
cannot render the page.
