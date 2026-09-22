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

**D13 — The runs list spans every live daemon, so nothing is switched by hand.** (Owner, 2026-09-22:
"взагалі перемикати нічого не треба".) The page asks every live daemon for its runs in parallel and
merges them newest-first, with a Project column that appears only when the list spans more than one.
No new process: daemons already record themselves in `daemon.json`, so a hub would only add another
thing to start, supervise and reap — the page pulls instead of daemons pushing. A daemon that fails to
answer costs its own rows, not the list. Opening a run follows the row, which carries its own project;
the detail view has no list to ask, so a merged row that did not carry it would be looked up in the
wrong project. `GET /api/daemons` stays unforwarded for the reason D12 gives.

**D14 — A run names what it was started against.** (Owner, 2026-09-22: "було б корисно зрозуміти
code-review чого саме".) With seven reviews queued against seven pull requests, rows reading
`code-review` and a step id are indistinguishable. The subject is DERIVED, never asked of a model and
never supplied by a caller: the first non-empty line of the longest string input, stripped of
markdown. The longest input is the substantive one — `baseline` and `introducedCommits` are short
refs — which is steadier than first-declared, because key order depends on the caller. Live and
disk-restored summaries derive it the same way, from the same recorded invocation.

**D15 — The workflow's name is the way into it.** (Owner, 2026-09-22.) The name links to the workflow
view; the separate `View` button beside it is removed, having said the same thing twice — the
duplication the owner named when he called the interface "дубльований". An anchor rather than a click
handler, so it answers the keyboard and middle-click like every other link.

**D16 — Diagram edges are routed, not drawn straight.** (Owner, 2026-09-22: "лініі які зєднують блоки
погані".) A straight line between two boxes crossed the column gap at an angle, and over a two-column
span it crossed whatever box sat between — the diagram read as a spray. Edges now leave horizontally,
turn at right angles and arrive horizontally, with an arrowhead so direction needs no tracing. Two
routes: to the next column, one turn in the gutter before the target, which is always empty; further
than that, down into a lane BELOW the boxes, across, and up — because every horizontal lane at box
height belongs to the columns being skipped. Edges arriving at one box are fanned apart so they do not
read as a single thick line.

**The first fix was wrong in a way the first test could not see.** It routed right angles but still ran
a long edge horizontally at box height, straight through the box it skipped; the test checked only the
vertical segment. The test now decomposes every path and checks EVERY segment against EVERY box, which
is the property that was meant all along. Generalise: a geometric guarantee needs a geometric test, not
a test of the one segment the author happened to think about.

**D17 — A settled run leads with its answer.** (Owner, 2026-09-22: "чи маю я бачити в завершених
воркфлоу результат ревью і репорт?") The report was reachable but buried: five steps down, inside the
last one's collapsed `Output` disclosure, typographically indistinguishable from the 15–41k-character
prompts above it. The run view had no notion of "this run's result" at all — it was a flat list of
steps whose answer happened to be the last.

The answer is the **sink**: the one declared step nothing else depends on. A pipeline with two sinks
has no unambiguous answer, so the block stays hidden rather than picking one. Fetched in full, not
excerpted, because a report cut at the excerpt length is not a report.

**Race worth recording:** the first attempt filled the block once after the initial render, and the
SSE `snapshot` event re-rendered the body milliseconds later and wiped it — so it silently never
appeared. The fill now belongs to the render itself, is cached per run so repeated snapshots cost no
fetch, and re-looks-up its element after the await instead of holding it across one.

**D18 — A run reads as three named sections, in one order.** (Owner, 2026-09-22: "не ясно де
початкова інформація де прогрес і де результат".) The view was a flat stream of 13px labels — "Chat",
"curl", "Steps" — with no boundaries, so which part was which had to be inferred from position.

Three sections, one heading idiom, always in this order: **Result** (the answer, settled runs only),
**Progress** (the steps), **Request** (what the run was asked for). Request moved from the top to the
bottom: it is 475px of inputs the operator already knows they sent, and reading past it to reach the
report was the wrong way round.

Also dropped from the view: the `__merge_level_*` rows, for the same reason D7 excludes them from the
step count — two rows reading only "succeeded · Activity · Output" are bookkeeping, not steps anyone
wrote. And a step's inline excerpt is capped to a few lines: six of them at full height made the page
mostly a second, worse copy of the outputs collapsed beneath them. Measured: 3038px → 1805px.

**Amended the same day, on the owner's next look: "а як розгорнути?"** The clamp shipped with no way
out — clipped text nobody can read is worse than long text. The excerpt opens in place on click, says
so in its tooltip, and the handler is delegated from the panel rather than bound per row, because the
stream replaces step rows as they advance and a row-bound handler dies with its row.

**D19 — A `<td>` is never a flex container.** (Owner, 2026-09-22: "у мене кнопки поїхали".) `.actions`
set `display: flex` on elements including `<td class="actions">`, which takes the cell out of table
layout: the row stops sizing to its content. With a narrow Actions column the buttons wrapped to a
second line the 30px row never made room for, and each row's last button landed on top of the row
below — measured `tr` 30px against 60px of content. The same latent defect sat in the daemons table,
unnoticed only because its actions had not yet wrapped.

`td.actions` stays `table-cell`, the flex gap comes back as a margin, and the cell is `nowrap` so the
greedy Description column beside it cannot squeeze the actions into two lines. Verified by measuring
every row: no cell taller than its row, no row starting above the previous one's bottom.

**CSS layout has no unit-test gate in this repo.** This class of defect is only observable in a
browser, and the check that found it — comparing each cell's `scrollHeight` against its row's height —
is worth re-running by hand after any change to a table's cells.

**D20 — The model picker shows the whole list, and what each entry resolves to.** (Owner, 2026-09-22:
"я не бачу повного спику при виборі, по друге я не бачу версій".) The role cells were free-text inputs
with a `datalist`, which only suggests once you have started typing — the set was never shown, and had
to be known by heart. The options carried bare ids (`opus`, `haiku`), so the version a run would
actually use was invisible, even though `GET /api/providers` already returned it.

This is the registry's own reasoning turned against itself: the entries are pinned precisely because
"a bare alias silently follows the newest — and therefore most expensive — model", and then the
picker showed only the alias. Cells are now `<select>`s reading `opus — claude-opus-5`; an entry that
pins nothing says so (`codex — codex default`); and a value the registry no longer carries is kept and
marked rather than dropped, because silently rewriting a profile is config loss, not correction.

**D21 — The openai profile is tiered, not one model three times.** (Owner, 2026-09-22, having opened
the codex CLI: "де ці моделі?") `openai` mapped reasoner, worker AND scout to a single unpinned
`codex` entry, so the role-to-model mapping this registry exists for did not exist on that side at
all — every role got whatever the account defaulted to. The CLI's own picker lists `gpt-5.6-terra`
(default, "balanced agentic coding model for everyday work"), `gpt-5.6-luna` ("fast and affordable")
and `gpt-5.5` (previous generation); none of the three was reachable from ours.

Three pinned entries added, mapped by those descriptions: reasoner and worker to `gpt-terra`, scout to
`gpt-luna`. `gpt-5-5` maps to no role and stays selectable for a deliberate comparison, the way
`fable` does on the Anthropic side. **The unpinned `codex` entry survives**: the working model is
account-dependent, and an operator whose account lacks a pinned one must still have a way through.

The registry's note that the codex default "resolves to gpt-5.4-mini, which the endpoint rejects with
HTTP 400" is now marked STALE in place — the default the CLI reports today is `gpt-5.6-terra`.

**D22 — A provider column offers only that provider's models.** (Owner, 2026-09-22: "в колонці
антропік — я маю бачити лише моделі антропіка".) Failover is per profile, so an anthropic column
offering codex models offered a choice that meant nothing.

The vendor is DERIVED from the entry — `cli.bin === "claude"`, `cli.bin === "codex"`, `transport:
api` — not declared in a new field, which would be one more thing to keep true. The column's vendor
is read from the models it already uses, **not from its id**: profiles can be named anything, and
matching on the word "anthropic" would be a rule about spelling. A profile with nothing recognisable
yet offers everything rather than guessing, and a value already in `providers.yaml` that fails the
filter is kept and marked — silently rewriting a config because the picker would not offer that
combination again is config loss.

Also from the same look: the option label shows the version ALONE. `opus — claude-opus-5` said one
fact twice, and `codex — codex default` named a binary, which tells a reader nothing about what will
run; the unpinned entry now reads `account default`.

**D23 — Each provider column names the account it is signed in as.** (Owner, 2026-09-22: "тобі
динамічно треба вставляти тип підписки… вона сама може через cli подивитись це".) Correct, and it is
the question behind every model list: availability follows the account — OpenAI's own pricing page
says "Model availability follows the API models available to your key", and this machine's codex
picker offers three models where the docs list five.

`claude auth status` prints JSON carrying `subscriptionType`; `codex login status` prints its auth
mode and **no plan at all**, reported as the absence it is rather than guessed. Probed once per
daemon — two subprocesses, and a plan does not change between page loads.

**Only the plan and the auth method are read.** That JSON also carries the signed-in email and an
organisation id; the parser names the two fields it wants instead of spreading the object, and a test
asserts neither reaches the response. A spread parser passes every other test in that file and leaks
both — verified by mutation.

**Two measurement traps, both mine.** `codex login status` prints to STDERR, so reading stdout alone
reported a working CLI as silent. And its exit code looked like 0 only because I read `$?` after a
pipeline, which is `head`'s status, not the command's.

**D24 — The landing page is never blank, and never says the same thing twice.** (Owner, 2026-09-22:
"подивись ui".) Three faults, found by looking at it after the seven-review batch finished:

**The page was empty at the one moment it mattered most.** D1 opens on "In flight", which is empty
whenever nothing is running — including the instant the work you were watching finishes, which is
exactly when the reports are wanted. It said "Nothing is running. Start one from Workflows", pointing
_away_ from the thirty runs it was hiding. The first fix fell back to the most recent runs and said
so — **that fix was itself wrong, and is superseded by D28**: it left the "In flight" chip lit above
a list of finished runs.

**The word `Runs` appeared twice**, 190px apart: as the highlighted nav tab and again as the section
heading below it. The heading is gone; the tab already says where you are.

**The daemons table spent a column on the pid.** It is developer trivia beside a Stop button that does
the killing — it stays as the row's title for the rare manual `kill`, not as a column read on every
page load.

**D25 — The run detail has one home at a time.** (Owner, 2026-09-22: "коли я збільшую екран, пропадає
результат".) Reproduced exactly: at 1500px the detail renders into the split pane, at 1000px into
`#view-run` (spec 034 FR-013) — and the abandoned one kept its markup. Two elements then carried
`id="run-result"`, and `getElementById` returns the FIRST in document order, which is the pane's. So
after a wide→narrow resize the result was written into the copy that is no longer on screen, and the
visible block held **zero characters** while the hidden one held 11,470.

Two changes, because either alone leaves the trap armed. The router empties the target it just left,
so no id is ever duplicated. And `fillRunResult` takes the body it was rendered into and uses
`scope.querySelector`, so even a stale duplicate elsewhere cannot win.

**Generalise: a per-render element must never be found by `getElementById`.** The id is unique in the
template, not in the document — any view that renders the same template into two places breaks that
assumption silently, and the symptom is emptiness rather than an error.

Verified across 1000 → 1500 → 980: one element each time, always the visible one, always filled.
**No unit gate covers this** — it is router-and-layout behaviour, observable only in a browser, like
D19's table-cell defect.

**D26 — The report is rendered as markdown, by us, not by a library.** (Owner, 2026-09-22: "чи можемо
ми результат зробити більш читаємим додавши кольори в ситнаксіс?") The reports are markdown and were
shown as one grey monospaced wall, so the finding, its severity and its file path read as the same
thing. Rendered: headings by level, bold labels, inline code in the accent colour, fenced blocks in
their own frame.

**Why a hand-written subset and not a markdown library.** The text is untrusted model output. Every
line is escaped FIRST and only then are our own tags introduced — after escaping there is no `<` left
in the input, so the tag set is exactly what `ui-markdown.js` writes. A library that parses raw
markdown to HTML hands that choice back to the text. Three tests hold the line: hostile input through
every construct, and a probe that tries to close one of our own tags from inside the text.

Two details worth keeping: a code span is lifted out BEFORE emphasis is applied, because this
project's own output contains deny globs whose asterisks are not emphasis; and an unterminated fence
shows the rest of the text rather than swallowing it, because the typo is the model's and hiding its
output is worse than showing it unformatted.

JSON output is untouched — `looksLikeMarkdown` refuses anything starting with `{` or `[`, and a plain
one-sentence answer gains nothing from a paragraph tag.

**D27 — The result offers both views, and Copy always hands over the source.** (Owner, 2026-09-22:
"мені нормально що я бачу маркдаун, бо я буду його копіювати… мені важливо одразу бачити основні
блоки" and then "можеш просто таби зробити md та preview".) Two demands that read as opposed —
structure at a glance, and markdown to paste — are one feature: `preview` and `md` tabs over the same
answer, with `preview` leading because the blocks are what is read first.

The Copy button takes the SOURCE from either tab. Copying what the page rendered would hand over prose
with its structure stripped out, which is the opposite of why it is being copied.

**D28 — The lit chip owns the rows beneath it.** (Owner, 2026-09-22: "а чому в In flight я бачу якісь
воркфлоу?") D24's fallback bought the right behaviour with the wrong mechanism: it overrode the
filter's _result_ while leaving the filter's _chip_ selected, so the page displayed a control that its
own list did not obey. A filter that shows non-matching rows is wrong however helpful the rows are.

The fix resolves the DEFAULT instead of overriding the result. `resolveRunsFilter` (`ui-tables.js`)
answers which chip is selected: with nothing in flight the default resolves to `all`, and the lit chip
is the one the rows belong to. A clicked chip is pinned and never re-resolved — an operator who asks
for "In flight" and gets an empty list has been answered, not overruled.

Cost of the pattern being broken twice in one spec: both D19 and D25 were also caught by the owner
looking at the screen. See the Outcome note at the end of this file.

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

## Outcome — what shipping this actually found (2026-09-22)

Shipped on `main` across roughly twenty commits ending at the D28 fix. Suite: 1800 tests, 0 failures.
Recorded here rather than in a memory note because the next person to touch this page needs it.

**The dogfood that produced the defects.** `code-review` was run locally against seven pull requests
in a separate repository (`domcap/ascent-portal`, #1365-#1371) while this spec was being built. All
seven runs succeeded; every one returned "ready to merge" with zero blocking findings. The value to
_this_ spec was not the reviews: it was that seven real runs put thirty runs, two daemons, two
projects and 12-20 KB markdown reports in front of the page, and the page broke under them.

**Every UI defect in this spec was found by the owner looking at the screen. None was found by the
suite.** Three, all shipped as green:

- **D19** — `display: flex` on a `<td>` took the cell out of table layout and the rows overlapped.
- **D25** — two elements carried `id="run-result"` after a resize, so `getElementById` wrote the
  answer into the copy that was no longer on screen.
- **D28** — the "In flight" chip stayed lit above a list of finished runs.

They share a shape: each is a property of the rendered document — layout, identity, the agreement
between a control and its list — and each was invisible to a test asserting on a string of HTML.
After the fact, each was made falsifiable as a pure function plus a unit test (`.actions` rules,
`fillRunResult(scope)`, `resolveRunsFilter`), and each of those tests was proven able to fail by
neutering its mechanism. That is the right end state and it arrived in the wrong order every time.

**The gap this leaves open:** there is no browser-level gate in this project. The `chrome-test`
handoff exists but is operator-driven, so nothing in `pnpm check` can catch this class. Until that
changes, "the suite is green" says nothing about whether the page is usable, and a change to
`ui.html` is not verified until someone has looked at it. Closing it is separate work, not this spec.

---

Note: `pnpm format:check` covers `specs/**.md`; this file has not been run through prettier and
must be formatted before commit.
