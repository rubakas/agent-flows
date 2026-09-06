// FR-003: Model registry — maps model IDs to CLI or API transport configs.

import type { Role, StepDef } from "./types.js";

export type ModelTransport = "cli" | "api";

export interface ModelEntry {
  id: string;
  transport: ModelTransport;
  cli?: { bin: "claude" | "codex"; model?: string };
  api?: { endpoint: string; keyEnv?: string; model?: string };
}

export class ModelRegistry {
  constructor(private readonly entries: ModelEntry[]) {}

  resolve(id: string): ModelEntry {
    const entry = this.entries.find((e) => e.id === id);
    if (entry) return entry;
    // Passthrough: any unknown id is treated as a claude CLI model alias or full name.
    return { id, transport: "cli", cli: { bin: "claude", model: id } };
  }

  list(): ModelEntry[] {
    return [...this.entries];
  }
}

export function defaultRegistry(env: NodeJS.ProcessEnv = process.env): ModelRegistry {
  return new ModelRegistry([
    // fable: pinned to claude-fable-5 — bare alias would track newest/most-expensive; this role backs most cycle steps
    { id: "fable", transport: "cli", cli: { bin: "claude", model: "claude-fable-5" } },
    { id: "opus", transport: "cli", cli: { bin: "claude", model: "opus" } },
    { id: "sonnet", transport: "cli", cli: { bin: "claude", model: "sonnet" } },
    { id: "haiku", transport: "cli", cli: { bin: "claude", model: "haiku" } },
    // codex: no model field — the CLI uses its own default when no -m flag is passed
    { id: "codex", transport: "cli", cli: { bin: "codex" } },
    {
      id: "ollama-qwen",
      transport: "api",
      api: {
        endpoint: `${env.OLLAMA_BASE_URL ?? "http://localhost:11434"}/v1/chat/completions`,
        model: "qwen2.5:1.5b",
      },
    },
    {
      id: "litellm",
      transport: "api",
      api: {
        endpoint: `${env.LITELLM_BASE_URL ?? "http://localhost:4000"}/v1/chat/completions`,
        keyEnv: "LITELLM_VIRTUAL_KEY",
        model: env.LITELLM_MODEL ?? "default",
      },
    },
  ]);
}

// FR-002: Provider profiles — map capability roles to concrete registry entry ids.

export interface ProviderProfile {
  id: string;
  roles: Record<Role, string>;
}

const DEFAULT_PROFILES: ProviderProfile[] = [
  {
    id: "anthropic",
    roles: { reasoner: "fable", worker: "sonnet", scout: "haiku" },
  },
  {
    id: "openai",
    roles: { reasoner: "codex", worker: "codex", scout: "codex" },
  },
  {
    id: "local",
    roles: { reasoner: "ollama-qwen", worker: "ollama-qwen", scout: "ollama-qwen" },
  },
];

/** Returns the profile for the given id; throws a clear error naming available ids. */
export function getProfile(id: string): ProviderProfile {
  const profile = DEFAULT_PROFILES.find((p) => p.id === id);
  if (!profile) {
    const available = DEFAULT_PROFILES.map((p) => p.id).join(", ");
    throw new Error(`Unknown provider "${id}". Available: ${available}`);
  }
  return profile;
}

/** Returns the active profile from AGENT_FLOWS_PROVIDER env, defaulting to "anthropic". */
export function getActiveProfile(env: NodeJS.ProcessEnv = process.env): ProviderProfile {
  return getProfile(env.AGENT_FLOWS_PROVIDER ?? "anthropic");
}

/**
 * Resolves a step to its ModelEntry via role indirection or explicit model id.
 * - step.model present → registry passthrough (explicit override wins).
 * - step.role present → profile.roles[role] → registry lookup.
 */
export function resolveStepModel(
  step: StepDef,
  profile: ProviderProfile,
  registry: ModelRegistry
): ModelEntry {
  if (step.model) {
    return registry.resolve(step.model);
  }
  const modelId = profile.roles[step.role!];
  return registry.resolve(modelId);
}
