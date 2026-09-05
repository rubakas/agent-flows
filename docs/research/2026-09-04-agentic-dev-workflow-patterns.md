# Agentic software-development workflow patterns (primary-source survey)

Date: 2026-09-04
Purpose: gather the factual, currently-documented patterns leading teams use to structure
**agentic software-development workflows**, as the evidence base for designing a full
software-development-lifecycle (SDLC) pipeline for **yoke** — a provider-neutral harness that
drives coding-agent CLIs (Claude Code / Codex) from chat (README Charter; ADR-0011, 0012, 0014).

**Ground rule (owner's):** facts only, no guessing. Every pattern below carries a primary-source
URL. Anything not confirmed against a primary source is marked **[unverified]**. Sections B, C and D
are explicitly *synthesis* of the cited primary patterns — they combine sourced facts; they do not
invent new ones, and each synthesised claim points back to the pattern it rests on.

Primary sources read in full for this note:

- Anthropic, *Building effective agents* — https://www.anthropic.com/engineering/building-effective-agents
- Anthropic, *Best practices for Claude Code* — https://code.claude.com/docs/en/best-practices
  (canonical redirect target of `anthropic.com/engineering/claude-code-best-practices`)
- Anthropic, *Common workflows* (Claude Code docs) — https://code.claude.com/docs/en/common-workflows
- GitHub, *Spec Kit* README + `templates/commands/*.md` command definitions —
  https://github.com/github/spec-kit (fetched via `gh api repos/github/spec-kit/contents/...`)
- Madaan et al., *Self-Refine: Iterative Refinement with Self-Feedback* — https://arxiv.org/abs/2303.17651
- Shinn et al., *Reflexion: Language Agents with Verbal Reinforcement Learning* — https://arxiv.org/abs/2303.11366

---

## A. Patterns catalogue

Anthropic's *Building effective agents* draws the load-bearing distinction the whole catalogue hangs
on: **workflows** are "systems where LLMs and tools are orchestrated through predefined code paths,"
whereas **agents** are "systems where LLMs dynamically direct their own processes and tool usage,
maintaining control over how they accomplish tasks." The guidance on *which*: "Workflows offer
predictability and consistency for well-defined tasks, whereas agents are the better option when
flexibility and model-driven decision-making are needed at scale." The overarching rule is
simplicity-first: "Start with simple prompts, optimize them with comprehensive evaluation, and add
multi-step agentic systems only when simpler solutions fall short."
(https://www.anthropic.com/engineering/building-effective-agents)

| # | Pattern | What it is | When to use | Yoke mapping |
|---|---------|-----------|-------------|--------------|
| A1 | Prompt chaining | Task decomposed into fixed sequential LLM calls; each processes the prior output; optional programmatic "gate" checks between steps | Task decomposes cleanly into fixed subtasks; trade latency for accuracy | The canon's ordered `steps` with `dependsOn` edges; a `gate` step between steps |
| A2 | Routing | Classify an input, then dispatch to a specialised downstream prompt/model | Distinct categories are better handled separately and classification is reliable | Registry `role`→model indirection; a routing step picking the pipeline/model per input |
| A3 | Parallelization — sectioning | Independent subtasks run concurrently, outputs aggregated in code | Subtasks are genuinely independent and parallelism buys speed | Steps sharing a dependency level fan out; DAG levelling (ADR-0014) |
| A4 | Parallelization — voting | The *same* task run multiple times for diverse takes, then aggregated | Multiple perspectives/attempts raise confidence (e.g. several reviewers) | Parallel `critic` + `security` review steps converging on `assemble` |
| A5 | Orchestrator–workers | A central LLM dynamically decomposes a task, delegates to worker LLMs, synthesises results; the subtasks are *not* pre-known | Complex tasks where you can't predict the subtasks up front | A develop/implement step delegating to Claude Code subagents; Binding A `pipeline()` fan-out |
| A6 | Evaluator–optimizer | One LLM generates; a second evaluates against criteria and returns feedback; loop until acceptable | Clear evaluation criteria exist and iterative refinement measurably helps | The verify→correct loop; adversarial review step; the approval `gate` |
| A7 | Autonomous agent | LLM acts in a tool-use loop on environmental feedback, deciding its own steps | Open-ended problems where the step count can't be predicted or hard-coded; requires trust + guardrails | `workspace: read`/write coding-agent steps (`claude`/`codex` CLI) executing a task inside the repo |

Per-pattern detail (definitions and "when" quoted/condensed from the source above):

- **A1 Prompt chaining.** Decompose a task into a fixed sequence of steps, each LLM call working on
  the last one's output, with optional programmatic validation between them. "Ideal for situations
  where the task can be easily and cleanly decomposed into fixed subtasks," trading total latency for
  higher accuracy per step. *Yoke:* this is exactly the canon's linear backbone — `steps` ordered by
  `dependsOn`, with a `gate` kind available as the between-step check (ADR-0014; README schema).

- **A2 Routing.** Classify the input and direct it to a specialised follow-on task, so each category
  gets its own optimised prompt/model. "Works well for complex tasks where there are distinct
  categories that are better handled separately, and where classification can be handled accurately."
  *Yoke:* maps onto the planned registry `role` indirection (ADR-0012 decision 5) — model/prompt
  chosen as policy per input rather than hard-coded.

- **A3/A4 Parallelization.** Run LLM work simultaneously and aggregate in code. Two variants:
  **sectioning** (independent subtasks in parallel) and **voting** (the same task several times for
  diverse outputs). "Effective when the divided subtasks can be parallelized for speed, or when
  multiple perspectives or attempts are needed for higher confidence results." Voting examples in the
  source include *multiple code reviews for vulnerability detection*. *Yoke:* the existing
  `spec-creation` pipeline already fans `critic` and `security` out in parallel and converges them on
  `assemble` (ADR-0014 migration note) — a sectioning+voting instance.

- **A5 Orchestrator–workers.** A central LLM "dynamically breaks down tasks, delegates them to worker
  LLMs, and synthesizes their results," distinguished from parallelization by the subtasks being
  *unpredictable and input-dependent* rather than pre-listed. "Well-suited for complex tasks where you
  can't predict the subtasks needed." Source example: *multi-file code modifications.* *Yoke:* a
  develop stage whose coding-agent delegates to its own subagents is an orchestrator-workers step;
  Binding A's `pipeline()` fan-out helper is the same shape (ADR-0012 findings).

- **A6 Evaluator–optimizer.** "One LLM call generates a response while another provides evaluation and
  feedback in a loop." "Particularly effective when we have clear evaluation criteria, and when
  iterative refinement provides measurable value." This is the vendor-blessed name for the
  reflection/self-correction loop (see §C). *Yoke:* the meta-loop's *verify-correctness* +
  *correct-plan* stages, and the approval `gate`.

- **A7 Autonomous agent.** An LLM "using tools based on environmental feedback in loops," with
  relative autonomy over a long task. Use for "open-ended problems where it's difficult or impossible
  to predict the required number of steps, and where you can't hardcode a fixed path"; the source
  stresses it needs "some level of trust in its decision-making," guardrails, and warns of "higher
  costs, and the potential for compounding errors." Source examples: *SWE-bench coding tasks.* *Yoke:*
  each coding-agent step (`claude`/`codex` CLI) is a bounded autonomous agent; `workspace: read`
  scopes it read-only for investigation, and Layer-0 key isolation is one of the guardrails (Charter).

**Cross-pattern note from the source:** these are composable, not exclusive — a real system is
usually several of these patterns wired together, and the author repeatedly warns against reaching for
the agent (A7) when a workflow (A1–A6) would be more predictable and cheaper.

---

## B. The documented dev lifecycle (synthesised from the cited sources)

> This section *synthesises* two independently-published vendor workflows into one stage sequence. It
> is a combination of sourced facts, not an invented method. Each stage cites the source it comes from.

### B.1 Anthropic — "Explore, plan, code, commit" (Claude Code)

Anthropic's Best-practices page states the failure mode plainly — "Letting Claude jump straight to
coding can produce code that solves the wrong problem" — and prescribes a four-phase workflow
(https://code.claude.com/docs/en/best-practices):

1. **Explore.** Enter *plan mode* (`Shift+Tab` → `⏸ plan mode on`, or `claude --permission-mode
   plan`); "Claude reads files and answers questions without making changes." Reading/understanding is
   deliberately separated from editing. The *Common workflows* page frames the same as "Delegate
   research to subagents" so the exploration doesn't fill the main context.
   (https://code.claude.com/docs/en/common-workflows)
2. **Plan.** "Ask Claude to create a detailed implementation plan" — what files change, what the flow
   is — reviewable/editable before any code. Callout: "Planning is most useful when you're uncertain
   about the approach, when the change modifies multiple files, or when you're unfamiliar with the
   code… If you could describe the diff in one sentence, skip the plan."
3. **Implement.** Approve/exit plan mode and let Claude code, "verifying against its plan," writing and
   running tests.
4. **Commit.** "Ask Claude to commit with a descriptive message and create a PR."

Two cross-cutting Anthropic practices bracket this loop:

- **Verification is the closing mechanism, not a nicety.** "Give Claude a check it can run: tests, a
  build, a screenshot to compare." "Claude stops when the work looks done. Without a check it can run,
  'looks done' is the only signal available, and you become the verification loop." Have Claude "show
  evidence rather than asserting success."
- **Adversarial review in a fresh context before 'done'.** "Before treating a task as done, have a
  subagent review the diff in a fresh context and report gaps." "A reviewer running in a fresh subagent
  context sees only the diff and the criteria you give it, not the reasoning that produced the change,
  so it evaluates the result on its own terms." (Caveat from the same source: tell the reviewer to
  flag only correctness/requirements gaps, or it over-engineers.) The multi-session **Writer/Reviewer**
  pattern generalises this — "A fresh context improves code review since Claude won't be biased toward
  code it just wrote" — and its test variant: "have one Claude write tests, then another write code to
  pass them."

For larger features, Anthropic recommends a **spec-first** front end: "for larger features have Claude
interview you and write a spec before you start implementing," and "The most useful specs are
self-contained: they name the files and interfaces involved, state what is out of scope, and end with
an end-to-end verification step that proves the feature works."

### B.2 GitHub Spec Kit — "specify → plan → tasks → implement" (+ analyze/clarify/converge)

Spec Kit is the same explore→plan→build discipline made *executable* as slash commands with
git-backed artifacts. Its core philosophy: "specifications become executable" and "Intent-driven
development where specifications define the *what* before the *how*." (https://github.com/github/spec-kit)

Stage commands, with the description each command file actually declares (verbatim from
`templates/commands/*.md` front-matter, fetched via `gh api`):

| Stage | Command | Declared description (verbatim) | Artifact written | Read/write |
|-------|---------|--------------------------------|------------------|------------|
| 0 (once) | `/speckit.constitution` | "Create or update the project constitution from interactive or provided principle inputs." | `/memory/constitution.md` | write (governance only) |
| 1 | `/speckit.specify` | "Create or update the feature specification from a natural language feature description." | `spec.md` | write |
| 1b | `/speckit.clarify` | "Identify underspecified areas in the current feature spec by asking up to 5 highly targeted clarification questions and encoding answers back into the spec." | edits `spec.md` | write |
| 2 | `/speckit.plan` | "Execute the implementation planning workflow using the plan template to generate design artifacts." | `plan.md` + design artifacts | write |
| 3 | `/speckit.tasks` | "Generate an actionable, dependency-ordered tasks.md for the feature based on available design artifacts." | `tasks.md` | write |
| 3b | `/speckit.analyze` | "Perform a non-destructive cross-artifact consistency and quality analysis across spec.md, plan.md, and tasks.md after task generation." | report only | **read-only** |
| 3c | `/speckit.checklist` | Generates "unit tests for English" — requirements-quality checklists (completeness/clarity/consistency), *not* implementation tests | `checklists/*.md` | write (reviewer-owned) |
| 4 | `/speckit.implement` | "Execute the implementation plan by processing and executing all tasks defined in tasks.md." | source code | write |
| 5 | `/speckit.converge` | "Assess the current codebase against the feature's spec, plan, and tasks, then append any remaining unbuilt work as new tasks to tasks.md so implement can complete it." | appends to `tasks.md` | read repo, write tasks |

Key sourced facts about ordering and gates:

- **Constitution is a one-time, per-project governance step**, separate from feature work; its own
  command "MUST NOT" create/modify application source (scope guard in `constitution.md`).
- **Clarify runs BEFORE plan.** The command file states it "is expected to run (and be completed)
  BEFORE invoking `plan`," and warns that skipping it (e.g. an exploratory spike) means "downstream
  rework risk increases."
- **Analyze is a read-only consistency gate between tasks and implement.** "STRICTLY READ-ONLY… Output
  a structured analysis report." It "MUST run only after `tasks` has successfully produced a complete
  `tasks.md`." The **constitution is non-negotiable** in that check — "Constitution conflicts are
  automatically CRITICAL and require adjustment of the spec, plan, or tasks — not dilution,
  reinterpretation, or silent ignoring."
- **Implement→converge is an explicit loop, not a straight line.** README: "Repeat steps 4 and 5 until
  `/speckit-converge` reports **Converged**."
- Spec Kit ships the same shape for two adjacent lifecycles: a **bug** extension —
  "assess → fix → test," which "keeps each fix scoped, evidence-based, and documented from root cause
  through verification" — and an **idea-assessment** extension — "intake → research → define → shape →
  decide," yielding a "go / needs-clarification / kill" decision. Both reinforce that a *research/assess*
  front stage and a *test/verify* back stage bracket the build in this vendor's model.

### B.3 The synthesised stage sequence

Aligning the two vendor workflows side by side shows they are the same spine under different names,
with Spec Kit adding explicit *governance*, *clarify*, and *cross-artifact-consistency* gates that
Anthropic performs conversationally:

| Lifecycle role | Anthropic (Claude Code) | GitHub Spec Kit | Anthropic pattern (§A) |
|----------------|--------------------------|------------------|------------------------|
| Governance/standards | CLAUDE.md persistent context | `/constitution` | — (context, not a pattern) |
| Research / investigate | Explore (plan mode, subagents, read-only) | `/specify` (+`/clarify`) intent capture | A1 chaining; A5/A7 read-only agent |
| Plan | Plan (detailed implementation plan) | `/plan` → `/tasks` | A1 chaining |
| Verify the plan | (review plan before approving) | `/analyze` (read-only consistency) + `/checklist` | A6 evaluator-optimizer |
| Correct the plan | edit plan; re-plan | remediation of spec/plan/tasks | A6 evaluator-optimizer |
| Build | Implement (code + run tests) | `/implement` | A5 orchestrator-workers; A7 |
| Verify correctness | tests / build / screenshot + adversarial review subagent | tests + `/converge` gap-assessment | A6; A4 voting (multiple reviewers) |
| Correct / converge | fix from review; iterate | `/converge` appends tasks, loop to `/implement` | A6 loop |
| Ship | Commit + PR | (post-converge) | — |

The consistent, twice-documented sequence is therefore:

**govern → research → plan → verify-plan → (correct-plan) → build → verify-correctness → (correct) → ship**,

with verification and correction appearing **twice** — once around the plan (Spec Kit `/analyze`+
`/clarify`; Anthropic's "review the plan before approving") and once around the code (Anthropic
adversarial-review + tests; Spec Kit `/converge` loop).

---

## C. Where "research → plan → verify-correctness → correct-plan" comes from

The owner's requested meta-loop is not invented; it is the composition of three separately-documented
primary patterns. Mapping term by term:

1. **research / investigate** = Anthropic's **Explore** phase — read files and answer questions *without
   making changes*, ideally in plan mode or delegated to subagents so it doesn't pollute context
   (https://code.claude.com/docs/en/best-practices; …/common-workflows). Its Spec Kit analogue is
   `/specify` (+`/clarify`) capturing intent before any `/plan`.

2. **plan** = Anthropic's **Plan** phase and Spec Kit's `/plan`→`/tasks` — an explicit, reviewable
   artifact produced before code, justified by "Letting Claude jump straight to coding can produce code
   that solves the wrong problem."

3. **verify-correctness** = Anthropic's **evaluator–optimizer** pattern: "One LLM call generates a
   response while another provides evaluation and feedback in a loop," used "when we have clear
   evaluation criteria" (https://www.anthropic.com/engineering/building-effective-agents). In Claude
   Code this is realised as the *adversarial-review subagent* ("have a subagent review the diff in a
   fresh context and report gaps") and as *runnable checks* (tests/build/screenshot). In Spec Kit it is
   `/analyze` (read-only cross-artifact check, constitution conflicts = CRITICAL) plus `/converge`
   (codebase-vs-spec gap assessment).

4. **correct-plan** = the *optimizer* half of the same loop: feed the evaluation back and revise. Spec
   Kit makes this an explicit, terminating loop — "Repeat steps 4 and 5 until `/speckit-converge`
   reports **Converged**" — where converge *writes corrections back into `tasks.md`*. Anthropic's
   equivalent is "the implementing session receives the gaps directly and can fix them and re-review."

The academic lineage behind evaluator–optimizer confirms the loop is an established method, not a
vibe:

- **Self-Refine** (Madaan et al., 2023): a single LLM in three roles — generate → self-feedback →
  refine — "the same LLM provides feedback for its output and uses it to refine itself, iteratively,"
  with **no additional training** (https://arxiv.org/abs/2303.17651). This is the *same-model* form of
  verify→correct.
- **Reflexion** (Shinn et al., 2023): "Reflexion agents verbally reflect on task feedback signals,
  then maintain their own reflective text in an episodic memory buffer to induce better decision-making
  in subsequent trials" — verbal reinforcement, no weight updates (https://arxiv.org/abs/2303.11366).
  This is the *carry-corrections-forward-across-trials* form of the loop.

**Conclusion:** "research → plan → verify-correctness → correct-plan" is a faithful re-labelling of
Anthropic's explore→plan + evaluator-optimizer, mirrored by Spec Kit's specify/plan → analyze/converge
loop, and grounded in the Self-Refine / Reflexion literature. It is a documented approach.

**Nuance to respect (from Anthropic, not to be over-applied):** verification only closes the loop when
the check "produces a pass or fail" the agent can read; and a reviewer told to find gaps "will usually
report some, even when the work is sound," so correction must be scoped to correctness/requirements or
it drifts into over-engineering (https://code.claude.com/docs/en/best-practices). Simplicity-first
still governs: add loop stages "only when simpler solutions fall short."

---

## D. Design implications for a yoke pipeline

Recommended stage breakdown for yoke's SDLC pipeline. It is designed so the whole chain can run as
**one pipeline** (a single `dependsOn` DAG) **or** each stage can be lifted out as a **reusable
standalone pipeline** — which the canon already supports: depth comes from a self-nesting step kind
that references another pipeline id (ADR-0012 decision 2), and topology is explicit `dependsOn` edges
levelled into parallel groups by both bindings (ADR-0014). Nothing here prescribes YAML; it describes
each stage's *contract* (role, I/O, repo access, human gate) and the cited pattern that justifies it.

Repo-access column uses the canon's own vocabulary: **read** = `workspace: read` (agent runs read-only
in the project dir, per README schema); **write** = agent may edit the repo; **none** = pure
LLM/data step; **canon-write** = writes yoke artifacts (spec/ticket), not the target repo.

| # | Stage | Role | Inputs → Outputs | Repo access | Human gate? | Justifying pattern (source) |
|---|-------|------|------------------|-------------|-------------|------------------------------|
| 0 | Govern (optional, once) | Load standing constraints/standards for the run | project principles → constitution/context | none / read | no | Spec Kit `/constitution`; Anthropic CLAUDE.md |
| 1 | Research / Investigate | Understand the request against the real repo, *no edits* | request (+repo) → findings/context brief | **read** (`workspace: read`) | no | Explore phase, read-only (best-practices); A7 read-only agent; A1 |
| 2 | Plan | Produce a detailed, reviewable implementation plan/spec | findings → plan (files to change, flow, out-of-scope, end-to-end verification step) | read | **optional gate** (review plan) | Plan phase; "self-contained spec" (best-practices); Spec Kit `/plan`,`/tasks`; A1 |
| 3 | Verify-plan | Independent check that the plan is complete/consistent, in a fresh context | plan → consistency report (gaps, contradictions, standard/constitution conflicts) | **read-only** | no (feeds gate) | Evaluator half of A6; Spec Kit `/analyze` (STRICTLY READ-ONLY; constitution conflicts CRITICAL); A4 voting |
| 4 | Correct-plan | Fold verify-plan feedback back into the plan; loop until clean | report + plan → revised plan | canon-write | no | Optimizer half of A6; Self-Refine loop; Spec Kit clarify/analyze remediation |
| — | **Approval gate** | Human authorises build before any repo write | revised plan → approved/blocked | none | **YES (human)** | Binding A "approve gates happen in chat between runs" (ADR-0011); `gate` step kind (README) |
| 5 | Develop / Implement | Execute the approved plan; write code + tests; self-verify against plan | approved plan → code diff + tests | **write** | no (runs post-gate) | Implement phase; A5 orchestrator-workers (subagents); A7; Spec Kit `/implement` |
| 6 | Test / Verify-correctness | Run the runnable check (tests/build/lint/screenshot); show evidence | diff → pass/fail + evidence | **write** (runs commands) or read | no (feeds loop) | "Give Claude a check it can run"; "show evidence" (best-practices); A6 |
| 7 | Audit / Review | Adversarial diff review in a *fresh* context; correctness/requirements gaps only | diff + plan → findings | **read-only** | no (feeds loop) | Adversarial-review subagent + Writer/Reviewer (best-practices); A4 voting (e.g. security review) |
| — | **Converge loop** | If tests fail or audit finds gaps, correct and re-run 5–7 until clean | findings → fixes | write | no | Spec Kit "repeat until Converged"; A6 loop; Reflexion (carry-forward) |
| 8 | Ship / PR | Commit with a descriptive message and open a PR | passing diff → commit + PR | **write** | **optional gate** (approve PR) | Commit phase; `gh` PR recipe (common-workflows) |

Design principles that fall directly out of the sources:

- **Separate read from write, and gate the transition.** Stages 1–4 and 3/7 are read-only or
  canon-only; the *first* stage that writes the target repo (5) sits immediately after a human approval
  gate. This is Anthropic's explore-before-code discipline plus Binding A's "approve gates happen in
  chat between runs" (ADR-0011). The canon expresses read-only grounding natively via `workspace:
  read`, which the README notes n8n has no concept of — a genuine yoke differentiator.

- **Verification appears twice, and each time in a *fresh* context.** Once on the plan (stage 3) and
  once on the code (stages 6–7). Both vendors do this; Anthropic's reason is that a fresh subagent
  "isn't the one grading it" and isn't "biased toward code it just wrote." In canon terms these are
  independent steps whose context is scoped to their ancestors' outputs (ADR-0014 §6), which is exactly
  the "sees only the diff and the criteria" property Anthropic wants.

- **Correction is a bounded loop with a termination signal, not open-ended.** Model stages 5–7 as a
  converge loop that ends on a concrete pass/fail (tests green + audit clean), mirroring Spec Kit's
  "repeat until Converged." Anthropic's caveat sets the loop's scope: correct only
  correctness/requirements gaps, or the optimizer over-engineers.

- **Parallelise the reviews (sectioning + voting).** Stage 7 can fan out into concurrent reviewers
  (e.g. general correctness + security), converging on a synthesis — the pattern the existing
  `spec-creation` pipeline already uses for `critic`+`security`→`assemble` (A4; ADR-0014). The DAG
  levelling makes this free.

- **Each stage is a reusable pipeline.** Because depth is self-nesting (a step referencing another
  pipeline id, ADR-0012), "research", "plan", "test" and "audit" can each be run alone (e.g. audit an
  existing PR) or composed into the full SDLC chain — satisfying the owner's "one full pipeline OR
  separate reusable workflows" requirement without new machinery.

- **Keep the default simple.** Per Anthropic's simplicity-first rule and its own callout ("If you could
  describe the diff in one sentence, skip the plan"), the pipeline should let trivial changes bypass
  stages 3–4 (and even 2), adding loop stages only when the task warrants them. Over-structuring a
  one-line fix is an anti-pattern the primary source explicitly names.

**Mapping to yoke's current canon primitives** (README + ADRs): stage ordering = `dependsOn` edges
levelled to parallel groups (ADR-0014); the human gate = the `gate` step kind / Binding-A chat approval
(README, ADR-0011); read-only stages = `workspace: read` (README); plan/ticket persistence =
`assemble-spec` + `persist-ticket` kinds already in the schema (README Status); model/role per stage =
the registry `role` indirection planned in ADR-0012 decision 5. No stage above requires a primitive the
canon lacks.

---

## Sources consulted

Primary (each claim above cites one of these):

1. Anthropic — *Building effective agents.* https://www.anthropic.com/engineering/building-effective-agents
   (workflows-vs-agents; prompt chaining; routing; parallelization sectioning+voting; orchestrator-workers;
   evaluator-optimizer; autonomous agents; simplicity-first).
2. Anthropic — *Best practices for Claude Code.* https://code.claude.com/docs/en/best-practices
   (explore→plan→code→commit; plan mode; verification "check it can run"; adversarial-review subagent;
   Writer/Reviewer + tests-then-code; interview→self-contained spec; course-correct/`/clear`; headless
   `-p`, `/batch` fan-out; worktrees).
3. Anthropic — *Common workflows* (Claude Code docs). https://code.claude.com/docs/en/common-workflows
   (test recipe; delegate research to subagents; plan-before-editing; worktrees; pipe into scripts).
4. GitHub — *Spec Kit* README and `templates/commands/{constitution,specify,clarify,plan,tasks,analyze,
   checklist,implement,converge}.md`. https://github.com/github/spec-kit (fetched via
   `gh api repos/github/spec-kit/contents/...`) — command descriptions, ordering constraints, read-only
   `/analyze`, constitution-conflict = CRITICAL, implement↔converge loop, bug (assess→fix→test) and
   idea (intake→research→define→shape→decide) extensions.
5. Madaan et al. — *Self-Refine: Iterative Refinement with Self-Feedback.* https://arxiv.org/abs/2303.17651
6. Shinn et al. — *Reflexion: Language Agents with Verbal Reinforcement Learning.* https://arxiv.org/abs/2303.11366

Internal (yoke) context cross-referenced for the "yoke mapping" columns: `README.md` (Charter, schema,
Bindings A/B/C, `workspace: read`); `docs/decisions/0011-chat-first-canon-and-bindings.md`;
`docs/decisions/0012-canon-ontology-single-nesting-pipeline.md`;
`docs/decisions/0014-canon-topology-explicit-edges.md`.

**[unverified] items:** none of the pattern claims are unverified — all were fetched from the primary
URLs above during this research. The only representational caveat: Anthropic's *live* best-practices
page presents test-driven development in condensed form (the two-Claude "one writes tests, another
writes code to pass them" split plus the runnable-check discipline) rather than a numbered
"confirm-tests-fail → commit-tests → implement-without-modifying-tests" sequence; this note reports the
condensed form the current source actually states rather than the older long-form phrasing.
