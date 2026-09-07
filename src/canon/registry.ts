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

/**
 * Constructs the default model registry.
 *
 * @param extra Project-supplied entries prepended before the built-ins.
 *   Find-first semantics mean any entry whose id matches a built-in id
 *   is resolved in favour of the project entry — no merge logic needed.
 */
export function defaultRegistry(
  env: NodeJS.ProcessEnv = process.env,
  extra?: ModelEntry[]
): ModelRegistry {
  return new ModelRegistry([
    ...(extra ?? []),
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

/**
 * Project-level provider configuration loaded from .agent-flows/providers.yaml.
 * Empty arrays mean the file is absent — behaviour identical to today.
 */
export interface ProviderConfig {
  /** Project-declared model entries; prepended before built-ins in the registry. */
  models: ModelEntry[];
  /** Project-declared profiles; searched before DEFAULT_PROFILES by getProfile. */
  profiles: ProviderProfile[];
  /** Optional default profile id; honoured by getActiveProfile when env var is absent. */
  defaultProvider?: string;
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

/** Returns the ids of the built-in provider profiles. Used by loadProviders for validation. */
export function builtInProfileIds(): string[] {
  return DEFAULT_PROFILES.map((p) => p.id);
}

/**
 * Returns the profile for the given id.
 * Searches extraProfiles first so project profiles override built-ins by id.
 * Throws a clear error naming all available ids (union of project + built-ins).
 */
export function getProfile(id: string, extraProfiles?: ProviderProfile[]): ProviderProfile {
  const allProfiles = [...(extraProfiles ?? []), ...DEFAULT_PROFILES];
  const profile = allProfiles.find((p) => p.id === id);
  if (!profile) {
    const available = allProfiles.map((p) => p.id).join(", ");
    throw new Error(`Unknown provider "${id}". Available: ${available}`);
  }
  return profile;
}

/**
 * Returns the active profile using the resolution order:
 *   1. AGENT_FLOWS_PROVIDER env var (explicit operator override)
 *   2. config.defaultProvider from providers.yaml
 *   3. "anthropic" (hardcoded fallback — unchanged from today)
 */
export function getActiveProfile(
  env: NodeJS.ProcessEnv = process.env,
  config?: ProviderConfig
): ProviderProfile {
  const id = env.AGENT_FLOWS_PROVIDER ?? config?.defaultProvider ?? "anthropic";
  return getProfile(id, config?.profiles);
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
