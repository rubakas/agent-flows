# 017. Investigation wiring and export-spec path resolution

| Field        | Value                          |
| ------------ | ------------------------------ |
| Feature Name | Investigation wiring           |
| Branch       | `017-investigation-wiring`     |
| Status       | Active                         |
| Created      | 2026-09-06                     |

**Context:** Two confirmed defects, both surfaced by a live run of the `cycle` pipeline today.

### D1 — Investigation findings are computed and discarded

`pipelines/cycle.yaml` and `pipelines/cycle-dev.yaml` declare the `plan` step as
`kind: pipeline, pipeline: spec-creation, dependsOn: [investigate]` with no `with:` mapping. The
`spec-creation` pipeline's `inputs` field (`pipelines/spec-creation.yaml:5`) declares only
`request`. Because no `with:` key maps `investigate`'s output into `spec-creation`, and because
`spec-creation`'s `intake` prompt (`prompts/intake.md`) references only `{{request}}`, the
investigation model calls (`survey` and `findings`) complete and their output is never read by the
planning stage. The spec-creation stage sees only the bare one-sentence request and invents
interfaces, roles, and subsystems that do not exist in the code.

### D2 — export-spec writes into the tool's own repo, not the target project

`src/bindings/mastra/build.ts:148` calls `buildExportSpecStep(step.id, step.path!, gateId)` where
`step.path` is the raw relative path from YAML (e.g. `specs/spec-creation`). Inside
`buildExportSpecStep` (`src/bindings/mastra/buildSteps.ts:317`), that string is passed directly to
`writeSpecKitSpec` (`src/canon/exportSpec.ts:198`) as `outDir`. A relative `outDir` resolves
against `process.cwd()` — the server process's working directory, which is the agent-flows checkout,
not the target project. `deps.cwd` (the project directory) is already available in `build.ts` and is
already passed to `buildCheckStep` at line 140, but is not forwarded here.

Observed live: with `AGENT_FLOWS_PROJECT_DIR=/Users/en3e/code/rubakas/newfolder`, the spec was
written to `/Users/en3e/code/rubakas/yoke/specs/spec-creation/spec.md`. The target project has no
`specs/` directory at all.

**persist-ticket check:** `buildPersistStep` (`src/bindings/mastra/buildSteps.ts:295`) calls
`persistTicket(store, spec)` which writes to a database store, not the filesystem. The D2 bug class
does not apply — no path-to-file is involved.

---

## Design question: are pipeline inputs required or optional in the generated schema?

At `src/bindings/mastra/build.ts:168–169`:

```typescript
for (const inp of def.inputs) {
  inputShape[inp] = z.string();
}
```

All declared inputs emit `z.string()` — required, no `.optional()`. A standalone `spec-creation`
run that omits `findings` would fail Zod schema validation.

**Chosen design — `optionalInputs?: string[]` in the canon:** Add a `PipelineDef.optionalInputs`
array that names the subset of declared inputs that may be omitted in a standalone trigger. In
`buildPipelineWorkflow`, inputs listed in `optionalInputs` emit `z.string().optional().default("")`
instead of `z.string()`. The alternative — making all inputs optional globally — weakens schema
validation for every pipeline including the required `request` input on `spec-creation` itself.
`optionalInputs` is additive and backward-compatible: pipelines that omit the field behave exactly
as today, so there are no forced migrations.

---

## Requirements

| ID     | Requirement                                                                                                                                                                                                                                                                                                                                                                       | Status |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| FR-001 | `PipelineDef` gains `optionalInputs?: string[]`. A name listed there must also appear in `inputs`; violation is rejected at load time. `buildPipelineWorkflow` emits `z.string().optional().default("")` for each optional input instead of `z.string()`.                                                                                                                        | TODO   |
| FR-002 | `pipelines/spec-creation.yaml` adds `findings` to `inputs` and declares `optionalInputs: [findings]`. A standalone trigger supplying only `request` must succeed; the generated Zod schema must accept the omission of `findings`.                                                                                                                                                | TODO   |
| FR-003 | `prompts/intake.md` references `{{findings}}`. When `findings` is non-empty the model is instructed to ground requirements in the surveyed code; when empty it falls back to the request alone. The prompt must not bloat: add one conditional instruction block in the terse style of the existing prompt.                                                                         | TODO   |
| FR-004 | `pipelines/cycle.yaml` and `pipelines/cycle-dev.yaml` add `with: { findings: investigate.findings }` to the `plan` step so the investigate pipeline's `findings` step output reaches `spec-creation`'s `intake` prompt. Both files must stay in sync.                                                                                                                            | TODO   |
| FR-005 | `buildExportSpecStep` in `build.ts` resolves a relative `step.path` against `deps.cwd` (falling back to `process.cwd()` when `deps.cwd` is absent). An absolute `step.path` is used unchanged (standard `path.resolve` semantics). `buildCheckStep` already follows this pattern; export-spec must match it.                                                                     | TODO   |
| FR-006 | Tests that would fail without each fix: (a) an export-spec test asserting the written `spec.md` lands in `join(deps.cwd, step.path)` when `step.path` is relative; (b) a test loading the real `cycle.yaml` and asserting the `plan` step's `with` map contains `findings: "investigate.findings"`.                                                                              | TODO   |

---

## Backward compatibility

- Existing pipelines with no `optionalInputs` field are unaffected — the field is optional and the
  schema generation path for required inputs is unchanged.
- Standalone `spec-creation` runs with only `request` continue to work; `findings` defaults to `""`.
- Cycle pipelines gain a `with` key that was absent before; `loadPipeline` already validates `with`
  keys against the nested pipeline's declared `inputs` (`src/canon/nest.ts:114–119`), so the new
  key will be accepted now that `findings` is declared.
- Absolute `step.path` values on `export-spec` steps are unaffected: `path.resolve(cwd, absPath)`
  returns `absPath` unchanged.

---

## Out of scope

- Changing how the investigation pipeline itself is structured.
- Making any input optional via a YAML `?`-suffix or per-input map syntax.
- Changing the `persist-ticket` step — no path-to-file involved (confirmed above).
- Migrating other pipelines to use `optionalInputs`.

---

## Test plan

| Test name                                                                   | File                                              | What it guards                                                                                 |
| --------------------------------------------------------------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `export-spec step resolves relative path against deps.cwd`                  | `src/bindings/mastra/build.test.ts`               | D2: spec.md written to `join(deps.cwd, step.path)`, not `join(process.cwd(), step.path)`      |
| `cycle.yaml plan step wires investigate.findings into spec-creation`        | `src/canon/canon.test.ts`                         | D1: `plan` step in cycle has `with.findings === "investigate.findings"`                        |
| `cycle-dev.yaml plan step wires investigate.findings into spec-creation`    | `src/canon/canon.test.ts`                         | D1: same for cycle-dev                                                                         |
| `spec-creation standalone run succeeds without findings input`              | `src/canon/canon.test.ts`                         | FR-002: optional input schema accepts omission of `findings`                                   |
| `optionalInputs entry not in inputs is rejected at load time`               | `src/canon/canon.test.ts`                         | FR-001: load.ts rejects a misconfigured optionalInputs list                                    |
