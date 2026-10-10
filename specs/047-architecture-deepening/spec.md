# 047. Deepening the architecture, and the defects found on the way

| Field        | Value                                                                                  |
| ------------ | -------------------------------------------------------------------------------------- |
| Feature Name | Architecture deepening — eight candidates, eight defects                               |
| Branch       | `feat/047-architecture-deepening`                                                      |
| Status       | Phase 1 + FR-8 + FR-17 done; FR-9, FR-11, FR-12 in progress (decisions recorded below) |
| Created      | 2026-10-10                                                                             |

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

| ID    | Requirement                                                              | Phase | Status      |
| ----- | ------------------------------------------------------------------------ | ----- | ----------- |
| FR-1  | Schema retry after a successful failover runs on the model that answered | 1     | Fixed       |
| FR-2  | Binding A: a parallel level's results are reachable by later prompts     | 1     | Fixed       |
| FR-3  | Daemon review capture cannot be blinded by repository git config         | 1     | Fixed       |
| FR-4  | A step that declares skills never lands on a transport that ignores them | 1     | Fixed       |
| FR-5  | The manifest route resolves a chained stage's run id                     | 1     | Fixed       |
| FR-6  | The run progress line names the step that is actually running            | 1     | Fixed       |
| FR-7  | Load rejects prompt placeholders the runtime never provides              | 1     | Fixed       |
| FR-8  | An edited pipeline runs its edited definition                            | 1     | Fixed       |
| FR-9  | Step attempt: the canon owns running a step on a model                   | 2     | In progress |
| FR-10 | Run start: the rules for a valid run live below the HTTP route           | 4     | Proposed    |
| FR-11 | Run store: one module owns where a run lives and what its status means   | 3     | In progress |
| FR-12 | Pipeline by id: one way to load a pipeline across layers                 | 3     | Designed    |
| FR-13 | Output-schema contract lives in the canon                                | 4     | Proposed    |
| FR-14 | One review-capture module, generated into the plugin                     | 5     | Proposed    |
| FR-15 | The page's run-view state moves out of inline script                     | 6     | Proposed    |
| FR-16 | One generator from a canon pipeline to a Claude workflow script          | 5     | Proposed    |
| FR-17 | Daemon `git status` callers cannot run repo-configured commands          | 1     | Fixed       |

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

### FR-15. Run view state (Phase 6, optional)

- **Problem.** `src/serve/ui.html` (3779 lines) holds request routing, snapshot/SSE/refresh
  and the output cache in one inline script; tests match its source text with regexes
  (`ui-refresh.test.ts:19-29`, `ui-requests.test.ts:38-69`, `ui-step-output.test.ts:55-62`).
  The last six page fixes (060e3e7, 9e8268b, 1ce2864, bd77d98, bf66fef, 0a633cd) all edited
  `ui.html`.
- **Direction.** Move routing and run-view state into DOM-free `ui-*.js` modules. Optional:
  the owner runs af from chat, not the page.

### FR-16. Canon to workflow script (Phase 5)

- **Problem.** `src/bindings/claudeCode.ts` and `scripts/build-af-review-workflow.mjs`
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
- **Locating a run:** by its own id, scanning run directories for the artifact whose `runId` matches. There is no pointer file.
- **No borrowing another run's file:** a run whose own artifact is gone is not found, instead of being shown another run's data. This covers a re-run of the same pipeline overwriting the earlier one.
- **Chained stages are listed:** the list shows one row per run, chained stages included.
- **MCP:** `get_run` gains `source` (live / disk), and a restored run waiting at a gate is not offered for approval.
- **`settledAt`:** the disk reader omits it for unfinished runs. What is written to disk does not change.
- **Dropped:** a chain pointer file (it cannot express an anchor in another project, and does not name the pipeline of a crashed child), a typed artifact rewrite, an on-disk `settledAt` change, and the page changes.
- **Accepted:** a crashed in-flight chained stage, and anchors in another project, are not resolvable after a restart.

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
- Smaller observations not pulled into a phase: the step-journal invariant
  (`BUILDER_LOGGED_KINDS`, `runService.ts:315-354`), four copies of the daemon-record
  probe, the ticket DDL restated beside the Drizzle schema (`src/db/index.ts:10-107`), the
  owner-only file-mode rule restated in four modules, the `{{…}}` pattern written four
  times, the CLI verb list kept three times in `src/cli.ts`.

## Risks

- FR-3 changes the bytes of review material; stored code-review fixtures or eval
  expectations may move.
- FR-4 refuses user pipelines that declare skills on codex or api; today they run silently
  without them.
- Parallel implementers share one worktree: file sets must be disjoint (D6), and
  `pnpm check` is only trusted in a quiet tree.
- FR-3's refusal is fail-closed: any stderr from the rename pass refuses a capture in which a
  credential-shaped path changed, including on repositories with many renames.
