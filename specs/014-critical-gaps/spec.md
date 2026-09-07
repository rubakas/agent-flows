# 014. Critical gaps

| Field        | Value               |
| ------------ | ------------------- |
| Feature Name | Critical gaps       |
| Branch       | `014-critical-gaps` |
| Status       | Draft               |
| Created      | 2026-09-03          |

**Context:** Spec 013 delivered one provider-portable workflow that runs end to end under two providers. What remains is not polish: measured against the project Charter in README.md, two capabilities the Charter claims outright do not exist yet. The Charter says the tool is for "building, editing and running" dynamic workflows — only running is implemented; the MCP server exposes `list_pipelines`, `run_pipeline`, `approve` and `get_run`, and nothing that creates or edits a template. And a harness for LLM-assisted software development currently produces specs that never look at the codebase they are about to change — a gap the pipeline's own critic step flagged during a real run ("spec not anchored to any codebase"). Everything in this spec is scoped by one test: without it, the product does not do what the Charter says it does.

---

## Requirements

| ID     | Requirement                                                                                                                                                                                                                                                                                                                                                                                                                                          | Status |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| FR-001 | Authoring from chat. Creating and editing a pipeline, a prompt, or a registry profile is possible from a chat client without hand-editing files outside it. At minimum a validation tool so an edit can be checked before it is run; whether authoring is MCP write-tools or plain file edits plus validation is an open question below, but the round trip "describe a change in chat → the definition changes → it validates → it runs" must work. | TODO   |
| FR-002 | Codebase grounding. A pipeline can declare what repository context its steps receive, and steps can read the target codebase. Today prompts are rendered from inputs only, so a hardened spec is written blind. Must not silently widen file access: what a step may read is declared, not implicit.                                                                                                                                                 | TODO   |
| FR-003 | A second pipeline (`develop`) exists and reuses prompts or steps already used by `spec-creation`. Until a second consumer exists, "workflows, steps, skills and agents are templates" is an untested claim, and per ADR-0012 no reuse layer may be built before it.                                                                                                                                                                                  | TODO   |
| FR-004 | `agent` and `skill` become first-class templates, as the Charter states. A step references an agent profile (role, model policy, permitted tools) and a skill (reusable instruction), instead of carrying a prompt path and role inline. Blocked by FR-003 — do not build this before a real second consumer exists.                                                                                                                                 | TODO   |
| FR-005 | An approval gate survives a restart of the MCP server. Binding B currently tracks runs in an in-process map, so a run suspended at a gate is unrecoverable if the server restarts — unacceptable when the gate is a human answering in chat, possibly much later.                                                                                                                                                                                    | TODO   |
| FR-006 | Binding A honours the active provider. The generated `.claude/workflows/*.js` bakes in the models resolved at generation time, so switching `AGENT_FLOWS_PROVIDER` does not affect it until it is regenerated. Either resolve at run time or make regeneration automatic and detectable; provider portability is a Charter acceptance criterion, and Binding A currently only satisfies it by accident.                                              | TODO   |
| FR-007 | Configurable per-step timeout. The CLI transport supports `AbortSignal`-based cancellation, but no deadline mechanism exists; a hung provider CLI hangs the run indefinitely. Implement a timeout that aborts through the existing signal path.                                                                                                                                                                                                      | TODO   |

---

## Exit Criteria

FR-001 through FR-007 done; `pnpm check` green (current baseline 291 pass / 0 fail under Node 22); and one demonstration that ties them together — a workflow created or modified from chat, grounded in this repository, run to a persisted ticket, with the approval gate answered after an MCP server restart.

---

## Out of Scope

- A visual or graphical editor (still blocked on finding an option that meets the bar — see the Charter).
- Remote or multi-machine execution.
- Multi-user or tenanted runs.
- Any second binding beyond A and B.

---

## Open Questions

- Whether authoring should be MCP write-tools (the server mutates definition files) or plain file edits by the chat client plus a validation tool. The second is simpler and matches "definitions are files reviewed in git"; the first works for clients that cannot edit files. This choice decides FR-001's shape.
- How much repository context a step should receive, and how it is bounded — a path allowlist, a retrieval step, or the provider CLI's own file access. Each has a different security profile under the Charter's Layer-0 rule.
- Whether the pre-pivot implementation (`src/cli.ts`, `module/`, `executor/`, `model/`, `checks/`, `tracker/`, `stages/`, `spec/`, `manifest.ts` — 32 files, ~3000 lines, larger than the canon and both bindings combined) is cut or kept. It is a second implementation of the same hardening job. This is a pending decision, not a requirement, and is listed here so it is not lost.
