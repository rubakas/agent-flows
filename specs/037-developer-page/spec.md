# 037. Developer page

| Field        | Value                |
| ------------ | -------------------- |
| Feature Name | Developer page       |
| Branch       | `main`               |
| Status       | Revised — 2026-09-14 |
| Created      | 2026-09-14           |

## Problem

The owner (2026-09-14): "I still see the n8n in the tool; Templates should be the page with our
default list of flows that we provide; Workflows are already installed and could be
edited/deleted or create new; make the design a bit better, it should be a simple technical
developer UI." n8n was adopted (ADR-0013 note, 2026-09-04) to get a workflow canvas and CRUD
without building them; in practice the export covered 8 of 12 pipelines, the n8n node ran
`claude` directly and bypassed the daemon (spec 035, Draft), and the page grew an n8n runtime
card, two n8n dialogs, "Edit in n8n" / "New in n8n" / "Save from n8n" actions and a settings
poller. The owner has decided to park n8n; spec 036 gives the run view live activity, so the
remaining gaps are the editor and the catalogue.

**Facts verified 2026-09-14** (explorer pass against `c8a8739`):

- n8n footprint: 51 files, 1111 matching lines (excluding `node_modules` and `.claude`). Code:
  `src/bindings/n8n/{build,import,write-cli}.ts` + tests (Binding C, imported by
  `src/serve/server.ts:31-32` and `src/cli.ts:31-32`); `src/serve/routes/n8n.ts` (161 lines:
  config read/write, `fetchN8n` with the API-key header; imported by `server.ts:58-64` and
  `n8nRuntime.ts:24`) + test; `src/serve/routes/n8nRuntime.ts` (309 lines: detect/probe/start/stop,
  pidfile `<stateDir>/n8n.pid`, log `<stateDir>/n8n.log`) + test; `server.ts` routes
  `GET /api/n8n/runtime` (`:1904`), `POST /api/n8n/start` (`:1910`), `POST /api/n8n/stop`
  (`:1917`), `GET /api/n8n/status` (`:1926`), `POST/DELETE /api/n8n/configure` (`:1939`, `:1965`),
  `GET /api/n8n/workflows` (`:1973`), `POST /api/pipelines/:id/n8n` (`:1994-2063`,
  `RE_PIPELINE_N8N` `:121`), `POST /api/templates/from-n8n` (`:1729-1802`), project map helpers
  `readProjectN8nMap`/`writeProjectN8nMap` (`:132-152`), `n8nRuntime` injection (`:425-428`,
  `:454-455`, `:570`), `n8nBaseUrl` in `/api/environment`; `src/runtime/projectState.ts:44,124`
  `n8nMapPath`; `src/cli.ts:43` `VALID_GENERATE_TARGETS = ["claude","n8n"]`, dispatch `:118-119`,
  help `:18,57`; `package.json:24` script `bindings:n8n`; `.gitignore:18` `.n8n-workflows/`;
  `src/canon/n8nNodeRoleModelSync.test.ts`; `src/canon/providers-wiring.test.ts:168-172`
  (references write-cli behaviour); `src/evals/scorers.ts:112` (a comment);
  `integrations/n8n-nodes-agent-flows/` (standalone package with its own `node_modules`, not in
  the main build); `.n8n-workflows/` (generated, ignored); `src/serve/ui.html` 143 matching lines
  (`loadN8nStatus` `:915-988`, `loadN8nRuntime` `:988-1023`, `_n8nRuntimePoller` `:1023-1035`
  started only on `#/settings`, dialogs `#n8n-cfg-*` `:795-813` and `#dialog*` `:816-829` "Save
  from n8n", Workflows actions); README sections `:95-96`, `:295-305`, `:336`, `:349-351`; ADR
  `docs/decisions/0013-visual-editor-meets-the-bar.md:3` carries the superseding note but no ADR
  records the n8n decision itself; `specs/027-open-work/spec.md:118-125,145,167,203-214` says n8n
  deletion needs an ADR first; `specs/035-n8n-node-via-daemon/spec.md` is Draft. Research docs
  under `docs/research/` mention n8n historically and stay.
- Page: `ui.html` styles `:7-626` with `:root` tokens `--bg --panel --sunk --line --ink --muted
--accent --accent-bg --ok --err --ui --mono` (`:8-21`) and a dark override (`:23-35`); base font
  14px system-ui; monospace `ui-monospace, "Cascadia Code", Menlo, monospace`; views `#view-runs`
  `:646-664`, `#view-run` `:667-672`, `#view-workflows` `:675-695`, `#view-templates`
  `:698-715`, `#view-settings` `:718-782`; loaders `loadProjectTier` `:1115-1204`,
  `loadTemplateTier` `:1204-1266`, `loadBundledTier` `:1266-1324`, `loadRuns` `:1473-1487`,
  `renderRuns` `:1487-1827`, `renderRunDetail` `:1827-1995`, `loadEnvironment` `:1995-2028`,
  `renderNameList` `:2028-2084` (skills/agents), router `route()` `:2126-2168`; tier badges
  `.tier-project/.tier-template/.tier-bundled` `:255-282`.
- A global `setInterval` poller (4 s, `:1583-1594`, started at `:2189`) is never cleared on any
  view; it only no-ops when `#view-runs` is hidden. It is why a browser extension reports the page
  as never idle on `#/workflows`. The n8n runtime poller (5 s) is correctly started/stopped by the
  router — the pattern to copy.
- Pipeline CRUD (all in `server.ts`): `GET /api/pipelines` `:780-804` → `{pipelines:[{id,
description, path}]}`; `POST /api/pipelines` `:806-847` `{id, description?}` → 201 `{id, path}`
  (skeleton YAML `version:1, inputs:[], steps:[{id:"start",kind:"gate"}]`), 403 when the
  pipelines dir is the bundled dir, 409 exists; `GET /api/pipelines/:id` `:849-871` → `{def,
prompts, levels, graph}`; `DELETE /api/pipelines/:id` `:873-903` (403 bundled, 409 with
  dependants via `findDependants`); `POST /api/pipelines/:id/drafts` `:905-925` → `{draftId,
body, baseHash}` (`indexSource` + `openDraft`, `src/canon/draftStore.ts`); `PUT /api/drafts/:id`
  `:927-949` `{body}`; `POST /api/drafts/:id/save` `:951-978` → 200 `{ok, regenerated}` / 409
  conflict / 422 invalid (`canonWriter.saveDraft`, `src/canon/canonWriter.ts:50-108`, validates
  with `loadPipeline` from `src/canon/load.ts` before any write; `load.ts:398-412` rejects prompt
  placeholders not visible to the step; `load.ts:192-199` allows only `{{checkCommand}}` in
  commands). No `GET /api/drafts/:id`, no preview/validate route. Templates: `GET /api/templates`
  `:1702-1725` (bundles in `~/.agent-flows/templates/*.yaml`, `WorkflowBundle {bundleVersion:1,
exportedAt, sourcePipeline, files:[{path, content}]}` from `src/install/bundle.ts:35-42`,
  `exportBundle`/`stringifyBundle`/`parseBundle`/`importBundle`), `GET /api/templates/:id`
  `:1806`, `DELETE /api/templates/:id` `:1838-1860`, `POST /api/templates/:id/install`
  `:1862-1895` (`importBundle` into `<project>/.agent-flows/`, validates each pipeline with
  `loadPipeline`). Installed pipelines live in `<project>/.agent-flows/pipelines/*.yaml` +
  `prompts/`; `resolveCanonDir` (`src/bindings/mastra/pipelineLoader.ts:57-68`) picks the project
  dir when it holds at least one yaml, else the bundled `pipelines/` dir
  (`pipelinesSource: "bundled"`, the case for this repo today). Draft tables `canon_source`/
  `canon_draft`/`canon_draft_op` in `src/db/schema.ts`.
- **Challenged 2026-09-14** by an independent devil pass (4 blocking, 10 major, 4 minor) and a
  security pass (1 blocking, 4 major, 5 minor); all resolved below.
- `GET /api/pipelines/:id` returns the **expanded** def and prompts (`server.ts:863`, via
  `load.ts:392` → `expandNested`); `src/canon/nest.ts:154-155` namespaces nested step ids as
  `` `${step.id}.${ns.id}` `` and `nest.ts:69` merges nested prompts into the same map;
  `kind: pipeline` steps are inlined (`nest.ts:61-62,103-155`) and only `kind: loop` survives
  intact (`nest.ts:73-77`) — no `pipeline` step ever appears in `levels`/`graph`. `loadPipeline`
  still touches the filesystem during an in-memory preview: `realpathSync` (`load.ts:295`) and
  nested-pipeline resolution (`load.ts:388-390`) both read sibling files from disk, which is why
  FR-004's no-write proof must cover the nested closure, not just the one YAML being edited.
- `resolveCanonDir` (`src/bindings/mastra/pipelineLoader.ts:57-68`) is exclusive — project-if-any-
  YAML else bundled — and the same resolution feeds `GET /api/pipelines` (`server.ts:782-786`) and
  MCP `list_pipelines` (`src/bindings/mastra/server.ts:31-34,41-46`), so installing one bundled
  workflow makes the project set authoritative for all three and hides the rest of the bundled
  catalogue from runs and MCP alike.
- `saveDraftAndRegenerate` writes `<project>/.claude/workflows/<id>.js` from the **on-disk**
  pipeline (`src/canon/canonWriter.ts:135-148`), not the draft body, and surfaces failures as
  `regenerationError` (`canonWriter.ts:148`) rather than throwing.
- `assertSafePath` (`src/install/paths.ts:19-33`) and `importBundle`'s per-entry check
  (`bundle.ts:179-184,227-234`) are string-only: they reject absolute paths, NUL and `../` escapes
  via `resolve` but never call `realpathSync`, so a pre-existing symlink inside `.agent-flows/` is
  not caught. `load.ts:294-304`'s prompt-path check already does call `realpathSync` (a dedicated
  `PromptPathError` on symlink escape) and is the precedent the new write paths copy.
- `/api/environment` (`server.ts:1624-1640`) has never carried `n8nBaseUrl`; the page's n8n
  indicator instead comes from `GET /api/n8n/status` (`ui.html:911,925,939`), which itself returns
  only `{configured, baseUrl, source}` and never the key.
- Guards the security pass confirmed already cover, cited here instead of adding new requirements:
  template id traversal on GET/DELETE/install via `isSafeId` (`route-helpers.ts:13-15`) +
  `assertSafePath(ctx.templatesBase, …)` (`server.ts:1806-1822,1838-1851,1866-1878`); pipeline id
  traversal on create/delete via `isSafeId` (`server.ts:811-817,878-881`) — `GET`/drafts skip it
  safely because `findPipelineById` (`server.ts:196-212`) never joins the id into a path, documented
  at `server.ts:849-854`; bulk install ids each `isSafeId`-checked (`server.ts:1555-1562`); the
  bundled catalogue is write-protected by `resolve(pipelinesDir) === resolve(bundledPipelinesDir)` →
  403 at create (`server.ts:817-821`) and delete (`server.ts:882-886`); bundle path traversal
  (absolute/NUL/`../`) is rejected pre-write by `assertSafePath` over every entry
  (`bundle.ts:182-184`), and validate-before-write leaves zero files touched on failure
  (`bundle.ts:186-222`); argv injection through a model override is not possible —
  `["--model", model]` are separate `spawn` array elements with no shell (`runClaudeCli.ts:372,380`)
  and the prompt goes over stdin (`runClaudeCli.ts:499`); `gateMode` is already an exact
  `"manual"|"auto"` enum check in the run handler; the daemon binds `127.0.0.1` (`server.ts:589`)
  with loopback Host/Origin checks (`server.ts:166-174,181-187`) and a CSP (`server.ts:752-753`)
  that every new route inherits; all new mutating routes inherit `BODY_LIMIT_DEFAULT` 64 KB
  (`server.ts:124`) except the preview route, whose limit is raised explicitly (FR-004).
- ADR numbering: 0015 and 0016 already existed, so the retirement ADR is 0017
  (`docs/decisions/0017-retire-the-workflow-editor-hybrid.md`); README is a gate root, so no
  shipped doc may spell the retired tool's name — only docs/ and specs/ may.

## Goals / Non-goals

**Goals.**

- G1 No n8n anywhere in the tool: code, routes, page, CLI, scripts, state paths, README; an ADR
  records the retirement.
- G2 Templates = the catalogue of the flows we ship (bundled `pipelines/`) plus the owner's saved
  templates; Workflows = the project's installed workflows with Run, View, Edit, Delete and New.
- G3 A workflow can be edited from the page with validation before any file is written; files
  remain the source of truth; SQLite drafts are only the edit buffer.
- G4 A simple technical developer UI: dense, monospace where data is code, one visual language, no
  decorative chrome, page idle when nothing is running.
- G5 The run view gets Activity, Decisions and Output from spec 036 D10 (the page half of that
  spec is delivered here).

**Non-goals.** A drag-and-drop canvas (the diagram is generated from `dependsOn`); block-form step
editing beyond the fields listed in D6 (a follow-up); MCP changes; deleting the owner's
`~/.agent-flows/n8n.json` or `<state>/n8n.json` files (the README sections that named them are
removed with D1; ADR-0017 is the surviving pointer that names them as safe to delete); the token
streaming and retention follow-ups of 036.

## Decisions

**D1 — Retire n8n, with an ADR.** New `docs/decisions/0017-retire-the-workflow-editor-hybrid.md` (Accepted,
2026-09-14): the n8n hybrid of 2026-09-04 is withdrawn; the page is the editor and the daemon is
the only executor; reasons: export covered 8 of 12 pipelines (`pipeline`, `loop`, `check` and gate
semantics had no node), the community node spawned `claude` directly and bypassed the daemon's
confinement (spec 035 was the fix and is withdrawn with it), the canvas need is met by a generated
levels diagram, and every n8n surface was a second truth to keep in sync. ADR-0013's superseding
note is amended to point at 0017. Spec 035 status → `Withdrawn — 2026-09-14 (ADR-0017)`; specs/027
n8n items closed. The ADR additionally names `~/.agent-flows/n8n.json` and `<stateDir>/n8n.json` as
leftovers holding an n8n API key, safe to delete (security finding S4) — the Non-goals below keep
the files themselves but the ADR is the surviving pointer once the README sections that named them
are deleted.

Delete: `src/bindings/n8n/` (all), `src/serve/routes/n8n.ts`, `src/serve/routes/n8nRuntime.ts`
and both tests, `src/canon/n8nNodeRoleModelSync.test.ts`, `integrations/n8n-nodes-agent-flows/`
(whole directory), `.n8n-workflows/` (and its `.gitignore` line), the `bindings:n8n` script, the
`n8n` generate target and its help text in `src/cli.ts` (`VALID_GENERATE_TARGETS = ["claude"]`),
every `/api/n8n/*` route (`/api/n8n/status` included — it never leaked the key, but it is n8n
surface), `POST /api/pipelines/:id/n8n`, `POST /api/templates/from-n8n`,
`readProjectN8nMap`/`writeProjectN8nMap`, the `n8nRuntime` server option, `n8nMapPath` from
`projectState.ts` (and its tests), `openExternal` (`ui.html:1094`) and its callers (dead once the
n8n dialogs that call it are gone), all n8n markup/functions/pollers/dialogs in `ui.html`, and the
README sections (state table rows, "Generate n8n workflows", Binding C, milestone lines). `/api/
environment` itself needs no change — it never carried `n8nBaseUrl` (see D11/FR-012). Research docs
stay as history.

Also relocate, not just delete: before `src/serve/routes/n8n.test.ts` is deleted, move its three
mutating-route preamble-guard tests (bad content-type → 403, cross-origin `Origin` → 403, loopback
`Origin` ok; `n8n.test.ts:95-148`) onto `POST /api/pipelines` in `src/serve/server.test.ts` — they
are the only regression coverage for the CSRF/content-type preamble every mutating route shares,
and this spec adds five more mutating routes. Update the comment at
`src/serve/routes/content.test.ts:55-58` (currently: "the content-type/Origin guards only run for
mutating methods and are covered on the n8n module's mutating routes instead") to point at the
relocated test. The API-key-secrecy and file-mode-0600 tests in the same file go with n8n.

Also update rather than delete: `src/serve/server.test.ts`'s n8n route suites, including the
traversal-rejection family at `:2060-2062` and the key-secrecy suite `:2092-2180` — delete them,
but re-point the traversal family at a surviving route if it was exercising a shared helper rather
than n8n-specific code; `src/serve/route-helpers.test.ts:159-183` — re-point at
`POST /api/pipelines/:id/template` per V2/finding 15, do not delete (it guards a dispatch-ordering
bug this spec re-creates); `src/cli.test.ts:111-115` — retarget to the remaining `claude` generate
target; `src/serve/routes/content.test.ts:58` and the comments at `src/runtime/projectState.ts:5,143`
— update the n8n wording; `src/runtime/projectState.test.ts:190` and `src/serve/server.test.ts:2218`
— update the assertions on the `n8n.json` string (S4). Keep, retitled: `providers-wiring.test.ts:
168-182` stays — it only asserts `loadProviders` throws on a malformed `providers.yaml` and imports
nothing from `src/bindings/n8n/`; retitle its `describe` block instead of deleting it (devil finding
17 — not an n8n test).

Test: `grep -ri n8n` over exactly the roots `src`, `scripts`, `package.json`, `README.md`,
`.gitignore`, `integrations` returns nothing, excluding `docs/`, `specs/`, `node_modules`, `.claude`
and `pnpm-lock.yaml`; the ADR, spec 035, spec 027 and `docs/research/` are the only remaining
mentions.

**D2 — Views and routes.** Hash routes: `#/runs`, `#/runs/<id>`, `#/workflows`,
`#/workflows/<id>` (view), `#/workflows/<id>/edit`, `#/templates`, `#/templates/<id>` (preview),
`#/settings`. `ui-route.js` gains the three new routes with tests: `VIEWS` (`ui-route.js:12`) gains
`workflow`, `workflow-edit` and `template`; `hashFor(view, id?)` gains the id argument for the four
detail/edit routes. The existing fallback invariant at `ui-route.js:41-45` — a tab route with an
unexpected trailing segment falls back to runs — stays and extends: `#/settings/<anything>` falls
back, and `#/workflows/<id>/<not edit>` falls back (only `edit` is a valid third segment). The
inverse test at `ui-route.test.ts:49-53` (`hashFor`/`parseHash` round-trip) is extended to cover the
id argument. `ui.html` gains `#view-workflow`, `#view-workflow-edit` and `#view-template`
containers alongside the existing five. The view/preview routes (`workflows`, `workflow`,
`templates`, `template`) ship with Ship 2; the `workflow-edit` route ships with Ship 3 (see
Delivery).

**D3 — Workflows view = the effective set the daemon runs.** `resolveCanonDir` is exclusive, not
merged (`pipelineLoader.ts:57-68`): the moment the project dir holds one installed pipeline, it
alone feeds `GET /api/pipelines`, MCP `list_pipelines` and every run — the flip is explicit, not
silent. When the project has installed workflows (`pipelinesSource: "project"`) the table lists
them: columns `id` (mono), `description`, `steps` (count), `inputs` (mono, comma-separated),
`source` (`project`); row actions `Run…`, `View`, `Edit`, `Delete`; header actions `New workflow`
(shown only when `pipelinesSource === "project"` — `POST /api/pipelines` 403s when
`pipelinesDir === bundledPipelinesDir`, `server.ts:821-825`, and so does `DELETE`,
`server.ts:881-885`) and `From template…` (goes to Templates). When nothing is installed
(`pipelinesSource: "bundled"`) the same table lists the bundled set with `source` `bundled`, row
actions `Run…`, `View`, `Install`, and a one-line note "Bundled workflows are read-only; Install to
edit." In place of `New workflow` the header shows "Install the bundled workflows to start editing."
`Edit` and `Delete` appear only for `project` rows; any mutating action on a bundled row compares
the row's own target dir against `bundledPipelinesDir`, not the dir currently serving `GET
/api/pipelines` (S10) — they are the same today but D3's own flip means they need not stay so.

Bundled `Install` opens a dialog with two radio options, default first: "Install all N bundled
workflows (recommended)" or "Install only `<id>` and what it depends on — the other N−k will no
longer be listed or runnable in this project"; both call the existing `POST /api/install
{ids, overwrite}` route (named in FR-014) — never `POST /api/templates/:id/install`, which serves
only `~/.agent-flows/templates`. After install the view reloads as `project`. `New workflow` opens
a small dialog (id, description) → `POST /api/pipelines` → opens `#/workflows/<id>/edit`. `Delete`
confirms, calls `DELETE /api/pipelines/:id`, shows the 409 dependants message verbatim. `Run…`
opens a dialog listing the pipeline's declared inputs as labelled fields (textareas for
multi-line), a gate mode select (manual/auto) and an optional per-step model override table (step
→ registry model id from `/api/models` if present, else a text field), posts `POST /api/runs` and
navigates to `#/runs/<runId>` (closes the 027 open item "Run… form on workflow rows").

**D4 — Templates view = the catalogue.** Section "Bundled" lists the shipped pipelines
(`GET /api/pipelines?source=bundled` — add the query parameter to the existing route, returning
the bundled dir listing regardless of the project) with columns `id`, `description`, `steps`,
`inputs` and actions `Preview`, `Install` (overwrite confirmation when the project already has
that id) and a header `Install all`. Both `Install` and `Install all` call the existing
`POST /api/install {ids, overwrite}` route (FR-014) — `Install all` sends every bundled id in one
call; neither ever calls `POST /api/templates/:id/install`, which serves only
`~/.agent-flows/templates`. Section "Yours" lists `~/.agent-flows/templates/*.yaml` bundles with
`templateId`, `sourcePipeline`, `exportedAt`, actions `Preview`, `Install`, `Delete`. `Preview`
(both sections) lists every `check` step's literal `command` and every non-pipeline file the bundle
carries, so `Install`/`Install all` is never a blind trust decision over a bundle that may have
shipped in a hostile checkout (security finding S1) — `importBundle`'s FR-016 allowlist is the
write-time backstop, Preview is the read-time one. "Save as template" lives on a project workflow's
View page (D5): `POST /api/pipelines/:id/template {templateId?, overwrite?}` → writes the bundle
with `exportBundle` + `stringifyBundle` (201 `{templateId, path}`, 409 exists without overwrite,
400 on an unsafe id — FR-003). Preview (`#/templates/<id>`) is the read-only workflow view of D5
rendered from the bundle or the bundled def.

**D5 — Workflow view (`#/workflows/<id>`, read-only).** Header: id (mono), description, source,
actions `Run…`, `Edit` (project only), `Save as template`, `Delete`. Body: the diagram (D7), then
the step table (id, kind, role, model, dependsOn, permissions, schema) and, per llm step, a
collapsed prompt block (existing `.code-block` styling). Data: `GET /api/pipelines/:id` (`def,
prompts, levels, graph`).

**D6 — Editor (`#/workflows/<id>/edit`, project workflows only).** Opens a draft
(`POST /api/pipelines/:id/drafts` → `draftId, body, baseHash`) and, alongside it,
`GET /api/pipelines/:id/prompts` (new route) → `{ [stepId]: {path, text, hash} }` where `hash` is
the sha256 of the on-disk prompt file content and the map covers only the pipeline's own llm steps
— ids with no `.` in them, since `GET /api/pipelines/:id` returns the **expanded** def and
`nest.ts:154-155` namespaces nested-pipeline step ids as `` `${step.id}.${ns.id}` `` (facts); a
namespaced id belongs to a different pipeline file entirely and is not editable here. Layout: left,
the diagram re-rendered from the last valid preview; right, two tabs — `Pipeline` (a monospace
textarea with the YAML body) and `Prompts` (one monospace textarea per own llm step's prompt file,
keyed by step id, seeded from the `GET .../prompts` map).

`Validate` and every save call `POST /api/drafts/:id/preview` (new route, FR-004): it validates
through `loadPipeline`'s injected `readFile` (`load.ts:58-62`, the same trick `canonWriter.ts:62-65`
already uses for `saveDraft`) against the draft body plus the edited prompt texts, never a temp
directory copy — a temp copy would silently change what "escapes the pipeline root" means. It
writes nothing; 200 body is exactly `{def, levels, graph}` — no `prompts`, so a crafted draft with
`prompt: providers.yaml` cannot turn preview into a read-back of that file (security finding S9).
422 `{error}` carries the loader's message, which names the step and placeholder. The error is
shown verbatim under the editor and the diagram keeps the last valid state. The route's body limit
is raised explicitly to 1 MiB (default `BODY_LIMIT_DEFAULT` is 64 KB, `server.ts:124`) since one
YAML plus several prompt textareas in one payload can exceed the default.

`Save` order is prompts first, then the YAML: for each changed prompt,
`PUT /api/pipelines/:id/prompts/:stepId {text, ifMatch}` (new route, FR-005) — `ifMatch` is the
hash the editor loaded from `GET .../prompts`, 409 on mismatch (someone changed the file since the
draft opened; per-prompt, since the draft's `baseHash` only covers the YAML,
`server.ts:918-922`) — then `PUT /api/drafts/:id {body}` and `POST /api/drafts/:id/save` for the
YAML, which also 409s on its own conflict. Prompts go first because `saveDraftAndRegenerate`
(`canonWriter.ts:135-148`) regenerates `<project>/.claude/workflows/<id>.js` from the **on-disk**
pipeline after the YAML write — saving prompts after the YAML would bake stale prompt text into
that file. `regenerationError` (`canonWriter.ts:148`) is shown as a non-fatal warning line, not a
failure of the save. Both conflict paths ("the YAML or a prompt file changed since the draft
opened") are shown with "reload draft", which reopens the draft and re-fetches
`GET .../prompts`. Unsaved changes: the tab title gets a `•` and leaving the route asks for
confirmation. The block form (D-fields per step) is the follow-up; the YAML tab is the editor of
this spec.

**D7 — Diagram.** New pure module `src/serve/ui-graph.js` (+ `.d.ts`, served via the FR-015
allowlisted static-module route, unit-tested): `renderLevelsSvg(levels, graph, opts)` returns an
inline `<svg>`: one column per level (left to right), one box per step (id in mono, kind and role
in a second line, a `gate` box drawn with a distinct border), straight edges between columns for
every `dependsOn`, an `unreachable` style when a step has no path from a root. `kind: pipeline`
steps are inlined by `nest.ts:61-62,103-155` and never appear in the expanded `levels`/`graph`
(facts) — only `kind: loop` survives intact, so the mounted-pipeline marker is on the **`loop`**
box, not a `pipeline` box; nested-origin steps (from either) are recognisable by their
`parent.child` id prefix, rendered with a muted parent label. Every text passes through escaping;
step ids land only in SVG text nodes and quoted non-URL attributes, never in `href`/`xlink:href`
(security S7); `escH`'s semantics (`& < > " '`) are copied unchanged into `ui-graph.js`. Sizes: box
160×44, column gap 48, row gap 16; the svg width is computed from the level count and the container
scrolls horizontally. Used by D5 (view), D6 (editor preview) and D4 (template preview).

**D8 — Developer UI.** One visual language, defined as tokens in `:root` and used everywhere: base
13px `--ui` (system-ui), `--mono` for ids, paths, inputs, YAML, prompts, commands and run ids; row
height 30px; borders 1px `--line`; radius 3px; no shadows; one accent; text `--ink` / `--muted`;
status badges are small mono chips: `running` accent, `succeeded` ok, `failed` err, `cancelled`
muted, `awaiting_approval` warn (add `--warn`). Top bar: app name, project basename (mono, title =
full path), state dir (muted, mono), the four tabs right-aligned; 16px page gutters, full width.
Tables: one `.table` class for every list (runs, workflows, templates, decisions, output), header
row muted uppercase 11px, zebra off, hover row `--sunk`. Sections: a 12px uppercase muted header,
no card padding stacks; `.card` is kept only for Settings key/value blocks. Buttons: one `.btn`
with `primary` and `danger` variants, 26px high. Dialogs: a bordered panel, no backdrop blur. Tier
badges (`.tier-*`) are removed in favour of the `source` column, except the one non-tier use at
`ui.html:1534` — a run badge titled "restored from its artifact — this run is not live" — which is
replaced by a muted `disk` chip in the same shared badge set as `running`/`succeeded`/`failed`/
`cancelled`/`awaiting_approval`, not silently dropped. Dark mode stays via `prefers-color-scheme`.
The split view at ≥1200px stays for runs and settings readers and is added for the editor
(diagram | tabs). Everything remains one `ui.html` plus the ESM helpers.

**D9 — Page idle.** The runs poller becomes view-gated like the old runtime poller: `pollersFor
(view)` in `ui-route.js` (FR-010) returns `["runs"]` for `runs` and `[]` otherwise; the router
starts/stops the poller from that result, and it also stops on `document.hidden`; the interval
stays 4 s. The existing suppression while a run's SSE connection is open (`activeRunEs !== null`,
`ui.html:1590`) stays on top of the view gating. No other interval exists after n8n is removed
(confirmed: exactly two `setInterval` sites exist today, `ui.html:1025` n8n and `:1587` runs). A
browser extension must be able to capture `#/workflows` (V-live).

**D10 — Run view activity.** Spec 036 D10 is implemented here as written: `src/serve/ui-log.js`
(+ `.d.ts`, served via the FR-015 allowlisted static-module route — it has no route today, which is
why spec 036's page half is unservable without this spec) with `renderLogEvent`, `renderStepFooter`,
`renderDecisions`, `renderOutput`, `mergeLogEvents`, `toolCallSummary`; the SSE `log` handler with
buffer-then-backfill by `seq`; Activity/Decisions/Output blocks; the `updateStepRow` missing-row
fix; escaping on every path; 2000 events per step. Its FR-011 and V5 are verified under this spec.

**D11 — Environment.** `/api/environment` (`server.ts:1624-1640`) is unchanged by this spec — it
never carried `n8nBaseUrl` in the first place (devil finding 8, security S8); the page's n8n
indicator instead came from `GET /api/n8n/status`, which is deleted along with every other
`/api/n8n/*` route under D1. `/api/environment` keeps `projectDir, stateDir, runsDir, dbPath,
pipelinesSource, pipelinesDir, port, profile, installed, available, skills, agents`. Settings shows
Environment and the Skills/Agents readers only.

## Delivery

Owner directive 2026-09-14: eleven decisions spanning a 51-file deletion, five new HTTP routes,
three new ESM modules and a full visual restyle bisect badly as one change. Ship as four separate
build runs and commit sets, in order:

- **Ship 1 — subtractive + spec 036 landing.** D1, D9, D10, D11, plus the new static-module route.
  FRs: FR-001, FR-010, FR-011, FR-012, FR-015. All removal and behaviour-preserving; the `no-n8n`
  gate and the runs-poller gate are objectively verifiable; leaves the tree green and small before
  any new write surface lands. Delivered: 1a — `6fe091b`, `3230ddd`, `c8428f3`; 1b — `989c3f8`,
  `350796b`, `a1424a3`, `607eb53`.
- **Ship 2 — catalogue.** D2 (the `workflows`/`workflow`/`templates`/`template` routes), D3, D4,
  D7. FRs: FR-002, FR-003, FR-006, FR-007, FR-008, FR-009, FR-014, FR-016. The `pipelinesSource`
  flip (D3) and the bundle allowlist (FR-016) are resolved above, not left as build-time decisions.
- **Ship 3 — editor.** D2 (the `workflow-edit` route), D6. FRs: FR-004, FR-005. The only genuinely
  new write surface; the prompt-path containment, conflict handling and regeneration ordering above
  are its acceptance criteria.
- **Ship 4 — developer-UI restyle.** D8. FR-013. Pure presentation, kept separate so Ships 1-3 stay
  free of CSS churn in their diffs; the owner's visual pass (V4) applies here and stays DEFERRED
  until an operator session is available, as in spec 034 V3.

## Functional Requirements

- **FR-001.** No n8n identifier remains in code, scripts, package manifest, README, `.gitignore`
  or `integrations/` (D1 grep, exact roots per V1); the three mutating-route preamble tests are
  relocated onto `POST /api/pipelines`, not lost; the ADR exists and names the leftover
  `n8n.json` files; spec 035 is Withdrawn; `pnpm check` is green with the n8n tests deleted or
  retargeted.
- **FR-002.** `GET /api/pipelines?source=bundled` lists the shipped catalogue for any project;
  without the parameter the route is unchanged; `source` is validated as the exact literal
  `bundled` (400 on any other value) and is never joined into a path (S10).
- **FR-003.** `POST /api/pipelines/:id/template` validates `templateId` (default: the pipeline id)
  with `isSafeId` then `assertSafePath(ctx.templatesBase, …)` — 400 on failure, mirroring
  `server.ts:1768-1774` (S5) — then writes a bundle to the templates dir (201/409/404) and the
  result installs back through `POST /api/templates/:id/install` unchanged (round trip test:
  install → edit description → save as template → install into a second temp project → identical
  files).
- **FR-004.** `POST /api/drafts/:id/preview` validates the draft body and optional prompt texts
  without writing, via `loadPipeline`'s injected `readFile` (never a temp copy — S9); the mtime of
  every canon file, **including every file in the nested closure** `load.ts:388-390` reads from
  disk, is unchanged after a 200 and after a 422; returns exactly `{def, levels, graph}` (no
  `prompts`) or `{error}` with the loader's message; body limit raised explicitly to 1 MiB for this
  route.
- **FR-005.** `PUT /api/pipelines/:id/prompts/:stepId {text, ifMatch}` writes only a path that,
  after `realpathSync`, sits inside the realpath of `<project>/.agent-flows/prompts/`, ends in
  `.md`, already exists, and is the file the step's own def references — `load.ts:288-291`'s
  `.agent-flows/`-rooted containment is not sufficient for a write and this route does not rely on
  it alone; 403 otherwise. 404 for an unknown step, a non-llm step, or a namespaced id (containing
  `.`, i.e. a nested-pipeline step — see D6/facts). 409 when `ifMatch` does not match the sha256 of
  the on-disk file (obtained from the new `GET /api/pipelines/:id/prompts`). 403 for bundled
  pipelines, reusing the `resolve(pipelinesDir) === resolve(bundledPipelinesDir)` comparison
  (facts).
- **FR-006.** `ui-route.js` parses the three new routes (four with the id argument on `hashFor`);
  unknown hashes and unexpected trailing segments (`#/settings/<anything>`,
  `#/workflows/<id>/<not edit>`) still fall back to runs.
- **FR-007.** `ui-graph.js` renders one box per step and one edge per `dependsOn`, escapes ids
  (text nodes and quoted non-URL attributes only, never `href`/`xlink:href` — S7), marks the `gate`
  box and the **`loop`** box carrying a mounted pipeline id, marks nested-origin steps by their
  `parent.child` prefix, and its width grows with the level count.
- **FR-008.** The Workflows table shows `project` rows with Edit/Delete and `bundled` rows with
  Install only (V-live and a DOM-free render-function test where the row HTML is produced by a
  helper in a `ui-log.js`-style module `ui-tables.js` — the table row renderers for runs,
  workflows, templates live there and are unit-tested for escaping, naming the four newly-rendered
  fields `description`, `steps`, `inputs`, `exportedAt` by name — S7).
- **FR-009.** Run… dialog posts exactly `{pipeline, inputs, gateMode, models?}` and navigates to
  the run; the route validates every `inputs` value as a string, and `models` as a flat
  `Record<string,string>` whose keys are the pipeline's declared step ids and whose values are
  registry model ids or `CLI_MODEL_RE`-shaped strings (`loadProviders.ts:54`) — 400 otherwise (S6).
- **FR-010.** `pollersFor(view)` in `ui-route.js` returns `["runs"]` for `runs` and `[]` otherwise,
  unit-tested; the router starts/stops the runs poller from that result on top of the existing
  `activeRunEs !== null` SSE suppression, which survives unchanged.
- **FR-011.** Spec 036 FR-011 (Activity/Decisions/Output with escaping).
- **FR-012.** `/api/environment` is unchanged — it never carried `n8nBaseUrl`; every `/api/n8n/*`
  route, including `/api/n8n/status`, is gone; `openExternal` (`ui.html:1094`) is deleted with its
  callers; MCP tools unchanged.
- **FR-013.** Every table, button, badge and dialog uses the shared classes of D8; no `.tier-*`
  class remains (the run-restored-from-artifact signal survives as a `disk` chip); base font 13px;
  `--warn` token exists in both themes.
- **FR-014.** Bundled-row `Install` and Templates `Install`/`Install all` call the existing
  `POST /api/install {ids, overwrite}` route (`server.ts:1539-1575`, `installWorkflow` copies the
  transitive closure via `install/install.ts:36-59`); no new install route is added; `Install all`
  sends every bundled id in one call; bundled `Install` never calls
  `POST /api/templates/:id/install`.
- **FR-015.** One allowlisted static-module route serves exactly `/ui-route.js`, `/ui-graph.js`,
  `/ui-log.js`, `/ui-tables.js` from `dirname(ctx.uiPath)`, with no path joining from request
  input, the same 503-when-missing and `nosniff` behaviour as today's `/ui-route.js` handler
  (`server.ts:764-778`); a non-allowlisted name 404s (test).
- **FR-016.** `importBundle` accepts only `pipelines/*.ya?ml`, `prompts/**` and `providers.yaml`
  entries; any other entry rejects the whole bundle before any write, with the same zero-write
  semantics as `bundle.ts:182-184` (S1). `importBundle` and `PUT /api/pipelines/:id/prompts/:stepId`
  both re-assert containment after `realpathSync` of the deepest existing ancestor — the two-stage
  check `load.ts:294-304` already uses — catching a pre-existing symlink inside `.agent-flows/`
  (S2).

## Verification

- **V1.** Grep gate for n8n (FR-001) run in `pnpm check` as a test (`src/serve/no-n8n.test.ts`),
  scanning exactly `src`, `scripts`, `package.json`, `README.md`, `.gitignore`, `integrations`,
  excluding `docs/`, `specs/`, `node_modules`, `.claude`, `pnpm-lock.yaml`.
- **V2.** Route tests for FR-002..FR-005, FR-014, FR-016 including the 400/403/404/409/422
  branches and the no-write assertion; the dispatch-ordering test at
  `route-helpers.test.ts:159-183` is re-pointed at `POST /api/pipelines/:id/template` against
  `RE_PIPELINE_DETAIL`/`RE_PIPELINE_DRAFTS` (`server.ts:855,908`) rather than deleted.
- **V3.** `ui-route.test.ts`, `ui-graph.test.ts`, `ui-tables.test.ts`, `ui-log.test.ts` with
  escaping mutations (drop one `esc` → red), covering `description`, `steps`, `inputs`,
  `exportedAt` by name (FR-008).
- **V4.** Live: from a temp project with nothing installed, Templates → `Install all` bundled
  workflows (the recommended default per D3, not a single row) → Workflows shows the full set as
  `project` → Edit `investigate` → introduce an unknown placeholder → Validate shows the loader's
  message and no file changed → fix → Save → files updated, including the regenerated
  `<project>/.claude/workflows/investigate.js` (D6) → Run… → run view shows Activity live; a bundle
  containing a `config.json` entry is refused by `Install`/`Install all` with zero files written
  (FR-016); page idle is verified by `pollersFor` and the absence of any other interval or open
  connection off the runs view (checked 2026-09-14 with `lsof` on the daemon: no connection from a
  fresh `#/workflows` tab); the Claude-in-Chrome extension still cannot capture the page (its
  injection waits for `document_idle`, which this page never reaches even with the poller gated —
  cause unknown, not the poller), so it is not a gate; owner visual pass of the design DEFERRED as
  in 034 V3.
- **V5.** Spec 036 V5/V6 items for the page.
- **V6.** Mutation ledger recorded under Verification log.

## Follow-ups

- Block-form step editing (kind/role/model/dependsOn/permissions as fields) on top of the YAML
  tab.
- Drag reorder.
- `/api/models` per-profile list (035 D2) for the Run… dialog.
- Removing the owner's leftover `n8n.json` files.

## Verification log

Placeholder — record each gate's mutation-proof run here as it is completed (see V6).

- [x] FR-001 — n8n removal grep gate: `src/serve/no-n8n.test.ts`; mutation: a `// n8n` comment
      turns it red, proven once
- [ ] FR-002 — bundled pipelines listing
- [ ] FR-003 — save-as-template round trip
- [ ] FR-004 — draft preview validation, no write
- [ ] FR-005 — prompt write route validation and scoping
- [ ] FR-006 — router new routes
- [ ] FR-007 — diagram rendering
- [ ] FR-008 — workflows table row actions by source
- [ ] FR-009 — run dialog payload and navigation
- [x] FR-010 — runs poller view-gating: `pollersFor` in `ui-route.js`; mutation returning
      `["runs"]` unconditionally → red (`leaves every other view idle, including the run
details`)
- [x] FR-011 — run view rendering and escaping (Activity / Decisions / Output): delivered by
      spec 037 Ship 1b (607eb53); `src/serve/ui-log.js` + `ui-log.test.ts` (23 tests); mutation:
      `esc` dropped from the message path → red (`renderLogEvent — escaping on every path` ›
      `escapes a message so a script tag cannot reach the DOM`)
- [x] FR-012 — environment payload and MCP surface unchanged: `/api/n8n/*` → 404;
      `/api/environment` unchanged
- [ ] FR-013 — shared UI classes and tokens
- [ ] FR-014 — bundled install calls the existing `POST /api/install` route
- [x] FR-015 — allowlisted static-module route (ui-route/ui-graph/ui-log/ui-tables): `/ui-log.js`
      200 + `nosniff`, `/ui-other.js` 404
- [ ] FR-016 — bundle path allowlist and symlink containment
