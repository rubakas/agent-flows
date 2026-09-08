// FR-005 — deterministic entry-point selection for stage pipelines.
// Never calls a model; the rule is an inspectable function, not a model guess.
// Design C: "safeguard against wrong premises carried far."

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";

export type EntryKind = "feature-request" | "task-description";

export type DecideResult =
  { ok: true; pipeline: string; reason: string } | { ok: false; error: string };

/**
 * Decide which pipeline stage to enter given free-text or a file path input
 * and an optional explicit kind.
 *
 * Rule (spec 029 FR-005, Design C):
 * 1. If kind is provided: "feature-request" → investigate (formulation),
 *    "task-description" → develop (development).
 * 2. If kind is absent, infer from input's form only:
 *    a. Existing path whose JSON has spec+gateDecisions → develop (artifact signature).
 *    b. Existing path whose JSON has findings or plan → spec-creation (formulation feedback).
 *    c. Any other existing text file → develop (written task already exists).
 *    d. Path-like string that does not exist → error (caller returns HTTP 400).
 *    e. Free text (not a path) → investigate (conservative default).
 *
 * Returns { ok: true, pipeline, reason } or { ok: false, error }.
 * The reason always names the branch taken so the operator can correct a wrong inference
 * by restating kind in the subsequent POST /api/runs call.
 *
 * fs functions are injectable for unit testing without real files.
 */
export function decideEntryPoint(
  input: string,
  kind?: string,
  opts?: {
    existsFn?: (p: string) => boolean;
    readFileFn?: (p: string, enc: "utf8") => string;
  }
): DecideResult {
  const _exists = opts?.existsFn ?? existsSync;
  const _read = opts?.readFileFn ?? ((p: string, enc: "utf8") => readFileSync(p, enc));

  // ── Branch 1: explicit kind overrides all inference ───────────────────────
  if (kind !== undefined) {
    if (kind === "feature-request") {
      return {
        ok: true,
        pipeline: "investigate",
        reason: "explicit kind 'feature-request' routes to formulation (investigate)",
      };
    }
    if (kind === "task-description") {
      return {
        ok: true,
        pipeline: "develop",
        reason: "explicit kind 'task-description' routes to development (develop)",
      };
    }
    return {
      ok: false,
      error: `Unknown kind "${kind}"; must be "feature-request" or "task-description"`,
    };
  }

  // ── Branch 2: infer from input's form ─────────────────────────────────────

  // "Looks like a path" means an absolute path, an explicit ./ or ../ prefix,
  // or a name that succeeds existsSync — the spec check is existsSync.
  const pathLike = isAbsolute(input) || input.startsWith("./") || input.startsWith("../");

  if (pathLike || _exists(input)) {
    // Input is path-shaped or resolves to an existing file.
    if (!_exists(input)) {
      // Looks like a path but the file is absent — tell the caller before billing a run.
      return { ok: false, error: `File not found: ${input}` };
    }

    // File exists — read and classify.
    let content: string;
    try {
      content = _read(input, "utf8");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `Cannot read file ${input}: ${msg}` };
    }

    // Attempt JSON parse — artifacts are JSON; text task-descriptions are not.
    let parsed: Record<string, unknown> | null = null;
    try {
      const raw = JSON.parse(content) as unknown;
      if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
        parsed = raw as Record<string, unknown>;
      }
    } catch {
      // Not JSON — treat as plain text document.
    }

    if (parsed !== null) {
      // Artifact signature: spec + gateDecisions → development tier.
      if ("spec" in parsed && "gateDecisions" in parsed) {
        return {
          ok: true,
          pipeline: "develop",
          reason:
            "path to artifact with spec and gateDecisions fields — " +
            "artifact signature routes to development tier",
        };
      }
      // Formulation-feedback artifact: findings or plan → spec-creation.
      if ("findings" in parsed || "plan" in parsed) {
        return {
          ok: true,
          pipeline: "spec-creation",
          reason:
            "path to artifact with findings or plan fields — " +
            "routes to formulation feedback (spec-creation)",
        };
      }
    }

    // Readable file without an artifact signature → written task → development.
    return {
      ok: true,
      pipeline: "develop",
      reason:
        "path to an existing document in the project routes to development — " +
        "a written task already exists",
    };
  }

  // ── Branch 3: free text (not a file path) — conservative default ──────────
  return {
    ok: true,
    pipeline: "investigate",
    reason: "free text routes to formulation as the conservative default (investigate)",
  };
}
