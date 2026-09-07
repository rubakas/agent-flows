# Stage-1 Ticket Hardening (terminal MVP)

| Field        | Value                                   |
| ------------ | --------------------------------------- |
| Feature Name | Stage-1 Ticket Hardening (terminal MVP) |
| Branch       | `001-stage1-hardening`                  |
| Status       | Draft                                   |
| Created      | 2026-09-01                              |

The first buildable slice of agent-flows — take a task, interview the user, adversarially harden it, and freeze a spec. Terminal only; single node; no Stage 2/3/4, no GUI, no durable engine, no multi-machine.

---

## User Scenarios & Testing

### US1 (P1) — Give a task, get an interview

A developer runs `agent-flows harden <issue-number | ->`. agent-flows runs a conversational interview (via Pi) capturing intent, constraints, success criteria, and edge cases, and writes a structured ticket to SQLite.

**Independent Test:** Run on a vague task; confirm it asks clarifying questions and persists a ticket.

**Acceptance Scenarios:**

- **Given** a task from a GitHub issue or free text,
  **When** intake completes,
  **Then** the ticket has intent + ≥3 acceptance criteria + edge cases recorded.

---

### US2 (P1) — Adversarial hardening

A critic pass records weaknesses (`WEAK-` ids) and a security pre-check records findings (`SEC-` ids).

**Acceptance Scenarios:**

- **Given** a drafted ticket,
  **When** hardening runs,
  **Then** `WEAK-` and `SEC-` rows exist, and unresolved blocking ones block the gate.

---

### US3 (P1) — Gate + freeze

When the ticket passes the gate (every acceptance criterion maps to a testable assertion; no unresolved blocking `WEAK`/high-severity `SEC`; explicit human approval), agent-flows exports a frozen Spec Kit–format `spec.md` and sets the ticket state to `ready`.

**Acceptance Scenarios:**

- **Given** a gate-passing ticket,
  **When** the human approves,
  **Then** `specs/<n>-<slug>/spec.md` is written and the ticket state = `ready`.

---

### US4 (P2) — Seed from a GitHub issue

`agent-flows harden <issue-number>` ingests the issue title/body/labels via `gh` to pre-fill the ticket.

**Acceptance Scenarios:**

- **Given** an issue number,
  **When** harden starts,
  **Then** the ticket is pre-filled from the issue.

---

### Edge Cases

- Nonexistent or empty issue.
- User aborts mid-interview — ticket saved as `draft`.
- LiteLLM proxy unreachable — fail clearly; never fall back to a raw provider key.
- No acceptance criteria derivable — gate fails with a clear reason.

---

## Requirements

| ID     | Requirement                                                                                                                                                                                         |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FR-001 | System MUST provide a CLI `agent-flows harden <issue-number \| ->` (interactive when `-`).                                                                                                          |
| FR-002 | System MUST conduct a conversational intake via the Pi agent loop, asking clarifying questions until intent, acceptance criteria, and edge cases are captured.                                      |
| FR-003 | System MUST persist the ticket in SQLite (better-sqlite3 + Drizzle) across tables: `tickets`, `requirements`, `acceptance_criteria`, `weaknesses`, `security_findings`, `provenance`.               |
| FR-004 | System MUST run a critic step that writes `WEAK-` items.                                                                                                                                            |
| FR-005 | System MUST run a security pre-check that writes `SEC-` items.                                                                                                                                      |
| FR-006 | System MUST enforce a gate combining machine-checkable predicates (each acceptance criterion maps to a testable assertion; no unresolved blocking `WEAK`/high `SEC`) with mandatory human approval. |
| FR-007 | System MUST export a frozen `spec.md` in Spec Kit format (FR-/SC- ids, Given/When/Then) to `specs/<n>-<slug>/`.                                                                                     |
| FR-008 | System MUST route ALL model calls through the local LiteLLM proxy; the agent-flows process MUST NOT hold a real provider API key (only a revocable virtual key).                                    |
| FR-009 | System MUST ingest a GitHub issue via `gh issue view <n> --json title,body,labels`.                                                                                                                 |

**Key Entities:** Ticket, Requirement, AcceptanceCriterion, Weakness, SecurityFinding, Provenance.

---

## Success Criteria

| ID     | Criterion                                                                                                  |
| ------ | ---------------------------------------------------------------------------------------------------------- |
| SC-001 | A task goes from issue/free-text to a frozen `spec.md` plus a `ready` ticket within one terminal session.  |
| SC-002 | On an underspecified task, the critic surfaces at least one genuine weakness before the gate.              |
| SC-003 | No real provider API key is present in the agent-flows process environment (only the LiteLLM virtual key). |

---

## Out of Scope

- Stages 2/3/4.
- GUI.
- Multi-machine / remote attach.
- Durable engine.
- Backlog UI.

---

## Assumptions

- Single machine, terminal.
- Pi installed.
- LiteLLM proxy running locally.
- `gh` authenticated.
- Node ≥ 22.
