# OpenAI's Agents platform vs agent-flows

Research date: 2026-09-13 · Scope: `developers.openai.com/api/docs/guides/agents*` and the guides it
links, plus `openai.github.io/openai-agents-python` and `openai-agents-js` for the SDK reference ·
Compared against `src/canon/types.ts`, `src/canon/registry.ts`, `src/runtime/artifactStore.ts`,
`specs/030-code-review/spec.md`, `pipelines/*.yaml`.

## 0. Method, and what the markers mean

Different from the 2026-09-06 security note: **nothing here was executed.** No OpenAI API call was
made, no session was created, no SDK was installed. Every claim is a documentation read.

- **[verified]** — read out of an OpenAI-published primary source during this session, at the URL
  listed in §7. Where a claim is a quotation it is in quotation marks.
- **[inferred]** — my deduction from what the docs do and do not say. Treat as an argument, not a
  fact.
- **[absent]** — I searched the primary sources for a concept and did not find it. Absence of
  documentation is weaker than a documented negative; each `[absent]` says what I searched.

Pages were fetched as their Markdown twins (`developers.openai.com` serves `<page>.md` for every
documentation page), so the quotations are the source text, not a model's summary of it.

**One page I could not read.** The endpoint reference for `POST /v1/agents/sessions` — linked from
several guides as "Create session reference" — returns HTTP 404 for its `.md` twin and renders
client-side as an empty SPA shell over HTTP. It is also absent from
`https://developers.openai.com/api/reference/llms.txt` and from the combined
`llms-full.txt` export (76 KB, no Agents session endpoints in it). The only machine-readable Agents
reference published is `agents/streaming-events.md`. Consequences are recorded in §6.

---

## 1. How they do it

### 1.0 The shape of the thing

**F1 — There is no single "OpenAI Agents platform." There are three runtimes and a deprecated
builder.** [verified] `agents.md` presents a chooser table, not a product:

|                      | Agents API                                                                 | Agents SDK                                                            | Responses API                                               |
| -------------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------- |
| Use for              | "Long-running tasks where OpenAI manages the agent and saves its progress" | "Building agents with custom tools and workflows in your application" | "Calling models directly or building an agent from scratch" |
| Where the agent runs | "OpenAI runs a managed Codex harness"                                      | "The SDK runs inside your application"                                | "Your application, with optional hosted orchestration"      |
| State between tasks  | "Saved session configuration, turns, and items"                            | "Your storage and SDK sessions, or Responses conversation state"      | "Manual history, response chaining, or Conversations"       |

The Agents API is in beta — every call carries `OpenAI-Beta: agents=v1` and the SDK surface is
`client.beta.agents.sessions.*`. [verified]

**F2 — The one declarative surface is being shut down.** [verified] Agent Builder — the visual node
canvas, the only place OpenAI ever shipped a declarative multi-step workflow — was deprecated on
2026-06-03 and "is scheduled to shut down on November 30, 2026" (`deprecations.md`, and a banner on
both `agent-builder.md` and `node-reference.md`). Its node set was: Start, Agent, Note, File search,
Guardrails, MCP, If/else (CEL), While (CEL), **Human approval**, Transform, Set state. The migration
guide is blunt about what survives:

> "This process does not convert your workflow graph or guarantee that every behavior transfers
> unchanged."
> "Workflows with strong determinism at their core may not migrate faithfully to a workspace agent."

The two exits offered are "Agents SDK" (imperative code) and "ChatGPT Workspace Agents" (built
"through natural language"). **This is the single most load-bearing fact in this document and every
later section leans on it.**

### 1.1 What is the unit of work

**F3 — SDK: the unit is a _turn_, not a step.** [verified] `running-agents.md`: "One SDK run is one
application-level turn." The runner loops — call the model → inspect output → execute tool calls →
follow handoffs → return on a final answer with no tool work. Tools, handoffs, approvals and
streaming "all build on top of it rather than replacing it."

**F4 — Agents API: the unit is a _session_ containing _turns_.** [verified] `sessions.md`: "A turn is
one cycle of work within a session. A message sent to an idle session starts a new turn. A message
sent during an active turn steers that turn." Session status is `idle | in_progress |
requires_action | failed`; turn status is `queued | in_progress | waiting | completed | failed |
cancelled` (both enums read from the streaming-events reference). [verified]

Neither unit is "a step with a declared prompt, model and permission set." The closest thing to a
step boundary in either runtime is a _tool call_ or a _handoff_, and both are chosen by the model at
run time.

### 1.2 Is a multi-step flow declared in code or declaratively

**F5 — In code, and that is now the only supported answer.** [verified] `orchestration.md` gives
exactly two patterns, both expressed as constructor arguments:

- **Handoffs** — `Agent.create({ name: "Triage agent", handoffs: [billingAgent, handoff(refundAgent)] })`.
  "Control moves to the specialist agent."
- **Agents as tools** — `summarizer.asTool({ toolName, toolDescription })`. "The manager keeps
  ownership of the reply."

Which branch runs is a model decision. There is no edge list, no `dependsOn`, no topological order,
no static graph. The Agents API equivalent is `agent.multi_agent.enabled: true`, after which "the
harness supplies tools to create, message, wait for, and interrupt subagents. You do not declare
these tools yourself." [verified] `max_concurrent_subagents` defaults to 6. Subagents "inherit
configured MCP tools, their credentials and allowed tools, and web search settings" and "do not
support function tools." [verified]

**F6 — There is no deterministic non-model step kind.** [absent] I searched every downloaded guide
for an equivalent of agent-flows' `kind: check` — a shell command run by the engine, not the model,
whose exit code becomes typed data the canon can branch on. The nearest surviving constructs are:

- `environment.setup_commands` — ordered shell commands that run _before_ the agent starts; "A
  nonzero setup exit status prevents the agent from starting." [verified] Runs once, pre-flight,
  cannot gate a later step.
- Agent Builder's `While` node with a CEL expression — deprecated with the rest of the canvas (F2).

Everything else is a model-invoked tool. The exit status of `pnpm test` in their world is a string
the model reports, not a value the runtime holds.

### 1.3 How state is carried between steps

**F7 — SDK: four documented strategies, pick one per conversation.** [verified] `running-agents.md`:

| Strategy                                      | Where state lives         | Next turn passes                           |
| --------------------------------------------- | ------------------------- | ------------------------------------------ |
| `result.history` / `result.to_input_list()`   | Your application          | The replay-ready history                   |
| `session` (`MemorySession`, `SQLiteSession`)  | Your storage plus the SDK | The same session                           |
| `conversationId`                              | OpenAI Conversations API  | The conversation ID and only the new turn  |
| `previousResponseId` / `previous_response_id` | OpenAI Responses API      | The last response ID and only the new turn |

"In most applications, pick one strategy per conversation. Mixing local replay with server-managed
state can duplicate context unless you are deliberately reconciling both layers."

**F8 — Agents API: the session is the state, and there is a separate durable artifact channel.**
[verified] The session holds agent config, conversation items and turns. Files are different:
`environments/files.md` — an artifact is "a published copy of a file from an OpenAI-hosted
environment", the agent writes to `/workspace/outputs`, and "OpenAI publishes outputs as immutable
artifacts when the turn completes." They are addressed by `(turn_id, path)`, survive sandbox
expiry, and are immutable: "Artifacts cannot be uploaded or edited through this API. To publish a
new version, ask the agent to update the file and complete another turn. Use the turn ID and path to
distinguish versions." Limits: 200 MiB per artifact, 500 MiB per turn, one download per request,
no batch endpoint. **The Artifacts API does not cover self-hosted environments** — "Files from
self-hosted environments are not published through the Artifacts API, including files under
`/workspace/outputs`." [verified]

**F9 — Context overflow is handled by compaction, not by stage boundaries.** [verified] The managed
harness does "summarizing previous work to manage its context window" automatically; the SDK exposes
`ModelSettings.context_management=[{"type": "compaction", "compact_threshold": 200000}]` and a
separate `OpenAIResponsesCompactionSession` that calls a standalone `responses.compact` endpoint
between turns.

### 1.4 How a run pauses and resumes

**F10 — SDK: `interruptions` + a serializable `state`, and it is explicitly the same run.**
[verified] `results.md`: "Interrupted runs return state, not a final answer" — `finalOutput` "can
stay empty because the run hasn't actually finished", `interruptions` lists pending tool calls,
`state` / `to_state()` is the snapshot you pass back. The documented lifecycle
(`guardrails-approvals.md`):

> 1. The run records an approval interruption instead of executing the tool.
> 2. The result returns `interruptions` plus a resumable `state`.
> 3. Your application approves or rejects the pending items.
> 4. You resume the same run from `state` instead of starting a new user turn.
>    If the review might take time, serialize `state`, store it, and resume later. That's still the same run.

`running-agents.md` adds the rule directly: "Treat approvals as paused runs, not as new turns."
The JS guide confirms the serialization is `state.toString()` / `RunState.fromString()`, that
sticky `alwaysApprove`/`alwaysReject` decisions survive it, and that `RunState.addInput()` lets new
user input be staged into a paused run. [verified]

**F11 — Agents API: `required_actions`, with exactly two kinds — and neither is "approval".**
[verified] From the streaming-events reference schema, `required_actions` is a union of exactly:

```
{ arguments, call_id, name, turn_id, type: "function_call" }
{ environment_id, type: "environment_connection" }
```

`sessions/manage.md` states the split cleanly: "The event tells your application when to check. The
retrieved session tells it what to do." That is a genuinely good separation — the pending-work list
lives on the _resource_, so a client that never held a stream can still discover what is owed.

### 1.5 How human approval is expressed

**F12 — In the SDK, approval is a boolean (or predicate) on a tool — not a node in a flow.**
[verified]

```javascript
const cancelOrder = tool({
  name: "cancel_order",
  parameters: z.object({ orderId: z.number() }),
  needsApproval: true,
  async execute({ orderId }) {
    /* ... */
  },
});
```

Python: `@function_tool(needs_approval=True)`. Resolution is `state.approve(interruption)` /
`state.reject(interruption)` then re-run from `state`. The JS guide notes the approval surface "is
run-wide, not limited to the current top-level agent" — a tool reached through a handoff or inside a
nested `agent.asTool()` still surfaces its interruption on the outer run. Local `shellTool()` and
`applyPatchTool()` can supply an `onApproval` callback to decide in code without pausing. [verified]

**F13 — In the Responses API, approval is a per-MCP-server policy with a request/response item
pair.** [verified] `require_approval: "always" | "never" | { never: { tool_names: [...] } }`; the
model emits an `mcp_approval_request` and the application replies with an `mcp_approval_response`
item carrying `approve: true` and the `approval_request_id`. The best-practice section states:
"Use the available configurations of the `require_approval` and `allowed_tools` parameters to ensure
that any sensitive actions require an approval flow."

**F14 — In the Agents API — the durable, long-running runtime — human approval is not a documented
concept at all.** [absent, and this is the sharpest finding in §1] I grepped every downloaded
`agents-api/*` guide for `approv`. Four hits, none of them a mechanism: three describe network
_approved endpoints_ and credential brokering, one is a showcase-app blurb ("Incident response
agent: investigate alerts and request approval for recovery actions"). `agents-api/tools/mcp.md`
contains **zero** occurrences — the `require_approval` parameter that exists on Responses-API MCP
tools is not documented for the Agents API. The session schema (read from the streaming-events
reference) has no approval field; the agent object holds exactly `id, instructions, model,
multi_agent, name, reasoning, service_tier, text, tools`.

The consequence is [inferred] but hard to escape: **to get a human gate inside a durable OpenAI
session, you make the sensitive action a `function_call` and hold the result in your own handler.**
The pause mechanism exists (`required_actions`) but the semantics — "a person must look at this
before it proceeds" — are yours to build, and the run is blocked on your webhook the whole time.

### 1.6 How per-step models are chosen

**F15 — SDK: three levels, all imperative.** [verified] `models.md` — `model` on the `Agent`
("Set `model` on an agent when that specialist consistently needs a different quality, latency, or
cost profile"), a run-level default via `new Runner({ model })` / `RunConfig(model=...)`, and the
process-wide `OPENAI_DEFAULT_MODEL` env var. The SDK reference adds the default: "When an Agent does
not specify a model, the Agents SDK uses `gpt-5.6-luna` with `reasoning.effort="none"` and
`verbosity="low"`", and warns "If your team cares about the exact default, don't rely on the SDK
fallback. Set it yourself."

**F16 — Agents API: one model per session, and nothing finer.** [verified] `model` is a field on the
agent config. Reuse is via a saved agent + `agent_id`; a session may pass both `agent_id` and
`agent` to override, with a footgun spelled out: "Supplied objects and arrays replace the entire
field rather than merging with the saved value. For example, supplying `tools` replaces the saved
tool list." There is no per-turn and no per-subagent model field in either the configuration guide
or the session schema. [absent — searched both]

There is no analogue of a _role tier_ — no named indirection between "this step is cheap survey
work" and a concrete model id. Model choice is a literal string at every site.

### 1.7 What happens on failure and retry

**F17 — SDK: a typed exception taxonomy, opt-in model retries, and per-error-kind handlers.**
[verified] Exceptions: `MaxTurnsExceeded`, `ModelTimeoutError`, `ModelBehaviorError` (malformed JSON,
unexpected tool use, terminal `failed`/`incomplete` Responses status), `ToolTimeoutError`,
`UserError`, `InputGuardrailTripwireTriggered`, `OutputGuardrailTripwireTriggered`. Controls:

- `ModelSettings.timeout` — "Maximum duration in seconds for each model-call attempt… It bounds the
  complete model attempt, including transport waits, but does not replace provider-specific phase
  timeout configuration or bound the full run, tool calls, or retry backoff."
- `ModelSettings.retry` — "Opt-in runner-managed retry settings for model calls." Off by default.
- `error_handlers` keyed by `"max_turns" | "model_refusal" | "invalid_final_output"`, each returning
  a controlled final output instead of raising. For `invalid_final_output` the docs are careful: the
  handler's fallback is validated against the same `output_type`, and "It does not retry the model
  call or replay any tool side effects."
- One automatic retry that is not opt-in: `conversation_locked` errors retry with backoff, rewinding
  the internal conversation-tracker input first.

**F18 — Agents API: a closed, stable failure-code enum — and explicitly no crash recovery.**
[verified] `SessionTurnError.code`, described as "A stable, machine-readable failure category", has
17 members: `context_length_exceeded`, `session_budget_exceeded`, `usage_limit_exceeded`,
`credit_balance_exhausted`, `rate_limit_exceeded`, `server_overloaded`, `cyber_policy`,
`connection_failed`, `server_error`, `authentication_error`, `invalid_request`,
`resource_not_found`, `sandbox_error`, `executor_version_incompatible`,
`active_turn_not_steerable`, `request_timeout`, `internal_error`. Paired with a customer-safe
`message`.

There is no declarative retry policy. The durability caveats are stated plainly and repeatedly:

> "The API does not guarantee recovery of pending input after a process crash. Check the request or
> session outcome before retrying. Do not resubmit while the original request is waiting. A late
> connection does not replay input that timed out." (`environments/lifecycle.md`)
> "The connection wait does not provide a durable input queue." (`sessions/webhooks.md`)
> "Streams do not replay missed events." (`sessions.md`)
> "`agent.session.idle` means the session is ready for more input, not that its last turn succeeded…
> A completed turn can still contain failed tool calls." (`sessions/webhooks.md`)

For side-effecting function tools the guidance is to build idempotency yourself: "store results
durably by session, turn, and call ID. If execution might have succeeded but no result was saved,
check the outcome before running the function again." [verified]

### 1.8 How long a run can live

**F19 — Session: durable, no documented maximum. Sandbox: one hour of silence, non-negotiable.
SDK run: as long as your process, unless you bolt on a workflow engine.** [verified]

- Agents API session — "The Agents API retains session state so you can continue work across turns
  without rebuilding the conversation context." No expiry is documented. [absent — searched all
  guides for expire/retention/lifetime]
- OpenAI-hosted sandbox — "Connected sandboxes receive keep-alives, including between turns. If
  activity and keep-alives stop for an hour, the sandbox can be deleted. **This timeout isn't
  configurable.**" Artifacts survive it; live files do not.
- Self-hosted environment — you own provisioning, reconnection and shutdown. "The API waits up to
  five minutes for an input-time connection… If it expires, the submission fails." And
  "Reusing the environment ID does not restore files in replacement compute."
- Agents SDK — the run is in-process. OpenAI's own answer for surviving restarts is to delegate:
  "The integrations below are for durable orchestration when runs may span long waits, retries, or
  process restarts" — **Dapr, Temporal, Restate, DBOS**, all third party, described as supporting
  "long-running agents, human-in-the-loop workflows, and handoffs." [verified]

That last item deserves emphasis. OpenAI's code-first agent runtime does not itself provide
durability; it provides a serializable snapshot and points at four external workflow engines.

### 1.9 Permissions, sandboxing, tracing, skills

**F20 — There is no per-step filesystem permission scope.** [absent — searched for `permission`,
`read.only`, `restrict.*tool`, `least privilege` across all downloaded guides] The controls that do
exist are coarser and live on the environment or the server, not the step:

- `network.access`: `enabled` (default) | `disabled` | `restricted` with `allowed_domains`, "1–100
  exact host names… Do not include wildcards, protocols, paths, or ports. Subdomains and redirect
  destinations need their own entries." [verified]
- `allowed_tools` on an MCP server, to "limit which tools the agent can discover and call". [verified]
- `environment.env` for string environment variables, with "Runtime-reserved names, including `PATH`,
  `CODEX_*`, and `OPENAI_API_KEY`" rejected. [verified]
- The posture in `environments/security.md` is isolation, not least-privilege tool grants: "Agent-
  generated code can access the files, credentials, and network available to its environment… Run
  workloads in isolated compute, such as virtual machines." Plus credential brokering — "The broker
  injects secrets into approved outbound requests without placing them in the agent's environment" —
  and the flat admission that "Agent-generated code can read the environment key."

**F21 — Environment overrides can only narrow.** [verified] `openai-hosted.md` on
`environment_template_id`: "Omitted settings inherit the template; **network overrides cannot
broaden its policy.**" A single sentence, but it is a design rule worth stealing (§3, §4).

**F22 — Tracing is on by default and closed.** [verified] `agents-api/tracing.md`: "Tracing is
enabled by default for new sessions. **The public beta API does not expose tracing configuration or
external trace exporters.**" The trace model is Session → Turn → spans of three types (Agent,
Generation, Tool), with per-agent token usage that excludes subagents. SDK tracing is also on by
default, `withTrace("name", …)` groups several runs into one trace — and the SDK docs advise: "In
cases where you do not have an API key from platform.openai.com, we recommend disabling tracing via
`set_tracing_disabled()`, or setting up a different tracing processor."

**F23 — Skills are the same open standard agent-flows already adopted.** [verified] `tools-skills.md`:
a skill is a directory with a `SKILL.md` manifest (front matter + instructions), and "Skills are
compatible with the open Agent Skills standard" (agentskills.io). A _plugin_ wraps skills **and** MCP
configuration in one directory behind `.codex-plugin/plugin.json`, loaded via
`environment.capability_directories` (self-hosted) or a ZIP in `environment.plugins` (hosted), and
reusable via an environment template. "Create a new session after changing plugin files or a
template. Existing sessions do not reload the tools."

**Verdict: their execution model is a model-driven agent loop with human review bolted on at the tool
boundary, wrapped in either a hosted durable session or an in-process library. The declarative,
authored, step-ordered graph — the thing agent-flows is — existed in exactly one place, Agent Builder,
and is being deleted on 2026-11-30, with the migration guide conceding that determinism is what
migrates worst.**

---

## 2. Where we overlap and diverge

### 2.1 Concept map

| agent-flows                                                                            | Nearest OpenAI concept                                               | Honest verdict                                                                                                                                                                                |
| -------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pipeline YAML in git                                                                   | Agent Builder workflow (published, versioned)                        | **Was** a real match. Deprecated, shutdown 2026-11-30. No replacement.                                                                                                                        |
| `steps` + `dependsOn` (explicit edges, ADR-0014)                                       | Handoffs / agents-as-tools                                           | **Not equivalent.** Theirs is a model-chosen route; ours is an authored edge resolved before the run.                                                                                         |
| `kind: llm`                                                                            | `Agent` with `instructions` + `model`                                | Close. Theirs carries tools and handoffs too; ours carries a prompt file and a permission set.                                                                                                |
| `kind: gate`, `manualOnly`                                                             | `needsApproval` on a tool + `interruptions`/`state`                  | Same _effect_, opposite _location_: ours is a node in the graph, theirs is an attribute of a side-effecting call. Neither subsumes the other.                                                 |
| `kind: check` (shell command, exit code is data)                                       | —                                                                    | **No counterpart.** Closest is `setup_commands` (pre-flight only) and the deprecated CEL `While`.                                                                                             |
| `kind: loop` + `until: test.passed` + `maxIterations`                                  | Agent Builder `While` (deprecated); `max_turns` in the SDK           | `max_turns` bounds model calls, not a convergence predicate. Our loop terminates on a real process exit code; theirs terminates on a model deciding it is done.                               |
| `kind: pipeline` (nesting, expanded at load)                                           | —                                                                    | No static composition primitive survives the Agent Builder shutdown.                                                                                                                          |
| `kind: assemble-spec` / `export-spec` / `persist-ticket`                               | Artifacts under `/workspace/outputs`; ordinary function tools        | Theirs are not runtime concepts at all. See §4.                                                                                                                                               |
| `role: reasoner\|worker\|scout` → profile → registry                                   | `Agent.model` string, `RunConfig` default, `OPENAI_DEFAULT_MODEL`    | **We are ahead.** They have no tier indirection. Ours is the mechanism that makes provider swap a config edit.                                                                                |
| `permissions.contents: read\|write` → `--restricted --tools …`                         | — (environment isolation + MCP `allowed_tools`)                      | **We are ahead**, materially. No per-step filesystem grant exists on their side.                                                                                                              |
| `permissions.allow` / `permissions.deny` globs                                         | `environment_template_id` overrides that "cannot broaden"            | Theirs is narrowing-only. Ours can widen. See §4.                                                                                                                                             |
| `env: [GH_TOKEN]` on `check` steps                                                     | `environment.env` map                                                | Similar intent; theirs is per-environment, ours per-step. Roughly even.                                                                                                                       |
| `skills:` on `llm` steps                                                               | `skills` / plugins, same Agent Skills standard                       | Same standard. Theirs bundles MCP config alongside; ours does not.                                                                                                                            |
| `maxBudgetUsd` per step / `defaultMaxBudgetUsd`                                        | `session_budget_exceeded` error code                                 | They cap per _session_; we cap per _step_. Their configuration surface is undocumented (§6).                                                                                                  |
| `timeoutMs` per step, `0` disables                                                     | `ModelSettings.timeout` per model-call attempt                       | Comparable. Theirs explicitly does not bound the whole run.                                                                                                                                   |
| Durable per-stage artifact + chain manifest (`src/runtime/artifactStore.ts`)           | Session artifacts under `/workspace/outputs`                         | **Genuine convergence.** Both immutable-on-completion, both survive the compute. Theirs is addressed by `(turn_id, path)`; ours by stage.                                                     |
| `StepProvenance { transport, modelId, model, tokens }`                                 | Trace spans + per-agent token usage                                  | Ours is in the artifact and readable offline; theirs is in a dashboard and "the public beta API does not expose… external trace exporters." **We are ahead on portability, behind on depth.** |
| Three bindings (Claude Code script gen, Mastra executor, n8n export)                   | One runtime each; Agent Builder → SDK code as a lossy one-way export | See §4. Their own export carries a no-guarantee warning.                                                                                                                                      |
| `decideEntryPoint` (`src/runtime/entryPoint.ts`), deterministic, "Never calls a model" | —                                                                    | **No counterpart.** Their entry is always "send a message to an agent."                                                                                                                       |

### 2.2 What they have that we lack — specifically

1. **A hosted durable session that survives the client process.** [verified] Our run lives in the
   Mastra executor; theirs lives in OpenAI's service and can be retrieved, listed, steered and
   resumed from anywhere with the API key. Caveated by F18's crash-recovery disclaimer, but the
   baseline is stronger than ours.
2. **Mid-turn steering.** [verified] "A message sent during an active turn steers that turn." We have
   no way to redirect a running step short of killing it. For an owner-in-the-loop tool this is a
   real capability gap.
3. **Programmatic approval callbacks alongside manual ones.** [verified] `onApproval` on
   `shellTool()`/`applyPatchTool()`, and hosted-MCP `requireApproval` + `onApproval`, let policy
   decide without a human round-trip. Our `gate` is binary: human, or a judge dispatched by
   `gateMode`.
4. **A closed, stable, machine-readable failure-code enum** (F18) that every consumer can branch on.
5. **Subagent fan-out with concurrency control** — `max_concurrent_subagents`, parallel independent
   contexts, per-subagent item history and command attribution (`turn.subagent_id` is `null` for the
   root). Our `dependsOn` DAG already expresses parallel branches (`spec-creation`'s `critic` and
   `security` both hang off `enrich`), but the fan-out is authored at a fixed width; theirs is
   dynamic, model-chosen and bounded by a concurrency knob. Different trade, not strictly better —
   but "spawn N reviewers, one per changed file" is expressible there and not here.
6. **Automatic context compaction** at both the harness and the `ModelSettings` layer.
7. **Deep per-span tracing** with per-agent token accounting.
8. **Webhooks.** Session state changes pushed without holding a stream.
9. **A credential-broker pattern** documented as a first-class posture (F20).
10. **Sandbox network policy as a declared, enforced field** (`disabled` / `restricted` +
    `allowed_domains`). We have no network control at all on `check` steps — the 2026-09-06 note's C3
    says so outright: "the check step still has full network. An allowlisted env removes the payload,
    not the channel."

### 2.3 What we have that they lack — specifically

1. **An authored, version-controlled, reviewable flow.** After 2026-11-30 they will not have one at
   any layer. `pipelines/*.yaml` diffs in a PR; an agent graph that the model picks at run time does
   not.
2. **A deterministic non-model step.** `kind: check` runs `/bin/sh -c` under the engine and yields a
   real exit code. `loop.until: test.passed` therefore cannot be talked closed by a model. Nothing in
   their platform gives you that; ADR-0015 already names it and it remains our sharpest structural
   advantage.
3. **Per-step least-privilege filesystem grants.** `permissions: { contents: read }` → `--restricted
--tools Read,Glob,Grep`. Their answer to the same problem is "use a separate VM."
4. **A capability-role indirection** (`reasoner`/`worker`/`scout` → profile → registry). This is what
   makes `AGENT_FLOWS_PROVIDER=openai` a one-line provider swap. They have no layer between a step
   and a model string.
5. **A gate as a first-class graph node with its own dependency edges**, orthogonal to whether any
   tool is being called. Our gate can pause between two _read-only_ steps because the owner wants to
   look; theirs cannot — approval is attached to a tool invocation.
6. **A provider-neutral canon.** `permissions.allow`/`deny` take "plain path globs — NOT vendor rule
   strings like `Read(...)`. The binding turns them into CLI rules; the canon stays provider-neutral"
   (`src/canon/types.ts`). Their configuration is their API shape, top to bottom.
7. **Export to a foreign runtime at all.** n8n export and Claude Code script generation have no
   OpenAI analogue except the deprecated builder's lossy SDK dump.
8. **Deterministic entry-point selection** (`entryPoint.ts`, "Never calls a model; the rule is an
   inspectable function, not a model guess"). Precisely the property open-dynamic-workflows was
   rejected for lacking, and OpenAI's path is the same model-guess path.
9. **Per-step cost caps.** `maxBudgetUsd` → `--max-budget-usd`, tripped per step. Their budget appears
   to be per session (F18) and its configuration is undocumented (§6).

**Verdict: the overlap is real but shallow — sessions/artifacts/skills/approval-pauses are genuinely
the same ideas, and their durability, tracing, steering and concurrency are better than ours. The
divergence is at the level that matters for this project: they have deliberately stopped shipping the
declarative authored graph, the deterministic check, and the per-step privilege grant, and those three
are agent-flows' entire reason to exist.**

---

## 3. What we should take — ranked by value ÷ effort

### T1 — Adopt a closed, stable failure-code enum on step and run results ★ highest value

- **Beats what we have:** today a failed step surfaces as a TypeScript error class
  (`StepBudgetExceededError` and friends) reaching the binding, and an artifact reader offline has
  prose. Their `SessionTurnError.code` is "a stable, machine-readable failure category" paired with a
  "customer-safe explanation" — one enum every consumer branches on: the MCP `get_run` tool, the
  chain manifest, the loop's `until`, the eval scorers, and the host CLI that reports to the owner.
- **Implementation:** a `StepFailureCode` union in `src/canon/types.ts`; map the existing error
  classes onto it in `runStep.ts`; record `{ code, message }` per step in `ArtifactProvenance`'s
  per-step block in `src/runtime/artifactStore.ts`. Steal the useful members outright —
  `context_length_exceeded`, `rate_limit_exceeded`, `request_timeout`, `invalid_request`,
  `authentication_error`, `server_overloaded`, `resource_not_found` — and add ours:
  `budget_exceeded`, `check_nonzero_exit`, `schema_parse_failed`, `permission_denied`,
  `gate_rejected`.
- **Cost:** one type, one mapping function, one artifact field. No canon change, no prompt change.
- **Incompleteness:** an enum is only as good as the mapping. A code that always comes out
  `internal_error` is worse than no code, because it reads as classified. Pick the members from
  failures we have actually seen, not from theirs wholesale.
- **Source:** `agents/streaming-events.md`, `SessionTurnError`.

### T2 — Put the pending-actions list on the run resource, not only on the event stream ★

- **Beats what we have:** their rule is "The event tells your application when to check. The
  retrieved session tells it what to do." A host-CLI chat session that reconnects, or a second
  terminal, or the owner coming back an hour later, can ask the run what it owes without having held
  a stream. Today a gate's payload lives in the Mastra `suspend()` envelope; the MCP `get_run` tool
  is the right place to surface a `requiredActions: [{ kind: "gate", stepId, message, … }]` array,
  and the run status should carry a `requires_action` state distinct from `in_progress`.
- **Implementation:** add `requiredActions` to the run resource in `src/runtime/runService.ts` and
  `src/serve/server.ts`; expose it from `mcp__agent-flows__get_run`; add the fourth status value.
  Mirror their event/resource split exactly — the notification says _when_, the resource says _what_.
- **Cost:** medium. Touches the run service, the HTTP surface and the MCP tool, but adds no new
  execution semantics — the gate suspension already exists.
- **Incompleteness:** only worth it if the run resource is durable across a daemon restart. If it is
  not, this hands out a promise the store cannot keep — do that half first.
- **Source:** `agents-api/sessions/manage.md`, `agents-api/sessions/webhooks.md`.

### T3 — Declare network policy on `check` steps, three-state, alongside `env:` ★

- **Beats what we have:** the 2026-09-06 note closed the _payload_ half of check-step exfiltration
  (C3, env allowlist) and explicitly left the _channel_ open. Their shape is proven and small:
  `network: { access: "enabled" | "disabled" | "restricted", allowed_domains: [...] }`, with the
  documented constraints (1–100 entries, exact hostnames, no wildcards/protocols/paths/ports,
  subdomains and redirect targets need their own entries). `disabled` should be the canon default for
  `check` — `pnpm test` does not need the internet, and `ship.yaml`'s `gh pr create` can declare
  `restricted: [api.github.com]`.
- **Implementation:** the _field_ is ~20 lines in `types.ts` + `load.ts`, mirroring `env:`. The
  _enforcement_ is the whole cost, and it is not small: `runCheckStep` spawns `/bin/sh -c` directly,
  so there is no CLI sandbox to lean on, and macOS has no cheap per-process network jail.
- **Cost:** field cheap, enforcement expensive and platform-specific. **Do not ship the field without
  the enforcement** — a declared `access: disabled` that does nothing is the exact "gate that cannot
  fail" failure this repo has already been bitten by twice.
- **Incompleteness:** even enforced, it does not constrain the `llm` steps' MCP servers; those are
  already handled by `--strict-mcp-config`.
- **Source:** `agents-api/environments/openai-hosted.md` (network table),
  `agents-api/environments/security.md`.

### T4 — Address artifacts by (stage, iteration) and make re-runs publish a new version

- **Beats what we have:** theirs is immutable and versioned by producing turn — "Use the turn ID and
  path to distinguish versions." Our artifact is per stage; a `loop` body that re-runs `fix` three
  times, or a stage re-entered after a gate rejection, has an addressing question the current design
  answers by overwriting or by not re-running. Immutable + versioned makes "what did iteration 2
  actually produce" answerable, which is exactly what the owner needs between short stages.
- **Implementation:** extend the artifact key in `src/runtime/artifactStore.ts` with the loop
  iteration / attempt ordinal; make the chain manifest list versions rather than one path per stage.
- **Cost:** low-medium, localized to the artifact store and the manifest type.
- **Incompleteness:** unbounded growth. Their answer is an explicit delete endpoint; ours should be a
  retention rule on `runs/`.
- **Source:** `agents-api/environments/files.md`.

### T5 — Add a run-level budget ceiling above the per-step caps

- **Beats what we have:** `maxBudgetUsd` is per step with a pipeline-level fallback; a nested
  `pipeline` + `loop` can multiply a per-step cap into an unbounded run cost. They carry
  `session_budget_exceeded` as a first-class terminal failure for the whole session.
- **Implementation:** accumulate spend in `runService.ts` across steps and nested pipelines; trip the
  run with the T1 code `budget_exceeded`.
- **Cost:** low, once per-step spend is already recorded (it is, for API transports; CLI transport
  reports no tokens, so CLI spend will be estimated or absent — say so rather than guessing).
- **Incompleteness:** with CLI transport the number is not authoritative. A ceiling built on an
  unknown is theatre; gate it on transports that actually report usage.
- **Source:** `agents/streaming-events.md` (`session_budget_exceeded`). Their _configuration_ surface
  for it is unverifiable (§6) — take the concept, not a copied field name.

### T6 — Bundle MCP configuration with skills, their plugin shape (defer)

- `.codex-plugin/plugin.json` declaring `skills` + `mcpServers` in one directory, registered by
  absolute path, reusable through a template. Directionally right and standards-aligned (agent-flows
  already borrowed `skills` from the same Agent Skills spec).
- Ranked last because **`skills:` has zero uses across all twelve pipelines today.** Adding a richer
  packaging format for a feature nothing uses is speculative work. Revisit when a pipeline actually
  needs a skill.

### Ranking

| #   | Take                                   | Value   | Effort                        | Files                                                                        |
| --- | -------------------------------------- | ------- | ----------------------------- | ---------------------------------------------------------------------------- |
| 1   | T1 stable failure-code enum            | high    | ~1 type + 1 mapping           | `src/canon/types.ts`, `src/canon/runStep.ts`, `src/runtime/artifactStore.ts` |
| 2   | T2 pending actions on the run resource | high    | medium                        | `src/runtime/runService.ts`, `src/serve/server.ts`, MCP `get_run`            |
| 3   | T3 network policy on `check`           | high    | field cheap, enforcement hard | `src/canon/types.ts`, `src/canon/load.ts`, `src/canon/runStep.ts`            |
| 4   | T4 versioned immutable artifacts       | medium  | low-medium                    | `src/runtime/artifactStore.ts`                                               |
| 5   | T5 run-level budget ceiling            | medium  | low                           | `src/runtime/runService.ts`                                                  |
| 6   | T6 plugin packaging                    | low now | medium                        | defer until a pipeline uses `skills:`                                        |

### Explicitly not taking

- **Handoffs / agents-as-tools.** Model-chosen routing is the property this project rejected
  open-dynamic-workflows for. Adopting it would delete `dependsOn` and ADR-0014 with it.
- **Compaction.** Our stages are short by design and hand over through artifacts, not through a
  growing context. Compaction solves the problem the stage boundary already solves.
- **Webhooks.** One operator, one machine, a daemon the operator starts. The MCP tools are the
  notification channel and they work.
- **Their tracing model.** "The public beta API does not expose tracing configuration or external
  trace exporters." Our per-step provenance in a file on disk is the more portable artifact, and
  ADR-0009's JSONL sink was already retired on purpose.

---

## 4. What we should simplify or drop

### D1 — Drop `permissions.allow`, or make overrides narrowing-only ★

`src/canon/types.ts` documents `effective deny = (project defaults ∪ step.deny) − step.allow`, with
roughly 30 lines of comment explaining exact-string-equality subtraction and why naming a specific
file does not defeat a broad glob. **It has zero uses across all twelve pipelines.**

Two arguments converge on removing it:

- **Theirs.** "Omitted settings inherit the template; network overrides cannot broaden its policy"
  (F21). A per-instance override that can only narrow is strictly safer and needs no subtraction
  semantics, no normalisation rules, and no documentation of them.
- **Ours.** F9 in the 2026-09-06 note established that `--restricted` discards the operator's own
  `settings.json` deny rules, which makes `CREDENTIAL_DENY_PATTERNS` "load-bearing and single-point."
  `allow` is a canon-level hole-puncher in the only remaining control. That is a bad combination for
  a feature nobody uses.

Keep `deny` (narrowing only). Delete `allow`, its subtraction rules, its loader validation and its
comment block. If a future step genuinely needs a `.pem` fixture, add it then, with the use case in
hand.

### D2 — Collapse `assemble-spec`, `export-spec` and `persist-ticket` into one kind, or out of the canon ★

Three of eight step kinds, one use each, **all three in `spec-creation.yaml` and nowhere else**, all
three operating on the single domain type `HardenedSpec`: `assembleSpec()` merges four step outputs
into it, `persistTicket()` writes it to SQLite, `exportSpec()` writes it as `spec.md` under a path.

OpenAI has no runtime concept for any of this — their equivalent is a file the agent wrote to
`/workspace/outputs`, published as an artifact, plus an ordinary function tool for the database
write. That is not automatically the right answer for us (their file is model-written; our assemble
is deterministic, which is better). But the ratio is bad: **37% of the canon's step vocabulary serves
one pipeline**, and that pipeline's output now also flows through the durable per-stage artifact
store added in `db487f9`/`81ba774`.

The question to answer before changing anything — I have read these three modules only at the header
level, so this is [inferred] and needs the real look — is whether the artifact store has made
`export-spec` redundant, and whether `persist-ticket` is a `check`-shaped side effect rather than a
step kind. If both hold, the canon loses two kinds and gains nothing to explain.

### D3 — Decide which of the three bindings is a product and which are exports

OpenAI ships exactly one runtime per path, plus one lossy export, and warns about it in the export's
own guide: "This process does not convert your workflow graph or guarantee that every behavior
transfers unchanged" and "Workflows with strong determinism at their core may not migrate faithfully."
They wrote that about a _visual graph → SDK code_ conversion, which is structurally the same job as
agent-flows' canon → n8n export and canon → Claude Code script generation. The prediction their
experience makes is that the exports diverge from the executor and the divergence is silent.

Not a recommendation to delete anything today — provider portability is the project's core
requirement and multiple bindings are how it is demonstrated. It is a recommendation to **name one
binding as the executor and the other two as best-effort exports with a stated non-guarantee**, so
that "behaviour differs between bindings" becomes a documented property rather than a bug. If the
n8n export has no live consumer, that is the one to retire first.

### D4 — Prune the unused canon fields before adding more

Census over `pipelines/*.yaml` — **zero uses**: `permissions.allow`, `permissions.deny`, `skills`,
`maxBudgetUsd`, `defaultMaxBudgetUsd`, `timeoutMs`, `model` (the per-step registry-id override;
`role` is used instead). **One or two uses**: `manualOnly` (`ship.yaml:12`), `optionalInputs`
(`spec-creation.yaml:12`, `code-review.yaml:14`) — those two are earning their place and stay.

Each zero-use field carries loader validation, tests, and 5–40 lines of interface documentation.
Some are deliberate forward investments and should stay (`maxBudgetUsd` is a safety valve worth
having before you need it; `timeoutMs` likewise). `allow` is not one of them (D1). Worth one pass
with the question asked per field: _what run is waiting on this?_

### Explicitly keep — do not "simplify" these

- **`role` → profile → registry.** This is the one place where extra indirection is load-bearing.
  Their flat `model: "gpt-6-astra"` string is simpler and would cost us the single-config-edit
  provider swap, which is the project's stated core requirement. Their design is worse for our goal.
- **`kind: check` and `until: test.passed` grounded in a real exit code.** The property nothing on
  their platform has.
- **`gate` as a graph node rather than a tool attribute.** Ours can pause between two read-only steps
  because the owner wants to look; theirs structurally cannot.
- **`decideEntryPoint`'s "never calls a model" rule.** Their entry point is a message to an agent.

---

## 5. The owner's framing, answered directly

### Does OpenAI's platform make any part of agent-flows redundant?

**One part, partially: the durable run-state plumbing — and only if you accept their lock-in.**

The Agents API session genuinely does what `src/runtime/runService.ts` plus the artifact store are
converging on: a durable, listable, resumable unit of work with immutable published artifacts,
per-turn provenance and a pending-actions list, all surviving the client process. If agent-flows were
OpenAI-only, building that ourselves would be redundant work. [verified mechanism, [inferred]
redundancy judgement]

Nothing else is. Specifically **not** redundant:

- the YAML canon and its explicit edges — their only declarative surface is being deleted (F2);
- `kind: check` and exit-code-grounded loop termination — no counterpart (F6);
- per-step `permissions` — no counterpart (F20);
- `gate` as a node — theirs is a tool attribute, and in the _durable_ runtime it is not documented at
  all (F14);
- `role` tiers — no counterpart (F15/F16);
- deterministic entry-point selection — no counterpart.

And the redundancy is one-sided in an uncomfortable direction: their session is redundant with our
runtime _only_ for sessions running OpenAI models on OpenAI's harness. The moment a stage runs under
Claude Code, their session cannot hold it.

### Is anything in it a reason to change course?

**No.** Two reasons, one confirming and one cautionary.

**The confirming one.** The strongest signal in the whole platform is the Agent Builder deprecation
(F2). OpenAI built the declarative, versioned, node-graph workflow product, shipped it, and is
retiring it by November 2026 in favour of imperative SDK code and natural-language workspace agents —
while conceding in the migration guide that "workflows with strong determinism at their core may not
migrate faithfully." A vendor walking away from the authored deterministic graph is not evidence the
graph is wrong; it is evidence that a vendor optimising for breadth of adoption will not maintain one
for you. That is the standard argument for keeping a small authored canon in your own git repo, and
this is a clean instance of it.

**The cautionary one.** Their durability caveats are the most useful thing they published, and they
should be read as a list of things agent-flows will have to answer too: no guaranteed recovery of
pending input after a process crash; streams that do not replay; idle ≠ succeeded; a completed turn
that still contains failed tool calls; side-effecting tools needing application-side idempotency keyed
by (session, turn, call). OpenAI has a team on this and still ships those disclaimers. A
single-operator tool with gates between stages should assume the same and design the gate payload so
that the owner can tell a stalled run from a finished one — which is exactly what T1 and T2 are for.

### Does it satisfy the provider-portability requirement, or is adopting it vendor lock-in?

**Split answer, and the split matters.**

**Agents API: total lock-in. Unambiguous.** [verified] The `model` field takes an OpenAI model; the
harness is "the OpenAI-hosted Codex instance"; tracing is on by default with no exporter and no
configuration; sessions, artifacts and items are OpenAI resources; data residency is US-only and Zero
Data Retention is not supported — "Choosing a self-hosted sandbox does not make the Agents API
ZDR-eligible." The only portable seam is `environment.type: "self_hosted"`, which moves _your
compute_ under your control while the orchestration, the model and the state stay with OpenAI. There
is no Claude Code path.

**Agents SDK: partial portability, load-bearing caveats, all of them OpenAI's own words.** [verified]
Non-OpenAI providers are supported through three built-in seams — `set_default_openai_client` (global),
`ModelProvider` (per run), `Agent.model` (per agent) — pointed at an OpenAI-compatible **Chat
Completions** endpoint, plus two adapters, Any-LLM and LiteLLM, shipped as "best-effort, beta adapter
integrations". The caveats:

- "In these examples, we use the Chat Completions API/model, because many LLM providers still do not
  support the Responses API."
- A list of features that only work on the OpenAI Responses path: `ToolSearchTool`,
  `tool_namespace()`, `@function_tool(defer_loading=True)`, `ProgrammaticToolCallingTool`,
  `allowed_callers`, `tool_choice="programmatic_tool_calling"` — "rejected on Chat Completions."
  `reasoning.mode` and `reasoning.context` likewise.
- "Adapters add another compatibility layer between the SDK and the upstream model provider, so
  feature support and request semantics can vary by provider."
- "In cases where you do not have an API key from platform.openai.com, we recommend disabling tracing
  via `set_tracing_disabled()`" — i.e. leaving OpenAI models costs you the observability story.

So the SDK's portability is _the OpenAI-compatible Chat Completions subset_, with the good parts
fenced off on the OpenAI side. That is the same shape as agent-flows' own `transport: "api"` registry
entries (`ollama-qwen`, `litellm` — both `/v1/chat/completions`) and it has the same ceiling.

**And it does not reach the requirement at all in one specific way: there is no Claude Code path.**
Neither runtime can drive `claude -p` with `--restricted --tools Read,Glob,Grep` as a step executor.
That is the same disqualifier open-dynamic-workflows was rejected for ("keyed HTTP providers with no
Claude Code path"), and it applies here for the same reason. agent-flows' `transport: "cli"`
entries — `opus`, `sonnet`, `haiku`, `codex` — are exactly the capability neither OpenAI runtime has,
and notably one of them _is_ OpenAI's own CLI. agent-flows can drive Codex; the Agents SDK cannot
drive Claude Code.

**Direct answer: adopting the Agents API means vendor lock-in, full stop. Adopting the Agents SDK
means partial portability across API-keyed providers with a documented feature cliff, and zero
portability to a local agent CLI. Neither satisfies the requirement as stated.**

---

## 6. What I could not verify

Listed so a reader does not mistake silence for coverage.

1. **`POST /v1/agents/sessions` request fields.** The `.md` twin 404s, the HTML page is a client-side
   SPA whose source contains none of the schema, and the endpoint is absent from both
   `api/reference/llms.txt` and the combined `llms-full.txt`. I could read the _response_ shape
   (`AgentSession`) from the streaming-events reference, which is strong evidence for what an agent
   config holds, but it is not the create-request schema.
2. **How a session budget is configured.** `session_budget_exceeded` exists as a terminal failure
   code; no guide documents a field that sets it, and I could not read the create reference (1).
   T5 therefore takes the concept, not a field name.
3. **Whether any Agents API turn timeout or maximum session lifetime exists.** Searched every guide
   for expire/retention/lifetime/timeout. Only the sandbox's non-configurable one-hour idle deletion
   and the five-minute environment-connection wait are documented.
4. **Whether a subagent can run a different model from its coordinator.** `multi-agent.md` documents
   what subagents inherit (MCP tools, credentials, allowed tools, web search) and what they cannot use
   (function tools). It says nothing about model. The session schema has one `model` field on the
   agent. I could not confirm either way.
5. **Any approval mechanism in the Agents API.** F14 is an `[absent]` finding from a grep over every
   downloaded `agents-api/*` guide plus the streaming-events schema — not a documented "there is none."
   If the create reference (1) carries an approval field, F14 is wrong and §2/§5 soften accordingly.
6. **Agent Builder's actual workflow file format.** The product is behind `platform.openai.com`
   (HTTP 403 to an unauthenticated fetch) and was deprecated before I looked. `node-reference.md`
   describes the nodes; I never saw a serialized workflow, so I cannot compare its schema to
   `PipelineDef` — only its node vocabulary.
7. **Runtime behaviour of anything here.** Nothing was executed. Every SDK claim is from OpenAI's
   published reference, not from running the code. The 2026-09-06 note's probe/control discipline was
   not applied because no probe was run.
8. **The TypeScript SDK's provider surface in detail.** I read the Python reference for models and
   providers and the JS reference for human-in-the-loop. Where the two SDKs differ on provider
   integration, I did not check.
9. **Pricing.** Repeatedly deferred to `api/docs/pricing`, which I did not fetch. Nothing in §3 or §4
   depends on a price.

---

## 7. Sources consulted

**Primary — OpenAI documentation, fetched as Markdown twins on 2026-09-13.** Entry point as
specified: `https://developers.openai.com/api/docs/guides/agents`, then the guides it links.

Agents overview and SDK:

- Agents (runtime chooser) — https://developers.openai.com/api/docs/guides/agents
- Agents SDK overview — https://developers.openai.com/api/docs/guides/agents/sdk
- Agent definitions — https://developers.openai.com/api/docs/guides/agents/define-agents
- Running agents — https://developers.openai.com/api/docs/guides/agents/running-agents
- Results and state — https://developers.openai.com/api/docs/guides/agents/results
- Orchestration and handoffs — https://developers.openai.com/api/docs/guides/agents/orchestration
- Guardrails and human review — https://developers.openai.com/api/docs/guides/agents/guardrails-approvals
- Models and providers — https://developers.openai.com/api/docs/guides/agents/models
- Integrations and observability — https://developers.openai.com/api/docs/guides/agents/integrations-observability
- Sandbox agents — https://developers.openai.com/api/docs/guides/agents/sandboxes

Agents API (hosted Codex harness):

- Overview — https://developers.openai.com/api/docs/guides/agents-api/overview
- Architecture — https://developers.openai.com/api/docs/guides/agents-api/architecture
- Quickstart — https://developers.openai.com/api/docs/guides/agents-api/quickstart
- Configuring agents — https://developers.openai.com/api/docs/guides/agents-api/configuration
- Run and continue sessions — https://developers.openai.com/api/docs/guides/agents-api/sessions
- Manage sessions — https://developers.openai.com/api/docs/guides/agents-api/sessions/manage
- Events and items — https://developers.openai.com/api/docs/guides/agents-api/sessions/events
- Session webhooks — https://developers.openai.com/api/docs/guides/agents-api/sessions/webhooks
- Multi-agent — https://developers.openai.com/api/docs/guides/agents-api/multi-agent
- Tracing — https://developers.openai.com/api/docs/guides/agents-api/tracing
- Observability and usage — https://developers.openai.com/api/docs/guides/agents-api/observability
- Functions — https://developers.openai.com/api/docs/guides/agents-api/tools/functions
- MCP connections — https://developers.openai.com/api/docs/guides/agents-api/tools/mcp
- Plugins — https://developers.openai.com/api/docs/guides/agents-api/tools/plugins
- Vaults — https://developers.openai.com/api/docs/guides/agents-api/tools/vaults
- OpenAI-hosted sandboxes — https://developers.openai.com/api/docs/guides/agents-api/environments/openai-hosted
- Self-hosted sandboxes — https://developers.openai.com/api/docs/guides/agents-api/environments/self-hosted
- Sandbox lifecycle — https://developers.openai.com/api/docs/guides/agents-api/environments/lifecycle
- Sandbox security — https://developers.openai.com/api/docs/guides/agents-api/environments/security
- Files and artifacts — https://developers.openai.com/api/docs/guides/agents-api/environments/files

Platform-wide guides and reference:

- Agent Builder — https://developers.openai.com/api/docs/guides/agent-builder
- Node reference — https://developers.openai.com/api/docs/guides/node-reference
- Migrate from Agent Builder — https://developers.openai.com/api/docs/guides/agent-builder/migrate-from-agent-builder
- Deprecations (Agent Builder, 2026-06-03 / 2026-11-30) — https://developers.openai.com/api/docs/deprecations
- MCP and Connectors — https://developers.openai.com/api/docs/guides/tools-connectors-mcp
- Skills — https://developers.openai.com/api/docs/guides/tools-skills
- Background mode — https://developers.openai.com/api/docs/guides/background
- Conversation state — https://developers.openai.com/api/docs/guides/conversation-state
- Compaction — https://developers.openai.com/api/docs/guides/compaction
- Evaluate agent workflows — https://developers.openai.com/api/docs/guides/agent-evals
- **Agents streaming events reference** (the one machine-readable Agents reference; source of the
  `AgentSession`, `Turn` and `SessionTurnError` schemas) —
  https://developers.openai.com/api/reference/resources/beta/subresources/agents/streaming-events
- Documentation indexes used to enumerate the guide set — https://developers.openai.com/llms.txt,
  https://developers.openai.com/api/docs/llms.txt, https://developers.openai.com/api/reference/llms.txt

**Primary — OpenAI SDK reference (openai.github.io, OpenAI's own published SDK docs):**

- Python SDK, Models (provider integration points, mixing models, third-party adapters, Responses-only
  features) — https://openai.github.io/openai-agents-python/models/
- Python SDK, Running agents (conversation state, error handlers, exceptions, durable-orchestration
  integrations: Dapr / Temporal / Restate / DBOS) — https://openai.github.io/openai-agents-python/running_agents/
- Python SDK, `ModelSettings` reference (`retry`, `timeout`, `context_management`,
  `prompt_cache_options`) — https://openai.github.io/openai-agents-python/ref/model_settings/
- JS SDK, Human-in-the-loop (`needsApproval`, `RunState` `toString()`/`fromString()`, sticky
  decisions, `addInput()`, `onApproval`) — https://openai.github.io/openai-agents-js/guides/human-in-the-loop/

**Attempted and unreachable:**

- `https://developers.openai.com/api/reference/resources/beta/subresources/agents/subresources/sessions/methods/create.md`
  — HTTP 404 (curl and WebFetch). The HTML URL returns 200 but is a client-rendered shell containing
  none of the schema.
- `https://platform.openai.com/docs/api-reference/agents` — HTTP 403 unauthenticated.
- Agent Builder itself (`platform.openai.com/agent-builder`) — not reachable unauthenticated, and
  deprecated.

**Not used, deliberately:** no blog posts, no third-party tutorials, no cookbook articles, no
model-written summaries. Where a page was fetched through a summarising tool rather than as raw
Markdown, it was re-fetched as Markdown before being cited.

**agent-flows source read for this comparison:** `src/canon/types.ts`, `src/canon/registry.ts`,
`src/canon/loadProviders.ts`, `src/canon/assemble.ts`, `src/canon/exportSpec.ts`,
`src/canon/persistTicket.ts`, `src/runtime/artifactStore.ts`, `src/runtime/entryPoint.ts`,
`src/evals/stepOutput.ts`, `specs/030-code-review/spec.md`,
`docs/research/2026-09-06-workflow-security-prompt-injection.md`, `pipelines/*.yaml` (step-kind and
field-usage census only), `git log` for commits `db487f9`, `d3d6da8`, `81ba774`.
