# 012. Chat-first canon and bindings

| Field        | Value                         |
| ------------ | ----------------------------- |
| Feature Name | Chat-first canon and bindings |
| Branch       | `012-chat-first-canon`        |
| Status       | In progress                   |
| Created      | 2026-09-02                    |

**Context:** Rivet spike 011 validated the engine, but hands-on operator use revealed the primary surface is CHAT (Claude Code / any MCP client), not visual canvas. Pipelines/workflows are DATA under CRUD (edited as files), authored in chat, executed by thin bindings compiled from provider-neutral canonical definitions.

Provider-portability acceptance criterion: switch T3Code to GPT and the pipeline still runs — only registry entries change, canon is untouched.

---

## Requirements

| ID     | Requirement                                                                                                                                                                                | Status |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| FR-001 | Canon loader: `pipelines/*.yaml` + `prompts/*.md` + loader in `src/canon/` (schema kinds: llm \| gate \| assemble-spec \| persist-ticket; parallel via `phase`)                            | DONE   |
| FR-002 | Binding A generator: `pnpm bindings:claude` → `.claude/workflows/<id>.js` (generated; drift-guard)                                                                                         | DONE   |
| FR-003 | Binding B Mastra interpreter + MCP server (stdio; tools run_<pipeline>, get_run, approve; durable suspend/resume HITL; MASTRA_TELEMETRY_DISABLED; LibSQL separate from agent-flows.sqlite) | DONE   |
| FR-004 | Registry-driven step execution: steps execute via open model registry (claude CLI / codex CLI / ollama / litellm) (provider profiles added)                                                | DONE   |
| FR-005 | Doctor gains checks for binding B prereqs (codex optional, ollama optional)                                                                                                                | DONE   |

---

## Exit Criteria

The acceptance test from ADR-0011 (canon pipeline runs under Binding A and Binding B with only registry changes) + `pnpm check` green.

---

## Out of Scope

- Visual editor (diagram generation may come later).
- OpenHands binding (candidate Binding C).
- Multi-machine orchestration.
