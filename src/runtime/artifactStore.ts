// Writes durable run artifacts and manages the .gitignore default for runs/.
// Spec 029 FR-001/FR-002/FR-008.
//
// Intentionally does not import from runService.ts — the two modules form a
// one-way dependency (runService → artifactStore) so there is no cycle.

import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

// ── Provenance types ──────────────────────────────────────────────────────────

/**
 * Per-step model and transport info recorded in every artifact.
 * Only entries whose model is known are present — an invented value is worse
 * than an absent one (spec 029 Design B).
 */
export interface StepProvenance {
  transport: "cli" | "api";
  /**
   * Registry entry id — e.g. "opus", "codex", "ollama-qwen".
   * Never a key, secret, or API token.
   */
  modelId: string;
  /** Human-readable model name from the registry entry, e.g. "claude-opus-5". */
  model?: string;
  /** Token counts for API transports (endpoint returns usage); absent for CLI. */
  inputTokens?: number;
  outputTokens?: number;
}

/**
 * Provenance block attached to every artifact.
 * A reader can tell which provider produced the artifact without the daemon running.
 */
export interface ArtifactProvenance {
  /** Matches the pipeline id used to start the run. */
  pipelineId: string;
  /** Active provider profile id, e.g. "anthropic", "openai", "local". */
  profileId: string;
  /**
   * Per-step model info, keyed by step id.
   * Empty when the step model cannot be determined without guessing.
   */
  transportPerStep: Record<string, StepProvenance>;
  /** ISO-8601 timestamp when start() was called. */
  startedAt: string;
  /** ISO-8601 timestamp when the run first settled or suspended at a gate. */
  settledAt: string;
}

// ── Artifact I/O ──────────────────────────────────────────────────────────────

/**
 * Write a durable artifact to <projectDir>/.agent-flows/runs/<runId>/<pipelineId>.json.
 *
 * Returns the path written on success, or undefined if writing failed.
 * Never throws — disk errors must not affect the run outcome.
 *
 * The artifact is plain JSON, uncompressed, and contains no credentials or API
 * keys (callers must never place secret values in artifactData).
 */
export async function writeRunArtifact(
  projectDir: string,
  runId: string,
  pipelineId: string,
  artifactData: Record<string, unknown>
): Promise<string | undefined> {
  const artifactDir = join(projectDir, ".agent-flows", "runs", runId);
  const artifactPath = join(artifactDir, `${pipelineId}.json`);

  try {
    await mkdir(artifactDir, { recursive: true });
    await writeFile(artifactPath, JSON.stringify(artifactData, null, 2), "utf8");
    // Ensure the gitignore is in place now that at least one artifact exists.
    await ensureRunsGitignore(projectDir);
    return artifactPath;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    // Log path but never artifact content — output may include repository content.
    console.warn(`[agent-flows] artifact write failed for run ${runId} at ${artifactPath}: ${msg}`);
    return undefined;
  }
}

// ── .gitignore management ─────────────────────────────────────────────────────

/**
 * Ensure <projectDir>/.agent-flows/.gitignore contains a "runs/" line.
 *
 * Creates the file if it does not exist. Appends the line if the file exists
 * without it. Never overwrites or removes existing content — operator
 * customisation is preserved (spec 029 FR-008, Design A).
 *
 * Default-ignore posture: artifacts contain model output that may include full
 * repository content, so committing them must be an explicit operator choice.
 */
export async function ensureRunsGitignore(projectDir: string): Promise<void> {
  const gitignorePath = join(projectDir, ".agent-flows", ".gitignore");
  const runsLine = "runs/";

  let existing = "";
  try {
    existing = await readFile(gitignorePath, "utf8");
  } catch {
    // File absent — fall through to create it via appendFile.
  }

  // Exact per-line match: "my-runs/" and "# runs/" are distinct from "runs/".
  const lines = existing.split("\n").map((l) => l.trim());
  if (lines.includes(runsLine)) return;

  // Ensure we never concatenate without a separating newline.
  const separator = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  await appendFile(gitignorePath, `${separator}${runsLine}\n`, "utf8");
}
