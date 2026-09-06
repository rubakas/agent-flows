# 018. Plan verification and correction (verify-plan / correct-plan)

| Field        | Value                          |
| ------------ | ------------------------------ |
| Feature Name | Plan verification and correction |
| Branch       | `018-plan-verification`        |
| Status       | Draft                          |
| Created      | 2026-09-06                     |

## Question

ADR-0015 (`docs/decisions/0015-sdlc-as-composable-workflows.md:26-27`) names two lifecycle stages that have no pipeline today: `verify-plan` (independent, fresh-context, repo-grounded check of the plan) and `correct-plan` (fold verification feedback back into the plan). The user's original request for the cycle was, verbatim: research, plan, **verify correctness**, **correct the plan**. This spec decides whether those two stages are already covered by `spec-creation`'s critic/security steps, the human `approve` gate, or `audit` — or genuinely missing — and, if missing, how to express them with existing canon primitives only.

## Evidence

**`spec-creation`'s critic and security are adversarial, but they are plan *production*, not plan *verification*.**

- Neither step declares `permissions`, so both run with **no repo access at all**: `pipelines/spec-creation.yaml:16-27` has no `permissions` key, and `src/canon/types.ts:59-60` — *"`contents: "none"` or absent `permissions`: no repo access (default)"*. They cannot check the plan against the codebase, which is verify-plan's defining property (ADR-0015:26 — "complete/consistent").
- They review the **pre-assembly draft**, not the assembled plan: `prompts/critic.md:3-6` and `prompts/security.md:3-6` template only `{{intake}}` and `{{enrich}}`.
- Their findings are **folded into** the spec as annotations, never resolved: `buildAssembleStep` (`src/bindings/mastra/buildSteps.ts:250-257`) reads the fixed keys `intake`/`enrich`/`critic`/`security` and attaches weaknesses/securityFindings to the `HardenedSpec`. No step ever checks that the assembled artifact addressed them.
- ADR-0015 itself accounts for them inside the `plan` stage, not the verify stage: line 25 puts "adversarial critique + security" in the `plan` contract, and lines 37-39 state "spec-creation as it exists today IS the `plan` workflow".

**The `approve` gate is a checkpoint, not verification.** `pipelines/spec-creation.yaml:31-34` suspends for a human, and ADR-0015:26 defines verify-plan as the machine stage that *"feeds gate"*. Today the gate receives a spec that was never checked against the repository.

**`audit` IS the verify-plan mechanism — deliberately — but never runs on the plan.**

- `pipelines/audit.yaml:3`: *"Adversarial read-only review of a plan"*; its single input is `plan`; both reviewer steps carry `permissions: contents: read` (`audit.yaml:10-11, 16-17`).
- The prompts were written plan-first: `prompts/audit-correctness.md:2` — *"the change under review — a plan, a diff, or source code"*; input block `"Plan under review: {{plan}}"` (`audit-correctness.md:16-18`, `audit-security.md:16-18`); severity "blocking (plan cannot proceed as written)" (`audit-correctness.md:27`); and the synthesis verdict line is literally *"Plan is ready to develop"* (`prompts/audit-synthesis.md:34`).
- But in composition it only ever reviews **code after the build**: `pipelines/build.yaml:25-30` runs `review` (audit) after the converge loop, and `pipelines/cycle.yaml:10-19` goes `plan → build` with nothing between the plan and the gate.

**`correct-plan` exists nowhere.** The only corrective step in the repo is `build-round`'s `fix` (`pipelines/build-round.yaml:12-18`), which corrects *code* from *test output* (`prompts/build-fix.md:17-19`). No step folds review findings back into a plan.

## Verdict

**GAP** — narrower than ADR-0015 implies, but real: `verify-plan` already exists as a *capability* (`audit` was written to review plans, with repo read access and a fresh context) yet never runs on the plan before the human gate; `correct-plan` exists nowhere; the fix is pure composition — nest `audit` into `spec-creation`, add one small leaf pipeline and one prompt file, change two `with:` mappings — no new runtime machinery.

## Design

### New leaf: `pipelines/correct-plan.yaml`

```yaml
id: correct-plan
version: 1
description: Fold verification findings back into a plan, producing a complete revised plan
inputs:
  - plan
  - findings
steps:
  - id: revise
    kind: llm
    role: reasoner
    permissions:
      contents: read
    prompt: prompts/correct-plan.md
```

Independently runnable (any plan + any findings), matching ADR-0015's leaf-workflow table. It gets `contents: read` (to re-check fixes against the repo), not the ADR's "canon-write" — the plan lives in run context, not in repo files, so write access is unneeded; tighter is better.

### New prompt: `prompts/correct-plan.md`

One-line brief: given the plan (`{{plan}}`) and the prioritised findings (`{{findings}}`), emit the **complete revised plan document** — every blocking/major finding either resolved in the text or explicitly rejected with a stated reason; no scope added beyond what findings require; output is the full plan, not a patch, because downstream consumers receive this key as the authoritative plan.

### Changed: `pipelines/spec-creation.yaml` (version 2)

Insert between `assemble` and `approve` (everything else unchanged):

```yaml
  - id: verify
    kind: pipeline
    pipeline: audit
    with:
      plan: assemble
    dependsOn: [assemble]
  - id: correct
    kind: pipeline
    pipeline: correct-plan
    with:
      plan: assemble
      findings: verify.synthesis
    dependsOn: [verify]
  - id: approve
    kind: gate
    message: Approve this hardened, verified spec?
    dependsOn: [correct]
```

Mechanics, verified against the loader: nesting `audit` rewrites its `{{plan}}` to `{{assemble}}` at expansion (`src/canon/nest.ts:20-28, 137`); `verify`'s entry steps inherit `dependsOn: [assemble]` (`nest.ts:158-160`); `correct`'s inherited `dependsOn: [verify]` is rewired to the terminal `verify.synthesis` (`nest.ts:198-210`), so the `{{verify.synthesis}}` placeholder passes the ancestor check in `src/canon/load.ts:352-367`. Under `cycle` the second nesting namespaces everything again (`verify.synthesis → plan.verify.synthesis`), which `nest.ts:135` handles because sibling-id rewriting operates on *expanded* ids.

### Where it slots into `cycle` (and `cycle-dev`): one mapping change

```yaml
  - id: build
    kind: pipeline
    pipeline: build
    with:
      plan: plan.correct.revise   # was: plan.assemble
    dependsOn: [plan]
```

`build` and `develop` need no edits — `develop`'s `{{plan}}` input passes through by name (`pipelines/build.yaml:7-9`, `pipelines/develop.yaml:4-5`), and `build`'s post-converge `audit` now reviews code against the *corrected* plan for free (`build.yaml:28-29`).

### Resulting order (matches the requested spine)

research (`investigate`) → plan (intake→enrich→critic+security→assemble) → **verify** (audit on the assembled plan, repo-grounded, fresh context per ADR-0015 principle 2 — the reviewers' prompts contain only the plan) → **correct** (revised plan) → human gate → build → ship.

### Known limitations (stated, not hidden)

1. **Gate payload, ticket, and export still carry the assemble-stage spec.** `buildGateStep` suspends with `ctx[<ns>.spec]` (`buildSteps.ts:286-288`), and `persist-ticket`/`export-spec` read the same fixed key (`buildSteps.ts:310-312, 330-336`). The corrected plan travels to `build` via context only; the operator reviews `correct.revise`'s output in the run view before approving. The eventual fix (out of scope) is a small binding change: prefer a revision key when present.
2. **Single pass, not "loop until clean" (deviation from ADR-0015:27).** Deliberate, for three verified reasons:
   - No trustworthy `until` signal exists. Plan cleanliness has no process ground truth; the only signal is model self-report — exactly the fabrication class ADR-0015 documents (lines 87-93). The existing schemas cannot express "clean" anyway: `Boolean([])` is `true`, so `until: x.weaknesses` always terminates and `until: x.weaknesses.0` terminates only when findings *exist* — inverted (`buildSteps.ts:423`, `src/canon/schemas.ts:26-29`, `types.ts:34`).
   - The loop primitive cannot feed the plan into a body: `with:` is pipeline-steps-only (`types.ts:136-144`), loop bodies skip placeholder rewriting (`nest.ts:73-95, 188-192`), and `renderPrompt` throws on any unresolved placeholder (`src/canon/render.ts:16-19`). `build-round` only works because its first step is a `check` whose subject is the repo, not context (`build-round.yaml:6-8`).
   - The human gate immediately downstream *is* the terminator; a rejection plus re-run is the loop, exactly as Spec Kit's `/analyze` → `/clarify` is human-driven re-entry.

   Named escalation path if gate rejections show one pass is insufficient: add a `verdict` schema entry (`{passed: boolean, summary: string}`) to `schemas.ts` and the union at `types.ts:34` — a registry entry, not a step kind — and run the loop over an exported plan file so the body is self-grounding like `build-round`.

## Why not a new step kind

Every node in this design is an existing kind: `pipeline` (twice), `llm` (once), and the untouched `gate`. `audit` is reused verbatim — its prompts were already written for plans. The only new artifacts are one 14-line YAML leaf and one prompt file, which is data, not code. The single-pass shape also avoids the one code change a loop would force (the `verdict` schema); that change is documented above as an escalation path, and it too is a schema-registry entry, not a step kind — none of the eight kinds is insufficient for what this spec ships.

## Out of scope

- Binding changes so gate/persist/export surface the corrected plan (limitation 1) — separate, small, code-level task.
- The bounded verify→correct loop and the `verdict` schema (escalation path only).
- Wiring `investigate` findings into `intake` — covered by spec 017.
- Any change to `build`, `develop`, `test`, `ship`, or the audit prompts.
- Provider and model selection — covered by spec 016.

## Test plan

1. **Canon validation (load-time, can fail):** unit tests asserting `loadPipeline("pipelines/spec-creation.yaml")` and `loadPipeline("pipelines/cycle.yaml")` succeed and that the expanded defs contain `verify.synthesis` / `plan.correct.revise`, with `plan.correct.revise`'s prompt referencing `{{plan.assemble}}` and `{{plan.verify.synthesis}}` and `build`'s prompts referencing `{{plan.correct.revise}}`. Negative case (proves the gate can fail): a `with` value typo such as `findings: verify` must be rejected by the placeholder check at `load.ts:352-367`, since `with` *values* are not validated at nest time (`nest.ts:114-123` checks keys only).
2. **Eval fixture:** extend the existing evals harness (`src/evals/scorers.ts` — `plantedGapsFound` already scores exactly this): a fixture plan with planted defects (e.g., a step referencing a function that does not exist in the repo); assert `verify`'s synthesis surfaces each planted gap and that `correct.revise`'s output resolves or explicitly rejects every blocking finding.
3. **Live run:** run `cycle-dev` on a small real request; at the gate, confirm the verify synthesis and revised plan are visible in the run view; approve; confirm via the run context (serve UI or DB) that `develop`'s rendered prompt contained the *corrected* plan text, not `plan.assemble`.
