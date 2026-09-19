// Provider adapter seam (spec 031 D1).
//
// `runLlmStep` dispatches to one of these instead of branching inline on
// transport. Supervision is deliberately NOT a capability: every `run()` must
// enforce the deadline or watchdog it has today, so a caller cannot construct an
// unsupervised adapter call (FR-002).

import type { ModelEntry } from "../registry.js";
import type { StepRunnerDeps } from "../stepRuntime.js";

/**
 * What a transport can actually enforce for a step, computed per call from the
 * entry and the resolved adapter config — never a hardcoded table (FR-003), so a
 * config change is reflected without an adapter rewrite.
 */
export interface AdapterCapabilities {
  /** Can serve `permissions.contents: read` with credential files invisible. */
  workspaceRead: boolean;
  /** Can serve `permissions.contents: write`. */
  workspaceWrite: boolean;
  /** Can enforce a per-step cost cap (`maxBudgetUsd`). */
  budgetCap: boolean;
  /**
   * Can enforce the step's own `permissions.deny` globs. A transport that cannot
   * must never be handed a step that declares one — a deny list the operator
   * wrote is a boundary, and a boundary only one provider honours is none.
   */
  stepDenyPatterns: boolean;
}

/** Adapter-level configuration resolved by the caller, not by the adapter. */
export interface AdapterConfig {
  /**
   * Whether the codex adapter composes the `agent_flows` permission profile
   * (D2). Without it codex cannot confine reads at all, so `workspaceRead` is
   * false. Defaults to true via DEFAULT_ADAPTER_CONFIG.
   */
  codexConfinement: boolean;
}

/** The configuration every caller gets unless it says otherwise. */
export const DEFAULT_ADAPTER_CONFIG: AdapterConfig = { codexConfinement: true };

export interface ProviderAdapter {
  id: "claude" | "codex" | "api";
  capabilities(entry: ModelEntry, config: AdapterConfig): AdapterCapabilities;
  /**
   * `config` is the same value `capabilities()` was asked about, so an adapter
   * can refuse at dispatch what it just declared it cannot enforce — defence in
   * depth behind `checkPortability`. Optional so an adapter that ignores it, and
   * a test that calls `run` directly, need not pass it; implementations default
   * to DEFAULT_ADAPTER_CONFIG.
   */
  run(
    prompt: string,
    entry: ModelEntry,
    deps: StepRunnerDeps,
    config?: AdapterConfig
  ): Promise<string>;
}
