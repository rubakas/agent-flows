# n8n and alternatives — for a private, coding-agent SDLC automation tool

Date: 2026-09-04. Every capability and licence claim is grounded in a primary source
(official docs, the repo's LICENSE, the GitHub API, or a first-party dist probe); the URL is
cited inline. GitHub metrics were read via `gh api` on 2026-09-04. Claims that could not be
confirmed from a primary source are marked _unverified_.

## The use case every tool is judged against

A **private, self-hosted tool for one developer** that automates his software-development
lifecycle: **investigate/spec** (read the real codebase, gather info, critique) → **develop**
(write code) → **test** (run tests) → **audit / security / self-improvement** (loop
edit→test until green) → **open a PR**. It drives AI **coding-agent CLIs** — Claude Code,
Codex, OpenCode — that run inside the project directory on a real git repo. It needs
**per-step model/provider switching** (a provider was down for a full day and he had to
switch). It wants a **visual node editor** to build, edit and watch runs. It is **not
distributed**, so the licence question is private self-host cost, not redistribution.

The single discriminating requirement, which most tools miss: **a step must run shell and
read/write a real repo checkout on the host** — not call a SaaS API, not run code in a remote
sandbox.

---

## Category 1 — full workflow-automation apps (could one replace yoke's core?)

| Tool             | Licence (private self-host)                  | Host shell in a repo dir?                   | Native agent/LLM step         | Per-step model switch                          | Visual editor               | Maintenance            |
| ---------------- | -------------------------------------------- | ------------------------------------------- | ----------------------------- | ---------------------------------------------- | --------------------------- | ---------------------- |
| **n8n**          | Sustainable Use — free for internal/personal | **Yes** — Execute Command (host shell)      | Yes (AI Agent node)           | Yes — 25+ model sub-nodes                      | Mature drag-drop            | 203k★, rel 2026-09-03  |
| **Kestra**       | Apache-2.0 core                              | **Yes** — Shell Commands task               | Yes (`agent.AIAgent`)         | Yes — per-task provider+model                  | YAML-first + topology graph | 28k★, rel 2026-09-02   |
| **Windmill**     | AGPLv3 non-EE                                | **Yes** — Bash/any-lang/Docker              | Partly (AI mostly build-time) | Broad providers; in-flow per-step _unverified_ | Flow DAG builder            | 17.8k★, rel 2026-09-03 |
| **Node-RED**     | Apache-2.0                                   | **Yes** — exec + function node              | No native AI                  | DIY                                            | Canonical wire canvas       | 23.6k★, rel 2026-09-01 |
| **Temporal**     | MIT                                          | Only in Activity code                       | No                            | Code-defined                                   | **No editor** (code-only)   | 22.8k★, rel 2026-07-08 |
| **Activepieces** | MIT core + EE dirs                           | **No** — no shell/exec piece                | Yes (AI pieces)               | Per-piece                                      | Drag-drop                   | 24.2k★, rel 2026-09-03 |
| **Huginn**       | MIT                                          | Partly — ShellCommandAgent (off by default) | OpenAI LLM agent only         | Minimal                                        | **No node canvas**          | 49.9k★, rel 2026-08-27 |

Key facts:

- **n8n** — Sustainable Use License: _"You may use or modify the software only for your own
  internal business purposes or for non-commercial or personal use."_
  ([LICENSE.md](https://raw.githubusercontent.com/n8n-io/n8n/master/LICENSE.md)) — private
  single-dev self-host is free; a paid Embed licence is only needed to offer/embed n8n to
  third parties, and `.ee.`-flagged files need an Enterprise licence. The **Execute Command**
  node _"runs shell commands on the host machine that runs n8n"_, self-hosted only, **disabled
  by default from n8n 2.0**
  ([docs](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.executecommand/));
  I confirmed the node exists in source (`packages/nodes-base/nodes/ExecuteCommand`). 25+ chat
  model sub-nodes verified in
  [source](https://github.com/n8n-io/n8n/tree/master/packages/%40n8n/nodes-langchain/nodes/llms).
  Free for private self-host; can shell out to `claude`/`codex` in a repo dir.
- **Kestra** — [Apache-2.0 core](https://github.com/kestra-io/kestra/blob/develop/LICENSE);
  native [`agent.AIAgent`](https://kestra.io/plugins/plugin-ai) with a clean per-task
  `provider` + `modelName`; real
  [Shell Commands task](https://kestra.io/plugins/plugin-scripts/io.kestra.plugin.scripts.shell.commands).
  Trade-off: **YAML-first authoring** with a live topology graph, not a free-form drag-drop
  canvas.
- **Windmill** — [AGPLv3](https://github.com/windmill-labs/windmill/blob/main/LICENSE)
  non-enterprise build; runs
  [Bash / any language / Docker](https://www.windmill.dev/docs/getting_started/scripts_quickstart/bash);
  visual Flow builder. Free for private self-host (AGPL copyleft only bites on distribution).
- **Node-RED** — [Apache-2.0](https://github.com/node-red/node-red/blob/master/LICENSE); great
  exec/function nodes and the canonical wire editor, but **no native AI/agent nodes** — you'd
  build the LLM-driving layer yourself.
- **Temporal** — [MIT](https://github.com/temporalio/temporal/blob/main/LICENSE), but it's a
  durable-execution engine you build on, with **no visual editor** and no native agent nodes.
- **Activepieces** — [MIT core](https://github.com/activepieces/activepieces/blob/main/LICENSE)
  - EE dirs; nice AI pieces and a drag-drop UI, but **no shell/exec piece** — SaaS-integration
    focus, cannot run arbitrary host shell in a repo dir.
- **Huginn** — [MIT](https://github.com/huginn/huginn/blob/master/LICENSE); an
  event/monitoring-agent model with no node canvas — wrong shape for an edit→test→PR loop.

**Category-1 verdict:** the shell-in-a-repo requirement eliminates Activepieces and Huginn,
and the no-visual-editor / no-native-AI gaps sideline Temporal and Node-RED. **n8n, Kestra and
Windmill** all genuinely can run shell in a repo dir with per-step model choice and a visual
authoring surface, free for private self-host.

---

## Category 2 — AI-agent / LLM visual orchestrators (closest domain)

**Bottom line up front: none of the six is built to drive external coding-agent CLIs
(Claude Code / Codex / OpenCode) that edit a repo on disk.** Five are for building
LLM-app / RAG / chatbot / agent-chat flows where a "step" is an LLM/tool/retrieval node.

| Tool               | Licence             | Repo shell on host?                             | Visual editor                            | Maintenance                                | Verdict                         |
| ------------------ | ------------------- | ----------------------------------------------- | ---------------------------------------- | ------------------------------------------ | ------------------------------- |
| **Flowise**        | Apache-2.0 core     | No (in-process JS / remote E2B sandbox)         | Mature — but **frozen**                  | **ARCHIVED 2026-08-13**                    | Reject (EOL)                    |
| **Langflow**       | MIT                 | No shell node (custom Python in-process)        | Strong, active                           | 154k★, rel 2026-09-01                      | Weak                            |
| **Dify**           | Modified Apache-2.0 | **No — Code node hard-sandboxed**               | Polished                                 | 154k★, rel 2026-08-25                      | Reject (sandbox)                |
| **Rivet**          | MIT                 | No first-class shell node; embeddable TS engine | Desktop editor                           | engine active, **app rel stale (2025-08)** | Partial building block          |
| **AutoGen Studio** | MIT code            | **Yes — host shell in `work_dir`**              | Prototype (non-production)               | 60.8k★, repo ~5mo stale                    | Closest capability, wrong shape |
| **LangGraph**      | MIT (library)       | Yes, if you write the node                      | **Studio is proprietary, account-gated** | 41k★, rel 2026-08-27                       | Code-first; editor closed       |

Key facts:

- **Flowise** is **archived / read-only as of 2026-08-13** (confirmed via `gh api` →
  `archived: true`; official
  [sunset notice](https://github.com/FlowiseAI/Flowise/discussions/6727)). Do not build on it.
- **Dify** deliberately sandboxes away the filesystem: its Code node _"runs in an isolated
  sandbox that blocks file system access, outbound network requests, and system commands"_
  ([docs](https://docs.dify.ai/en/guides/workflow/node/code)). Structurally unable to touch a
  repo.
- **AutoGen** is the only one with genuine host shell in a working directory —
  `LocalCommandLineCodeExecutor` _"executes code on the host machine … in the specified
  `work_dir`"_
  ([docs](https://microsoft.github.io/autogen/stable/user-guide/core-user-guide/components/command-line-code-executors.html))
  — but its agents write and run code **themselves**; it is not a wrapper that drives an
  external CLI like Claude Code, and AutoGen Studio is an explicit non-production research
  prototype.
- **LangGraph** ([MIT](https://github.com/langchain-ai/langgraph/blob/main/LICENSE)) is
  code-first: a node is arbitrary Python, so you can `subprocess` out to a coding-agent CLI —
  but the visual editor (LangGraph/LangSmith Studio) is **proprietary and account-gated** (its
  repo returns 404; requires a LangSmith API key), so the "visual build/watch" requirement
  pulls you into a closed tool.
- **Rivet** ([MIT](https://github.com/Ironclad/rivet/blob/main/LICENSE)) — the one whose
  editor+engine are cleanly embeddable TS libraries (`@ironclad/rivet-core`, `-node`), but no
  shipped shell-in-repo node and desktop-app releases are stale (this repo already evaluated
  and rejected it — see spec 011).

**Category-2 verdict:** "coding-agent that edits your repo" is **not a native concept in any of
them**. This is the empty niche that justifies yoke.

---

## Category 3 — embeddable node-editor libraries (if we build our own editor)

| Library                          | Framework   | Licence                           | Script-tag build?                | Stars       | Latest              | Maintenance                      |
| -------------------------------- | ----------- | --------------------------------- | -------------------------------- | ----------- | ------------------- | -------------------------------- |
| **React Flow** (`@xyflow/react`) | React 17+   | MIT                               | **UMD exists** (needs React UMD) | 38.2k       | pkg 12.11.6         | very active (2026-09-02)         |
| **Svelte Flow**                  | Svelte      | MIT                               | No (bundler)                     | (same repo) | 1.6.6 (2026-09-01)  | active                           |
| **Vue Flow**                     | Vue 3       | MIT                               | IIFE build exists                | 6.8k        | 1.48.2 (2026-01-28) | active                           |
| **Rete.js**                      | Agnostic TS | MIT                               | Core UMD, but needs plugins      | 12.2k       | 2.0.6 (2025-06-30)  | active                           |
| **Drawflow**                     | Vanilla JS  | MIT                               | **Yes** (min js+css)             | 6.1k        | 0.0.60 (2024-09)    | **dormant** (2024-10)            |
| **LiteGraph.js**                 | Vanilla JS  | MIT                               | **Yes**                          | 8.1k        | 2024-03             | **dormant**; Comfy fork archived |
| **jsPlumb Community**            | Vanilla JS  | **MIT/GPLv2 dual** (Toolkit=paid) | Yes (legacy)                     | 7.8k        | none published      | connectivity lib, not an editor  |

Corrections to my earlier going-in assumptions (all re-verified):

- **React Flow DOES ship a UMD build** — `dist/umd/index.js`, global `ReactFlow` (I confirmed
  HTTP 200 at
  [jsdelivr](https://cdn.jsdelivr.net/npm/@xyflow/react/dist/umd/index.js)). A bundler is the
  documented path, not a hard requirement. MIT, ~11.2M weekly npm downloads, most mature of the
  set — custom nodes/edges, minimap, controls, sub-flows.
- **Drawflow and LiteGraph are the true no-build vanilla options**, but both are effectively
  dormant (Drawflow last commit 2024-10; LiteGraph's original repo dormant and the ComfyUI
  fork archived) — a maintenance risk, though a small one when you vendor a single file.
- **jsPlumb Community is dual MIT/GPLv2**; the polished editor is the separate **paid**
  Toolkit — weakest fit for a turnkey node editor.

**Category-3 verdict:** for a private tool where build-toolchain weight is acceptable,
**React Flow** is the pick — MIT, by far the most capable and best-maintained, and it even
offers a UMD escape hatch if we ever want to drop the bundler.

---

## Decision

### (a) Is there an off-the-shelf tool that fits — or does yoke's niche justify building?

**No single tool is built for "personal SDLC automation with coding agents grounded in a
repo."** The visual AI orchestrators (Category 2) build LLM/RAG/chatbot flows, not
repo-editing pipelines — Dify sandboxes the filesystem away outright, Flowise is EOL, and the
rest offer only in-process code nodes. That specific niche is genuinely unserved, which is
yoke's justification.

**But the research overturns one thing I said earlier and must correct: n8n is not the wrong
core.** n8n (and Kestra, and Windmill) can run **host shell in a repo directory**, so they can
shell out to `claude -p` / `codex exec` — the exact CLIs yoke already drives — while giving you
a mature visual editor and per-step model switching **for free** on private self-host. The
"heavy separate app" objection from ADR-0011 is real, but for a private self-hosted tool it is
not disqualifying — the owner has confirmed a self-hosted internal tool is exactly the goal.

So the honest framing is two viable paths, not one:

### (b) If adopting a full app — n8n (or Kestra), and what is lost

**n8n** is the strongest adopt-candidate: mature drag-drop editor, native agent nodes, Execute
Command host-shell to run coding-agent CLIs in a repo dir, 25+ per-step model providers, free
for private self-host. **Kestra** is the Apache-2.0 alternative (cleaner licence, per-task
provider/model) at the cost of YAML-first authoring.

What you lose versus yoke's design:

- **Git-backed, reviewable definitions (ADR-0003).** n8n stores workflows in its own DB as
  JSON; yoke keeps them as neutral YAML in the repo, diffable in a PR.
- **Provider-neutral role→model indirection.** n8n switches models by swapping a model
  sub-node per step; yoke's role/profile registry is a different, more portable model.
- **Native coding-agent orchestration.** In n8n you drive `claude`/`codex` through a generic
  shell node; yoke treats the coding agent as a first-class step with declared, sandboxed repo
  access (just built: read-only investigation steps run `claude --allowedTools "Read,Glob"` in
  the project dir).
- **Chat-first entry from the AI CLI you're already in.** n8n is GUI-first.

### (c) If building our own editor — React Flow, and why

For a private tool where build weight is acceptable, **React Flow** (`@xyflow/react`, MIT) is
the clear choice: the most capable and best-maintained node editor, huge adoption, and it even
ships a UMD build as a fallback. Drawflow/LiteGraph are the no-build vanilla options but both
are dormant; jsPlumb's turnkey editor is paid. React Flow it is.

### Recommendation

The niche is real and yoke's design (git-backed neutral definitions + first-class,
repo-grounded coding-agent steps + role-based provider portability) is not something any
off-the-shelf tool gives. **Keep building yoke, with React Flow for the editor.** Before
committing fully, the cheap sanity check worth doing is a spike: wire one n8n Execute Command
node to run `claude -p` in a repo and see how close its editor + execution gets to the goal —
if it gets 90% of the way for near-zero build cost, that reframes the effort. But on the
evidence, the coding-agent-grounded-in-a-repo core is yoke's to build.

---

## Sources consulted

- n8n: [LICENSE.md](https://raw.githubusercontent.com/n8n-io/n8n/master/LICENSE.md) ·
  [Execute Command node](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.executecommand/) ·
  [AI Agent node](https://docs.n8n.io/integrations/builtin/cluster-nodes/root-nodes/n8n-nodes-langchain.agent/) ·
  [LLM sub-nodes](https://github.com/n8n-io/n8n/tree/master/packages/%40n8n/nodes-langchain/nodes/llms)
- Node-RED: [LICENSE](https://github.com/node-red/node-red/blob/master/LICENSE) ·
  [nodes](https://nodered.org/docs/user-guide/nodes)
- Windmill: [LICENSE](https://github.com/windmill-labs/windmill/blob/main/LICENSE) ·
  [bash scripts](https://www.windmill.dev/docs/getting_started/scripts_quickstart/bash) ·
  [AI generation](https://www.windmill.dev/docs/core_concepts/ai_generation)
- Temporal: [LICENSE](https://github.com/temporalio/temporal/blob/main/LICENSE) ·
  [overview](https://docs.temporal.io/evaluate/understanding-temporal)
- Kestra: [LICENSE](https://github.com/kestra-io/kestra/blob/develop/LICENSE) ·
  [AI plugin](https://kestra.io/plugins/plugin-ai) ·
  [shell task](https://kestra.io/plugins/plugin-scripts/io.kestra.plugin.scripts.shell.commands)
- Activepieces: [LICENSE](https://github.com/activepieces/activepieces/blob/main/LICENSE)
- Huginn: [LICENSE](https://github.com/huginn/huginn/blob/master/LICENSE)
- Flowise: [LICENSE](https://github.com/FlowiseAI/Flowise/blob/main/LICENSE.md) ·
  [sunset](https://github.com/FlowiseAI/Flowise/discussions/6727) (repo `archived:true` via gh api)
- Langflow: [LICENSE](https://github.com/langflow-ai/langflow/blob/main/LICENSE) ·
  [components](https://docs.langflow.org/concepts-components)
- Dify: [LICENSE](https://github.com/langgenius/dify/blob/main/LICENSE) ·
  [Code node sandbox](https://docs.dify.ai/en/guides/workflow/node/code)
- Rivet: [LICENSE](https://github.com/Ironclad/rivet/blob/main/LICENSE) ·
  [packages](https://github.com/Ironclad/rivet/tree/main/packages)
- AutoGen: [LICENSE-CODE](https://github.com/microsoft/autogen/blob/main/LICENSE-CODE) ·
  [code executors](https://microsoft.github.io/autogen/stable/user-guide/core-user-guide/components/command-line-code-executors.html)
- LangGraph: [LICENSE](https://github.com/langchain-ai/langgraph/blob/main/LICENSE) ·
  [Studio (proprietary)](https://docs.langchain.com/oss/python/langgraph/studio)
- Node editors: [xyflow](https://github.com/xyflow/xyflow) ·
  [vue-flow](https://github.com/bcakmakoglu/vue-flow) ·
  [rete](https://github.com/retejs/rete) ·
  [Drawflow](https://github.com/jerosoler/Drawflow) ·
  [litegraph.js](https://github.com/jagenjo/litegraph.js) ·
  [jsplumb community](https://github.com/jsplumb/community-edition) ·
  dist probes on jsdelivr; GitHub REST API for stars/releases/pushed_at/archived; npm downloads API.

Independently re-verified on 2026-09-04 for this document: n8n LICENSE wording and the
ExecuteCommand node's existence in source; Flowise `archived:true`; the LangGraph Studio repo
404; the React Flow UMD build (HTTP 200); Drawflow's last-commit date.
