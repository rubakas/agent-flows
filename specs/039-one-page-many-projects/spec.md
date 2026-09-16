# 039. One page, many projects

| Field        | Value                                                                              |
| ------------ | ---------------------------------------------------------------------------------- |
| Feature Name | One page, many projects                                                            |
| Branch       | `feat/039-one-page-many-projects` (not yet created)                                |
| Status       | Draft — ship order reversed after review (see "Ship order: reversed after review") |
| Created      | 2026-09-17                                                                         |

## Context

Owner ask, verbatim (2026-09-17): "also I still dont understand why we have 2 pages: workflows and
templates / my idea was like: i have a workflows page where i can see the global/bundled workflows /
from this page i can select a project - folder with a code, that i already used(added af to it) /
after select of this project the custom workflows should appear next to bundled / from this page i
should be able to add/delete af from the project (this means that it will appear or dissapear as a
project) / so when i click run in should show the modal where already filled all fields with already
selected project / from this page i can import export custom workflows, add/remove them and run/stop".

Follow-up, same session, that reframed the whole design: "why its locked to some project? why I cant
open a few claudecodes for example and start the chat there, each of them connects to mcp and has a
communication with our tool".

### Why two pages, and why that split no longer means anything

Spec 037 built Templates as the catalogue of bundled workflows (`Preview`/`Install`) and Workflows as
the project's installed set (`Run`/`View`/`Edit`/`Delete`), because `resolveCanonDir`
(spec 037 facts) was exclusive: one installed pipeline hid the rest of the bundled catalogue, so
"what am I allowed to run" and "what could I install" were genuinely different questions. Spec 038
D13 replaced that exclusive flip with a three-layer merge (bundled, user library, repository canon)
and D14/D16 replaced "install" with fork-to-edit and import/export — so today `GET /api/pipelines`
already returns every layer merged, and the Workflows table (`src/serve/ui.html:745-758`,
`src/serve/ui-tables.js:92-104`) already lists bundled rows alongside project ones, each carrying a
`layer` column and a `Fork…` action in place of `Edit` when the row is read-only
(`ui.html:988-1010`). Confirmed live in the tree: every workflow's read-only View page already has
`Run…`, `Edit`, `Export` and `Save as template` for every row regardless of layer
(`ui.html:1320-1347`), so the only capability the Templates view (`ui.html:776-793`) still carries
that Workflows does not is the "Yours" list of previously saved bundles at
`~/.agent-flows/templates/*.yaml` (`GET /api/templates`, `POST /api/templates/:id/install`,
`DELETE /api/templates/:id` — spec 037 D4). Everything else on that page — the "Bundled"
Preview/Export sub-table (`ui.html:777-784`, `?source=bundled` at `ui.html:1175,1634`) — is a second,
narrower view of rows Workflows already shows in full. The split is a leftover, not a design.

### Why the page is locked to one project, and what that actually costs

Several chats in several projects already work today against separate daemons, and this was proven
live in this session, not assumed: two MCP processes were started against two different project
directories at the same time, both completed a tool call that requires the daemon, and two daemons
came up, one per project, each recording its own project and port. The code supports exactly this
shape: `resolveProjectState`/`projectKey` (`src/runtime/projectState.ts:77-124`) derive a distinct,
escaped state directory per project realpath, `resolveDaemonPort`/`findOurDaemon`
(`src/bindings/mastra/daemonResolver.ts:171-242`) look up and auto-start a daemon scoped to exactly
one project's state directory, and `classifyIdentity` (`src/runtime/daemonRecord.ts:166-173`) refuses
to reuse a daemon that reports a different project. So the per-project **process** model costs
nothing in chat: a chat client in project A and a chat client in project B never interfere.

What it costs is the **page**. A daemon resolves `projectDir` exactly once, at process start
(`opts.projectDir ?? process.cwd()`, `src/serve/server.ts:722`), and every request handler reads the
one closed-over `ctx.projectDir` (`HandlerCtx.projectDir`, `server.ts:651`; read at, among others,
`:777`, `:1040`, `:1099`, `:1771`, `:1965`, `:2313`, `:2397`, `:2521`, and the CLI entry at `:2545`).
No route in the ~40-entry route table (`server.ts:126-166`) takes a project from the request — every
`RE_...` path pattern names a pipeline, a run, a draft or a template, never a project. The MCP proxy
layer is the same shape: `daemonFetch` (`src/bindings/mastra/daemonTools.ts:8-30`) builds every URL
from `resolveDaemonBase()` with no project segment anywhere in the path. A page is served by one
daemon process, on one port, bound to one `projectDir` for its whole lifetime — so it can only ever
show that daemon's project. That single fact, not a missing feature, is why the owner's model ("select
a project on the page, see its workflows, add or remove projects, run without retyping which one")
does not fit the tool as it stands today.

### Owner decisions this session

- **One server for every project.** The daemon stops choosing a folder at startup; each request names
  its project, and the daemon keeps one engine per project, opened on first use. Chats name their
  project too. This replaces the identity handshake from spec 038 D8 with something stronger on the
  axis that mattered — a wrong project becomes structurally impossible to reach, because the project
  is always explicit, rather than being caught after the fact by comparing what a single-project
  daemon happened to report.
- **The merged page ships first, for the current project only, before the server rework.** Then the
  project picker and add/remove. Then the run dialog prefilled from the picked project. Ship 1 changes
  the page and Ship 3 changes it again — the owner accepted this in order to get the simplification
  (one Workflows page, no dead Templates tab) sooner rather than gated behind the harder server work.
  **Superseded later in the same session — see "Ship order: reversed after review" below.**

### A devil pass challenged the daemon design before any code was written

A pass over the "one daemon, many projects" design, checked against the code cited below by the lead
before this draft was finalized, found four blocking gaps and six further ones. All are folded into
the Decisions below rather than listed separately, because each one changes what the daemon/registry
ship must do (Ship 1 in the final order below — see "Ship order: reversed after review"), not just how
it is described:

1. `server.ts:722`'s `opts.projectDir ?? process.cwd()` fallback is harmless only because the project
   is fixed at startup; once any request names its project, an omitted or mis-threaded one would
   silently resolve to the daemon's own working directory instead of failing loudly (D2).
2. Dropping the whole identity handshake would drop version-skew protection along with the
   project-match check it also performs (`daemonRecord.ts:166-173`); an explicit project on every
   request replaces only the project axis, not the version one (D6).
3. `agent-flows stop`, the daemon record, and `agent-flows uninstall`'s deletion question
   (`stop.ts:71-153`, `server.ts:807-813`, `uninstall.ts:108-148`) are all built on "one process means
   one project" — under a shared daemon, `stop` can never resolve as written, or a stop meant for one
   project could kill every other project's daemon (D7).
4. Draft ids are per-database autoincrement integers (`src/db/index.ts:80-89`), and each project
   already has its own separate SQLite file (`state.dbPath`) — safe only if every draft- and
   run-bearing route is always told which project's file to open; a page that lost track of the
   current project while holding a draft id could otherwise write into the wrong repository with both
   sides internally consistent (D10).

Six further findings, folded into D1, D4, D8, D9, D11 and D13 below: two live routes resolve the active
provider profile with no project argument at all (`server.ts:1837`, `:2307` — confirmed by reading
`getActiveProfile`'s own signature at `src/canon/registry.ts:156-162`, which already accepts a
`ProviderConfig` second argument that neither call site passes, so `config.defaultProvider` from the
project's own `providers.yaml` is skipped even today, single project or not); an artifact path
supplied on a request is contained only to the shared state root
(`resolveArtifactPath`, `server.ts:566-597`), which is cross-project handoff by design (spec 029
FR-003 Design F) rather than a new hole; `resolveProjectDir()` (`src/bindings/mastra/projectDir.ts:
21-36`) returns a raw path with no realpath step, while `projectKey()`
(`projectState.ts:77-96`) realpaths separately and falls back to a lexical path when realpath fails;
`ensureProjectState` (`projectState.ts:133-164`) always runs the legacy-runs copy
(`migrateLegacyRuns`, `:214-278`) in the same call that creates the marker, so a naive "add a project"
implemented by calling it would copy files merely from being added; `better-sqlite3` is synchronous
and the Mastra `LibSQLStore` in the CLI entry is constructed with the same literal id
`"agent-flows-mastra"` for every process (`server.ts:2586`) — whether that id is a de-duplication key
inside Mastra itself is unverified; and the merged Workflows table's `layer` column already carries a
third value, `user` (the personal library, `src/canon/layers.ts:23`), that the page must label as
distinctly as `bundled`/`repo`, not leave implied.

## Decisions

**D1 — Merge Workflows and Templates into one page; Templates is removed, not left dead.** The
`#/templates` and `#/templates/<id>` routes, the `#view-templates`/`#view-template` containers
(`ui.html:776-800`), and the "Bundled" Preview/Export sub-table are deleted: the merged Workflows
table already lists every bundled row with a fuller action set (`Run…`, `View`, `Fork…`, `Hide`) than
the Bundled sub-table ever offered, and every row's View page already has `Export` and
`Save as template` (`ui.html:1336-1339`). The one capability that has no other home — the "Yours" list
of saved export bundles at `~/.agent-flows/templates/*.yaml` — moves into a new **Import…** dialog
opened from the Workflows header in place of today's `btn-from-template` link; it lists those same
bundles via the unchanged `GET /api/templates`, with `Preview` (`GET /api/templates/:id`), `Import`
(`POST /api/templates/:id/install`) and `Delete` (`DELETE /api/templates/:id`) actions — none of these
routes change, only the page surface that calls them. `New workflow`, `Import…` and `Show hidden`
stay as header actions; `Run…`, `View`, `Edit`/`Fork…`, `Hide`/`Show`, `Delete` stay as row actions,
unchanged in mechanism.

The Workflows table's `Layer` column renders `bundled`, `user` (labelled distinctly, e.g. "personal")
and `repo` as three visibly different sources — the merge otherwise makes three layers look like two,
since only `bundled` and "your project" were ever contrasted on the old two-page split.

**D2 — No implicit default project; the request-context builder is the only gate.** `opts.projectDir
?? process.cwd()` (`server.ts:722`) and the single closed-over `ctx.projectDir` are removed. Every
request carries an explicit `project` query parameter (chosen over a header because the codebase
already reads request state this way — `url.searchParams.get("source")`,
`?include=hidden` — and because `EventSource`, used by the run-events SSE route, cannot set custom
headers but can carry a query string). One prologue, run before any route's `if` chain, resolves
`project`, checks it against the registry (D4) and refuses (400 absent, 403 unregistered) before
dispatch. A route handler never re-implements this check and never receives a project the prologue did
not already validate — the failure mode D2 exists to prevent is a _future_ route that forgets to
check, not today's routes, so the check lives in exactly one place structurally, not by convention.

**D3 — One process, one engine per open project, opened lazily.** The daemon keeps a map from a
registered project's realpath (D4) to an **engine**: that project's `ProjectState`/db handle
(`state.dbPath`, already one file per project), its own `loadProviders`-loaded `ProviderConfig`
(D9), its own compiled `Mastra` instance and workflow objects — built once, at open, with that
project's realpath as every step's `cwd` (D11) — and its own merged catalog view (`resolveCatalog`
already takes `projectDir` as a plain argument, so this generalises for free, `src/canon/layers.ts:
105-112`). An engine opens on the first request naming that project, never on `add` alone (D5). An
idle engine closes after a configurable timeout; the map enforces a configurable maximum open-engine
count, evicting the least-recently-idle entry when the cap is hit; an engine with a run in flight is
never evicted regardless of idle time or cap pressure (ASSUMPTION — exact numbers are an
implementation choice sized in Ship 1, not fixed here). Global, unaffected by any of this: the bundled
layer (`packageRoot()`), the personal library (`~/.agent-flows/workflows`, D13 spec 038 — machine-wide
by its own design already), and the page itself — one static `ui.html` plus its ESM modules, one port,
shared by every open engine.

**D4 — The project registry is `<stateRoot>/projects/*/project.json`; no second file.** This directory
already exists (spec 032) and its marker file already stores exactly what a registry entry needs:
`{projectDir: <realpath, captured once, at creation>, key, createdAt, schemaVersion}`
(`ensureProjectState`, `projectState.ts:143-160`). Adding a second, separate "list of known projects"
file would duplicate a source of truth that already has the right shape. Adding a project narrows what
that write does today: `ensureProjectState` currently also runs `migrateLegacyRuns` in the same call
(`:162`); `add` calls a new, narrower function that writes only the directory and the marker — nothing
is copied, nothing is opened (D3's engine opens lazily, on first use, never on `add` alone).

The registry is the security boundary, because once any request can name a folder, an unguarded daemon
would execute workflow steps in an arbitrary directory on the machine. At request time (not just at
add time): the named path's realpath is resolved fresh, and if that resolution fails (the directory
moved or was deleted), the request is refused with a named error — it never falls back to a lexical
path the way `projectKey()`'s own fallback does for its unrelated callers
(`projectState.ts:84-90`, kept as-is for those). The resolved realpath must equal the `projectDir`
recorded in that key's `project.json` exactly, or the request is refused as unregistered — this is
what stops a moved or symlink-retargeted project from being silently reused for the wrong folder. A
path whose realpath lands inside `packageRoot()` or inside `stateRoot()` itself is refused
unconditionally: running steps with cwd equal to the installed package or the shared state root would
let a workflow read or write the package's own files, or every open project's database.

**D5 — What adding and removing a project does.** `agent-flows add [dir]` (default: cwd) is exactly
the narrowed write from D4 — it remembers the folder and writes nothing into it; that project's own
`.agent-flows/` workflow directory is created only when something is first forked or imported there
(spec 038 D14/D16, unchanged), so a project that only ever runs bundled workflows stays clean.
`agent-flows remove [dir]` (default: cwd) does three things, in order: (1) releases the project (D7)
if the daemon is running it; (2) unconditionally deletes that project's `project.json` — this is the
"forget" step, asked about nothing, because it is the registration itself being undone; (3) asks
exactly one keep-by-default question, reusing `offerProjects`'s wording verbatim
(`uninstall.ts:108-148`, spec 038 D10), about deleting the rest of that project's state directory (its
database and run history) — a non-terminal stdin is asked nothing and deletes nothing beyond the
marker. Splitting steps 2 and 3 like this is what lets "forget this project" and "keep its run history"
both be true at once: the directory can lose its `project.json` (no longer selectable, no longer
listed) while still holding `agent-flows.sqlite` and `runs/` until the owner separately says to delete
those, exactly mirroring spec 038's per-item, keep-by-default uninstall prompts. `remove` never touches
`<project>/.agent-flows` — a repository's own committed workflows belong to the repository, not to
this machine's state, unchanged from spec 038 D10's uninstall guarantee.

A chat client names its project on every call (D2), and that name may not be registered yet — the
owner's second question ("why can't I open a few claudecodes ... each connects to mcp") only holds if
a brand-new project works from the first tool call, with no separate manual `add` step first. So an
MCP tool call naming a project that is not yet registered runs exactly this `add` path itself, through
the same realpath and package/state-root refusals, before the call proceeds — visibly (logged), not as
a silent fallback the way `opts.projectDir ?? process.cwd()` was (D2). This is registration, not a
bypass of it: the caller named a real, specific folder, and that folder goes through the same gate
`add` always does, it is simply triggered by first use instead of by a prior explicit command.

**D6 — The identity handshake narrows to version-only; the project axis retires because it cannot
recur.** `GET /api/daemon` keeps reporting `{version, pid, startedAt}` and drops the single
`projectDir` field — there no longer is one, since the daemon serves many. `classifyIdentity`
(`daemonRecord.ts:166-173`) drops its `"other-project"` branch entirely and keeps `"other-version"`
unchanged: an old daemon running a stale version is still never reused and never killed, and is still
reported to the user by name and version exactly as spec 038 FR-015 already does. The project-match
branch is not merely redundant, it is now provably unnecessary: a client always names its own project
on every call (D2), and that name is either registered and opened correctly, or refused outright — it
can no longer be silently answered by a daemon serving someone else's project, because there is only
one daemon and it never guesses. The record moves from `<stateDir>/daemon.json` (one per project) to
`<stateRoot>/daemon.json` (one, machine-wide); the start lock moves the same way, from
`<stateDir>/daemon.start.lock` to `<stateRoot>/daemon.start.lock`.

**D7 — `agent-flows stop` releases one project; `agent-flows stop --all` shuts the daemon down.**
`agent-flows stop [dir]` (default: cwd) resolves the registered project, cancels its in-flight runs,
closes its engine including its database handle, and evicts it from the map — every other open
project and the daemon process itself are untouched. `agent-flows stop --all` terminates the daemon
process itself; before doing so it prints one line per project that still has a run in flight, naming
it, so an operator is never surprised by what a full shutdown interrupted — it warns rather than
refuses, matching the "don't overcomplicate" posture the owner set for spec 038 D15. `uninstall`'s
per-project deletion (D5, reusing spec 038 D10's wording) always releases first via this same path,
never by killing a shared daemon other projects still depend on.

**D8 — Artifacts are contained to their own project; cross-project handoff is removed by choice.**
`resolveArtifactPath` (`server.ts:566-597`) today contains an absolute artifact path to the shared
state root, which holds every project's run directories — a deliberate design from spec 029 FR-003
Design F ("the operator may deliberately cross project boundaries"). Once one process serves many
projects at once (D3), that containment stops being a convention nobody happens to have exploited and
becomes an actual boundary between mutually distrusting repositories, so it is tightened rather than
carried forward: the check moves from the shared state root to the **named project's own** state
directory (`state.dir`), and an artifact path resolving outside it — including one that points into a
different, currently-registered project's own run directory — is refused. **What this drops:** a run
can no longer start a stage from an artifact a stage produced while running in a different repository;
that cross-project handoff (spec 029 FR-003 Design F) is deliberately removed, not preserved. A test
proves an artifact path naming a different project's state — one still registered, and one that has
since been removed — is refused in both cases.

**D9 — Provider profile is resolved per open project; two existing call sites are wrong regardless of
this spec.** `getActiveProfile()` at `server.ts:1837` and `:2307` is called with zero arguments today,
even though its own signature accepts a `ProviderConfig` second argument
(`registry.ts:156-162`) — meaning `config.defaultProvider` from the project's own `providers.yaml` is
never consulted at either site, single project or many; both silently fall through to
`AGENT_FLOWS_PROVIDER` or the hardcoded `"anthropic"`. This is a pre-existing bug that multi-project
merely makes visible: two open projects with different `providers.yaml` `defaultProvider` values would
otherwise report identical, both-wrong profiles. Both call sites are changed to pass the named
project's engine-cached `ProviderConfig` (`loadProviders(projectDir)`, D3). `agent-flows doctor`'s
daemon line (spec 038 D11/FR-032) changes from "does the daemon report an identity matching THIS
project" — unanswerable once a daemon reports no single project — to "is a version-matching daemon
reachable, and is the current directory a registered project."

**D10 — Draft and run ids resolve strictly inside the named project's own database file.** Draft ids
are autoincrement integers scoped to one SQLite file (`canon_draft`, `db/index.ts:80-89`), and each
project already has its own file (`state.dbPath`). Once every draft- and run-bearing route requires
the `project` parameter (D2) and opens strictly that project's engine (D3) to satisfy it, "draft 1 in
project A" and "draft 1 in project B" are different rows in different files by construction — there is
no shared table for them to collide in. The requirement this spec adds is procedural, not a schema
change: no route may resolve a bare draft or run id without the `project` parameter that says which
file to open, so the page (or a chat client) losing track of which project is selected fails loudly as
"unregistered project" rather than silently reading or writing the wrong repository's row.

**D11 — The realpath captured at `add` is the only path an engine ever runs steps in.**
`resolveProjectDir()` (`projectDir.ts:21-36`) keeps its existing raw-path behaviour for resolving which
project a _calling_ process itself means (the MCP client's own `AGENT_FLOWS_PROJECT_DIR` or cwd); that
value is realpathed exactly once, client-side, before being sent as the `project` parameter (D2). The
daemon never re-derives a project's working directory from anything but the realpath already recorded
in its `project.json` (D4) — so a symlink that starts pointing elsewhere after registration cannot
redirect an already-open engine, and cannot retarget a new one without going through `add` again.

**D12 — Migration: a pre-upgrade, per-project daemon must be found before the new daemon binds its
port.** A spec-038-shaped daemon writes `<stateDir>/daemon.json` per project and understands only the
old, project-scoped `GET /api/daemon` shape; nothing in this spec's discovery path
(`<stateRoot>/daemon.json`, D6) would ever see it, since it looks in a different place. Before binding
its port, the shared daemon sweeps every `<stateRoot>/projects/*/daemon.json` left over from before the
upgrade, probes each recorded port, and if any still answers, refuses to start — naming the project,
pid and port it found and telling the operator to stop it first. Without this sweep, an old daemon and
the new shared one could run side by side against the same project's SQLite file with no coordination
between them at all.

**D13 — The concurrency ceiling stays an open question, made actionable rather than left as a worry.**
`better-sqlite3` is synchronous, so a slow or locked query in one project's engine blocks the Node
event loop for every other open project's requests and SSE streams in the same process — this was a
non-issue when one process meant one project. This spec does not fix a number, because the right one
depends on two things nobody has measured yet: how many projects are realistically open in one daemon
at once (a developer's own habit, not a theoretical maximum), and what this process's file-descriptor
and child-process budget looks like when several of those projects run workflow steps at the same
time — each `check`/`llm` step may itself spawn a child process, so the ceiling is a property of the
whole machine's resource limits, not a number this spec can pick without that data. Ship 1 must
measure both before choosing a number, then add a documented, configurable ceiling on pipeline steps
executing concurrently across every open engine (queued past the ceiling, not rejected) informed by
what it measured. Before the engine map is built, implementation must also confirm whether Mastra's
`LibSQLStore`, constructed
today with the literal id `"agent-flows-mastra"` for every process (`server.ts:2586`), treats that id
as a de-duplication or registry key inside Mastra's own runtime — if it does, every open engine needs
a distinct id, and this must be verified against Mastra's source, not assumed safe.

**D14 — The MCP instructions string is unaffected.** Spec 038 D7's `instructions` text is built inside
the chat/MCP client process from that process's own project (D11), never inside the shared daemon —
nothing here changes what it says or when it is computed.

### Ship order: reversed after review

The owner originally chose page-first, in this same session, before any code was written: "the merged
page ships first, for the current project only, before the server rework. Then the project picker and
add or remove. Then the run dialog prefilled from the picked project," accepting that "ship 1 changes
the page and ship 3 changes it again" as the cost of getting the simplification sooner.

A devil pass, run against that plan before this draft was finalised, argued the opposite order —
daemon, registry and lifecycle work first — because the merged page would otherwise bake
single-project assumptions into its fork, import and export targets and into its deep links, all of
which get revisited once every call needs a `project` parameter (D2, D5, D9): under the original
order, the page is built once against today's single-project daemon and then rebuilt again once the
`project` parameter exists, a cost the original plan did not name. It quantified the rework that
ordering would avoid at roughly a day, concentrated in the page's hash-route/deep-link scheme and its
tests, the page's per-view caches (`_workflowLayers` and similar), and the SSE subscription lifecycle
for the run view.

**The owner reversed the order after seeing that argument.** The server work — the shared daemon, the
registry, and everything the review forced into it — now ships first, visibly changing nothing on the
page; the merged page ships second, built directly against the `project`-parameter shape rather than
against a shape it would later have to unlearn; the picker, add/remove and the prefilled dialog ship
third, unchanged in scope. This record keeps both decisions and the reasoning that separates them,
because the same question was decided twice, in opposite directions, in one session — the reasoning
that changed the owner's mind is the part worth keeping, not just the final answer.

## Delivery

Three ships, in the owner's final order:

- **Ship 1 — the shared daemon, the registry, and chats naming their project.** D2–D14. FRs:
  FR-005–FR-019. Nothing visible changes on the page in this ship. Done means: a request naming an
  unregistered folder is refused before any handler runs; a registered project's run executes with
  that project's captured realpath as its working directory and writes only into that project's own
  state directory; two registered projects are served concurrently by one daemon with no crossing of
  drafts, runs, provider profile, or artifacts; a pre-upgrade per-project daemon is found and named
  before the new daemon binds its port; `agent-flows stop`/`remove` release or forget one project
  without touching any other; removing a project never deletes workflows committed in a repository;
  every new gate has a mutation proof (its own test goes red when the gate is neutered, then green
  again once restored).
- **Ship 2 — the merged page, for whichever project is selected.** D1. FRs: FR-001–FR-004. Built
  directly against Ship 1's `project`-parameter shape, for whichever single project a caller currently
  selects — Ship 3 is what lets that selection change from the page itself. Done means: `#/templates`
  and `#/templates/<id>` are gone from `ui-route.js` and `ui.html`, along with their `?source=bundled`
  page callers; the Workflows header has `New workflow`, `Import…` and `Show hidden`; `Import…` lists
  saved bundles with `Preview`/`Import`/`Delete`; the `Layer` column labels `bundled`/`user`/`repo`
  distinctly; `pnpm check` is green; the owner's visual pass is DEFERRED as in specs 037/038, pending
  an operator session.
- **Ship 3 — the picker, add/remove, and the prefilled run dialog.** FRs: FR-020–FR-022. Done means:
  the page's project picker lists exactly the registry (`GET /api/projects`); switching it re-fetches
  every project-scoped view with no stale row surviving from the previous selection; `+ Add project`
  and `Remove` reuse Ship 1's `add`/`remove` semantics and prompts as page dialogs; the Run… dialog's
  project field is always the current picker selection and is never typed by hand.

## Functional Requirements

- **FR-001.** `#/templates` and `#/templates/<id>` routes, `#view-templates`/`#view-template`
  containers, and the two `?source=bundled` page callers (`ui.html:1175`, `:1634`) are removed;
  `ui-route.js`'s `VIEWS`/`hashFor` lose the `template`/`templates` entries (D1).
- **FR-002.** An `Import…` dialog, opened from the Workflows header in place of `btn-from-template`,
  lists `~/.agent-flows/templates/*.yaml` bundles via the unchanged `GET /api/templates`, with
  `Preview` (`GET /api/templates/:id`), `Import` (`POST /api/templates/:id/install`) and `Delete`
  (`DELETE /api/templates/:id`) — none of these routes change (D1).
- **FR-003.** The Workflows table's `Layer` column renders `bundled`, `user` (labelled distinctly from
  both, e.g. "personal") and `repo` as three visibly different values, by name, in a render-function
  unit test (D1).
- **FR-004.** `pnpm check` stays green after the removal; a DOM-free render test proves the removed
  Templates page assets are gone and the `Import…` dialog renders `templateId`/`sourcePipeline`/
  `exportedAt` by name, matching the escaping coverage spec 037 FR-008 already required of the table it
  replaces (D1).
- **FR-005.** `opts.projectDir ?? process.cwd()` (`server.ts:722`) and the single closed-over
  `ctx.projectDir` are removed; a single prologue, run before any route's dispatch, resolves and
  validates the `project` query parameter for every request; an absent or unregistered project is
  refused (400/403) before any handler runs, and a test proves a newly added route cannot bypass this
  check (D2).
- **FR-006.** `<stateRoot>/projects/*/project.json` is the project registry, with no second registry
  file; `agent-flows add [dir]` (default: cwd) resolves `dir`'s realpath, refuses one inside
  `packageRoot()` or `stateRoot()`, and otherwise writes only the directory and the marker — no engine
  opened, no legacy-runs migration run, nothing written inside `dir` itself; `GET /api/projects` and
  `POST /api/projects` expose the same read/write to the page (D4, D5).
- **FR-007.** Every request's `project` parameter is realpathed fresh at request time; a realpath
  failure (moved or deleted directory) refuses the request by name rather than falling back to a
  lexical path; the resolved realpath must equal the registered `project.json`'s `projectDir` exactly,
  or the request is refused as unregistered (D4).
- **FR-008.** The daemon keeps a map of open project engines keyed by registered realpath, each engine
  holding its own `ProjectState`/db handle, its own `loadProviders`-loaded `ProviderConfig`, its own
  compiled `Mastra` instance built with that project's realpath as `cwd`, and its own merged catalog;
  an engine opens lazily on first use, closes after a configurable idle timeout, and a configurable
  open-engine cap evicts the least-recently-idle entry — never one with a run in flight (D3).
- **FR-009.** The MCP process attaches its own resolved, realpathed project as the `project` query
  parameter on every daemon HTTP call (`daemonFetch`, `daemonTools.ts`); a tool call naming an
  unregistered project triggers the same `add` path as FR-006, visibly, before the call proceeds (D5,
  D11).
- **FR-010.** Every draft- and run-bearing route requires `project` and resolves the id strictly
  inside that project's own database file; a test proves two projects each holding a "draft 1" (and
  correspondingly shaped run records) never cross (D10).
- **FR-011.** `GET /api/daemon` reports `{version, pid, startedAt}` with no `projectDir` field, from a
  single record at `<stateRoot>/daemon.json`; `classifyIdentity` drops its `"other-project"` verdict
  and keeps `"other-version"` unchanged, including its never-killed, name-and-report-to-the-user
  behaviour; the start lock moves to `<stateRoot>/daemon.start.lock` (D6).
- **FR-012.** `agent-flows stop [dir]` (default: cwd) releases exactly one registered project —
  cancelling its in-flight runs, closing its engine and database handle, evicting it from the map —
  without affecting any other open project or the daemon process; `agent-flows stop --all` terminates
  the daemon itself, first naming every project with a run still in flight (D7).
- **FR-013.** `agent-flows remove [dir]` (default: cwd) releases the project (FR-012), then
  unconditionally deletes its `project.json`, then asks exactly one keep-by-default question — reusing
  `offerProjects`'s wording verbatim — about deleting the rest of its state directory; a non-terminal
  stdin deletes nothing beyond the marker; `<project>/.agent-flows` is never touched (D5).
- **FR-014.** `resolveArtifactPath` contains an artifact path to the **named** project's own state
  directory (`state.dir`), not the shared state root; an absolute or relative path resolving outside
  it is refused, including one that points at a different, currently-registered project's own run
  directory, and including one naming a project directory that has since been fully removed (FR-013,
  marker and state both gone). A test proves both refusals (D8).
- **FR-015.** `getActiveProfile()` at `server.ts:1837` and `:2307` is called with the named project's
  engine-cached `ProviderConfig` as its second argument; a test with two open projects whose
  `providers.yaml` name different `defaultProvider` values proves each request reports its own
  project's profile (D9).
- **FR-016.** `agent-flows doctor`'s daemon line reports whether a version-matching daemon is
  reachable and whether the current directory is a registered project, replacing the now-unanswerable
  "does the daemon's identity match this project" check (D9).
- **FR-017.** An engine's step-execution `cwd` and its `buildPipelineWorkflow` `cwd` argument are
  always the realpath captured at `add` time, never re-derived per request; `resolveProjectDir()`'s
  existing raw-path behaviour is unchanged for resolving which project a calling client itself means,
  and that value is realpathed exactly once before being sent as `project` (D11).
- **FR-018.** Before binding its port, the shared daemon sweeps every `<stateRoot>/projects/*/daemon
.json` left by a pre-upgrade daemon, probes each recorded port, and refuses to start — naming the
  project, pid and port — if any still answers (D12).
- **FR-019.** Before the engine map is built, implementation measures how many projects are
  realistically open in one daemon at once and this process's file-descriptor and child-process
  budget under that many projects running workflow steps together, and uses those two measurements to
  size a documented, configurable ceiling on pipeline steps executing concurrently across every open
  engine (queued past it, not rejected); it also verifies whether Mastra's `LibSQLStore` treats its
  constructor id as a de-duplication key requiring a distinct value per engine (D13).
- **FR-020.** The page's project picker lists exactly `GET /api/projects`; switching the selection
  re-fetches every project-scoped view (Workflows, Runs, Settings) with no row surviving from the
  previous selection.
- **FR-021.** `+ Add project` and `Remove` page actions call FR-006's `add` and FR-013's `remove`
  paths, rendered as page dialogs with the same one-question, keep-by-default rule and the same
  never-touches-`.agent-flows` guarantee as the CLI verbs.
- **FR-022.** The Run… dialog's `project` field is always the picker's current selection, never typed
  by hand, and is sent as the `project` parameter on `POST /api/runs` per FR-002's shape.

## Verification

- **V1.** A request naming an unregistered folder is refused before any handler runs (FR-005, FR-006,
  FR-007).
- **V2.** A registered project's run executes with that project's captured realpath as its working
  directory and writes only into that project's own state directory (FR-008, FR-017).
- **V3.** Two registered projects are served concurrently by one daemon with no crossing of drafts,
  runs, provider profile, or catalog contents (FR-008, FR-010, FR-015).
- **V4.** Removing a project never deletes workflows committed in a repository; a test proves
  `<project>/.agent-flows` is untouched by `remove` regardless of the run-history answer (FR-013).
- **V5.** Mutation proofs, one per new gate, each neutered and confirmed red before being restored and
  confirmed green: the unregistered-project refusal (FR-005/007), the realpath-strictness check
  (FR-007), `classifyIdentity`'s version-only comparison (FR-011), the draft/run project-scoping
  (FR-010), the provider-profile-per-project fix (FR-015), the artifact-path project containment
  (FR-014), the pre-upgrade daemon sweep (FR-018), and the engine-map eviction never taking an
  in-flight project (FR-008).
- **V6.** The page halves of all three ships (the merge, the picker, add/remove, the prefilled dialog)
  are not verifiable by the automated suite and need the owner's eyes, as in specs 037 and 038 — a
  request file per ship, DEFERRED until an operator session is available.
- **V7.** An artifact path outside the named project's own state directory is refused, proven two ways:
  one pointing at a different, currently-registered project's own run directory, and one pointing at a
  project directory that has since been removed (FR-014) — this is now a boundary this spec enforces,
  not a convention nobody happened to have exploited, so it gets its own proof rather than riding on
  V5's mutation pass alone.

## Risks and out of scope

- One process now holds several projects' databases and Mastra instances: a crash is wider than
  before — a single daemon fault now interrupts every open project's runs at once, not one project's.
- The engine map needs a bound (FR-008) or it grows with every project ever opened in a session;
  the exact idle-timeout and cap numbers are an implementation choice this spec does not fix.
- `better-sqlite3`'s synchronous driver and the unverified Mastra `LibSQLStore` id question (D13,
  FR-019) mean Ship 1 cannot be built without first measuring what D13 asks for and closing the
  `LibSQLStore` question, not assuming either away.
- **Cross-project artifact handoff is removed by choice, not left as an oversight (D8).** Starting a
  stage in one repository from an artifact a stage produced while running in a different repository
  (spec 029 FR-003 Design F) no longer works once artifacts are contained to their own project; this is
  recorded here so a later change does not widen the containment back to the shared state root thinking
  the narrower check was an accident rather than a deliberate tightening.
- The page still has no automated visual verification (V6); every ship's page half is owner-verified
  by hand, as in 037/038.
- The `project` query-parameter convention (D2) depends on every caller remembering to send it — the
  MCP `daemonFetch` layer and every page `api()` call site must be updated together; a single missed
  call site reproduces the "silent wrong project" failure this spec exists to close, and only code
  review plus the FR-005 prologue test catches it, not a runtime guarantee this spec can make on its
  own.
- The editor forking on `Edit` rather than on `Save` (carried over from spec 038 D14) is untouched by
  this spec.
- A machine-wide "default project" (so a bare CLI invocation with no `dir` argument means something
  even with several registered) is out of scope; `add`/`remove`/`stop` default to `process.cwd()`,
  unchanged from every other verb's convention.
- Retiring `AGENT_FLOWS_PROJECT_DIR` as the mechanism a chat client uses to name its own project is out
  of scope — it is repurposed (D11), not replaced, since the client-side "which project do I mean" step
  still needs an answer independent of the shared daemon.
