# 035. n8n node via daemon

| Field        | Value                     |
| ------------ | ------------------------- |
| Feature Name | n8n node via daemon       |
| Branch       | `035-n8n-node-via-daemon` |
| Status       | Draft — 2026-09-14        |
| Created      | 2026-09-14                |

## Problem

The owner, looking at the node's panel (Role select, free-text "Model Override", Workspace Access,
Prompt, Timeout): "here we have role, but we also need to have a model select, and there should be
the list of models according to where the tool was run: if the session was started in anthropic —
claude models, if openai — openai models, if other — all available."

The node spawns `claude` directly (`AgentFlowsAgent.node.ts:190`, `spawn('claude', args, ...)`), so
it (a) cannot offer models other than Claude's, (b) has no knowledge of the daemon's registry or
active profile (`AGENT_FLOWS_PROVIDER`, `getActiveProfile`, `registry.ts:156`), (c) bypasses the
adapters, confinement, portability check and run observability built in specs 031–034, and (d)
validates "Model Override" against its own copy of the registry
(`ROLE_TO_MODEL`/`ALLOWED_MODELS`, `AgentFlowsAgent.node.ts:27-45`), kept in sync only by a source-parsing
test (`src/canon/n8nNodeRoleModelSync.test.ts`). Spec 027 flagged the same gap: "n8n as an executor
needs an ADR: either the agent node calls the daemon (`POST /api/runs`) so runs are observable and
confined, or n8n stays authoring-only" (`specs/027-open-work/spec.md:124-125`).

## Decisions

**D1 — The daemon is the node's executor.** New route `POST /api/steps` runs ONE llm step through
the same path a pipeline step takes: body `{ role?, model?, workspaceAccess: "read"|"write"|"none",
workspaceDirectory?, prompt, timeoutMs?, schema? }`. The daemon resolves the `ModelEntry` (explicit
`model` registry id wins, else `role` under the active profile — `resolveStepModel`,
`registry.ts:169-179`), runs `checkPortability` (`portability.ts:35`), calls `runLlmStep` via the
adapters (claude native denies, codex sanitized copy + profile, api text-only —
`adapters/types.ts`), and responds `{ output, model: { id, transport, bin? }, durationMs }`. Errors
(portability refusal, unknown model, missing workspace) return 400 with the reason. A step run is
recorded as a one-step run in the registry so it appears on the Runs page and in artifacts
(`invocation.source: "n8n"`), with the prompt attached via stepIntrospection. Long-running: the HTTP
response waits for the step to finish; the node's own timeout governs the call.

**D2 — Model listing.** `GET /api/models` returns `{ profile, models: [{ id, label, transport, bin?,
provider, roles: [...] }] }`, filtered by the active profile (`getActiveProfile`): `anthropic` →
entries whose `cli.bin` is `claude`; `openai` → entries whose `cli.bin` is `codex`; any other profile
(e.g. `local`) → every entry. Each entry marks which roles map to it under the active profile
(`profile.roles`). `label` is `<id> (<model string or bin>)`.

**D3 — Node changes.** A `Daemon URL` parameter (default `http://127.0.0.1:7411`); Role stays;
`Model Override` becomes a Model select (`type: "options"`, `loadOptionsMethod: "getModels"` calling
`GET <daemonUrl>/api/models`; first option "(role default)" = empty; if the daemon is unreachable
the dropdown shows one option explaining to start the daemon). Workspace Access / Directory / Prompt
/ Timeout stay unchanged. `execute()` POSTs to `/api/steps` and returns
`{ output, model, transport, workspaceAccess, durationMs }`. The local `claude` spawn path
(`runClaude`, `buildMinimalEnv`, `validateWorkspaceDirectory`'s call sites, `ROLE_TO_MODEL`,
`ALLOWED_MODELS`, `resolveModel`) is deleted; the node no longer needs the `claude` binary on n8n's
PATH.

**D4 — Export.** `src/bindings/n8n/build.ts` (`buildStepNode`, `:276-283`) emits `daemonUrl` from
`AGENT_FLOWS_PORT`/7411 alongside the existing `role`, `model: ""`, `workspaceAccess`,
`workspaceDirectory`, `prompt`, `timeoutMs` fields; existing pushed workflows keep working (empty
`model` = role default).

**D5 — Install.** The built node is installed into `~/.n8n/nodes` per the README's
`npm install <path>` step, n8n restarted; the daemon must be running for the node to execute — the
node's error message says so explicitly.

## Functional Requirements

- **FR-001.** `POST /api/steps` accepts `{ role?, model?, workspaceAccess, workspaceDirectory?,
prompt, timeoutMs?, schema? }`, resolves the model (explicit `model` wins over `role`), and returns
  `{ output, model: { id, transport, bin? }, durationMs }` on success.
- **FR-002.** `POST /api/steps` runs `checkPortability` before dispatch; a refusal returns 400 with
  the same reason string `checkPortability` produces (step id, profile, transport, requirement).
- **FR-003.** `POST /api/steps` returns 400 for an unknown explicit `model` id and for
  `workspaceAccess: "read"|"write"` with a missing or invalid `workspaceDirectory`.
- **FR-004.** Every `/api/steps` call is recorded as a one-step run in the run registry with
  `invocation.source: "n8n"`; the run appears in `GET /api/runs` and its step carries the prompt via
  stepIntrospection.
- **FR-005.** `GET /api/models` filters registry entries by the active profile's CLI bin
  (`anthropic` → `claude`, `openai` → `codex`, any other profile → unfiltered) and marks, per entry,
  which roles resolve to it under the active profile.
- **FR-006.** The node's `Model` parameter is a `loadOptionsMethod` (`getModels`) options field
  whose first entry is "(role default)" mapping to an empty string; when the daemon is unreachable it
  returns a single disabled-looking option instructing the operator to start the daemon, rather than
  throwing.
- **FR-007.** `execute()` sends the node's own `timeoutMs` as the HTTP request timeout for the
  `/api/steps` call and surfaces a `NodeOperationError` naming the daemon URL when the call fails or
  the daemon is unreachable.
- **FR-008.** The `claude` spawn path, its env-scrubbing (`buildMinimalEnv`), its inline
  `ROLE_TO_MODEL`/`ALLOWED_MODELS` tables, and `resolveModel` are removed from
  `AgentFlowsAgent.node.ts`; the node package no longer imports `node:child_process`.
- **FR-009.** `src/bindings/n8n/build.ts` adds `daemonUrl` (from `AGENT_FLOWS_PORT`, default 7411) to
  every generated llm-step node's parameters, alongside the existing fields.
- **FR-010.** `src/canon/n8nNodeRoleModelSync.test.ts` is replaced by a test asserting the node's
  `properties` array contains no `ROLE_TO_MODEL`/model-table declaration and that `Model` is an
  `options`-type field using `loadOptionsMethod`.

## Verification

- **V1.** Route tests for `GET /api/models` under each profile (`AGENT_FLOWS_PROVIDER` set per test):
  `anthropic` → only claude-bin entries, `openai` → only codex entries, `local` → all entries.
  Mutation: drop the profile filter → red.
- **V2.** Route tests for `POST /api/steps` with a fake runner: role resolution, explicit `model`,
  portability refusal → 400, and the resulting run appearing in `GET /api/runs` with
  `source: "n8n"` and the prompt attached to its step.
- **V3.** Node unit tests: check the package's own test setup (`integrations/n8n-nodes-agent-flows`,
  `npm run test:ts`) first; if present, add a script-level test of `getModels` against a fake daemon
  HTTP server; otherwise cover this with a build + a script-level test invoked from the repo root.
- **V4.** Live: build and install the node, restart n8n, open the `investigate` workflow — the survey
  node's Model dropdown lists the anthropic entries (owner's visual pass DEFERRED pending operator);
  execute the workflow with a request and confirm the run appears on the daemon page with
  `source: "n8n"` via `GET /api/runs` (daemon-side check, not the browser).
- **V5.** `pnpm check` green.

## Risks

- Restarting n8n to load the rebuilt node drops any in-flight executions.
- The node package needs a version bump for n8n to pick up the rebuilt `dist/`.
- Regenerating `.n8n-workflows/` via `src/bindings/n8n/build.ts` (D4) changes all 12 exported
  workflow files.

## Follow-ups

- Route `check` steps through a daemon endpoint too, since `n8n-nodes-base.executeCommand` has no
  daemon awareness (`executeCommand` is unavailable there).
- Gate steps via `/api/runs/:id/approve` from within an n8n workflow.
