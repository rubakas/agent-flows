// Artifact → run-inputs resolution (spec 029 FR-003/FR-011): turning the
// `artifactPath` a caller hands POST /api/runs into the inputs the next stage
// starts with. Lives outside server.ts because the rules here — path
// containment, artifact shape, the field mapping and how a mapped value becomes
// a string — decide what a chained run reads, and none of them are about HTTP.
// The route's only job is to turn a refusal into a 400.

import { readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { isContained } from "../bundle/paths.js";
import { renderSpecKitSpec } from "../canon/exportSpec.js";
import { activeProfileIdOrUnknown } from "../canon/registry.js";
import type { HardenedSpec, PipelineDef } from "../canon/types.js";

// ── Artifact input mapping (spec 029 FR-003/FR-011) ───────────────────────────

/**
 * Maps each well-known pipeline input name to the artifact field that carries
 * its value. Canon lives here; the same fact is mirrored as a comment in each
 * pipeline YAML so stage authors know what field to output and stage callers
 * know where to read — but a second machine-readable copy would drift.
 *
 *   plan     ← artifact.spec          (spec-creation outputs spec; build/audit/develop read it as plan)
 *   findings ← artifact.result.findings  (result is the run's accumulated context keyed by step id;
 *                                          the step named "findings" holds the string value)
 *
 * Resolution rule (spec 029 FR-003, derived from live defect):
 *   - If the mapped field is a string, use it directly.
 *   - If the mapped field is a HardenedSpec object (shape-checked on its two
 *     required fields: title and description), render it with renderSpecKitSpec
 *     so the text the next stage receives is byte-identical to the spec.md the
 *     human approved at the gate — not an ad-hoc serialisation.
 *   - If the mapped field is some other object that has a key matching the input
 *     name and that value is a string, use that (handles accumulated-context).
 *   - Otherwise refuse at the HTTP boundary — silently serialising an object
 *     into a z.string() input produces a run that passes Mastra schema validation
 *     on a technicality while reviewing the wrong data (this repo was bitten by
 *     this failure mode: a stage reported success while its input was garbled).
 */
const ARTIFACT_INPUT_FIELDS: Readonly<Record<string, "spec" | "result">> = {
  plan: "spec",
  findings: "result",
};

// Recognises a HardenedSpec by its two required fields. Optional fields
// (requirements, acceptanceCriteria, weaknesses, securityFindings) are not
// checked — the renderer handles absent optionals gracefully. Checking the
// required fields is precise enough to distinguish from accumulated-context
// objects (whose keys are step ids, not spec field names) without importing
// a full validator.
function isHardenedSpec(v: Record<string, unknown>): boolean {
  return typeof v.title === "string" && typeof v.description === "string";
}

/**
 * Resolve an artifact path supplied by an HTTP request.
 *
 * Absolute paths are allowed — the operator may deliberately cross project
 * boundaries (spec 029 FR-003 Design F). Relative paths must stay inside
 * projectDir; the same containment principle as assertSafePath (bundle/paths.ts)
 * applies but adapted for the absolute-path cross-project use case.
 */

/**
 * `candidate` with every symlink on its existing prefix resolved, keeping the
 * components that do not exist yet.
 *
 * The candidate itself usually does not exist (a chain writes new artifacts
 * beside the one it was handed), so realpath cannot be called on it directly.
 * The missing components must be carried over rather than dropped: returning
 * the nearest existing ancestor alone would shorten a not-yet-created state
 * root to its parent directory — and a containment check against a parent
 * accepts everything beside it. That bug was live in this function for one
 * commit-sized moment and is exactly what the "/tmp/x is rejected" test pins.
 */
function realpathish(candidate: string): string {
  const abs = resolve(candidate);
  let current = abs;
  const missing: string[] = [];
  for (;;) {
    try {
      const real = realpathSync(current);
      return missing.length > 0 ? join(real, ...missing.reverse()) : real;
    } catch {
      const parent = dirname(current);
      if (parent === current) return abs;
      missing.push(basename(current));
      current = parent;
    }
  }
}

/**
 * Resolve an artifact path supplied by an HTTP request (or the MCP tools, which
 * proxy through the same route).
 *
 * The path decides where the *next* stage's artifacts are written
 * (`chainArtifactDir`, `runService.ts`), so an unconstrained value turns
 * "continue this chain" into "write JSON anywhere this daemon can reach" and
 * "read any JSON file on the machine". Every artifact this daemon produces
 * lives under the state root (spec 032 D2), so that root is the boundary:
 * cross-*project* handoff still works — every project's state lives under the
 * same root — while paths outside it are refused.
 *
 * A symlink is resolved before the check, so a link planted inside the state
 * root cannot be used to step outside it.
 */
function resolveArtifactPath(
  projectDir: string,
  artifactPath: string,
  stateRoot: string
): { ok: true; resolved: string } | { ok: false; error: string } {
  if (!artifactPath || artifactPath.includes("\0")) {
    return { ok: false, error: `Invalid artifact path: ${JSON.stringify(artifactPath)}` };
  }

  let resolved: string;
  if (isAbsolute(artifactPath)) {
    resolved = resolve(artifactPath);
  } else {
    // Relative paths: resolve from projectDir and verify containment there first,
    // so a traversal attempt is reported as what it is.
    // path.join strips leading slashes from non-first args, so absolute-looking
    // relative paths (e.g. the empty string after stripping) cannot escape here.
    resolved = resolve(join(projectDir, artifactPath));
    if (!isContained(projectDir, resolved)) {
      return {
        ok: false,
        error: `Artifact path ${JSON.stringify(artifactPath)} escapes the project directory — rejected`,
      };
    }
  }

  const realRoot = realpathish(stateRoot);
  if (!isContained(realRoot, realpathish(resolved))) {
    return { ok: false, error: `artifactPath must be under ${realRoot}` };
  }
  return { ok: true, resolved };
}

/** What the resolver hands back: the seeded inputs, or why the artifact was refused. */
export type ArtifactInputsResult =
  | {
      ok: true;
      /** Inputs derived from the artifact. Take priority over the caller's own. */
      inputs: Record<string, unknown>;
      /**
       * FR-006: the directory holding the source artifact. The next stage writes
       * its own artifact there so every stage in a chain accumulates together.
       */
      chainDir: string;
    }
  | { ok: false; error: string };

/**
 * Resolve the inputs a run should start with from the artifact a caller named.
 *
 * Every refusal is a caller error (a 400 at the route), never an exception: a
 * bad path, a missing or unparsable file, an artifact that is still running or
 * carries an unknown status, a mapped field that cannot become a string, or a
 * required input that neither the artifact nor `explicitInputs` supplies.
 *
 * Inputs the caller passed explicitly are consulted only to decide whether a
 * declared input still counts as unresolved — they are NOT returned here. The
 * caller merges them itself, with these values winning (FR-003).
 */
export function resolveArtifactInputs(params: {
  /** The raw `artifactPath` field from the request body; its type is checked here. */
  artifactPath: unknown;
  projectDir: string;
  /** The state root every artifact this daemon produces lives under (spec 032 D2). */
  stateRoot: string;
  /** The target pipeline, when it could be loaded; its declared inputs drive the mapping. */
  pipelineDef: PipelineDef | undefined;
  /** Inputs the caller supplied on the request, used only as a presence check. */
  explicitInputs: Record<string, unknown>;
}): ArtifactInputsResult {
  const { projectDir, stateRoot, pipelineDef, explicitInputs } = params;
  const artifactDerivedInputs: Record<string, unknown> = {};

  const artifactPath = params.artifactPath;
  if (typeof artifactPath !== "string") {
    return { ok: false, error: 'Field "artifactPath" must be a string' };
  }

  // Resolve and contain the path — absolute paths cross project boundaries
  // (allowed by design), relative paths must stay inside projectDir.
  const pathResult = resolveArtifactPath(projectDir, artifactPath, stateRoot);
  if (!pathResult.ok) {
    return { ok: false, error: pathResult.error };
  }

  // Load the artifact file.
  let artifactRaw: string;
  try {
    artifactRaw = readFileSync(pathResult.resolved, "utf8");
  } catch {
    return { ok: false, error: `Artifact file not found: ${pathResult.resolved}` };
  }

  // Parse and validate the artifact shape.
  let artifact: Record<string, unknown>;
  try {
    const artifactParsed: unknown = JSON.parse(artifactRaw);
    if (
      typeof artifactParsed !== "object" ||
      artifactParsed === null ||
      Array.isArray(artifactParsed)
    ) {
      return { ok: false, error: "Artifact is not a valid JSON object" };
    }
    artifact = artifactParsed as Record<string, unknown>;
  } catch {
    return { ok: false, error: "Artifact file contains invalid JSON" };
  }

  // Reject artifacts without a status field — not an artifact shape.
  const artifactStatus = artifact.status;
  if (typeof artifactStatus !== "string") {
    return { ok: false, error: "Not a valid artifact: missing or non-string status field" };
  }

  // Reject in-flight artifacts — their content is incomplete (FR-003).
  if (artifactStatus === "running") {
    return {
      ok: false,
      error: "Cannot use an artifact from a running stage — wait for it to settle first",
    };
  }

  // Reject unknown statuses — indicates a corrupt or incompatible artifact.
  const KNOWN_STATUSES = new Set(["succeeded", "awaiting_approval", "failed", "rejected"]);
  if (!KNOWN_STATUSES.has(artifactStatus)) {
    return {
      ok: false,
      error: `Artifact has unknown status "${artifactStatus}" — not a recognisable terminal artifact`,
    };
  }

  // FR-004: log when crossing provider boundaries. Informational, not a warning —
  // this is the intended path for "continue on GPT when Claude is down".
  const artifactProvenance = artifact.provenance as Record<string, unknown> | undefined;
  const artifactProfileId =
    typeof artifactProvenance?.profileId === "string" ? artifactProvenance.profileId : undefined;
  const currentProfileId = activeProfileIdOrUnknown();
  if (artifactProfileId !== undefined && artifactProfileId !== currentProfileId) {
    console.log(
      `[agent-flows] stage handoff: artifact produced by profile "${artifactProfileId}", ` +
        `new run uses profile "${currentProfileId}"`
    );
  }

  // Resolve the target pipeline's declared inputs from the artifact fields.
  // The mapping and resolution rule are defined in ARTIFACT_INPUT_FIELDS above.
  // Only required inputs (not in optionalInputs) must be resolved; optional ones
  // may be absent without failing — the Mastra schema gives them default "".
  const declaredInputs = pipelineDef?.inputs ?? [];
  const optionalInputs = new Set(pipelineDef?.optionalInputs ?? []);
  const artifactFields = Object.keys(artifact).filter(
    (k) => k !== "provenance" && k !== "steps" && k !== "gateDecisions"
  );
  const unresolved: string[] = [];
  let resolveError: string | null = null;

  for (const inputName of declaredInputs) {
    if (resolveError !== null) break;
    const artifactField = ARTIFACT_INPUT_FIELDS[inputName];
    if (artifactField !== undefined) {
      const fieldValue = artifact[artifactField];
      if (fieldValue !== undefined) {
        if (typeof fieldValue === "string") {
          // Mapped field is a bare string — use it as-is. Artifact takes
          // priority over any explicit input the operator also provided.
          artifactDerivedInputs[inputName] = fieldValue;
        } else if (
          typeof fieldValue === "object" &&
          fieldValue !== null &&
          !Array.isArray(fieldValue)
        ) {
          const obj = fieldValue as Record<string, unknown>;
          if (isHardenedSpec(obj)) {
            // artifact.spec is the structured HardenedSpec that spec-creation writes.
            // Render it with the canonical renderer so the plan text the next stage
            // receives is byte-identical to the spec.md the human approved at the gate,
            // not an ad-hoc serialisation that diverges from the reviewed document.
            artifactDerivedInputs[inputName] = renderSpecKitSpec(obj as unknown as HardenedSpec);
          } else {
            // Mapped field is an object that is not a spec (e.g. accumulated-context
            // keyed by step id). Look for a key that matches the input name and holds
            // a string. Using the whole object would silently pass a non-string into a
            // z.string() input — the workflow engine accepts it through its Mastra layer
            // and produces a run that appears to succeed while operating on garbled data
            // (this repo was bitten by this failure mode; spec 029 FR-003).
            const nested = obj[inputName];
            if (typeof nested === "string") {
              artifactDerivedInputs[inputName] = nested;
            } else {
              const heldType =
                nested === undefined ? `key "${inputName}" is absent` : `type "${typeof nested}"`;
              const availableKeys = Object.keys(obj).join(", ");
              resolveError =
                `Input "${inputName}" cannot be resolved to a string from artifact ` +
                `field "${artifactField}": the field is an object but ${heldType} ` +
                `(available keys: [${availableKeys}]). ` +
                `Artifact: ${pathResult.resolved}.`;
            }
          }
        } else {
          // Non-string, non-object value (number, array, boolean) — cannot be
          // coerced into a string input without silently corrupting the run.
          resolveError =
            `Input "${inputName}" cannot be resolved from artifact field ` +
            `"${artifactField}": expected string or object, got ${typeof fieldValue}. ` +
            `Artifact: ${pathResult.resolved}.`;
        }
      } else if (!optionalInputs.has(inputName) && !(inputName in explicitInputs)) {
        // Required input not in artifact AND not explicitly provided — fail loud
        // rather than start with an empty input. This repo was bitten once by a
        // step whose input was silently discarded while the run still reported
        // success.
        unresolved.push(inputName);
      }
    } else if (!optionalInputs.has(inputName) && !(inputName in explicitInputs)) {
      // No mapping exists for this input name and the operator did not supply it.
      unresolved.push(inputName);
    }
  }

  if (resolveError !== null) {
    return { ok: false, error: resolveError };
  }

  if (unresolved.length > 0) {
    return {
      ok: false,
      error:
        `Cannot resolve required input(s) [${unresolved.join(", ")}] from artifact. ` +
        `Artifact carried fields: [${artifactFields.join(", ")}]. ` +
        `Known mappings: plan←artifact.spec (string), findings←artifact.result.findings (string).`,
    };
  }

  return { ok: true, inputs: artifactDerivedInputs, chainDir: dirname(pathResult.resolved) };
}
