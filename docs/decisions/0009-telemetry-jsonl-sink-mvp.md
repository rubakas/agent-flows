# ADR-0009: MVP Telemetry — JSONL Sink

> **Superseded (2026-09-02):** JSONL sink removed with StageRunner; observability comes from binding runtimes (Claude Code transcripts / Mastra OTel), Phoenix stays a dormant option — see ADR-0011.

**Status:** Superseded by ADR-0011  
**Date:** 2026-09-01

## Decision

Ship a dependency-free `JsonlTelemetrySink` as the MVP `TelemetrySink` implementation. It appends span/log events as JSONL to a configurable file (`AGENT_FLOWS_TELEMETRY_PATH`, default `./agent-flows-telemetry.jsonl`) and exposes an `onEvent` hook for the orchestrator's live flow-monitor. A `NoopTelemetrySink` is included for tests. The OTel/OpenInference→Phoenix exporter (ADR-0005, FR-003) is deferred as a drop-in `TelemetrySink` module — no `@opentelemetry/*` or `@arizeai/*` dependencies are added now.

## Context

ADR-0004 (supply-chain security) requires careful vetting of every dependency. The OTel Node SDK + OpenInference instrumentation packages add a significant dependency surface before MVP trust boundaries are established. The `TelemetrySink` seam (spec 002) already decouples the pipeline from any specific telemetry backend, so the JSONL sink delivers per-agent logs and whole-flow spans locally without that surface. The orchestrator (spec 008) can subscribe to `onEvent` for real-time streaming instead of polling a Phoenix UI.

## Consequences

- Phoenix UI is not wired yet; operators read JSONL directly or via the orchestrator's event stream.
- Swapping in an `OtelSink` later requires only a new module descriptor + manifest flip — zero core changes.
- Span attrs follow the `agent-flows.*` convention (FR-002) from day one, so the OTel exporter will emit correct semantic attributes when it lands.
