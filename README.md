# agent-flows

A modular, TypeScript workflow-control harness for LLM-driven software development.

agent-flows turns a request into a **hardened spec** through an adversarial pipeline: intake → enrichment → parallel criticism and security review → assembly → approval gate → persisted ticket. Pipelines are defined once as provider-neutral data (YAML + prompt files) and executed by thin bindings to Claude, Mastra, or other runtimes.

## Getting started

agent-flows installs once per machine as a global npm package, registers itself with your MCP-capable chats (Claude Code, Codex CLI, OpenCode — T3 Code inherits whichever of those it runs), and reaches every project through a per-project daemon it starts on demand. By the end of this section you'll have run your first pipeline and seen how gates work.

### Install agent-flows

```sh
pnpm install && pnpm build
npm pack
nvm use 22 && npm i -g --prefix ~/.local ./rubakas-agent-flows-0.1.0.tgz
```

Node 22 is required for the install itself: the native `better-sqlite3` module is compiled against whichever Node ran the install. After that, the command works fine under an older default Node — `bin/agent-flows` re-execs itself under a Node that can actually load the database module, proving that by loading it rather than by comparing version numbers, since a newer Node also fails to load a module built for a different one.

**The trap:** npm's global prefix follows whichever Node is currently active, so installing without pinning `--prefix` can put the `agent-flows` command somewhere that isn't on your PATH. Pick a prefix once (`~/.local` above) and keep using it.

To remove the package: run `agent-flows uninstall` **first**, while the command still exists, then `npm rm -g --prefix ~/.local @rubakas/agent-flows`. Skipping the removal step first leaves every harness with a registration pointing at a binary that no longer exists.

`agent-flows uninstall` always unregisters the MCP server from every harness — that is what the verb means — and then asks two questions, each of which keeps your data unless you answer an explicit yes:

- **Delete the personal workflow library** (`~/.agent-flows/workflows`)? It names the path and how many workflows are in it. Workflows committed inside a repository are never touched by this: they live in the repository, not here.
- **Delete the per-project state** (`~/.agent-flows/projects`)? This is the databases and the whole run history, it names how many projects are there, and it cannot be undone. Any daemon still running is stopped first; a project whose daemon cannot be identified and stopped keeps its state, and the run says which and why.

A bare newline keeps both. When standard input is not a terminal — a piped or scripted run — nothing is asked and nothing is deleted; the paths that were left behind are printed instead, so a script that wants them gone can remove them itself. There is no flag to force it.

**Developing agent-flows itself** (working on this repository, not using it on another one): a symlink to `bin/agent-flows` also works, but the launcher runs the compiled `dist/` output — run `pnpm build` after every source change, or the symlinked command keeps running the old code. This repository's own `.mcp.json` takes a separate path: it registers `scripts/mcp-serve.sh`, which runs the checkout's source directly under `tsx`, with no build step needed.

### Register agent-flows with your chat

```sh
agent-flows install
```

This registers the `agent-flows` MCP server with Claude Code and Codex CLI through their own `mcp add` commands, and with OpenCode by a targeted edit of `~/.config/opencode/opencode.json` (OpenCode's non-interactive `mcp add` form isn't documented, so `install` writes the `mcp["agent-flows"]` key directly, after a one-time backup, and refuses if your OpenCode config actually lives in `opencode.jsonc` or `config.json`). T3 Code needs nothing of its own — it runs one of the other three harnesses and inherits that harness's configuration. `install` registers this tool with your chats and nothing more: it installs no package and copies no workflow anywhere.

Running `install` again makes no further changes; it reports "already-registered" for each harness it already touched. `agent-flows uninstall` reverses exactly what it wrote — only the entries it created — leaving every other key and the file's own formatting untouched. Neither verb takes any arguments.

This is the entire footprint: agent-flows registers an MCP server and nothing else. It never writes a skill, an agent, a rule, or a settings file into any harness's directory — that belongs to a separate tool (`agent-notes`), which already distributes those to the same four harnesses and registers no MCP server of its own.

The chat tools become available the next time you open a session in a registered harness:

- `decide_entry_point` — call this first with the user's request; it names the pipeline to run and why
- `list_pipelines` — see every pipeline this project can run and its inputs
- `run_pipeline` — start a workflow with a request and inputs
- `approve` — make a gate decision (approve or reject, with an optional reason)
- `get_run` — check the status of a running workflow, including per-step progress
- `cancel_run` — stop an in-flight workflow, killing whatever step is running

You do not need to restart the chat after editing a pipeline file; changes are picked up on the next call.

### Workflows: three layers, no install step

Every bundled workflow is already present in every project — there is no per-project install step. What a project can run is the merge of three layers, a later one winning a same-id collision:

1. **bundled** — shipped inside the package, always present, read-only;
2. **your personal library** — `workflows/` under the state directory (`~/.agent-flows/workflows` by default), machine-wide;
3. **your repository's own canon** — `<your-repo>/.agent-flows/`, committed and shared with your team.

Each layer holds its own `pipelines/` and `prompts/`; a workflow's prompts always come from the layer that owns it. A workflow nested inside another (as a `pipeline` or `loop` step) still resolves across all three layers, so a copy you fork into your repo keeps mounting whichever children it already mounted, wherever they live.

See what's available and which layer owns each id:

```sh
cd <path-to-your-repo> && agent-flows list
```

There is nothing to install to start editing — you fork instead:

```sh
agent-flows fork cycle-dev              # repo canon if the project has one, else your personal library
agent-flows fork cycle-dev --to user    # explicit target
agent-flows fork cycle-dev --to repo
```

`fork` copies exactly that workflow's own YAML and prompt files — not the other workflows it mounts, since those keep resolving across layers — into the target layer, and refuses to overwrite an existing copy unless you pass `--overwrite`. The installed package itself is never a write target.

To declutter the chat listing without deleting or disabling anything:

```sh
agent-flows enable cycle-dev
agent-flows disable cycle-dev
```

Hiding removes a workflow from `list_pipelines` and the page's workflow list only. A hidden workflow still runs when you name it directly, and still runs when another workflow mounts it as a step — hiding is decluttering, not access control.

Moving a workflow to another machine or layer is export and import (`GET /api/export/:id`, `POST /api/import` on the daemon's page) — there is no CLI verb for it yet.

### Start the daemon

The chat tools don't execute anything themselves; they talk to a per-project HTTP daemon that coordinates runs, keeps state, and reports back. You usually don't have to start it yourself: the first chat tool call in a project finds this project's daemon by a per-project identity record and a `GET /api/daemon` handshake, and starts one on an unused port when none matches — a daemon belonging to a different project or a different agent-flows version is never reused and never killed, so a chat in one repository can never end up running steps against another. That first call can take a few seconds while the daemon comes up.

To start it yourself — useful for watching the web page — run it from your project directory:

```sh
cd <path-to-your-repo> && agent-flows serve
```

(You can also set `AGENT_FLOWS_PROJECT_DIR` to override the target.) This starts an HTTP server on port 7411 by default. Set `AGENT_FLOWS_PORT=<port>` to change it; `--port <port>` on the command line overrides that. An auto-started daemon always takes an ephemeral port instead, so it never collides with one you started by hand.

The daemon serves a web page at `http://127.0.0.1:7411` showing active runs and available workflows; a running run can be stopped there with its **Cancel run** button. On a run's page each step has an **Activity** block showing its tool calls, messages and check output as they happen, a **Decisions** table listing every gate and judge verdict, and an **Output** block with the step's full output. **Workflows** lists every workflow across all three layers, tagging each row with its owning layer and marking one that shadows a same-id workflow in an earlier layer; **Edit** on a row the project can't write (a bundled one) forks it into a writable layer first and edits the copy, and each row's Hide/Show toggle is the same visibility list `agent-flows enable`/`disable` edit. **Templates** shows the bundled catalogue plus the templates you've saved yourself; importing from either writes into your repository's `.agent-flows/` canon. Leave the daemon running while you work; stop it with `agent-flows stop` (or `agent-flows stop --all` for every project's) when you're done. The external-editor integration this page once carried was retired (ADR-0017); the daemon is the only executor.

**Why the daemon?** The chat, the HTTP API, and the web page all share a single run registry. The daemon is the source of truth for run state, allowing you to start a workflow in the chat, check its status from the HTTP API, and resume it from the web page—all without losing track of what is running.

### Where agent-flows keeps files

agent-flows splits what your teammates need from what only this machine produced.

| Location                                                                           | Contents                                                                                                           | Versioned?                          |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------- |
| `<your-repo>/.agent-flows/pipelines/`, `prompts/`, `providers.yaml`, `config.json` | The repository layer — workflows you forked or created here                                                        | Yes — commit them                   |
| `~/.agent-flows/workflows/pipelines/`, `prompts/`                                  | Your personal, machine-wide layer — workflows you forked here follow you across projects                           | No — machine-local                  |
| `~/.agent-flows/projects/<key>/`                                                   | `runs/` (artifacts and manifests), `agent-flows.sqlite`, `agent-flows-mastra.db`, `daemon.json`, `visibility.json` | No — machine-local, never committed |
| `~/.agent-flows/templates/`                                                        | Global saved-template store (separate from the personal workflow layer above)                                      | No — global to this machine         |

Inside one run directory (`runs/<runId>/`), beside the `<pipelineId>.json` artifact:

- `<pipelineId>.events.jsonl` — the ordered step log, appended while the run is in flight.
- `<pipelineId>.outputs/<stepId>.json` — each llm step's full output, not just the excerpt.

`<key>` is the absolute real path of your project directory with every character
outside `[A-Za-z0-9_-]` replaced by `-` (truncated to 200 characters plus an
8-character hash when longer), so two checkouts of the same repository keep
separate state.

- `AGENT_FLOWS_HOME` moves the whole state root somewhere other than `~/.agent-flows`.
- `AGENT_FLOWS_PROJECT_KEY` pins the key, e.g. to share one state directory across worktrees.

If a previous version left run artifacts in `<your-repo>/.agent-flows/runs/`, the
daemon copies them into the state directory once on start and prints a notice
naming both paths. The old directory is never deleted or modified — remove it by
hand when you are satisfied with the copy.

agent-flows never edits your `.gitignore`.

### Checking your install

```sh
agent-flows doctor
```

Reports, per harness (Claude Code, Codex CLI, OpenCode, T3 Code), whether its binary is on PATH, whether `agent-flows` is registered with it, and whether that registration is stale (its command no longer resolves — the sign of a package removal that skipped `agent-flows uninstall`); whether this project's daemon is listening; and whether `better-sqlite3` matches the running Node's ABI, with a hint to reinstall the package rather than rebuild it.

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
cd <path-to-your-repo> && agent-flows generate claude   # writes <your-repo>/.claude/workflows/*.js
```

This creates native Claude Code workflows from the bundled pipelines, written into your project directory (`AGENT_FLOWS_PROJECT_DIR` or cwd), never into the installed package. They can execute `llm` and `assemble-spec` steps, but not gates, checks, loops, or other advanced step types. Any pipeline using those kinds is refused at generation time (no file is written). The native path is simpler but has narrower coverage; use the MCP path (above) for full pipeline support.

**Important:** Per-step `permissions.contents` declared in your pipeline are NOT enforced by the native binding—each step runs with your current session's access level. The MCP path enforces these boundaries.

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

- **Provider-neutral canon** — `pipelines/*.yaml` + `prompts/*.md` + loader (`src/canon/`); schema includes llm, gate, assemble-spec, persist-ticket, check, loop, pipeline, export-spec; step ordering is explicit via `dependsOn` edges (ADR-0014), compiled to parallel levels. A step may declare `permissions: { contents: read }` to run its agent read-only in the project directory (follows the GitHub Actions `permissions:` convention); `permissions` replaces the deprecated `workspace` key. LLM steps may declare `skills` to invoke named Agent Skills. Hardening is unconditional: every claude CLI invocation gets `--restricted --strict-mcp-config`. Check steps run shell commands with an allowlist-controlled environment (`PATH`, `HOME`, `SHELL`, `TMPDIR`, `LANG`, and any vars declared via the step's `env` field). Workflows resolve from three merged layers — bundled (the package), personal (`~/.agent-flows/workflows/`), and repository (`<project>/.agent-flows/`) — a later layer winning an id collision; `agent-flows fork` copies a workflow into a writable layer to edit it (ADR-0018, spec 038 D13/D14). Audit runs inside the build pipeline (`build.yaml`) after the converge loop, not as a separate top-level workflow, and a required verification of the project's own check command runs after the audit — a build run only succeeds if it passes.
- **Binding A** — Claude Code dynamic workflow generator (`.claude/workflows/*.js`, generated via `agent-flows generate claude`); approval gates happen in chat between runs; subscription-billed; exit path is Binding B.
  - **Implements:** `llm` steps (sequential and parallel, with `skills` and `schema` support) and `assemble-spec` steps.
  - **Does not implement:** `gate`, `check`, `loop`, `persist-ticket`, `export-spec`, or nested `pipeline` steps. A pipeline containing any of these kinds is refused at generation time (no file is written; any stale artifact is deleted). Use Binding B for full pipeline coverage.
  - **Permissions not enforced:** per-step `permissions.contents` declared in the canon is not passed through to the Claude Code `agent()` API (which has no permission-restriction option). Every step runs with the host session's access level. A notice comment is emitted at the top of every generated file.
- **Binding B** — Mastra interpreter + MCP server (Apache-2.0); durable suspend/resume HITL; steps execute via the open model registry (`agent-flows mcp` starts the server; `pnpm mastra:smoke` runs standalone).
- **Model registry** — open; CLI aliases + passthrough of any model id; local `claude`/`codex` CLIs on subscription auth, Ollama local models, keyed APIs via LiteLLM.
- **SQLite ticket store** — pipeline source of truth (better-sqlite3 + Drizzle); persisted by the `persist-ticket` step in each pipeline run.
- **Layer-0 key isolation** — agent-flows process environment holds no real provider keys; LLM child processes (claude CLI) receive a scrubbed environment with credential keys removed; check step child processes receive only the allowlisted base env plus any vars explicitly declared on the step (Charter invariant).

**Planned, not yet built:**

- `verify-plan` and `correct-plan` workflows — named in ADR-0015 as the plan-verification and correction stages of the SDLC pipeline; no pipeline YAML files for these stages exist yet.

## Current direction

**One canonical pipeline definition, many execution backends.** Chat-first operation via any MCP-capable client (Claude Code, Codex, or other). The same canon (provider-neutral YAML + prompts) runs unchanged against any configured model provider — swapping providers is a registry edit, not a code change (ADR-0011, ADR-0012). Provider portability is an acceptance criterion, enforced by smoke-testing the same pipeline under at least two independent bindings.

**The editor is the daemon's own page.** The third-party workflow-editor hybrid adopted on 2026-09-04 was retired on 2026-09-14 (ADR-0017): its export covered 8 of 12 pipelines, its community node bypassed the daemon's confinement and run records, and every one of its surfaces was a second representation of the canon to keep in sync. The daemon is the only executor and its web page (`src/serve/`) is the catalogue, the editor and the run monitor — it lists every workflow across the three merged layers (ADR-0018, spec 038 D13), supports creation from templates (shipped and user-saved), edits a workflow with validation before any file is written (forking a bundled one into a writable layer first), shows active runs with their status, streams each step's activity live, and provides approval controls for gates. This resumes the direction of ADR-0013.

Current milestone: [`specs/038-global-package-and-harness-reach`](specs/038-global-package-and-harness-reach/spec.md) — global package and harness reach. Ships 1–4 (real package, reachable-by-default daemon, three-layer workflows, `install`/`uninstall`/`stop`/`doctor`) are implemented; Ship 5 is this documentation. Still outstanding: a live multi-harness proof and the developer page's visual pass (both owner-verified, not yet run). Investigation pipeline reading via `permissions: { contents: read }` is done. [`specs/013-provider-portable-templates`](specs/013-provider-portable-templates/spec.md) is built; [`specs/014-critical-gaps`](specs/014-critical-gaps/spec.md) holds the remaining Charter gaps.

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
- [0013. A visual editor meets the Charter's bar](docs/decisions/0013-visual-editor-meets-the-bar.md) (superseded 2026-09-04, resumed by ADR-0017)
- [0014. Canon topology: explicit edges](docs/decisions/0014-canon-topology-explicit-edges.md)
- [0015. The SDLC is a library of composable workflows](docs/decisions/0015-sdlc-as-composable-workflows.md)
- [0016. Prompt authoring: portable core in the canon, model-conditional knobs in bindings](docs/decisions/0016-prompt-authoring-convention.md)
- [0017. Retire the workflow-editor hybrid](docs/decisions/0017-retire-the-workflow-editor-hybrid.md)
- [0018. One global install, harnesses hold pointers](docs/decisions/0018-one-global-install-harnesses-hold-pointers.md)

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
