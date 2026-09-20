# 041. Model autoselect

| Field        | Value                                                |
| ------------ | ---------------------------------------------------- |
| Feature Name | Model autoselect                                     |
| Branch       | `feat/041-model-autoselect` (not yet created)        |
| Status       | Draft — design only, not approved for implementation |
| Created      | 2026-09-21                                           |

## Context

Owner ask, verbatim: "we will have a default behaviour described in a settings, but if we enable
the autoselect, orchestrator could reassign better fit model." The trigger point named for the
assessment is spec analysis — the point at which a run's shape is known but no step has dispatched
yet. Default behaviour (declared role → model mapping) is unchanged for anyone who does not opt in.

### How model selection works today

- `resolveStepModel(step, profile, registry)` (`src/canon/registry.ts:181-191`): an explicit
  `step.model` wins outright; otherwise `profile.roles[step.role]` resolves through the registry.
  `Role = "reasoner" | "worker" | "scout"` (`src/canon/types.ts:26`).
- `ProviderProfile` is `{ id, roles: Record<Role, string>, fallback?: string[] }`; `ProviderConfig`
  is `{ models, profiles, defaultProvider? }` (`registry.ts:88-110`), loaded from project
  `.agent-flows/providers.yaml` via `loadProviders`, edited through `GET`/`PUT /api/providers` and
  the Settings page's Providers section (`src/serve/ui.html:879-883`, role × profile matrix).
- `POST /api/runs` already accepts a per-step `models: {stepId: modelId}` map and a per-run
  `provider` string; both are validated at the boundary against the resolved pipeline's own step
  ids and a model-id shape regex (`src/serve/server.ts:1876-1908`), and the Run dialog already
  collects per-step model overrides into that same map (`ui.html:1215-1310`,
  `data-run-model` → `models[stepId]`). A selection policy only has to **emit** this map; no new
  apply-side plumbing is needed for the map itself.
- **The load-bearing constraint this spec turns on.** In `buildLlmStep`
  (`src/bindings/mastra/buildSteps.ts:456-466`), `ctxModelOverride(step.id, ctxData)` reads
  `ctxData.models[stepId]` (`buildSteps.ts:151-154`); when present, it becomes `entry` outright and
  is also passed as `override` into the failure branch. At `buildSteps.ts:585`,
  `!pinned && override === undefined && worthy` gates whether `runFailoverChain`
  (`buildSteps.ts:336-431`) is even attempted on a transport-level failure — **any** value in
  `models[stepId]`, however it got there, disables the Anthropic↔OpenAI failover chain spec 039
  built for that step. If autoselect wrote its choices into the same `models` map, turning
  autoselect on would silently turn failover off for every step it touched.
- **The portability seam already runs per step, before every model call.** `buildLlmStep` calls
  `checkPortability(step, entry, profile.id, portabilityOpts)`
  (`buildSteps.ts:468-476`, comment: "refuse an unportable step before any model call. The adapters
  throw for the same combinations, but only after a subprocess has been shaped") and throws before
  dispatch if the resolved model cannot satisfy what the step declares (`permissions.contents`,
  `permissions.deny`, `maxBudgetUsd` — `src/canon/portability.ts:35-70`). Whatever emits a model
  choice must pass this same check, or a run fails at dispatch time instead of at selection time.
- **`StepDef` has no capability/requirement field today** (`types.ts:28-191` read in full) — no tag
  for "needs deep judgement" or "needs wide context." What it does already declare, deterministically,
  is `role` (`types.ts:26`) and `permissions.contents` (`types.ts:57-65`); neither needs to be
  assessed by a model, only read.
- **Cost basis per transport, verified against the adapters.** The claude-cli adapter reads
  `total_cost_usd` straight off the CLI's own `result` event
  (`src/canon/runClaudeCli.ts:284-286,345`, `usageFromResultEvent`) — a measured figure, persisted
  into the run's `<run>/<pipeline>.events.jsonl` via `appendStepLog`/`stepLog.ts`. The codex adapter
  emits `{inputTokens, outputTokens}` only, explicitly commented "Codex reports tokens only — no cost
  figure" (`src/canon/adapters/codex.ts:177-184`). The api adapter emits the same token-count shape
  from `usage.prompt_tokens`/`completion_tokens`, also no cost (`src/canon/adapters/api.ts:76-82`).
  Only these two transports need a declared price table; the claude path must never be priced from
  its own token counts as a substitute for `total_cost_usd`.
- **Provenance channels that already exist and that this spec extends, not replaces.**
  `StepIntrospection` (`src/runtime/stepIntrospection.ts:31-40`) is `{prompt?, command?, model?,
actual?: StepActualProvider}`, written via `recordStep(runId, stepId, info)` and merged into the
  run record. `RunInvocation` (`src/runtime/runService.ts:460-481`) is the once-set, never-mutated
  record of `{pipeline, inputs, models?, provider?, gateMode, artifactPath?, startedAt, source}` —
  `models`/`provider` are split back out of the workflow's merged context at `runService.ts:470` so
  the invocation record shows exactly what the caller (or, after this spec, the policy) asked for.
- **The precedent this spec follows for "a model assesses, code decides."**
  `decideEntryPoint` (`src/runtime/entryPoint.ts:1-2`): "Never calls a model; the rule is an
  inspectable function, not a model guess." Selection here keeps the same shape: a model may rate
  attributes, but the map from attributes to a concrete model id is a plain function, unit-testable
  without a model in the loop — the same posture spec 040 FR-017 already established for
  `severityDropAccountedFor` (a scorer proven able to fail by neutering it, no model call).

## Decisions

**D1 (owner) — a model ASSESSES, code DECIDES.** A model may rate a step's task attributes (D6); a
deterministic policy function (D8) maps those attributes, plus the step's own declared shape, to a
concrete model id. The model never chooses a model id itself. Same posture as `decideEntryPoint`
(quoted above); kept unit-testable and diffable for the same reason.

**D2 (owner) — an autoselected model is a PREFERENCE; an operator pin is a CONSTRAINT.** They travel
in different channels end to end (D9), because today's single `models` map conflates "the caller
insists on this model" with "nothing was asked" — and the failover-skip gate at
`buildSteps.ts:585` keys off exactly that map. An autoselected choice must still fail over on a
transport error; an explicit operator pin (`models[stepId]` sent by a caller, or `step.model` in the
canon) must still skip the chain exactly as it does today.

**D3 (owner) — default OFF.** Absent the switch, behaviour is unchanged: `resolveStepModel` resolves
`step.model` or `profile.roles[role]` exactly as it does today, with no assessment call and no
`autoModels` map populated.

**D4 (owner) — cost basis is measured where available, estimated only where not, and always
labelled.** claude-cli steps report `costBasis: "measured"` from `total_cost_usd`
(`runClaudeCli.ts:284-286`); codex and api steps report `costBasis: "estimated"` from a declared
price table applied to their reported token counts (D11). A recorded cost that does not say which one
it is is not acceptable provenance (D10).

**D5 — the switch lives in `providers.yaml`, with a per-run override; UI mirrors both.**
`ProviderConfig` gains an optional `autoselect?: boolean` field (default/absent = off), read and
written the same way `defaultProvider` already is: `GET`/`PUT /api/providers` round-trip it, and the
Settings page's Providers section (`ui.html:879-883`) gains a single checkbox next to the existing
role × profile matrix — no new page, no new route shape. `POST /api/runs` gains an optional
`autoselect: boolean` field, validated the same way the existing `provider` field is (`server.ts:
1914-1918` pattern: type-checked, 400 on the wrong type), which overrides the project default for
that one run; the Run dialog gets one checkbox next to the existing provider selector. Absent from
both, the project's `providers.yaml` value governs; absent from both entirely, the switch is off
(D3).

**D6 — two assessed attributes; everything else is read, not guessed.** Per `llm` step: a
**complexity tier** (`low | medium | high` — judgement depth the step's own prompt asks for) and an
**expected context size** (`small | large` — how much the step is likely to read or carry forward).
These are the only two attributes a model rates. Two candidates the owner named are deliberately
_not_ assessed, because the canon already declares them:

- **Whether repo reading is needed** is `step.permissions.contents` (`types.ts:57-65`), already
  declared per step at load time. The policy reads it; a model is never asked to guess it.
- **Cost sensitivity** is a project-level knob, not a per-task judgement — declared once in
  `providers.yaml` (e.g. `costSensitivity: "low" | "balanced" | "high"`, sibling to `autoselect`),
  consulted by the policy function (D8) as a fixed input alongside the two assessed attributes, not
  re-assessed on every run.

This keeps the taxonomy at two model-rated dimensions, per the instruction to resist inventing a
large one; `role` (`types.ts:26`) is the third input the policy reads directly, also unassessed.

**D7 — who assesses, and when: one scout-tier call per run, at the `POST /api/runs` seam, before any
step dispatches.** This is the "spec analysis" trigger point named by the owner made concrete: after
the existing `models`/`provider` boundary validation and pipeline resolution
(`server.ts:1867-1908`), and before `RunService.start()` is invoked, one model call — resolved
through the existing `scout` role the same way `investigate.yaml`'s `survey` step already is
(`registry.ts:118`, `pipelines/investigate.yaml:10-15`) — is made only when autoselect resolves ON
for this run (D5) and the pipeline has at least one `llm` step. It is given the pipeline's own
declared step list (id, role, `permissions.contents` — nothing else) and the run's own input text
(the same `request`/`plan`/etc. values already supplied to `POST /api/runs`), and returns, per `llm`
step id, the two D6 attributes. This is **not** a new step inserted into any pipeline's YAML — no
`pipelines/*.yaml` file changes — it is a policy-only call the daemon makes directly, keeping every
pipeline's own graph exactly as declared.

**D8 — the policy function is pure, unit-tested, and lives in `src/canon/autoselect.ts`.**
`selectModels(steps: StepDef[], attributes: Record<string, {complexity, contextSize}>, profile:
ProviderProfile, registry: ModelRegistry, config: {costSensitivity?, pricing?}, opts:
PortabilityOptions): { preferences: Record<string, string>; decisions: Record<string, {chosen:
string; reason: string}> }`. It makes no model call — the assessment (D7) is a separate step whose
output it consumes as plain data. For each `llm` step without an explicit `step.model`: combines the
two assessed attributes, `step.role`, `step.permissions.contents` and `config.costSensitivity` into a
model id through an inspectable table (e.g. `complexity: high` biases toward the `reasoner` role's
model even on a `worker`-role step; `costSensitivity: high` biases toward the cheaper model that still
satisfies `contents`), then checks the candidate with `checkPortability` (D12) before accepting it. A
step already carrying an explicit `step.model` is skipped entirely — the canon-level pin
(`registry.ts:186-188`) already outranks everything this spec adds, unchanged. Unit-tested with no
model in the loop, and mutation-provable the same way spec 040 FR-017's scorer is: the test goes red
when the mapping table is neutered, green once restored.

**D9 — preference and pin are distinguishable all the way to `runFailoverChain`.** A new reserved
context key, `autoModels` (sibling to the existing `models`/`provider` keys already reserved at
`server.ts:510`), carries `selectModels`'s `preferences` map. `buildSteps.ts` gains a second lookup,
`ctxModelPreference(stepId, ctxData)`, reading `ctxData.autoModels[stepId]` the same shape
`ctxModelOverride` reads `ctxData.models[stepId]` (`buildSteps.ts:151-154`). Resolution order at
`buildSteps.ts:462-466` becomes: explicit `step.model` (unchanged, `registry.ts:186-188`) → operator
`models[stepId]` (hard pin, unchanged — still becomes `override` and still gates failover at
`buildSteps.ts:585`) → `autoModels[stepId]` (soft preference — sets the initial `entry` via
`registry.resolve(...)`, but is never assigned to `override`) → `resolveStepModel`'s existing
`profile.roles[role]` default. Because `override` stays `undefined` for a preference-only step, the
`!pinned && override === undefined && worthy` gate at `buildSteps.ts:585` is unaffected by
autoselect — `runFailoverChain` runs on a preference-selected step's transport failure exactly as it
would with no selection at all.

**D10 — provenance records the attributes, the decision, its reason, and the cost basis.**
`StepIntrospection` (`stepIntrospection.ts:31-40`) gains an optional field:
`autoselect?: { attributes: {complexity, contextSize}; chosen: string; reason: string; costBasis:
"measured" | "estimated"; costUsd?: number }`, written at the same `recordStep` call site the step's
`model`/`actual` fields already use. `RunInvocation` (`runService.ts:460-481`, alongside `models`/
`provider` at `:470-481`) gains an optional `autoselect: boolean` recording whether the switch was ON
for the run; the per-step decision map itself is not duplicated into `RunInvocation` — it is read from
each step's own `StepIntrospection`, the same way `actual` (the failover provenance) already is, so
there is exactly one place a step's own history lives. No `chosen` model is ever recorded without a
`reason` string — same principle as `severityRationale` in spec 040 D13: a decision that cannot be
accounted for is not auditable.

**D11 — the price table is a static built-in, project-overridable, and covers only codex/api
models.** `src/canon/pricing.ts` (new) declares `Record<modelId, {inputPerMillion: number;
outputPerMillion: number}>` for the registry's codex and api-transport entries only — claude entries
are absent by construction, since D4 forbids estimating their cost from token counts.
`ProviderConfig` gains an optional `pricing` field that a project's `providers.yaml` may extend or
override, the same optional-and-overridable posture `models` and `profiles` already have
(`registry.ts:103-110`). A resolved model with no price-table entry records `costBasis: "estimated"`
with `costUsd` omitted rather than a fabricated number — an open gap, not a guess (see Risks).

**D12 — a portability refusal is checked at selection time, not only at dispatch time.**
`selectModels` (D8) calls `checkPortability(step, candidateEntry, profileId, opts)`
(`portability.ts:35-70`) for every candidate before writing it into `preferences`; a refused candidate
falls back to `profile.roles[step.role]` (today's default) and the fallback is itself the recorded
`reason` (D10). The existing per-step check inside `buildLlmStep`
(`buildSteps.ts:468-476`, "refuse an unportable step before any model call") is unchanged and stays
as defence in depth — it should never actually trip for an autoselect-chosen entry, because D12
already filtered it out one step earlier, at the same seam D7 places the assessment.

## Functional Requirements

- **FR-001.** `ProviderConfig` gains `autoselect?: boolean` and an optional `costSensitivity?: "low" |
"balanced" | "high"`; `GET`/`PUT /api/providers` round-trip both; the Settings page's Providers
  section gains one checkbox for `autoselect` next to the existing role × profile matrix (D5, D6).
- **FR-002.** `POST /api/runs` accepts an optional `autoselect: boolean` field, validated the same way
  the existing `provider` field is (type-checked, 400 on the wrong type), overriding the project
  default for that run only; the Run dialog gains one checkbox next to the existing provider selector
  (D5).
- **FR-003.** When autoselect resolves ON for a run (per-run field, else project default) and the
  pipeline has at least one `llm` step without an explicit `step.model`, one scout-role model call
  runs once at the `POST /api/runs` seam — after the existing `models`/`provider` validation
  (`server.ts:1867-1908`) and before `RunService.start()` — given the pipeline's step list (id, role,
  `permissions.contents`) and the run's own input text, and returns per-step `{complexity, contextSize}`
  (D6, D7). No `pipelines/*.yaml` file is modified to add this call.
- **FR-004.** `src/canon/autoselect.ts` exports a pure `selectModels` function (signature in D8) that
  makes no model call, skips any step already carrying an explicit `step.model`, checks every
  candidate with `checkPortability` before accepting it, and falls back to `profile.roles[step.role]`
  on a portability refusal, recording the refusal as the decision's `reason` (D8, D12). Unit-tested
  with no model in the loop; the test is proven able to fail by neutering the mapping table.
- **FR-005.** A new reserved context key `autoModels` (added to `RESERVED_CONTEXT_KEYS`,
  `server.ts:510`) carries `selectModels`'s output; `buildSteps.ts` gains `ctxModelPreference`,
  parallel to `ctxModelOverride` (`buildSteps.ts:151-154`); resolution order becomes `step.model` →
  `models[stepId]` (hard pin) → `autoModels[stepId]` (soft preference) → `profile.roles[role]`; only
  the hard-pin channel is assigned to `override`, so the `buildSteps.ts:585` failover gate is
  unaffected by a preference-only selection (D9). A test proves a step selected via `autoModels`
  alone still enters `runFailoverChain` on a transport-level failure, and a step selected via
  `models` still does not.
- **FR-006.** `StepIntrospection` gains an optional `autoselect` field (shape in D10), written
  alongside the step's existing `model`/`actual` fields; `RunInvocation` gains an optional
  `autoselect: boolean`; no `chosen` model is recorded without a `reason` (D10).
- **FR-007.** `src/canon/pricing.ts` declares a static price-per-million-tokens table for codex/api
  registry entries only, keyed by model id; `ProviderConfig` gains an optional `pricing` field a
  project may extend or override; a step's `costBasis` is `"measured"` for claude-cli transports
  (sourced from `total_cost_usd`, never from token counts) and `"estimated"` for codex/api transports
  (sourced from the price table against the transport's own reported token counts); a model with no
  price-table entry omits `costUsd` rather than fabricating one (D4, D11).
- **FR-008.** `selectModels` never emits a candidate that `checkPortability` refuses; the existing
  per-step check inside `buildLlmStep` (`buildSteps.ts:468-476`) is unchanged and unaffected by this
  spec (D12).

## Out of scope

- Jev / TypeSafe (cloud-only, rejected by the owner —
  `docs/research/2026-09-21-jev-typesafe-system-one.md`).
- Any new model vendor or transport.
- Changing the role/profile indirection itself. Autoselect rides `resolveStepModel`'s existing
  precedence (`step.model` → role → profile) and the `models`/`autoModels` channel split (D9); it does
  not replace either.
- Generation-time schema constraints (e.g. constraining a model's own output shape based on the
  selected model) — out of scope for this spec.

## Risks

- **Reproducibility.** A dynamically selected model makes a run less reproducible than a declared
  `profile.roles` mapping; this repo just spent spec 039/040 effort making provenance truthful
  (`actual`, `severityRationale`), and D10's requirement — every `chosen` model carries a `reason` — is
  the mitigation, not a guarantee that two runs of the same pipeline pick the same model.
- **Displacement, not just savings.** A policy that picks a cheaper model to save cost can cost
  retained findings — spec 040 D12's rule applies here too: measure what a change displaces, not only
  what it saves. Rolling out autoselect needs a benchmark against retained-baseline-findings on a
  pipeline like `code-review`, not a cost delta alone. Cost context for sizing this: a 4-step
  `code-review` run costs roughly $4.32 today, a 6-step run $4.57–$5.18, and a single reasoner retry
  roughly $1 — autoselect's savings have to be measured against what those numbers buy today, not
  assumed.
- **Assessment cost and latency.** D7's scout call is one more model call per run, on the critical
  path before any step dispatches — its own cost and latency are not budgeted here and should be read
  off the benchmark the displacement risk above already requires.
- **Price-table gaps.** FR-007's table is static and project-overridable but not automatically kept
  current; a codex/api model with no entry reports `costBasis: "estimated"` with no `costUsd` at all
  (D11) rather than a wrong number, which means some autoselect decisions will carry an incomplete
  cost record until the table is extended.
