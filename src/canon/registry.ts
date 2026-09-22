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
    // fable: pinned to claude-fable-5-1 (fable-5 is legacy). Entry is kept so project overrides can
    // reference it explicitly, but NO built-in role profile maps to this id — the owner reserves
    // fable for chat orchestration and will not risk it inside automated workflows.
    { id: "fable", transport: "cli", cli: { bin: "claude", model: "claude-fable-5-1" } },
    // opus/sonnet/haiku: pinned to explicit versioned ids rather than bare CLI aliases.
    // A bare alias silently follows the newest — and therefore most expensive — model;
    // pinning makes cost predictable and prevents accidental tier upgrades on CLI updates.
    { id: "opus", transport: "cli", cli: { bin: "claude", model: "claude-opus-5" } },
    { id: "sonnet", transport: "cli", cli: { bin: "claude", model: "claude-sonnet-5" } },
    { id: "haiku", transport: "cli", cli: { bin: "claude", model: "claude-haiku-4-5" } },
    // codex: no model field by default — the CLI uses its own default when no -m
    // flag is passed, and AGENT_FLOWS_CODEX_MODEL overrides it. Kept unpinned
    // because the working model is account-dependent and a hardcoded id here
    // would break other operators. (The older note that the default resolves to
    // gpt-5.4-mini and is rejected with HTTP 400 is STALE: as of 2026-09-22 the
    // CLI's own picker lists gpt-5.6-terra as the default.)
    {
      id: "codex",
      transport: "cli",
      cli: {
        bin: "codex",
        ...(env.AGENT_FLOWS_CODEX_MODEL ? { model: env.AGENT_FLOWS_CODEX_MODEL } : {}),
      },
    },
    // The models the codex CLI actually offers, pinned the way the Claude tiers
    // are. Without these the openai side had one entry for every role, so the
    // role-to-model mapping — the thing this registry exists for — did not exist
    // there at all. Additive: `codex` above still resolves per account, so an
    // operator whose account lacks one of these is unaffected until they pick it.
    // terra/luna/5.5 are what this machine's `codex` picker offers (2026-09-22).
    { id: "gpt-terra", transport: "cli", cli: { bin: "codex", model: "gpt-5.6-terra" } },
    { id: "gpt-luna", transport: "cli", cli: { bin: "codex", model: "gpt-5.6-luna" } },
    { id: "gpt-5-5", transport: "cli", cli: { bin: "codex", model: "gpt-5.5" } },
    // sol and astra are documented API models the picker does NOT list, and
    // `codex -m` takes any string — validity is decided by the account at call
    // time, the way gpt-5.4-mini once failed with HTTP 400. Selectable so the
    // owner can pair them with their Claude counterparts (opus↔sol, fable↔astra),
    // but deliberately mapped to no role: a default nobody has verified on this
    // account would break every reasoner step the first time it ran.
    { id: "gpt-sol", transport: "cli", cli: { bin: "codex", model: "gpt-5.6-sol" } },
    { id: "gpt-astra", transport: "cli", cli: { bin: "codex", model: "gpt-6-astra" } },
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
  /**
   * Ordered profile ids to try when a step fails on this profile (spec 039).
   * Each candidate is tried once, in order; the first one that answers wins.
   * Absent or empty means the profile has no failover — its failures are final.
   */
  fallback?: string[];
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
    // reasoner=opus: most complex judgment steps; worker=sonnet: implementation/review;
    // scout=haiku: fast survey and condensing steps. fable is intentionally excluded from
    // all role profiles — owner decision, see registry comment on the fable entry.
    roles: { reasoner: "opus", worker: "sonnet", scout: "haiku" },
    // The two CLI profiles cover for each other. `local` is deliberately absent
    // from every chain: the api transport is a single POST with no tool loop, so
    // a local model cannot read files or run commands. It is a text-only reserve,
    // never a substitute for a repo-grounded step (owner decision, spec 039).
    fallback: ["openai"],
  },
  {
    // Tiered like `anthropic`, by the CLI's own descriptions: terra is the
    // "balanced agentic coding model for everyday work", so it plays both the
    // judgment and the implementation roles; luna is "fast and affordable", so
    // it plays scout. gpt-5.5 is previous-generation and maps to no role — it
    // stays selectable for a deliberate comparison, like fable on the other side.
    id: "openai",
    roles: { reasoner: "gpt-terra", worker: "gpt-terra", scout: "gpt-luna" },
    fallback: ["anthropic"],
  },
  {
    id: "local",
    roles: { reasoner: "ollama-qwen", worker: "ollama-qwen", scout: "ollama-qwen" },
  },
];

/**
 * Profiles the portability matrix reports on (spec 031 D4): the built-in
 * defaults, in declaration order.
 */
export const MATRIX_PROFILE_IDS: readonly string[] = DEFAULT_PROFILES.map((p) => p.id);

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
 * The active profile's id, or "unknown" when no profile can be resolved.
 * Callers that only record provenance must not fail because the provider
 * configuration is unreadable.
 */
export function activeProfileIdOrUnknown(
  env: NodeJS.ProcessEnv = process.env,
  config?: ProviderConfig
): string {
  try {
    return getActiveProfile(env, config).id;
  } catch {
    return "unknown";
  }
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
