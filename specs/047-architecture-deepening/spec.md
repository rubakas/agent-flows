# 047. Deepening the architecture, and the defects found on the way

| Field        | Value                                                                                                           |
| ------------ | --------------------------------------------------------------------------------------------------------------- |
| Feature Name | Architecture deepening — eight candidates, eight defects                                                        |
| Branch       | `feat/047-architecture-deepening`                                                                               |
| Status       | Implemented 2026-10-10 (branch unpushed); browser test DEFERRED — pending operator; deferred items listed below |
| Created      | 2026-10-10                                                                                                      |

## Origin

The owner asked what in af's review and audit checks architecture. Nothing does: `code-review`
and `audit` look for concrete defects only (`prompts/code-review-correctness.md:4`: "A concrete
defect in the code in front of you outweighs any general observation about the design"; spec 030
§Out of scope: "No new discovery dimensions beyond correctness and security"). The owner then
ran `/improve-codebase-architecture` over the whole repository and asked for the findings to
become a spec and for work to start.

Four read-only explorations covered `src/serve`, `src/runtime`, `src/canon` and
`src/bindings` + `plugin/`. Their key citations were re-read against the files by the lead.
The review used the `/codebase-design` vocabulary: **module**, **interface** (everything a
caller must know), **depth** (behaviour per unit of interface), **seam**, **adapter**,
**leverage**, **locality**, and the **deletion test**.

The review produced two kinds of output, and this spec keeps them apart:

- **Defects** (FR-1 … FR-8): traced in code, not yet reproduced. Each is fixed minimally,
  behind a regression test that is shown red before the fix.
- **Deepening candidates** (FR-9 … FR-16): structural changes. None is designed yet; each
  needs its own design pass before code.

## Decisions

**D1 — Defects before structure.** The defects are fixed first with minimal changes. Their
regression tests then pin behaviour that the later refactors must preserve. A defect whose
test cannot be made to fail on the current code is not a defect: the FR is closed as "not
reproduced", with the evidence.

**D2 — Failing first.** Every Phase 1 regression test is run red against the unfixed code,
and the red output is recorded in the hand-off, before the fix is applied.

**D3 — Skills are a capability (FR-4).** A step that declares `skills` is refused on a
transport that ignores them, the same way `stepDenyPatterns` is handled
(`src/canon/adapters/types.ts:16-28`). Refuse, not warn: a step that silently runs without
the skills it asked for produces a result that looks valid. No bundled pipeline declares
`skills` (`grep -l 'skills:' pipelines/*.yaml` is empty), so no shipped pipeline changes
behaviour.

**D4 — FR-8 is investigated before it is fixed.** The fix depends on what the Mastra build
captures (YAML only, or prompts too) and on whether a rebuild is safe while runs are in
flight. It may fold into FR-10.

**D5 — Candidates need a design pass.** Before any FR-9 … FR-16 code: a grilling session
with the owner, a `devil` challenge, and an amendment to this spec with acceptance
criteria. The 2026-09-21 measurement stands: `handleRequest` routes are not split into
files (no field clustering). FR-10 moves rules, not routes.

**D6 — Parallel work uses disjoint file sets.** The test suite cannot run beside another
copy of itself (spec 045), so implementers run targeted test files only; the lead runs the
full suite.

## Functional Requirements

| ID    | Requirement                                                              | Phase | Status                                                      |
| ----- | ------------------------------------------------------------------------ | ----- | ----------------------------------------------------------- |
| FR-1  | Schema retry after a successful failover runs on the model that answered | 1     | Fixed                                                       |
| FR-2  | Binding A: a parallel level's results are reachable by later prompts     | 1     | Fixed                                                       |
| FR-3  | Daemon review capture cannot be blinded by repository git config         | 1     | Fixed                                                       |
| FR-4  | A step that declares skills never lands on a transport that ignores them | 1     | Fixed                                                       |
| FR-5  | The manifest route resolves a chained stage's run id                     | 1     | Fixed                                                       |
| FR-6  | The run progress line names the step that is actually running            | 1     | Fixed                                                       |
| FR-7  | Load rejects prompt placeholders the runtime never provides              | 1     | Fixed                                                       |
| FR-8  | An edited pipeline runs its edited definition                            | 1     | Fixed                                                       |
| FR-9  | Step attempt: the canon owns running a step on a model                   | 2     | Done (reduced scope)                                        |
| FR-10 | Run start: the rules for a valid run live below the HTTP route           | 4     | Done (C1+C2; C3–C6 deferred)                                |
| FR-11 | Run store: one module owns where a run lives and what its status means   | 3     | Done (80%)                                                  |
| FR-12 | Pipeline by id: one way to load a pipeline across layers                 | 3     | Done                                                        |
| FR-13 | Output-schema contract lives in the canon                                | 4     | Done (Binding A emits canon schemas; rules module deferred) |
| FR-14 | One review-capture module, generated into the plugin                     | 5     | Done                                                        |
| FR-15 | The page's run-view state moves out of inline script                     | 6     | Commit 1 done; run-view session deferred                    |
| FR-16 | One generator from a canon pipeline to a Claude workflow script          | 5     | Done (pinning test; shared step table deferred)             |
| FR-17 | Daemon `git status` callers cannot run repo-configured commands          | 1     | Fixed                                                       |

## Phase 1 — defects

### FR-1. Schema retry after failover

- **Evidence.** After a successful failover the step records `actualEntry = outcome.entry`
  (`src/bindings/mastra/buildSteps.ts:622`), but the one schema retry calls
  `runner(entry, retryPrompt, runnerDeps)` (`:668`) — the provider that already failed.
- **Fix.** The retry runs on `actualEntry ?? entry`. The retry's budget under failover is
  FR-9's concern, not this fix.
- **Regression test.** The primary runner throws a failover-worthy error; the failover
  candidate first returns invalid JSON, then valid JSON. A runner spy records the entry of
  each call; the retry's entry is the candidate's.

### FR-2. Binding A parallel results

- **Evidence.** A parallel level binds results as `` `${safeId(gs.id)}Res` ``
  (`src/bindings/claudeCode.ts:249-250`); the null-guard uses `` `${gs.id}Res` `` without
  `safeId` (`:272`); later prompts reference `` `${r_${safeId(name)}}` `` (`:78`). The
  bundled `audit` pipeline runs `correctness` and `security` in parallel and its synthesis
  prompt uses `{{correctness}}` (`prompts/audit-synthesis.md:8`), so the generated script is
  expected to throw `ReferenceError` at synthesis. The current test only runs
  `node --check` (`src/bindings/claudeCode.test.ts:186-197`).
- **Fix.** Parallel results are bound with the same `r_<safeId>` names as sequential steps
  (`:283`), and the null-guard uses them.
- **Regression test.** Generate the script for the bundled `audit` pipeline and **execute**
  its body with stub `agent` / `parallel` / `phase` globals; the synthesis prompt contains
  the correctness stub's output.

### FR-3. Daemon review capture hardening

- **Evidence.** `src/runtime/reviewMaterial.ts` runs git (`git()`, `:593-615`) with none of:
  `--text`, `--no-textconv`, `--no-ext-diff`, `-c core.fsmonitor=false`, `LC_ALL=C`; its
  credential pathspecs (`:91-100`) lack `icase`. The plugin's port has all of them
  (`plugin/skills/review/scripts/capture.mjs:205-213, 298-306, 329, 774-779`). A committed
  `.gitattributes` with `* -diff` can therefore blank changes from af's daemon review but
  not from `/af:review`.
- **Fix.** Port those protections to `reviewMaterial.ts`. Behaviour otherwise unchanged.
- **Regression tests.** (a) A temp repo with a committed `.gitattributes` `* -diff`: the
  captured patch contains the changed lines. (b) A file named `.ENV` is excluded from the
  material. (c) A textconv driver configured in the repo's own config does not run.
- **Review.** `security-auditor` reviews this change.
- **Amended 2026-10-10 after the security audit.** The first port closed ext-diff, textconv, `-diff`
  and fsmonitor, but the audit reproduced three more repo-config paths, and the lead reproduced the
  first with the production argv:
  - `log.showSignature=true` + `gpg.program` runs a command on `git log` / `git show` when a commit in
    range carries a (forged) `gpgsig` header → `-c log.showSignature=false` on every call.
  - `diff.renameLimit=1` makes git skip rename detection with exit 0 and a stderr warning, so a
    withheld file renamed with edits arrives as delete + add and its content reaches the material →
    the rename pass reports `incomplete` on failure or any stderr, and capture refuses
    (`available: false`) when it is incomplete and a credential path changed.
  - A promisor lazy fetch runs `core.sshCommand` → `GIT_NO_LAZY_FETCH=1` (honoured by git ≥ 2.44),
    plus `GIT_TERMINAL_PROMPT=0` and `GIT_OPTIONAL_LOCKS=0`.
  - git's env is built per call, not snapshotted at module load.
  - Every git call has a timeout (default 120 s, `AF_REVIEW_GIT_TIMEOUT_MS`); a timeout throws and
    is converted once, at `buildReviewMaterial`, into `available: false` — never partial material.
- **Plugin parity.** `plugin/skills/review/scripts/capture.mjs` had the `log.showSignature` hole and
  no `GIT_NO_LAZY_FETCH`; both are fixed there too, with a test in `src/af-plugin/capture.test.ts`.
  Codex keeps a frozen copy of the plugin: re-run `codex plugin add af@agent-flows` to pick it up.
- **Not done (follow-ups).** An allowlisted env for git (today a bypass would inherit the daemon's
  full env); `GIT_CONFIG_NOSYSTEM` (capture.mjs sets it, the daemon does not); `spawnSync` still
  blocks the daemon's event loop for up to the timeout per call; no test for the lazy-fetch path
  (the auditor's PoC proved it, falsifiably, outside the repo).

### FR-4. Skills as a capability

- **Evidence.** Only the claude adapter passes skills (`src/canon/adapters/claude.ts:150-154`);
  `AdapterCapabilities` has no skills field (`src/canon/adapters/types.ts:16-28`), so the
  portability check and failover (`src/bindings/mastra/failover.ts:143`) can land a skills
  step on codex or api, which ignore it while the prompt still lists the skills
  (`buildSteps.ts:503-505`).
- **Fix.** A skills capability: true for claude, false for codex and api. The portability
  check refuses a skills step on a transport without it; failover skips such candidates
  (D3).
- **Regression tests.** Portability refuses a skills step for codex and for api; the
  failover chain skips a codex candidate for a skills step.

### FR-5. Manifest route and chained stages

- **Evidence.** A chained stage writes into its anchor's directory (`artifactDirFor`,
  `src/runtime/runService.ts:1534-1539`), but `GET /api/runs/:id/manifest` joins
  `runsDir/<id>` (`src/serve/server.ts:2181`) and answers 404 for the child.
  `getManifestPath` (`runService.ts:1650-1656`) resolves chains and has no production
  caller.
- **Fix.** When `runsDir/<id>/manifest.json` is absent, the route asks the run service for
  the run's manifest path. Disk-only child ids after a daemon restart are FR-11's concern.
- **Regression test.** A chained run in a server test: `GET /api/runs/<childId>/manifest`
  answers 200 with the anchor's manifest.

### FR-6. Run progress line

- **Evidence.** `formatRunProgress` looks for a step with status `"running"`
  (`src/bindings/mastra/daemonTools.ts:175`); the producer emits `"started"` and
  `"suspended"` (`src/runtime/runService.ts:662`, `src/serve/server.ts:136`). The tests
  pass on fixtures that use `"running"` and `"pending"` (`daemonTools.test.ts:662-671`),
  values the producer never emits.
- **Fix.** Match the producer's vocabulary: the current step is the one `started` or
  `suspended`. Fixtures use producer values.
- **Regression test.** Steps `{a: succeeded, b: started}`: the line names `b`.

### FR-7. Placeholders the runtime never provides

- **Evidence.** Load accepts `{{models}}` (`src/canon/load.ts:540`), but the prompt context
  skips `models` and `provider` (`src/bindings/mastra/buildSteps.ts:292`), so render throws
  at run time. No shipped prompt uses `{{models}}` or `{{provider}}`.
- **Fix.** `models` is no longer an always-available placeholder; such a prompt fails at
  load with the existing unknown-placeholder error.
- **Regression test.** A pipeline whose prompt uses `{{models}}` fails to load.
- **Also.** `inputs:` is now validated explicitly: a pipeline without an `inputs` list fails with
  `Pipeline "<id>": "inputs" must be a list (use inputs: [] for none)`. Before, the same pipeline
  failed later with `expanded.def.inputs is not iterable` — a spread that happened to throw — so no
  pipeline that loaded before stops loading.

### FR-8. Edited pipeline runs its startup build (fixed — see Decisions)

- **Confirmed by code reading (2026-10-10).** The daemon loads and builds every pipeline once at
  startup (`src/serve/server.ts:2644-2657`). The build closes over the step list and graph
  (`src/bindings/mastra/build.ts:83-165`), each step's config, and the prompt **text**, read at load
  time (`src/canon/load.ts:330`) and rendered from the build-time string (`buildSteps.ts:486`).
  Nested children and loop bodies are expanded at load time too. `RunService.start` runs
  `this.mastra.getWorkflow(id)` (`src/runtime/runService.ts:593`) — the cached workflow — while the
  route's fresh definition feeds only provenance (`transportPerStep`) and logging
  (`builderLoggedSteps`). So after an edit, validation and provenance describe the new definition
  and execution runs the old one, silently. Nothing invalidates the cache except a lookup miss for
  some id. The project's provider config and `check` command are also fixed at startup.
- **Rebuild safety.** `rebuild()` is synchronous; in-flight runs hold their own `Run` objects and
  resume through them, so a rebuild does not disturb them. A throw from one pipeline's build aborts
  the whole rebuild today — a per-pipeline guard is needed if rebuilds become routine.
- **Options.** (A) Fingerprint the loaded pipeline on `getWorkflow` and rebuild when it changed —
  catches edits made outside the daemon, keeps signatures, leaves a small window between the
  route's read and the fingerprint read. (B) Invalidate from the page's write routes — misses edits
  from an editor or `git checkout`, the main path; rejected. (C) Build from the definition the route
  validated, cached by content hash — one source of truth, fixes provenance by construction, but
  changes `MastraLike` / `RunService.start` and every start path. **Recommended: C**, which overlaps
  FR-10; A is the stopgap if C is too wide.
- **Test to write first.** In `src/bindings/mastra/dynamicMastra.test.ts` (real Mastra + LibSQL):
  build at "startup", edit the prompt to `NEW` and add a step, start a run, assert the recorded
  prompt is `NEW` and the new step ran — red today.

### FR-17. Daemon `git status` callers (follow-up from the FR-3 audit)

- **Evidence.** `src/runtime/gateMaterial.ts:30` and `src/bindings/mastra/buildSteps.ts:75`
  (`workspaceDirtyMessage`) run `git status --porcelain` in the project with no config overrides,
  hardened env or timeout. The auditor reproduced both running a repo-configured `core.fsmonitor`
  and a `filter.<name>.clean` command for a stat-dirty file. `src/canon/workspace/sanitize.ts:146`
  (`git ls-files`) is lower risk.
- **Fix direction.** One hardened git helper shared by every daemon caller (overrides, per-call env,
  timeout); `filter.*.clean` needs its own answer, since it cannot be disabled by a single `-c`.
  Not yet designed.

## Phase 2+ — deepening candidates

Each is **Proposed**; D5 applies.

### FR-9. Step attempt (Phase 2, top recommendation)

- **Problem.** The provider seam is real — one `ProviderAdapter` with three adapters,
  dispatched in `adapterFor` — but the request each adapter receives is built by its
  callers. `buildLlmStep` (`buildSteps.ts:452-731`) normalises the step, inherits the
  budget (restated in `src/canon/portability.ts:64`), runs failover and the schema retry;
  `src/runtime/gateJudge.ts:135-139` and `src/runtime/gateSummary.ts:137-141` each branch
  on `transport === "api"`. A test comment records a past leak at this seam
  (`build.test.ts:638-641`).
- **Direction.** The canon owns attempting a step on a model: request normalisation,
  capability check, remaining budget, failover chain and schema retry behind one interface;
  the Mastra binding and the two gate modules call it. `runLlmStep`
  (`src/canon/runStep.ts:352-358`) is a pass-through that would go.
- **Dependency category.** Ports & adapters — three adapters plus a fake spawn already
  exist.

### FR-10. Run start (Phase 4)

- **Problem.** Every rule for a valid run lives in the `POST /api/runs` handler
  (`src/serve/server.ts:1800-2005`); `RunService.start` has one caller. The route merges
  `models` and `provider` into the input and `start` splits them back out
  (`runService.ts:616`). The reserved-key rule is written at `server.ts:467`, `build.ts:86`,
  `buildSteps.ts:292` and `load.ts:540`. The route must pass `pipelineBodies` so llm steps
  are not logged twice (`server.ts:1994-1998`).
- **Direction.** One run-start module under HTTP owns definition lookup, validation, input
  merge and the definition actually executed (FR-8 is fixed; this module does not absorb
  it); the route maps refusals to status codes.
- **Reserved keys (shipped first).** `RUN_CONTROL_KEYS` (`src/canon/runContext.ts`) is the
  one list of `models` and `provider`. The loader now refuses a step id or an input name in
  that set, including in a loop body or nested child, since a top-level step's output lands
  at `ctx[step.id]` and a step named `models` with JSON output would become the next steps'
  model overrides, past the route's validation. A user pipeline that already uses either
  name stops loading until it is renamed; no bundled pipeline does. Expanded nested ids are
  prefixed, so only the standalone load of a child can newly fail.
- **Run start (shipped second).** `startRun(req, deps)` in `src/runtime/runStart.ts` owns
  every rule that was in the `POST /api/runs` handler, in the same order and with the same
  strings, and returns `{ ok: true; result }` or `{ ok: false; refusal: "invalid"; error }`;
  the route parses the body, calls it and maps a refusal to a 400. A pipeline no layer
  defines is now a refusal (`Pipeline "x" not found`) instead of a 500 from the workflow
  lookup, and one that exists but fails to load says `fails to load: <reason>` with the layer
  root redacted by `safePath`. A throw out of `startRun` is a bug. It still imports
  `artifactInputs.ts` and `safePath` from `src/serve/`; moving them is cosmetic and deferred.
- **Scope.** The lead cut FR-10 to the reserved-key rule plus a `startRun` module below the
  route. Narrowing `RunService.start` and passing the validated definition to
  `getWorkflow` are deferred: the first relocates the merge rather than removing it and
  collides with FR-11's `runService.ts` edits, the second re-opens FR-8 option C.

### FR-11. Run store (Phase 3)

- **Problem.** The run directory is joined in four places (`runService.ts:1538`,
  `artifactStore.ts:523,573`, `server.ts:2181`, `daemonTools.ts:588`); `"manifest.json"`
  appears in six. Two readers pick a chain directory's file differently
  (`artifactStore.ts:464-469` vs `daemonTools.ts:596-600`). The artifact is untyped
  (`runService.ts:1599`, read back with `as unknown as`). Step status is typed `string`
  (`runService.ts:152`); status sets are restated in `idleShutdown.ts:78-82`,
  `daemonTools.ts:49-55, 530`, `artifactInputs.ts:232`, `ui-tables.js:13`.
- **Direction.** One run store owns where a run lives (chains included), which file
  describes it, typed read-back, and the status vocabulary including restored-not-live and
  orphaned.

### FR-12. Pipeline by id (Phase 3)

- **Problem.** `src/canon/layers.ts:178` calls the merged catalogue "the read path every
  surface uses", but `loadPipeline` falls back to the sibling file (`load.ts:519-521`) and
  about ten callers take that default: `findPipelineById` (`server.ts:250-266`, used at
  1428, 1475, 1589, 1620), prompt save (1518), draft preview (1701),
  `canonWriter.ts:66, 138`, `validate-cli.ts:19`, `write-cli.ts:48`, `doctor.ts:612`.
  Likely consequence: a fork whose children live in another layer cannot be opened in the
  editor (404). `server.test.ts` pins a single `pipelinesDir`.
- **Direction.** Loading by id within a project is the only public entry point; it resolves
  nesting through the merged view and answers the editable file, its prompts and its
  nesters. The bare-path loader becomes internal.

### FR-13. Output-schema contract (Phase 4)

- **Problem.** The canon holds schemas and ajv checks (`src/canon/validateOutput.ts`); the
  Mastra binding holds JSON extraction, the top-level key check and retry notes
  (`buildSteps.ts:202-372`); Binding A retypes the schemas by hand
  (`claudeCode.ts:192-220`) — "nothing mechanical catches that today" (`:26`).
- **Direction.** One canon module decides whether a raw answer satisfies schema X, what the
  retry note says, and serialises the schema for both bindings. ADR-0016: the "Return ONLY
  JSON" suffix stays in the binding.

### FR-14. One review capture (Phase 5)

- **Problem.** `src/runtime/reviewMaterial.ts` (1147 lines) and
  `plugin/skills/review/scripts/capture.mjs` (1335 lines) implement the same capture; the
  audit's fixes are tested on the plugin copy only (`src/af-plugin/capture.test.ts:746-958`);
  nothing pins one to the other.
- **Direction.** One capture module; the plugin's dependency-free copy is generated with a
  freshness test, as `plugin/workflows/review-engine.js` is (spec 046 FR-5).
- **Superseded line counts:** see Decisions → FR-14 for the final sizes.

### FR-15. Run view state (Phase 6, optional)

- **Problem.** `src/serve/ui.html` (3779 lines) holds request routing, snapshot/SSE/refresh
  and the output cache in one inline script; tests match its source text with regexes
  (`ui-refresh.test.ts:19-29`, `ui-requests.test.ts:38-69`, `ui-step-output.test.ts:55-62`).
  The last six page fixes (060e3e7, 9e8268b, 1ce2864, bd77d98, bf66fef, 0a633cd) all edited
  `ui.html`.
- **Direction.** Move routing and run-view state into DOM-free `ui-*.js` modules. Optional:
  the owner runs af from chat, not the page.

### FR-16. Canon to workflow script (Phase 5)

- **Problem.** `src/bindings/claudeCode.ts` and `src/af-plugin/buildReviewEngine.ts`
  generate Claude workflow scripts with different prompt embedding and hard-coded model
  tiers; a change to `pipelines/code-review.yaml` neither reaches the plugin nor turns a
  test red.
- **Direction.** One module turns a canon pipeline into a workflow script, carrying
  topology, `required` flags and roles as data (spec 046 D5's fail-and-continue choice
  included).

## Decisions made during implementation (2026-10-10)

The owner asked to "work till the end", so the lead made the open design calls. Each was challenged by a `devil` review before code, and each is recorded here so it can be overturned:

### FR-8 — option A, not C

The daemon fingerprints the requested pipeline (sha256 of its loaded definition, prompts and nested children) on every `getWorkflow`. It rebuilds from that same read when the fingerprint changed. It fails closed: an absent, unloadable or unbuildable requested pipeline throws and never runs from cache. Other pipelines that fail to build during a rebuild keep their previous workflow (carry-forward). A per-pipeline guard at startup means one broken pipeline no longer stops the daemon. The replaced Mastra instance's global hooks are unregistered (never `shutdown()`, which would break in-flight runs). Page saves are atomic (temp file + rename). Option C (build each run from the route's validated definition) was not taken: it changes `MastraLike` / `RunService.start` and every start path, and registering several builds under one workflow id in Mastra is unverified. A small window remains between the route's read and the fingerprint read. Out of scope: `providers.yaml`, the env profile and `checkCommand` remain fixed at daemon start. Commits 5879ffc, dc7f5fa.

### FR-17 — narrower than the audit framed it

These `git status` calls run in the owner's own project under the owner's own git config. Disabling `filter.*.clean` would break Git LFS, and the owner's own terminal `git status` runs the same filters. So one helper (`src/runtime/projectGitStatus.ts`) adds `core.fsmonitor=false` (fsmonitor is only a performance cache), `GIT_OPTIONAL_LOCKS=0` (no index lock while the owner uses git), `GIT_NO_LAZY_FETCH=1` and a timeout. A repo-configured clean filter remains an accepted risk. Commit a6f8db7.

### FR-9 — reduced scope

Four behaviour-preserving commits: an output contract (`src/canon/outputContract.ts`), a step-attempt module (`src/canon/stepAttempt.ts`, owning failover and the schema retry), the Mastra binding switched onto it (`failover.ts` deleted), and `runLlmStep` replaced by the `Dispatch` type. Decided after review:

- The binding keeps its portability pre-flight before `step.start`, so an unportable step never logs and `required: false` cannot swallow it.
- The output contract keeps the `parse` / `schema` retry reason the step log reports.
- The result type is only `{ value, answeredBy }`.
- **Dropped:** retrying under the _remaining_ budget and deadline. The retry keeps the full allowance as today, because only claude reports cost and the project runs steps without duration limits.
- **Deferred:** moving the gates (judge, summary) onto the attempt. They keep their explicit transport decision and the judge keeps its own retry loop.

### FR-11 — run store, the 80% path

- Both traced defects were confirmed by review:
  - a chained stage's run id is unreachable after a daemon restart, on every reader (HTTP and MCP);
  - the HTTP and MCP disk readers can pick different files in a chain directory.
- **Shared vocabulary:** one status vocabulary (`src/runtime/runStatus.ts`) is shared by the readers.
- **One store:** `src/runtime/artifactStore.ts` is deepened into the run store, with no new wrapper module.
- **Locating a run:** by its own id, scanning run directories pre-filtered by the run id's text before parsing, for the artifact whose `runId` matches. There is no pointer file.
- **No borrowing another run's file:** a run whose own artifact is gone is not found, instead of being shown another run's data. This covers a re-run of the same pipeline overwriting the earlier one.
- **Chained stages are listed:** the list shows one row per run, chained stages included.
- **MCP:** `get_run` gains `source` (live / disk), and a restored run waiting at a gate is not offered for approval.
- **`settledAt`:** the disk reader omits it for unfinished runs. What is written to disk does not change.
- **Dropped:** a chain pointer file (it cannot express an anchor in another project, and does not name the pipeline of a crashed child), a typed artifact rewrite, an on-disk `settledAt` change, and the page changes.
- **Accepted:** a crashed in-flight chained stage, and anchors in another project, are not resolvable after a restart.

### FR-10 — the 80%: reserved keys + startRun

- `src/canon/runContext.ts` holds `RUN_CONTROL_KEYS` (`models`, `provider`), used by the loader, the Mastra binding and the run starter.
- The loader now refuses a step id or input name from that set. A step named `models` would otherwise have had its LLM output become the next steps' model choices. **User pipelines using either name stop loading;** no bundled pipeline does.
- `src/runtime/runStart.ts` `startRun()` owns validation, the input merge and artifact chaining below the HTTP route. It keeps the same check order and byte-identical refusal strings.
- **New refusals:** an unknown pipeline is a 400 refusal `Pipeline "x" not found` instead of a catch-all 500; a pipeline that exists but fails to load is reported as `fails to load: <redacted reason>`.
- The dead `validateModelOverrides` was removed.
- **Deferred:**
  - narrowing `RunService.start` (it relocates the merge and conflicts with FR-11);
  - `getWorkflow(id, loaded)` (it would reopen FR-8 option C);
  - moving `artifactInputs.ts` to runtime.

### FR-12 — pipeline by id: owner decisions D1–D3

- **D1:** a pipeline whose winning file is in the repo or the user layer is editable in the page — edit, prompt write and delete. The page already offers "user" as a fork target and shows Delete for user rows. Bundled is never editable. The create route stays repo-only.
- **D2:** delete is allowed when nesting pipelines exist but a lower layer still defines the id; nesters fall back to the lower version.
- **D3:** a pipeline file that fails to load stays 404 in the editor (out of scope).

Also decided after review:

- **Bundled guard:** bundled mode keeps its 403 before any lookup, and every refusal drains the request body.
- **`check(path, edits)`:** refuses paths outside a workflow layer and takes prompt paths from the draft body.
- **`saveDraft`:** checks editability itself.
- **Public API kept:** `MergedCatalog` stays public for fork, export and the CLIs.
- **Duplicate ids:** two files declaring one id in a layer are reported as errors, and "still in use" counts only winning pipelines.
- **CLIs:** they fail on catalogue errors.
- **Redaction:** error paths are redacted relative to the file's own layer.
- **Deferred:** removing the loader's sibling-file fallback. A lint rule routes production code through the new module instead.

### FR-12 follow-ups from review and security audit

- Editability is decided by real path, not by layer label. A repo or user layer whose `pipelines/` is a symlink into the installed package could otherwise delete a package file. DELETE re-checks the owner immediately before removing.
- Every refusal drains the request body.
- One helper redacts every layer root, the package root and the home directory in all error paths.
- Deleting a user-library workflow shows a confirm naming the user layer and "every project on this machine".
- An empty or missing bundled catalogue fails `validate`, `generate` and `doctor` again.

### FR-13 + FR-16 — the 80%

- **FR-13:** Binding A emits `JSON.stringify` of the canon's own schemas. This closes a latent `ReferenceError` (an undefined `CODE_REVIEW_DELIVERY_SCHEMA`) for user pipelines.
- **FR-16:** one test loads `pipelines/code-review.yaml` and pins the plugin's review engine to it: steps, every dependency edge (by stub event order), models per role, and schema keys. The plugin's deliberate continue-on-failure choices (falsifiability, correctness and security degrade to a marker; synthesis logs only) are an explicit list that must equal the observed deviations. In-memory YAML mutations each turn it red.
- `pipelines/code-review.yaml` was NOT changed to adopt the plugin's choices.
- **Deferred (updated in Phase 3):** the canon rules module, the TypeScript port and the YAML-derived tables were done in Phase 3 track G; Binding A's render/onFailure rewrite and a shared step-table module remain deferred. Nothing in the daemon reads Binding A output, and whether Binding A stays is spec 027's open owner decision.

### FR-14 — one capture core

- **The core:** `src/runtime/reviewCapture.ts` is the single capture core, and `src/runtime/reviewMaterial.ts` is now a thin daemon adapter (1287 → 307 lines).
- **The plugin copy:** `scripts/build-af-review-capture.mjs` transpiles the core into `plugin/skills/review/scripts/lib/*.mjs`, pinned by a freshness test and a Node ≥ 18 API denylist. It accepts only named `node:` builtins. `capture.mjs` (1349 → 589 lines) keeps the CLI and run-directory duties.
- **Plugin version 0.2.0:** Codex users must re-run `codex plugin add af@agent-flows`.
- **Deny list (policy, lead decision; the owner may overturn):**
  - Four credential files (`.git-credentials`, `.pypirc`, `.docker/config.json`, `.dockercfg`) are added to the shared credential list, so the review model's own Read, Grep and Edit tools are denied them too.
  - The dotenv globs (`.env.*`, `*.env`) are withheld from the material by both captures. So dotenv example files no longer appear in daemon material, though the model can still Read them.
- **Adopted for both callers:** control-character escaping (including spec titles and URLs), stopping after a `gh` timeout, `GIT_SSH_COMMAND=false` (so lazy fetch fails closed on git < 2.44), and attribute-free worktree snapshots (no repo-configured clean filters; needs git ≥ 2.40).
- **Plugin-only:** `GIT_CONFIG_NOSYSTEM`, `GIT_PAGER` and `LANGUAGE`.
- **Kept per caller:** whitespace baseline (the daemon derives one; the plugin refuses), empty diff (the plugin refuses), and the HEAD check (plugin).
- **Testing:** one hostile-repository table runs every case through four implementations: the TypeScript core, the generated `.mjs`, the daemon adapter and the CLI.
- **Not done:** the plugin smoke run (`/af:review` end to end) — the owner should re-run it.

### FR-15 — commit 1 only

- The page counts only live runs as in flight, using a pinned copy of the run-status rules with a parity test against `src/runtime/runStatus.ts`. Restored-from-disk rows don't count, don't tick, raise no approval banner, and show no gate box or Cancel.
- A run without a `source` (older daemons in the cross-project view) still counts as live.
- **Deferred to the owner (now Phase 3 track C):**
  - moving the run-view state (snapshot, SSE, refresh, output cache) out of `ui.html` into a DOM-free module, since there is no CI browser coverage and four of the last six page fixes were there;
  - the polling rule change.
- Browser test 33abe823 PASSED all 5 scenarios on 2026-10-13; report `~/.claude/chrome-test/agent-flows/report-33abe823.md`; run by dev session through Chrome tools against daemon on throwaway state home (real run directory untouched).
  - No screenshots (controlled tab was hidden, captures timed out).
  - Ticking checked with Refresh (hidden tab polls nothing by design).
  - Restored runs were patched copies of old runs, not a daemon killed mid-run.
  - Live run's gate summary made one model call.

## Follow-ups

- **Owner decisions:**
  - the FR-14 deny-list policy;
  - FR-12 D1 (user-layer workflows editable and deletable from the page);
  - whether Binding A stays (spec 027).
- **Open owner actions:**
  - re-run the `/af:review` smoke run.
- **Completed owner actions:**
  - re-add the Codex plugin (af 0.2.0 installed in Claude Code and Codex on 2026-10-13; both installed skills directories byte-identical to plugin/skills; Claude Code needs a restart to load it).
  - run the browser test request (PASS, report above).
- **Deferred design work:** pulled into Phase 3 (below), except Binding A's render/onFailure rewrite; FR-10 C3/C4, FR-11's typed artifact and chain pointer, FR-13/16's shared modules, FR-15 commits 2–3, removing the loader's sibling-file fallback (FR-12; a lint rule guards production code instead).
- **Smaller observations (pulled into Phase 3):** the step-journal invariant (`BUILDER_LOGGED_KINDS`), four copies of the daemon-record probe, the ticket DDL beside the Drizzle schema, `src/serve/editabilityRoutes.test.ts` symlink exercises, `artifact.test.ts` and `capture.test.ts` "audit L12" load sensitivity.

## Phase 3 — follow-ups (approved 2026-10-19)

Approved by the owner on 2026-10-19. Process same as Phase 2: design refreshed against current code, `devil` challenge before code, red-first tests with a recorded neuter probe for every new gate, reviewer after, security-auditor where paths, git or the page are touched, one commit per item. Each track in its own git worktree branched from feat/047 and cherry-picked back.

### Track A — run service (one worktree, items in order)

- **A0:** `artifact.test.ts`'s `flushAsync` stops waiting a fixed 20 ms; it waits for the condition it needs. AC: no fixed-delay wait left in it; file green when run alone and beside a full suite.
- **A1:** The step-journal rule (`BUILDER_LOGGED_KINDS`, `src/runtime/runService.ts`) is exhaustive over `StepKind`. AC: adding a `StepKind` without classifying it fails `tsc` (neuter probe recorded).
- **A2 (FR-10 C3):** `RunService.start` takes the loaded definition and the run control values (models, provider) as options instead of mixed into inputs; the control keys merge once; the split inside start is deleted. AC: no behaviour change; only the test calls that passed models/provider inside inputs change.
- **A3 (FR-11 remainder):** The saved run record gets a named type and a read-back normaliser at the disk boundary (unknown status → unreadable) replacing the `as unknown as` casts in runService. The chain pointer is re-examined first: if a chained stage that crashed before its first artifact is still not found by id after a restart, or its pipeline is lost, fix it with a design that also works when the anchor run is in another project; if no gap remains, record the evidence and drop it. On-disk `settledAt` only for terminal runs, if not already so.
- **A4 (FR-10 C4):** A feasibility test runs first: two builds of one workflow id with different definitions, one run in flight on the first while a second starts. Only if it passes does the run build from the definition the route validated; otherwise A4 is dropped and the evidence recorded. Flag: this reverses FR-8's recorded choice of option A.

### Track B — loader

- **B1:** Remove the loader's sibling-file fallback for nested pipelines (callers pass the resolver explicitly; a nested reference without one fails loudly; decide whether the lint rule that guarded production code is still needed).
- **B2:** `src/serve/editabilityRoutes.test.ts` stops symlinking into the real package directory; it uses a temporary package copy through the existing server options. AC for B2: the test never writes inside the real package directory.

### Track C — page (FR-15 commits 2–3)

Run-view state (snapshot, SSE stream, refresh, step output cache) moves out of `src/serve/ui.html` into a DOM-free `src/serve/ui-runview.js` tested in node; closing a session drops its late responses (replacing the separate staleness guards); one fetcher for step output; the output cache key includes the project. Commit 3 changes the polling rule so polling does not duplicate what the open stream delivers. The browser test fires again; it must start no paid model calls (test workflows use check steps only, no gate).

### Track D — daemon records

One function in `src/runtime/daemonRecord.ts` answers which daemon, if any, serves a project; `src/serve/daemons.ts`, `src/serve/stop.ts`, `src/bindings/mastra/daemonResolver.ts` and `src/doctor.ts` use it. AC: no behaviour change; existing tests unchanged and green.

### Track E — database

A test fails when the hand-written ticket DDL (`src/db/index.ts`) and the Drizzle schema (`src/db/schema.ts`) disagree on tables, columns, types, nullability or primary key (neuter probe recorded).

### Track F — tests

The root cause of the `capture.test.ts` "audit L12 timeout" hang (once 16 minutes under load) is found and fixed, or the test is made independent of machine load; evidence recorded. Outcome: hardening only — see the decisions below.

### Track G — plugin and bindings (FR-13/16 remainder, Binding A untouched)

The plugin generator moves to TypeScript with generated output unchanged apart from its header; the cross-field schema rules live once in the canon and the plugin's schema JSON files are generated from them; the generator derives the review engine's steps, models, failure modes and schema keys from `pipelines/code-review.yaml` instead of hard-coding them.

### Decisions made during Phase 3 (2026-10-19)

**Track A** (run service):

- A0, A1, A2 done. A2 deviation: the merge of models/provider into the workflow input moved into `RunService.start` (Mastra reads them from the input), it was not removed; about 25 test call sites changed, not only the four the AC named.
- A3a done. Deliberate behaviour changes: an unknown or missing on-disk status reads as `unreadable` (with the error and the file path); undeclared keys are no longer passed through from disk artifacts; the pipeline id falls back to provenance, then the file stem. A golden round-trip test pins every field a restored run shows (including a failed-over step's `actual`).
- A3b done without a pointer file: a chained stage that crashed before its artifact is found by scanning only the first 64 KiB of unclaimed events files, confirming the top-level `runId`; regular files only; misses are remembered for up to 2 s. Limits: an events file can hold several runs; a crashed stage re-running a pipeline whose stem an artifact already claims stays unresolved; a stage whose anchor is in another project is found only by that project's daemon.
- A3c cut. Evidence: the readers already hide `settledAt` for non-terminal runs; a new `persistedAt` field would make an older daemon drop a gate-suspended stage from the manifest.
- A4 cut by the lead, not by a failed feasibility test. Evidence: there is no `await` between the route's lazy, synchronous load and `getWorkflow`, so only an outside writer in a window of a few milliseconds can race; approve and resume use the Run created at start, so a resumed run can't pick up a different build (now pinned by a test); the change would also reverse FR-8's fail-closed rule. The owner may overturn.

**Track B** (loader):

- B1 done (the closure's no-resolver mode stays, test-only, because it holds the traversal guard; the lint rule stays as the single-entry guard). B2 done through a new programmatic seam: `resolveLayers`/`projectPipelines` take an injectable bundled root, set only from `ServeOptions.bundledPipelinesDir` (basename must be `pipelines`); no CLI, env or HTTP path sets it.

**Track C** (page, FR-15 commits 2–3):

- Commit 2 done (one run session per opened run; `close()` replaces the staleness guards and fixes five unguarded cases; one step-output fetcher; the cache key includes the project; a missing output is cached only if the step had settled when asked; run and step ids `.`/`..` are refused). Commit 2b fixes Copy on a re-opened settled run. Commit 3 re-scoped: its premise was false (nothing polled while a run stream was open); it now refreshes the run list and daemons panel beside an open run on a wide screen (more requests, none removed) and deletes the dead stream check. Cut: follow states, detached-run polling, `coversRun`.
- Browser test `~/.claude/chrome-test/agent-flows/report-a7f3f53a.md` (2026-10-19, run by the dev session through the Chrome tools against two throwaway daemons, no model calls): stream lifecycle, fast switching within and across projects, step outputs, Copy after re-open, the same run id in two projects, live command blocks and a stream error all PASS. The split-view polling scenarios were NOT EXERCISED because the controlled tab was hidden; the owner should glance at a wide `#/runs/<id>` view.

**Track D** (daemon records):

- Done for `daemons.ts`, `stop.ts` and `doctor.ts`. `findOurDaemon` stays separate (it probes the pinned port first, ignores the recorded pid and throws on a version mismatch) — a deviation from "four callers". Added: a daemon record whose pid is not an integer above 1 or whose port is outside 1–65535 is refused; the stop path signals only inside the `verified` branch.

**Track E** (database):

- Done. The test cannot see drift in an existing on-disk database, because `CREATE TABLE IF NOT EXISTS` never migrates one.

**Track F** (tests):

- Hardening, not a root-cause fix: the 16-minute hang was not reproduced and its cause is unknown. Timed-out `git`, `gh` and the provider login probe are now killed with SIGKILL (a timeout did not bound a child that ignores SIGTERM). The test script fails any test file that runs longer than ten minutes (node applies `--test-timeout` per file). Left unbounded: `src/canon/workspace/sanitize.ts` `git ls-files` and `src/harness/harnesses.ts` `defaultRun`.

**Track G** (plugin and bindings, FR-13/16 remainder, Binding A untouched):

- G1 done (`src/af-plugin/buildReviewEngine.ts`, `pnpm plugin:generate`). G2 done (the eight rules live in `src/canon/schemaRules.ts`; the plugin's schema JSON is generated and came out byte-identical). G3 reduced: the generator reads the step list, models, schema keys and prompts from `pipelines/code-review.yaml` and refuses unsupported shapes; failure handling and the schedule stay hand-written in the engine body (rewriting them needs a paid smoke run); no shared `workflowSteps.ts` (one consumer). A new test fails if the engine serialises steps the YAML leaves independent.

### Follow-ups found in Phase 3

- `waitForSettled` never resolves for an auto-mode run after a human approves its gate (`approve()` never calls `settle()`); no production caller today.
- The run header, gate box and Cancel go stale after a streamed run settles: the stream never carries run-level status (needs a server-side run event).
- Declared steps are fetched from the page's project, not the run's; `primeDeclaredSteps` re-renders from an older snapshot.
- Export reads prompt files and fork writes targets with lexical path checks only (no realpath check against symlinks).
- `doctor` ignores `AGENT_FLOWS_PORT`; `removeDaemonRecordIfOwned` checks the pid only.
- `layerForPipelinesDir` still labels an injected bundled root "repo".
- The split view's 4 s poll re-renders the run list, which drops keyboard focus.
- A run interrupted before its first artifact (events file only) returns 404 over HTTP after a daemon restart, so an open page keeps a stale "running" view with Cancel; only the MCP daemon-down reader finds it.

### Excluded from Phase 3

- Binding A's render/onFailure rewrite (waits on spec 027's decision whether Binding A stays).
- Paid smoke runs.
- Push and merge.
- OpenCode support (on hold).

## Tests

- Phase 1: each FR's regression test is run red before its fix and green after (D2).
  Targeted files via `bash scripts/test.sh <file…>`; the lead runs the full suite plus
  `. scripts/use-pinned-node.sh && ./node_modules/.bin/{eslint,tsc,prettier}`.
- Phase 2+: acceptance criteria are written in the amendment each candidate's design pass
  produces.

## Out of scope

- Splitting `handleRequest` routes into files (2026-09-21 measurement: no field
  clustering).
- Retiring af's `code-review` pipeline in favour of the plugin (owner's call).
- Smaller observations not pulled into a phase: the owner-only file-mode rule restated in four modules, the `{{…}}` pattern written four times, the CLI verb list kept three times in `src/cli.ts`.

## Risks

- FR-3 changes the bytes of review material; stored code-review fixtures or eval
  expectations may move.
- FR-4 refuses user pipelines that declare skills on codex or api; today they run silently
  without them.
- Parallel implementers share one worktree: file sets must be disjoint (D6), and
  `pnpm check` is only trusted in a quiet tree.
- FR-3's refusal is fail-closed: any stderr from the rename pass refuses a capture in which a
  credential-shaped path changed, including on repositories with many renames.
