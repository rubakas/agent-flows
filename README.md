# agent-flows

A modular, TypeScript workflow-control harness for LLM-driven software development.

agent-flows turns a request into a **hardened spec** through an adversarial pipeline: intake → enrichment → parallel criticism and security review → assembly → approval gate → persisted ticket. Pipelines are defined once as provider-neutral data (YAML + prompt files) and executed by thin bindings to Claude, Mastra, or other runtimes.

## Getting started with your repository

If you use an MCP-capable chat (like Claude Code or Codex) and want to put your day-to-day development workflow into a repeatable flow, this is where you start. You'll install agent-flows itself, point it at your repository, and use it from the chat. By the end of this section you'll have run your first pipeline and seen how gates work.

### Prerequisites

You need three things. The first two are JavaScript tools; the third is the Claude CLI.

- **Node ≥ 22** (required for native dependency `better-sqlite3`, which is compiled for Node 22's ABI). If you use nvm, `nvm install 22` and `nvm use 22`. You can check your current version with `node --version`.
- **pnpm 10.15.0+** (auto-enabled through corepack when you run `pnpm` for the first time in an agent-flows repo). If you don't have pnpm installed, follow https://pnpm.io/installation.
- **Claude CLI installed and logged in.** Install it from https://docs.claude.com/en/docs/claude-code, then use `claude auth` to authenticate.

### Bootstrap agent-flows

First, check that your setup is complete:

```sh
git clone <agent-flows-repo-url>
cd agent-flows
pnpm bootstrap
```

This command checks Node 22, enables pnpm, installs dependencies, validates the `better-sqlite3` native module, and builds the project. It ends with a preflight check (`agent-flows doctor`) that confirms the Claude CLI is available.

If any step fails, `agent-flows doctor` will tell you exactly what is missing and how to fix it.

### Point agent-flows at your repository

agent-flows is provider-neutral; it needs to know which repository to run workflows against. You control this with the `AGENT_FLOWS_PROJECT_DIR` environment variable.

First, see what workflows are available:

```sh
cd <path-to-your-repo> && agent-flows list
```

This lists every bundled workflow and shows whether it is already installed in your project. For example:

```
Project: /Users/you/code/your-repo

AVAILABLE WORKFLOWS:
  audit                [not installed]
  build                [not installed]
  build-round          [not installed]
  correct-plan         [not installed]
  cycle                [not installed]
  cycle-dev            [not installed]
  develop              [not installed]
  investigate          [not installed]
  ship                 [not installed]
  spec-creation        [not installed]
  test                 [not installed]
```

Now install the workflow(s) you want:

```sh
cd <path-to-your-repo> && agent-flows install cycle-dev
```

This command copies the `cycle-dev` workflow and all its dependencies into `<your-repo>/.agent-flows/`. The files are yours to edit—that's the entire point. If you install `cycle-dev`, you will NOT get `ship`, because `ship` is not part of that chain; your installed workflow cannot commit or open a pull request.

Once you have at least one pipeline file in `<your-repo>/.agent-flows/pipelines/`, that directory takes precedence over the bundled pipelines. You can edit your copies without affecting the agent-flows source.

### Start the daemon

Before you use the workflow from the chat, the daemon must be running. The chat tools do not execute anything themselves; they send requests to this daemon, which coordinates the run, manages state, and reports back. If the daemon is not running, every chat tool call fails immediately.

Open a new terminal (or terminal tab) and run:

```sh
cd <path-to-your-repo> && agent-flows serve
```

Run this from your project directory — `agent-flows serve` uses cwd as the project directory by default. (You can also set `AGENT_FLOWS_PROJECT_DIR` to override the target, but running from the project directory is simpler.)

This starts an HTTP server on port 7411 (override with `AGENT_FLOWS_PORT=<port>`). The daemon stays running and serves a web page at `http://127.0.0.1:7411` showing active runs and available workflows. Leave this terminal open while you work.

**Why the daemon?** The chat, the HTTP API, and the web page all share a single run registry. The daemon is the source of truth for run state, allowing you to start a workflow in the chat, check its status from the HTTP API, and resume it from the web page—all without losing track of what is running.

### Wire the chat

Register the agent-flows MCP server in your repository's MCP configuration. Create `.mcp.json` at your repository root — the same file this repository uses — and add:

```json
{
  "mcpServers": {
    "agent-flows": {
      "command": "bash",
      "args": ["/absolute/path/to/agent-flows/scripts/mcp-serve.sh"],
      "env": { "AGENT_FLOWS_PROVIDER": "anthropic" }
    }
  }
}
```

Replace `/absolute/path/to/agent-flows` with the actual path to your agent-flows checkout. The path must be absolute because the chat launches the script from your repository, not from the agent-flows checkout. That is also what aims the run: `scripts/mcp-serve.sh` records the directory it was launched in before it changes to the agent-flows root, so every pipeline step runs against your repository without you setting `AGENT_FLOWS_PROJECT_DIR` at all.

The chat tools become available immediately:

- `list_pipelines` — see every installed pipeline and its inputs
- `run_pipeline` — start a workflow with a request and inputs
- `approve` — make a gate decision (approve or reject the spec)
- `get_run` — check the status of a running workflow

If you open the agent-flows repository itself in your chat, you can use the `.mcp.json` already present there for working on agent-flows (not your own repository). You do not need to restart the chat after editing a pipeline file; changes are picked up on the next call.

### Worked example: running your first pipeline

Here's a real exchange with the chat to run a workflow end-to-end.

**You (in chat):**

```
List the pipelines available in my repo.
```

**Chat calls `list_pipelines`**, which returns:

```json
{
  "pipelines": [
    {
      "id": "cycle-dev",
      "description": "Full development lifecycle — investigate, plan, and build (stops before ship; no commit, no PR)",
      "inputs": ["request"]
    }
  ],
  "errors": []
}
```

The `inputs` array is a list of input names as declared in the pipeline YAML file; the `errors` array lists any pipeline files that failed to load.

**You:**

```
Run cycle-dev with this request: "Add a --dry-run flag to the deploy command".
```

**Chat calls `run_pipeline`** with:

```json
{
  "pipeline": "cycle-dev",
  "inputs": { "request": "Add a --dry-run flag to the deploy command" }
}
```

The workflow investigates the request, generates a plan, and builds the changes. If no gate is encountered, the workflow completes and returns the spec and build output. The `cycle-dev` pipeline suspends at the approval gate after spec assembly, waiting for your approval.

When the run hits a gate and suspends:

**Chat returns:**

```json
{
  "runId": "run-abc123",
  "status": "awaiting_approval",
  "gateMessage": "Approve this spec to proceed with the build?",
  "spec": { ... your assembled spec ... }
}
```

**You:**

```
Approve the spec.
```

**Chat calls `approve`** with:

```json
{
  "runId": "run-abc123",
  "approved": true
}
```

The workflow resumes, executes the build, and reports the final result.

**Why gates?** A gate is a decision point where a human reviews the spec (the request, the plan, the security review) before the workflow proceeds to implementation. This is the core strength of agent-flows: it produces a hardened spec that you review and approve before any code changes happen. No surprises.

### Two modes for gates

Gates can operate in two modes. The default is **manual**: the run suspends and waits for a human decision from the chat, HTTP API, or web page.

You can also use **auto mode**. When you start a run in auto mode, an independent LLM judge evaluates each gate and answers on your behalf. If the judge fails, the run falls back to waiting for you. The decision is recorded as made by an agent, not a human. Try this when you are iterating quickly and trust the judge to catch obvious failures.

To run in auto mode:

```json
{
  "pipeline": "cycle-dev",
  "inputs": { "request": "..." },
  "gateMode": "auto"
}
```

Some gates (like the final approval before `ship` commits real code) are pinned to manual mode and cannot be automated. These are declared with `manualOnly: true` in the pipeline.

### What you cannot do yet

- **No cancel outside gates:** The web page has a "Reject (terminates run)" button for runs waiting at an approval gate. There is no way to cancel a run that is not currently suspended at a gate. A runaway run ends when the daemon stops.
- **No persistence across restarts:** Runs live in the daemon's memory. If the daemon restarts, all active runs are lost.
- **No rejection reason:** When you reject a gate, the system records only `approved: false`. There is no field for why you rejected it.

---

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

The section above covers the primary path: running workflows from your MCP-capable chat. These sections cover alternative execution methods.

### Generate Claude Code workflows

If you prefer to run workflows as native Claude Code JavaScript files instead of through the MCP server, you can generate them:

```sh
agent-flows generate claude   # generate .claude/workflows/*.js
```

This creates native Claude Code workflows. They can execute `llm` and `assemble-spec` steps, but not gates, checks, loops, or other advanced step types. Any pipeline using those kinds is refused at generation time (no file is written). The native path is simpler but has narrower coverage; use the MCP path (above) for full pipeline support.

**Important:** Per-step `permissions.contents` declared in your pipeline are NOT enforced by the native binding—each step runs with your current session's access level. The MCP path enforces these boundaries.

### Generate n8n workflows

To author and run workflows in n8n (the visual editor):

```sh
agent-flows generate n8n      # generate .n8n-workflows/*.json from the canon
```

Install the typed agent node into n8n: copy the built `integrations/n8n-nodes-agent-flows` into `<N8N_USER_FOLDER>/.n8n/nodes/node_modules/`, then import the generated workflow. See `integrations/n8n-nodes-agent-flows/README.md` for details.

To connect agent-flows to your n8n instance, use the web UI's **Connect n8n** action in the header. It opens a form for your base URL (http or https) and API key. The credentials are stored in `~/.agent-flows/n8n.json` with permissions 0600, outside the project directory so they cannot be committed. Environment variables `AGENT_FLOWS_N8N_URL` and `AGENT_FLOWS_N8N_API_KEY` take priority if set. Before connecting, per-workflow "Edit in n8n" buttons are dimmed; clicking them opens the connect form.

### Run a pipeline standalone

To execute a pipeline outside the chat or web UI (for testing or CI):

```sh
pnpm mastra:smoke             # execute with default test input
pnpm mastra:smoke --db ./custom.sqlite --intake-model opus  # with custom flags
```

### Verify prerequisites

Run the preflight check at any time:

```sh
agent-flows doctor            # verify all prerequisites; lists missing items with fix hints
```

---

## Status

**Built (ready to use):**

- **Provider-neutral canon** — `pipelines/*.yaml` + `prompts/*.md` + loader (`src/canon/`); schema includes llm, gate, assemble-spec, persist-ticket, check, loop, pipeline, export-spec; step ordering is explicit via `dependsOn` edges (ADR-0014), compiled to parallel levels. A step may declare `permissions: { contents: read }` to run its agent read-only in the project directory (follows the GitHub Actions `permissions:` convention); `permissions` replaces the deprecated `workspace` key. LLM steps may declare `skills` to invoke named Agent Skills. Hardening is unconditional: every claude CLI invocation gets `--restricted --strict-mcp-config`. Check steps run shell commands with an allowlist-controlled environment (`PATH`, `HOME`, `SHELL`, `TMPDIR`, `LANG`, and any vars declared via the step's `env` field). Pipelines install into `<project>/.agent-flows/` via `agent-flows install`. Audit runs inside the build pipeline (`build.yaml`) after the converge loop, not as a separate top-level workflow.
- **Binding A** — Claude Code dynamic workflow generator (`.claude/workflows/*.js`, generated via `agent-flows generate claude`); approval gates happen in chat between runs; subscription-billed; exit path is Binding B.
  - **Implements:** `llm` steps (sequential and parallel, with `skills` and `schema` support) and `assemble-spec` steps.
  - **Does not implement:** `gate`, `check`, `loop`, `persist-ticket`, `export-spec`, or nested `pipeline` steps. A pipeline containing any of these kinds is refused at generation time (no file is written; any stale artifact is deleted). Use Binding B for full pipeline coverage.
  - **Permissions not enforced:** per-step `permissions.contents` declared in the canon is not passed through to the Claude Code `agent()` API (which has no permission-restriction option). Every step runs with the host session's access level. A notice comment is emitted at the top of every generated file.
- **Binding B** — Mastra interpreter + MCP server (Apache-2.0); durable suspend/resume HITL; steps execute via the open model registry (`agent-flows mcp` starts the server; `pnpm mastra:smoke` runs standalone).
- **Binding C** — n8n workflow generator (`.n8n-workflows/*.json`, generated via `agent-flows generate n8n`); the canon compiles to an n8n workflow whose llm steps reference the installable `n8n-nodes-agent-flows.agentFlowsAgent` community node (`integrations/n8n-nodes-agent-flows/`). n8n provides the visual editor and execution surface; the canon stays the git-backed source.
- **Model registry** — open; CLI aliases + passthrough of any model id; local `claude`/`codex` CLIs on subscription auth, Ollama local models, keyed APIs via LiteLLM.
- **SQLite ticket store** — pipeline source of truth (better-sqlite3 + Drizzle); persisted by the `persist-ticket` step in each pipeline run.
- **Layer-0 key isolation** — agent-flows process environment holds no real provider keys; LLM child processes (claude CLI) receive a scrubbed environment with credential keys removed; check step child processes receive only the allowlisted base env plus any vars explicitly declared on the step (Charter invariant).

**Planned, not yet built:**

- `verify-plan` and `correct-plan` workflows — named in ADR-0015 as the plan-verification and correction stages of the SDLC pipeline; no pipeline YAML files for these stages exist yet.

## Current direction

**One canonical pipeline definition, many execution backends.** Chat-first operation via any MCP-capable client (Claude Code, Codex, or other). The same canon (provider-neutral YAML + prompts) runs unchanged against any configured model provider — swapping providers is a registry edit, not a code change (ADR-0011, ADR-0012). Provider portability is an acceptance criterion, enforced by smoke-testing the same pipeline under at least two independent bindings.

**The visual editor is n8n, not a agent-flows-built one** (evaluated live 2026-09-04; see `docs/research/2026-09-04-n8n-spike.md` and `docs/research/2026-09-04-n8n-and-alternatives.md`). Rebuilding a node editor — the canvas is only a library (n8n uses Vue Flow); the forms, modals, inspector and execution UI are years of work — is not worth it for a private tool. Instead the canon compiles to n8n via Binding C, and the typed coding-agent step ships as an installable n8n node. n8n gives the editor and runtime for free; agent-flows keeps the git-backed canon, the provider-neutral role→model registry, and the typed repo-access grounding (`permissions.contents`) that n8n has no concept of. The agent-flows web UI (`src/serve/`) is a project inventory, library manager, and run monitor: it displays workflows in the project, enables viewing and deletion, supports creation from templates (both shipped and user-saved), shows active runs with their status, streams each step's status and output live, and provides approval controls for gates. n8n is the authoring surface — new workflows are created there, and existing workflows are edited there, with a link in the agent-flows UI redirecting to n8n. Workflows authored in n8n can be saved as global templates for later use in other projects. The UI is not an editor. This reflects a shift from the earlier direction of a agent-flows-served DAG editor (ADR-0013, spec 015).

Current milestone: Binding C (built; pending input interpolation per spec 021), `n8n-nodes-agent-flows` node package (built), and investigation pipeline reading via `permissions: { contents: read }` (done). The n8n round-trip and template library (spec 022) are specified but not yet built. [`specs/013-provider-portable-templates`](specs/013-provider-portable-templates/spec.md) is built; [`specs/014-critical-gaps`](specs/014-critical-gaps/spec.md) holds the remaining Charter gaps.

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
