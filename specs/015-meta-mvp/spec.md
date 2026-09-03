# 015. Meta-MVP: a DAG editor for the canon

| Field        | Value          |
| ------------ | -------------- |
| Feature Name | Meta-MVP       |
| Branch       | `015-meta-mvp` |
| Status       | Draft          |
| Created      | 2026-09-03     |

**Context:** The Charter defines Yoke as a harness for "building, editing and running" dynamic
workflows; spec 014 records that only running is implemented. This spec closes the editing half.
Two decisions taken on 2026-09-03 set its shape. First, the editor is a real DAG canvas — blocks
with drawn connections — not a view over the current phase mechanism, which means the canon gains
an explicit edge model and ADR-0012's topology rule is amended. Second, the spec exporter is
rewritten against ADR-0003's declared format rather than ported from the pre-pivot code. Closes 014
FR-005, FR-006, FR-007, and pulls ADR-0012's deferred agent/skill trigger by adding a second
pipeline. There is no multi-project machinery: the root is wherever the harness was launched.

---

## Glossary

| Term                | Means                                                                                                                                                     |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ADR                 | Architecture Decision Record — a numbered file under `docs/decisions/` recording one decision and why.                                                    |
| SDD                 | Spec-Driven Development — the practice this repo follows: the spec is the artifact of record, committed to git.                                           |
| Spec Kit            | github/spec-kit, the SDD toolkit whose `spec-template.md` defines the format ADR-0003 adopts.                                                             |
| FR / SC             | Functional Requirement / Success Criterion — the two id series in a Spec Kit spec. `FR` states what the system must do; `SC` states a measurable outcome. |
| DAG                 | Directed Acyclic Graph — blocks with one-way connections and no loops. What the editor draws and the canon will store.                                    |
| Canon               | This project's neutral definitions: `pipeline` YAML plus prompt files. Provider-agnostic by rule.                                                         |
| Binding             | A thin compiler from canon to one execution backend. Binding A emits Claude Code workflows; Binding B builds Mastra workflows.                            |
| Step / phase / gate | A step is the leaf unit of work. `phase` is today's parallelism marker, replaced here by `dependsOn`. A gate is a step that suspends for a human answer.  |
| Role / profile      | A step declares a role (`reasoner`, `worker`, `scout`); the active provider profile maps each role to a model id, so templates carry no vendor names.     |
| MCP                 | Model Context Protocol — how a chat client calls tools. Yoke's server exposes `run_pipeline`, `approve` and friends over it.                              |
| SSE                 | Server-Sent Events — a one-way HTTP stream from server to browser. How the run view updates live.                                                         |
| YAML AST            | The `yaml` library's document tree. Editing through it preserves comments and key order that a parse-and-rewrite would destroy.                           |
| Levelling           | Sorting a DAG into ordered layers so each layer can run in parallel. Lets an arbitrary graph compile onto a linear builder.                               |
| Loopback            | The `127.0.0.1` address, reachable only from this machine. The daemon binds nowhere else.                                                                 |

## What we are building

1. **An edge model in the canon.** A step declares what it depends on. The graph becomes data, not
   an inference from array order.
2. **`yoke serve`** — one local process: indexes the canon under a root, serves the editor, keeps
   the MCP tool surface chat clients already use, and owns run state behind a transport-agnostic
   `RunService`. Loopback only.
3. **A DAG editor** — draw blocks, connect them, edit each step inline, watch a run advance. An
   ordinary web page, so it opens in Claude Code's browser pane, in T3 Code's desktop Browser
   panel, or in a normal browser. One app, three windows, not three integrations.
4. **A draft layer in SQLite** — the edit buffer between the UI and the YAML file, so a half-written
   or invalid edit never reaches disk and never gets lost.
5. **A file output** — a spec exporter in ADR-0003's format, as a canon step kind, because today
   the live path writes nothing to disk at all.

## Why the canon must change

`StepDef` has no connection concept — `id`, `kind`, `role`, `model`, `prompt`, `schema`, `phase`,
`message` (`src/canon/types.ts`). The only topology mechanism is `phase`: steps sharing a phase
string fan out and converge on a synthetic merge (`src/bindings/mastra/build.ts:146-172`). That
expresses a sequence and same-width fan-out, and nothing else — no independent concurrent
subgraphs, no per-edge routing, no conditionals.

A canvas whose edges cannot be saved is a canvas in name only. So `phase` is replaced by an
explicit dependency:

```yaml
steps:
  - id: intake
  - id: enrich
    dependsOn: [intake]
  - id: critic
    dependsOn: [enrich]
  - id: security
    dependsOn: [enrich]
  - id: assemble
    dependsOn: [critic, security]
```

`dependsOn` subsumes `phase` — a "phase" is just a set of steps sharing the same dependencies, so
keeping both would be two ways to say one thing. This amends ADR-0012's topology rule; its
ontology survives untouched: still one self-nesting `pipeline`, still `step` as the leaf.

**Compiling a DAG onto Mastra.** Mastra's builder is a linear chain of `.then()` and `.parallel()`,
which looks like a mismatch and is not: any DAG topologically sorts into levels, each level becomes
one `.parallel()` (or `.then()` when it holds a single step), and the existing synthetic merge folds
each level. Binding A's `phase()` output compiles the same way. No framework change is needed —
only a levelling pass in front of both binders.

**Context scope.** Today every step receives the whole accumulated context
(`src/bindings/mastra/build.ts:101-141`). With real edges, a step should see its ancestors'
outputs, not everything — which is a filter over the existing context map keyed by step id, not a
new data plane. Cheap to do, and it makes an edge mean something.

## Where definitions live

Verified 2026-09-03:

- `.claude/workflows/*.js` is a real Claude Code convention — its `Workflow` tool loads named
  workflows from there, and Binding A already writes exactly there.
- Codex has no workflow format. Its project convention is `AGENTS.md` plus `.codex/config.toml`.
- LiteLLM has no project convention at all; it is a proxy configured by a model list.

Provider directories are therefore the right home for **binding output** and the wrong home for the
canon. Canon inside `.claude/` would invert Charter rule 3, and since two of the three backends have
no workflow format to reuse, it would mean duplicating the canon per vendor or electing one vendor
as its home. Both defeat "one canonical definition, many execution backends".

    <root>/.yoke/pipelines/*.yaml   canon, provider-neutral, git-tracked, one copy
    <root>/.yoke/prompts/*.md       canon
    <root>/.claude/workflows/*.js   Binding A output, generated, disposable
    (Codex and LiteLLM)             reached through Binding B over MCP - no files to write

`loadPipeline` supports this unchanged: it derives its root from the YAML's own path
(`src/canon/load.ts:19`), so `<root>/.yoke/pipelines/x.yaml` resolves prompts under `<root>/.yoke/`.
Moving the existing `pipelines/` and `prompts/` into `.yoke/` is a file move, not a code change.

## The database is a buffer, not the truth

Editing a YAML file straight from a UI is risky in four specific ways: a half-formed edit becomes
the on-disk truth; work is lost when validation fails; two writers clobber each other; there is no
undo. SQLite fixes all four when it sits in front of the file.

It must not replace the file. ADR-0011 makes templates files edited in chat, ADR-0003 makes them
git-backed, and Binding A generates from files on disk. An agent cannot read the database. Files are
the truth; the database is a draft buffer and an index.

## Invariants

Checkable rules, not preferences:

1. **Files are the truth.** Anything an agent, a CLI or git reads comes from a file. The database
   holds drafts and an index, never the definition of record.
2. **One validator.** Every write path — UI, MCP, CLI — re-runs `loadPipeline` before persisting.
3. **The graph is data.** Nodes and edges come from the canon's own `dependsOn`. Neither the UI nor
   a binding infers topology from array order.
4. **Provider directories hold output, never canon.** Generated files are disposable.
5. **A run pins its definition.** Editing a pipeline never changes a run already in flight.

## Requirements

| ID     | Requirement                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Status |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| FR-001 | ADR-0013: a visual editor option has met the Charter's bar; amend the Operating surface paragraph; scope the daemon as a loopback-only local editor that does not revive ADR-0010's orchestrator.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | DONE   |
| FR-002 | ADR-0014: canon topology is an explicit `dependsOn` edge set, replacing `phase`. Amends ADR-0012's topology rule; its ontology (one self-nesting `pipeline`, leaf `step`) is unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | DONE   |
| FR-003 | `StepDef` gains `dependsOn: string[]`; `phase` is removed. `loadPipeline` validates the graph: unknown references, cycles and duplicate ids are rejected with a precise message naming the offending step ids. A step with no edges at all is NOT rejected — in a graph with no designated entry point nothing is unreachable, an unconnected step is a valid level-0 task, and rejecting it would stop the editor saving a block the moment it is dropped on the canvas and before its first edge is drawn (FR-007 requires an invalid draft never be written, so a rule this strict makes work-in-progress unsaveable). An unconnected block is visible as such on the canvas and needs no validator.                                                                                                                                          | TODO   |
| FR-004 | A levelling pass topologically sorts the DAG into levels and both binders compile from it — Mastra as `.then()`/`.parallel()` per level, Binding A as `phase()` per level. `pipelines/spec-creation.yaml` migrates to `dependsOn` and produces the same execution it does today.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | TODO   |
| FR-005 | A step's rendered context is scoped to its ancestors' outputs rather than the whole accumulated record, implemented as a filter over the existing step-id-keyed context map.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | TODO   |
| FR-006 | Canon index and draft buffer: `canon_source` (root, relative path, kind, content hash, parse state), `canon_draft` (body, base hash, validation state), `canon_draft_op` (edit ops for undo). Everything the editor shows loads from these; nothing an agent reads comes from them.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | TODO   |
| FR-007 | Canon writer: saving validates the draft with `loadPipeline`, re-hashes the file on disk, and refuses the save as a conflict when the hash differs from the draft's base hash. Writes go through the `yaml` Document AST so comments, key order and formatting survive. An invalid draft is never written and never lost.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | TODO   |
| FR-008 | DAG editor UI, resolved design: **level bands with a step inspector**. The canvas lays steps out in horizontal bands, one per execution level, so execution order is the primary visual fact rather than a consequence of node placement; a parallel level is marked as such. Edges are drawn between bands. A right-hand inspector edits the selected step's `kind`, `role`, `prompt` and gate `message` inline, and shows its `dependsOn` and computed level read-only. Steps can be added, removed and connected; a new pipeline seeds from a template without touching disk until it validates. A rejected save shows the validator's message verbatim. A free-floating canvas was rejected: it promises per-edge data routing the canon does not store. Decided from a three-variant prototype, kept on branch `prototype/editor-variants`. | TODO   |
| FR-009 | `pipelineToGraph` maps canon edges to render edges with no inference, and is the single producer consumed by both the UI and the binders.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | TODO   |
| FR-010 | Per-step lifecycle events reach the UI over SSE, sourced from Mastra's own run stream rather than hand-rolled wrappers, so a gate suspension is never reported as a step failure. A client connecting mid-run gets a snapshot, then the stream. Each event carries the step id, the resolved model, and the rendered prompt digest, so "the right model ran with the right prompt" is observable rather than asserted.                                                                                                                                                                                                                                                                                                                                                                                                                           | TODO   |
| FR-011 | A run suspended at a gate is approvable or rejectable from the UI and from the MCP `approve` tool, resolving the same Mastra run, and survives a server restart. Single-flight per run id; approving an already-resolved gate returns a defined error. Mastra's run id is the public run id.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | TODO   |
| FR-012 | Saving a pipeline regenerates its Claude Code workflow output, resolving models from the active profile and recording that profile in the output. Without this, an edit made in the GUI leaves Claude Code running the previous version.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | TODO   |
| FR-013 | A new `kind: export-spec` writes `spec.md` into the target repository in GitHub Spec Kit's format (github/spec-kit, `templates/spec-template.md`), which is what ADR-0003 means by Spec Kit style: User Scenarios with prioritised user stories and **Given**/**When**/**Then** acceptance scenarios, Functional Requirements as `FR-NNN: System MUST …`, Key Entities, measurable Success Criteria as `SC-NNN`, and `[NEEDS CLARIFICATION]` markers where the pipeline could not resolve something. Written fresh: the pre-pivot renderer emits `AC-` ids and a field table, and matches none of this.                                                                                                                                                                                                                                          | TODO   |
| FR-014 | Legacy purge: delete `src/cli.ts`, `src/config.ts`, `src/manifest.ts`, `src/stages/`, `src/checks/`, `src/executor/`, `src/tracker/`, `src/spec/`, `src/model/`, `src/module/registry.ts` and the orphan barrel files, keeping `src/module/seams.ts`, `src/db/` and `src/store/`, which the canon path uses. LiteLLM support is unaffected — it lives in the canon registry's `api` transport, not in the deleted gateway.                                                                                                                                                                                                                                                                                                                                                                                                                       | DONE   |
| FR-015 | The root is the directory the harness was launched in, not Yoke's install directory. The five call sites that hardcode `pipelines/` take that root, as does Binding A's output directory, and the draft database sits beside the canon under it. A scope flag selects a project-local pipeline (`<root>/.yoke/`) or a global one (user-level), with local shadowing global on an id collision. There is no project registry and no multi-project bookkeeping: Yoke never knows about more than the root it was started in.                                                                                                                                                                                                                                                                                                                       | TODO   |
| FR-016 | A second pipeline authored in the editor produces a spec for adopting spec-driven development, reusing at least one prompt or step from `spec-creation`. This is the reuse evidence ADR-0012 required before `agent` and `skill` become first-class templates.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | TODO   |
| FR-017 | A configurable per-step deadline aborts a hung step through the existing `AbortSignal` path, surfacing as a failed step rather than an indefinite hang.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | TODO   |
| FR-018 | Two live bugs fixed: prompt paths are contained within the pipeline root (`src/canon/load.ts:53`); caller-supplied `models` overrides are validated against registry ids, closing the passthrough in `ModelRegistry.resolve` that spawns an arbitrary `--model` string.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | TODO   |
| FR-019 | Local posture: bind `127.0.0.1` by default and refuse any non-loopback bind. Validate `Host` and `Origin` on every mutating request. Raw CLI stderr and upstream response bodies never enter an HTTP or SSE payload.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | TODO   |

## Staging

Nineteen requirements is not one MVP. Three stages, each ending in something demonstrable.

| Stage         | Requirements                     | Done when                                                                                                                                                                                                                                                              |
| ------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. Foundation | FR-001..005, FR-013..015, FR-018 | The decisions are recorded; the canon expresses edges and rejects a cycle; `spec-creation` runs unchanged from a `dependsOn` definition under both bindings; a run writes a Spec Kit `spec.md` into the launch root; the repo has no dead code. No UI yet.             |
| B. The editor | FR-006..012, FR-017, FR-019      | `yoke serve` binds loopback; a pipeline is drawn, connected, edited and saved from the browser; the save regenerates Binding A output; a run is watched step by step with its model and prompt visible; a gate is answered from either surface and survives a restart. |
| C. Reuse      | FR-016                           | A second pipeline, authored in the editor, produces an SDD adoption spec while reusing a step or prompt from the first — the evidence ADR-0012 requires before `agent` and `skill` become first-class.                                                                 |

## Acceptance

Stage B's demonstration is the one that matters, and it is deliberately the same run seen twice:

A pipeline is edited in the Yoke editor — opened once inside Claude Code's browser pane and once
inside T3 Code's desktop Browser panel — a connection is drawn between two blocks, the edit
validates and lands in the working tree with comments intact, Binding A output regenerates, and the
pipeline runs to a persisted ticket and an exported `spec.md` under the Anthropic profile, with the
approval gate answered after a server restart and every step's resolved model and prompt visible in
the run view. `pnpm check` green.

Two cheaper tests guard the risks the design exists to remove: edit the file behind a draft's back
and save — the save must be refused as a conflict and the draft must survive; and define a cycle —
the loader must reject it by name rather than hang the levelling pass.

## Out of scope

- **`agent` and `skill` as first-class templates.** Neither exists in the canon today — the word
  "skill" appears nowhere in `src/`. FR-016 supplies the reuse evidence ADR-0012 asked for; the
  split itself is the next spec. Until then, "the right skills were used" is not a criterion that
  can be evaluated, and is deliberately absent from acceptance.
- Conditional edges, loops and per-edge data mapping. FR-003 buys a DAG, not a flow language.
  Edges order execution and scope context; they do not carry mapped payloads.
- Delegating step execution to T3 Code's WebSocket orchestration.
- Non-loopback binding, remote approve, multi-user access, and any access control — justified only
  by the loopback-only bind; wanting a non-loopback bind makes it mandatory and is a new spec.

## Open questions

- The spec exporter currently guesses whether a requirement is a bare capability phrase or a full
  clause, so it knows whether to prepend `System MUST`. Guessing at English grammar with pattern
  rules will always misfire on some input. The durable fix is upstream: the intake and enrich
  prompts should ask for Spec Kit-shaped capability phrases, after which the renderer needs no
  heuristic at all. That is a canon prompt change, not a renderer change.
- Whether `.yoke/` is the right directory name for canon in a target project, or whether it should
  follow whatever neutral convention settles (`.agents/` is emerging in the wild).
- Whether the repo's existing specs are migrated to the Spec Kit format. FR-013 makes the pipeline
  emit user stories, Given/When/Then scenarios and `SC-` success criteria, but specs 013, 014 and
  this one use `FR-` with prose and no `SC-` at all. The generator and the corpus should not
  disagree indefinitely — either the corpus migrates, or ADR-0003 is amended to describe what is
  actually written.
- Provenance attribution is still wrong: `persistTicket` records `model` as a pipeline id and
  `agent` as a constant. Once a gate can be answered from three surfaces, a provenance row should
  record which surface and which model actually did the work.
- Where the draft database lives for a global pipeline, given a project-local one sits beside its canon under the launch root.
