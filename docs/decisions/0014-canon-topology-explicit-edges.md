# 0014. Canon topology: explicit edges

Status: Accepted (2026-09-03)

Amends: ADR-0012, decision 3 (`group:` renamed to `phase:`). ADR-0012's ontology is unchanged.

## Context

ADR-0013 puts a graph editor in the product. The editor lets an operator draw connections between
blocks, so the question is whether the canon can store what was drawn.

It cannot. `StepDef` carries `id`, `kind`, `role`, `model`, `prompt`, `schema`, `phase` and
`message`, and none of those is a connection. The only topology mechanism is `phase:` — steps
sharing a phase string fan out in parallel and converge on a synthetic merge, and everything else
runs in declaration order. That expresses a sequence and a same-width fan-out. It cannot express an
independent concurrent subgraph, a step that depends on two others without those two being a phase,
or any per-edge relationship at all.

An editor whose edges cannot be saved is a drawing tool, not an editor. Either the canvas is
restricted to what `phase` can encode — a phase editor wearing a canvas costume — or the canon
gains an edge model. The project chose the edge model.

## Decision

1. **A step declares its predecessors: `dependsOn: string[]`.** A step with no `dependsOn` may start
   immediately. The graph is data in the canon, not an inference from array order.

2. **`phase:` is removed.** A phase is exactly the set of steps sharing the same dependencies, so
   keeping both would be two spellings of one idea. This amends ADR-0012 decision 3; the rename it
   performed is superseded rather than reverted.

3. **ADR-0012's ontology stands unchanged.** One composable noun `pipeline`, a flat `steps:` list,
   the leaf is `step`, depth still comes from a future self-nesting step kind, and "Action" is still
   rejected. This ADR changes how steps relate, not what a step is.

4. **The loader validates the graph.** Unknown references, cycles, duplicate ids and unreachable
   steps are rejected by `loadPipeline` with a message naming the offending step ids. A cycle must
   fail loudly at load, never hang a compiler.

5. **Both bindings compile the graph by levelling it.** A topological sort groups the DAG into
   ordered levels; each level becomes one parallel group and levels run in sequence. Mastra's
   `.then()`/`.parallel()` chain and Claude Code's `phase()` both accept that shape unchanged, so no
   execution framework has to learn about graphs.

6. **Edges order execution and scope context; they do not carry mapped payloads.** A step's rendered
   context is filtered to its ancestors' outputs rather than the whole accumulated record. Per-edge
   data mapping, conditional edges and loops are explicitly not adopted — this buys a DAG, not a
   flow language.

## Consequences

- `src/canon/types.ts`, `src/canon/load.ts`, `src/bindings/mastra/build.ts`,
  `src/bindings/claudeCode.ts` and every test asserting phase behaviour change together.
- `pipelines/spec-creation.yaml` migrates: `critic` and `security` become
  `dependsOn: [enrich]`, and `assemble` becomes `dependsOn: [critic, security]`. Its executed shape
  is unchanged, which makes the migration testable against current behaviour.
- Cycle detection becomes a correctness requirement rather than a nicety, because the levelling pass
  is shared by the editor and both binders — one bad definition would otherwise take down whatever
  process loaded it.
- Scoping context to ancestors changes what a prompt sees. Any prompt that silently relied on a
  non-ancestor step's output will surface as a rendering gap, which is the point: an edge now means
  something.
- The graph the editor draws and the graph the binder executes are the same object. Nothing in the
  UI infers topology.
