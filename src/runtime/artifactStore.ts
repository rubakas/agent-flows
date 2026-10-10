// Writes durable run artifacts into the machine-local state dir.
// Spec 029 FR-001/FR-002/FR-006; spec 032 FR-004/FR-008.
//
// Intentionally does not import from runService.ts — the two modules form a
// one-way dependency (runService → artifactStore) so there is no cycle.

import { randomBytes } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

import { runPhase } from "./runStatus.js";
import { runSubject } from "./runSubject.js";

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

/**
 * Which step's output became the exported spec document.
 *
 * Neither ManifestStage (the stage) nor ArtifactProvenance (transport per step)
 * says where the saved document came from, and with a revision step in the
 * pipeline there is more than one candidate: the assembled HardenedSpec and the
 * revised markdown are different documents, and a reader looking at a saved
 * spec cannot tell which one they got.
 */
export interface SpecSource {
  /** Step id whose output was written — an assemble step, or a revision step. */
  stepId: string;
  /** Absolute path of the document written to the project tree. */
  path: string;
}

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
  /** ISO-8601 timestamp of the cancel() call; present only when status is "cancelled". */
  cancelledAt?: string;
  /** Operator-supplied cancellation reason, when one was given (spec 033 FR-004). */
  reason?: string;
  /** Which step produced the spec document this stage exported, if it exported one. */
  specSource?: SpecSource;
}

/** The run manifest file at <runDir>/manifest.json. */
export interface RunManifest {
  /** Chain anchor runId — the directory name, set by the first stage. */
  runId: string;
  /** ISO-8601 timestamp of when the first stage started. */
  startedAt: string;
  /** Overall chain status, derived from all stage statuses. */
  status: "in-progress" | "completed" | "failed" | "cancelled";
  /** Ordered list of stages that have run in this chain. */
  stages: ManifestStage[];
}

// ── Atomic publication ────────────────────────────────────────────────────────

/**
 * Serialise `data` as JSON and publish it at `path` atomically.
 *
 * writeFile is open(O_TRUNC) → write → close, so between the open and the write
 * a zero-length file exists at the final name. A concurrent reader — the daemon
 * serving GET /api/runs, for instance — then parses "" and reports a healthy run
 * as unreadable. Writing a sibling temp file and renaming it means a reader only
 * ever sees a complete file: the previous one or the new one.
 *
 * The temp file is a sibling so it is on the same filesystem (rename is only
 * atomic within one), carries a unique suffix so concurrent writers in the same
 * directory cannot collide, and ends in ".tmp" rather than ".json" so the
 * directory scans that pick artifacts out of a run dir cannot select it.
 *
 * Throws on failure, after removing the temp file; callers own the reporting.
 */
async function writeJsonAtomic(path: string, data: unknown): Promise<void> {
  const tempPath = `${path}.${process.pid.toString(36)}-${randomBytes(6).toString("hex")}.tmp`;
  try {
    // mode applies at creation, and rename carries it to the final name.
    await writeFile(tempPath, JSON.stringify(data, null, 2), { encoding: "utf8", mode: 0o600 });
    await rename(tempPath, path);
  } catch (err: unknown) {
    // A temp file that was never created is not a second problem to report.
    await unlink(tempPath).catch(() => undefined);
    throw err;
  }
}

// ── Artifact I/O ──────────────────────────────────────────────────────────────

/**
 * Write a durable artifact to <artifactDir>/<pipelineId>.json.
 *
 * artifactDir is supplied by the caller — the run's own directory under the
 * state dir, or a parent run's directory when chaining stages (spec 029
 * FR-006, spec 032 FR-004). Nothing is written inside the project tree.
 *
 * Returns the path written on success, or undefined if writing failed.
 * Never throws — disk errors must not affect the run outcome.
 *
 * The artifact is plain JSON, uncompressed, and contains no credentials or API
 * keys (callers must never place secret values in artifactData).
 */
export async function writeRunArtifact(
  artifactDir: string,
  runId: string,
  pipelineId: string,
  artifactData: Record<string, unknown>
): Promise<string | undefined> {
  const artifactPath = join(artifactDir, `${pipelineId}.json`);

  try {
    // Owner-only: an artifact holds rendered prompts and step output, i.e. the
    // repository's content. Same modes as everything else under the state dir.
    await mkdir(artifactDir, { recursive: true, mode: 0o700 });
    await writeJsonAtomic(artifactPath, artifactData);
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
/**
 * Derive the chain's overall status from its stage statuses.
 *
 * Precedence: a failed or rejected stage wins, because a chain that broke is
 * the most important thing to report. A cancelled stage comes next — without
 * it a fully cancelled chain reads "in-progress" forever, since a cancelled
 * stage is neither failed nor succeeded. "completed" requires every stage to
 * have succeeded; anything else is still in progress.
 *
 * Shared by upsertManifestEntry and readManifest so the two cannot drift.
 */
export function deriveChainStatus(stages: readonly ManifestStage[]): RunManifest["status"] {
  if (stages.some((s) => s.status === "failed" || s.status === "rejected")) return "failed";
  if (stages.some((s) => s.status === "cancelled")) return "cancelled";
  if (stages.length > 0 && stages.every((s) => s.status === "succeeded")) return "completed";
  return "in-progress";
}

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
    // specSource is recorded mid-run by the export step; this entry is written
    // by the run's settlement, which knows nothing about the spec document. A
    // straight replace would erase the provenance every time, so a recorded
    // source survives unless the incoming entry carries one of its own.
    const previous = manifest.stages[idx];
    manifest.stages[idx] =
      entry.specSource === undefined && previous.specSource !== undefined
        ? { ...entry, specSource: previous.specSource }
        : entry;
  } else {
    manifest.stages.push(entry);
  }

  manifest.status = deriveChainStatus(manifest.stages);

  try {
    await writeJsonAtomic(manifestPath, manifest);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[agent-flows] manifest write failed at ${manifestPath}: ${msg}`);
  }
}

/**
 * Record which step produced the spec document a stage exported.
 *
 * Called by the export-spec step, which is the only place that knows both the
 * source step and the path written. The stage entry already exists: an
 * export-spec step requires a gate ancestor, and suspending at that gate
 * persists the artifact and the manifest entry first.
 *
 * Never throws — provenance is a record of a write that already succeeded, and
 * losing it must not fail the run.
 */
export async function recordManifestSpecSource(
  artifactDir: string,
  stageId: string,
  specSource: SpecSource
): Promise<void> {
  const manifestPath = join(artifactDir, "manifest.json");
  try {
    const raw = await readFile(manifestPath, "utf8");
    const manifest = JSON.parse(raw) as RunManifest;
    const idx = manifest.stages.findIndex((s) => s.stageId === stageId);
    if (idx < 0) {
      console.warn(
        `[agent-flows] spec provenance not recorded: no manifest entry for stage ${stageId} at ${manifestPath}`
      );
      return;
    }
    manifest.stages[idx] = { ...manifest.stages[idx], specSource };
    await writeJsonAtomic(manifestPath, manifest);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[agent-flows] spec provenance write failed at ${manifestPath}: ${msg}`);
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
  return { ...manifest, stages: all, status: deriveChainStatus(all) };
}

// ── Reading runs back from disk (spec 034 D8/FR-010..FR-012) ─────────────────
//
// Deliberately synchronous, unlike the rest of this module: RunService.list()
// and get() are synchronous and are called from route handlers that have no
// await point for them, so an async read here would ripple through the service,
// the routes and the MCP tools for no behavioural gain.

/** One persisted run as it appears in the run list. */
export interface PersistedRunSummary {
  runId: string;
  pipelineId: string;
  /** Terminal status from the artifact, or "unreadable" when it could not be parsed. */
  status: string;
  /** ISO-8601 start time, from the artifact's provenance or invocation. */
  createdAt: string;
  /** ISO-8601 settle time from the artifact's provenance. */
  settledAt?: string;
  /** Always "disk" — this run was reconstructed, not served from the registry. */
  source: "disk";
  /** Present when status is "unreadable": why the artifact could not be read. */
  error?: string;
  /** Present when status is "unreadable": the file that could not be read. */
  path?: string;
  /** One line naming what this run was started against (spec 042 D14). */
  subject?: string;
}

/** A run's full state rebuilt from its artifact — the on-disk twin of GetResult. */
export type PersistedRun = Record<string, unknown> & {
  runId: string;
  status: string;
  source: "disk";
};

/**
 * Reject anything that could escape runsDir before it reaches join().
 * The run id reaches these functions from a URL path segment, and join() happily
 * resolves "..", so the guard lives here rather than only at the route.
 */
export function isSafeRunId(runId: string): boolean {
  return (
    runId.length > 0 &&
    runId.length <= 200 &&
    !runId.startsWith(".") &&
    !/[/\\\0]/u.test(runId) &&
    runId !== ".."
  );
}

/** One parsed artifact file in a run directory. */
interface ArtifactFile {
  artifact: Record<string, unknown>;
  path: string;
}

/** What a run directory holds: the artifacts that parsed, and the first that did not. */
interface RunDirScan {
  artifacts: ArtifactFile[];
  failure?: { error: string; path: string };
}

/**
 * Parse every artifact file in a run directory (the `*.json` files that are not
 * the manifest). A chained run writes every stage's artifact into its anchor's
 * directory (spec 029 FR-006), so one directory can hold several runs.
 * Undefined when the directory cannot be read.
 */
function scanRunDir(runDir: string): RunDirScan | undefined {
  let entries: string[];
  try {
    entries = readdirSync(runDir);
  } catch {
    return undefined;
  }

  const artifacts: ArtifactFile[] = [];
  let failure: RunDirScan["failure"];
  for (const entry of entries.sort()) {
    if (!entry.endsWith(".json") || entry === "manifest.json") continue;
    const path = join(runDir, entry);
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        failure ??= { error: "artifact is not a JSON object", path };
        continue;
      }
      artifacts.push({ artifact: parsed as Record<string, unknown>, path });
    } catch (err) {
      // FR-012: remember the failure. A run whose artifact will not parse must
      // be reported as unreadable, not quietly omitted from the list.
      failure ??= { error: err instanceof Error ? err.message : String(err), path };
    }
  }
  return failure === undefined ? { artifacts } : { artifacts, failure };
}

/**
 * Whose artifact this is. The artifact's own `runId`; an artifact with none
 * (written before the field existed) belongs to the directory it sits in.
 */
function ownerOf(artifact: Record<string, unknown>, dirName: string): string {
  return typeof artifact.runId === "string" ? artifact.runId : dirName;
}

/** The pipeline an artifact file is named for: `<pipelineId>.json`. */
function stemOf(path: string): string {
  return basename(path, ".json");
}

/** Where a run was found, and what describes it there. */
type RunMatch =
  | { kind: "artifact"; dir: string; path: string; artifact: Record<string, unknown> }
  | { kind: "unreadable"; dir: string; path: string; error: string }
  | { kind: "events"; dir: string; pipelineId: string };

const EVENTS_SUFFIX = ".events.jsonl";

/**
 * A run in its own directory: the artifact that names it, else the one broken
 * artifact that might, else — for a run that has not written an artifact yet —
 * its events file.
 *
 * An events file whose pipeline already has an artifact belonging to a
 * DIFFERENT run is that run's, not this one's.
 */
function findInOwnDir(runsDir: string, runId: string): RunMatch | undefined {
  const dir = join(runsDir, runId);
  const scan = scanRunDir(dir);
  if (scan === undefined) return undefined;

  const own = scan.artifacts.find((c) => ownerOf(c.artifact, runId) === runId);
  if (own) return { kind: "artifact", dir, ...own };
  if (scan.failure) return { kind: "unreadable", dir, ...scan.failure };

  const claimed = new Set(scan.artifacts.map((c) => stemOf(c.path)));
  const events = readdirSync(dir)
    .filter((name) => name.endsWith(EVENTS_SUFFIX))
    .map((name) => name.slice(0, -EVENTS_SUFFIX.length))
    .filter((pipelineId) => !claimed.has(pipelineId))
    .sort()[0];
  return events === undefined ? undefined : { kind: "events", dir, pipelineId: events };
}

/**
 * A chained run in some other run's directory: the artifact anywhere under
 * runsDir whose own `runId` is this one's.
 *
 * Cost: one readdir of runsDir plus a read-and-parse of every artifact in every
 * run directory. It runs only when the run's own directory does not describe it
 * — a chained child after a restart, or an id nobody has heard of — never on
 * the way to a run that is where its id says it is.
 *
 * Not resolvable: a stage chained into a directory outside runsDir (a
 * cross-project anchor), which this project's state does not contain.
 */
function findByScan(runsDir: string, runId: string): RunMatch | undefined {
  let dirEntries: string[];
  try {
    dirEntries = readdirSync(runsDir);
  } catch {
    return undefined;
  }
  for (const name of dirEntries) {
    if (name === runId || !isSafeRunId(name)) continue;
    const dir = join(runsDir, name);
    const scan = scanRunDir(dir);
    const found = scan?.artifacts.find((c) => c.artifact.runId === runId);
    if (found) return { kind: "artifact", dir, ...found };
  }
  return undefined;
}

/**
 * Find the run `runId` under runsDir. The artifact whose own runId matches is
 * the run; there is no fallback to "the latest one in the directory", because
 * that artifact may be another run's, or may have overwritten this one's.
 */
function findRun(runsDir: string, runId: string): RunMatch | undefined {
  if (!isSafeRunId(runId)) return undefined;
  return findInOwnDir(runsDir, runId) ?? findByScan(runsDir, runId);
}

/** Where a run's files live. */
export interface RunLocation {
  /** The directory holding the run's artifact, events file and manifest. */
  dir: string;
  /**
   * The run's pipeline, as its artifact declares it (the file's own name when it
   * declares none; the events file's name for a run with no artifact yet). The
   * artifact is untrusted input, so a caller joining this into a path must
   * validate it first.
   */
  pipelineId: string;
}

/**
 * Locate a run by its own id (spec 047 FR-11). A chained stage lives in its
 * anchor's directory, so the id is not always a directory name.
 */
export function locateRun(runsDir: string, runId: string): RunLocation | undefined {
  const match = findRun(runsDir, runId);
  if (match === undefined) return undefined;
  if (match.kind === "events") return { dir: match.dir, pipelineId: match.pipelineId };
  const declared = match.kind === "artifact" ? match.artifact.pipelineId : undefined;
  return {
    dir: match.dir,
    pipelineId: typeof declared === "string" ? declared : stemOf(match.path),
  };
}

function provenanceOf(artifact: Record<string, unknown>): Record<string, unknown> {
  const prov = artifact.provenance;
  return typeof prov === "object" && prov !== null ? (prov as Record<string, unknown>) : {};
}

function settledAtOf(artifact: Record<string, unknown>): string {
  const value = provenanceOf(artifact).settledAt;
  return typeof value === "string" ? value : "";
}

function startedAtOf(artifact: Record<string, unknown>, runDir: string): string {
  const fromProvenance = provenanceOf(artifact).startedAt;
  if (typeof fromProvenance === "string") return fromProvenance;
  const invocation = artifact.invocation;
  if (typeof invocation === "object" && invocation !== null) {
    const started = (invocation as Record<string, unknown>).startedAt;
    if (typeof started === "string") return started;
  }
  // Last resort: the directory's own mtime. A run with no recorded start time
  // would otherwise sort to the top of the list forever.
  try {
    return statSync(runDir).mtime.toISOString();
  } catch {
    return "";
  }
}

/**
 * Summarise every run directory under runsDir (FR-010).
 *
 * Returns an empty list when runsDir does not exist — a daemon that has never
 * run anything is not an error. Directories whose artifact cannot be parsed are
 * returned with status "unreadable" rather than dropped (FR-012).
 */
/** The `subject` property when the artifact's invocation yields one. */
function subjectOf(artifact: unknown): { subject?: string } {
  const subject = runSubject((artifact as { invocation?: unknown })?.invocation);
  return subject === undefined ? {} : { subject };
}

/**
 * `settledAt` as the reader reports it: only for a run that has settled. The
 * artifact's provenance records the last write, which for a run suspended at a
 * gate is the suspension, so reading it back as "settled" contradicts the list's
 * own contract.
 */
function reportedSettledAt(artifact: Record<string, unknown>): { settledAt?: string } {
  const settledAt = settledAtOf(artifact);
  if (settledAt === "") return {};
  const status = typeof artifact.status === "string" ? artifact.status : "unreadable";
  return runPhase({ status, source: "disk" }) === "terminal" ? { settledAt } : {};
}

export function listPersistedRuns(runsDir: string): PersistedRunSummary[] {
  let dirEntries: string[];
  try {
    dirEntries = readdirSync(runsDir);
  } catch {
    return [];
  }

  const summaries: PersistedRunSummary[] = [];
  for (const dirName of dirEntries) {
    if (!isSafeRunId(dirName)) continue;
    const runDir = join(runsDir, dirName);
    try {
      if (!statSync(runDir).isDirectory()) continue;
    } catch {
      continue;
    }

    const scan = scanRunDir(runDir);
    if (scan === undefined) continue;
    if (scan.artifacts.length === 0) {
      if (scan.failure === undefined) continue;
      summaries.push({
        runId: dirName,
        pipelineId: "unknown",
        status: "unreadable",
        createdAt: startedAtOf({}, runDir),
        source: "disk",
        error: scan.failure.error,
        path: scan.failure.path,
      });
      continue;
    }

    // One row per run: a directory holds its anchor's artifact and the artifact
    // of every stage chained into it, each under its own id.
    for (const { artifact } of scan.artifacts) {
      const pipelineId = provenanceOf(artifact).pipelineId ?? artifact.pipelineId;
      summaries.push({
        runId: ownerOf(artifact, dirName),
        pipelineId: typeof pipelineId === "string" ? pipelineId : "unknown",
        status: typeof artifact.status === "string" ? artifact.status : "unreadable",
        createdAt: startedAtOf(artifact, runDir),
        ...reportedSettledAt(artifact),
        // A restored run names its subject the same way a live one does: the
        // artifact is a serialised GetResult, so the invocation is right there.
        ...subjectOf(artifact),
        source: "disk",
      });
    }
  }
  return summaries;
}

/**
 * Rebuild one run's full state from its artifact (FR-010).
 *
 * Returns undefined when no artifact names this run — the caller answers 404.
 * A chained stage is found in its anchor's directory. The artifact already
 * holds exactly what GET /api/runs/:id returned when the run settled (it is a
 * serialised GetResult plus provenance), so the fields are passed through
 * rather than re-derived; `provenance` is kept so a reader can still see which
 * profile produced it.
 */
export function readPersistedRun(runsDir: string, runId: string): PersistedRun | undefined {
  const match = findRun(runsDir, runId);
  if (match === undefined || match.kind === "events") return undefined;
  if (match.kind === "unreadable") {
    return {
      runId,
      status: "unreadable",
      source: "disk",
      error: match.error,
      path: match.path,
      steps: {},
      gateDecisions: [],
    };
  }

  const { artifact, path, dir } = match;
  return {
    ...artifact,
    runId,
    status: typeof artifact.status === "string" ? artifact.status : "unreadable",
    steps: typeof artifact.steps === "object" && artifact.steps !== null ? artifact.steps : {},
    gateDecisions: Array.isArray(artifact.gateDecisions) ? artifact.gateDecisions : [],
    createdAt: startedAtOf(artifact, dir),
    ...reportedSettledAt(artifact),
    artifactPath: path,
    source: "disk",
  };
}
