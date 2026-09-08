// Writes durable run artifacts and manages the .gitignore default for runs/.
// Spec 029 FR-001/FR-002/FR-006/FR-008.
//
// Intentionally does not import from runService.ts — the two modules form a
// one-way dependency (runService → artifactStore) so there is no cycle.

import { appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

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

// ── Manifest types (spec 029 FR-006) ─────────────────────────────────────────

/** One stage entry in the run manifest. */
export interface ManifestStage {
  /** Pipeline id used for this stage (e.g. "investigate", "spec-creation"). */
  stageId: string;
  /** Absolute path of the stage's artifact file. */
  artifactPath: string;
  /** Provider profile that produced this stage. */
  profileId: string;
  /** Terminal status of this stage. */
  status: string;
  /** ISO-8601 timestamp when this stage settled. */
  settledAt: string;
  /** Error message if status is "failed" or "rejected". */
  error?: string;
}

/** The run manifest file at <runDir>/manifest.json. */
export interface RunManifest {
  /** Chain anchor runId — the directory name, set by the first stage. */
  runId: string;
  /** ISO-8601 timestamp of when the first stage started. */
  startedAt: string;
  /** Overall chain status, derived from all stage statuses. */
  status: "in-progress" | "completed" | "failed";
  /** Ordered list of stages that have run in this chain. */
  stages: ManifestStage[];
}

// ── Artifact I/O ──────────────────────────────────────────────────────────────

/**
 * Write a durable artifact to <runDir>/<pipelineId>.json.
 *
 * By default runDir is <projectDir>/.agent-flows/runs/<runId>.
 * Pass opts.artifactDir to override (used when chaining stages into a parent
 * run's directory — spec 029 FR-006).
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
  artifactData: Record<string, unknown>,
  opts?: { artifactDir?: string }
): Promise<string | undefined> {
  const artifactDir = opts?.artifactDir ?? join(projectDir, ".agent-flows", "runs", runId);
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

// ── Manifest I/O (spec 029 FR-006) ───────────────────────────────────────────

/**
 * Create or update the manifest at <artifactDir>/manifest.json.
 *
 * On the first stage the manifest is created; on subsequent stages the new
 * stage entry is appended in order. If a stage with the same stageId already
 * exists in the manifest it is updated in place (idempotent re-runs).
 *
 * Never throws — a manifest write failure must not fail the run.
 * The chain runId is derived from the artifact directory name so it matches
 * the first stage's runId regardless of which stage is currently writing.
 */
export async function upsertManifestEntry(
  artifactDir: string,
  startedAt: string,
  entry: ManifestStage
): Promise<void> {
  const manifestPath = join(artifactDir, "manifest.json");
  // Chain runId is the directory name — the first stage's Mastra runId.
  const chainRunId = basename(artifactDir);

  let manifest: RunManifest;
  try {
    const raw = await readFile(manifestPath, "utf8");
    manifest = JSON.parse(raw) as RunManifest;
  } catch {
    // File absent or unparseable — create a fresh manifest for this chain.
    manifest = {
      runId: chainRunId,
      startedAt,
      status: "in-progress",
      stages: [],
    };
  }

  // Update existing entry for this stageId (idempotent) or append.
  const idx = manifest.stages.findIndex((s) => s.stageId === entry.stageId);
  if (idx >= 0) {
    manifest.stages[idx] = entry;
  } else {
    manifest.stages.push(entry);
  }

  // Derive overall status: failed wins, then completed if all succeeded, else in-progress.
  const hasFailed = manifest.stages.some((s) => s.status === "failed" || s.status === "rejected");
  const allSucceeded =
    manifest.stages.length > 0 && manifest.stages.every((s) => s.status === "succeeded");
  manifest.status = hasFailed ? "failed" : allSucceeded ? "completed" : "in-progress";

  try {
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[agent-flows] manifest write failed at ${manifestPath}: ${msg}`);
  }
}

/**
 * Read the manifest at <artifactDir>/manifest.json and reconcile it against
 * the stage artifacts present in the same directory.
 *
 * Any <stageId>.json that is a valid artifact (has provenance.settledAt,
 * provenance.profileId, and a top-level status) but has no manifest entry is
 * included, with its fields taken from the artifact itself. Entries written by
 * a stage keep their recorded order; reconciled entries are merged by
 * settledAt so the chain still reads in the order it happened.
 *
 * Read-only: this function never writes to the manifest file. The file is
 * the record that stages write; rewriting it would erase evidence that a
 * stage missed recording itself, which is valuable for diagnosing write failures.
 *
 * Throws if the manifest file cannot be read or parsed — callers should check
 * existence before calling. Silently ignores unreadable or non-artifact files
 * beside the manifest.
 */
export async function readManifest(artifactDir: string): Promise<RunManifest> {
  const manifestPath = join(artifactDir, "manifest.json");
  const raw = await readFile(manifestPath, "utf8");
  const manifest = JSON.parse(raw) as RunManifest;

  // Collect stageIds already recorded so we don't double-count them.
  const knownStageIds = new Set(manifest.stages.map((s) => s.stageId));

  let dirEntries: string[];
  try {
    dirEntries = await readdir(artifactDir);
  } catch {
    // Directory unreadable after the manifest was read — return as-is.
    return manifest;
  }

  const reconciled: ManifestStage[] = [];
  for (const entry of dirEntries) {
    // manifest.json is infrastructure, not a stage; skip non-json files.
    if (!entry.endsWith(".json") || entry === "manifest.json") continue;
    const stageId = entry.slice(0, -".json".length);
    if (knownStageIds.has(stageId)) continue;

    const artifactPath = join(artifactDir, entry);
    try {
      const artifactRaw = await readFile(artifactPath, "utf8");
      const artifact = JSON.parse(artifactRaw) as Record<string, unknown>;
      // A file is a valid artifact when it carries the provenance block written
      // by writeRunArtifact. Anything without these fields is not an artifact.
      const prov = artifact.provenance as Record<string, unknown> | undefined;
      if (
        !prov ||
        typeof prov.settledAt !== "string" ||
        typeof prov.profileId !== "string" ||
        typeof artifact.status !== "string"
      ) {
        continue;
      }
      reconciled.push({
        stageId,
        artifactPath,
        profileId: prov.profileId,
        status: artifact.status,
        settledAt: prov.settledAt,
      });
    } catch {
      // Unreadable or non-JSON file — not an artifact, skip silently.
    }
  }

  if (reconciled.length === 0) return manifest;

  // Merge manifest entries with reconciled ones, ordering by settledAt.
  // Array.sort is stable: manifest entries with equal settledAt keep their
  // recorded relative order, which matches the execution order they were written.
  const all = [...manifest.stages, ...reconciled].sort((a, b) =>
    a.settledAt.localeCompare(b.settledAt)
  );

  // Recompute overall status to account for newly-visible stages.
  const hasFailed = all.some((s) => s.status === "failed" || s.status === "rejected");
  const allSucceeded = all.length > 0 && all.every((s) => s.status === "succeeded");
  const status: RunManifest["status"] = hasFailed
    ? "failed"
    : allSucceeded
      ? "completed"
      : "in-progress";

  return { ...manifest, stages: all, status };
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
