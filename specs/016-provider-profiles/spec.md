# 016. Provider profiles as project data

| Field        | Value                          |
| ------------ | ------------------------------ |
| Feature Name | Provider profiles as project data |
| Branch       | `016-provider-profiles`        |
| Status       | Draft                          |
| Created      | 2026-09-06                     |

**Context:** The charter claims "swapping providers is a registry edit, not a rewrite", but the provider→role mapping lives in a TypeScript literal (`DEFAULT_PROFILES`, `src/canon/registry.ts:64-77`) and the model registry in another (`defaultRegistry`, `registry.ts:29-55`). A user cannot add a provider, change which model backs a role, or set a default provider without editing source. A pipeline's model mapping also does not travel with its exported bundle (`src/install/bundle.ts` exports only `pipelines/*.yaml` and prompt files). This spec makes the provider list, the provider→role mapping, and the default provider selection **data**: one YAML file in the project, loaded and merged over the built-ins, round-tripped through export/import.

---

## Requirements

| ID     | Requirement                                                                                                                                | Status |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| FR-001 | A project file `.agent-flows/providers.yaml` can declare model entries, provider profiles, and a default provider, without any TS edit.    | TODO   |
| FR-002 | Project declarations merge over built-ins by id (project wins); built-ins remain available; absent file ⇒ behavior identical to today.     | TODO   |
| FR-003 | A malformed file fails loudly at startup with a descriptive error naming the offending field — never a silent fallback.                    | TODO   |
| FR-004 | The existing resolution chain (per-run `models` > step `model` > step `role`) is unchanged; only the profile/registry *sources* change.    | TODO   |
| FR-005 | `providers.yaml` travels with exported bundles and is validated on import; the importer's existing file wins unless `overwrite`.           | TODO   |

---

## Existing capability survey (reuse, do not reinvent)

- **Registry & profiles** — `src/canon/registry.ts`:
  - `ModelRegistry.resolve(id)` (`:17-22`) is find-first over its entries array with a claude-CLI passthrough for unknown ids. **Find-first means "project entries prepended" is already an override mechanism** — no merge logic needed inside the class.
  - `defaultRegistry(env)` (`:29-55`) already parameterizes on env; extension = one optional `extra` parameter, not a redesign.
  - `getProfile(id)` / `getActiveProfile(env)` (`:80-92`) close over `DEFAULT_PROFILES`; extension = an optional profiles argument defaulting to the built-ins.
  - `resolveStepModel(step, profile, registry)` (`:99-109`) is already pure and injected — **zero change needed**.
- **Dependency injection already exists at every consumer**: `buildSteps.ts:133` (`deps.profile ?? getActiveProfile()`), `buildSteps.ts:146` (`deps.registry`), `claudeCode.ts:74-75` (`profile ?? getActiveProfile()`). The change is confined to composition roots that today call the zero-arg defaults: `serve/server.ts:931,937`, `bindings/write-cli.ts:18`, `bindings/claudeCode.ts:74-75` (default branch), `bindings/mastra/smoke.ts:40,59`, `doctor.ts:96-97`, `canon/canonWriter.ts:135`, `evals/run.ts:131-132`.
  (Note: `serve/server.ts:914,923` imports `registry.js` via a variable specifier — that is an eslint-cycle workaround per the comment at `:906-909`, **not** a pluggable-registry extension point. Do not treat it as one.)
- **YAML loading & validation idiom** — the canon uses `parse` from `yaml` plus imperative checks with descriptive `throw new Error(...)` messages: `src/canon/load.ts:75-76` and throughout; `src/install/bundle.ts:91-138` (`parseBundle`) is the exact template for validating an untrusted YAML mapping field-by-field. **zod is a mastra-binding concern only** (`src/bindings/mastra/{build,buildSteps,server}.ts`) — the canon layer does not use it, so this feature must not introduce it there.
- **Bundle round-trip** — `src/install/bundle.ts`: `BundleFile.path` is relative to the `.agent-flows/` root (`:28`), `importBundle` already writes any safe relative path with skip-existing/overwrite semantics (`:243-252`) and validates in a temp dir before touching the project (`:216-237`). Carrying `providers.yaml` needs **no new file-transport code** — only one append on export and one validation call on import.
- **Project root discovery** — `.agent-flows/` is already the project convention (`bindings/mastra/pipelineLoader.ts:58`, `install/install.ts:80`, `serve/server.ts:900`).

## Design

**File**: `<projectDir>/.agent-flows/providers.yaml`. Complete example:

```yaml
version: 1
defaultProvider: budget          # optional; must name a profile below or a built-in
models:                          # optional; entries merge over defaultRegistry() by id
  - id: deepseek
    transport: api
    api:
      endpoint: http://localhost:11434/v1/chat/completions
      model: deepseek-r1:14b
  - id: gpt5
    transport: cli
    cli: { bin: codex, model: gpt-5 }
  - id: sonnet                   # overrides the built-in "sonnet" entry
    transport: cli
    cli: { bin: claude, model: claude-sonnet-4-5 }
profiles:                        # optional; profiles merge over DEFAULT_PROFILES by id
  - id: budget                   # new profile
    roles: { reasoner: deepseek, worker: gpt5, scout: haiku }
  - id: anthropic                # overrides the built-in "anthropic" profile
    roles: { reasoner: opus, worker: sonnet, scout: haiku }
```

Rules:
- `version` must be `1` (same idiom as `bundleVersion`, `bundle.ts:103`).
- `models[].transport` must be `"cli"` or `"api"`; `cli.bin` must be `"claude"` or `"codex"` (the existing `ModelEntry` constraint, `registry.ts:10`). New binaries are out of scope.
- `profiles[].roles` must map **exactly** the three roles `reasoner`, `worker`, `scout` (`Role`, `src/canon/types.ts:26`); missing or unknown role keys are errors.
- A profile role value may name a `models` entry, a built-in registry id, or any string (registry passthrough, `registry.ts:20-21`, applies as today).
- **Absent file**: silently use built-ins — identical to current behavior.
- **Malformed file** (bad YAML, wrong `version`, duplicate ids, missing role key, unknown top-level key, `defaultProvider` naming no known profile): throw at startup with a message naming the field, matching the `load.ts` error style. Loud failure, never silent fallback — "declared but silently dropped" is the bug class this project explicitly guards against (`load.ts:300-302`).

## Resolution order (most-specific wins)

Model resolution for an llm step — unchanged chain, changed sources:

1. **Per-run override**: `ctxData.models[step.id]` (key: exact step id) — from HTTP `POST /api/runs` body `models` (`serve/server.ts:597` → `build.ts:171` → `buildSteps.ts:65-68`).
2. **Step declaration**: `step.model` (key: model id string) — `registry.ts:104-105`.
3. **Role indirection**: `step.role` → `activeProfile.roles[role]` (key: role name) → model id — `registry.ts:107-108`.

The winning model id is then resolved through the registry, itself layered:

1. Project `models` entry with that id (from `providers.yaml`).
2. Built-in `defaultRegistry` entry with that id.
3. Claude-CLI passthrough (`registry.ts:20-21`).

Active-profile selection:

1. Explicit argument (e.g. `--provider` flags in `smoke.ts` / `evals/run.ts`).
2. `AGENT_FLOWS_PROVIDER` env (`registry.ts:91`).
3. `defaultProvider` from `providers.yaml`.
4. `"anthropic"`.

## Interface changes

Minimal surface; `ModelRegistry` and `resolveStepModel` are untouched.

**New file `src/canon/loadProviders.ts`** (fs+parse lives beside `load.ts`, keeping `registry.ts` pure):

```ts
export interface ProviderConfig {
  models: ModelEntry[];          // project entries only, [] when file absent
  profiles: ProviderProfile[];   // project entries only, [] when file absent
  defaultProvider?: string;
}
export function loadProviders(
  projectDir: string,
  deps?: { readFile?: (p: string) => string; exists?: (p: string) => boolean }
): ProviderConfig;
```

**`src/canon/registry.ts`** — three signature widenings, all with defaults preserving current calls:

```ts
export function defaultRegistry(env?: NodeJS.ProcessEnv, extra?: ModelEntry[]): ModelRegistry;
// implementation: new ModelRegistry([...(extra ?? []), ...builtins]) — find-first = override

export function getProfile(id: string, extraProfiles?: ProviderProfile[]): ProviderProfile;
// lookup order: extraProfiles then DEFAULT_PROFILES; error message lists the union of ids

export function getActiveProfile(env?: NodeJS.ProcessEnv, config?: ProviderConfig): ProviderProfile;
// id = env.AGENT_FLOWS_PROVIDER ?? config?.defaultProvider ?? "anthropic"
```

**Composition roots** — each gains `const providers = loadProviders(projectDir)` and threads it:
- `src/serve/server.ts:931` → `defaultRegistry(process.env, providers.models)`; `:937` → add `profile: getActiveProfile(process.env, providers)` to the deps object (consumed at `buildSteps.ts:133`; verify `build.ts`'s deps type includes `profile` and add the field if not).
- `src/bindings/claudeCode.ts:74-75`, `src/bindings/write-cli.ts:18`, `src/doctor.ts:96-97`, `src/canon/canonWriter.ts:135`, `src/bindings/mastra/{server.ts:46, smoke.ts:40,59}`, `src/evals/run.ts:131-132` — same two-line pattern where a `projectDir`/cwd is in scope.

**`src/install/bundle.ts`**:
- `exportBundle` (`:53`): after the prompt loop, if `<root>/providers.yaml` exists, append `{ path: "providers.yaml", content }` to `files`. No signature change.
- `importBundle` (`:204`): in the phase-2 temp-dir validation (`:227-237`), if the bundle contains `providers.yaml`, validate it there; a validation failure aborts the import exactly like a pipeline failure. Phase-3 write/skip semantics need no change.

No new dependencies. No zod in the canon layer.

## Backward compatibility

- **No `providers.yaml`**: `loadProviders` returns `{ models: [], profiles: [] }`; every widened signature degrades to today's exact behavior (`DEFAULT_PROFILES`, built-in registry, env-or-anthropic). All existing tests in `registry.test.ts` pass unmodified.
- **Existing pipelines**: untouched — `role`/`model` step fields and their validation (`load.ts:204-211`) are unchanged.
- **Existing per-run `models` overrides**: unchanged and still highest-precedence; the override path (`buildSteps.ts:65-68`) does not touch profiles at all.
- **Existing bundles** (no `providers.yaml` entry): import unchanged — the file is optional in both directions.
- **`AGENT_FLOWS_PROVIDER`**: still honored, now explicitly above the file's `defaultProvider`.

## Round-trip through export/import

The file travels. Rationale: role indirection keeps *pipelines* portable, but a pipeline authored against a custom profile (e.g. `budget` above) is unrunnable on import without the profile definition — the mapping is part of the workflow's meaning, so it rides in the bundle. Safety comes free from existing `importBundle` semantics: the importer's own `providers.yaml` is skipped unless `overwrite` (`bundle.ts:246-249`), so importing a bundle never silently replaces local provider choices, and phase-2 validation rejects a malformed bundled file before any write. Machine-local concerns (endpoints, env-var names) stay overridable because the importer's file wins by default.

## Out of scope

- New CLI binaries beyond `claude`/`codex` (`ModelEntry.cli.bin` union unchanged).
- New or user-defined roles beyond `reasoner`/`worker`/`scout`.
- Per-pipeline or per-step profile selection (a step already has `model:` for full override).
- Hot-reloading `providers.yaml` while `serve` is running (restart to apply).
- Any change to `ModelRegistry`, `resolveStepModel`, or the per-run `models` override contract.
- API-key management or transport changes.

## Test plan

`src/canon/loadProviders.test.ts`:
- `absent-file-returns-empty-config` — no file ⇒ `{ models: [], profiles: [] }`, no throw.
- `parses-full-example` — the literal example above parses into the expected `ProviderConfig`.
- `rejects-bad-version`, `rejects-unknown-top-level-key`, `rejects-duplicate-model-id`, `rejects-duplicate-profile-id`, `rejects-missing-role-key`, `rejects-unknown-role-key`, `rejects-bad-transport`, `rejects-bad-cli-bin`, `rejects-unknown-default-provider` — each asserts the error message names the offending field (FR-003).

`src/canon/registry.test.ts` (additions):
- `extra-entry-overrides-builtin-by-id` — `defaultRegistry(env, [sonnetOverride])` resolves `"sonnet"` to the override.
- `builtin-survives-extra` — with extras present, an untouched built-in id still resolves.
- `project-profile-overrides-builtin`, `new-profile-resolvable`, `unknown-profile-error-lists-union`.
- `active-profile-precedence` — env beats file `defaultProvider`; file beats `"anthropic"`; all-absent yields `anthropic` (existing test still green).
- `zero-arg-calls-unchanged` — `defaultRegistry()`, `getProfile("anthropic")`, `getActiveProfile({})` behave exactly as before (FR-002 regression guard).

`src/install/bundle.test.ts` (additions):
- `export-includes-providers-yaml-when-present`, `export-omits-when-absent`.
- `import-skips-existing-providers-yaml` / `import-overwrites-with-flag`.
- `import-rejects-malformed-bundled-providers` — nothing written to the project (mirrors `bundle.test.ts:250` idiom).
- `old-bundle-without-providers-imports-unchanged`.

Integration (extend `serve` tests): run resolution precedence end-to-end — per-run `models[stepId]` beats step `model` beats `role`-via-project-profile beats built-in profile.
