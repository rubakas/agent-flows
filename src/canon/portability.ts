// Run-start portability check (spec 031 D3, FR-007).
//
// A pure function so `canon:check` can build the portability matrix (D4) without
// making a model call, and so the binding can refuse a step before dispatch. The
// runtime throws inside the adapters stay as defence in depth.

import { DEFAULT_ADAPTER_CONFIG, adapterFor } from "./adapters/index.js";
import { resolveStepModel } from "./registry.js";
import type { AdapterConfig } from "./adapters/index.js";
import type { ModelEntry, ModelRegistry, ProviderProfile } from "./registry.js";
import type { LoadedPipeline, StepDef } from "./types.js";

export type PortabilityResult = { ok: true } | { ok: false; reason: string };

/** Human-readable transport descriptor: `cli:claude`, `cli:codex`, or `api`. */
function transportLabel(entry: ModelEntry): string {
  return entry.transport === "cli" ? `cli:${entry.cli?.bin ?? "claude"}` : entry.transport;
}

export interface PortabilityOptions {
  config?: AdapterConfig;
  /**
   * The pipeline's `defaultMaxBudgetUsd`. A step inherits it when it declares no
   * budget of its own (the same resolution `buildLlmStep` applies), so an
   * inherited cap is refused at run start rather than at transport dispatch.
   */
  defaultMaxBudgetUsd?: number;
}

/**
 * Compares what the step declares against what the resolved adapter can enforce.
 * `entry` must be resolved exactly as the binding resolves it (ctx models
 * override first, else the profile role).
 */
export function checkPortability(
  step: StepDef,
  entry: ModelEntry,
  profileId: string,
  opts: PortabilityOptions = {}
): PortabilityResult {
  const capabilities = adapterFor(entry).capabilities(entry, opts.config ?? DEFAULT_ADAPTER_CONFIG);

  const refuse = (requirement: string): PortabilityResult => ({
    ok: false,
    reason:
      `step "${step.id}" under profile "${profileId}" resolves to model entry "${entry.id}" ` +
      `(transport ${transportLabel(entry)}), which cannot enforce ${requirement}`,
  });

  // Checked before `contents` so the refusal names the deny list rather than the
  // access mode: without this guard the failover chain has no guard for the
  // class at all, and the next adapter added inherits the same hole.
  if (step.permissions?.deny?.length && !capabilities.stepDenyPatterns) {
    return refuse("the step's declared permissions.deny globs");
  }

  const contents = step.permissions?.contents;
  if (contents === "read" && !capabilities.workspaceRead) {
    return refuse(`permissions.contents "read"`);
  }
  if (contents === "write" && !capabilities.workspaceWrite) {
    return refuse(`permissions.contents "write"`);
  }
  const effectiveBudget = step.maxBudgetUsd ?? opts.defaultMaxBudgetUsd;
  if (effectiveBudget !== undefined && !capabilities.budgetCap) {
    return refuse("maxBudgetUsd");
  }

  return { ok: true };
}

// ── Portability matrix (D4, FR-008) ───────────────────────────────────────────

/**
 * Verdict for one whole pipeline under one profile: the first refusal found, or
 * ok when every llm step — including the steps of nested loop bodies — resolves
 * to an adapter that can enforce what the step declares. Makes zero model calls.
 */
export function checkPipelinePortability(
  pipeline: LoadedPipeline,
  profile: ProviderProfile,
  registry: ModelRegistry,
  config: AdapterConfig = DEFAULT_ADAPTER_CONFIG
): PortabilityResult {
  // A nested body carries its own defaultMaxBudgetUsd, so the inherited cap is
  // resolved per pipeline rather than once at the top.
  const defaultMaxBudgetUsd = pipeline.def.defaultMaxBudgetUsd;
  for (const step of pipeline.def.steps) {
    if (step.kind === "llm") {
      const entry = resolveStepModel(step, profile, registry);
      const result = checkPortability(step, entry, profile.id, {
        config,
        ...(defaultMaxBudgetUsd !== undefined ? { defaultMaxBudgetUsd } : {}),
      });
      if (!result.ok) return result;
    }
    const body = pipeline.bodies?.[step.id];
    if (body) {
      const result = checkPipelinePortability(body, profile, registry, config);
      if (!result.ok) return result;
    }
  }
  return { ok: true };
}

/** The id of the first step named in a refusal reason, for the `refused: <step>` prefix. */
function refusedStepId(reason: string): string {
  return /step "([^"]+)"/.exec(reason)?.[1] ?? "?";
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

/**
 * Renders the pipeline × profile table printed by `pnpm canon:check` (D4).
 * One row per pipeline and profile: "runs" or "refused: <step>: <reason>".
 */
export function renderPortabilityMatrix(
  pipelines: LoadedPipeline[],
  profiles: ProviderProfile[],
  registry: ModelRegistry,
  config: AdapterConfig = DEFAULT_ADAPTER_CONFIG
): string {
  const pipelineWidth = Math.max(8, ...pipelines.map((p) => p.def.id.length));
  const profileWidth = Math.max(7, ...profiles.map((p) => p.id.length));

  const lines = [`${pad("PIPELINE", pipelineWidth)}  ${pad("PROFILE", profileWidth)}  VERDICT`];
  for (const pipeline of pipelines) {
    for (const profile of profiles) {
      const result = checkPipelinePortability(pipeline, profile, registry, config);
      const verdict = result.ok
        ? "runs"
        : `refused: ${refusedStepId(result.reason)}: ${result.reason}`;
      lines.push(
        `${pad(pipeline.def.id, pipelineWidth)}  ${pad(profile.id, profileWidth)}  ${verdict}`
      );
    }
  }
  return lines.join("\n");
}
