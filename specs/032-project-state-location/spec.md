# 032. Project state location

| Field        | Value                        |
| ------------ | ---------------------------- |
| Feature Name | Project state location       |
| Branch       | `032-project-state-location` |
| Status       | Implemented — 2026-09-13     |
| Created      | 2026-09-13                   |

## Problem

Machine-local state lives inside the project and inside the tool's own checkout. Run artifacts
default to `<project>/.agent-flows/runs/<runId>/<pipelineId>.json` (`artifactStore.ts:103-104`), and
every write calls `ensureRunsGitignore`, which creates or appends `runs/` to
`<project>/.agent-flows/.gitignore` at runtime (`artifactStore.ts:110,279-297`) — a runtime edit of a
file inside the user's tracked tree with no precedent among the twelve surveyed tools (research §1,
F2; §2.1). `<project>/.agent-flows/n8n.json` holds instance-local n8n workflow ids, has no ignore
rule, and is committed by default (F4, `server.ts:108-128`). The tickets/drafts SQLite db defaults to
`join(process.cwd(), "agent-flows.sqlite")` (`server.ts:404`, `:1715`, `--db` override), and
`dev-serve.sh`/`mcp-serve.sh` export (`install.sh` does not — `scripts/install.sh:6`)
`AGENT_FLOWS_PROJECT_DIR` and then `cd` into the tool checkout before `exec` — so every served
project shares one db that lives inside the
agent-flows repo, not per project (F3). `agent-flows-mastra.db` is derived from the same path
(`paths.ts:10-12`) and inherits the same defect.

Every surveyed tool draws one line: what a teammate needs to reproduce behaviour is versioned in the
project (`.claude/settings.json`, `AGENTS.md`, `.vscode/settings.json`, `.envrc`,
`.terraform.lock.hcl`, `.pre-commit-config.yaml`, `mise.toml`); what only this machine produced is
under the home dir, keyed per project (Claude Code transcripts/memory, Codex sessions, VS Code
`workspaceStorage`, direnv `allow`, pre-commit cache, mise state) — research §2.1. Only Claude Code
manages a runtime ignore rule, and it edits the _global_ excludes file, never the repo's `.gitignore`
(F10, §2.1). No surveyed tool keeps its shared config out of the project either (research §2, O2).

## Goals / Non-goals

**Goal.** Versioned canon (`pipelines/`, `prompts/`, `providers.yaml`, `config.json`) stays in
`<project>/.agent-flows/` unchanged. Machine-local state — run artifacts, the tickets/drafts db, the
mastra db, the project n8n id map — moves under a per-project directory keyed off the resolved
project path, with no runtime writes into the project tree beyond the canon the owner asked for.

**Non-goals.** Moving canon (`pipelines/`, `prompts/`) out of the project (research O2, rejected — it
breaks review/blame/clone and contradicts ADR-0011, spec 013, README:68); per-worktree key sharing;
a retention/pruning policy for `runs/`; a two-daemon/two-port story (spec 033).

## Decisions

**D1 — Split, not move.** Versioned canon stays in `<project>/.agent-flows/` (`pipelines/`,
`prompts/`, `providers.yaml`, any config the owner commits). Machine-local state moves to the state
dir. Rationale: canon must travel with clones and stay under version control; "codebase is docs".

**D2 — State dir layout.** `${AGENT_FLOWS_HOME ?? ~/.agent-flows}/projects/<key>/` contains
`project.json` (`{ projectDir, key, createdAt, schemaVersion: 1 }`), `runs/<runId>/…` (artifacts +
manifest, the layout `artifactStore.ts` writes today), `agent-flows.sqlite` (tickets/drafts),
`agent-flows-mastra.db` (libsql, derived per FR-006 from the sqlite name exactly as
`src/bindings/mastra/paths.ts` does today), `n8n.json` (project n8n id map). Unchanged, global:
`~/.agent-flows/templates/`, `~/.agent-flows/n8n.json` (instance config, F5).

**D3 — Project key.** Escaped absolute realpath of the resolved project dir, using Claude Code's
transcript scheme (F10): every character outside `[A-Za-z0-9_-]` becomes `-`, leading `-` kept;
truncated to 200 chars plus an 8-char sha256 suffix when longer; `AGENT_FLOWS_PROJECT_KEY` overrides.
The sha256 is taken over the unescaped realpath; escaping is applied first, then the escaped string
is cut to 200 chars and joined to the 8-char hex suffix by `-` (total 209). The key derivation
realpaths its input independently; `resolveProjectDir()`'s return value
(`src/bindings/mastra/projectDir.ts:22`) is unchanged, so step execution cwd is unaffected. On
case-insensitive filesystems two spellings of one directory yield two keys — accepted, listed in
Risks.
Rationale: matches the unit the daemon already resolves (`AGENT_FLOWS_PROJECT_DIR ?? cwd`,
`projectDir.ts:22`), needs no git, a moved repo yields a listable orphan rather than a collision, two
checkouts of one repo stay separate (research §3.1). Worktrees get separate state (accepted; §3.1,
follow-up below).

**D4 — Stop writing into the project.** Delete `ensureRunsGitignore` (`artifactStore.ts:110,
279-297`) and any other runtime write to `<project>/.agent-flows/.gitignore`; the project
`n8n.json` (`server.ts:126`) is no longer written there.

**D5 — Non-destructive migration.** On daemon start, if `<project>/.agent-flows/runs` exists and
`<stateDir>/runs` does not, COPY it into the state dir once into `<stateDir>/runs.partial` and then
`rename` it into place, so an interrupted copy never counts as done; and print one notice naming both
paths and saying the old dir may be deleted by hand; never delete or move. `<project>/.agent-flows/n8n.json`
is read as a fallback when the state-dir copy is absent, and written only to the state dir. A legacy
`<cwd>/agent-flows.sqlite` is NOT auto-migrated (F3: it was effectively a shared global store); the
daemon prints a notice if one exists, and `--db` still overrides to any path the owner wants.

**D6 — Surfaces.** `GET /api/environment` and the UI header show the state dir; `agent-flows
list`/`install` output names it; README gains a "Where agent-flows keeps files" section with the
split table.

## Functional Requirements

- **FR-001.** The project key is derived by escaping every character outside `[A-Za-z0-9_-]` in the
  resolved (`realpath`) absolute project dir to `-`, truncated to 200 chars plus an 8-char sha256
  suffix when longer; `AGENT_FLOWS_PROJECT_KEY` overrides the derivation entirely (D3).
- **FR-002.** The state dir resolves to `${AGENT_FLOWS_HOME ?? path.join(os.homedir(),
".agent-flows")}/projects/<key>/` (D2, D3).
- **FR-003.** `project.json` (`{ projectDir, key, createdAt, schemaVersion: 1 }`) is written once, on
  first resolution for a key, and never overwritten on subsequent resolutions of the same key.
- **FR-004.** Run artifacts and manifests default to `<stateDir>/runs/<runId>/<pipelineId>.json` and
  the equivalent manifest path, replacing the `<project>/.agent-flows/runs/...` default in
  `artifactStore.ts:103-104`, `runService.ts:999,1024`, and the run-detail route
  (`server.ts:1112`).
- **FR-005.** The tickets/drafts db defaults to `<stateDir>/agent-flows.sqlite`, replacing
  `join(process.cwd(), "agent-flows.sqlite")` in `server.ts:404` and `:1715`; `--db` continues to
  override.
- **FR-006.** The mastra libsql db path is derived from the resolved db path exactly as today
  (`paths.ts:10-12`: strip `.sqlite`/`.db`, append `-mastra.db`) so a `<stateDir>/agent-flows.sqlite`
  default yields `<stateDir>/agent-flows-mastra.db`. It is derived at the call site from the
  _effective_ db path, not stored on `ProjectState`: a field there would be a second derivation that
  silently ignores `--db`.
- **FR-007.** The project n8n id map is read from `<project>/.agent-flows/n8n.json` only as a
  fallback when `<stateDir>/n8n.json` does not exist, and is written only to `<stateDir>/n8n.json`
  (`server.ts:108-128`).
- **FR-008.** No code path writes or appends to `<project>/.agent-flows/.gitignore` at runtime;
  `ensureRunsGitignore` (`artifactStore.ts:110,279-297`) is deleted.
- **FR-009.** On daemon start, if `<project>/.agent-flows/runs` exists and `<stateDir>/runs` does
  not, the runs dir is copied (not moved) into the state dir exactly once, and one notice line naming
  both paths is printed; a start that finds an incomplete copy (`runs.partial` present, no `runs`)
  redoes it; a start with a complete copy performs no copy and leaves the legacy dir untouched.
- **FR-010.** If a legacy `<cwd>/agent-flows.sqlite` exists in the daemon's launch cwd, and no
  `<stateDir>/agent-flows.sqlite` exists yet, the daemon prints a notice naming the legacy path and
  the new default; it is never auto-migrated.
- **FR-011.** `GET /api/environment` and the UI header report the resolved state dir; `agent-flows
list` and `agent-flows install` output name the state dir alongside the canon dir.
- **FR-012.** README documents the split: what stays in `<project>/.agent-flows/` versus what lives
  under the state dir, with the `AGENT_FLOWS_HOME` override.
- **FR-013.** `scripts/install.sh` exports `AGENT_FLOWS_PROJECT_DIR="${AGENT_FLOWS_PROJECT_DIR:-$PWD}"`
  before its `cd`, matching `scripts/mcp-serve.sh:8-9`, so `install`/`list` resolve the owner's
  project rather than the tool checkout.

## Verification

- **V1.** Unit tests for key derivation (escape, 200-char truncation + 8-char sha256 suffix,
  `AGENT_FLOWS_PROJECT_KEY` override) and state dir resolution (default vs `AGENT_FLOWS_HOME`). Red if
  the escape set, truncation length, or override precedence changes.
- **V2.** A test asserts `writeRunArtifact` writes under `<stateDir>/runs/<runId>/...`; mutation that
  reverts the default to `<project>/.agent-flows/runs` must turn the test red.
- **V3.** A test runs a pipeline against a temp project dir and asserts no file under
  `<project>/.agent-flows/` other than the allowlisted `pipelines/`, `prompts/`, `providers.yaml`,
  `config.json` is created or modified; mutation (re-add `ensureRunsGitignore`'s call site) must turn
  the test red.
- **V4.** Migration test: seed a legacy `<project>/.agent-flows/runs/` dir, start the daemon once —
  assert the state-dir copy exists and is byte-identical to the legacy dir. Seed a `runs.partial`
  left behind by a simulated interrupted copy (no `runs`) — assert the next start redoes the copy to
  completion. Start again with a complete `runs` present — assert no further copy occurs
  (mtime/content unchanged). The legacy dir stays byte-identical to its seed throughout all three
  starts.
- **V5.** Live: start the daemon with `AGENT_FLOWS_HOME=<tmp>` against a temp project, `POST
/api/runs {pipeline:"test", inputs:{checkCommand:"true"}}` (no model call); assert artifacts and
  manifest appear under `<tmp>/projects/<key>/runs/<runId>/` and no new file appears under the temp
  project's `.agent-flows/`.
- **V6.** `pnpm check` is green.
- **V7.** Existing artifact/run-path assertions in `src/runtime/artifact.test.ts` and
  `src/serve/server.test.ts` (about 20, hard-coding `<tmp>/.agent-flows/runs/...`) are updated to the
  state dir as part of FR-004; `pnpm check` green is the gate.

## Risks

- Two daemons serving two projects still need two ports — out of scope here (spec 033).
- Worktrees of one repo get separate state dirs (D3, accepted).
- Users who relied on `<project>/.agent-flows/runs` being visible in-project must look under the new
  state dir; the migration notice (FR-009) is the only signal given.
- Ticket ids become per-project autoincrement, no longer unique across projects; ids recorded in
  pre-migration artifacts may resolve into a different db.
- On case-insensitive filesystems, two spellings of one directory (differing only in case) resolve to
  two separate keys and two separate state dirs — accepted.
- The legacy runs copy uses `cpSync` with `dereference: false` (the default): symlinks are copied as
  links, so a relative symlink that escaped `runs/` breaks at the new depth. The copy also does not
  preserve timestamps — artifact mtimes are reset to the copy time. Both accepted: run artifacts are
  self-describing JSON, and the legacy directory is left in place for the owner to consult.

## Follow-ups

- A worktree-shared key option via `git rev-parse --git-common-dir` (research §3.1).
- Retention/pruning of `runs/` under the state dir.
- An `agent-flows where` CLI verb printing the canon dir and the state dir.

## Verification log (2026-09-13)

1294 tests green at HEAD. V5 live: a daemon on a temp project with `AGENT_FLOWS_HOME=<tmp>` ran the
`test` pipeline with `checkCommand: true`; the artifact and the manifest landed under
`<tmp>/projects/<key>/runs/<runId>/`, and the project listing was unchanged. Mutations, all red: the
old in-project artifact path (14 failures), appending to `.gitignore`, redoing a partial copy, and the
`install.sh` export. Review follow-ups applied: state is a required argument at all 57 call sites,
stale `runs.partial` copies are swept, and the legacy notice is scoped.
