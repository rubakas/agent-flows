# Dogfood: running spec-creation on a real task (2026-09-04)

We ran yoke's own `spec-creation` pipeline on a real upcoming task — "build a proper installable
n8n community node package for the Yoke agent" — to evaluate the pipeline's quality on real work.
Verdict: **the content is strong; the plumbing has three real gaps.**

## Content quality — good

The pipeline produced a genuinely useful hardened spec ("Yoke Agent n8n Node"): 7 requirements,
6 acceptance criteria, **30 weaknesses (7+ critical/blocking), 16 security findings**. The critic
and security passes caught real, serious issues, not filler — e.g.:

- Argument injection into the `claude` spawn (prompt/model/dir unsanitised).
- Read-only guarantee (`--allowedTools Read,Glob`) defeated by project-scoped Claude config.
- The spawned `claude` inherits n8n's entire environment — `N8N_ENCRYPTION_KEY`, DB creds.
- Prompt passed as a CLI arg leaks into the host process table (`ps`).
- Synchronous spawn would block n8n's event loop; no timeout; multi-item execution undefined.

These became hard guardrails for the actual build. The pipeline earns its keep on content.

## Plumbing gaps — three real findings

1. **The investigation is blind.** `spec-creation.yaml`'s steps do not declare `workspace: read`,
   so the pipeline writes the spec from the request text alone — it never reads the target repo,
   even though the read-only grounding capability now exists (`workspace: "read"` in `runStep`).
   The spec above was written without looking at the code. Wiring grounding into the pipeline (and
   having the daemon pass the project root as the workspace dir) is the highest-value fix.

2. **You cannot see what you are approving.** At the gate, `GET /api/runs/:id` and the SSE
   `snapshot` return only `{runId, pipelineId, status}` — not the assembled spec. The spec is only
   delivered on the live `gate.raised` event (or the `approve` response). A client that connects
   after the gate is raised cannot retrieve the spec at all. The run state / snapshot must include
   the gate payload so a reviewer can read the spec before approving.

3. **No reviewable spec.md is written.** The pipeline's `persist` step writes the spec into
   `yoke.sqlite` (tickets + related tables) but does not write a `spec.md` file. The Spec Kit
   exporter (`src/canon/exportSpec.ts`) exists but is not wired into the pipeline, so the git-backed
   spec artifact ADR-0003 calls for is never produced by a run. To read the spec here we had to
   query SQLite by hand. `export-spec` should be a step kind the pipeline runs.

## Operational notes

- A run took ~180s for 4 LLM steps (2 on `opus`) — expected, not a defect.
- `RunService.get` returning minimal state also made polling opaque (status only). Related to gap 2.

## Backlog produced

- Wire `workspace: read` into `spec-creation.yaml` investigation steps; have the daemon/RunService
  pass the launch/project root as the workspace dir.
- Include the gate payload (spec) in run state / SSE snapshot so it is retrievable after the fact.
- Add an `export-spec` step (the Spec Kit exporter) so a run writes a git-backed `spec.md`.
