# Evaluating workflow quality: what the stack already provides

Date: 2026-09-05
Question: how to quality-check the SDLC workflow library of ADR-0015, at two levels —
(a) an individual workflow (`investigate`, `plan`, `audit`), (b) the whole pipeline end-to-end.
Framing: ergonomics audit. Reuse what the stack has; build nothing bespoke unless forced.

Verification method: Mastra claims are checked against the **installed** `@mastra/core@1.63.2`
type declarations and bundle source in `node_modules`, not only against the docs site. Where the
docs and the installed code differ, the installed code wins and is marked as such.

---

## 1. What Mastra already gives us

### 1.1 The primitives exist and are already installed

`@mastra/core@1.63.2` exposes an `./evals` subpath (confirmed in
`node_modules/@mastra/core/package.json` exports). Its public surface, from
`node_modules/@mastra/core/dist/evals/index.js`:

```
createScorer, MastraScorer, runEvals, filterRun, collectToolMocks,
extractTrajectory, extractWorkflowTrajectory, extractTrajectoryFromTrace,
scoreRowDataSchema, saveScorePayloadSchema, … (+ ./evals/scoreTraces)
```

**`createScorer(config)`** — a scorer is a chainable pipeline. Verified signature
(`dist/evals/base.d.ts:361-370`), docs at
<https://mastra.ai/docs/evals/custom-scorers> and
<https://github.com/mastra-ai/mastra/blob/main/docs/src/content/en/reference/evals/create-scorer.mdx>:

```ts
import { createScorer } from "@mastra/core/evals";

const s = createScorer({
  id: "grounded-in-repo",
  description: "Every cited path exists on disk",
  judge: { model, instructions, tools }, // optional — omit for a pure-code scorer
})
  .preprocess(({ run, results }) => any) // optional
  .analyze(({ run, results }) => any) // optional
  .generateScore(({ run, results }) => number) // REQUIRED, returns a number
  .generateReason(({ run, results, score }) => string); // optional

const score = await s.run({ input, output, groundTruth }); // → { score, reason, … }
```

Two facts that matter for us, both verified in `dist/evals/base.d.ts`:

- A scorer with **no `judge`** is pure deterministic code — no LLM, no cost, no flakiness.
  The docs call this "deterministic logic without LLM involvement—no judge configuration needed."
- `ScorerJudgeConfig.tools` exists, documented in-source as: _"e.g. a goal judge that inspects the
  workspace with readonly tools to independently verify the agent's claims, rather than grading
  text alone."_ This is exactly the shape needed to grade "did `investigate` really read the repo".
- A scorer is **callable standalone** via `scorer.run({...})`. It does not require `runEvals`,
  a Mastra instance, or storage. This is what makes it droppable into the repo's existing
  `node:test` suite.

### 1.2 It scores WORKFLOW runs — this is the crucial answer

`runEvals` has a dedicated overload for `AnyWorkflow` targets accepting a `WorkflowScorerConfig`
(verified, `dist/evals/run/index.d.ts`):

```ts
export type WorkflowScorerConfig<TScorer = RunEvalsScorer> = {
  /** Scorers that evaluate the overall workflow input/output */
  workflow?: TScorer[];
  /** Scorers that evaluate individual workflow steps by step ID */
  steps?: Record<string, TScorer[]>;
  /** Scorers that evaluate the workflow's step execution trajectory */
  trajectory?: TScorer[];
};
```

Usage (docs:
<https://github.com/mastra-ai/mastra/blob/main/docs/src/content/en/reference/evals/run-evals.mdx>):

```ts
const result = await runEvals({
  target: myWorkflow,
  data: [{ input: { request: "…" } }],
  scorers: { workflow: [outputScorer], steps: { critic: [criticScorer] }, trajectory: [trajScorer] },
  gates: [mustPassScorer],  // must average 1.0 or verdict === "failed"
  concurrency: 1,
  onItemComplete: ({ item, targetResult, scorerResults }) => { … },
});
// → { scores, summary:{totalItems}, verdict?: "passed"|"scored"|"failed", gateResults?, thresholdResults? }
```

`gates` is the CI-relevant piece: verified in the bundle
(`dist/agent-B8m3ps7U.js`, `async function runEvals`), a gate's averaged score must be `>= 1`
or `result.verdict = "failed"`. Threshold-bearing scorers that miss yield `"scored"`;
everything green yields `"passed"`.

**Both ADR-0015 levels map onto one API: `scorers.steps` is level (a) — per-workflow-step quality;
`scorers.workflow` + `scorers.trajectory` + `gates` is level (b) — the whole pipeline.**

### 1.3 Built-in scorers

Prebuilt scorers live in the separate **`@mastra/evals`** package (latest `1.10.0`), **which is NOT
installed here** — this repo has only `@mastra/core`, `@mastra/libsql`, `@mastra/mcp`.
Its peer deps are `@mastra/core: >=1.0.0-0 <2.0.0-0` (compatible with our 1.63.2) and
`vitest: >=3.0.0 <5.0.0` marked **`{ optional: true }`** (verified via `npm view`), so adding it does
not force vitest on a `node:test` repo. Export paths: `@mastra/evals/scorers/prebuilt`,
`@mastra/evals/checks`, `@mastra/evals/vitest` (unused by us).

Source: <https://mastra.ai/docs/evals/built-in-scorers>

LLM-judge scorers (accuracy/reliability): `answer-relevancy` (is the answer on-topic),
`answer-similarity` (vs ground truth), `faithfulness` (supported by supplied context),
`hallucination` (contradictions / unsupported claims), `completeness` (required info present),
`content-similarity` and `textual-difference` (string-level), `tool-call-accuracy`,
`trajectory-accuracy` (executed step sequence vs expected), `prompt-alignment` (did it do what was
asked), `multi-turn-judge`. Context quality: `context-precision`, `context-relevance`.
Output quality: `tone-consistency`, `toxicity`, `bias`, `keyword-coverage`.

Deterministic, zero-LLM **Quick Checks** (`@mastra/evals/checks`, namespace verified in
`packages/evals/src/scorers/code/checks/index.ts`):
`includes, excludes, equals, matches, similarity, calledTool, didNotCall, toolOrder, maxToolCalls,
usedNoTools, noToolErrors`.

Relevance to us: almost all the LLM judges are tuned for RAG/chat answers, not for "is this
implementation spec good". The genuinely reusable ones are `prompt-alignment`, `completeness`,
`faithfulness` (for grounding a critique in a diff), and the whole `checks.*` namespace as free
gates. `trajectory-accuracy` is directly useful for asserting the pipeline executed the ADR-0015
stage order.

### 1.4 How they are run, and whether results persist

- **In code**: `runEvals(...)`, or `scorer.run(...)` standalone.
- **Live/inline**: attach `scorers: { id: { scorer, sampling: { type: "ratio", rate: 1 } } }` to an
  agent, or to a `createStep({ … scorers })` in a workflow. Runs async in the background; supports
  a declarative `filter` predicate evaluated before sampling.
- **Trace scoring after the fact**: `@mastra/core/evals/scoreTraces` exports
  `scoreTraces({ scorerId, targets:[{traceId, spanId}], mastra })`, plus `scoreTrace` /
  `scoreTraceBatch({ storage, scorer, targets, batchId, datasetId, concurrency })`.
- **Datasets / experiments**: `mastra.datasets.get({id})` then
  `dataset.startExperiment({ targetType: "workflow", targetId, scorers, maxConcurrency })`
  → `ExperimentSummary { succeededCount, totalItems, status }`.
- **Storage**: scores persist to the **`mastra_scorers`** table when storage is configured _and_
  the scorers are registered on the `Mastra` instance. Verified in the bundle: `runEvals` reads
  `target.getMastraInstance?.() || target.mastra` then `mastra?.getStorage()`, and only calls
  `saveScoresToStorage` when storage is non-null. Our `smoke.ts` already builds
  `new Mastra({ storage: new LibSQLStore(...), workflows: {...} })`, so persistence is one
  `scorers: {...}` key away.
- **UI**: Mastra Studio (Observability section) shows scores, per-item pass/fail and experiments.
  Requires the `mastra` CLI package (v1.27.3), **not installed here**.
- **CLI**: no dedicated `mastra eval` command is documented. _(Unverified — absence of evidence.)_
  CI integration is documented only as "scorers can be part of your CI/CD pipeline", i.e. you run
  `runEvals` from a script and branch on `verdict`.

### 1.5 HITL / suspended workflows — the one real gap

This is where the docs are silent and the installed source is decisive.
`dist/agent-B8m3ps7U.js`, `executeWorkflow`:

```js
async function executeWorkflow(target, item, targetOptions) {
  const workflowResult = await (await target.createRun({ disableScorers: true })).start({
    ...targetOptions, ...item.startOptions, inputData: item.input, ...
  });
  return { traceId, spanId, entityType: EntityType.WORKFLOW_RUN, scoringData: {
    input: item.input,
    output: workflowResult.status === "success" ? workflowResult.result : void 0,
    stepResults: workflowResult.steps,
    stepExecutionPath: workflowResult.stepExecutionPath,
  }};
}
```

Consequences for our gated pipelines (our `approve` step calls `suspend()` — see
`buildGateStep` in `src/bindings/mastra/build.ts`):

1. **`runEvals` calls only `.start()`. It never calls `.resume()`.** A pipeline with a human gate
   returns `status === "suspended"`, so `scoringData.output` is `undefined` and every
   `scorers.workflow` entry grades `undefined`. Workflow-level scoring of a gated pipeline via
   `runEvals` alone is dead.
2. **Per-step scorers still work on a suspended run.** `WorkflowResult` for `status:'suspended'`
   carries `steps` and `stepExecutionPath` (verified, `dist/workflows/types.d.ts:781+`), and
   `runScorers` reads `targetResult.scoringData.stepResults?.[stepId]`, scoring any step with
   `status === "success" && output !== undefined`. So `intake`, `enrich`, `critic`, `security`,
   `assemble` are all scorable in a run that suspends at `approve`.
3. **Trajectory scorers still work**, falling back to
   `extractWorkflowTrajectory(stepResults, stepExecutionPath)` when no trace store is present.
4. `createRun({ disableScorers: true })` means inline step-level `scorers` are suppressed during
   `runEvals`; scorers must be passed explicitly in the `scorers` argument.

The workaround costs one function: drive `start()` → `resume()` yourself (which
`src/bindings/mastra/smoke.ts` and `src/runtime/runService.ts` already do) and call
`scorer.run({ input, output: finalResult })` on the resumed result. Scorers are standalone-callable,
so no harness is involved.

**Verdict 1: Mastra ships a complete, first-class eval layer — `createScorer` + `runEvals` with
per-step, whole-workflow, trajectory and pass/fail `gates` — and it is already installed in
`@mastra/core@1.63.2`; the single gap is that `runEvals` only `start()`s a run, so the post-gate
half of a HITL pipeline must be scored by calling `scorer.run()` on a result we resume ourselves.**

---

## 2. What Anthropic documents about building evals

Primary sources (the `docs.claude.com/en/docs/test-and-evaluate/*` pages now redirect to
`platform.claude.com`):

- <https://platform.claude.com/en/docs/test-and-evaluate/define-success>
- <https://platform.claude.com/en/docs/test-and-evaluate/develop-tests>

### 2.1 Defining success criteria

Criteria must be **Specific** ("Instead of 'good performance,' specify 'accurate sentiment
classification'"), **Measurable** ("Use quantitative metrics or well-defined qualitative scales" —
they note even ethics/safety can be quantified), **Achievable** ("Base your targets on industry
benchmarks, prior experiments, AI research, or expert knowledge"), and **Relevant** to the
application's purpose.

Dimensions to consider: task fidelity (including edge-case handling), consistency, relevance and
coherence, tone and style, privacy preservation, context utilization, latency, price.

Their worked contrast:

> Poor: "The model should classify sentiments well"
> Good: "…should achieve an F1 score of at least 0.85 (Measurable, Specific) on a held-out test set
> of 10,000 diverse Twitter posts (Relevant), which is a 5% improvement over the current baseline
> (Achievable)."

And: **"Most use cases need multidimensional evaluation along several success criteria."**

### 2.2 Eval design principles

1. **Be task-specific** — "Design evals that mirror your real-world task distribution. Don't forget
   to factor in edge cases!" (irrelevant/nonexistent input data, overly long inputs, poor or harmful
   input, ambiguous cases).
2. **Automate when possible** — "Structure questions to allow for automated grading (for example,
   multiple-choice, string match, code-graded, LLM-graded)."
3. **Prioritize volume over quality** — "More questions with slightly lower signal automated grading
   is better than fewer questions with high-quality human hand-graded evals."

### 2.3 Grading methods and when each applies

| Method                                | Kind           | When Anthropic says to use it                                                                                                             |
| ------------------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| **Exact match**                       | code           | "perfect for tasks with clear-cut, categorical answers"                                                                                   |
| **Cosine similarity** (Sentence-BERT) | code/embedding | "ideal for evaluating consistency because similar questions should yield semantically similar answers, even if the wording varies"        |
| **ROUGE-L**                           | code/metric    | summarization / relevance; "High ROUGE-L scores indicate that the generated summary captures key information in a coherent order"         |
| **LLM Likert 1-5**                    | LLM judge      | "ideal for evaluating nuanced aspects like empathy, professionalism, or patience that are difficult to quantify with traditional metrics" |
| **LLM binary classification**         | LLM judge      | subtle/implicit properties "that rule-based systems might miss"                                                                           |
| **LLM ordinal scale**                 | LLM judge      | degree of context utilization / multi-faceted quality                                                                                     |
| **Human grading**                     | human          | implicitly the fallback — the docs push hard away from it ("prioritize volume over quality")                                              |

Crucial operational note for us, verbatim: **"Generally best practice to use a different model to
evaluate than the model used to generate the evaluated output."** agent-flows' `ModelRegistry` +
`ProviderProfile` roles (`reasoner`/`worker`/`scout`, `src/canon/registry.ts`) make this trivial —
score with a different role/provider than the step under test.

Applied to prose-output steps: a spec or a critique is _not_ purely prose. It has a schema
(`HardenedSpec`, `canonSchemas`), countable parts (requirements, acceptance criteria, findings), and
cited artifacts (file paths). Anthropic's ordering says grade all of that with **code**, and reserve
the **LLM judge** for the genuinely subjective residue — "is this acceptance criterion actually
objectively checkable", "is this critique substantive or generic".

**Verdict 2: Anthropic's guidance is a strict ordering — code-graded first, LLM-judge only for the
subjective residue, human last — plus one hard rule we must honour: grade with a different model
than the one that produced the output.**

---

## 3. What already exists in this repo to reuse

### 3.1 Structured output and its validation — `src/canon/schemas.ts`

Two JSON Schemas only: `WEAK_SCHEMA` (`{ weaknesses: Finding[] }`) and `SEC_SCHEMA`
(`{ securityFindings: Finding[] }`), where `Finding = { text, severity: low|medium|high|critical,
blocking: boolean }`, all `required`, `additionalProperties: false`. Exported as
`canonSchemas = { weaknesses, securityFindings }`.

How they are enforced (`src/bindings/mastra/build.ts`, `buildLlmStep`): the schema is **appended to
the prompt** as an instruction, then `tryParseSchemaOutput` strips fences, `JSON.parse`s, and checks
the top-level key is present. On failure there is **one retry** with the parse error fed back; a
second failure throws `Step "<id>": <error>`. Note what this is _not_: the JSON Schema is never
actually applied as a validator — only the presence of the top-level key is checked. Field types,
the `severity` enum and `additionalProperties:false` are unverified at runtime.

Reuse: this is a hard structural gate for `critic` and `security` that already exists and already
fails the run. An eval layer should not re-litigate it; it should sit on top and measure content
quality. The unvalidated-fields gap is a genuine (small) hole a `checks`-style deterministic scorer
or a real Zod parse would close.

`src/canon/types.ts` additionally defines `HardenedSpec { title, description, requirements[],
acceptanceCriteria[], weaknesses[], securityFindings[] }`, assembled by `assembleSpec`
(`src/canon/assemble.ts`, delegating to `ASSEMBLE_JS` so the TS runtime and generated Claude Code
scripts share one implementation).

### 3.2 Test suite conventions

- 17 `*.test.ts` files under `src/`, node's built-in runner (`node:test` `describe`/`it`,
  `node:assert/strict`). No vitest, no jest.
- `scripts/test.sh` forces Node 22 via nvm (better-sqlite3 ABI), then
  `tsx --test $(find src -name '*.test.ts' | sort)`; passes through argv for single-file runs.
- `pnpm check` = `lint && typecheck && format:check && test`.
- Fixture style is already exactly the eval style: `src/bindings/mastra/build.test.ts` defines
  `CANNED_PIPELINE` (a full `LoadedPipeline` literal) plus `CANNED_RESPONSES` keyed by step id, and
  injects `deps.runner = makeFakeRunner(...)` — i.e. **the pipeline can be executed end-to-end with
  zero LLM calls and deterministic step outputs**. It drives real Mastra suspend/resume against a
  temp-file LibSQL store, and already covers happy path, rejected gate, model overrides, schema
  failure, JSON retry, context scoping (FR-005), timeouts, and loop convergence/exhaustion.
- `src/canon/testing/fakeSpawn.ts` provides `makeFakeChild` / `makeFakeSpawn` /
  `makeMultiFakeSpawn` for the CLI transport layer.

`grep -rn "scorer|runEvals|evals" src/` returns **nothing**. No eval code exists yet.

### 3.3 `pnpm mastra:smoke` — already a crude end-to-end harness

`src/bindings/mastra/smoke.ts` (~200 lines) currently:

1. Disables Mastra telemetry, builds `LibSQLStore` + Drizzle ticket store + `defaultRegistry()`.
2. Loads `pipelines/spec-creation.yaml`, prints a **model resolution table** per step (evidence the
   provider swap is real). Flags: `--db`, `--provider`, `--cheap` (pin every step to the profile's
   scout role), `--intake-model <id>`.
3. `buildPipelineWorkflow` → `new Mastra({ storage, workflows })` → `createRun()` → `start()` with a
   hardcoded input: _"Add a dark mode toggle to the web app…"_.
4. On `suspended`, reads `steps.approve.suspendPayload.spec` and prints **counts**: requirements,
   acceptance criteria, weaknesses, security findings. Errors if `spec` is missing.
5. Auto-approves via `run.resume({ step: r1.suspended[0], resumeData: { approved: true } })`.
6. Asserts `ticketId` in the result, then re-reads the store (`listTickets`, `listRequirements`,
   `listAcceptanceCriteria`, `listWeaknesses`, `listSecurityFindings`) and prints per-ticket counts.
7. Sets `process.exitCode = 1` on any failure; prints `Smoke PASSED` / `Smoke FAILED`.

This is a real end-to-end driver against real models, with a real HITL resume, a real persistence
assertion, and a non-zero exit code. Its only shortfall as an eval is that its assertions are
**existence-only** — a ticket with one empty requirement passes exactly like a good one. It is the
right thing to extend, not replace: it already solves the hard part (`start` → inspect suspend
payload → `resume` → verify persisted rows) that `runEvals` structurally cannot do.

### 3.4 Fixtures usable as a test task

- `pipelines/spec-creation.yaml` — the only pipeline on disk. Per ADR-0015 §4 it _is_ the `plan`
  workflow: `intake → enrich → (critic ‖ security) → assemble → [gate approve] → persist`.
- `prompts/{intake,enrich,critic,security}.md`.
- `CANNED_PIPELINE` / `CANNED_RESPONSES` in `build.test.ts` — a zero-cost deterministic pipeline.
- `specs/001…015` — 15 real historical spec directories; a ready-made corpus of "what a good output
  of this repo's `plan` stage looks like", usable as `groundTruth` for reference-based scorers.
- `docs/decisions/0001…0016` — 16 ADRs, similarly usable.
- Hardcoded smoke input: the dark-mode-toggle request. Note it is _generic_, not repo-grounded —
  it cannot test whether `investigate` actually reads this repo.

### 3.5 Correction to ADR-0015's "Consequences"

ADR-0015 lists four blockers. Two are now stale (verified in code):

| ADR-0015 claim                                                   | Actual state                                                                                                                                                                                                                 |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Self-nesting execution is the linchpin… no binding executes it" | **Implemented.** `src/canon/nest.ts` `expandNested()` flattens `kind:"pipeline"` steps with cycle + depth guards; `StepKind` includes `"pipeline"`.                                                                          |
| "Bounded-loop construct does not exist"                          | **Implemented.** `StepKind` includes `"loop"`; `StepDef.maxIterations` / `.until`; `buildLoopStep` in `build.ts` compiles to Mastra `.dountil(bodyWorkflow, condition)`; tested (convergence, exhaustion, run independence). |
| "`workspace: write` is not implemented"                          | **Still true.** `StepDef.workspace?: "read"` only; `runStep.ts` passes `--allowedTools Read,Glob` for `claude`, `-s read-only` for `codex`.                                                                                  |
| "A `check` / `command` step kind does not exist"                 | **Still true.** `StepKind = llm \| gate \| assemble-spec \| persist-ticket \| pipeline \| loop`.                                                                                                                             |

**Verdict 3: everything an eval layer needs already exists here — node:test + `scripts/test.sh` as
the CI surface, `build.test.ts`'s canned-runner fixtures for zero-cost deterministic pipeline runs,
`smoke.ts` as the real end-to-end HITL driver, and `specs/` + `docs/decisions/` as a ground-truth
corpus; what is missing is only the scoring content, and no scorer code exists yet.**

---

## 4. Verdict and recommendation

### 4.1 Does the owner need custom eval code?

**Covered by Mastra + the existing test suite, with no new infrastructure:**

- The scorer abstraction itself (`createScorer`, chainable, LLM-judge-optional, standalone-callable).
- Per-step scoring of a workflow run, keyed by step id (`scorers.steps`) — level (a).
- Whole-run and execution-order scoring (`scorers.workflow`, `scorers.trajectory`) — level (b).
- Binary pass/fail CI semantics (`gates` must average 1.0 → `verdict:"failed"`; thresholds →
  `"scored"`).
- Batching over a dataset with concurrency (`runEvals({ data, concurrency })`).
- Persistence and query (`mastra_scorers` table via the `LibSQLStore` `smoke.ts` already creates).
- Structural validity of `critic`/`security` output (already enforced with a retry in `build.ts`).
- Running it all: `scripts/test.sh` for the free tier, `pnpm mastra:smoke` for the paid tier.

**Genuinely not covered:**

1. **Scoring a HITL pipeline end-to-end via `runEvals`.** `executeWorkflow` calls `.start()` only;
   a suspended run yields `output: undefined` to `scorers.workflow`. Cost to close: reuse the
   `start` → `resume` loop that `smoke.ts` and `runService.ts` already implement, then call
   `scorer.run({ input, output })` directly. Roughly ten lines in `smoke.ts`.
2. **Domain scorers.** No prebuilt scorer knows what "grounded in _this_ repo" or "an acceptance
   criterion that is objectively checkable" means. These must be written — but they are the
   _content_ of the eval, not a harness, and each is a single `createScorer` call.
3. **`audit` cannot be honestly graded without seeded defects.** "Did it find real defects" has no
   ground truth on a clean diff. Needs a fixture diff with known planted bugs.
4. **The three unwritten workflows.** `investigate`, `verify-plan`, `correct-plan`, `develop`,
   `test`, `audit` do not exist as pipelines yet — only `plan` (= `spec-creation.yaml`) is runnable,
   and `develop`/`test` remain blocked on `workspace: write` and a `check` step kind (§3.5).
   Level (b) end-to-end evaluation of the _full_ ADR-0015 cycle is not executable today at all.

**Verdict 4a: no bespoke eval harness is needed and none should be built — Mastra's scorer layer
plus the repo's node:test suite and `smoke.ts` already cover both levels; the only custom code
required is the scorer definitions themselves plus a ~10-line resume-aware call in `smoke.ts`, and
the real blocker to level (b) is that six of the seven ADR-0015 workflows are not implemented yet.**

### 4.2 Recommended setup

**Dependency:** `pnpm add -D @mastra/evals` — optional. `createScorer` is already in
`@mastra/core`. Add it only for `checks.*` (free deterministic assertions) and
`prompt-alignment` / `completeness` / `faithfulness`. Its `vitest` peer is
`{ optional: true }`, so `node:test` is unaffected.

**Where the code lives:** one new directory `src/evals/`, holding scorer definitions only.
No runner, no config, no CLI.

**Two tiers, split by cost and determinism — this is the whole design:**

| Tier                     | Runs in                                                        | Cost      | Grades                                   |
| ------------------------ | -------------------------------------------------------------- | --------- | ---------------------------------------- |
| **Free / deterministic** | `pnpm test` (i.e. every `pnpm check`)                          | zero      | code-graded scorers over canned fixtures |
| **Paid / judged**        | `pnpm mastra:smoke` (already opt-in, already hits real models) | LLM calls | LLM-judge scorers over real runs         |

LLM-judge scorers must never enter `pnpm test`: `pnpm check` runs on every change, and
nondeterministic paid assertions there would make the gate untrustworthy. This directly implements
Anthropic's ordering (§2.3): code first, judge for the residue.

**Level (a) — evaluate an individual workflow.**
New `src/evals/*.test.ts` files (matching existing conventions), each calling `scorer.run(...)`
against a fixture and asserting `score >= threshold`. Concretely:

- `investigate` groundedness → **pure-code scorer, no judge.** Extract every path-shaped token from
  the output; score = `(cited paths that exist on disk) / (cited paths)`, hard-zeroed if any
  required path from the task's known-answer set is missing. A phantom path is an outright fail.
  This is Anthropic's "exact match" applied to citations and is strictly stronger evidence than any
  judge — a model cannot talk its way past `existsSync`.
- `plan` meets its criteria → **hybrid.** Code half: `requirements.length >= N`,
  `acceptanceCriteria.length >= N`, `weaknesses` non-empty, every `Finding.severity` in the enum
  (closing the §3.1 gap that `build.ts` never actually validates). Judge half: a Likert/binary judge
  over each acceptance criterion — "is this objectively checkable by a script or a test, yes/no" —
  scored as the pass fraction. Run the judge on a _different_ role than the step under test
  (`registry.resolve` + `ProviderProfile.roles`), per Anthropic's cross-model rule.
- `audit` finds real defects → **seeded-defect recall, code-graded.** Keep a fixture diff with N
  planted defects, each carrying a unique marker; score = fraction reported. `checks.includes` from
  `@mastra/evals/checks` does this for free.

**Level (b) — evaluate the whole pipeline.**
Two complementary drivers, both already half-written:

- _Free, in `pnpm test`_: reuse `build.test.ts`'s `makeFakeRunner` + `CANNED_RESPONSES` to run the
  whole pipeline with zero LLM calls, then `runEvals({ target: workflow, scorers: { steps, trajectory },
gates })`. Per §1.5 both `steps` and `trajectory` scorers work on a run that suspends at `approve`.
  This catches wiring/order/contract regressions — trajectory asserts the ADR-0015 stage order held.
- _Paid, in `pnpm mastra:smoke`_: keep the existing `start` → resume → verify-rows flow verbatim and
  replace its count-printing with `await scorer.run({ input: request, output: spec })` calls;
  set `process.exitCode = 1` when any gate scorer misses 1.0, exactly as it already does on a
  missing ticket. Register the scorers on the existing `new Mastra({ storage })` so scores land in
  `mastra_scorers` alongside the runs and become queryable over time.

**Verdict 4b: put deterministic code-graded scorers in `src/evals/` and assert them from
`*.test.ts` over `build.test.ts`'s canned fixtures so they run free on every `pnpm check`; put the
LLM-judge scorers behind `pnpm mastra:smoke`, which already performs the real start→resume→persist
cycle that `runEvals` cannot.**

### 4.3 One concrete test task for end-to-end evaluation

> **Add a `check` step kind to the canon: a non-LLM step that runs a declared shell command and
> yields `{ passed: boolean, output: string }` into the pipeline context.**

This is ADR-0015 blocker #4, still genuinely open (§3.5), and it is the prerequisite for the `test`
workflow — so the cycle's output is something the project actually wants.

Why it is a good eval task:

- **Small and bounded.** One new `StepKind` member, one builder branch, one runner, one test file.
- **Real.** Named in an Accepted ADR as a blocker; not synthetic busywork.
- **The correct answer set is knowable in advance**, which is what makes grading objective. The
  touch-set is fixed and small: `src/canon/types.ts` (`StepKind` union + `StepDef` fields),
  `src/bindings/mastra/build.ts` (`buildLevelsOntoBuilder` dispatch), `src/canon/graph.ts`
  (validation), and the two other bindings `src/bindings/claudeCode.ts` + `src/bindings/n8n/build.ts`.
  That list is the ground truth for the `investigate` groundedness scorer, and the last two are the
  discriminator: a shallow investigation names the first three and misses the bindings.
- **Success is machine-checkable, not judged.** Objective end-state criteria, in Anthropic's
  Specific/Measurable form:
  1. `pnpm check` exits 0 (lint + typecheck + format + all 17+ test files).
  2. A new `*.test.ts` exists that runs a pipeline containing a `check` step and asserts both the
     pass branch (exit 0 → `passed: true`) and the fail branch (non-zero → `passed: false`).
  3. `pipelines/spec-creation.yaml` still runs: `pnpm mastra:smoke` still reaches `Smoke PASSED`
     (no regression to the only live pipeline).
  4. `git diff --name-only` is a subset of the known touch-set — measures scope discipline
     (ADR-0015 principle 3: corrections scoped to correctness, or the loop over-engineers).
- **It exercises the read/write boundary the ADR cares about.** `investigate` and `plan` run
  read-only and are runnable today; `develop`/`test` need `workspace: write`, which does not exist.
  So the task is evaluable in two tiers now and completely once `workspace: write` lands — the
  criteria above do not change, only who satisfies them (the owner today, `develop` later).

**Verdict 4c: use "add a `check` step kind to the canon" as the end-to-end test task — it is a real
open ADR-0015 blocker, its correct file touch-set is known in advance so `investigate` can be graded
by code rather than judged, and its success reduces to `pnpm check` exiting 0 plus a new pass/fail
test and an unregressed `pnpm mastra:smoke`.**

---

## Sources

**Mastra (primary docs)**

- <https://mastra.ai/docs/evals/overview>
- <https://mastra.ai/docs/evals/built-in-scorers>
- <https://mastra.ai/docs/evals/custom-scorers>
- <https://mastra.ai/docs/evals/running-evals>
- <https://github.com/mastra-ai/mastra/blob/main/docs/src/content/en/reference/evals/create-scorer.mdx>
- <https://github.com/mastra-ai/mastra/blob/main/docs/src/content/en/reference/evals/run-evals.mdx>
- <https://github.com/mastra-ai/mastra/blob/main/docs/src/content/en/reference/evals/trajectory-accuracy.mdx>
- <https://github.com/mastra-ai/mastra/blob/main/docs/src/content/en/reference/core/listScorers.mdx>
- <https://github.com/mastra-ai/mastra/blob/main/docs/src/content/en/reference/datasets/startExperiment.mdx>
- <https://github.com/mastra-ai/mastra/blob/main/packages/evals/src/scorers/code/checks/index.ts>

**Mastra (installed code, authoritative over docs where they differ)**

- `node_modules/@mastra/core/dist/evals/index.js` — public exports
- `node_modules/@mastra/core/dist/evals/run/index.d.ts` — `runEvals` overloads, `WorkflowScorerConfig`, `RunEvalsResult`
- `node_modules/@mastra/core/dist/evals/base.d.ts` — `createScorer`, `ScorerJudgeConfig` (incl. `tools`)
- `node_modules/@mastra/core/dist/evals/scoreTraces/*.d.ts` — `scoreTraces`, `scoreTrace`, `scoreTraceBatch`
- `node_modules/@mastra/core/dist/workflows/types.d.ts:781+` — `WorkflowResult`, `status:'suspended'` carries `steps`
- `node_modules/@mastra/core/dist/agent-B8m3ps7U.js` — `runEvals`, `executeTarget`, `executeWorkflow`, `runScorers`
- `npm view @mastra/evals` — version 1.10.0, exports, `peerDependenciesMeta: { vitest: { optional: true } }`

**Anthropic (primary docs)**

- <https://platform.claude.com/en/docs/test-and-evaluate/define-success>
- <https://platform.claude.com/en/docs/test-and-evaluate/develop-tests>

**This repo**

- `docs/decisions/0015-sdlc-as-composable-workflows.md`
- `src/canon/schemas.ts`, `src/canon/types.ts`, `src/canon/assemble.ts`, `src/canon/nest.ts`, `src/canon/runStep.ts`
- `src/bindings/mastra/build.ts`, `src/bindings/mastra/build.test.ts`, `src/bindings/mastra/smoke.ts`
- `src/runtime/runService.ts`, `src/canon/testing/fakeSpawn.ts`
- `scripts/test.sh`, `package.json`, `pipelines/spec-creation.yaml`, `README.md`
