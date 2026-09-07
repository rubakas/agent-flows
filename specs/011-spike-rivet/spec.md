# Spike: Rivet visual engine

| Field        | Value                      |
| ------------ | -------------------------- |
| Feature Name | Spike: Rivet visual engine |
| Branch       | `011-spike-rivet`          |
| Status       | Draft                      |
| Created      | 2026-09-01                 |

**Context:** agent-flows is pivoting from a bespoke TypeScript pipeline to a visual, node-graph workflow authoring and execution system. The operator authors workflows visually, watches execution live, and each node/step selects its own model and transport (local `claude`/`codex` CLI via subscription auth, or API models via OpenRouter/Ollama/LiteLLM). Constraint: OSI open-source, self-hosted, minimal bespoke code.

This spike validates **Rivet** (MIT, TypeScript, embeddable `@ironclad/rivet-node`), a visual node-graph engine with a desktop editor. It implements a single canonical "spec-creation" workflow to test Rivet's ability to: (1) run the user's local subscription-authenticated CLI on a host; (2) route different models across CLI and API transports per node; (3) pause/resume for human approval; (4) integrate with agent-flows' TS domain logic; (5) show live progress. On pass of the E1–E8 Evaluation Rubric, agent-flows adopts Rivet and records ADR-0011.

**Single-Machine Scope:** Deployment is a single machine (Linux or macOS); no distributing a pipeline/workflow across machines for now. This scope has a concrete upside for E1: `rivet-node` runs natively on the host (no Docker), so the local `claude`/`codex` CLI is directly reachable in-process, de-risking the make-or-break E1 capability (local CLI execution with real subscription auth).

**Design principle (tool-wide, carry into ADR-0011):** agent-flows is SELF-ASSEMBLING — a single bootstrap command builds and launches the whole tool from a fresh checkout (a couple of steps on a new machine).

---

## User Scenarios & Testing

### US1 (P1) — Local CLI node executes and returns output

A workflow node runs the user's local `claude -p` (subscription-authenticated), passes a prompt, and captures the response. This is the make-or-break capability.

**Acceptance Scenarios:**

- **Given** a Rivet host executor with `runClaudeCli` registered as an External Function,
  **When** a node in the workflow invokes `runClaudeCli(prompt, {model:"claude-3-5-sonnet"})`,
  **Then** the function spawns the local `claude` process, reads its subscription auth, executes the prompt, and returns the model's output to the node.

---

### US2 (P1) — Multi-transport model routing

Different nodes use different models: one uses the local CLI (`claude`), another uses an API model via LiteLLM (e.g. Ollama baseURL). The workflow author picks per node.

**Acceptance Scenarios:**

- **Given** the "spec-creation" workflow with 6 steps,
  **When** the author configures step 1 (`intake`) to use CLI and step 2 (`enrich`) to use LiteLLM Ollama,
  **Then** step 1 runs locally, step 2 calls the Ollama baseURL, both models route correctly, and downstream steps receive output.

---

### US3 (P1) — Human-in-the-loop approval gate

Step 5 (`approve`) pauses the run and requires human approval before proceeding.

**Acceptance Scenarios:**

- **Given** the workflow running and step 4 (`security`) complete,
  **When** step 5 (`approve`) is a User Input node that awaits user interaction,
  **Then** the run pauses, the operator is prompted in the Rivet editor, and resuming from the editor advances to step 6.

---

### US4 (P2) — Live progress visible in UI

The operator sees each node's state (running, complete, pending) and output in the Rivet editor in real time.

**Acceptance Scenarios:**

- **Given** the workflow running,
  **When** the Rivet editor is open and connected to the host executor,
  **Then** each node's status bar updates live, completion timestamps appear, and node output is readable.

---

### US5 (P2) — agent-flows integration: persist to SQLite

Step 6 (`create-ticket`) calls agent-flows' `DrizzleTicketStore` to insert the hardened spec into the tickets table.

**Acceptance Scenarios:**

- **Given** the workflow complete through step 5,
  **When** step 6 invokes a host function `persistTicket(spec)`,
  **Then** agent-flows' TicketStore writes the ticket, returns the ticket ID, and the workflow completes.

---

### US6 (P1) — Self-assembling bootstrap

The whole tool comes up from a fresh checkout with one command; external prereqs it can't install are checked and reported.

**Acceptance Scenarios:**

- **Given** a fresh checkout on a machine that has the external prerequisites (Rivet app, `claude` CLI logged in, Node ≥22),
  **When** the operator runs the single bootstrap command,
  **Then** dependencies install, the project builds, migrations run, the rivet-node host + model registry + host functions + store wire up, and the tool launches ready to run the spec-creation workflow — with no manual wiring; and any missing external prereq is flagged by preflight with a clear fix.

---

## Requirements

| ID     | Requirement                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FR-001 | Set up a `@ironclad/rivet-node` HOST process (TypeScript) that runs a Rivet graph headless and can be debugged/authored remotely via Rivet desktop editor.                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| FR-002 | Register External Function `runClaudeCli(prompt, opts)` that spawns the user's local `claude -p` with subscription auth, passes the prompt, and returns output.                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| FR-003 | Register External Function `resolveModel(nodeId)` that maps a node's configured model ID to either a Rivet API model config (LiteLLM/Ollama baseURL) or to `runClaudeCli`.                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| FR-004 | Author the "spec-creation" workflow in Rivet (`.rivet-project` file): 6 ordered steps (intake, enrich, critic, security, approve, create-ticket).                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| FR-005 | Use an External Call node for CLI steps (intake, critic, security) and a User Input node for the approve HITL gate.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| FR-006 | Register a host function to persist the hardened spec into agent-flows' SQLite `tickets` store (reuse `DrizzleTicketStore`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| FR-007 | Verify the host can tolerate long-running `claude -p` calls (minutes) without timing out.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| FR-008 | The spike MUST be self-assembling: a SINGLE bootstrap command (e.g. `pnpm bootstrap` / `agent-flows up`) brings the whole tool up from a fresh checkout — installs dependencies, builds, runs DB migrations, wires the `rivet-node` host + model registry + host functions + SQLite store, and launches it — with minimal manual steps. It MUST run a preflight/"doctor" check for external prerequisites it cannot install itself (Rivet desktop app present; `claude`/`codex` CLI installed AND logged in; Node ≥22) and clearly report anything missing with a fix hint. The bootstrap MUST be idempotent / re-runnable. |

---

## Exit Criteria (Shared Evaluation Rubric)

Score each PASS / PARTIAL / FAIL:

| ID  | Criterion                                                                                                                                          | Notes                                                        |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| E1  | **Local CLI on host:** a node runs the user's local `claude -p` (subscription auth) and returns its output.                                        | Make-or-break. Must execute with real auth, not mock.        |
| E2  | **Per-node model routing, both transports:** different models on different nodes, at least one CLI node and one API node (LiteLLM/Ollama baseURL). | Tests the flexibility to mix CLI + API without rewrites.     |
| E3  | **HITL gate:** the `approve` step pauses execution and resumes on human approval.                                                                  | Gate must block downstream steps until manual interaction.   |
| E4  | **Live progress:** the run's per-node progress/status is visible in the tool's UI.                                                                 | Operator can watch without polling; UI updates in real time. |
| E5  | **agent-flows integration:** a node can call agent-flows' existing TypeScript domain logic / SQLite ticket store. (How cleanly?)                   | Measures coupling friction; lower is better.                 |
| E6  | **Authoring UX:** how it feels to visually build/edit the sequence and change a node's model.                                                      | Subjective; note pain points, surprises, learnability.       |
| E7  | **Effort / bespoke surface:** rough LOC + pieces we had to write ourselves; maintainability read.                                                  | Gauge long-term maintenance burden.                          |
| E8  | **Fit & trust:** self-host, no paid tiers, no provider key in-process for CLI nodes, "one place" feel (operator runs one host and attaches).       | Aligns with agent-flows' design principles.                  |

---

## Known Risks & Unknowns

- **Desktop editor only:** Rivet's UI is an Electron desktop app, not a browser-embedded editor. Attachment requires both the operator and the host to run desktop editor + host process separately.
- **Release cadence / maintenance:** Rivet's release cadence may be stalled. Verify active development before committing.
- **External Call node permissions:** Rivet may sandbox External Call or Shell node execution for safety. Confirm that calling arbitrary host functions is permitted and not behind a feature flag.
- **Long-running I/O:** confirm the host executor tolerates `claude -p` calls that run for minutes without timeout or resource exhaustion.
- **Model configuration:** Rivet's model registry and per-node model assignment may require custom node types. Verify the SDK documentation for current APIs before implementation.

---

## Out of Scope

- Production hardening (auth, TLS, multi-machine fleet, HA).
- Full fractal nesting (sub-workflows within nodes).
- The complete agent-flows model registry (only a subset of models for this spike).
- Multi-machine orchestration or worker pool.
- Porting all 4 agent-flows pipeline stages (only the spec-creation workflow).
- Rivet's plugin ecosystem or advanced features (templating, conditional branching).
- Multi-machine / remote-attach / distributed pipeline (the prior bespoke orchestrator, spec 008, is dropped — it existed only for multi-machine).

---

## Decision

If Rivet passes the E1–E8 Evaluation Rubric (especially E1 local-CLI, E2 transport-mix, E5 agent-flows-integration, E8 fit), adopt it and record ADR-0011. If it fails a make-or-break criterion (e.g. E1), reconsider (e.g. a bespoke React-Flow web editor on a permissive TS engine, or pursue Kestra's Docker worker isolation more deeply).
