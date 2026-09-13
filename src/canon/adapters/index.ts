// Adapter dispatch (spec 031 D1, FR-001).

import { apiAdapter } from "./api.js";
import { claudeAdapter } from "./claude.js";
import { codexAdapter } from "./codex.js";
import type { ModelEntry } from "../registry.js";
import type { ProviderAdapter } from "./types.js";

export { DEFAULT_ADAPTER_CONFIG } from "./types.js";
export type { AdapterCapabilities, AdapterConfig, ProviderAdapter } from "./types.js";
export { WATCHDOG_DIGEST_CLOSE, WATCHDOG_DIGEST_OPEN } from "./claude.js";

/**
 * Returns the adapter that will execute a step resolved to `entry`.
 * Throws naming the entry when no transport matches — a step must never fall
 * through to an unsupervised default.
 */
export function adapterFor(entry: ModelEntry): ProviderAdapter {
  if (entry.transport === "cli") {
    const bin = entry.cli?.bin ?? "claude";
    if (bin === "claude") return claudeAdapter;
    if (bin === "codex") return codexAdapter;
    throw new Error(`adapterFor: unknown cli bin "${String(bin)}" for model entry "${entry.id}"`);
  }
  if (entry.transport === "api") return apiAdapter;
  throw new Error(
    `adapterFor: unknown transport "${String(entry.transport)}" for model entry "${entry.id}"`
  );
}
