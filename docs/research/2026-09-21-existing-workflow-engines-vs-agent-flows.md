# Research: is there an engine that already does this, so `af` can stop existing?

Date: 2026-09-21. Question: the owner is building `agent-flows` (`af`), a workflow engine for an
agentic SDLC. Before investing further: **does an existing self-hostable tool already solve this well
enough to implement the flows there instead?**

Two candidates were assessed on 2026-09-21 in
[`2026-09-21-scheduler-notifier-third-tool.md`](2026-09-21-scheduler-notifier-third-tool.md) —
OpenClaw's Lobster and Workboard, and Hermes Agent's Kanban. This document is the rest of the field
and does not repeat them. The n8n hybrid, retired in
[ADR-0017](../decisions/0017-retire-the-workflow-editor-hybrid.md), is the baseline: its three
recorded failure modes are the rubric every candidate is scored against.

Every claim is cited to a primary source — the project's own documentation in its own repository or
docs site, its `LICENSE` file, the GitHub API, a workflow file read out of its repository, or a file
in this repository — unless marked **UNVERIFIED**. Web search was used only to locate primaries and
is cited nowhere. Notation: "P" = primary; see Sources.

**Answer up front: do not adopt, but the honest answer is much less comfortable than "no".** There is
a whole category of purpose-built agentic-SDLC engines that the original candidate list missed, and
the largest of them — **Archon**, MIT, 23,517 stars — is `af` with a bigger catalogue, a visual
builder, container isolation, and a ten-stage SDLC pack whose stage names are almost `af`'s own
(P65, P73). It has per-step declared tool grants; a second engine, **Vincent**, has `af`'s
refuse-when-unenforceable guard verbatim; a third, **Keelson**, has `af`'s un-overridable deny floor.
The claim that no one provides `af`'s permission model is **false as a whole and true only in
detail** — §6 states the residue precisely, and it is one field wide.

---

## 1. Method and triage rule

Ten needs were given (§5 scores them). Two do almost all the eliminating:

- **Criterion 1 — runs self-hosted on a laptop, license permits private use.**
- **Criterion 6 — a step that shells out to an AI coding agent can have its permissions DECLARED in
  the workflow and ENFORCED by the engine**, not typed by hand into a CLI flag.

Criterion 6 is ADR-0017's failure mode 2 stated as a requirement. n8n died on it: "The community node
spawned `claude` directly and so bypassed the daemon's confinement, its tool grants and its run
records" (P1). Any engine that executes the agent step itself owns the sandbox; if it has no way to
express a per-step grant, adopting it means giving up confinement.

The field splits into two families, and they fail differently:

- **General-purpose workflow engines** (§4) — Kestra, Windmill, Conductor, Argo, Mastra. Mature,
  strong on criteria 2–10, and none of them has a concept of "an AI agent's tool grant" because they
  do not model an AI agent.
- **Purpose-built agentic-SDLC engines** (§3) — Archon, Takt, Vincent, Keelson and a handful more.
  Young, mostly solo-maintained, and all five of them have some form of per-step agent permission,
  because that is the problem they were built for.

§3 is the part of this document that matters. It is also the part that was nearly missed: none of
these appeared on the candidate list, and the brief's instruction to "actively look for anything
purpose-built for agentic SDLC pipelines" is what surfaced them.

## 2. Dismissed, one line each

**On criterion 1 (not a laptop, or the licence)**

| Tool                | Disqualifier                                                                                                                                                                             |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Argo Workflows**  | "orchestrating parallel jobs **on Kubernetes**… implemented as a Kubernetes CRD" (P20) — a cluster is the runtime. Kept in §4.4 anyway: it is the only general engine that passes 6.     |
| **Camunda / Zeebe** | Camunda License 1.0 grants use "limited to the Use in or for the purpose of Using the Software in **Non-Production Environment**" (P34). Dead on arrival for a tool he means to rely on. |

**On criterion 2 (no declared, diffable workflow artifact AND no UI to edit it) — libraries and
code-first engines**

| Tool                 | Disqualifier                                                                                                                                                                                                               |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Temporal**         | "A Workflow Definition is **the code** that defines your Workflow" (P25). Durable, excellent, and nothing to fork or diff as data; the Web UI is observability.                                                            |
| **Airflow**          | "When workflows are defined **as code**, they become more maintainable, versionable, testable, and collaborative" (P26) — the project's own pitch is the disqualifier. No UI authoring.                                    |
| **Prefect**          | "build and schedule workflows in pure Python—**no DSLs or complex config files**"; "Write workflows in native Python—no DSLs, YAML, or special syntax" (P60). The absence of a file is the product pitch.                  |
| **Dagster**          | "you declare—**as Python functions**—the data assets that you want to build", and it "is designed for developing and maintaining **data assets**" (P61) — wrong domain and wrong representation.                           |
| **Inngest**          | "Write durable functions using any of our language SDKs" (P27) — SSPL, self-hostable, but the function is code. Its separate Workflow Kit is the exception; see §3.5.                                                      |
| **Restate**          | BSL 1.1 with an internal-use grant (P28) — usable, but "Workflows-as-Code" (P28) is the product.                                                                                                                           |
| **Hatchet**          | MIT, "orchestration engine for background tasks, AI agents, and durable workflows" (P29) — SDK-defined workflows.                                                                                                          |
| **Trigger.dev**      | Apache-2.0 and it does ship "Human-in-the-loop: Programmatically pause your tasks until a human can approve, reject or give feedback" (P30) — but tasks are TypeScript files; there is no workflow document and no editor. |
| **DBOS**             | "annotate workflows and steps in your program to make it durable" (P31) — a library, not an engine.                                                                                                                        |
| **Dagger**           | "Dagger is a CI orchestration engine. Define your pipelines once, **in real code**" (P22). No human-approval or suspend primitive appears anywhere in its full documentation export (P23). Kept for one idea in §7.        |
| **LangGraph**        | "low-level orchestration framework for building stateful agents" (P32) — graphs are Python/TS objects; Studio is proprietary and is a debugger.                                                                            |
| **CrewAI**           | Python multi-agent library, MIT (P17). No workflow document, no gates, no per-step confinement.                                                                                                                            |
| **Pydantic AI**      | "the Python AI SDK: a typed, extensible agent loop" (P33) — a library. Its durable-execution story is a Temporal/DBOS integration, i.e. code again.                                                                        |
| **Google ADK**       | "an open-source, **code-first** Python framework" (P35) — self-describing dismissal.                                                                                                                                       |
| **Claude Agent SDK** | A library for driving one agent, not an engine for a graph of them. It is the layer `af` and Archon both call; §6 explains why that matters.                                                                               |

**On criterion 6 (visual builders whose steps cannot be a confined shell in your repo)**

| Tool         | Disqualifier                                                                                                                                                                         |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Dify**     | The Code node's languages "run in **secure sandboxes**" with a fixed standard library (P24) — there is no host-shell step, so `claude` in your checkout is not expressible at all.   |
| **Langflow** | MIT, "visual builder interface", components customised in Python (P36) — an LLM-app builder; no host shell step, no per-step permission model.                                       |
| **Node-RED** | Apache-2.0, "Low-code programming for event-driven applications" (P37) — has `exec`, has no AI/agent step, no permission model, no schema, no gates. You would build `af` inside it. |
| **Flowise**  | **Archived.** GitHub reports `archived: true`, last push 2026-08-13 (P18). Not a candidate.                                                                                          |
| **AutoGen**  | "**AutoGen is now in maintenance mode. It will not receive new features or enhancements**" (P19), redirecting to Microsoft Agent Framework — which is also a code-first SDK.         |

## 3. The category that was missed: purpose-built agentic-SDLC engines

Four projects clear the bar of _self-hosted + declared YAML DAG + agent steps over a real git repo_.
All four were created in the last twenty months. Repository facts below are mine, read from the GitHub
API on 2026-09-21 (P16b):

|             | Repo                   | Created    | Stars      | Licence    | Last push  |
| ----------- | ---------------------- | ---------- | ---------- | ---------- | ---------- |
| **Archon**  | `coleam00/Archon`      | 2025-02-07 | **23,517** | MIT        | 2026-09-21 |
| **Takt**    | `nrslib/takt`          | 2026-01-25 | 1,381      | MIT        | 2026-09-18 |
| **Vincent** | `lezli01/vincent`      | 2026-07-09 | 26         | MIT        | 2026-09-21 |
| **Keelson** | `danielscholl/keelson` | 2026-05-25 | **0**      | Apache-2.0 | 2026-09-21 |

### 3.1 Archon — this is `af`, with more of it, at 23.5k stars

MIT, `Copyright (c) 2025-2026 Cole Medin` (P66). Default branch `dev`. Self-describes as "The first
open-source harness builder for AI coding. Make AI coding deterministic and repeatable" (P65).
Installs by shell script, Homebrew or a container image; SQLite by default.

**It is a declared YAML DAG, and the design rule is written down.** "`nodes:` (DAG) format
exclusively… The `steps:` (sequential) format has been removed"; "Nodes without `depends_on` run
immediately. Nodes in the same topological layer run concurrently via `Promise.allSettled`. Skipped
nodes (failed `when:` condition or `trigger_rule`) propagate their skipped state to dependants" (P68).

Against `af`'s ten criteria:

- **Parallel fan-out and join (3): passes, and goes further than `af`.** `depends_on` plus
  `trigger_rule` (`all_success | one_success | none_failed_min_one_success | all_done`) plus `when:`
  conditional edges — and `fan_out`, "one child per item of a runtime list", available both on a
  composed `include:` block and on a `workflow:` child run (P68). `af` has no runtime fan-out.
- **Durable approval gates (4): passes, with the exact guarantee `af` needs.** "**Server restart
  while paused**: The run persists in the database. The user can still approve or reject after
  restart." Multiple approval nodes are supported, and one in a parallel layer pauses at the layer
  boundary (P69). There is also a separate `wait:` node that "durably pauses the run until a time or
  bounded external event. The server resumes due waits without keeping a worker or subprocess alive"
  (P68).
- **Bounded loop with a convergence condition (8): passes, and is better designed than `af`'s.**
  A loop ends on any of three channels, OR'd: an LLM `<promise>SIGNAL</promise>`, a structured
  `until_field`, or "**Deterministic bash check** — an `until_bash` script exits with code 0". "A
  loop must declare at least one of `until` / `until_bash` / `until_field`… the cheap channels are
  checked before `until_bash`, which is skipped once another one fired (it cannot change the outcome,
  and skipping it avoids an extra run of a side-effecting script)." `max_iterations` is required, and
  `loop_group:` applies the same to a whole sub-DAG (P70).
- **Nested workflows (10): passes, with two distinct keywords where `af` has one.** `include:` —
  "Name of another workflow whose nodes are **inlined into this DAG at load time** as a namespaced
  sub-DAG"; `workflow:` — "Name of another workflow to run as a **governed child sub-run** at
  execution time — its own run record, gates, artifacts, and cost", with `isolation: 'inherit' |
'worktree'` (P68).
- **Schema-validated step output (7): passes, and harder than `af`'s.** `output_format` is a JSON
  Schema on a node. "On a provider with enforced structured output (Claude, Codex, OpenCode) the
  schema constrains decoding. On a best-effort provider (Pi, Copilot) the schema is appended to the
  prompt, and a payload that fails validation is re-asked up to three times within the same iteration
  — a reask does not consume a loop iteration. If those are exhausted, the node fails with the
  validation errors; it is never treated as an incomplete iteration" (P70). `af`'s `schema` is an
  enum of three fixed shapes (P15-af).
- **Per-step model (5): passes.** Workflow-level and per-node `provider`, `model`, `effort`
  ("Reasoning depth on any provider that has one") (P68).
- **Declared definition and a UI editor (2): passes, in beta.** `packages/web/src/experiments/
console/builder/` exists on `dev` and contains `BuilderPage.tsx`, `BuilderConnected.tsx`, and
  `editor/`, `flow/`, `validation/`, `variants/`, `yaml/` subtrees (P73) — a graph builder over the
  same YAML.
- **Scheduling (9): absent.** No schedule or cron command appears in the CLI reference; the only
  matches for "schedule" are an internal environment-cleanup sweep, and `wait:` timers are in-run
  (P72). Same gap `af` has.

**And it ships `af`'s catalogue.** `.archon/workflows/sdlc/` holds ten stage workflows:
`triage, investigate, plan, implement, review, validate, deliver, pr, ship, upkeep` (P73). Read
`archon-review.yaml` and the shape is `af`'s `code-review`, wider: six lenses — `code, seams,
simplify, tests, errors, docs` — all `depends_on: [scope]`, joined by a node with
`trigger_rule: all_done` (P74). ADR-0019's stage table has an independent, larger implementation.

**Criterion 6 — where it differs from `af`, and this is the whole argument.** Archon does have
per-step declared tool grants:

> "Workflow nodes support `allowed_tools` and `denied_tools` to restrict which tools the AI can use
> at each step… `allowed_tools` is a whitelist — only listed tools are available. An empty list
> (`[]`) disables all tools. `denied_tools` is a blacklist… These are mutually exclusive per node.
> If both are set, `allowed_tools` takes precedence." (P67)

with the documented example being exactly `af`'s read-only stage:

```yaml
- id: review
  prompt: "Review the code for security issues"
  allowed_tools: [Read, Grep, Glob] # Can only read, not write
```

Four differences remain, and they are not cosmetic:

1. **The baseline is inverted.** "Archon runs the Claude Code SDK in **bypassPermissions** mode. This
   means the AI agent can read, write, and execute files without interactive confirmation prompts"
   (P67). Wide open by default; a node narrows. `af`'s default is `contents: "none"` — "no repo
   access (default…)" — and a step widens, within a floor (P15-af).
2. **No path scoping.** `allowed_tools` names tools. There is no glob. "May never read
   `ops/secrets-notes/**`" has no expression in the documented model (P67). Archon nodes also accept
   a `hooks:` block; whether that can express a path-scoped denial is **UNVERIFIED** — see §8.3, and
   it is the one thing that could partly close this gap.
3. **No un-overridable floor.** Nothing in the documented model prevents a workflow author from
   granting a node every tool. `af` removed `allow` on purpose: "a pipeline author is not an
   authorisation authority, and one line of YAML must never re-open a credential denial" (P15-af).
4. **It warns where `af` refuses.** "Tool restrictions are currently supported for the **Claude
   provider only**. Codex nodes with `denied_tools` will **log a warning**; `allowed_tools` is not
   supported by the Codex SDK" (P67). `af` skips the candidate instead: a fallback "is skipped —
   never attempted — when it cannot enforce what the step declares" (P15-af).

**And a finding that cuts both ways.** I checked whether Archon's own SDLC pack uses the mechanism.
It does not: across all ten of `archon-{triage,investigate,plan,implement,review,validate,deliver,pr,
ship,upkeep}.yaml`, the count of lines matching `allowed_tools|denied_tools` is **zero** (P74).
Archon's read-only review stage is not read-only; it runs at `bypassPermissions` like everything else.
The mitigation the docs offer instead is blast radius: a git worktree per run, and for folder projects
a Docker container over "a **read-only mount of the project root plus a writable overlay upper
layer**" with an approval-gated write-back of the overlay diff (P71).

The same check run against `af` is not flattering either: `permissions:` appears in 7 of 12 pipelines
(`code-review` 6 times, `audit` twice), and `deny:` appears in **zero** (P15-af, `pipelines/*.yaml`).
`af`'s differentiating field is built, tested and unexercised by its own catalogue.

**Against ADR-0017's three failure modes:** expressiveness — would not repeat, every kind has a
richer target. Confinement — Archon executes the step and does own the sandbox, but unlike n8n it has
a real per-node grant; the failure is one of precision and default, not of absence. Second
representation — **would not repeat**: workflows are files in `.archon/workflows/`, the builder edits
those files, and there is no server-side canonical copy to reconcile.

### 3.2 Vincent — the smallest project in the survey, and it has `af`'s guard

Go, MIT, 26 stars, created 2026-07-09 (P16b). "Local-first orchestrator for AI coding-agent
workloads" — a daemon plus SQLite. Validated YAML in a registry with project > global > built-in
shadowing, which is `af`'s three-layer merge (P76). Step types: `agent | command | manual | parallel |
fan_out | condition | loop | break | include`.

Two things in it are worth the whole section:

- **`af`'s portability refusal, already implemented.** "`permission_mode` … `full-auto` (default) or
  `restricted`. `restricted` needs an adapter that can restrict on this host — cursor cannot on
  Windows, and **a task whose restricted step resolves there is refused at creation**" (P76). That is
  the same gate as `af`'s `checkPortability`, expressed on the same axis, by an unrelated author. It
  is not a `af` invention.
- **Refusal used as a general design discipline.** A workflow with `network: false` that has an agent
  step "is refused at task creation"; a workflow that pins no image "is only refused when a task is
  created"; a cycle "is refused when the workflow loads"; `on_input: require` "refuses" codex and
  cursor (P76).

What it lacks against `af`: `permission_mode` is a two-value enum, not a tool list and not a glob set.

### 3.3 Keelson — `af`'s un-overridable floor, and an honest statement of where it stops

Apache-2.0, 0 stars, "A single-user, local-only agent harness: pluggable ribs, deterministic YAML
workflows, a typed extension contract" (P77). It is an Archon-format reimplementation.

Two documented facts matter here:

- **The floor.** "`KEELSON_WORKFLOW_TOOL_DENYLIST` is the always-on floor: a comma-separated list of
  tool names no workflow `prompt` node may use, subtracted on top of whatever a node's own
  `allowed_tools` permits. It is the one governance control active without opt-in, and **it cannot be
  overridden by a node or a rib**" (P77). That is `af`'s "effective deny = project defaults ∪
  step.deny, narrowing-only" — for tool names.
- **The limit, stated by the author against himself.** Keelson has real path confinement: the
  `path_confinement` builtin "denies any tool call whose file paths or shell arguments canonicalize
  outside those roots. It realpath-canonicalizes both the roots and each candidate path before
  comparing, so a symlink inside an allowed root that points elsewhere cannot be traversed to escape
  confinement." And then: "**Chat, workflow `prompt` nodes, and MCP calls declare no roots, so the
  builtin allows everything there**" (P77).

So the one engine in this survey that implements path-level confinement explicitly does not apply it
to workflow steps. That is the sharpest available evidence for §6.

It is also the weakest candidate operationally: 0 stars, solo, and its approval gates are not durable
— a fact its own docs state. **UNVERIFIED**: I did not re-read the approval page myself; the
restart-fails-the-run claim is relayed and unconfirmed.

### 3.4 Takt — the most adopted after Archon, and no headless gate

TypeScript, MIT, 1,381 stars (P16b). "Define how AI agents coordinate, where humans intervene, and
what gets recorded — in YAML" (P75). Seven step kinds including `workflow_call` with a typed
`subworkflow:` block.

- **Convergence (8): passes, on `af`'s exact semantics.** `quality_gates` of `type: command` "run
  inside the worktree after an agent step completes and **pass only when the command exits with code
  `0`**"; on failure TAKT "feeds command metadata, cwd, exit code or timeout/output-limit details, and
  the private output log path back into the same agent step" while keeping stdout out of the agent
  feedback (P75).
- **Permissions (6): a third distinct design.** `required_permission_mode: readonly | edit | full`
  per step, plus `capabilities:` presets naming tool allowlists, network, sandbox and skills. The
  engine actively narrows: "When `edit: false`… TAKT **removes** command/edit tools from
  `provider_options.*.allowed_tools` before calling the provider", with per-provider normalisation —
  `Bash(...)` judged by the canonical name before the parenthesis for Claude, lowercase `bash`/`edit`/
  `write` for OpenCode (P75). And the same warn-not-refuse ending as Archon: "Providers that cannot
  restrict tools (such as Codex) leave the leader's `allowedTools` unset and the leader still gets
  read-only **guidance** because its execution environment is read-capable" (P75).
- **Gates (4): fails, and this is disqualifying for `af`'s use.** "A rule with `interactive_only:
true` is only considered during interactive execution. In non-interactive runs (e.g. `--pipeline`
  or `takt run`), the rule is **skipped as if it were not declared**" (P75). A gate that silently
  disappears in the unattended mode is worse than no gate.

### 3.5 The rest of the category, at one line each

Repository facts verified by me (P16b); **all feature claims in this table are relayed from a
secondary sweep and were NOT independently verified — treat every one as UNVERIFIED.**

| Tool          | Repo / licence / stars                          | Reported strength                                                                                      | Reported disqualifier                                                        |
| ------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| **Bernstein** | `sipyourdrink-ltd/bernstein`, Apache-2.0, 1,231 | Goal→plan→parallel worktrees→verify→merge; `loop.until` bash; cron + RRULE                             | No in-workflow human gate; `interactive: true` rejected at load time         |
| **Nika**      | `supernovae-st/nika`, **AGPL-3.0**, 87          | `.nika` YAML, DAG waves, durable pause, child-authority subset rule                                    | `permits:` is workflow-level, not per-step; no exit-0 convergence            |
| **Goose**     | `aaif-goose/goose`, Apache-2.0, 54,528          | `retry: {max_retries, checks}` where the check "must exit with code 0" (P80); `sub_recipes`; real cron | The graph lives in the prompt — parallelism is LLM-decided, not declared     |
| **Squid**     | `dominno/squid`, MIT, 11                        | `gate` steps with structured input forms and `requiredApprovers`                                       | **Last push 2026-04-08** — five months stale (P16b). No per-step permissions |
| **Roast**     | `Shopify/roast`, MIT, 1,230                     | `map` + `parallel N` + `collect()`; `repeat`/`break!`                                                  | No longer YAML — now a Ruby DSL; permissions are one boolean                 |
| **Dagu**      | `dagucloud/dagu`, **GPL-3.0**, 4,047            | Best general self-hosted YAML DAG: sub-DAGs, cron, human tasks, single binary                          | No AI-agent step type, no per-step agent tool permissions                    |
| **OpenHands** | `OpenHands/OpenHands`, MIT, 88,699              | Git-synced `automation.yaml`, self-host-only                                                           | The file has no steps — one prompt, one entrypoint, one cron trigger         |

Goose's retry block is the one item here I did verify (P80): `retry` takes `max_retries` and a
`checks` array where each check is `type: shell` with a "Shell command to execute for validation
(**must exit with code 0 for success**)", plus `on_failure`, and between attempts it resets "the
agent's message history to initial state". That is `af`'s `loop` + `check` in five lines of schema.

## 4. The general-purpose engines

Five earned depth: **Kestra** (declarative YAML, the best editor in the field), **Windmill** (the only
general engine with a first-class AI-sandbox step), **Conductor** (a JSON graph whose workers are
yours), **Argo** (fails criterion 1; the only general engine that passes 6), and **Mastra** (`af`
already runs on it). Provenance, GitHub API, 2026-09-21 (P16):

|                | Created    | Stars  | Licence (SPDX) | Latest release                    |
| -------------- | ---------- | ------ | -------------- | --------------------------------- |
| Kestra         | 2019-08-24 | 28,199 | Apache-2.0     | `v2.0.2`, 2026-09-15              |
| Windmill       | 2022-05-05 | 17,993 | NOASSERTION¹   | `v1.815.0`, 2026-09-18            |
| Conductor      | 2023-12-08 | 32,212 | Apache-2.0     | `v3.33.0-rc5`, 2026-09-18         |
| Argo Workflows | 2017-08-21 | 16,996 | Apache-2.0     | `v4.1.4`, 2026-09-18              |
| Mastra         | 2024-08-06 | 28,234 | NOASSERTION²   | `@mastra/core@1.67.0`, 2026-09-15 |

¹ AGPLv3 plus proprietary enterprise code; see §4.2. ² Apache-2.0 except `ee/` directories (P15).
Note on Conductor: `Netflix/conductor` is **archived** (`archived: true`, last push 2023-12-22, P21);
`conductor-oss/conductor` was created two weeks before that archival and is the maintained line (P11).
Its newest tag is a release candidate (`-rc5`), which is what the API returns as the most recent
release (P16); the latest stable tag was not separately determined.

### 4.1 Kestra — the best declarative language and the best editor, and it cannot confine a step

**What it is.** Apache-2.0 core. "Workflows are defined declaratively in YAML as **flows**. Each flow
has an `id`, a `namespace`, a list of `tasks`, and optionally `inputs`, `outputs`, `triggers`,
`variables`" (P2). Every construct `af` needs has a named equivalent:

- **Parallel fan-out and join (3): passes, exactly.** `Dag` "lets you declare tasks and their
  `dependsOn` links; Kestra derives execution order and runs tasks in parallel as their dependencies
  are satisfied. Use it when your dependency graph cannot be expressed as a flat sequence or a single
  `Parallel` block — for example, when task C depends on both A and B, but A and B are independent"
  (P3). That is ADR-0014's explicit-edge model.
- **Durable approval gates (4): passes, and is better than `af`'s today.** `Pause` "halts the
  execution until it is manually resumed or a timeout expires", resumable via
  `POST /api/v1/executions/{executionId}/resume`, with `pauseDuration` and a `behavior` of
  `RESUME | WARN | CANCEL | FAIL` on expiry — and `onResume` declares **typed inputs collected from
  the approver**, read downstream as `{{ outputs.<pause_task_id>.onResume.<input_id> }}` (P3).
- **Bounded loop with a convergence condition (8): passes, with better guardrails than `af`.**
  `LoopUntil` takes a `condition` evaluated after each iteration with access to child outputs, plus
  `checkFrequency` carrying `interval`, `maxIterations` and `maxDuration`, plus `failOnMaxReached`,
  and emits `outputs.<task_id>.iterationCount` (P3).
- **Nested workflows (10): passes.** `Subflow` with `wait`, `transmitFailed`, `revision` pinning, and
  outputs read as `{{ outputs.call_subflow.outputs.result }}` (P3).
- **Scheduling (9): passes.** Schedule (cron) triggers plus Backfill (P2).
- **Declared definition AND a UI editor (2): the best answer anyone has.** The Edit tab opens
  side-by-side panels — "**Flow Code** — YAML editor with autocomplete", "**No-code** — visual flow
  builder", "**Topology** — visual DAG of the flow", plus Docs that update as the cursor moves, and
  Revisions (P8). "Tasks added here appear immediately in the No-code and Topology views" (P8). One
  dent worth knowing before copying it: the construct `af` most needs is the one the canvas does not
  cover — "**UI no-code forms are not available for DAG tasks** — configure them in YAML or the code
  editor" (P3).
- **Per-step model (5): passes for AI tasks.** Each `io.kestra.plugin.ai.agent.AIAgent` task carries
  its own `provider.type` + `modelName` (P5). A per-task `tools:` list exists too — but the tools are
  Kestra plugin tools (Skill, MCP, web search, flow call), not filesystem access (P5).
- **Schema-validated output (7): partial.** The AI provider takes `responseFormat` — "set `type` to
  `TEXT` (default) or `JSON`; for JSON output also set `jsonSchema`" (P6). Nothing validates a shell
  task's stdout against a declared schema.

**Where it fails: criterion 6, and it fails hard.** On a laptop Kestra has two ways to run a shell
command — the remaining task runners are Kubernetes, AWS Batch, AWS EC2, Azure Batch, Azure VM, Google
Batch and Google Cloud Run (P2) — and neither of the two can express a per-step grant:

1. **The Process task runner runs on the host with nothing between it and your machine.** Kestra's own
   security guide says so and puts the fix behind a paywall: "Restrict which task runners and plugins
   flow authors can use. At minimum, restrict access to the Process task runner in multi-tenant or
   untrusted environments — **the Process runner executes directly on the worker host with no
   container isolation**" — under a heading reading "**Plugin restrictions (EE)**" (P7). "Allowed
   plugins to centrally control which plugins may run" and "Policies to inject or enforce plugin
   configuration" are both Enterprise-only safeguards (P42-kestra). A single-user OSS install cannot
   restrict it at all.
2. **The Docker task runner's mounts are an instance-wide switch, not a per-step declaration.** The
   `volumes` property's own schema text: "**Volume mounts are disabled by default for security
   reasons** — if you are sure you want to use them, enable that feature in the plugin configuration
   by setting `volume-enabled` to `true`", via `kestra.plugins.configurations` keyed on the Docker
   runner **type** (P4). Flip it once and every flow on the instance can bind-mount anything. You can
   express "read-only" with a `:ro` bind; you cannot express "and never see `ops/secrets-notes/**`",
   and you cannot scope the capability to one step.

**Against ADR-0017's three failure modes.** Expressiveness — would **not** repeat: `pipeline` →
`Subflow`, `loop` → `LoopUntil`, `check` → a shell task where "the exit code is the real exit code of
your last command" (P59), gate → `Pause` + `onResume`. Confinement — **would repeat, in the purest
form**; ADR-0019's Refuses column becomes documentation again. Second representation — would partly
repeat: the artifact is YAML, but the source of truth is Kestra's database and Git is a sync in one
chosen direction — "Schedule a sync flow that automatically applies changes from Git to Kestra… **The
sync flow applies those changes, overwriting any conflicting UI edits with the Git version**" (P9).

**Verdict: no.** The best-designed thing among the general engines, and it would cost `af` its reason
for existing.

### 4.2 Windmill — the strongest general-engine case, made honestly

**What it is.** Community Edition "is free to use internally" (P10); the binary built without the
`enterprise` feature flag is AGPLv3, and the CE Docker images contain additional proprietary code
usable free for internal use (P10). Architecture: "A Postgres database, which contains the **entire
state of Windmill**, including the job queue", plus server-mode and worker-mode containers; "For small
setups, use Docker and Docker Compose on a single instance" (P58). Flows are DAG job specifications
persisted as flow YAML, authored in a low-code Flow editor (P12).

**It is the only general engine with a purpose-built primitive for the thing `af` does.** The AI
sandbox page is titled "How do I run AI coding agents (**Claude Code, Codex, OpenCode**) in Windmill
with sandboxing and persistent file storage?" (P13). Two annotations at the top of a step's script:

```ts
// sandbox
// volume: agent-state .agent
```

- `sandbox` — "runs the job inside **nsjail**, isolating the agent's filesystem and processes from
  the worker."
- `volume: <name> <path>` — "mounts a persistent volume so the agent can read and write files that
  survive across job runs" (P13).

Added from the flow editor: "Add a new step and select **AI Sandbox**. Choose a template (e.g.
**Claude Code**)" (P13). Per-step model selection is first class on AI agent steps — provider, model
and a `reasoning effort` dropdown per step (P14) — and those steps take an output schema: "Define a
JSON schema that the AI agent will follow for its response format" (P14). Approval is durable: a step
with Suspend enabled "will suspend the execution of a flow until it has been approved through the
resume endpoints or the approval page by and solely by the recipients of the secret URLs", with
flow-level pre-approvals via `flowLevel: true` (P39). `branchall` runs branches in parallel (P40);
while loops stop on an Early stop predicate (P41); subflows and retries are in the flow editor (P12,
P41); cron is a first-class trigger (P62).

**So why not adopt it? Because the sandbox is a switch, not a declaration — and the vendor's own
template proves it.** Windmill's built-in Claude Code template calls the Agent SDK like this (P13):

```ts
permissionMode: "bypassPermissions",
allowDangerouslySkipPermissions: true,
```

Concretely, against criterion 6:

- The `sandbox` annotation is **binary**. No per-step mount list, no read-only flag, no deny glob.
  "These configurations control resource limits, mount points, network isolation, and other security
  settings. **The configs are embedded into the Windmill binary at compile time**" (P38). Changing
  what a step may reach means recompiling Windmill, not editing the flow.
- Isolation is **off by default**: "NSJAIL is **disabled by default**"; "Isolation is **disabled by
  default**. You should manually enable either NSJAIL or PID isolation before deploying to
  production" (P38).
- On this owner's hardware it is worse. Windmill's platform-support table lists PID namespace
  isolation on "Docker Desktop (macOS)" as "⚠️ No — Set `ENABLE_UNSHARE_PID=false` for macOS workers"
  (P38). Whether nsjail itself works inside Docker Desktop's Linux VM on macOS is **UNVERIFIED**.
- Credentials must be hand-plumbed in: "Script inputs are TypeScript (or Python) variables — they are
  **not** automatically available as environment variables inside the sandbox… You must do the same
  for **any credential the agent needs at runtime**" (P13), with `process.env.GH_TOKEN = github_token`
  as the worked example. `af`'s default is the opposite — no provider keys in the process environment
  and a scrubbed child environment (P15-af).

**What adopting it would cost:** (1) `permissions: { contents, deny }` as a property of the step, and
with it ADR-0019's Refuses column; (2) the canon as single source of truth — Windmill's is Postgres
(P58), Git sync is bidirectional and on CE limited to "workspaces with up to 2 users" (P42);
(3) running in the **live working tree** — an nsjail'd job sees its job directory and mounted volumes,
and volumes are "synced to object storage" (P13); (4) the three-layer merge and `fork`;
(5) chat as the primary entry point (P15-af, P12).

**Against ADR-0017:** expressiveness — would not repeat. Confinement — **would repeat**, but less
badly than n8n, since Windmill at least has a sandbox; the grant is simply not per-step and not in the
file. Second representation — **would repeat** (P42, P58).

### 4.3 Conductor — the only general-engine adoption that would not repeat failure mode 2

Apache-2.0, `npm install -g @conductor-oss/conductor-cli && conductor server start`, or one Docker
image, UI at `:5000` and API at `:8080` (P11). Workflows are a registered, versioned **JSON
document**: "Keep orchestration as a versioned, inspectable graph while workers and built-in tasks
perform business logic and side effects" (P11). The operator set is `FORK_JOIN`, `JOIN`,
`EXCLUSIVE_JOIN`, `DYNAMIC_FORK`, `DO_WHILE`, `SWITCH`, `SUB_WORKFLOW`, `START_WORKFLOW`,
`SET_VARIABLE`, `TERMINATE`, plus system tasks including `HUMAN`, `WAIT`, `HTTP`, `INLINE`, `EVENT`
and the AI tasks (P42-cond).

- **Parallel (3):** `FORK_JOIN` with `forkTasks` as a list of lists — "Each item in the outer list
  represents a fork that will be invoked in parallel" — paired with a `JOIN` that "collects the
  outputs from each forked tasks" (P43). An explicit join node, which no other candidate has.
- **Gates (4):** `HUMAN` "pause the workflow and wait for an external signal… remains in
  `IN_PROGRESS` until marked as `COMPLETED` or `FAILED` by an external trigger", resolved by
  `POST api/tasks` or a queue update, and any body posted becomes the task output (P44). "Every step
  is persisted. Survives crashes, restarts, and network failures" (P11).
- **Bounded loop (8):** `DO_WHILE` with a `loopCondition` JavaScript expression evaluated after each
  iteration, plus `keepLastN` (P45). A worker that runs the check command and reports its exit code
  gives "loop until this exits 0".
- **Nested (10):** `SUB_WORKFLOW`, synchronous, `version` pinning, inline `workflowDefinition` (P46).
- **Cron (9):** an OSS scheduler at `/api/scheduler` when `conductor.scheduler.enabled=true`, with
  `cronSchedules`, `zoneId`, `paused`, and `runCatchupScheduleInstances` (P47).
- **Schema-validated output (7): the best answer in the whole survey.** Schemas attach at two points
  — `WorkflowDef.inputSchema`/`outputSchema` for "the workflow's own input and output", and
  `TaskDef.inputSchema`/`outputSchema` for "every use of that task, in every workflow" — as an
  embedded `SchemaDef` carrying a JSON Schema draft-2020-12 document, so that "with enforcement turned
  on, the execution is rejected at the boundary, before any side effect" (P63).
- **Declared definition (2): yes; UI _editing_ unverified.** "A workflow definition is a versioned
  JSON document… This page covers writing that document, validating it, and registering it with the
  server", with `POST /api/metadata/workflow/validate` before `conductor workflow create` (P64). The
  server ships "the built-in ui-next UI" (P11); whether it edits definitions was not established.
- **Sandboxing (6): absent from the workflow definition, by design.** "Conductor workers are plain
  code — any language, any library, any I/O… **Workers poll, execute, and report — run them
  anywhere**" (P11). The nearest thing to a grant lives in the Python SDK, not the graph: an agent
  with `cli_commands=True` gets a `run_command` tool where "`cli_allowed_commands` is the boundary.
  Anything outside the list is refused before it executes", and "Shell mode is off by default" (P48)
  — a worker-side constructor argument, invisible to the workflow JSON.

Because the engine never executes the step, adopting Conductor would **not** repeat failure mode 2 —
`af`'s daemon would be the worker. It is also not an answer: it means keeping `af`'s canon, daemon and
permission enforcement, adding a JVM, and registering a second graph representation to keep in sync
with `pipelines/*.yaml`. That is failure mode 3 bought for durability `af` already has (spec 033).

### 4.4 Argo Workflows — fails criterion 1, and shows what criterion 6 looks like at the OS layer

Dismissed on the laptop requirement (P20), documented for one reason. A step is a Kubernetes container
spec — "The spec of the template is the same as the Kubernetes container spec, so you can define a
container here the same way you do anywhere else in Kubernetes" (P49) — so image, `securityContext`
and `volumeMounts` with read-only flags are per-step, declared in the workflow YAML, and enforced by
something other than the agent's good behaviour. Its DAG is `dag.tasks[].dependencies`, where "Once
`A` has finished, steps `B` and `C` run in parallel. Finally, once `B` and `C` have completed, step
`D` runs" (P57). It also has `suspend: {}` as a first-class template type, resumable by `argo resume`
(P50); loops by recursion plus `when` (P51); `WorkflowTemplate` + `templateRef`; and `CronWorkflow`
(P52).

What it does not have is the thing `af` needs on top: a container boundary is not a _tool_ grant.
"May use Read/Glob/Grep but never Bash" is not expressible at any layer Kubernetes owns.

### 4.5 Mastra — what `af` would be without its canon

`af` already runs on Mastra (Binding B). Apache-2.0 except `ee/` (P15). The workflow API gives, in
code: `.parallel()`, `.branch()`, `.dountil()`, `.dowhile()`, `.foreach()`, `.then()`, `.sleep()`,
nested workflows, `.resume()`/`.cancel()`, and snapshots with time travel (P53); suspend-and-resume
(P54); Zod schemas on step input and output; and `schedule` with multiple cron schedules, runtime
pause and trigger history (P55).

So Mastra alone supplies criteria 3, 4, 7, 8, 9 and 10. It supplies none of 2 and 6, and 5 only as
something you write:

- **Criterion 2.** No declared workflow artifact — the workflow is TypeScript. Mastra's `Editor` is
  not a workflow editor and is built on exactly the pattern ADR-0017 rejected: "Editor works like a
  CMS for Mastra agents… **TypeScript defines the agent's default values. Editor saves changes
  separately instead of updating the source code**" (P56).
- **Criterion 5.** A step can call any model because a step is a function — so there is no per-step
  model _declaration_, no provider registry and no failover policy. `af`'s `providers.yaml` and
  role→model resolution are its own.
- **Criterion 6.** Nothing.

**This is the measurement of what `af` is.** Strip it down and what remains beyond Mastra is: the
provider-neutral canon as files, the three-layer merge, provider failover, and `permissions`. Four
things. Archon has all four in some form (§3.1); three of them are conveniences anyway.

## 5. The ten criteria, scored

Legend: ● full, ◐ partial, ○ absent.

| #   | Need                                    | **Archon**                                  | Kestra                 | Windmill                  | Conductor                  | Argo                  | Mastra           |
| --- | --------------------------------------- | ------------------------------------------- | ---------------------- | ------------------------- | -------------------------- | --------------------- | ---------------- |
| 1   | Self-hosted on a laptop, licence OK     | ● MIT, SQLite                               | ● Apache-2.0           | ● AGPL CE                 | ● Apache-2.0               | ○ needs Kubernetes    | ● Apache-2.0     |
| 2   | Declared definition **and** UI editing  | ● files + builder (beta)                    | ● best editor in field | ● flow YAML + editor      | ◐ JSON; UI edit unverified | ◐ YAML; UI ≈ runs     | ○ code only      |
| 3   | Parallel fan-out and join               | ● `depends_on`+`fan_out`                    | ● `Dag`+`dependsOn`    | ● `branchall`             | ● `FORK_JOIN`/`JOIN`       | ● `dependencies`      | ● `.parallel()`  |
| 4   | Durable human approval gates            | ● survives restart                          | ● `Pause`+`onResume`   | ● Suspend + resume URLs   | ● `HUMAN`                  | ● `suspend`           | ● suspend/resume |
| 5   | Per-step model selection                | ● provider/model/effort                     | ● per-task provider    | ● provider/model/effort   | ◐ worker's business        | ◐ your container      | ◐ you write it   |
| 6   | **Per-step declared, enforced sandbox** | **◐ tool names, no globs, warn-not-refuse** | **○**                  | **◐ binary, compiled-in** | **○** by design            | **●** container-level | **○**            |
| 7   | Schema-validated step output            | ● `output_format` + re-ask                  | ◐ `responseFormat`     | ◐ on agent steps          | ● workflow **and** task    | ○                     | ● Zod            |
| 8   | Bounded loop with convergence           | ● `until_bash` exit 0                       | ● `LoopUntil`          | ● while + early stop      | ● `DO_WHILE`               | ◐ recursion           | ● `.dountil()`   |
| 9   | Scheduling / cron                       | **○** absent from CLI ref                   | ● Schedule + Backfill  | ● cron                    | ● `/api/scheduler`         | ● `CronWorkflow`      | ● `schedule`     |
| 10  | Nested / composable workflows           | ● `include:` + `workflow:`                  | ● `Subflow`            | ● subflows                | ● `SUB_WORKFLOW`           | ● `templateRef`       | ● nested         |

For reference, `af` today scores ● on 2 (files plus the daemon's page), 3, 4, 6, 7 (`schema` on `llm`
steps), 8 and 10; ◐ on 1 (Node 22 and a native `better-sqlite3` ABI make installation fiddly, per
`README.md`); and ○ on 9. **Archon matches or beats `af` on nine of ten rows.** The one it loses is
row 6, and only in detail.

## 6. Verdict

**Do not adopt — but the reason is now one field wide, not a category difference, and that should
change how the project is argued for.**

The claim I would have made from the general engines alone — that no one provides a per-step,
engine-enforced, declared permission grant — is **false**. It was falsified by four independent
projects on the same afternoon:

- **Archon** has per-node `allowed_tools` / `denied_tools`, whitelist semantics, `[]` meaning no
  tools at all (P67).
- **Vincent** has the refuse-when-the-backend-cannot-enforce guard, on the same axis and with the
  same consequence: "a task whose restricted step resolves there is **refused at creation**" (P76).
- **Keelson** has the un-overridable floor: a deny list "subtracted on top of whatever a node's own
  `allowed_tools` permits… **it cannot be overridden by a node or a rib**" (P77).
- **Takt** has an engine that actively strips edit tools out of the provider's allowlist before the
  call, with per-provider normalisation (P75).

**What is left that no one has** is the conjunction, and one specific piece of it:

> A **path-glob** deny set, declared on a workflow step, unioned with a project-default floor it
> cannot widen, and enforced by refusing the provider rather than warning.

Each clause is held by someone. None holds all four, and the first clause — _path globs on a workflow
step_ — has no implementation I found anywhere. Archon scopes by tool name. Takt scopes by tool name.
Vincent scopes by a two-value mode. Keelson has genuine realpath path confinement and then says, in
its own documentation, that it does not reach workflow steps: "Chat, **workflow `prompt` nodes**, and
MCP calls declare no roots, so the builtin allows everything there" (P77).

That is `af`'s product. It is a real, defensible gap — and it is a much smaller one than "nobody does
this."

**Two findings should temper the celebration.**

1. **Archon does not use its own mechanism.** Zero of its ten SDLC workflows set `allowed_tools` or
   `denied_tools`; its `review` stage runs at `bypassPermissions` like everything else (P74, P67).
2. **`af` does not use its own either.** `deny:` appears in **zero** of twelve pipelines (P15-af).
   The field that justifies the project is unexercised by the catalogue that is supposed to need it.
   A capability no shipped workflow depends on is a hypothesis, not a differentiator — and by the
   project's own standard, a guard that has never been seen doing anything proves nothing.

**The strongest case for adopting Archon**, stated plainly: it is MIT, local, file-based, 23.5k stars,
pushed today, and it already has the ten-stage SDLC catalogue, runtime fan-out, two kinds of
composition, three loop-termination channels, schema-enforced structured output with bounded re-ask,
container isolation with an approval-gated overlay write-back, chat adapters, and a visual builder
over the same YAML — most of which `af` does not have and would have to write. It even avoids
failure mode 3 cleanly: its workflows are files, and the builder edits those files.

**What adopting it would cost**, in descending order of seriousness:

1. **The security default inverts.** `bypassPermissions` with per-node narrowing, versus `contents:
"none"` with per-step widening inside a floor. That is not a setting; it is a posture.
2. **Path-glob deny disappears**, and with it the only expression of ADR-0019's Refuses column that
   goes beyond tool names.
3. **Provider portability stops being an acceptance criterion.** Tool restrictions are "supported for
   the Claude provider only"; Codex nodes get a warning (P67). Charter rule 1 says the same pipeline
   must run under at least two independent providers _unchanged_; under Archon it would run, silently
   less confined.
4. **The narrowing-only rule has no equivalent**, so one line of YAML could re-open anything.

**Recommendation: keep `af`, and make the gap real within one milestone.** The honest position after
this survey is that `af` is not categorically unique — it is one of five, it is smaller than the
largest by two orders of magnitude of adoption, and its distinguishing feature is currently
unexercised. The correct response is not to argue harder; it is to (a) put `permissions.deny` globs
into `investigate`, `audit` and `code-review` where the stage table already promises read-only, and
(b) write the falsifiable test that a step declaring `deny` is refused on a provider that cannot
enforce it, running against a real provider rather than a stub. Until both exist, the answer to "is he
wrong to keep building?" is _not proven either way_ — and Archon is the benchmark he should be
measured against, not n8n.

**What would change this — each falsifiable:**

- **Archon adds path-scoped denies to a node.** Then the residue in §6 is gone, and the case for
  adopting becomes very strong. Watch `packages/workflows/src/schemas/` and
  `archon.diy/reference/security/`.
- **`af` still has no `deny:` in any pipeline in three months.** Then the differentiator was never
  needed and the project should be re-evaluated against Archon on the remaining nine rows — where it
  loses.
- **Archon's tool restrictions reach Codex/OpenCode and start refusing rather than warning** (P67).
  Two of the four clauses close at once.
- **The substrate stops enforcing what `af` declares.** `af`'s grant is only as good as the CLI
  invocation beneath it — `--restricted --strict-mcp-config` plus the tool and deny rules the binding
  emits (P15-af). A prior probe on this machine concluded that `claude -p`'s `--allowedTools` alone
  gates nothing; that probe was **not re-verified for this document** and is cited only as the reason
  to keep re-verifying. If it weakens, criterion 6 becomes unachievable for everyone and the honest
  move is a container per step — Archon's own fallback, and Argo's answer scaled to a laptop.

## 7. What `af` should steal, not adopt

Fourteen borrowings, each with a named source. None requires adopting anything.

1. **Archon's three OR'd loop-termination channels (P70)** — `until` (model signal), `until_field`
   (validated structured output) and `until_bash` (exit 0), with "the cheap channels checked before
   `until_bash`, which is skipped once another one fired (it cannot change the outcome, and skipping
   it avoids an extra run of a side-effecting script)". `af`'s `loop` has one. The skip-the-side-
   effecting-probe reasoning is the part to copy.
2. **Archon's `output_format` re-ask contract (P70)** — a schema violation is re-asked up to three
   times _within the same iteration_, "a reask does not consume a loop iteration", and exhaustion
   fails the node with the validation errors rather than counting as an incomplete iteration. `af`
   now validates schemas with ajv; this is what to do on failure.
3. **Archon's two composition keywords (P68)** — `include:` inlines at load time into a namespaced
   sub-DAG; `workflow:` starts a governed child run with "its own run record, gates, artifacts, and
   cost". `af` has only the second. The first is what a `-round` body actually wants.
4. **Archon's `wait:` node (P68)** — "durably pauses the run until a time or bounded external event.
   The server resumes due waits without keeping a worker or subprocess alive." A gate that costs no
   process.
5. **Archon's container write-back gate (P71)** — read-only mount of the project root plus a writable
   overlay, and the overlay diff is what the human approves before it touches the live tree. This is
   a better `ship` gate than approving a description of a change.
6. **Vincent's refusal-as-discipline (P76)** — `af` refuses on unenforceable permissions; Vincent
   also refuses a workflow with `network: false` and an agent step, a workflow pinning no image, a
   cycle at load time, and `on_input: require` on providers that cannot honour it. Refuse at the
   earliest point the premise is knowable, every time.
7. **Keelson's operator floor as an environment variable (P77)** — `KEELSON_WORKFLOW_TOOL_DENYLIST`,
   "the one governance control active without opt-in… it cannot be overridden by a node or a rib".
   `af`'s floor is compiled into the runtime; an operator-settable, un-overridable floor is a
   one-variable upgrade.
8. **Takt's tool-list normalisation (P75)** — when narrowing, `Bash(...)` is "judged by the canonical
   tool name before `(`" for Claude-family providers and lowercase `bash`/`edit`/`write` for
   OpenCode. Any deny that is not normalised per provider is a deny that can be spelled around.
9. **Takt's command-gate feedback shape (P75)** — on failure, feed back "command metadata, cwd, exit
   code or timeout/output-limit details, and the **private output log path**", while sanitized stdout
   "is available only in that local private log and is not inserted into agent feedback". That is the
   redact-at-the-source rule applied to check output.
10. **Goose's `retry` block (P80)** — `max_retries` plus a `checks` array of shell commands that "must
    exit with code 0 for success", an `on_failure` command, and a reset of "the agent's message
    history to initial state" between attempts. Five lines of schema for fix-until-green; the history
    reset is the part `af`'s `build-round` lacks.
11. **Kestra's three-panel editor (P8)** — YAML ↔ no-code canvas ↔ topology, live-synced, plus
    Revisions and a Docs panel that follows the cursor. `af` has an advantage Kestra does not: the
    file already _is_ the source of truth, so there is no sync problem to solve (contrast P9).
12. **Kestra's `Pause.onResume` typed decision inputs (P3)** — let a `gate` declare the shape of the
    decision it collects, instead of `af`'s fixed `{approved, reason?}` body.
13. **Kestra's `LoopUntil.checkFrequency` triple (P3)** — `interval` / `maxIterations` / `maxDuration`
    plus `failOnMaxReached`, and `iterationCount` as an output: a convergence budget, not a timeout.
14. **Conductor's two schema attachment points (P63) and validate-before-register (P64)** — a schema
    on the workflow's own input and output, a schema on a step kind binding "every use of that task,
    in every workflow", enforcement that rejects "at the boundary, before any side effect", and a
    `POST …/validate` endpoint separate from registration.

Two things explicitly **not** to steal: Mastra's Editor model, which "saves changes separately instead
of updating the source code" (P56) — ADR-0017 failure mode 3 sold as a feature; and Archon's
`bypassPermissions` baseline (P67), which is the one place `af` is unambiguously more careful.

## 8. What I could not verify

1. **Nothing was installed or run.** Every behavioural claim about every tool comes from its own
   documentation or its own repository files, not from observation. No workflow was executed, no
   `claude` was launched inside a jail, no gate was resumed after a restart.
2. **§3.5 is relayed, not verified.** Repository metadata in that table is mine (P16b); **every
   feature claim in it is UNVERIFIED** except Goose's `retry` block, which I read myself (P80). The
   same applies to Keelson's non-durable approval gates in §3.3 — the two governance quotes are
   verified (P77), the restart behaviour is not.
3. **Archon's `hooks:` semantics.** The security page shows per-node tool restrictions; the claim
   that a node's `hooks:` compile to Claude SDK `PreToolUse` hooks with a `permissionDecision: deny`,
   and that its `matcher` is a tool-name regex whose only path-scoped example is advisory, comes from
   a page I did not read directly. **UNVERIFIED** — and it is the one thing that could partly close
   the §6 gap, so it should be checked before the verdict is relied on.
4. **Archon's zero-tool-restriction finding is a text count, not a behavioural test.** I fetched all
   ten `.archon/workflows/sdlc/*/archon-*.yaml` files and counted lines matching
   `allowed_tools|denied_tools`; the count is zero (P74). Whether some default or an `include:`d block
   applies restrictions elsewhere was not checked.
5. **Whether Windmill's nsjail works on Docker Desktop for macOS.** The platform table covers PID
   namespace isolation (macOS: "⚠️ No") and says nothing about nsjail on that row (P38).
6. **Whether Conductor OSS's built-in UI edits workflow definitions** or only views executions (P11,
   P64). This is why Conductor scores ◐ on criterion 2.
7. **Whether a Kestra shell task can practically operate on a live, dirty working tree.** Nothing
   forbids `cd /path/to/repo` with the Process runner; whether it composes with caching, namespace
   files and `{{ workingDir }}` was not tested.
8. **Windmill's Community Edition proprietary surface.** The README states CE images "contain
   proprietary and non-public code" (P10) without enumerating it.
9. **Kestra 2.0 migration risk.** `v2.0.2` shipped 2026-09-15 (P16) and the worker architecture
   changed in 2.0 (P7); no migration guide was checked.
10. **The `af` claims are read from source, not from a live run.** `src/canon/types.ts`,
    `src/canon/portability.ts` and `src/bindings/mastra/buildSteps.ts` were read directly (P15-af) and
    the tests asserting the refusal exist, but no run was executed to watch a candidate be skipped.
11. **Coverage is still not exhaustive.** §3 is the result of one sweep. Hosted coding-agent
    platforms, devcontainer-based runners and harness-specific "workflow" features were surveyed only
    shallowly, and the category is producing new entrants monthly — Vincent is ten weeks old.

---

## Sources

Primary — Archon (`github.com/coleam00/Archon` branch `dev`, and `archon.diy`, read 2026-09-21):

- P65 `https://api.github.com/repos/coleam00/Archon` — created `2025-02-07`, pushed `2026-09-21`,
  23,517 stars, `license.spdx_id: MIT`, `default_branch: dev`, `archived: false`, description "The
  first open-source harness builder for AI coding. Make AI coding deterministic and repeatable."
- P66 `LICENSE` — "MIT License / Copyright (c) 2025-2026 Cole Medin"
- P67 `archon.diy/reference/security/` — "Permission Model" ("Archon runs the Claude Code SDK in
  bypassPermissions mode… The AI assistant has full read/write access to the working directory…
  There is no per-action confirmation step"); "Mitigations" (git worktree per conversation,
  "Workflows support per-node tool restrictions"); "**Tool Restrictions**" (the `allowed_tools:
[Read, Grep, Glob]` and `denied_tools: [WebSearch, WebFetch]` examples; "allowed_tools is a
  whitelist — only listed tools are available. An empty list (`[]`) disables all tools"; "These are
  mutually exclusive per node. If both are set, allowed_tools takes precedence"; "Tool restrictions
  are currently supported for the Claude provider only. Codex nodes with denied_tools will log a
  warning; allowed_tools is not supported by the Codex SDK")
- P68 `archon.diy/guides/authoring-workflows/` — the node-type table (`approval`, `wait`, `cancel`,
  `include`, `workflow` with their descriptions quoted in §3.1); "Nodes without `depends_on` run
  immediately. Nodes in the same topological layer run concurrently via `Promise.allSettled`";
  `trigger_rule: none_failed_min_one_success`; `when:` conditional edges; "The `steps:` (sequential)
  format has been removed. All workflows use `nodes:` (DAG) format exclusively"; workflow-level
  `provider` / `model` / `effort` / `webSearchMode` / `interactive`
- P69 `archon.diy/guides/approval-nodes/` — "Edge Cases": "Multiple approval nodes: Supported…
  Approval in parallel layer: … the workflow pauses at the layer boundary. **Server restart while
  paused: The run persists in the database. The user can still approve or reject after restart.**"
- P70 `archon.diy/guides/loop-nodes/` — "A loop node iterates its prompt until one of these
  conditions is met: LLM completion signal… **Deterministic bash check — an `until_bash` script exits
  with code 0**… Structured field… Max iterations reached"; "A loop must declare at least one of
  `until` / `until_bash` / `until_field`… They are OR'd… the cheap channels are checked before
  `until_bash`, which is skipped once another one fired"; the `output_format` provider-capability
  paragraph ("a payload that fails validation is re-asked up to three times within the same iteration
  — a reask does not consume a loop iteration"); `loop_group` with `until_bash`
- P71 `archon.diy/guides/container-isolation/` — "Container isolation runs the whole workflow inside
  a Docker container over a **read-only mount of the project root plus a writable overlay upper
  layer**, so nothing touches the live folder until you approve it"; the prepare → container →
  approval gate → WRITE-BACK GATE → teardown diagram
- P72 `archon.diy/reference/cli/` — searched for `schedule`, `cron`, `timer`: no schedule or cron
  command; the only `schedule` match is an internal environment-cleanup sweep and the only `timer`
  match is a `wait:` node's in-run timer
- P73 `https://api.github.com/repos/coleam00/Archon/contents/packages/web/src/experiments/console/builder`
  — `BuilderPage.tsx`, `BuilderConnected.tsx`, `components`, `editor`, `flow`, `model`, `validation`,
  `variants`, `yaml`; and `…/git/trees/dev?recursive=1` — `.archon/workflows/sdlc/{triage,
investigate, plan, implement, review, validate, deliver, pr, ship, upkeep}/archon-*.yaml`
- P74 `raw.githubusercontent.com/coleam00/Archon/dev/.archon/workflows/sdlc/*/archon-*.yaml` — all ten
  fetched (HTTP 200); `grep -cE "allowed_tools|denied_tools"` returns **0** for every one.
  `archon-review.yaml` shows six lenses (`code`, `seams`, `simplify`, `tests`, `errors`, `docs`) each
  `depends_on: [scope]`, joined by a node with `trigger_rule: all_done`

Primary — the other purpose-built engines (read 2026-09-21):

- P16b `https://api.github.com/repos/{lezli01/vincent, nrslib/takt, danielscholl/keelson,
sipyourdrink-ltd/bernstein, supernovae-st/nika, dominno/squid, Shopify/roast, aaif-goose/goose,
dagucloud/dagu, OpenHands/OpenHands}` — creation dates, stars, SPDX ids, `archived`, `pushed_at`
  (Squid's is `2026-04-08`)
- P75 `github.com/nrslib/takt/blob/main/docs/workflows.md` — `required_permission_mode: readonly |
edit | full`; "`type: command` gates run inside the worktree after an agent step completes and pass
  only when the command exits with code `0`"; the on-failure feedback sentence including "the private
  output log path… Sanitized stdout and stderr are available only in that local private log and are
  not inserted into agent feedback"; "A rule with `interactive_only: true` is only considered during
  interactive execution. In non-interactive runs (e.g. `--pipeline` or `takt run`), the rule is
  skipped as if it were not declared"; "When `edit: false`… TAKT removes command/edit tools from
  `provider_options.*.allowed_tools` before calling the provider… `Bash(...)` is judged by the
  canonical tool name before `(`"; "Providers that cannot restrict tools (such as Codex) leave the
  leader's `allowedTools` unset and the leader still gets read-only guidance"; `capabilities` presets
- P76 `github.com/lezli01/vincent/blob/master/docs/reference/workflow-schema.md` — "`permission_mode`
  | string | | `full-auto` (default) or `restricted`. `restricted` needs an adapter that can restrict
  on this host — cursor cannot on Windows, and **a task whose restricted step resolves there is
  refused at creation**"; `on_input: wait | deny | require` ("`require` refuses them"); the other
  refusals (agent step under `network: false`; no pinned image; cycle at load; `on_input: require`
  inside a loop body)
- P77 `danielscholl.github.io/keelson/llms-full.txt` (657 KB documentation export) — "`KEELSON_
WORKFLOW_TOOL_DENYLIST` is the always-on floor: a comma-separated list of tool names no workflow
  `prompt` node may use, subtracted on top of whatever a node's own `allowed_tools` permits. It is the
  one governance control active without opt-in, and it cannot be overridden by a node or a rib";
  "The `path_confinement` builtin is always registered… denies any tool call whose file paths or
  shell arguments canonicalize outside those roots. It realpath-canonicalizes both the roots and each
  candidate path before comparing, so a symlink inside an allowed root that points elsewhere cannot be
  traversed to escape confinement"; "This is a rib-agent-turn capability, not a global operator
  toggle. **Chat, workflow `prompt` nodes, and MCP calls declare no roots, so the builtin allows
  everything there**". `danielscholl.github.io/keelson/llms.txt` — the project description
- P80 `goose-docs.ai/docs/guides/recipes/recipe-reference` — the `retry` schema (`max_retries`,
  `checks`, `timeout_seconds`, `on_failure_timeout_seconds`, `on_failure`); "Success Check
  Configuration… `command` … Shell command to execute for validation (**must exit with code 0 for
  success**)"; "How Retry Logic Works… Execute the `on_failure` command (if configured); **Reset the
  agent's message history to initial state**; Increment retry counter"; the top-level field table
  including `sub_recipes`, `response` ("Structured output schema for automation workflows")

Primary — Kestra (`kestra.io/docs`, read 2026-09-21; each page fetched as its `.md` twin):

- P2 `/docs/llms.txt` — the core model paragraph, the flowable-task list, Triggers (Schedule/cron),
  Inputs, Outputs, Backfill, the Task-runners list, Namespace files
- P3 `/docs/workflow-components/tasks/flowable-tasks.md` — `Sequential`, `Parallel` (`concurrent`),
  `Switch`, `If`, `Loop`, **`LoopUntil`** (`condition`, `checkFrequency.interval|maxIterations|
maxDuration`, `failOnMaxReached`, `iterationCount`), `AllowFailure`, `Fail`, **`Subflow`** (`wait`,
  `transmitFailed`, `revision`), `WorkingDirectory`, **`Pause`** (`pauseDuration`, `behavior`,
  `onResume` typed inputs, `POST /api/v1/executions/{executionId}/resume`), **`DAG`** (`dependsOn`;
  "UI no-code forms are not available for DAG tasks")
- P4 `kestra.io/plugins/plugin-script-shell/runner/io.kestra.plugin.scripts.runner.docker.Docker` —
  the `volumes` description: "Volume mounts are disabled by default for security reasons… by setting
  `volume-enabled` to `true`", with the `kestra.plugins.configurations` YAML keyed on the runner type
- P5 `/docs/ai-tools/ai-agents.md` — `io.kestra.plugin.ai.agent.AIAgent` with per-task
  `provider.type` + `modelName` + `apiKey`, `systemMessage`, `prompt`, `tools:` and the `Skill` tool
- P6 `kestra.io/plugins/plugin-ai` (plugin schema) — "`responseFormat` — set `type` to `TEXT`
  (default) or `JSON`; for JSON output also set `jsonSchema`"
- P7 `/docs/administrator-guide/security-hardening.md` — "## Plugin restrictions (EE)… the Process
  runner executes directly on the worker host with no container isolation"; "## Worker isolation"
- P8 `/docs/ui/flows.md` — the Edit panel list (Flow Code / No-code / Topology / Docs / Files /
  Blueprints / Context), "Tasks added here appear immediately in the No-code and Topology views"
- P9 `/docs/version-control-cicd/git.md` — the SyncFlows/PushFlows pattern list and "The sync flow
  applies those changes, overwriting any conflicting UI edits with the Git version"
- P42-kestra `/docs/oss-vs-paid.md` — Enterprise-only safeguards ("allowed plugins to centrally
  control which plugins may run", "Policies to inject or enforce plugin configuration")
- P59 `kestra.io/plugins/plugin-script-shell/io.kestra.plugin.scripts.shell.Commands` — "the exit code
  is the real exit code of your last command"
- `github.com/kestra-io/kestra/blob/develop/LICENSE` — Apache License 2.0

Primary — Windmill (`windmill.dev/docs`, read 2026-09-21; `.md` twins):

- P10 `github.com/windmill-labs/windmill/blob/main/LICENSE` and `README.md` §License
- P12 `/docs/flows/flow_editor.md` — DAG job specifications, groups, subflows, "a persistent setting
  saved in the flow YAML"
- P13 `/docs/core_concepts/ai_sandbox.md` — the page title; the `// sandbox` and `// volume:`
  annotations; "Add a new step and select **AI Sandbox**"; the built-in Claude Code template with
  `permissionMode: "bypassPermissions"` and `allowDangerouslySkipPermissions: true`; "Passing
  credentials to the sandbox"; prerequisites
- P14 `/docs/core_concepts/ai_agents.md` — per-step provider/model/reasoning effort; "Define a JSON
  schema that the AI agent will follow for its response format"
- P38 `/docs/advanced/security_isolation.md` — "NSJAIL is disabled by default"; "The configs are
  embedded into the Windmill binary at compile time"; the per-script `sandbox` annotation;
  `job_isolation: nsjail_sandboxing`; "### Platform support" (Docker Desktop macOS row); "Isolation is
  disabled by default"
- P39 `/docs/flows/flow_approval.md` — suspension, `wmill.getResumeUrls()`, secret-URL approvers,
  flow-level pre-approvals
- P40 `/docs/flows/flow_branches.md` — "Branch all… execute all the branches in parallel"
- P41 `/docs/flows/while_loops.md`, `/docs/flows/flow_loops.md`, `/docs/flows/retries.md`
- P42 `/docs/advanced/git_sync.md` — bidirectional sync; "Community Edition for workspaces with up to
  2 users"
- P58 `/docs/advanced/self_host.md` — "A Postgres database, which contains the entire state of
  Windmill, including the job queue"; "For small setups, use Docker and Docker Compose"
- P62 `/docs/llms.txt` — the index entries quoted for features not read page-by-page ("Scheduling
  (cron): … Use CRON-like syntax with a visual interface and control panels for recurring jobs")

Primary — Conductor (`conductor-oss.github.io/conductor`, read 2026-09-21):

- P11 `github.com/conductor-oss/conductor/blob/main/README.md`
- P43 `/documentation/configuration/workflowdef/operators/fork-task.html`
- P44 `/documentation/configuration/workflowdef/systemtasks/human-task.html`
- P45 `/documentation/configuration/workflowdef/operators/do-while-task.html`
- P46 `/documentation/configuration/workflowdef/operators/sub-workflow-task.html`
- P47 `/documentation/api/scheduler.html`
- P48 `/devguide/ai/cookbook/agent-cli-tools.html`
- P63 `/devguide/how-tos/schema-validation.html` — the attachment table and "With one, and with
  enforcement turned on, the execution is rejected at the boundary, before any side effect"
- P64 `/devguide/how-tos/Workflows/creating-workflows.html` — "A workflow definition is a versioned
  JSON document"; "2. Validate before registration" (`POST /api/metadata/workflow/validate`)
- P42-cond `docs.conductor-oss.org/sitemap.xml` — the operator, system-task and how-to indexes
- P21 `https://api.github.com/repos/Netflix/conductor` — `archived: true`, last push 2023-12-22

Primary — Argo Workflows (`github.com/argoproj/argo-workflows`, branch `main`, read 2026-09-21):

- P20 `README.md`; P49 `docs/workflow-concepts.md`; P50 `docs/walk-through/suspending.md`;
  P51 `docs/walk-through/recursion.md`; P52 `docs/cron-workflows.md`, `docs/workflow-templates.md`,
  `docs/walk-through/loops.md`; P57 `docs/walk-through/dag.md` (`dag.tasks[].dependencies`)

Primary — Mastra (`mastra.ai/docs`, read 2026-09-21; `.md` twins):

- P15 `github.com/mastra-ai/mastra/blob/main/LICENSE.md` — Apache-2.0 except any `ee/` directory
- P53 `mastra.ai/llms.txt` and `/docs/workflows/control-flow.md`; P54 `/docs/workflows/suspend-and-
resume.md`; P55 `/docs/workflows/scheduled-workflows.md`; P56 `/docs/studio/editor.md`

Primary — dismissed candidates (each read 2026-09-21):

- P16 `https://api.github.com/repos/{kestra-io/kestra, windmill-labs/windmill,
conductor-oss/conductor, mastra-ai/mastra, argoproj/argo-workflows}` and `/releases?per_page=1`
- P17 `crewAIInc/crewAI` — MIT; P18 `FlowiseAI/Flowise` — `archived: true`, pushed `2026-08-13`
- P19 `github.com/microsoft/autogen/blob/main/README.md` — "AutoGen is now in maintenance mode…"
- P22 `docs.dagger.io/llms-full.txt` §Introduction and §"Daggerize a Go Project"; `docs.dagger.io/
llms.txt`
- P23 `docs.dagger.io/llms-full.txt` searched for `human approval`, `human-in-the-loop`, `approval
gate`, `suspend` — **no match** (documented absence in a 529 KB export)
- P24 `docs.dify.ai/en/guides/workflow/node/code`; `github.com/langgenius/dify/blob/main/LICENSE`
- P25 `docs.temporal.io/workflows`; P26 `github.com/apache/airflow/blob/main/README.md`
- P27 `github.com/inngest/inngest` `README.md` + `LICENSE.md` (SSPL v1.0)
- P28 `github.com/restatedev/restate/blob/main/LICENSE` (BSL 1.1) + `README.md`
- P29 `github.com/hatchet-dev/hatchet/blob/main/README.md`
- P30 `github.com/triggerdotdev/trigger.dev/blob/main/README.md`
- P31 `github.com/dbos-inc/dbos-transact-py/blob/main/README.md`
- P32 `github.com/langchain-ai/langgraph/blob/main/README.md`
- P33 `github.com/pydantic/pydantic-ai/blob/main/README.md`
- P34 `github.com/camunda/camunda/blob/main/licenses/CAMUNDA-LICENSE-1.0.txt` — "limited to the Use in
  or for the purpose of Using the Software in Non-Production Environment"
- P35 `github.com/google/adk-python/blob/main/README.md`
- P36 `github.com/langflow-ai/langflow/blob/main/README.md`
- P37 `github.com/node-red/node-red/blob/master/README.md`
- P60 `docs.prefect.io/v3/get-started/index`; P61 `github.com/dagster-io/dagster/blob/master/
python_modules/dagster/README.md`

Primary — this repository, read directly:

- P1 `docs/decisions/0017-retire-the-workflow-editor-hybrid.md` — the three failure modes
- P15-af `src/canon/types.ts:30-135` — `StepDef` fields (`kind`, `role`, `model`, `schema` as the enum
  `"weaknesses" | "securityFindings" | "codeReviewFindings"`, `dependsOn`, `manualOnly`, `skills`,
  `timeoutMs`, `permissions`, `command`, `env`, `path`) and specifically `:59-94` (the `permissions`
  doc comment: `contents: "read" | "write" | "none"`, "effective deny = project defaults ∪ step.deny",
  "Deny is narrowing-only (spec 031 D5)… a pipeline author is not an authorisation authority", `deny`
  as plain path globs); `src/canon/portability.ts:13,45-62` (the deny-list refusal checked before
  `contents`; `workspaceRead`/`workspaceWrite`/`stepDenyPatterns` capabilities; the
  `refused: <step>: <reason>` matrix row); `src/bindings/mastra/buildSteps.ts:329-332, 379-381,
470-476, 539-540` (a candidate "is skipped — never attempted — when it cannot enforce what the step
  declares"; `denyPatterns` forwarding); `src/bindings/mastra/buildSteps.test.ts:1348-1376`;
  `pipelines/*.yaml` counted directly — `permissions:` in 7 of 12 files (`code-review` 6,
  `audit` 2, `build-round`/`correct-plan`/`develop`/`investigate` 1 each) and `deny:` in **0 of 12**;
  `README.md` (three workflow layers, `fork`, per-project daemon, Layer-0 key isolation, Charter rule
  1 on provider portability, "Permissions not enforced" on Binding A);
  `docs/decisions/0019-the-stage-model-and-its-vocabulary.md` (D1 stage table and the Refuses column)

Secondary (used only to locate primaries; relied on for nothing, and every claim resting on it is
labelled UNVERIFIED in §3.5 and §8):

- S1 A delegated discovery sweep produced the candidate names in §3 and the reported-strength column
  of §3.5. Every §3.1–§3.4 claim was then re-read by me against the primary sources listed above
  before being stated here; §3.5 was not.
