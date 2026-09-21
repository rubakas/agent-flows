# Research: the third tool — OpenClaw vs Hermes vs writing it ourselves

Date: 2026-09-21. Question: which tool should provide the scheduling + Telegram + "call `af` over HTTP"
layer that sits above `agent-notes` (`an`) and `agent-flows` (`af`)?

Every claim below is cited to a primary source — the project's own docs in its repository, its
`LICENSE` file, the GitHub API, or a file on this machine — unless marked **UNVERIFIED**. Web search
was used only to locate those primaries and is cited nowhere. Notation: "P" = primary; see Sources.

Answer up front: **neither. Write it.** The reasoning is in §6; the two candidates are evaluated
honestly first, because the case for not adopting one rests on what they actually are.

---

## 1. What each candidate is

### OpenClaw

A self-hosted personal-assistant agent. One long-lived **Gateway** process is the local control plane
for sessions, tools, events and channel connections; a CLI, a TUI, a browser Control UI and native
macOS/iOS/Android/Windows apps connect to it; ~25 chat channels (Telegram, WhatsApp, Discord, Slack,
Signal, iMessage, …) bring it to your phone (P2). It has its own skills system, its own multi-agent
routing, its own model-provider config, its own memory architecture, its own plugin registry, its own
sandbox runtimes, its own node/device pairing protocol, and a scheduler it calls **automations** (P3,
P9, P15, P19, P20).

Scale: the repo is 5.5 GB and 49,214 tracked paths (P3, P42). Created 2025-11-24 — **ten months old**
(P3). MIT, `Copyright (c) 2026 OpenClaw Foundation` (P1). Stewarded by a 501(c)(3); "has no paid tier,
hosted service, or token" (P2).

### Hermes Agent

Nous Research's self-hosted personal agent — "The self-improving AI agent … the only agent with a
built-in learning loop" (P23). Same architectural shape: one **gateway** process, a TUI, a web
dashboard, a desktop app, ~25 chat platforms, its own skills system (`~/.hermes/skills/`, "the primary
directory and source of truth"), its own model routing, its own memory, its own subagent delegation,
its own cron scheduler, its own OpenAI-compatible API server (P23, P26, P30, P34).

Scale: 1.0 GB, 15,724 tracked paths (P24, P43). Created 2025-07-22 — **fourteen months old** (P24).
MIT, `Copyright (c) 2025 Nous Research` (P22). Still versioned `0.21.x` (P25).

## 2. The disambiguation — which Hermes

Three things carry the name, and two of them come from the same organisation:

1. **Hermes Agent** — `github.com/NousResearch/hermes-agent`, docs at
   `hermes-agent.nousresearch.com` (P24). A CLI/gateway agent harness. This is the reading in the
   brief: the `superpowers` plugin on this machine lists it as a supported harness with tools
   `read_file`, `write_file`, `patch`, `terminal`, `search_files`, `delegate_task`, `skill_view`, an
   instructions file at `~/.hermes/SOUL.md`, and an install line `hermes plugins install
obra/superpowers --enable` (P38).
2. **Hermes the open-weights LLM family** (Hermes 2/3/4, Nous Research). Also Nous Research. That is a
   _model_ question — which weights to run — and is orthogonal to which orchestration layer schedules
   jobs. Not evaluated here.
3. Unrelated namesakes (message buses, mail libraries). Not relevant.

**This document evaluates reading (1), Hermes Agent.** The name collision is real but not ambiguous in
context: the brief asks for a tool that owns cron and Telegram, and only reading (1) does. Note the
genuine confusion hazard for the owner's own notes: `hermes` the CLI and `Hermes-4-405B` the
checkpoint ship from the same lab and the docs cross-link (P23 recommends Nous Portal for models).

## 3. Criterion-by-criterion

| #   | Criterion            | OpenClaw                                                                                   | Hermes Agent                                                                                   | DIY                                                |
| --- | -------------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| 1   | Self-hosting reality | **Pass, cleanest** — MIT, 501(c)(3), no hosted tier; one daily version check on by default | **Pass** — MIT, but the docs steer hard at a paid Nous Portal subscription                     | **Pass by construction**                           |
| 2   | **Overlap risk**     | **High** — owns skills, agents, models, memory, and wants a _copy_ of your Codex skills    | **High** — same, plus a bundled TDD/code-review/debugging skill catalogue that duplicates `an` | **None**                                           |
| 3   | Scheduling           | **Best** — 5 schedule kinds, catch-up default on, documented retry ladder                  | Very good — cron/interval/one-shot, catch-up default on, `cron doctor`                         | Adequate — launchd coalesces missed calendar fires |
| 4   | Telegram             | First-party, strongest access control; **automation approvals never reach chat**           | First-party, QR setup; **native approve/deny buttons in Telegram**                             | Bot API directly; ~15 lines                        |
| 5   | Call local HTTP      | Generic (`--command` payload runs a shell, no model call)                                  | Generic (`--no-agent --script`, script confined to `$HERMES_HOME/scripts/`)                    | It _is_ the thing                                  |
| 6   | Multi-machine        | **Best** — node pairing, SSH-verified enrolment, per-node skills                           | Per-profile gateways on one host; desktop can attach to many                                   | One script per machine                             |
| 7   | Security             | Deepest, most granular; auth on by default                                                 | Solid 8-layer model; headless contexts deny by default                                         | Yours to write; ~1 allowlist check                 |
| 8   | Maturity             | 10 months, 390k★, 377+ contributors, 90% issue close rate, releases every ~3 days          | 14 months, 247k★, 398+ contributors, 53% close rate, still `0.x`                               | n/a                                                |

### 3.1 Self-hosting reality

**OpenClaw.** `LICENSE` is verbatim MIT with one appended line pointing at `THIRD_PARTY_NOTICES.md`
(P1). That trailing line is why the GitHub API reports `"license": "NOASSERTION"` (P3) — the badge is
wrong, the file is MIT. The README states the position directly: "State, memory, and credentials live
on your hardware… by default OpenClaw itself phones home for nothing but a daily version check,
anonymous feature statistics are opt-in, and `update.checkOnStart: false` disables both… has no paid
tier, hosted service, or token" (P2). The telemetry page confirms the shape of that one request —
`GET https://telemetry.openclaw.ai/api/latest-version` with version/OS/Node/arch in the User-Agent,
and "Anonymous feature statistics … are **off by default**" (P14). No account, no control plane.
Cloud features exist (`gateway/cloud-workers`, `gateway/cloud-sessions`) but are opt-in profiles you
point at your own infrastructure.

**Hermes.** `LICENSE` is verbatim MIT, no addenda (P22). Local install, local gateway, local state.
But the docs push a hosted product: Nous Portal is "**the recommended way to run Hermes Agent**… If
you only have time to set up one thing, set up this" (P32), and the Tool Gateway — web search, image
gen, TTS, cloud browser — "is included with every **paid** Nous Portal subscription" (P33). Both are
declines-able ("Use any model you want… no lock-in", P23), and the cron scheduler's hosted variant is
explicitly the non-default: "Local (built-in ticker) deployments don't need this" (P26). So Hermes
passes the hard constraint — but its default documented path routes both inference _and tools_
through one vendor's subscription, which is a different posture from OpenClaw's foundation.

I could not find a Hermes equivalent of OpenClaw's telemetry page. The only update checks documented
are the **desktop app's** check against `api.github.com` (P36). Whether the CLI/gateway phones home at
all: **UNVERIFIED** (absence of a doc is not absence of a request).

### 3.2 Overlap risk — the load-bearing criterion

Both candidates fail this the same way, for the same reason: **they are not trigger layers. They are
agent frameworks that happen to have a scheduler.**

`an` owns skills and agents in harness dot-directories plus a role→model resolver with per-role
budgets. `af` owns the workflow catalogue, stage semantics, and run state. Both candidates claim all
four of those concepts:

- **Skills.** OpenClaw: "Each skill lives in a directory containing a `SKILL.md` file with YAML
  frontmatter" loaded from `~/.openclaw/skills` and a registry called ClawHub (P15). And the sentence
  that should decide this on its own: "Codex CLI's native `$CODEX_HOME/skills` directory is **not** an
  OpenClaw skill root. Use `openclaw migrate plan codex` to inventory those skills, then `openclaw
migrate codex` to **copy them into your OpenClaw workspace**" (P15, emphasis mine). It does not read
  your harness skills — it forks them into a second source of truth. That is precisely the two-tools-
  one-concept failure the owner has been burned by twice.
- Hermes: "All skills live in **`~/.hermes/skills/`** — the primary directory and source of truth…
  The agent can modify or delete any skill" (P30). Its bundled catalogue includes
  `software-development-test-driven-development`, `software-development-requesting-code-review`,
  `software-development-systematic-debugging`, `software-development-spike` and
  `software-development-simplify-code` (P44) — name-for-name the superpowers skills `an` already
  installs on this machine (P38). Two catalogues, two update paths, one concept.
- **Model selection.** OpenClaw: per-job `--model`, `--fallbacks`, `--thinking` (`off` … `ultra`),
  plus a whole model-provider config domain (P9, P41). Hermes: a three-level resolution chain
  (per-job pin → `cron.model` → main agent model) and per-job `--reasoning-effort` (P26). Both
  reimplement `an`'s role→model-with-budget idea at a different granularity, and neither can read
  `an`'s resolver — nor should it, per ADR-0019 D6.
- **Agents.** OpenClaw has `multiAgent.*` routing and per-agent workspaces (P41). Hermes has
  `delegate_task` subagents and per-profile agents (P38, P23).
- **Identity file.** Both landed on the same name: OpenClaw `docs/concepts/soul.md`, Hermes
  `~/.hermes/SOUL.md` (P42, P38). Adopting either adds a third place where "who the agent is" lives.

#### And a fourth concept: workflows — the largest overlap of all

Both candidates ship work-orchestration layers that overlap `af` directly, and they overlap it in
_different places_: Hermes on the durable runtime, OpenClaw on the definition language.

**Hermes.** The comparison is Kanban, not
`delegate_task`** — Hermes says so itself. `delegate_task` is fork/join RPC, and its own table (P47,
"Kanban vs. `delegate_task`") rules it out on the two properties `af` exists for: resumability
"**None — failed = failed**" vs "Block → unblock → re-run; crash → reclaim"; human in the loop
"**Not supported**" vs "Comment / unblock at any point"; audit trail "Lost on context compression" vs
"Durable rows in SQLite forever". Its one-line summary: "`delegate_task` is a function call; Kanban is
a work queue where every handoff is a row any profile (or human) can see and edit."

**The axis that separates Kanban from `af`: where the graph comes from.** Kanban's graph is _rows
built at runtime_ — `task_links` parent→child edges where "The dispatcher promotes `todo → ready` when
all parents are `done`" (P47). It is authored by an orchestrator model calling
`kanban_create(… parents=[…])`, by a human on the CLI, by `hermes kanban swarm` (one hard-coded
root→workers→verifier→synthesizer topology), or — by default, `kanban.auto_decompose: true` — by an
LLM decomposer that "fans the task out into a small graph of child tasks routed to the best-fit
specialists" (P47). `af`'s graph is a _declared file_: YAML steps with explicit `dependsOn` edges and
nested pipelines composed by reference, which can be diffed, reviewed, versioned and forked.

**What Hermes genuinely does better than `af` today.** Two things, and they are not small:

- **The durable-run substrate.** Three tables in `~/.hermes/kanban.db`: `tasks`, `task_runs` (one row
  per attempt, closed with an `outcome`), and append-only `task_events` carrying `run_id`. The
  dispatcher "reclaims stale claims, reclaims crashed workers (PID gone but TTL not yet expired)",
  matching "by PID **and** spawn-time fingerprint, so a recycled PID is never signalled"; a circuit
  breaker auto-blocks after `kanban.failure_limit` consecutive spawn failures; `block_loop_detected`
  breaks unblock↔re-block cycles; orphan reconciliation requeues cards left `running` with broken
  claim bookkeeping (P47).
- **Multi-process worker isolation.** Each worker is a full OS process spawned as `hermes -p <assignee>`
  with its own profile, injected `HERMES_HOME`, log file, and workspace — `scratch`, `dir:<abs path>`,
  or a git `worktree` under `.worktrees/<id>/` (P47). `af` runs steps through provider adapters inside
  one daemon.

**What it lacks against `af`.** Four gaps, each load-bearing:

- **No declared graph artifact** — there is nothing to fork, and no bundled catalogue of process
  definitions (§ above).
- **No per-step permissions.** The full `hermes kanban create` option set is `--body`, `--assignee`,
  `--parent`, `--tenant`, `--workspace`, `--branch`, `--priority`, `--triage`, `--idempotency-key`,
  `--max-runtime`, `--max-retries`, `--goal`, `--goal-max-turns`, `--skill`, `--json` — no toolset or
  permission flag anywhere in it (P47). Tool access is scoped
  per _profile_ and per session; the documented pattern is profile-level ("pair it with a profile whose
  toolsets are restricted to board operations … so the orchestrator literally cannot execute
  implementation tasks even if it tries", P47), and `delegate_task` "does not accept a model-facing
  `toolsets` parameter" (P48). The stated threat model is "the worker runs with your uid. This is the
  trusted-local-user threat model" (P47). **ADR-0019's "Refuses" column has no expression in Hermes.**
- **Schema only on the ephemeral primitive.** `delegate_task` takes an `output_schema` the child's
  answer must validate against, with "exactly one bounded correction turn carrying the validation
  errors verbatim" (P48) — close to what `af` ships. But durable Kanban cards have no schema: their
  handoff field is `metadata`, "free-form JSON dict on the run" (P47), unvalidated.
- **Convergence by LLM judge, not a deterministic check.** Goal-mode cards (`--goal` plus
  `--goal-max-turns N`, default 20) run a loop where "after every turn an auxiliary judge checks the
  worker's output against the card's title + body (treated as the acceptance criteria)" (P47, P49).
  `af`'s `kind: loop` converges on a check command. Different reliability class; Hermes has no "loop
  this sub-pipeline until this command exits 0".

**Forward-looking warning.** Hermes has reserved the schema for the piece it is missing (P47, "Forward
compatibility"):

> Two nullable columns on `tasks` are reserved for v2 workflow routing: `workflow_template_id` (which
> template this task belongs to) and `current_step_key` (which step in that template is active). The v1
> kernel ignores them for routing but lets clients write them, so a v2 release can add the routing
> machinery without another schema migration.

`hermes kanban list` already accepts `--workflow-template-id` and `--current-step-key` as filters
against columns nothing writes for routing (P47). **If a v2 ships a workflow-template format, this
overlap moves from partial to near-total** — the declared-graph distinction above is the whole of
what currently separates the two.

**Net for `af` vs Hermes:** partially redundant, not redundant. Hermes owns the runtime substrate;
`af` owns the definition language and the per-step guarantees. No per-run cost or token accounting
tied to a Kanban run appears anywhere in the docs — `hermes insights` exists ("Show token/cost/activity
analytics", P50) but is never connected to `task_runs`: **UNVERIFIED**.

**OpenClaw has three multi-step primitives, not one, and none is the default.** This is the closer
overlap of the two, and it lands on the axis Hermes misses:

- **Lobster** (P51) — "**Typed workflow runtime for OpenClaw with resumable approval gates**", an
  **optional** plugin (`openclaw plugins install @openclaw/lobster`, then `tools.alsoAllow`). It runs
  `.lobster` YAML/JSON **workflow files** with `name`, `args`, `steps`, `env`, `condition` and
  `approval` — steps carry an `id`, a `run:`/`command:` shell or `pipeline:` stage, `stdin:
$step.stdout` / `$step.json` / `$step.json.<field>` references to prior steps, `when:`/`condition:`
  gating, and per-step `retry`, `timeout_ms`, `on_error: continue|skip_rest` and `for_each` (P52).
  Its self-description is almost `af`'s: "a small, constrained DSL rather than a general scripting
  language: approve/resume is a durable, built-in primitive; **pipelines are data (easy to log, diff,
  replay, review)**" (P51). **This is a declared, forkable, versionable workflow file — the thing
  Hermes does not have.** Paired with the optional `llm-task` tool it also gets a schema-validated
  model step: "a single JSON-only LLM call … optionally validated against a JSON Schema", with
  `defaultProvider` / `defaultModel` / `allowModelOverride` / `allowedCompletionModels` (P53).
  **The limit:** steps are an ordered list joined by a single `stdin`, plus `env`/`condition`
  references. There is no `depends_on`, no `needs`, and no parallel or fan-out/join keyword anywhere
  in the tool docs or the upstream repo — `for_each` iterates items inside one step, and its retry
  "restarts at the first item" (P51, P52). It is a **pipe, not a DAG**.
- **Workboard** (P54) — a bundled-but-disabled plugin (`openclaw plugins enable workboard`) that is
  Hermes Kanban's shape almost feature for feature: cards with statuses
  `triage|backlog|todo|scheduled|ready|running|review|blocked|done`, and `workboard_link` — "Link a
  parent to a child card. **Children stay `todo` until every parent reaches `done`**, then dispatch
  promotion moves them to `ready`" — plus `workboard_decompose`, per-card skills, retry budget,
  runtime limit, claims/heartbeat/release, proof and artifacts, and parent results in a child's
  context. Templates exist but "prefill title, notes, labels, and priority" for one card — not a graph.
- **Task Flow** (P55) — "the orchestration layer above background tasks… a durable record of
  multi-step work with its own status, JSON state, revision counter, and linked task records", in the
  `flow_runs` table of `~/.openclaw/state/openclaw.sqlite`, with optimistic concurrency on `revision`.
  Its own table routes "Multi-step pipeline driven by plugin code" here — a managed flow is advanced
  by **a TypeScript controller you write**, and "Durability covers records, not a JavaScript call
  stack or automatic scheduling."

OpenClaw's subagent primitive is `sessions_spawn` + `sessions_yield` + `subagents` (P56), with
per-child `model` and `thinking` overrides, `context: fork|isolated`, optional managed worktree, and a
default spawn depth limit of 5 — a per-child model override Hermes's `delegate_task` explicitly lacks.

**Net for `af` vs OpenClaw:** Lobster overlaps `af`'s definition language directly and is the single
closest thing to `af` in either candidate — but it is a linear pipe with no DAG, no per-step
permissions model, and it arrives as an optional plugin on top of the whole Gateway. Workboard
re-implements Hermes Kanban. Task Flow is a durable record you drive from code you write. Nothing in
OpenClaw expresses ADR-0019's "Refuses" column either. **UNVERIFIED:** whether a plain (non-Task-Flow)
Lobster run survives a reboot — resume state is "small JSON files under the Lobster state directory
(`~/.lobster/state`)" and the docs say only that flow state persists in SQLite while "Lobster's
approval checkpoint is separate and must also remain available for resume" (P51).

**Can either be used as a thin trigger-and-notify layer?** Yes — and this is the honest part. Both
ship a no-model scheduled payload:

- OpenClaw: "Command payloads run deterministic scripts inside the Gateway scheduler **without
  starting a model-backed turn**… capture stdout/stderr… and reuse the same `announce`, `webhook`, and
  `none` delivery modes" (P9). The worked example in the docs is literally the shape we want:

  ```bash
  openclaw automations create "*/15 * * * *" --name "Queue depth probe" \
    --command "scripts/check-queue.sh" --command-cwd "/srv/app" \
    --announce --channel telegram --to "-1001234567890"
  ```

  "non-empty stdout wins… A command that prints only `NO_REPLY` … posts nothing back to chat" (P9).
  Agent tools can be cut to nothing independently: `--tools ""` is "an empty allowlist that disables
  all agent tools" (P9), and any individual skill can be killed with `entries.<skillKey>.enabled:
false` (P16).

- Hermes: `no_agent` mode — "a script on a schedule, its stdout delivered verbatim, **zero LLM
  involvement**"; "Empty stdout → silent tick, no delivery"; "No tokens, no model, no provider
  fallback — the job never touches the inference layer" (P26). Skills can be skipped at install with
  `--no-skills`, and that stays empty across updates (P30).

So yes, both _can_ be reduced to cron-with-a-Telegram-sink. But look at what that costs: you install
a 5.5 GB / 49k-file (or 1.0 GB / 15.7k-file) agent framework, a second skills tree, a second model
config, a second identity file, a second memory system and a second plugin registry — and then use
one flag on one payload kind. The reduction is possible; the residue is not.

### 3.3 Scheduling

**OpenClaw** is the stronger scheduler on the merits. Five schedule kinds — `at`, `every`, `cron`
(5- or 6-field, `--tz` IANA), `on-exit` (fire when a watched command exits) and `stream` (fire from
batched lines of a supervised long-running command) — plus condition-trigger scripts that gate any
time or stream schedule on `{fire, message?, state?}` (P6). Jobs and run history live in shared SQLite,
"so restarts do not lose schedules" (P7).

- _Sleep/reboot_: `cron.skipMissedJobs` defaults to `false` — i.e. **catch up by default**; setting
  it true makes missed `cron`/`every` slots "advance to their next future occurrence instead of
  catching up, avoiding stale reminders… at the cost of dropping missed work", with one-shot `at` jobs
  catching up either way (P8). On restart, overdue agent-turn jobs are "rescheduled instead of replayed
  immediately, keeping model/tool execution out of scheduler startup" (P7).
- _Retries_: "transient errors… use a built-in retry schedule. Permanent errors disable the job
  immediately. **Recurring retry**: consecutive execution errors back off on an extended schedule
  (30s, 60s, 5m, 15m, 60m). Backoff resets after the next successful run." (P8)
- Also: per-run wall-clock budgets, a 60-minute scheduler watchdog, dynamic pacing bounds, and a
  documented croner gotcha (day-of-month and day-of-week are OR, not AND) (P6, P7).

**Hermes** is close and has one thing OpenClaw lacks a direct analogue of. `cron.catch_up_missed`
defaults to `true`; the opt-out re-anchors a job "later than its existing grace window (half its
period, clamped to 120 seconds–2 hours)… to its next future occurrence without firing now. The skip is
logged." (P26). `cron.retry_unreachable` defaults true. It parks jobs through a provider's stated
quota window rather than re-firing into a guaranteed failure. And `hermes cron doctor` is a read-only
fleet health check that exits `1` while any finding stands, including the one that actually bites —
"`next_run_at` missing, or parked in the past beyond a 15-minute ticker grace window — the 'job is
silently not firing' signal" (P26). That is a falsifiable gate on your scheduler, which is exactly the
kind of thing this owner keeps having to add by hand.

### 3.4 Telegram

Both are first-party channels, not plugins, and both are cheap to set up (BotFather token → config).

**OpenClaw**: `dmPolicy` of `pairing` (default) / `allowlist` / `open` / `disabled`, numeric-user-ID
allowlists, group allowlists with mention gating, forum-topic targeting (`-100…:topic:123`), and
per-DM and per-sender _tool policy_ — `channels.telegram.direct.<chatId>.tools` with `deny: ["write",
"edit"]` (P11, P12). First-DM pairing approval also seeds `commands.ownerAllowFrom` (P12). This is the
better access-control story of the two.

**Replies back.** This is where they diverge, and it matters for `af`'s human-gated `ship`:

- OpenClaw forwards _interactive_ exec approvals to chat — "You can forward exec approval prompts to
  any chat channel (including plugin channels) and approve them with `/approve`… A bare `/approve` or
  an invented ID cannot approve a command" (P18); Matrix additionally seeds `✅`/`♾️`/`❌` reaction
  shortcuts (P17). **But for scheduled jobs it explicitly refuses**: "Approvals raised by gateway-host
  automation (cron) runs are delivered only to connected exec approval clients: the Control UI, the
  macOS/iOS/Android apps, and API clients that declare the `approvals` … capability. The TUI does not
  render exec approval cards, and **chat channels never receive automation approvals**… With no
  approval surface connected, the request is denied immediately" (P17). So "approve from the phone"
  works through the OpenClaw iOS/Android app, not through Telegram, for anything cron-initiated.
- Hermes routes approvals to Telegram natively: the destructive-action dialog is a "Three-option
  dialog (Approve Once / Always Approve / Cancel) routed through **native yes/no buttons on Telegram,
  Discord, and Slack**; text fallback elsewhere" (P29). Its headless defaults are conservative —
  `cron_mode: deny` and `unattended_mode: deny`, because "These surfaces have no human who can answer
  `/approve`" (P29).

Note carefully what both of those are approving: _the tool's own shell commands_, not `af`'s gate.
`af`'s `ship` gate is `manualOnly: true` and is resolved by `POST /api/runs/:id/approve` with
`{approved: boolean, reason?: string}` (P41). Getting that from a phone means: Telegram message →
something runs `curl`. Both candidates can do that; so can 15 lines.

### 3.5 Calling a local HTTP service

Neither has a first-class HTTP-request tool. OpenClaw's built-in tool config covers `exec`, web search
and web fetch (P45); Hermes's registry has `terminal`, `web_search`, `web_extract` — `web_extract`
requires one of five third-party API keys and is a page-reader, not an API client (P31). In both, "POST
to `http://127.0.0.1:<port>/api/runs`" means **shell out to `curl`**. That is a generic capability in
both, not a product feature.

Two sharp edges worth knowing before either is adopted:

- **OpenClaw refuses loopback for outbound webhook delivery by default.** "Every outbound automation
  webhook uses the strict SSRF guard. Loopback, private/internal, link-local, and other special-use
  targets are refused by default." You must name it: `cron.webhookSsrfPolicy.allowedHostnames:
["127.0.0.1"]` (P10). Right default, surprising the first time; it does not affect `--command` payloads.
- **Hermes confines `no_agent` scripts to `$HERMES_HOME/scripts/`** — "relative names, absolute paths,
  and `~`-prefixed paths are accepted when the resolved target stays in that directory; paths that
  escape it are rejected" — and sanitises their environment: "provider API credentials and other
  Hermes-managed secrets are **not** inherited by cron scripts" (P26). So the script that calls `af`
  cannot live in your repo, and `GH_TOKEN` would need explicit re-provision.

Inbound is symmetric and fine in both: OpenClaw has Gateway HTTP hooks (P46) and Hermes has webhook
subscriptions with `cron_job` event-triggered firing (P26).

### 3.6 Multi-machine

**OpenClaw** is clearly built for it: one Gateway plus paired **nodes**, with device pairing gating the
WebSocket handshake, SSH-verified auto-approval of first-time node pairing (the Gateway SSHes back and
approves "only on an exact `openclaw node identity` device-key match"), CIDR allowlists, per-node
command allow/deny, node-hosted skills that appear and disappear with the node, and `remote.transport`
of `ssh` or `direct` ws/wss (P19, P41). State is shared SQLite on the execution host (P17).

**Hermes** documents multiple _profiles_ as separate supervised gateways on **one** machine — each
with its own bot tokens, sessions and memory, via LaunchAgent / systemd unit / Scheduled Task — and
points cross-machine users at a desktop app that connects to several instances (P35). There is no
node/device fabric equivalent. For "I install across several computers", OpenClaw's model fits better.

Relevant constraint from our side: `af` runs **one daemon per project**, on the machine holding the
repo, on port 7411 by default but on an **ephemeral port** when auto-started, with the live port
recorded in `~/.agent-flows/projects/<key>/daemon.json` (P41). So whatever schedules the job must
either be on that machine or reach it, and it must read the port from that file rather than hardcode 7411. Neither candidate makes that easier than a two-line `jq`.

### 3.7 Security

The threat model here is real: this layer accepts messages from the internet and can trigger `git add
-u && git commit` and `gh pr create` via `af`'s `ship` stage (P41).

**OpenClaw** has the deepest story. Gateway binds `loopback` by default; "**Auth**: required by
default. Non-loopback binds require gateway auth… Onboarding wizard generates a token by default";
`gateway.auth.mode: "none"` exists but is "intentionally not offered by onboarding prompts" (P41-cfg).
There is a failed-auth rate limiter with lockouts, browser-origin throttling that disables the loopback
exemption "as defense-in-depth against browser-based localhost brute force", trusted-proxy identity
mode, named operator roles with a closed scopes ceiling, and `gateway.tools.deny` for the HTTP
`POST /tools/invoke` surface (P13). Exec approvals are per-host documents in SQLite with
allow-once / allow-always / deny, where "`allow-always` means **always allow here**: the generated
grant is tied to the command's exact arguments and current working directory" and automation-raised
approvals mint a scoped standing grant bound to "that exact agent, automation, job configuration, and
operation" instead of a blanket allowlist entry (P17, P21). Sandbox runtimes are Docker/Podman/SSH/
OpenShell with an `openclaw sandbox explain` that prints the effective policy (P20). Crucially,
**command payloads are an admin surface, not an agent surface**: "Creating, updating, removing, or
manually running automation jobs requires `operator.admin`… Agent exec policy … governs model-visible
exec tools, not command payloads" (P9).

**Hermes** publishes an eight-layer model: user authorization, dangerous-command approval, file-write
denylist plus optional write sandbox, container isolation, MCP credential filtering, **context-file
prompt-injection scanning**, cross-session isolation with path-traversal-hardened cron storage, and
working-directory input sanitisation (P29). `approvals.mode` defaults to `smart` (an auxiliary LLM
triages; uncertain cases escalate to a human), and the three headless contexts — cron, `-q`, and
webhook/API — all default to `deny`. Its API server uses bearer auth (P34). The webhook path has a
hard-fail guard with a CVE reference: `TELEGRAM_WEBHOOK_SECRET` is "**Required whenever
`TELEGRAM_WEBHOOK_URL` is set** — the gateway refuses to start without it (GHSA-3vpc-7q5r-276h)" (P36).

Both are credible. But note what neither fixes: **`af`'s daemon is unauthenticated** — there is no
`Authorization`, bearer, or token handling anywhere in `src/serve/server.ts`, and `POST
/api/runs/:id/approve` accepts any caller (P41). Putting either candidate in front of it does not add
a boundary; it adds one more process that can cross it. The security work here is on `af`, not on the
choice of third tool.

### 3.8 Maturity

|                         | OpenClaw                | Hermes Agent                           |
| ----------------------- | ----------------------- | -------------------------------------- |
| Created                 | 2025-11-24 (10 mo)      | 2025-07-22 (14 mo)                     |
| Stars / forks           | 390,160 / 82,049        | 247,467 / 52,053                       |
| Contributors (non-anon) | 377 pages @1            | 398 pages @1                           |
| Open issues (excl. PRs) | 5,258                   | 13,735                                 |
| Closed issues           | 49,682                  | 15,722                                 |
| Close rate              | 90%                     | 53%                                    |
| Issues opened, last 30d | 6,784                   | 6,351                                  |
| Commits, last 7d        | ≥100 (page cap)         | ≥100 (page cap)                        |
| Latest release          | `v2026.9.5`, 2026-09-19 | `v2026.9.14` = **v0.21.3**, 2026-09-14 |

(P3, P4, P5, P24, P25.)

Both are enormous, both are frantic, both are **younger than a year and a bit**. On the numbers
OpenClaw is healthier: it closes issues roughly nine times out of ten against Hermes's one in two, and
Hermes's 13.7k open issues is not a backlog so much as a weather system. Against that, Hermes is four
months older and OpenClaw is still visibly renaming its own primitives.

**Breaking-change record.** Both change fast and both ship migrations rather than compatibility.
OpenClaw renamed `cron` → `automations` recently enough that "the tool still accepts its legacy `cron`
name as a compatibility alias" and the CLI page is still `docs/cli/cron.md` (P9, P42); heartbeat
`tasks:` blocks, `~/.openclaw/cron/jobs.json` legacy stores and `tools.call('exec', …)` trigger scripts
all require `openclaw doctor --fix` to convert, and `controlUi.toolTitles` was simply "retired" (P6,
P8, P13). Hermes is on `0.21.x` with a `migrate-from-openclaw` guide, an `import-from-other-agents`
guide, and `hermes migrate relay` converting removed env vars (P36, P43). Neither has a stability
promise. For a tool the owner wants to still work in a year across several machines, that is the real
maturity finding — not the star counts.

## 4. Where each would actually land in this system

Both would sit outside `af` and call it over HTTP, which `af` supports fine: `POST /api/runs` returns
immediately, `GET /api/runs/:id` polls, `GET /api/runs/:id/events` is the SSE stream, `POST
/api/runs/:id/approve` resolves the gate, `POST /api/runs/:id/cancel` aborts (P41). Neither would need
to understand pipelines, stages, or prompts. The integration is genuinely small — which is the point.

The three intended jobs map cleanly in both:

| Job                                  | Shape                                                                                                                                              |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| "review the PRs assigned to me"      | schedule → `gh pr list --search "review-requested:@me"` → for each, `POST /api/runs` with `pipeline: code-review` → poll → post a one-line verdict |
| "develop the ticket assigned to me"  | schedule → fetch ticket → `POST /api/runs` with `cycle-dev` → notify at the gate                                                                   |
| "does this ticket have enough info?" | schedule → fetch ticket → `POST /api/gate-judge` (already a stateless judge-as-a-service endpoint, P41) → post yes/no                              |

Note the third needs no agent at all — `af` already exposes the judge. That is a small but telling
data point: the "intelligence" the third tool would supposedly bring is already in `af`.

## 5. The third candidate: write it

What the layer must do, stated exactly:

1. Fire on a schedule, surviving sleep and reboot.
2. `POST http://127.0.0.1:<port>/api/runs`, poll `GET /api/runs/:id`, read a field or two.
3. `POST https://api.telegram.org/bot<token>/sendMessage` with `chat_id` and `text`.
4. Read replies and, for an approval, `POST /api/runs/:id/approve`.
5. Only listen to one Telegram user id.

Each of those is primary-source-verifiable as small:

- **Telegram.** "All queries to the Telegram Bot API must be served over HTTPS and need to be
  presented in this form: `https://api.telegram.org/bot<token>/METHOD_NAME`". `sendMessage` requires
  exactly `chat_id` and `text`. `getUpdates` requires **no** parameters and needs no public endpoint —
  it long-polls; "This method will not work if an outgoing webhook is set up", so polling and webhooks
  are an either/or, and polling is the one that needs no TLS, no domain, and no inbound port (P39).
  Every update carries `from.id`, so the allowlist is one integer comparison.
- **Scheduling on macOS.** launchd is strictly better than cron here, and its man page says why:
  "Unlike cron which skips job invocations when the computer is asleep, **launchd will start the job
  the next time the computer wakes up**. If multiple intervals transpire before the computer is woken,
  those events will be coalesced into one event upon wake from sleep." — for `StartCalendarInterval`.
  The counterpart warning matters just as much: with `StartInterval`, "If the system is asleep during
  the time of the next scheduled interval firing, that interval will be missed" (P40). So: use
  `StartCalendarInterval`, get catch-up-with-coalescing for free, which is the same semantic OpenClaw
  and Hermes both implement in application code and both default to.
- **Finding `af`.** Read `port` from `~/.agent-flows/projects/<key>/daemon.json` — the record `doctor`
  already reads, which "records pid … on port …" (P41). Two lines of `jq`.
- **Retries and failure alerts.** A non-zero exit sends one Telegram message. A `while` loop with
  `sleep` covers the retry ladder both candidates hard-code.

That is a LaunchAgent plist plus one script per job, sharing a ~40–80 line helper. It is the only
option of the three that adds zero new owners of skills, agents, prompts or model selection — and
therefore the only one that cannot repeat the failure the owner has already hit twice.

What DIY genuinely gives up, stated without softening:

- **A run ledger for the trigger layer itself.** Both candidates keep durable per-job run history,
  incident records and failure-alert cooldowns (P8, P26). You would have `launchctl list`, a log file,
  and whatever `af` already records for the runs it started. For three jobs that is fine; for thirty
  it is not.
- **Operational self-diagnosis.** `hermes cron doctor`'s "job is silently not firing" check (P26) is
  a real thing you would otherwise never write, and silent non-firing is the exact failure mode of
  hand-rolled schedulers.
- **Rich chat.** Voice notes, images, threads, inline buttons, group routing, mention gating. You get
  `sendMessage` and an `if`.
- **Everything else in the box** — which is the point: you don't want everything else in the box.

## 6. Recommendation

**Do not adopt either. Write the layer.** Concretely: one LaunchAgent per job with
`StartCalendarInterval`, one shared shell/TS helper that (a) resolves the port from `daemon.json`,
(b) starts the run and polls, (c) posts to `sendMessage`, and (d) long-polls `getUpdates` filtered to a
single `from.id` for approvals. Keep it in this repo, under `af`'s ownership, as a thin client — not a
new tool with its own name and its own config directory.

The reasoning, in the owner's own priority order:

1. Criterion 2 dominates and both candidates fail it. Neither is a scheduler with a chat sink; both
   are complete agent frameworks that would install a second skills tree, a second model-selection
   mechanism, a second agent registry and a second identity file next to `an` and `af`. OpenClaw's own
   docs say the quiet part: it wants to `migrate codex` your existing skills **into its workspace**
   (P15). Hermes ships a bundled `software-development` skill catalogue that duplicates, by name, what
   `an` already installs (P44, P38).
2. The part of either tool you would actually use — one scheduled `--command` / `--no-agent` payload
   whose stdout goes to Telegram (P9, P26) — is a rounding error against 5.5 GB / 1.0 GB of
   installation. When the vendor's own thin path is "run a shell script on a timer and post stdout",
   the honest read is that this is not a product-sized problem.
3. The remaining criteria don't rescue them. Scheduling: launchd already gives catch-up-with-coalescing
   (P40), the one scheduling property that actually matters for a laptop that sleeps. Telegram: the Bot
   API is two HTTPS calls (P39). HTTP: neither candidate makes it first-class anyway — both shell out
   to `curl` (P31, P45). Security: neither fixes `af`'s unauthenticated daemon, which is the actual
   hole (P41).
4. Maturity argues against adopting _now_ regardless of which. Ten and fourteen months old, `0.x` in
   one case, an active primitive rename in the other, no stability promise in either, and a
   migration-tool-per-release cadence (P6, P8, P25, P42). Betting a cross-machine automation layer on
   that, this early, is the risk the owner said he is wary of.

**What would change this — each is falsifiable:**

- **The job list grows past ~5–8, or gains conditional/event triggers.** Once you want "fire when this
  command exits", "fire on a line from a supervised process", "back off and park through a provider
  quota window", or "tell me when a job has silently stopped firing", you are writing a scheduler. At
  that point adopt **OpenClaw**, whose `on-exit` and `stream` schedules, condition-trigger scripts,
  documented retry ladder and default catch-up (P6, P7, P8) are strictly ahead of what you would write.
- **Approving from the phone becomes daily, with rich buttons.** If tapping ✅ in Telegram matters more
  than a text reply, **Hermes** has the better answer today — native approve/deny buttons on Telegram
  (P29) — against OpenClaw's explicit refusal to send automation approvals to chat at all (P17). This
  only flips the decision if the DIY reply path (a message whose text names a run id) proves too
  error-prone in practice; test that before switching.
- **A second, non-`af` consumer appears** — a personal assistant that reads mail, drives a calendar,
  answers from your phone. Then you are buying an assistant, not a trigger layer, and criterion 2 no
  longer applies because the overlap would be intentional. Take **OpenClaw**: cleaner governance (MIT,
  501(c)(3), no hosted tier, P1/P2), better multi-machine story (P19), better access control (P12),
  and a far healthier issue-close rate (P5).
- **Both projects reach a stability promise** — semver, a deprecation policy, a year without a
  primitive rename. Re-evaluate then; the argument in §6.4 evaporates and only criterion 2 remains.

If forced to pick one today despite all of the above: **OpenClaw**, on self-hosting posture,
multi-machine fit, scheduler depth and maintenance health — accepting that its automation approvals
never reach Telegram and that it will want to own a copy of your skills.

## 7. What I could not verify

1. **Whether Hermes's CLI/gateway phones home.** OpenClaw publishes a telemetry page (P14); Hermes has
   no equivalent doc. The only documented update check is the desktop app's, against `api.github.com`
   (P36). Absence of a doc is not absence of a request — **UNVERIFIED**.
2. **Neither tool was installed or run.** Everything about behaviour comes from each project's own
   docs in its own repository, not from observation. No cron job was created, no Telegram bot paired,
   no `curl` to `127.0.0.1` executed from inside either scheduler.
3. **Contributor counts are floors, not exact.** They are the last page number from
   `contributors?per_page=1` (377 and 398), which GitHub caps and which excludes anonymous
   contributors (P3, P24).
4. **"Commits in the last 7 days" is capped at the 100-item page** for both — the true number is ≥100,
   and the two are not distinguishable at that resolution (P5).
5. **Whether OpenClaw's iOS/Android app is a practical approval surface for this owner.** The docs say
   automation approvals reach "the macOS/iOS/Android apps" (P17); whether that is pleasant in practice,
   and whether it requires the Gateway to be reachable from the phone's network, was not tested.
6. **Actual disk/RAM footprint of either gateway at rest.** Repo size (5.5 GB / 1.0 GB per the GitHub
   API, P3/P24) is not install size, and neither project documents a resident-memory figure I found.
7. **Hermes's `0.21.x` → `1.0` intentions.** No roadmap or stability statement was located in the repo.
8. **The exact DIY line count.** "~40–80 lines" is my estimate from the verified API shapes (P39, P40,
   P41), not a written and measured implementation.
9. **Per-run cost or token accounting on a Kanban run.** `task_runs` records `outcome`, `summary` and
   free-form `metadata`, and `hermes insights` reports "token/cost/activity analytics" (P47, P50), but
   nothing in the docs ties the two together and nothing records which model actually answered a card.
   **UNVERIFIED** — absence in the docs, not proof of absence.
10. **Whether Hermes's v2 workflow routing exists in code.** The reserved columns and the CLI filters
    are documented (P47); no template format, schema or release note for it was located. Treated here
    as a stated intention, not a shipped feature.

---

## Sources

Primary — OpenClaw (all paths relative to `github.com/openclaw/openclaw`, branch `main`, read
2026-09-21):

- P1 `LICENSE` — MIT, "Copyright (c) 2026 OpenClaw Foundation", plus a trailing pointer to
  `THIRD_PARTY_NOTICES.md`
- P2 `README.md` — "**Yours, with no catch.**… by default OpenClaw itself phones home for nothing but
  a daily version check, anonymous feature statistics are opt-in, and `update.checkOnStart: false`
  disables both… stewarded by the OpenClaw Foundation, an independent 501(c)(3), and has no paid tier,
  hosted service, or token"
- P3 `https://api.github.com/repos/openclaw/openclaw` — created `2025-11-24T10:16:47Z`, 390,160 stars,
  82,049 forks, `license: NOASSERTION`, `size: 5559052`
- P4 `https://api.github.com/repos/openclaw/openclaw/releases` — `v2026.9.5` 2026-09-19, `v2026.9.4`
  2026-09-11, `v2026.9.3` 2026-09-08, `v2026.9.2`, `v2026.9.1`, `v2026.8.2`…
- P5 `https://api.github.com/search/issues` — `is:issue is:open` 5,258; `is:closed` 49,682;
  `created:>2026-08-21` 6,784. Same queries for Hermes under P24
- P6 `docs/automation/cron-jobs/schedules.md` — "## Schedule types" table (`at`/`every`/`cron`/
  `on-exit`/`stream`), "### Stream sources", "### Dynamic cadence (pacing)", "### Day-of-month and
  day-of-week use OR logic", "## Event triggers (condition watchers)"
- P7 `docs/automation/cron-jobs/how-it-works.md` — "## How automations work" (Gateway-process
  scheduler, SQLite persistence, startup catch-up), "Isolated run hardening", "Task reconciliation"
- P8 `docs/automation/cron-jobs/managing-jobs.md` — "Retry behavior" accordion (30s/60s/5m/15m/60m),
  `cron.skipMissedJobs` default `false`, "Maintenance", "Legacy store migration"
- P9 `docs/automation/cron-jobs/payloads.md` — "## Payloads" table, "### Agent-turn options"
  (`--model`, `--fallbacks`, `--thinking`, `--tools ""`), "### Command payloads" (worked Telegram
  example, `operator.admin` requirement, stdout/`NO_REPLY` semantics), "### Script payloads"
- P10 `docs/automation/cron-jobs/delivery.md` — "## Delivery and output" table
  (`announce`/`webhook`/`none`), the SSRF `<Warning>` block with `cron.webhookSsrfPolicy`,
  `--announce --channel telegram --to`
- P11 `docs/channels/telegram/setup.md` — BotFather flow, `channels.telegram` config block,
  `openclaw pairing approve`
- P12 `docs/channels/telegram/access-control.md` — "DM policy" tab (`pairing`/`allowlist`/`open`/
  `disabled`), `allowFrom` numeric IDs, `commands.ownerAllowFrom`, `direct.<chatId>.tools`
- P13 `docs/gateway/config-gateway.md` — `bind` modes, "**Auth**: required by default…",
  `gateway.auth.mode: "none"`, `gateway.auth.rateLimit`, `gateway.roles`, `gateway.tools.deny/allow`
- P14 `docs/gateway/telemetry.md` — daily `GET https://telemetry.openclaw.ai/api/latest-version`,
  "Anonymous feature statistics … are **off by default**", `openclaw telemetry show`
- P15 `docs/tools/skills.md` — `SKILL.md` + frontmatter, `~/.openclaw/skills`, the `<Note>` on
  `$CODEX_HOME/skills` and `openclaw migrate codex`, node-hosted skills
- P16 `docs/gateway/config-extensions.md` — `entries.<skillKey>.enabled: false`, `skills.limits.*`
- P17 `docs/tools/exec-approvals.md` — automation approvals delivered only to connected approval
  clients, "chat channels never receive automation approvals", standing grants, SQLite storage
- P18 `docs/tools/exec-approvals-advanced.md` — "## Approval forwarding to chat channels", `/approve`,
  `safeBins`, `operator.approvals` scope
- P19 `docs/cli/nodes.md` — `nodes status/pending/approve`, pairing vs device pairing
- P20 `docs/cli/sandbox.md` — Docker/Podman/SSH/OpenShell runtimes, `sandbox explain`
- P21 `docs/cli/approvals.md` — `approvals get/pending/resolve`, `allow-always` = "always allow here"
  bound to exact argv + cwd, `--expires-in-days`
- P42 `https://api.github.com/repos/openclaw/openclaw/git/trees/main?recursive=1` — 49,214 paths; used
  to enumerate `docs/**` (including `docs/concepts/soul.md`, `docs/cli/cron.md`,
  `docs/gateway/cli-backends.md`, `docs/concepts/multi-agent.md`)
- P45 `docs/gateway/config-tools/built-in-tools.md` — `tools.exec`, web search/fetch; no HTTP-request
  tool
- P51 `docs/tools/lobster.md` — "Typed workflow runtime for OpenClaw with resumable approval gates",
  "## Why" (the constrained-DSL paragraph), "## Enable" (optional plugin install + `tools.alsoAllow`),
  "## Workflow files (.lobster)", "### Injected environment variables", "## Tool parameters",
  "### Managed Task Flow mode", "## Output envelope", "## Approvals" (`~/.lobster/state`), "## Safety"
- P52 `https://github.com/openclaw/lobster` `README.md` — workflow file examples (`run:`, `pipeline:`,
  `stdin:`, `when:`, `approval:`, `retry`, `timeout_ms`, `on_error`, `for_each`, approval identity
  constraints), "## Commands" (`exec`, `where`, `pick`, `head`, `map`, `json`, `table`, `approve`),
  `LOBSTER_MAX_OUTPUT_BYTES`, `ctx.requestInput`. No parallel/`depends_on`/`needs` keyword present
- P53 `docs/tools/llm-task.md` — "a single JSON-only LLM call … optionally validated against a JSON
  Schema"; `llm.allowModelOverride`, `allowedCompletionModels`, `config.defaultProvider`,
  `defaultModel`, `defaultAuthProfileId`, `maxTokens`, `timeoutMs`
- P54 `docs/plugins/workboard.md` and `docs/cli/workboard.md` — card statuses, "## Agent tools" table
  (`workboard_link`, `workboard_decompose`, `workboard_create`, `workboard_read`,
  `workboard_complete`/`_block`, `workboard_dispatch`), templates (`bugfix`, `docs`, `release`,
  `pr_review`, `plugin`), `openclaw plugins enable workboard`
- P55 `docs/automation/taskflow.md` — "## When to use Task Flow" table, "### Managed mode",
  "### Mirrored mode", "## Flow statuses", "## Durable state and revision tracking" (`flow_runs` in
  `~/.openclaw/state/openclaw.sqlite`), "## Cancel behavior"
- P56 `docs/concepts/session-tool.md` — "## Available tools" table (`sessions_spawn`, `sessions_yield`,
  `subagents`), "## Spawning sub-agents" (`runtime: "subagent"|"acp"`, per-child `model`/`thinking`,
  `context: "fork"|"isolated"`, `visible`, `maxSpawnDepth` default 5)
- P46 `docs/automation/cron-jobs/webhooks.md`, `docs/cli/webhooks.md` — inbound Gateway HTTP hooks

Primary — Hermes Agent (all paths relative to `github.com/NousResearch/hermes-agent`, branch `main`,
read 2026-09-21):

- P22 `LICENSE` — MIT, "Copyright (c) 2025 Nous Research"
- P23 `README.md` — "The self-improving AI agent built by Nous Research", feature table (channels,
  learning loop, cron, delegation, seven terminal backends), install one-liners
- P24 `https://api.github.com/repos/NousResearch/hermes-agent` — created `2025-07-22T22:22:28Z`,
  247,467 stars, 52,053 forks, `license: MIT`, `size: 1022856`; issue searches: 13,735 open / 15,722
  closed / 6,351 in last 30d
- P25 `https://api.github.com/repos/NousResearch/hermes-agent/releases` — `v2026.9.14` = "Hermes Agent
  v0.21.3", 2026-09-14; `v2026.9.11` = v0.21.2; `v2026.8.31` = v0.21.0…
- P26 `website/docs/user-guide/features/cron.md` — "## What cron can do now", the model-resolution
  tip, `/cron` and `hermes cron create`, `hermes pause`, `--paused`, `cron.retry_unreachable`, quota
  parking, "### Fleet health check: `hermes cron doctor`", "## Missed scheduled fires
  (`last_fire_error`)", `cron.catch_up_missed` (default `true`) and its grace window, "### Misfire
  catch-up" (`misfire_grace_minutes`, hosted only), "## No-agent mode (script-only jobs)",
  "## Schedule formats"
- P27 `website/docs/guides/cron-script-only.md` — the comparison table including "OS cron + `curl` to
  a webhook subscription… when Hermes might be unhealthy"
- P28 `website/docs/user-guide/messaging/telegram.md` — QR setup writing `TELEGRAM_BOT_TOKEN` and
  `TELEGRAM_ALLOWED_USERS`, BotFather steps, privacy mode, `allowed_chats`/`group_allowed_chats`
- P29 `website/docs/user-guide/security.md` — "The security model has eight layers", `approvals.mode`
  table (`smart`/`manual`/`off`), `cron_mode`/`single_query_mode`/`unattended_mode` all default
  `deny`, `destructive_slash_confirm` "routed through native yes/no buttons on Telegram, Discord, and
  Slack"
- P30 `website/docs/user-guide/features/skills.md` — "All skills live in **`~/.hermes/skills/`** — the
  primary directory and source of truth… The agent can modify or delete any skill", `--no-skills`,
  "## Skill Directory Structure", `agentskills.io` compatibility
- P31 `website/docs/user-guide/features/tools.md` and `website/docs/reference/tools-reference.md` —
  toolset table, `terminal` / `read_file` / `write_file` / `patch` / `web_search` / `web_extract`
  (the latter two gated on third-party API keys); no HTTP-request tool
- P32 `website/docs/integrations/nous-portal.md` — "**the recommended way to run Hermes Agent**… If
  you only have time to set up one thing, set up this", `hermes setup --portal`, model catalogue
- P33 `website/docs/user-guide/features/tool-gateway.md` — "included with every paid Nous Portal
  subscription", search/image/TTS/browser routing
- P34 `website/docs/user-guide/features/api-server.md` — `POST /v1/chat/completions` with
  `Authorization: Bearer`, `GET /api/model/options`, `GET /v1/capabilities`
- P35 `website/docs/user-guide/multi-profile-gateways.md` — "# Running Many Gateways at Once", per-
  profile LaunchAgent/systemd/Scheduled Task/s6, pointer to `multi-connection-desktop.md`
- P36 `website/docs/reference/environment-variables.md` — `TELEGRAM_WEBHOOK_SECRET` required when
  `TELEGRAM_WEBHOOK_URL` is set (GHSA-3vpc-7q5r-276h); desktop update check via `api.github.com`;
  `HERMES_NEMO_RELAY_*` migration note
- P43 `https://api.github.com/repos/NousResearch/hermes-agent/git/trees/main?recursive=1` — 15,724
  paths; used to enumerate `website/docs/**`, including `guides/migrate-from-openclaw.md`,
  `user-guide/import-from-other-agents.md`, `developer-guide/chronos-managed-cron-contract.md`
- P47 `website/docs/user-guide/features/kanban.md` — "Kanban vs. `delegate_task`" table, "## Core
  concepts" (task statuses, `task_links`, dispatcher, workspaces), "### Per-task model override",
  "### Pinning extra skills to a specific task", "### Goal-mode cards (`--goal`)", "### How the
  orchestrator behaves", "### Kanban Swarm topology helper", "## CLI command reference" (the full
  `kanban create` signature), "## Runs — one row per attempt", "### Forward compatibility"
  (`workflow_template_id` / `current_step_key`), "## Event reference" (`dependency_wait`,
  `block_loop_detected`, `reconciled`), `kanban.auto_decompose`, `kanban.failure_limit`
- P48 `website/docs/user-guide/features/delegation.md` — "## Structured Output (`output_schema`)",
  "## Model Override" ("`delegate_task` has no per-task model parameter"), "## Inherited Tool Access",
  "## Max Iterations", "## Child Timeout"
- P49 `website/docs/user-guide/features/goals.md` — the Ralph-style judge loop, "Goals vs Kanban:
  which one do I want?"; `website/docs/user-guide/features/loops.md` — `/loop` cadence modes
- P50 `website/docs/reference/cli-commands.md` — `hermes insights` ("Show token/cost/activity
  analytics"), `hermes usage`; `website/docs/guides/automation-blueprints.md` and
  `website/docs/reference/automation-blueprints-catalog.mdx` — "A blueprint is just a skill with a
  `metadata.hermes.blueprint` block in its `SKILL.md` frontmatter"
- P44 `website/docs/user-guide/skills/bundled/software-development/*` — bundled skill pages
  `…-test-driven-development.md`, `…-requesting-code-review.md`, `…-systematic-debugging.md`,
  `…-spike.md`, `…-simplify-code.md`, `…-github.md`, plus
  `user-guide/skills/bundled/autonomous-ai-agents/…-claude-code.md`

Primary — other:

- P38 This machine: `~/.claude/plugins/cache/claude-plugins-official/superpowers/6.3.0/skills/
using-superpowers/references/hermes-tools.md` (Hermes tool mapping, `~/.hermes/SOUL.md`,
  `delegate_task`, `skill_view`, `hermes kanban`) and `…/superpowers/6.3.0/README.md` §"Hermes Agent"
  (`hermes plugins install obra/superpowers --enable`), plus `…/.hermes-plugin/plugin.yaml`
  ("Superpowers skills and workflow bootstrap for Hermes Agent")
- P39 `https://core.telegram.org/bots/api` — "All queries to the Telegram Bot API must be served over
  HTTPS and need to be presented in this form: `https://api.telegram.org/bot<token>/METHOD_NAME`";
  `sendMessage` required params `chat_id`, `text`; `getUpdates` has no required params and "will not
  work if an outgoing webhook is set up"
- P40 `launchd.plist(5)` — `StartCalendarInterval`: "Unlike cron which skips job invocations when the
  computer is asleep, launchd will start the job the next time the computer wakes up. If multiple
  intervals transpire before the computer is woken, those events will be coalesced into one event upon
  wake from sleep."; `StartInterval`: "If the system is asleep during the time of the next scheduled
  interval firing, that interval will be missed due to shortcomings in kqueue(3)."
- P41 This repo, read directly: `src/serve/server.ts` (routes `POST /api/runs`, `GET /api/runs`,
  `RE_RUN_BY_ID`, `RE_RUN_EVENTS`, `RE_RUN_LOG`, `RE_RUN_APPROVE` with its
  `{approved: boolean, reason?: string}` body, `RE_RUN_CANCEL`, `POST /api/gate-judge`,
  `POST /api/runs/decide`; **no** `Authorization`/bearer/token handling anywhere in the file);
  `src/doctor.ts:78-95` (`daemon.json` records pid and port); `pipelines/ship.yaml`
  (`kind: gate`, `manualOnly: true`, then `git add -u && git commit -m …` and `gh pr create --fill`);
  `README.md` (three workflow layers, per-project daemon, default port 7411, ephemeral port when
  auto-started, state under `~/.agent-flows/projects/<key>/`);
  `docs/decisions/0019-the-stage-model-and-its-vocabulary.md` (D1 stage table, D6 "agent-flows must
  not depend on agent-notes internals")

Secondary (used only to locate primaries; relied on for nothing):

- S1 WebSearch results for "OpenClaw self-hosted AI agent cron Telegram" and "Hermes Agent CLI coding
  agent harness SOUL.md" — awesome-lists, vendor blogs, tutorial sites. Used to find
  `github.com/openclaw/openclaw` and `github.com/NousResearch/hermes-agent` and nothing else.
