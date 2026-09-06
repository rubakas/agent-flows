# agent-flows

A modular, TypeScript workflow-control harness for LLM-driven software development.

agent-flows turns a request into a **hardened spec** through an adversarial pipeline: intake → enrichment → parallel criticism and security review → assembly → approval gate → persisted ticket. Pipelines are defined once as provider-neutral data (YAML + prompt files) and executed by thin bindings to Claude, Mastra, or other runtimes.

## Charter

**What agent-flows is.** A harness for building, editing and running dynamic workflows for
LLM-assisted software development. Workflows, steps, skills and agents are provider-neutral
templates stored as data. The same template runs against whichever model providers are
currently active.

**The goal.** One canonical definition, many execution backends. A workflow authored once
runs unchanged when the underlying provider changes — swapping providers is a registry edit,
not a rewrite.

**Operating surface.** Chat and a local editor. Templates are files; creating and editing them is
a chat and file operation (ADR-0011). Since ADR-0013 a visual editor is part of the product rather
than deferred: it is a web page served by a loopback-only local process, it writes the same files
chat writes, and it opens in whichever window the operator already has — Claude Code's browser
pane, T3 Code's desktop Browser panel, or an ordinary browser.

**Rules** (invariants, not preferences):

1. Provider portability is an acceptance criterion, not a feature — the same pipeline must
   run under at least two independent providers.
2. Layer-0 key isolation — no provider API keys in the agent-flows process environment; child
   processes receive a scrubbed environment (ADR-0004).
3. The canon stays provider-neutral; anything harness-specific lives in a binding
   (ADR-0011).
4. One self-nesting `pipeline`; the leaf is `step`; the term "Action" is not used
   (ADR-0012).
5. No speculative abstraction — a layer appears when a second real consumer needs it.
6. Documentation is ADRs, lean specs and the code itself. No large design documents.
7. Anthropic-first is a current experiment, not an architectural commitment.

## Quick start

**Prerequisites (cannot be auto-installed):**

- Node ≥ 22: `nvm install 22` (`.nvmrc` pins the version)
- `claude` CLI installed and logged in: see https://docs.claude.com/en/docs/claude-code, then `claude auth login`

**Validate and generate:**

```sh
pnpm canon:check              # validate pipeline definitions
pnpm bindings:claude          # generate Claude Code workflow into .claude/workflows/
```

**Start the MCP server (via chat client):**

`.mcp.json` at the repo root wires the server into any MCP-capable client (Claude Code, VS Code with MCP, etc.). Open the repo in your client — it picks up the server automatically.

Manual workflow from the client:

1. Call `list_pipelines` to see available pipelines.
2. Call `run_pipeline` with `pipeline` and `inputs` to start a run.
3. If the run returns `status: "awaiting_approval"`, review the spec and call `approve` with the `runId`.
4. Call `get_run` at any time to check status.

**Switching providers:** edit the `AGENT_FLOWS_PROVIDER` value in `.mcp.json` (`anthropic` → `openai` or `local`) and restart the client. No pipeline or prompt changes needed.

```sh
pnpm mcp                      # also launchable standalone (stdio, for testing)
```

**Generate an n8n workflow (Binding C) and run it in n8n:**

```sh
pnpm bindings:n8n             # generate .n8n-workflows/*.json from the canon
```

Install the typed node so both the n8n editor and CLI load it — copy the built
`integrations/n8n-nodes-agent-flows` into `<N8N_USER_FOLDER>/.n8n/nodes/node_modules/`, then import the
generated workflow. See `integrations/n8n-nodes-agent-flows/README.md`.

**Node version:** everything requires Node ≥ 22 (`better-sqlite3` is built for it). If your shell
defaults to an older node, `scripts/dev-serve.sh` and `scripts/mcp-serve.sh` force Node 22 via nvm —
`.claude/launch.json` and `.mcp.json` invoke them, so the daemon and MCP server start correctly
regardless of the ambient node.

**Run the pipeline end-to-end (standalone):**

```sh
pnpm mastra:smoke             # execute pipeline with test input
pnpm mastra:smoke --db ./custom.sqlite --intake-model opus  # with flags
```

**Preflight check:**

```sh
pnpm run doctor               # verify all prerequisites; fix hints for each missing item
```

---

## Status

**Built (ready to use):**

- **Provider-neutral canon** — `pipelines/*.yaml` + `prompts/*.md` + loader (`src/canon/`); schema includes llm, gate, assemble-spec, persist-ticket, check, loop, pipeline, export-spec; step ordering is explicit via `dependsOn` edges (ADR-0014), compiled to parallel levels. A step may declare `permissions: { contents: read }` to run its agent read-only in the project directory (follows the GitHub Actions `permissions:` convention); `permissions` replaces the deprecated `workspace` key. LLM steps may declare `skills` to invoke named Agent Skills. Hardening is unconditional: every claude CLI invocation gets `--restricted --strict-mcp-config`. Check steps run shell commands with an allowlist-controlled environment (`PATH`, `HOME`, `SHELL`, `TMPDIR`, `LANG`, and any vars declared via the step's `env` field). Pipelines install into `<project>/.agent-flows/` via `pnpm agent-flows install`. Audit runs inside the build pipeline (`build.yaml`) after the converge loop, not as a separate top-level workflow.
- **Binding A** — Claude Code dynamic workflow generator (`.claude/workflows/*.js`, generated via `pnpm bindings:claude`); approval gates happen in chat between runs; subscription-billed; exit path is Binding B.
- **Binding B** — Mastra interpreter + MCP server (Apache-2.0); durable suspend/resume HITL; steps execute via the open model registry (`pnpm mcp` starts the server; `pnpm mastra:smoke` runs standalone).
- **Binding C** — n8n workflow generator (`.n8n-workflows/*.json`, generated via `pnpm bindings:n8n`); the canon compiles to an n8n workflow whose llm steps reference the installable `n8n-nodes-agent-flows.agentFlowsAgent` community node (`integrations/n8n-nodes-agent-flows/`). n8n provides the visual editor and execution surface; the canon stays the git-backed source.
- **Model registry** — open; CLI aliases + passthrough of any model id; local `claude`/`codex` CLIs on subscription auth, Ollama local models, keyed APIs via LiteLLM.
- **SQLite ticket store** — pipeline source of truth (better-sqlite3 + Drizzle); persisted by the `persist-ticket` step in each pipeline run.
- **Layer-0 key isolation** — agent-flows process environment holds no real provider keys; LLM child processes (claude CLI) receive a scrubbed environment with credential keys removed; check step child processes receive only the allowlisted base env plus any vars explicitly declared on the step (Charter invariant).

**Planned, not yet built:**

- `verify-plan` and `correct-plan` workflows — named in ADR-0015 as the plan-verification and correction stages of the SDLC pipeline; no pipeline YAML files for these stages exist yet.

## Current direction

**One canonical pipeline definition, many execution backends.** Chat-first operation via any MCP-capable client (Claude Code, Codex, or other). The same canon (provider-neutral YAML + prompts) runs unchanged against any configured model provider — swapping providers is a registry edit, not a code change (ADR-0011, ADR-0012). Provider portability is an acceptance criterion, enforced by smoke-testing the same pipeline under at least two independent bindings.

**The visual editor is n8n, not a agent-flows-built one** (evaluated live 2026-09-04; see `docs/research/2026-09-04-n8n-spike.md` and `docs/research/2026-09-04-n8n-and-alternatives.md`). Rebuilding a node editor — the canvas is only a library (n8n uses Vue Flow); the forms, modals, inspector and execution UI are years of work — is not worth it for a private tool. Instead the canon compiles to n8n via Binding C, and the typed coding-agent step ships as an installable n8n node. n8n gives the editor and runtime for free; agent-flows keeps the git-backed canon, the provider-neutral role→model registry, and the typed repo-access grounding (`permissions.contents`) that n8n has no concept of. The earlier direction — a agent-flows-served DAG editor (ADR-0013, spec 015) — is superseded by this hybrid; the level-band web editor built under it (`src/serve/`) remains but is no longer the plan.

Current milestone: land the hybrid — Binding C (built), the `n8n-nodes-agent-flows` node package (built), and wiring the investigation pipeline to read the repo (`permissions: { contents: read }`). [`specs/013-provider-portable-templates`](specs/013-provider-portable-templates/spec.md) is built; [`specs/014-critical-gaps`](specs/014-critical-gaps/spec.md) holds the remaining Charter gaps.

### Architecture & Design Record

**Architecture Decisions (ADRs):**

- [0001. Base runtime: Pi](docs/decisions/0001-base-runtime-pi.md) (superseded by ADR-0011)
- [0002. Single kernel per node](docs/decisions/0002-single-kernel-per-node.md)
- [0003. Spec = git-backed SDD artifact](docs/decisions/0003-spec-is-git-backed-sdd.md)
- [0004. Supply-chain security posture](docs/decisions/0004-supply-chain-security-posture.md)
- [0005. TypeScript substrate](docs/decisions/0005-ts-substrate.md)
- [0006. Stage-2 executor: real Claude Code via pi-claude-cli](docs/decisions/0006-stage2-real-claude-code.md) (superseded by ADR-0011)
- [0007. Deployment: containerized nodes + headless server + remote attach](docs/decisions/0007-deployment-containerized-nodes.md)
- [0008. Linting and Formatting Toolchain](docs/decisions/0008-linting-and-formatting.md)
- [0009. MVP Telemetry: JSONL Sink](docs/decisions/0009-telemetry-jsonl-sink-mvp.md) (superseded by ADR-0011)
- [0010. Orchestrator Transport: HTTP + SSE](docs/decisions/0010-orchestrator-transport-http-sse.md) (superseded by ADR-0011)
- [0011. Chat-first canon and bindings](docs/decisions/0011-chat-first-canon-and-bindings.md)
- [0012. Canon ontology: single-nesting pipeline](docs/decisions/0012-canon-ontology-single-nesting-pipeline.md) (topology rule amended by ADR-0014)
- [0013. A visual editor meets the Charter's bar](docs/decisions/0013-visual-editor-meets-the-bar.md)
- [0014. Canon topology: explicit edges](docs/decisions/0014-canon-topology-explicit-edges.md)
- [0015. The SDLC is a library of composable workflows](docs/decisions/0015-sdlc-as-composable-workflows.md)
- [0016. Prompt authoring: portable core in the canon, model-conditional knobs in bindings](docs/decisions/0016-prompt-authoring-convention.md)

**Hardened Specs (per-feature):**
See [`specs/`](specs/) for the full set: stage1-hardening, module-system, tracker-provider, executor, stage2-development, stage3-testing, stage4-audit, orchestrator-server, observability.

## Development

**Prerequisites:** Node ≥ 22, pnpm, Docker (Compose v2), `claude` CLI, `gh` (authenticated).

> Exact dependency versions pin on first `pnpm install` via `.npmrc save-exact`. The resulting `pnpm-lock.yaml` is committed and must be kept in sync.

```sh
# 1. Configure environment
cp .env.example .env          # fill in LITELLM_MASTER_KEY, LITELLM_VIRTUAL_KEY, GH_TOKEN

# 2. Start the stack (LiteLLM proxy + Postgres + Phoenix)
docker compose up -d postgres litellm phoenix

# 3. Install dependencies (pins exact versions, no lifecycle scripts)
pnpm install

# 4. Generate and apply DB migrations
pnpm db:generate && pnpm db:migrate
```

**Quality gates** (run before commit):

```sh
pnpm lint          # ESLint + typescript-eslint (type-checked)
pnpm format:check  # Prettier
pnpm typecheck     # TypeScript
pnpm test          # node:test suite
```
