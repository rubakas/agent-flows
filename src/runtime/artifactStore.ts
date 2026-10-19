// Writes durable run artifacts into the machine-local state dir.
// Spec 029 FR-001/FR-002/FR-006; spec 032 FR-004/FR-008.
//
// Intentionally does not import from runService.ts — the two modules form a
// one-way dependency (runService → artifactStore) so there is no cycle.

import { randomBytes } from "node:crypto";
import {
  closeSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
} from "node:fs";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

import { isRunStatus, isStepStatus, runPhase } from "./runStatus.js";
import { runSubject } from "./runSubject.js";
import type {
  ArtifactProvenance,
  CancelledInfo,
  GateDecision,
  PersistedRun,
  RunArtifact,
  RunInvocation,
  RunSummary,
  StepState,
} from "./runState.js";
import type { ReadStatus } from "./runStatus.js";
import type { StepActualProvider } from "./stepIntrospection.js";

export type { ArtifactProvenance, PersistedRun, StepProvenance } from "./runState.js";

// ── Provenance types ──────────────────────────────────────────────────────────

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
  artifactData: RunArtifact
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
export interface PersistedRunSummary extends RunSummary {
  /** Always "disk" — this run was reconstructed, not served from the registry. */
  source: "disk";
  /** Present when status is "unreadable": why the artifact could not be read. */
  error?: string;
  /** Present when status is "unreadable": the file that could not be read. */
  path?: string;
}

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
 *
 * With `mentioning`, a file whose text does not contain that string is skipped
 * before it is parsed: an artifact carries step results and can be large, and a
 * caller that is looking for one run id has no use for a file that cannot name
 * it. The text is only a pre-filter — a file that does contain the string is
 * still parsed and judged by its fields.
 */
function scanRunDir(runDir: string, mentioning?: string): RunDirScan | undefined {
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
      const raw = readFileSync(path, "utf8");
      if (mentioning !== undefined && !raw.includes(mentioning)) continue;
      const parsed = JSON.parse(raw) as unknown;
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

/**
 * The pipeline an artifact says it belongs to: its own `pipelineId`, else its
 * provenance's, else the name of its file. One answer for every reader.
 */
function pipelineIdOf(artifact: Record<string, unknown>, path: string): string {
  if (typeof artifact.pipelineId === "string") return artifact.pipelineId;
  const provenance = artifact.provenance;
  if (isPlainObject(provenance) && typeof provenance.pipelineId === "string") {
    return provenance.pipelineId;
  }
  return stemOf(path);
}

/** Where a run was found, and what describes it there. */
type RunMatch =
  | { kind: "artifact"; dir: string; path: string; artifact: Record<string, unknown> }
  | { kind: "unreadable"; dir: string; path: string; error: string }
  | { kind: "events"; dir: string; pipelineId: string };

const EVENTS_SUFFIX = ".events.jsonl";

/**
 * How much of an events file the scan reads. A file can reach tens of megabytes
 * (stepLogEvents caps a run's log far above this) and a lookup for an id nobody
 * has heard of reads every unclaimed one, on the event loop; a run names itself
 * on its first line, so the head is where its id is.
 */
const EVENTS_HEAD_BYTES = 64 * 1024;

/**
 * The run ids named by the complete lines at the head of an events file: the
 * top-level `runId` of each line, which is the run that wrote it.
 *
 * With `mentioning`, only a line containing that text is parsed. The text is a
 * pre-filter, not the answer — an id quoted inside a nested field (a tool call's
 * input is an object) matches it too, so a line it matches is still judged by
 * its own top-level field. A file that cannot be read names no run.
 */
function runIdsAtHeadOfEvents(path: string, mentioning?: string): Set<string> {
  const ids = new Set<string>();
  let text: string;
  let cut: boolean;
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const buffer = Buffer.alloc(EVENTS_HEAD_BYTES);
    const read = readSync(fd, buffer, 0, EVENTS_HEAD_BYTES, 0);
    text = buffer.toString("utf8", 0, read);
    cut = read === EVENTS_HEAD_BYTES;
  } catch {
    return ids;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  const lines = text.split("\n");
  // A head that ended mid-file ends mid-line.
  if (cut) lines.pop();
  for (const line of lines) {
    if (line === "" || (mentioning !== undefined && !line.includes(mentioning))) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (isPlainObject(parsed) && typeof parsed.runId === "string") ids.add(parsed.runId);
    } catch {
      // A half-written line names nothing.
    }
  }
  return ids;
}

/** The pipeline stems of a directory's events files that no artifact in it claims, sorted. */
function unclaimedEventsStems(dir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const claimed = new Set(
    names
      .filter((name) => name.endsWith(".json") && name !== "manifest.json")
      .map((name) => name.slice(0, -".json".length))
  );
  return names
    .filter((name) => name.endsWith(EVENTS_SUFFIX))
    .filter((name) => isRegularFile(join(dir, name)))
    .map((name) => name.slice(0, -EVENTS_SUFFIX.length))
    .filter((pipelineId) => !claimed.has(pipelineId))
    .sort();
}

function sizeOf(path: string): number | undefined {
  try {
    return lstatSync(path).size;
  } catch {
    return undefined;
  }
}

/**
 * Whether `path` is itself a regular file. A link is not followed and a FIFO is
 * not opened: the state dir is owned by this user, but a lookup for an id that
 * came off a URL must not be the thing that reads through a link or blocks on a
 * pipe someone left there.
 */
function isRegularFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * A run in its own directory: the artifact that names it, else the one broken
 * artifact that might, else — for a run that has not written an artifact yet —
 * its events file.
 *
 * An events file whose pipeline already has an artifact belonging to a
 * DIFFERENT run is that run's, not this one's. An events file that names
 * another run is never taken; the one that names this run is preferred, then an
 * empty one (a crash before the first event), which can in rare cases be another
 * run's.
 */
function findInOwnDir(runsDir: string, runId: string): RunMatch | undefined {
  const dir = join(runsDir, runId);
  const scan = scanRunDir(dir);
  if (scan === undefined) return undefined;

  const own = scan.artifacts.find((c) => ownerOf(c.artifact, runId) === runId);
  if (own) return { kind: "artifact", dir, ...own };
  if (scan.failure) return { kind: "unreadable", dir, ...scan.failure };

  const candidates = unclaimedEventsStems(dir).map((pipelineId) => {
    const file = join(dir, `${pipelineId}${EVENTS_SUFFIX}`);
    return { pipelineId, names: runIdsAtHeadOfEvents(file), empty: sizeOf(file) === 0 };
  });
  // Only a file with nothing in it is a crash before the first event; one with
  // content that names no run belongs to some run, and may not be this one.
  const found = candidates.find((c) => c.names.has(runId)) ?? candidates.find((c) => c.empty);
  return found === undefined ? undefined : { kind: "events", dir, pipelineId: found.pipelineId };
}

/**
 * A chained run in some other run's directory: the artifact anywhere under
 * runsDir whose own `runId` is this one's, else — for a stage that crashed
 * before it wrote one — an events file there whose lines name it.
 *
 * Cost: one readdir of runsDir plus a read of every artifact in every run
 * directory; only a file whose text contains the run id is parsed. The second
 * pass reads at most the head of an events file no artifact claims, which is
 * none in a healthy directory. It runs only when the run's own directory does
 * not describe it — a chained child after a restart, or an id nobody has heard
 * of — never on the way to a run that is where its id says it is.
 *
 * Limits: openRunLog appends, so an events file can hold several runs and a run
 * that is not on a head line is not found; a crashed child that re-ran a
 * pipeline whose stem an artifact in that directory already claims stays
 * unresolved; a stage chained into a directory outside runsDir (a cross-project
 * anchor) is found only by the daemon of the project that holds the anchor.
 */
function findByScan(runsDir: string, runId: string): RunMatch | undefined {
  let dirEntries: string[];
  try {
    dirEntries = readdirSync(runsDir);
  } catch {
    return undefined;
  }
  const others = dirEntries.filter((name) => name !== runId && isSafeRunId(name));
  // As the artifact's JSON spells it: an id with a quote in it is escaped there.
  const spelled = JSON.stringify(runId).slice(1, -1);
  for (const name of others) {
    const dir = join(runsDir, name);
    const scan = scanRunDir(dir, spelled);
    const found = scan?.artifacts.find((c) => c.artifact.runId === runId);
    if (found) return { kind: "artifact", dir, ...found };
  }
  const prefilter = `"runId":${JSON.stringify(runId)}`;
  for (const name of others) {
    const dir = join(runsDir, name);
    for (const pipelineId of unclaimedEventsStems(dir)) {
      const named = runIdsAtHeadOfEvents(join(dir, `${pipelineId}${EVENTS_SUFFIX}`), prefilter);
      if (named.has(runId)) return { kind: "events", dir, pipelineId };
    }
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
  return findInOwnDir(runsDir, runId) ?? findByScanRemembering(runsDir, runId);
}

// ── A missed scan, remembered ────────────────────────────────────────────────
//
// A lookup for an id that is nowhere reads every artifact under runsDir and the
// head of every unclaimed events file, synchronously, and a page or poller that
// asks about a run it cannot find asks again at once, from several routes. The
// miss is kept for a moment so those repeats cost nothing. The price is that a
// run whose files appear within the TTL is not found until it ends; a run in
// this daemon never depends on this, because the registry answers first.

const MISS_TTL_MS = 2000;
const MISS_CAPACITY = 256;
const scanMisses = new Map<string, number>();
let lookupClock: () => number = Date.now;

/** Replace the clock the remembered misses expire by, and forget them. For tests. */
export function setRunLookupClock(clock: () => number = Date.now): void {
  lookupClock = clock;
  scanMisses.clear();
}

function findByScanRemembering(runsDir: string, runId: string): RunMatch | undefined {
  const key = `${runsDir}\0${runId}`;
  const now = lookupClock();
  const expiresAt = scanMisses.get(key);
  if (expiresAt !== undefined) {
    if (now < expiresAt) return undefined;
    scanMisses.delete(key);
  }
  const found = findByScan(runsDir, runId);
  if (found === undefined) {
    // A Map iterates in insertion order, so the first key is the oldest miss.
    if (scanMisses.size >= MISS_CAPACITY) {
      const oldest = scanMisses.keys().next();
      if (!oldest.done) scanMisses.delete(oldest.value);
    }
    scanMisses.set(key, now + MISS_TTL_MS);
  }
  return found;
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
  return {
    dir: match.dir,
    pipelineId:
      match.kind === "artifact" ? pipelineIdOf(match.artifact, match.path) : stemOf(match.path),
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
function subjectOf(run: { invocation?: unknown }): { subject?: string } {
  const subject = runSubject(run.invocation);
  return subject === undefined ? {} : { subject };
}

/**
 * `settledAt` as the reader reports it: only for a run that has settled. The
 * artifact's provenance records the last write, which for a run suspended at a
 * gate is the suspension, so reading it back as "settled" contradicts the list's
 * own contract.
 */
function reportedSettledAt(
  status: ReadStatus,
  artifact: Record<string, unknown>
): { settledAt?: string } {
  const settledAt = settledAtOf(artifact);
  if (settledAt === "") return {};
  return runPhase({ status, source: "disk" }) === "terminal" ? { settledAt } : {};
}

// ── Normalising an artifact on read ──────────────────────────────────────────
//
// An artifact is a file: another version may have written it, or a person edited
// it. The reader builds a PersistedRun field by field, so a value that is not the
// declared type is replaced by its empty value or dropped rather than handed to a
// caller that trusts the type. Only keys the types declare are kept; anything else
// in the file is dropped (spec 047 FR-10).

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The listed keys of `raw` that hold a string, and nothing for the rest. */
function stringFields<K extends string>(
  raw: Record<string, unknown>,
  keys: readonly K[]
): Partial<Record<K, string>> {
  const out: Partial<Record<K, string>> = {};
  for (const key of keys) {
    const value = raw[key];
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

function booleanFields<K extends string>(
  raw: Record<string, unknown>,
  keys: readonly K[]
): Partial<Record<K, boolean>> {
  const out: Partial<Record<K, boolean>> = {};
  for (const key of keys) {
    const value = raw[key];
    if (typeof value === "boolean") out[key] = value;
  }
  return out;
}

function actualOf(raw: unknown): StepActualProvider | undefined {
  if (!isPlainObject(raw)) return undefined;
  const { profileId, transport, modelId } = raw;
  if (typeof profileId !== "string" || typeof modelId !== "string") return undefined;
  if (transport !== "cli" && transport !== "api") return undefined;
  return { profileId, transport, modelId, ...stringFields(raw, ["model"]) };
}

function stepStateOf(raw: unknown): StepState | undefined {
  if (!isPlainObject(raw) || !isStepStatus(raw.status)) return undefined;
  const actual = actualOf(raw.actual);
  return {
    status: raw.status,
    ...stringFields(raw, [
      "startedAt",
      "finishedAt",
      "error",
      "outputExcerpt",
      "prompt",
      "command",
      "model",
    ]),
    ...booleanFields(raw, ["outputTruncated"]),
    ...(actual !== undefined ? { actual } : {}),
  };
}

function gateDecisionOf(raw: unknown): GateDecision | undefined {
  if (!isPlainObject(raw)) return undefined;
  const { gateStepId, mode, decidedBy, approved, decidedAt } = raw;
  if (
    typeof gateStepId !== "string" ||
    (mode !== "manual" && mode !== "auto") ||
    (decidedBy !== "human" && decidedBy !== "agent") ||
    typeof approved !== "boolean" ||
    typeof decidedAt !== "string"
  ) {
    return undefined;
  }
  return {
    gateStepId,
    mode,
    decidedBy,
    approved,
    decidedAt,
    ...stringFields(raw, ["reason", "judgeModelId"]),
    ...booleanFields(raw, ["workspaceAccess", "superseded"]),
  };
}

/** The invocation is kept whole once it has the shape the replay UI needs. */
function invocationOf(raw: unknown): RunInvocation | undefined {
  if (!isPlainObject(raw)) return undefined;
  if (typeof raw.pipeline !== "string" || !isPlainObject(raw.inputs)) return undefined;
  return raw as unknown as RunInvocation;
}

function cancelledOf(raw: unknown): CancelledInfo | undefined {
  if (!isPlainObject(raw) || typeof raw.at !== "string") return undefined;
  return { at: raw.at, ...stringFields(raw, ["reason"]) };
}

function describeStatus(status: unknown): string {
  return typeof status === "string"
    ? `unknown status "${status.slice(0, 100)}"`
    : "artifact has no status";
}

/** `raw` is the parsed artifact file at `path`, which sits in `dir` and belongs to `runId`. */
function normaliseArtifact(
  raw: Record<string, unknown>,
  runId: string,
  path: string,
  dir: string
): PersistedRun {
  const status: ReadStatus = isRunStatus(raw.status) ? raw.status : "unreadable";
  const provenance = isPlainObject(raw.provenance)
    ? (raw.provenance as unknown as ArtifactProvenance)
    : undefined;
  const pipelineId = pipelineIdOf(raw, path);

  const steps: Record<string, StepState> = {};
  if (isPlainObject(raw.steps)) {
    for (const [id, entry] of Object.entries(raw.steps)) {
      // An own "__proto__" key (JSON.parse makes one) would hit the prototype
      // setter on assignment and make every step id inherit the entry's fields.
      if (id === "__proto__") continue;
      const state = stepStateOf(entry);
      if (state !== undefined) steps[id] = state;
    }
  }
  const gateDecisions = Array.isArray(raw.gateDecisions)
    ? raw.gateDecisions.flatMap((entry) => gateDecisionOf(entry) ?? [])
    : [];
  const invocation = invocationOf(raw.invocation);
  const cancelled = cancelledOf(raw.cancelled);

  return {
    runId,
    pipelineId,
    status,
    source: "disk",
    gateMode: raw.gateMode === "auto" ? "auto" : "manual",
    steps,
    gateDecisions,
    createdAt: startedAtOf(raw, dir),
    ...(invocation !== undefined ? { invocation } : {}),
    ...(raw.result !== undefined ? { result: raw.result } : {}),
    ...(raw.spec !== undefined ? { spec: raw.spec } : {}),
    ...stringFields(raw, [
      "gateMessage",
      "gateSummary",
      "gateStepId",
      "judgeError",
      "cancelledAt",
      "reason",
    ]),
    // An unknown status is reported as the reason the run cannot be read; the
    // artifact's own error would describe a run this build cannot place.
    ...(status === "unreadable"
      ? { error: describeStatus(raw.status), path }
      : stringFields(raw, ["error"])),
    ...(cancelled !== undefined ? { cancelled } : {}),
    ...(provenance !== undefined ? { provenance } : {}),
    ...reportedSettledAt(status, raw),
    artifactPath: path,
  };
}

/**
 * Summarise every run directory under runsDir (FR-010).
 *
 * Returns an empty list when runsDir does not exist — a daemon that has never
 * run anything is not an error. Directories whose artifact cannot be parsed are
 * returned with status "unreadable" rather than dropped (FR-012).
 */
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
        pipelineId: stemOf(scan.failure.path),
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
    for (const { artifact, path } of scan.artifacts) {
      const run = normaliseArtifact(artifact, ownerOf(artifact, dirName), path, runDir);
      summaries.push({
        runId: run.runId,
        pipelineId: run.pipelineId,
        status: run.status,
        createdAt: run.createdAt,
        ...(run.settledAt !== undefined ? { settledAt: run.settledAt } : {}),
        // A restored run names its subject the same way a live one does: the
        // artifact is a serialised GetResult, so the invocation is right there.
        ...subjectOf(run),
        source: "disk",
        ...(run.status === "unreadable" ? { error: run.error, path } : {}),
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
      pipelineId: stemOf(match.path),
      status: "unreadable",
      source: "disk",
      gateMode: "manual",
      createdAt: startedAtOf({}, match.dir),
      error: match.error,
      path: match.path,
      steps: {},
      gateDecisions: [],
    };
  }
  return normaliseArtifact(match.artifact, runId, match.path, match.dir);
}
