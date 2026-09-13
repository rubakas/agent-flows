# 031. Provider-portable workspace access

| Field        | Value                              |
| ------------ | ---------------------------------- |
| Feature Name | Provider-portable workspace access |
| Branch       | `031-provider-portable-workspace`  |
| Status       | Implemented — 2026-09-13           |
| Created      | 2026-09-13                         |

## Problem

The only executed path is chat → MCP `run_pipeline` (`src/bindings/mastra/server.ts:117` POSTs to
the daemon) → `src/serve/server.ts` (`createDynamicMastra`) → Binding B → `buildLlmStep`
(`src/bindings/mastra/buildSteps.ts:175`) → `runLlmStep` (`src/canon/runStep.ts:837`) → a provider
CLI subprocess. `permissions.contents` is enforced asymmetrically across transports: the Claude
branch assembles `--restricted --strict-mcp-config` plus tool grants and `--disallowedTools`
credential-deny rules over `CREDENTIAL_DENY_PATTERNS` (`runStep.ts:934-935`, `:981-1000`, `:45-168`;
verified enforced live against CLI 2.1.270), while the api transport throws at runtime for any
`permissions.contents` (`runStep.ts:847-851`), and the codex branch throws on `contents: write`
(`:1054-1057`) and on `contents: read` (`:1059-1072`, reasoning given there: codex exec has no
file-deny mechanism, so credential files would be readable). Codex already spawns
`codex exec --ephemeral --json -s read-only [-m model]` (`:656-663`) and accepts a `cwd` (`:651`,
`:666`), but is called with `undefined` cwd (`:1073`) — and `-s read-only` does not confine reads in
any case (probe, D2), so cwd alone was never a boundary.
Every repo-grounded pipeline declares `contents:` (`code-review.yaml:22,28,38,50`,
`build-round.yaml:22`, `develop.yaml:18`, `correct-plan.yaml:18`, `investigate.yaml:14`,
`audit.yaml:17,23`), so "any model" today means "any model addressable by the Claude Code CLI", and
`specs/029-stage-handoff` V-5 (start a stage under `AGENT_FLOWS_PROVIDER=openai`) cannot pass on any
real pipeline. Role selection already resolves per-profile per-step (`registry.ts:94-110` profiles,
`:45-53` model entries, `resolveStepModel` `:151-161`, `getActiveProfile` `:138-144`,
`AGENT_FLOWS_PROVIDER` env → `providers.yaml` → `"anthropic"`), so the profile the step actually
runs under is known before dispatch.

## Goals / Non-goals

**Goal.** A step with `permissions.contents: read` runs under any registered CLI transport with the
same credential invisibility as the Claude path; unsupported combinations are refused before any
model call, with the reason; portability is visible from `pnpm canon:check`.

**Non-goals.** `contents: write` on codex; a tool loop for the api transport; changes to Bindings A
or C; collapsing step kinds; research items T1–T5.

## Decisions

**D1 — Adapter seam.** `runLlmStep(entry, prompt, deps)` stays the executor seam. A new
`src/canon/adapters/` holds a `ProviderAdapter` interface: `id`, `capabilities(entry, config) →
{ workspaceRead, workspaceWrite, budgetCap }` (computed from configuration, never constants), and
`run(prompt, entry, deps) → Promise<string>`, which MUST supervise (watchdog or timeout) —
supervision is a canon invariant, not a capability, matching the existing split (`runStep.ts:868-873`
claude watchdog, `DEFAULT_STEP_TIMEOUT_MS` and claude-only `maxBudgetUsd` at `:1048-1052`). Claude
flag assembly moves verbatim into `adapters/claude.ts`; codex into `adapters/codex.ts`; api into
`adapters/api.ts`. `runLlmStep` dispatches by adapter.

**D2 — Sanitized copy + codex permission profile (two layers, both required).**
`src/canon/workspace/sanitize.ts` exposes `materializeSanitizedWorkspace(repoDir) → { dir, cleanup }`.
Copy = `git ls-files -co --exclude-standard -z` (tracked + untracked-not-ignored) minus every path
matching the exclusion set — `CREDENTIAL_DENY_PATTERNS` (the same array object the Claude flag
builder imports) ∪ the path globs of the operator's own `Read(...)`/`Grep(...)` deny rules from
`operatorDenyRules()`, so a file hidden from every Claude step is not readable simply by running that
step under codex — matched case-insensitively; symlinks skipped, never followed — accepted
consequence: a symlinked in-repo source directory is invisible to the step; gitlink/submodule
entries skipped with a logged note; `.git` not copied. `BUILD_CONFIG_DENY_PATTERNS` is deliberately
NOT excluded: those files are Edit-denied but read-allowed on the Claude path, and codex has no write
path at all, so excluding them would blind a review step to `package.json`, `tsconfig`, every
`*.config.*` and `pipelines/**` for no gain in confinement. TOCTOU between `lstat` and the copy is
accepted for a single-operator tool. Lives under `os.tmpdir()` as `agent-flows-ws-<random>`, removed
in `finally`; each materialization sweeps `agent-flows-ws-*` dirs older than 24h.
**Confinement (layer two).** Probe 2026-09-13 (codex-cli 0.152.1): `codex exec -s read-only -C <dir>`
does not confine reads — a sibling dir, `../`, and `~/.codex` were all readable, exit 0; `-s
read-only` is write/network-only, and `-c 'sandbox_permissions=[]'` is a silent no-op. The adapter
never passes `-s`; it composes a named profile instead: `-c 'default_permissions="agent_flows"' -c
'permissions.agent_flows.extends=":read-only"' -c 'permissions.agent_flows.filesystem={...}'`, denying
`/Users`, `/Volumes`, `/tmp`, `/private/tmp`, `/etc`, `/private/etc`, `/var/folders`,
`/private/var/folders`, `/Library`, `/Applications`, `/opt/homebrew/etc`, `/usr/local/etc`,
`/private/var`, `/nix`, `/srv`, `/root`, `os.homedir()`, and the parent of `os.tmpdir()` if
uncovered — never `/opt` or `/usr/local` wholesale, which makes the binaries under them unexecutable
(`execvp … Operation not permitted`), so only their `etc` subtrees are denied — every path, deny and
grant alike, is `fs.realpathSync`-resolved before composition so `/var` vs `/private/var` cannot
split the namespace (never `/` — probed, SIGABRT 134), plus one `read` grant on the copy
(most-specific path wins; the grant under `/private/var/folders/...` still beats the `/private/var`
deny). Both layers are required: the copy strips credential-named files and ignored bulk; the profile
makes every other path — the real repo, other steps' copies, `~/.codex` — unreadable. Stated
boundary, not fixed here: the exclusion set is the Claude credential deny set plus the operator's
read denials, so secrets in ordinary-named files (`config.ts`, `backup.sql`) remain visible on both
paths. Codex `workspaceRead: true` only when the profile is composed (computed from config, FR-003),
`workspaceWrite: false`. `sandbox_permissions` must never be used — confirmed no-op. Claude keeps its
native deny flags and does not use the copy.

**D3 — Portability check at run start.** Before any model call, for every `llm` step,
`checkPortability(step, entry, profileId)` resolves the `ModelEntry` exactly as `buildLlmStep` does
(ctx `models` override first, else profile role), inside the step wrapper before `runner()` is
called, and compares `permissions.contents` — and `maxBudgetUsd` against `capabilities().budgetCap` —
to the resolved adapter's capabilities; a mismatch errors naming the step, profile, transport, and
reason. The runtime throws already in the adapters (D1) stay as defence in depth. This check is a
pure function so `canon:check` can reuse it without a model call.

**D4 — Portability matrix.** `pnpm canon:check` prints pipeline × profile → `"runs"` or `"refused:
<step>: <reason>"`.

**D5 — Delete `permissions.allow`.** The field, its doc block, its subtraction semantics
(`allowEntryRemoves`, `runStep.ts:311-346`, `:366-384`, `:957-979`), loader validation, and tests are
removed; `deny` stays narrowing-only. `permissions.allow` has zero uses across `pipelines/`
today, and `docs/research/2026-09-13-openai-agents-platform-vs-agent-flows.md` §4 D1 recommends the
same removal. A pipeline declaring `allow:` fails load with "permissions.allow was removed (spec
031); deny is narrowing-only".

## Functional Requirements

- **FR-001.** `runLlmStep` dispatches to a `ProviderAdapter` (D1) instead of branching inline on
  transport; the claude/codex/api branches move verbatim into `adapters/claude.ts`,
  `adapters/codex.ts`, `adapters/api.ts` with no behavior change. Supervision code (the deadline,
  `StepTimeoutError` mapping, the claude watchdog, and the reformulation retry) moves with its
  branch; `runLlmStep` keeps only dispatch.
- **FR-002.** Every adapter's `run()` enforces supervision (watchdog for claude, timeout for
  codex/api) internally; a caller cannot construct an unsupervised adapter call.
- **FR-002a.** Each adapter has a unit test proving an unsupervised call is impossible: a
  deliberately hung child process is aborted by the adapter's own supervision, not by the test
  harness.
- **FR-003.** `capabilities()` is computed from the entry and resolved config on each call, never a
  hardcoded table, so a future config change (e.g. a codex sandbox flag) is reflected without an
  adapter rewrite.
- **FR-003a.** A capabilities test flips one config field and asserts the reported capability
  changes accordingly.
- **FR-004.** The codex adapter runs against `materializeSanitizedWorkspace(repoDir).dir` as its `-C`
  root, composing the `agent_flows` permission profile (D2) — never `-s read-only`, which probe
  2026-09-13 showed does not confine reads; the temp copy is removed in `finally` even on adapter
  failure, and each materialization sweeps `agent-flows-ws-*` directories older than 24h.
- **FR-005.** The sanitized copy excludes every path matching `CREDENTIAL_DENY_PATTERNS` ∪ the path
  globs of the operator's own `Read(...)`/`Grep(...)` deny rules, case-insensitively, skips symlinks
  without following them, skips gitlink/submodule entries with a logged note, and never contains
  `.git`. `BUILD_CONFIG_DENY_PATTERNS` is NOT excluded: those files are read-allowed on the Claude
  path and codex has no write path, so excluding them would only blind the step (D2).
- **FR-006.** Codex capabilities report `{ workspaceRead: true, workspaceWrite: false }` only when
  the adapter is configured to compose the `agent_flows` profile (computed from config, per D2); api
  capabilities report `{ workspaceRead: false, workspaceWrite: false }`; claude capabilities report
  `{ workspaceRead: true, workspaceWrite: true }`.
- **FR-007.** `checkPortability(step, entry, profileId)` runs before any model call for every `llm`
  step and throws with the step id, profile id, transport, and reason on a capability mismatch
  (`permissions.contents` or `maxBudgetUsd` vs. `capabilities().budgetCap`), independent of the
  adapter-level throws it front-runs.
- **FR-008.** `pnpm canon:check` calls `checkPortability` for every pipeline × registered profile
  combination and prints `"runs"` or `"refused: <step>: <reason>"` per cell, making zero model calls.
- **FR-009.** The loader rejects any pipeline declaring `permissions.allow` with the exact message
  "permissions.allow was removed (spec 031); deny is narrowing-only"; `deny` continues to work
  unchanged.

## Verification

- **V1.** Golden argv: captured for profile `anthropic`, no ctx `models` override, no skills, no
  `maxBudgetUsd`, fixed `cwd`, and a fixed prompt fixture, before FR-001's adapter extraction and
  before the `allow` deletion (D5/FR-009) land. The Claude argv for `code-review`'s `verify` step must
  be byte-identical against that capture after both changes.
- **V2.** Sanitizer unit tests: planted `.env`, `.ENV`, `id_rsa`, `x.pem`, `secrets.yaml`,
  `service-account.json`, a symlink to a file outside the repo, and a nested `.git` are absent from
  the copy; ordinary tracked files and an untracked non-ignored file are present; an ignored file is
  absent. `.env`/`.ENV` must be planted in a case-sensitive fixture (or one dropped) — APFS is
  case-insensitive and would collapse the pair.
- **V3a.** Deterministic, no model, part of `pnpm test`, SKIP-lined, with the reason printed, only
  when `codex` is absent from PATH. On any codex version the assertions run — an API change must show
  as red, never as a skip (verified on 0.152.1). Build a copy from a fixture repo; `codex sandbox -P
agent_flows -C <copy>` with the -c flag array obtained from the adapter's own flag-builder
  `codexConfinementArgs()` (never hand-written; -C requires -P), then `-- cat <copy>/README.md`
  returns the marker; `-- cat <fixture repo>/outside-marker.txt` returns non-zero with "Operation not
  permitted";
  `-- sh -c 'echo x > <copy>/w'` exits non-zero with "Operation not permitted". The test asserts exact
  exit codes, not merely non-zero. Red if the `filesystem` deny map is dropped — control: an
  `extends`-only profile (no deny map) leaks the outside marker.
- **V3b.** Live, with a model, forced-shell-attempt prompt under codex; run manually, recorded in the
  verification log (not part of `pnpm test`).
- **V3c.** The same marker probe as V3a/b, run on the claude path (native deny flags), for symmetry.
- **V4.** Run-start refusal without model calls: codex+write, api+read, api+write each produce the D3
  error naming the step.
- **V5.** `canon:check` matrix snapshot for all 12 pipelines × 3 profiles (`anthropic`, `openai`,
  `local`). `local` (api transport) is expected `refused` for every pipeline declaring `contents`, so
  the matrix shape is 12 × {runs, runs, refused}.
- **V6.** The `code-review-citations` eval runs end to end under `AGENT_FLOWS_PROVIDER=openai` with
  schema-valid `verify` output; the score is reported, not gating — a weaker verdict from a weaker
  model is a model finding, not a spec failure.
- **V7.** The loader rejects `allow:`; all 12 pipelines load; `pnpm check` is green.

## Risks

- Copy time and disk use on large repos — acceptable for a personal tool, stated rather than
  optimized away.
- Codex must be installed and authenticated for V3b/V6 (codex-cli 0.152.1 is present on the dev
  machine); Node 22 via nvm.
- The permission-profile API is documented but version-specific (verified on 0.152.1 only); V3a is
  the regression guard.
- A `deny` entry on `/` aborts the sandboxed process (SIGABRT 134, dyld) — the deny-set builder must
  never emit it.
- V2 must plant `.env`/`.ENV` in a case-sensitive fixture, or drop one of the pair — APFS is
  case-insensitive by default.

## Follow-ups

- Write on codex: an `extends=":workspace"` profile composed on a writable copy, plus diff-back.
- Api transport tool loop (Mastra-native tools with in-process deny).
- Unify the Claude adapter onto the sanitized copy if the deny flags ever regress.
- Bindings A/C decisions: A bypasses step permissions by its own header — security decision pending;
  C needs an ADR superseding 0013's supersession.
- A container adapter (ADR-0007) as the provider-agnostic confinement for any CLI agent.

## Verification log (2026-09-13)

- **V1.** Golden argv captured before the adapter extraction and before the `allow` deletion;
  byte-identical after both (fixture sha1 `193ec7f665c25f230f7f6a4e9db77d6c07d8cfc2`).
- **V2.** Sanitizer unit tests green, including the case-sensitivity guard for `.env`/`.ENV`.
- **V3a.** `codex sandbox` integration ran live on codex-cli 0.152.1: read inside the grant ok;
  outside marker, `/Library` and `/opt/homebrew/etc` denied ("Operation not permitted"); write
  denied; the deny-map-less control leaks the outside marker.
- **V3b.** Reviewer probe through the real adapter: inside marker read, outside "Operation not
  permitted", a planted `.env` absent from the copy, the copy removed on both success and throw.
- **V3c.** Carried from the 2026-09-13 Claude `Grep(...)` deny probe (CLI 2.1.270).
- **V4 / V5 / V7.** Run-start refusals, the 12 × 3 matrix snapshot, and the `allow` removal green as
  unit and snapshot tests, with no model calls.
- **V6.** `code-review-citations` under `AGENT_FLOWS_PROVIDER=openai`
  `AGENT_FLOWS_CODEX_MODEL=gpt-5.6-luna`: EVAL PASSED in 177.9s, verdictAccuracy 100%, misrouted 0;
  three conditionals were not raised (inconclusive, not failures); four sanitized copies were
  materialized, each skipping 2 denied files.
- The live preflight test passed with `AGENT_FLOWS_LIVE_TESTS=1` (no trusted-directory refusal).
- Review found and closed a supervision hole: `timeoutMs: 0` disabled the deadline on codex/api;
  mutation (k) turns 3 tests red and the suite exit code to 1.
