# Module System (plugin registry)

| Field        | Value                           |
| ------------ | ------------------------------- |
| Feature Name | Module System (plugin registry) |
| Branch       | `002-module-system`             |
| Status       | Draft                           |
| Created      | 2026-09-01                      |

The modularity foundation — every capability plugs into a typed seam; modules connect and disconnect via a config manifest. No provider is hard-wired.

Seams (TypeScript interfaces): `TrackerProvider`, `ModelGateway`, `Executor`, `Stage`, `Check`, `TicketStore`, `TelemetrySink`.

---

## User Scenarios & Testing

### US1 (P1) — Register & resolve by seam

A typed `Registry` exposes `register(seam, module)` / `get(seam)` / `list(seam)`. Core always resolves capabilities through the registry, never by direct import.

**Acceptance Scenarios:**

- **Given** modules registered for a seam,
  **When** core resolves that seam,
  **Then** the configured active implementation is returned.

---

### US2 (P1) — Enable/disable via config manifest

Each seam's active module is declared in a config manifest; disabled modules are never loaded.

**Acceptance Scenarios:**

- **Given** a manifest enabling one tracker,
  **When** agent-flows starts,
  **Then** only enabled modules load; disabled ones are inactive.

---

### US3 (P2) — Clear failure on a missing required seam

Starting agent-flows with a required seam unfilled produces an actionable error, not a runtime crash.

**Acceptance Scenarios:**

- **Given** no provider registered for a required seam,
  **When** agent-flows starts,
  **Then** a clear error names the missing seam and exits.

---

## Requirements

| ID     | Requirement                                                                                                                                              |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FR-001 | System MUST define TypeScript interfaces for all seams: `TrackerProvider`, `ModelGateway`, `Executor`, `Stage`, `Check`, `TicketStore`, `TelemetrySink`. |
| FR-002 | System MUST provide a typed `Registry` with `register(seam, module)`, `get(seam)`, and `list(seam)`.                                                     |
| FR-003 | System MUST load and activate modules per a config manifest that enables/disables modules per seam.                                                      |
| FR-004 | Each module MUST declare `id`, `seam`, and an optional config schema.                                                                                    |
| FR-005 | System MUST fail with a clear error naming the seam when a required seam has no registered implementation.                                               |

---

## Out of Scope

- Hot-reload of modules at runtime.
- A plugin marketplace or remote module registry.
