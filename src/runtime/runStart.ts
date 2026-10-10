// Starting a run, below the HTTP route (spec 047 FR-10).
//
// Every rule that decides whether a request is a valid run lives here: which
// fields must be which type, which pipeline it names, whether its inputs and
// per-step model overrides belong to that pipeline, which provider profile it
// means, what an artifact path seeds, and how those are merged into the one
// workflow input the run starts with. The route is left with the transport:
// parse the body, call `startRun`, turn a refusal into a 400.
//
// A refusal is a caller error and is returned, never thrown. A throw out of here
// is a bug.

import { loadProviders, CLI_MODEL_RE } from "../canon/loadProviders.js";
import { builtInProfileIds, getProfile, type ProviderProfile } from "../canon/registry.js";
import { isRunControlKey } from "../canon/runContext.js";
import { resolveArtifactInputs } from "../serve/artifactInputs.js";
import { safePath } from "../serve/route-helpers.js";
import type { RunService, StartResult } from "./runService.js";
import type { Lookup, Pipelines } from "../canon/pipelines.js";

/** The raw JSON body of `POST /api/runs`: every field is untrusted until checked. */
export interface RunRequest {
  pipeline?: unknown;
  inputs?: unknown;
  models?: unknown;
  provider?: unknown;
  gateMode?: unknown;
  artifactPath?: unknown;
}

export interface RunStartDeps {
  runService: Pick<RunService, "start">;
  /** The merged view a run resolves its pipeline through; a run may name any layer's. */
  pipelines: Pipelines;
  projectDir: string;
  /** The state root every artifact this daemon produces lives under (spec 032 D2). */
  stateRoot: string;
  /**
   * The provider profiles the running workflows were built with, so validation
   * and execution cannot disagree about which exist. Absent: re-read
   * `providers.yaml` from the project.
   */
  providerProfiles?: ProviderProfile[];
}

export type RunStartOutcome =
  { ok: true; result: StartResult } | { ok: false; refusal: "invalid"; error: string };

const invalid = (error: string): RunStartOutcome => ({ ok: false, refusal: "invalid", error });

/**
 * Why a pipeline cannot be used, as a clause starting `pipeline "<name>"`. A
 * pipeline that exists but fails to load is not "not found": the loader's reason
 * is shown, with the layer's root path replaced as every route does.
 */
function unresolvedClause(lookup: Lookup, shown: string): string {
  if (lookup.kind === "broken") {
    const reason = safePath(lookup.error.message, lookup.file.layer.root);
    return `pipeline "${shown}" fails to load: ${reason}`;
  }
  return `pipeline "${shown}" not found`;
}

export async function startRun(req: RunRequest, deps: RunStartDeps): Promise<RunStartOutcome> {
  const { pipeline, inputs, models, provider, gateMode, artifactPath } = req;
  if (typeof pipeline !== "string") return invalid('Field "pipeline" must be a string');
  if (gateMode !== undefined && gateMode !== "manual" && gateMode !== "auto") {
    return invalid('Field "gateMode" must be "manual" or "auto"');
  }
  // FR-009/S6: inputs are workflow input values, so every one of them must be
  // a string — a nested object reaches a z.string() input and produces a run
  // that appears to succeed on garbled data.
  if (typeof inputs === "object" && inputs !== null && !Array.isArray(inputs)) {
    for (const [key, value] of Object.entries(inputs as Record<string, unknown>)) {
      if (typeof value !== "string")
        return invalid(`Input "${key.slice(0, 100)}" must be a string`);
    }
  }

  // Run entry resolution goes through the merged view (D13): a run may name a
  // workflow from any layer, not only the one writes target. The pipeline name is
  // caller-supplied like the keys are, so it is truncated the same way — an error
  // message is not a place to echo an unbounded request field back.
  const lookup = deps.pipelines.get(pipeline);
  const pipelineEntry = lookup.kind === "ok" ? lookup : undefined;
  const pipelineDef = pipelineEntry?.loaded.def;
  const shownPipeline = pipeline.slice(0, 100);

  // FR-009/S6: the per-step model override map is a flat step id → model id
  // record. Keys must name steps of this pipeline and values must be
  // registry-id-shaped, so a typo fails here rather than silently running the
  // profile default, and nothing unvalidated reaches the CLI argv.
  if (models !== undefined) {
    if (typeof models !== "object" || models === null || Array.isArray(models)) {
      return invalid('Field "models" must be an object');
    }
    if (!pipelineDef) {
      return invalid(
        `Field "models" cannot be validated: ${unresolvedClause(lookup, shownPipeline)}`
      );
    }
    const stepIds = new Set(pipelineDef.steps.map((s) => s.id));
    for (const [stepId, model] of Object.entries(models as Record<string, unknown>)) {
      if (!stepIds.has(stepId)) {
        return invalid(
          `Model override "${stepId.slice(0, 100)}" is not a step of "${shownPipeline}"`
        );
      }
      if (typeof model !== "string" || model.length > 100 || !CLI_MODEL_RE.test(model)) {
        return invalid(`Model override "${stepId.slice(0, 100)}" must be a model id`);
      }
    }
  }

  // The per-run provider names a profile, not a model. It is resolved here so
  // an unknown id fails at the boundary rather than inside a step, and so the
  // run's provenance records the profile the run will actually use.
  let runProfile: ProviderProfile | undefined;
  if (provider !== undefined) {
    if (typeof provider !== "string") return invalid('Field "provider" must be a string');
    let declaredProfiles: ProviderProfile[];
    if (deps.providerProfiles !== undefined) {
      declaredProfiles = deps.providerProfiles;
    } else {
      try {
        declaredProfiles = loadProviders(deps.projectDir).profiles;
      } catch (err) {
        return invalid(
          `Field "provider" cannot be validated: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
    const known = new Set([...declaredProfiles.map((p) => p.id), ...builtInProfileIds()]);
    if (!known.has(provider)) {
      return invalid(
        `Provider "${provider.slice(0, 100)}" does not name a known profile. Available: ${[...known].join(", ")}`
      );
    }
    runProfile = getProfile(provider, declaredProfiles);
  }

  // Extract explicit inputs early so the artifact check can skip inputs that
  // the operator already provided — those don't need to come from the artifact.
  const explicitInputs =
    typeof inputs === "object" && inputs !== null && !Array.isArray(inputs)
      ? (inputs as Record<string, unknown>)
      : {};

  // `inputs` is spread straight into the workflow context, which is also where
  // `provider` and `models` live — so an unfiltered object is a second door
  // onto both, bypassing every check above it. Keys are refused rather than
  // dropped: a silently discarded input is the failure mode this repo has been
  // bitten by, and a run whose provenance names a provider it never used is
  // worse than a 400.
  const explicitInputKeys = Object.keys(explicitInputs);
  const reservedKey = explicitInputKeys.find(isRunControlKey);
  if (reservedKey !== undefined) {
    return invalid(
      `Input "${reservedKey}" is reserved — pass it as the top-level "${reservedKey}" field instead`
    );
  }
  if (explicitInputKeys.length > 0) {
    if (!pipelineDef) {
      return invalid(
        `Field "inputs" cannot be validated: ${unresolvedClause(lookup, shownPipeline)}`
      );
    }
    const declared = new Set(pipelineDef.inputs ?? []);
    const unknownKey = explicitInputKeys.find((key) => !declared.has(key));
    if (unknownKey !== undefined) {
      return invalid(
        `Input "${unknownKey.slice(0, 100)}" is not an input of "${shownPipeline}". Declared: ${[...declared].join(", ")}`
      );
    }
  }

  // ── Artifact-path input resolution (spec 029 FR-003) ──────────────────────
  // When artifactPath is provided, inputs may be omitted; the artifact seeds
  // the run's inputs. If both are provided, artifact-derived values take
  // priority — the operator is being explicit about what to hand off.
  let artifactDerivedInputs: Record<string, unknown> = {};
  // FR-006: when chaining from a parent artifact, write the new stage's artifact
  // into the parent run's directory so all stages in a chain accumulate there.
  // The chain dir is the directory that contains the source artifact file.
  let chainArtifactDir: string | undefined;
  if (artifactPath !== undefined) {
    const resolved = resolveArtifactInputs({
      artifactPath,
      projectDir: deps.projectDir,
      stateRoot: deps.stateRoot,
      pipelineDef,
      explicitInputs,
    });
    if (!resolved.ok) return invalid(resolved.error);
    artifactDerivedInputs = resolved.inputs;
    chainArtifactDir = resolved.chainDir;
  }

  // inputs is required when no artifactPath is provided (existing behaviour).
  if (artifactPath === undefined) {
    if (typeof inputs !== "object" || inputs === null || Array.isArray(inputs)) {
      return invalid('Field "inputs" must be an object');
    }
  }

  // Last, so every refusal above keeps the message it had when this case reached
  // the run service and came back as a 500: starting a pipeline the view cannot
  // give us is a caller error.
  if (!pipelineEntry) {
    const clause = unresolvedClause(lookup, shownPipeline);
    return invalid(`P${clause.slice(1)}`);
  }

  // Merge explicit inputs and artifact-derived inputs; artifact takes priority
  // when both are present (FR-003: "artifactPath takes priority").
  const wfInput: Record<string, unknown> = {
    ...explicitInputs,
    ...artifactDerivedInputs,
    ...(models !== undefined ? { models } : {}),
    ...(runProfile !== undefined ? { provider: runProfile.id } : {}),
  };

  const result = await deps.runService.start(pipeline, wfInput, {
    gateMode: gateMode ?? "manual",
    pipelineSteps: pipelineEntry.loaded.def.steps,
    // Loop bodies are built like top-level steps but are absent from
    // def.steps, so without them their llm steps would be logged twice.
    ...(pipelineEntry.loaded.bodies !== undefined
      ? { pipelineBodies: pipelineEntry.loaded.bodies }
      : {}),
    ...(chainArtifactDir !== undefined ? { chainArtifactDir } : {}),
    ...(typeof artifactPath === "string" ? { artifactPath } : {}),
    ...(runProfile !== undefined ? { provider: runProfile } : {}),
  });
  return { ok: true, result };
}
