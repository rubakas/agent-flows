// FR-010 / FR-019 — loopback-only HTTP + SSE editor server (ADR-0013).
// Serves the DAG editor UI, relays run events over SSE, and enforces
// DNS-rebinding and simple-form CSRF mitigations. Zero new runtime
// dependencies — node:http only.

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import {
  createServer as nodeCreateServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { parse, stringify } from "yaml";

import { createDynamicMastra } from "../bindings/mastra/dynamicMastra.js";
import { resolveProjectDir } from "../bindings/mastra/projectDir.js";
import { exportBundle, importBundle, parseBundle, stringifyBundle } from "../bundle/bundle.js";
import { hashContent, saveDraft } from "../canon/canonWriter.js";
import {
  getDraft,
  getSource,
  indexSource,
  openDraft,
  updateDraftBody,
} from "../canon/draftStore.js";
import { forkPipeline, resolveForkTarget } from "../canon/fork.js";
import { pipelineToGraph, pipelineLevels } from "../canon/graph.js";
import {
  layerForPipelinesDir,
  loadCatalogPipelines,
  loadFromCatalog,
  mergedCatalog,
  repoCanonRoot,
  resolveCatalog,
  userLibraryRoot,
  writeTargetLayer,
  type LayerSource,
  type MergedCatalog,
  type MergedPipeline,
} from "../canon/layers.js";
import { listPipelines, loadPipeline } from "../canon/load.js";
import {
  CLI_MODEL_RE,
  PROVIDERS_RELATIVE_PATH,
  loadProviders,
  parseProviders,
} from "../canon/loadProviders.js";
import {
  builtInProfileIds,
  defaultRegistry,
  activeProfileIdOrUnknown,
  getProfile,
} from "../canon/registry.js";
import { makeDb, type DbInstance } from "../db/index.js";
import {
  bundledPipelinesDir as defaultBundledPipelinesDir,
  packageVersion,
} from "../packageRoot.js";
import { readManifest } from "../runtime/artifactStore.js";
import {
  removeDaemonRecordIfOwned,
  writeDaemonRecord,
  type DaemonIdentity,
} from "../runtime/daemonRecord.js";
import { decideEntryPoint } from "../runtime/entryPoint.js";
import { ensureProjectState, type ProjectState } from "../runtime/projectState.js";
import {
  isSafeStepId,
  pipeRunLog,
  readStepOutput,
  runLogFile,
  stepOutputFile,
} from "../runtime/stepLog.js";
import { readHidden, setHidden } from "../runtime/visibility.js";
import { resolveArtifactInputs } from "./artifactInputs.js";
import { listDaemons, stateDirForKey } from "./daemons.js";
import {
  countInFlight,
  DEFAULT_IDLE_MS,
  idleCheckIntervalMs,
  IDLE_MS_ENV,
  shouldExitWhenIdle,
} from "./idleShutdown.js";

import { probeProviderAccounts } from "./providerAccounts.js";
import { resolveProxyTarget, splitProxyPath } from "./proxy.js";

import {
  BODY_LIMIT_DEFAULT,
  isSafeId,
  json,
  readAndDiscardBody,
  requireJsonBody,
  requireRunService,
  requireSafeId,
  RequestTooLargeError,
  safePath,
} from "./route-helpers.js";
import { CONTENT_CAP, handleContentRoutes } from "./routes/content.js";
import { stopProjectDaemon } from "./stop.js";
import type { ProviderAccount } from "./providerAccounts.js";
import type { ModelEntry, ProviderConfig, ProviderProfile } from "../canon/registry.js";
import type { Role } from "../canon/types.js";
import type { RunService, StepEvent } from "../runtime/runService.js";
import type { AddressInfo } from "node:net";

export { CONTENT_CAP };

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ── SSE status normalisation ───────────────────────────────────────────────────
// Maps RunService StepEvent kinds to the stable status strings the UI receives.

const STEP_STATUS: Record<StepEvent["kind"], string> = {
  "step-start": "started",
  "step-finish": "succeeded",
  "step-failed": "failed",
  "step-suspended": "suspended",
  "step-cancelled": "cancelled",
};

// Reusable compiled regexes for the host port check and route matching.
const RE_PORT = /:\d+$/u;
const RE_PORT_CAPTURE = /:(\d+)$/u;
const RE_PIPELINE_DETAIL = /^\/api\/pipelines\/([^/]+)$/u;
const RE_PIPELINE_DRAFTS = /^\/api\/pipelines\/([^/]+)\/drafts$/u;
const RE_PIPELINE_FORK = /^\/api\/pipelines\/([^/]+)\/fork$/u;
const RE_PIPELINE_VISIBILITY = /^\/api\/pipelines\/([^/]+)\/visibility$/u;
const RE_PIPELINE_PROMPTS = /^\/api\/pipelines\/([^/]+)\/prompts$/u;
const RE_PIPELINE_PROMPT = /^\/api\/pipelines\/([^/]+)\/prompts\/([^/]+)$/u;
const RE_DRAFT_BY_ID = /^\/api\/drafts\/(\d+)$/u;
const RE_DRAFT_SAVE = /^\/api\/drafts\/(\d+)\/save$/u;
const RE_DRAFT_PREVIEW = /^\/api\/drafts\/(\d+)\/preview$/u;
/**
 * An own (non-namespaced) step id. A nested-pipeline step id carries a `.`
 * (`nest.ts:154`) and names a step of another pipeline file, which the prompt
 * write route must not edit — the pattern is what makes that a 404 (FR-005).
 */
const RE_OWN_STEP_ID = /^[A-Za-z0-9_-]+$/u;
const RE_RUN_EVENTS = /^\/api\/runs\/([^/]+)\/events$/u;
const RE_RUN_LOG = /^\/api\/runs\/([^/]+)\/log$/u;
const RE_RUN_STEP_OUTPUT = /^\/api\/runs\/([^/]+)\/steps\/([^/]+)\/output$/u;
const RE_AFTER_SEQ = /^\d+$/u;
const RE_RUN_BY_ID = /^\/api\/runs\/([^/]+)$/u;
const RE_RUN_APPROVE = /^\/api\/runs\/([^/]+)\/approve$/u;
const RE_RUN_CANCEL = /^\/api\/runs\/([^/]+)\/cancel$/u;
const RE_RUN_MANIFEST = /^\/api\/runs\/([^/]+)\/manifest$/u;
/**
 * The page's ESM helpers, by request path (spec 037 FR-015). The file name is
 * taken from this map and never from the request, so no traversal can reach a
 * file next to ui.html that is not listed here.
 */
const STATIC_MODULES: ReadonlyMap<string, string> = new Map([
  ["/ui-route.js", "ui-route.js"],
  ["/ui-graph.js", "ui-graph.js"],
  ["/ui-log.js", "ui-log.js"],
  ["/ui-tables.js", "ui-tables.js"],
  ["/ui-providers.js", "ui-providers.js"],
  ["/ui-daemons.js", "ui-daemons.js"],
]);

const RE_DAEMON_STOP = /^\/api\/daemons\/([^/]+)\/stop$/u;

const RE_EXPORT = /^\/api\/export\/([^/]+)$/u;

// Body size limits for readBody(). BODY_LIMIT_DEFAULT now lives in
// route-helpers.ts so the extracted route modules can share it.
const BODY_LIMIT_IMPORT = 4 * 1024 * 1024; // 4 MB — /api/import carries a YAML bundle
// 1 MiB — /api/drafts/:id/preview carries one YAML body plus every edited
// prompt text in a single payload, which overruns the 64 KB default (FR-004).
const BODY_LIMIT_PREVIEW = 1024 * 1024;
// 64 MiB — a run's `inputs` carry the change under review, which is the one body
// on this daemon that is legitimately large. A 35-file pull request diff is
// ~77 KB; the owner routinely reviews changes an order of magnitude past that,
// and a ~100k-line diff is around 4.5 MB. Trimming the diff to fit is not the
// answer: it would hide the very files a reviewer is meant to read, and the
// falsifiability step exists to review the tests.
//
// This is deliberately far above any real diff rather than snug against one.
// The cap is here so a runaway client gets a clear 413 instead of an OOM, not to
// express an opinion about how large a change may be. The real ceiling is the
// model's context window, which this number cannot raise.
const BODY_LIMIT_RUN = 64 * 1024 * 1024;

// ── Security helpers (FR-019) ──────────────────────────────────────────────────

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * DNS-rebinding defence: the Host header must identify a loopback address,
 * optionally followed by the exact bound port.
 */
function isAllowedHost(host: string | undefined, port: number): boolean {
  if (!host) return false;
  // Strip port suffix to get the bare hostname.
  const bare = host.replace(RE_PORT, "");
  if (!LOOPBACK_HOSTS.has(bare)) return false;
  const portMatch = RE_PORT_CAPTURE.exec(host);
  if (portMatch) return Number(portMatch[1]) === port;
  return true;
}

/**
 * Simple-form CSRF defence: if an Origin header is present on a mutating
 * request, it must be a loopback origin with the exact bound port.
 * Absence is allowed — non-browser clients (curl, fetch from localhost) omit it.
 */
function isAllowedOrigin(origin: string | undefined, port: number): boolean {
  if (!origin) return true;
  for (const h of LOOPBACK_HOSTS) {
    if (origin === `http://${h}:${port}`) return true;
  }
  return false;
}

// ── Pipeline helpers ───────────────────────────────────────────────────────────

interface PipelineEntry {
  filePath: string;
  loaded: ReturnType<typeof loadPipeline>;
}

/** Scan pipelinesDir and return the first pipeline whose id matches. */
function findPipelineById(pipelinesDir: string, id: string): PipelineEntry | undefined {
  let files: string[];
  try {
    files = listPipelines(pipelinesDir);
  } catch {
    return undefined;
  }
  for (const filePath of files) {
    try {
      const loaded = loadPipeline(filePath);
      if (loaded.def.id === id) return { filePath, loaded };
    } catch {
      // Skip files that fail to load; the listing endpoint reports them as absent.
    }
  }
  return undefined;
}

/**
 * Resolve one id through the merged three-layer view (spec 038 D13).
 *
 * A pipeline that is defined but fails to load is reported as absent, matching
 * `findPipelineById`: the routes answer 404 and the broken file stays visible to
 * `agent-flows validate`.
 */
function findMergedPipeline(catalog: MergedCatalog, id: string): MergedPipeline | undefined {
  try {
    return loadFromCatalog(catalog, id);
  } catch {
    return undefined;
  }
}

/** One row of the catalogue listing (spec 037 FR-002, spec 038 FR-020). */
interface PipelineRow {
  id: string;
  description: string;
  path: string;
  steps: number;
  inputs: string[];
  /** Which layer owns this id; absent on the bundled-catalogue listing. */
  layer?: LayerSource;
  /** Layers holding a same-id workflow this row shadows, lowest precedence first. */
  shadows?: LayerSource[];
  /** Hidden from the page's workflow list by this project's visibility file (FR-026). */
  hidden?: boolean;
}

/**
 * Every workflow the merged view resolves, as catalogue rows (FR-017, FR-020).
 *
 * `path` is relative to the owning layer's own root, so a bundled row reads
 * `pipelines/x.yaml` rather than a chain of `../..` out of the project.
 */
function mergedPipelineRows(catalog: MergedCatalog, hidden: ReadonlySet<string>): PipelineRow[] {
  // A pipeline that fails to load contributes no row; it stays visible as an
  // error on disk and is flagged by `agent-flows validate`.
  return loadCatalogPipelines(catalog).loaded.map(({ entry, loaded }) => ({
    hidden: hidden.has(loaded.def.id),
    id: loaded.def.id,
    description: loaded.def.description,
    path: relative(entry.layer.root, entry.filePath),
    steps: loaded.def.steps.length,
    inputs: [...(loaded.def.inputs ?? [])],
    layer: entry.layer.source,
    shadows: [...entry.shadows],
  }));
}

/**
 * List every loadable pipeline in `pipelinesDir` as a catalogue row.
 *
 * `steps` and `inputs` come from the loaded definition so the Workflows table
 * can be rendered from one request (spec 037 D3).
 */
function listPipelineRows(pipelinesDir: string, root: string): PipelineRow[] {
  let files: string[];
  try {
    files = listPipelines(pipelinesDir);
  } catch {
    return [];
  }
  const rows: PipelineRow[] = [];
  for (const filePath of files) {
    try {
      const loaded = loadPipeline(filePath);
      rows.push({
        id: loaded.def.id,
        description: loaded.def.description,
        path: relative(root, filePath),
        steps: loaded.def.steps.length,
        inputs: [...(loaded.def.inputs ?? [])],
      });
    } catch {
      // Silently omit files that fail to parse; they are visible as errors
      // on disk and will be flagged by `agent-flows canon:check`.
    }
  }
  return rows;
}

/**
 * Raw step shape for dependant scanning — avoids full loadPipeline (which
 * expands nested steps in place and loses the original pipeline references).
 */
interface RawStep {
  kind?: string;
  pipeline?: string;
}
interface RawPipeline {
  id?: string;
  steps?: RawStep[];
}

/**
 * Returns ids of pipelines in pipelinesDir that directly reference targetId
 * as a nested pipeline (kind: pipeline or kind: loop step).
 * Uses raw YAML parsing so that malformed files and the target file itself
 * do not prevent scanning the rest of the catalog.
 */
function findDependants(pipelinesDir: string, targetId: string): string[] {
  let files: string[];
  try {
    files = listPipelines(pipelinesDir);
  } catch {
    return [];
  }
  const dependants: string[] = [];
  for (const filePath of files) {
    try {
      const raw = parse(readFileSync(filePath, "utf8")) as RawPipeline;
      if (raw.id === targetId) continue; // skip self
      const hasRef = (raw.steps ?? []).some(
        (s) => (s.kind === "pipeline" || s.kind === "loop") && s.pipeline === targetId
      );
      if (hasRef) dependants.push(raw.id ?? filePath);
    } catch {
      // skip unparseable files
    }
  }
  return dependants;
}

// ── Prompt files of a pipeline (spec 037 D6/FR-005) ───────────────────────────

/** Where one own llm step's prompt file lives, as the on-disk pipeline declares it. */
interface PromptTarget {
  /** The path exactly as written in the YAML, relative to the pipeline root. */
  rel: string;
  /** The absolute path the loader reads it from. */
  abs: string;
}

/**
 * The prompt file of every own llm step of a pipeline file.
 *
 * Read from the YAML on disk rather than from the definition `loadPipeline`
 * returns: expansion inlines nested pipelines and namespaces their step ids as
 * `parent.child` (`nest.ts:154`), and those prompts belong to another file
 * entirely. A document that does not parse yields an empty map, so the caller
 * answers 404 for the step instead of guessing a path out of it.
 */
function ownPromptTargets(filePath: string): Map<string, PromptTarget> {
  const targets = new Map<string, PromptTarget>();
  let doc: unknown;
  try {
    doc = parse(readFileSync(filePath, "utf8"));
  } catch {
    return targets;
  }
  const steps = (doc as { steps?: unknown } | null)?.steps;
  if (!Array.isArray(steps)) return targets;
  // Same root the loader derives (load.ts:65): the pipeline file's grandparent.
  const pipelineRoot = dirname(dirname(resolve(filePath)));
  for (const step of steps as { id?: unknown; kind?: unknown; prompt?: unknown }[]) {
    if (step?.kind !== "llm") continue;
    if (typeof step.id !== "string" || typeof step.prompt !== "string") continue;
    targets.set(step.id, { rel: step.prompt, abs: resolve(pipelineRoot, step.prompt) });
  }
  return targets;
}

/**
 * Whether the write route may overwrite `absPath`: an existing `.md` file whose
 * realpath sits inside the realpath of the pipeline root's `prompts/` directory.
 *
 * The loader's own containment (`load.ts:288-304`) is not sufficient for a
 * write — it accepts any path under the pipeline root, `providers.yaml`
 * included — so this is a second, narrower gate, and it is applied after
 * realpathSync so a symlink planted inside `prompts/` cannot redirect the write.
 *
 * Hard links are not detected: a second name for a file outside `prompts/` is
 * indistinguishable from the real thing here. That residual needs prior local
 * write access to the directory, which this route does not grant.
 */
function isWritablePromptFile(absPath: string, promptsDir: string): boolean {
  if (!absPath.endsWith(".md")) return false;
  let realTarget: string;
  let realDir: string;
  try {
    realTarget = realpathSync(absPath);
    realDir = realpathSync(promptsDir);
  } catch {
    return false; // the prompt file, or the prompts directory itself, is absent
  }
  if (!realTarget.endsWith(".md")) return false;
  if (!statSync(realTarget).isFile()) return false;
  const dirWithSep = realDir.endsWith(sep) ? realDir : realDir + sep;
  return realTarget.startsWith(dirWithSep);
}

/**
 * Context keys the run itself owns. They are merged into the workflow input
 * alongside the caller's `inputs`, so an `inputs` entry of the same name would
 * override the validated top-level field and reach the step runner having passed
 * through none of its checks.
 */
const RESERVED_CONTEXT_KEYS: ReadonlySet<string> = new Set(["provider", "models"]);

/**
 * The state root this daemon writes under: `AGENT_FLOWS_HOME ?? ~/.agent-flows`.
 *
 * Derived from the resolved ProjectState rather than the environment, because
 * the daemon is handed its state explicitly and a test's isolated state home
 * never reaches process.env (`resolveProjectState(dir, { AGENT_FLOWS_HOME })`).
 * `state.dir` is `<root>/projects/<key>` by construction (projectState.ts).
 */
function stateRootOf(state: ProjectState): string {
  return dirname(dirname(state.dir));
}

// ── Public API ─────────────────────────────────────────────────────────────────

export interface ServeOptions {
  /** TCP port; defaults to 7411. Pass 0 for an ephemeral port (tests). */
  port?: number;
  /** Absolute path to the SQLite database; defaults to the state dir's `agent-flows.sqlite`. */
  dbPath?: string;
  /**
   * Machine-local state locations for this project (spec 032 D2). Required: a
   * default here would silently resolve against the ambient environment, so a
   * test that forgot to pass one would read and write the owner's real
   * ~/.agent-flows. The CLI passes `ensureProjectState`'s result, so the
   * directory and its marker exist.
   */
  state: ProjectState;
  /** Directory containing pipeline YAML files; defaults to `<cwd>/pipelines`. */
  pipelinesDir?: string;
  /** Injected RunService for tests; constructed from Mastra in CLI mode. */
  runService?: RunService;
  /** The user's project directory (install target). Defaults to process.cwd(). */
  projectDir?: string;
  /** The tool's bundled pipeline catalog directory. Defaults to the package's own. */
  bundledPipelinesDir?: string;
  /** Root directory containing skills/ and agents/ subdirs. Defaults to AGENT_FLOWS_SKILLS_DIR or ~/.claude. */
  skillsBase?: string;
  /**
   * The provider profiles the running workflows were BUILT with — the daemon's
   * startup `providers.yaml` snapshot, the same array handed to BuildDeps.
   *
   * Passed in rather than re-read per request so the boundary validates against
   * the list the steps will actually resolve from: a profile added to
   * providers.yaml without a restart used to pass validation here and then
   * throw "Unknown provider" inside the first step, failing the run mid-flight
   * instead of at the boundary.
   */
  providerProfiles?: ProviderProfile[];
  /**
   * Whether this daemon was spawned by the MCP process rather than by a human
   * (spec 042 D11). Defaults to the `AGENT_FLOWS_AUTOSTART` marker the spawner
   * sets. Only an auto-started daemon reaps itself when idle; injected here so
   * the policy is reachable in a test without touching the real environment.
   */
  autostarted?: boolean;
  /** Idle span before an auto-started daemon stops. Defaults to 15 minutes. */
  idleMs?: number;
}

export interface ServeHandle {
  port: number;
  close(): Promise<void>;
}

// ── Handler context ────────────────────────────────────────────────────────────

interface HandlerCtx {
  /**
   * The layer a write targets. Reads go through `catalog`; this is only the
   * directory the mutation routes create, edit and delete in (seam for D14).
   */
  pipelinesDir: string;
  /** The merged three-layer view, resolved per request (spec 038 D13). */
  catalog: MergedCatalog;
  root: string;
  db: DbInstance;
  runService: RunService | null;
  uiPath: string;
  boundPort: number;
  projectDir: string;
  /** Machine-local state locations for projectDir (spec 032 D2). */
  state: ProjectState;
  /** Resolved SQLite path in force for this daemon (state default or --db). */
  dbPath: string;
  bundledPipelinesDir: string;
  skillsBase: string;
  /** Package version reported by `GET /api/daemon` (spec 038 FR-011). */
  version: string;
  /** ISO timestamp fixed when this daemon began listening (spec 038 FR-011). */
  startedAt: string;
  /**
   * The startup providers.yaml snapshot the workflows were built with, when the
   * caller supplied one. Absent only on the legacy/test path, where the file is
   * re-read per request as before.
   */
  providerProfiles?: ProviderProfile[];
}

// ── readAgentFlowsConfig ───────────────────────────────────────────────────────

/**
 * Read `.agent-flows/config.json` from `projectDir` and return the resolved
 * `checkCommand`, or `undefined` when the file or the key is absent.
 *
 * Throws a loud error for: unreadable file, malformed JSON, or a
 * `checkCommand` key of the wrong type. Called ONCE at CLI startup; the
 * validated value is then passed into `startServer` via options so the server
 * never needs to touch the file itself.
 */
export function readAgentFlowsConfig(projectDir: string): string | undefined {
  const configPath = join(projectDir, ".agent-flows", "config.json");
  if (!existsSync(configPath)) return undefined;

  let raw: string;
  try {
    raw = readFileSync(configPath, "utf8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`agent-flows: failed to read ${configPath}: ${msg}`, { cause: err });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`agent-flows: ${configPath} contains malformed JSON: ${msg}`, { cause: err });
  }

  if (typeof parsed !== "object" || parsed === null || !("checkCommand" in parsed)) {
    return undefined;
  }

  const val = (parsed as Record<string, unknown>).checkCommand;
  if (typeof val !== "string") {
    // Wrong-typed key is malformed config — a silent fallback would use the
    // default gate with no feedback, hiding a misconfigured project.
    throw new Error(`agent-flows: ${configPath}: checkCommand must be a string, got ${typeof val}`);
  }

  console.log(`agent-flows serve: checkCommand from ${configPath}: ${val}`);
  return val;
}

// ── startServer ────────────────────────────────────────────────────────────────

/**
 * Bind a loopback-only HTTP server. Returns a handle with the actual port
 * (useful when port 0 was requested) and a close function.
 */
export async function startServer(opts: ServeOptions): Promise<ServeHandle> {
  // opts.pipelinesDir is an explicit override (used by tests to pin a specific dir).
  // When absent, the canon directory is resolved per-request from projectDir (FR-004).
  const explicitPipelinesDir: string | undefined = opts.pipelinesDir;
  const projectDir = opts.projectDir ?? process.cwd();
  const state = opts.state;
  const dbPath = opts.dbPath ?? state.dbPath;
  const db = makeDb(dbPath);
  const runService = opts.runService ?? null;
  const uiPath = join(__dirname, "ui.html");
  const bundledPipelinesDir = opts.bundledPipelinesDir ?? defaultBundledPipelinesDir();

  const skillsBase =
    opts.skillsBase ?? process.env.AGENT_FLOWS_SKILLS_DIR ?? join(homedir(), ".claude");

  // boundPort is updated once the OS assigns a port (important when port: 0).
  let boundPort = opts.port ?? DEFAULT_PORT;

  // Identity reported by GET /api/daemon and written to daemon.json (FR-011).
  // startedAt is fixed in the listen callback, not here, so it names the moment
  // the daemon became reachable rather than the moment it began starting.
  const version = packageVersion();
  let startedAt = "";

  // FR-004: tracks the last-logged layer set so we emit one log line per
  // transition, not one per request. null means no line has been emitted yet.
  let lastLayerLine: string | null = null;

  // Spec 042 D11: the clock an auto-started daemon's idle exit is measured from.
  // Seeded at construction so a daemon that is spawned and never dialled still
  // ages out, rather than waiting for a first request that never comes.
  let lastRequestAt = Date.now();

  const server = nodeCreateServer((req, res) => {
    lastRequestAt = Date.now();
    // FR-004: resolve the workflow layers per-request so that a workflow added
    // while the daemon is running is reflected on the very next request, with no
    // restart required. When an explicit pipelinesDir was passed (test/legacy
    // path), that single directory is the only layer.
    const catalog =
      explicitPipelinesDir !== undefined
        ? mergedCatalog([layerForPipelinesDir(explicitPipelinesDir)])
        : resolveCatalog(projectDir);
    const layerLine = catalog.layers.map((l) => `${l.source} (${l.root})`).join(", ");
    if (layerLine !== lastLayerLine) {
      console.log(`agent-flows serve: workflow layers ${layerLine}`);
      lastLayerLine = layerLine;
    }
    // Writes still target one directory; reads all go through `catalog`.
    const pipelinesDir = explicitPipelinesDir ?? writeTargetLayer(catalog.layers).pipelinesDir;
    const root = dirname(pipelinesDir);

    void handleRequest(req, res, {
      pipelinesDir,
      catalog,
      root,
      db,
      runService,
      uiPath,
      boundPort,
      projectDir,
      state,
      dbPath,
      bundledPipelinesDir,
      skillsBase,
      version,
      startedAt,
      ...(opts.providerProfiles !== undefined ? { providerProfiles: opts.providerProfiles } : {}),
    }).catch((err: unknown) => {
      if (!res.headersSent) {
        if (err instanceof RequestTooLargeError) {
          json(res, 413, { error: err.message });
          return;
        }
        const msg = err instanceof Error ? err.message : String(err);
        json(res, 500, { error: safePath(msg, root) });
      }
    });
  });

  return new Promise<ServeHandle>((resolve, reject) => {
    // Scoped to the listen phase only (spec 033 D4): a socket error arriving
    // after a successful bind must not try to reject an already-settled promise.
    const onListenError = (err: Error): void => {
      reject(err);
    };
    server.listen(opts.port ?? DEFAULT_PORT, "127.0.0.1", () => {
      const info = server.address() as AddressInfo;
      boundPort = info.port;
      startedAt = new Date().toISOString();
      writeDaemonRecord(state.dir, {
        projectDir,
        version,
        pid: process.pid,
        startedAt,
        port: boundPort,
      });
      server.off("error", onListenError);
      server.on("error", (err: Error) => {
        console.error(`agent-flows serve: server error: ${err.message}`);
      });
      // Spec 042 D11: only a daemon the MCP process spawned reaps itself.
      const idleMs = opts.idleMs ?? envIdleMs() ?? DEFAULT_IDLE_MS;
      const idleTimer =
        (opts.autostarted ?? process.env[AUTOSTART_ENV] === "1")
          ? setInterval(() => {
              if (
                !shouldExitWhenIdle({
                  autostarted: true,
                  msSinceLastRequest: Date.now() - lastRequestAt,
                  // No run service means this daemon cannot be carrying a run.
                  inFlight: runService === null ? 0 : countInFlight(runService.list()),
                  idleMs,
                })
              ) {
                return;
              }
              console.log(
                `agent-flows serve: stopping — auto-started, idle and carrying no runs (port ${boundPort})`
              );
              removeDaemonRecordIfOwned(state.dir, process.pid);
              server.closeAllConnections();
              server.close(() => process.exit(0));
            }, idleCheckIntervalMs(idleMs))
          : undefined;
      // Never hold the process open on the timer's account: it exists to end the
      // process, so it must not be the reason the process is still there.
      idleTimer?.unref();
      resolve({
        port: info.port,
        close: () =>
          new Promise<void>((r, e) => {
            if (idleTimer !== undefined) clearInterval(idleTimer);
            // Graceful exit drops the record — but only if it is still ours, so
            // a daemon that was replaced while shutting down never deletes the
            // live one's record (FR-011).
            removeDaemonRecordIfOwned(state.dir, process.pid);
            // Destroy keep-alive connections immediately so server.close() resolves
            // without waiting for idle timeouts (important for SSE in tests).
            server.closeAllConnections();
            server.close((err) => {
              if (err) e(err);
              else r();
            });
          }),
      });
    });
    server.on("error", onListenError);
  });
}

/**
 * Pipe one request to another local daemon and its answer back (spec 042 D12).
 *
 * Piped rather than buffered: the run view reads progress over SSE, which never
 * ends, so anything that waits for a complete body would hang the view it exists
 * to show. The target is always 127.0.0.1 on a port read from a verified daemon
 * record — the caller resolves that before calling this.
 */
async function forwardToDaemon(
  req: IncomingMessage,
  res: ServerResponse,
  port: number,
  path: string
): Promise<void> {
  await new Promise<void>((resolve) => {
    const upstream = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path,
        method: req.method ?? "GET",
        // The target applies the same Host and content-type guards we just
        // passed, so it is handed a Host it will accept for its own port.
        headers: {
          host: `127.0.0.1:${port}`,
          ...(req.headers["content-type"] !== undefined
            ? { "content-type": req.headers["content-type"] }
            : {}),
          ...(req.headers.accept !== undefined ? { accept: req.headers.accept } : {}),
        },
      },
      (upRes) => {
        res.writeHead(upRes.statusCode ?? 502, upRes.headers);
        upRes.pipe(res);
        upRes.on("end", () => resolve());
        upRes.on("error", () => {
          res.end();
          resolve();
        });
      }
    );
    upstream.on("error", (err: Error) => {
      if (!res.headersSent) json(res, 502, { error: `daemon on port ${port}: ${err.message}` });
      else res.end();
      resolve();
    });
    // A client that navigates away mid-stream must not leave the upstream open.
    res.on("close", () => upstream.destroy());
    req.pipe(upstream);
  });
}

/**
 * The signed-in account per provider, resolved once (spec 042 D23).
 *
 * Two subprocesses, so it is answered from memory after the first ask: a plan
 * does not change between page loads, and a page that polls must not spawn a
 * process per poll. A CLI that is missing or slow yields an error field rather
 * than blocking the route — the rest of the providers view is still useful
 * without it.
 */
let _accounts: Record<string, ProviderAccount> | undefined;

function providerAccounts(): Record<string, ProviderAccount> {
  if (_accounts !== undefined) return _accounts;
  _accounts = probeProviderAccounts((bin, args) => {
    try {
      const out = spawnSync(bin, args, { encoding: "utf8", timeout: 10_000 });
      if (out.status !== 0) return undefined;
      // `codex login status` prints to STDERR, not stdout — reading stdout alone
      // reported a working CLI as silent. Status on stderr is common enough that
      // it is treated as an answer rather than as an error.
      const stdout = (out.stdout ?? "").trim();
      return stdout !== "" ? out.stdout : (out.stderr ?? undefined);
    } catch {
      return undefined;
    }
  });
  return _accounts;
}

// ── Port resolution and listen failures (spec 033 D4/FR-011/FR-012) ───────────

/** Printed when the requested port is not a usable TCP port number (FR-011). */
export function portInvalidMessage(value: string): string {
  return `agent-flows serve: invalid port "${value}" — pass --port <1-65535> or set AGENT_FLOWS_PORT`;
}

/** stderr + exit wiring, injected so the validation paths are testable. */
export interface CliIo {
  error: (message: string) => void;
  exit: (code: number) => never;
}

const DEFAULT_CLI_IO: CliIo = {
  error: (message) => {
    console.error(message);
  },
  exit: (code) => process.exit(code),
};

/** The conventional daemon port a human-launched `agent-flows serve` prefers. */
export const DEFAULT_PORT = 7411;

/**
 * Environment marker the MCP process sets on a daemon it starts itself
 * (spec 038 D8, FR-012). An auto-started daemon never takes the conventional
 * port, so it can never collide with one a human launched there.
 */
export const AUTOSTART_ENV = "AGENT_FLOWS_AUTOSTART";

/** The idle-span override, when it names a positive number of milliseconds. */
function envIdleMs(): number | undefined {
  const raw = process.env[IDLE_MS_ENV];
  if (raw === undefined) return undefined;
  const ms = Number(raw);
  return Number.isFinite(ms) && ms > 0 ? ms : undefined;
}

/** The resolved listen port plus whether the operator asked for that exact port. */
export interface PortChoice {
  /** Port to bind. 0 means "let the OS assign an ephemeral port". */
  port: number;
  /**
   * True when `--port` or `AGENT_FLOWS_PORT` named this port. An explicit port
   * that is taken is a user error and exits loudly; a defaulted one falls back
   * to an ephemeral port instead.
   */
  explicit: boolean;
}

/**
 * Resolve the daemon's listen port (spec 038 FR-012): `--port`, then
 * `AGENT_FLOWS_PORT`, then — for an auto-started daemon — an ephemeral port,
 * otherwise 7411 with an ephemeral fallback when it is taken.
 *
 * A value that is not a usable TCP port exits 1 with an explanation rather than
 * reaching listen(): `parseInt("abc")` is NaN and `listen(NaN)` silently binds a
 * random ephemeral port, so the daemon would come up somewhere nobody is looking.
 */
export function resolvePortChoice(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  io: CliIo = DEFAULT_CLI_IO
): PortChoice {
  const idx = argv.indexOf("--port");
  const flagValue = idx !== -1 && idx + 1 < argv.length ? argv[idx + 1] : undefined;
  const raw = flagValue ?? (env.AGENT_FLOWS_PORT !== "" ? env.AGENT_FLOWS_PORT : undefined);
  if (raw !== undefined) {
    const port = Number(raw);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      io.error(portInvalidMessage(raw));
      io.exit(1);
    }
    return { port, explicit: true };
  }
  if (env[AUTOSTART_ENV] === "1") return { port: 0, explicit: false };
  return { port: DEFAULT_PORT, explicit: false };
}

/**
 * FR-010: a db left in the launch cwd by an older version is never migrated.
 * Returns the operator notice, or undefined when there is nothing worth saying —
 * including when `--db` already points at that legacy file, where advising the
 * operator to pass the flag they just passed is pure noise.
 */
export function legacyDbNotice(
  cwd: string,
  dbPath: string,
  stateDbPath: string,
  exists: (path: string) => boolean = existsSync
): string | undefined {
  const legacyDbPath = join(cwd, "agent-flows.sqlite");
  if (!exists(legacyDbPath) || exists(stateDbPath)) return undefined;
  if (dbPath === legacyDbPath) return undefined;
  return (
    `[agent-flows] found a legacy database at ${legacyDbPath}; it is NOT migrated. ` +
    `The default is now ${stateDbPath} — pass --db ${legacyDbPath} to keep using the old one.`
  );
}

/** The operator-facing message printed when the daemon's port is taken (FR-012). */
export function portInUseMessage(port: number): string {
  return (
    `agent-flows serve: port ${port} is already in use — ` +
    `is another agent-flows daemon running? Pass --port <other> or stop it.`
  );
}

/**
 * Turn a listen failure into an operator-facing exit (FR-012). EADDRINUSE is an
 * ordinary operator mistake, so it gets a one-line explanation and exit 1 rather
 * than a stack trace; anything else is rethrown unchanged.
 */
export function handleListenError(err: unknown, port: number, io: CliIo): never {
  if ((err as NodeJS.ErrnoException | null)?.code === "EADDRINUSE") {
    io.error(portInUseMessage(port));
    io.exit(1);
  }
  throw err;
}

// ── Provider configuration routes (spec 039) ───────────────────────────────────

/** The roles a profile maps, in the order the page renders them as matrix rows. */
const PROVIDER_ROLE_IDS: readonly Role[] = ["reasoner", "worker", "scout"];

/** The one file the provider routes read and write — no caller-supplied component. */
function providersFilePath(projectDir: string): string {
  return join(projectDir, PROVIDERS_RELATIVE_PATH);
}

/** Current providers.yaml text, or undefined when the file is absent. Other IO errors throw. */
function readProvidersText(projectDir: string): string | undefined {
  try {
    return readFileSync(providersFilePath(projectDir), "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    throw err;
  }
}

/**
 * An endpoint stripped of any userinfo component before it leaves the daemon.
 *
 * The built-in api entries assemble their endpoint from OLLAMA_BASE_URL /
 * LITELLM_BASE_URL, which never pass through validateEndpoint's userinfo ban —
 * so a `https://user:pass@host` in the operator's environment would otherwise
 * put a password on the page.
 */
function redactEndpoint(endpoint: string): string {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return endpoint;
  }
  if (!url.username && !url.password) return endpoint;
  url.username = "";
  url.password = "";
  return url.toString();
}

/**
 * One model entry as the page sees it.
 *
 * `keyEnv` is reported by NAME only, plus whether that variable currently holds
 * a value. The value itself must never reach the page, a log or an error — a
 * credential belongs in the environment, and the editor only ever names it.
 */
function providerModelView(
  entry: ModelEntry,
  source: "project" | "builtin",
  env: NodeJS.ProcessEnv
): Record<string, unknown> {
  const base = { id: entry.id, transport: entry.transport, source };
  if (entry.transport === "cli") {
    return {
      ...base,
      cli: {
        bin: entry.cli?.bin ?? "claude",
        ...(entry.cli?.model !== undefined ? { model: entry.cli.model } : {}),
      },
    };
  }
  const keyEnv = entry.api?.keyEnv;
  return {
    ...base,
    api: {
      endpoint: redactEndpoint(entry.api?.endpoint ?? ""),
      ...(keyEnv !== undefined ? { keyEnv, keyEnvSet: (env[keyEnv] ?? "") !== "" } : {}),
      ...(entry.api?.model !== undefined ? { model: entry.api.model } : {}),
    },
  };
}

/**
 * The merged provider view: project-declared entries first, then the built-ins,
 * each marked with its source. Order is `getProfile`/`ModelRegistry` order, so
 * the page's "project overrides a built-in of the same id" badge describes what
 * resolution actually does rather than restating the rule.
 */
function providerView(
  config: ProviderConfig,
  env: NodeJS.ProcessEnv
): { profiles: Record<string, unknown>[]; models: Record<string, unknown>[] } {
  const builtinProfiles = builtInProfileIds().map((id) => getProfile(id));
  const builtinProfileIds = new Set(builtinProfiles.map((p) => p.id));
  const projectProfileIds = new Set(config.profiles.map((p) => p.id));
  const profiles = [
    ...config.profiles.map((p) => ({
      ...p,
      fallback: p.fallback ?? [],
      source: "project",
      overridesBuiltIn: builtinProfileIds.has(p.id),
    })),
    ...builtinProfiles.map((p) => ({
      ...p,
      fallback: p.fallback ?? [],
      source: "builtin",
      overriddenByProject: projectProfileIds.has(p.id),
    })),
  ];

  const builtinModels = defaultRegistry(env).list();
  const projectModelIds = new Set(config.models.map((m) => m.id));
  const models = [
    ...config.models.map((m) => providerModelView(m, "project", env)),
    ...builtinModels.map((m) => ({
      ...providerModelView(m, "builtin", env),
      overriddenByProject: projectModelIds.has(m.id),
    })),
  ];

  return { profiles, models };
}

// ── Bundled-catalog write guard ────────────────────────────────────────────────

/** True when the write layer resolves to the read-only bundled catalog. */
function isBundledCatalog(ctx: HandlerCtx): boolean {
  return resolve(ctx.pipelinesDir) === resolve(ctx.bundledPipelinesDir);
}

/**
 * Refuses a mutation aimed at the bundled catalog with 403 and the caller's
 * message. Drains the request body first so the socket stays alive long
 * enough to write the response. Returns true when the request was refused.
 */
async function refuseBundled(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: HandlerCtx,
  message: string
): Promise<boolean> {
  if (!isBundledCatalog(ctx)) return false;
  await readAndDiscardBody(req, BODY_LIMIT_DEFAULT);
  json(res, 403, { error: message });
  return true;
}

// ── Run lookup ───────────────────────────────────────────────────────────────

/** The pinned 404 body for a run id with no record behind it. */
function runNotFound(res: ServerResponse, id: string): void {
  json(res, 404, { error: `Run "${id}" not found` });
}

/**
 * Looks up a run snapshot for a route that has already narrowed its
 * RunService. Writes the 404 body and returns undefined for an unknown id.
 */
function requireRun(
  runService: RunService,
  res: ServerResponse,
  id: string
): ReturnType<RunService["get"]> {
  const snapshot = runService.get(id);
  if (!snapshot) {
    runNotFound(res, id);
    return undefined;
  }
  return snapshot;
}

// ── Request handler ────────────────────────────────────────────────────────────

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: HandlerCtx
): Promise<void> {
  const { root, boundPort } = ctx;
  const method = req.method ?? "GET";
  const rawUrl = req.url ?? "/";
  const url = new URL(rawUrl, `http://${req.headers.host ?? "localhost"}`);
  const pathname = url.pathname;

  // ── FR-019: Host validation (DNS-rebinding defence) ────────────────────────
  if (!isAllowedHost(req.headers.host, boundPort)) {
    json(res, 403, { error: "Forbidden: invalid Host header" });
    return;
  }

  const isMutating = method === "POST" || method === "PUT" || method === "DELETE";

  if (isMutating) {
    // Content-type guard — kills simple-form CSRF
    const ct = (req.headers["content-type"] ?? "").toLowerCase();
    if (!ct.startsWith("application/json")) {
      json(res, 403, { error: "Forbidden: content-type must be application/json" });
      return;
    }
    // Origin guard — forces preflight failure for cross-origin pages
    const origin = req.headers.origin;
    if (!isAllowedOrigin(origin, boundPort)) {
      json(res, 403, { error: "Forbidden: cross-origin request rejected" });
      return;
    }
  }

  // ── Route dispatch ─────────────────────────────────────────────────────────

  // GET / — serve the editor UI from disk
  if (method === "GET" && pathname === "/") {
    if (!existsSync(ctx.uiPath)) {
      res.writeHead(503, { "Content-Type": "text/plain" });
      res.end("UI file absent: src/serve/ui.html has not been built");
      return;
    }
    const html = readFileSync(ctx.uiPath, "utf8");
    res.writeHead(200, {
      "Content-Type": "text/html",
      // The UI uses inline <style> and <script>, so both style-src and script-src
      // must permit 'unsafe-inline'. All other fetch directives fall through to
      // default-src 'self', confining any future resource loads to the loopback origin.
      "Content-Security-Policy":
        "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    });
    res.end(html);
    return;
  }

  // GET /ui-route.js, /ui-log.js, … — the page's ESM helpers, kept as real
  // module files so they can be unit-tested without a DOM (spec 034 D7/V2,
  // spec 037 FR-015). Served from the same directory as ui.html; no build step.
  // Anything not in STATIC_MODULES falls through to the 404 at the end.
  if (method === "GET" && STATIC_MODULES.has(pathname)) {
    const moduleName = STATIC_MODULES.get(pathname)!;
    const modulePath = join(dirname(ctx.uiPath), moduleName);
    if (!existsSync(modulePath)) {
      res.writeHead(503, { "Content-Type": "text/plain" });
      res.end(`UI module absent: src/serve/${moduleName} is missing`);
      return;
    }
    res.writeHead(200, {
      "Content-Type": "text/javascript; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    });
    res.end(readFileSync(modulePath, "utf8"));
    return;
  }

  // GET /api/daemon — identity, health and version handshake in one route
  // (spec 038 D8, FR-011). The MCP client refuses to reuse a daemon
  // whose projectDir or version differs from its own, so this response is what
  // keeps one project's chat from running steps in another project's tree.
  if (method === "GET" && pathname === "/api/daemon") {
    const identity: DaemonIdentity = {
      projectDir: ctx.projectDir,
      version: ctx.version,
      pid: process.pid,
      startedAt: ctx.startedAt,
    };
    json(res, 200, identity);
    return;
  }

  // GET /api/daemons — every recorded daemon on this machine, verified (spec 042
  // FR-001, D2, D3). Cross-project and READ-ONLY: it reads other projects'
  // daemon.json and probes their ports, and no route here dispatches a run or
  // writes into a state directory that is not this daemon's own.
  if (method === "GET" && pathname === "/api/daemons") {
    const daemons = await listDaemons(stateRootOf(ctx.state), {
      self: { pid: process.pid, projectDir: ctx.projectDir },
    });
    json(res, 200, { daemons });
    return;
  }

  // /api/projects/:projectKey/api/... — read another project through this daemon
  // (spec 042 D12). The page stays on one origin and one port; the daemon whose
  // page is open forwards to the project the operator picked. The target port is
  // read from that project's own verified daemon record, never from the request,
  // so this cannot be aimed anywhere else. The response is piped rather than
  // buffered, because the run view's progress arrives as SSE.
  const proxySplit = splitProxyPath(pathname);
  if (proxySplit !== undefined) {
    const daemons = await listDaemons(stateRootOf(ctx.state), {
      self: { pid: process.pid, projectDir: ctx.projectDir },
    });
    const target = resolveProxyTarget(proxySplit.projectKey, daemons);
    if (typeof target === "string") {
      json(res, 502, { error: target });
      return;
    }
    await forwardToDaemon(req, res, target.port, proxySplit.rest + url.search);
    return;
  }

  // POST /api/daemons/:projectKey/stop — the page's Stop button (spec 042 FR-003,
  // D4, D8). No new kill mechanism: this delegates to `stopProjectDaemon`, which
  // re-runs the identity handshake before it signals anything, so a record that
  // went stale between the page's last read and this click is refused here too.
  // The StopReport is returned verbatim; the page renders its outcome and never
  // retries on its own.
  const daemonStopMatch = RE_DAEMON_STOP.exec(pathname);
  if (method === "POST" && daemonStopMatch) {
    const key = decodeURIComponent(daemonStopMatch[1]);
    await readAndDiscardBody(req, BODY_LIMIT_DEFAULT);
    const stateDir = stateDirForKey(stateRootOf(ctx.state), key);
    if (stateDir === undefined) {
      json(res, 404, { error: `No project state directory named "${key}"` });
      return;
    }
    json(res, 200, await stopProjectDaemon(stateDir));
    return;
  }

  // GET /api/pipelines[?source=bundled] (spec 037 FR-002)
  // `source` is an exact literal, never a directory name joined from request
  // input: the only alternative dir is the one the daemon already knows (S10).
  if (method === "GET" && pathname === "/api/pipelines") {
    const source = url.searchParams.get("source");
    if (source !== null && source !== "bundled") {
      json(res, 400, { error: "invalid source" });
      return;
    }
    if (source === "bundled") {
      // The package's own catalogue, never the merge.
      json(res, 200, {
        pipelines: listPipelineRows(ctx.bundledPipelinesDir, dirname(ctx.bundledPipelinesDir)),
      });
      return;
    }
    // The default listing is the merged three-layer view (D13), minus this
    // project's hidden ids (FR-026) — this is the page's workflow list, one of
    // the exactly two surfaces visibility filters. `?include=hidden` is the
    // management view the page's own toggle uses to bring one back; hiding
    // never refuses a run, so no run route consults this.
    const hidden = readHidden(ctx.state.dir);
    const rows = mergedPipelineRows(ctx.catalog, hidden);
    const includeHidden = url.searchParams.get("include") === "hidden";
    json(res, 200, {
      pipelines: includeHidden ? rows : rows.filter((row) => row.hidden !== true),
    });
    return;
  }

  // POST /api/pipelines/:id/fork — copy a workflow into a writable layer (FR-021,
  // FR-022). The page's Save on a workflow the project cannot write goes through
  // here first and then edits the copy; the source is never written in place.
  const forkMatch = RE_PIPELINE_FORK.exec(pathname);
  if (method === "POST" && forkMatch) {
    const id = decodeURIComponent(forkMatch[1]);
    const parsed = await requireJsonBody(req, res, BODY_LIMIT_DEFAULT);
    if (parsed === undefined) return;
    if (!requireSafeId(id, "Pipeline", res)) return;
    const { to, overwrite } = parsed;
    if (to !== undefined && to !== "user" && to !== "repo") {
      json(res, 400, { error: 'Field "to" must be "user" or "repo"' });
      return;
    }
    const target = resolveForkTarget(ctx.projectDir, ctx.catalog.layers, to);
    try {
      const report = forkPipeline({
        id,
        catalog: ctx.catalog,
        target,
        overwrite: overwrite === true,
      });
      json(res, 200, report);
    } catch (err) {
      const message = (err as Error).message;
      json(res, message.includes("already exists") ? 409 : 422, { error: message });
    }
    return;
  }

  // POST /api/pipelines/:id/visibility — hide or unhide one workflow (FR-025).
  const visibilityMatch = RE_PIPELINE_VISIBILITY.exec(pathname);
  if (method === "POST" && visibilityMatch) {
    const id = decodeURIComponent(visibilityMatch[1]);
    const parsed = await requireJsonBody(req, res, BODY_LIMIT_DEFAULT);
    if (parsed === undefined) return;
    if (!requireSafeId(id, "Pipeline", res)) return;
    const { hidden } = parsed;
    if (typeof hidden !== "boolean") {
      json(res, 400, { error: 'Field "hidden" must be a boolean' });
      return;
    }
    json(res, 200, { id, hidden, allHidden: setHidden(ctx.state.dir, id, hidden) });
    return;
  }

  // POST /api/pipelines — create a new pipeline in the project canon directory
  if (method === "POST" && pathname === "/api/pipelines") {
    const parsed = await requireJsonBody(req, res, BODY_LIMIT_DEFAULT);
    if (parsed === undefined) return;
    const { id, description } = parsed;
    if (typeof id !== "string" || !isSafeId(id)) {
      json(res, 400, {
        error:
          'Field "id" must be a non-empty lowercase alphanumeric+hyphen string (no dots or slashes)',
      });
      return;
    }
    // Refuse mutations against the bundled catalog — only project copies are writable.
    if (isBundledCatalog(ctx)) {
      json(res, 403, { error: "Cannot create pipelines in the bundled catalog" });
      return;
    }
    const destPath = join(ctx.pipelinesDir, `${id}.yaml`);
    if (existsSync(destPath)) {
      json(res, 409, { error: `Pipeline "${id}" already exists` });
      return;
    }
    const desc =
      typeof description === "string" && description.trim().length > 0
        ? description.trim()
        : "New pipeline";
    // Produce a minimal skeleton that passes loadPipeline immediately.
    // Uses kind:gate for the single stub step — gate requires no prompt file or role.
    const skeleton = stringify({
      id,
      version: 1,
      description: desc,
      inputs: [] as string[],
      steps: [{ id: "start", kind: "gate" }],
    });
    writeFileSync(destPath, skeleton, "utf8");
    json(res, 201, { id, path: relative(root, destPath) });
    return;
  }

  // GET /api/pipelines/:id/prompts — the editable prompt files of a workflow
  // (spec 037 D6). Registered before the pipeline-detail route so the /prompts
  // suffix reaches this handler and not the detail one. Only the pipeline's own
  // llm steps are listed: a namespaced `parent.child` id is a step of another
  // file, which this page does not edit.
  const promptsMatch = RE_PIPELINE_PROMPTS.exec(pathname);
  if (method === "GET" && promptsMatch) {
    const id = decodeURIComponent(promptsMatch[1]);
    if (isBundledCatalog(ctx)) {
      json(res, 403, { error: "Bundled workflows are read-only" });
      return;
    }
    const entry = findPipelineById(ctx.pipelinesDir, id);
    if (!entry) {
      // No isSafeId here (the id is never joined into a path — see the detail
      // route), so the echo is truncated instead.
      json(res, 404, { error: `Pipeline "${id.slice(0, 100)}" not found` });
      return;
    }
    const prompts: Record<string, { path: string; text: string; hash: string }> = {};
    const promptsDirForRead = join(dirname(dirname(resolve(entry.filePath))), "prompts");
    for (const [stepId, target] of ownPromptTargets(entry.filePath)) {
      // Same gate as the write route, applied before the read: a step whose
      // prompt is not an existing `.md` under `prompts/` is omitted, so a
      // declared `prompt: providers.yaml` is never read and never returned.
      if (!isWritablePromptFile(target.abs, promptsDirForRead)) continue;
      let text: string;
      try {
        text = readFileSync(target.abs, "utf8");
      } catch {
        continue; // a prompt that cannot be read is not editable
      }
      prompts[stepId] = {
        path: relative(ctx.root, target.abs),
        text,
        hash: hashContent(text),
      };
    }
    json(res, 200, prompts);
    return;
  }

  // PUT /api/pipelines/:id/prompts/:stepId — the only route that writes a
  // prompt file (spec 037 FR-005). Everything it may touch is an existing `.md`
  // inside the pipeline root's `prompts/` directory, checked after realpathSync;
  // the loader's own containment is deliberately not trusted for a write.
  const promptWriteMatch = RE_PIPELINE_PROMPT.exec(pathname);
  if (method === "PUT" && promptWriteMatch) {
    const id = decodeURIComponent(promptWriteMatch[1]);
    const stepId = decodeURIComponent(promptWriteMatch[2]);
    if (!requireSafeId(id, "Pipeline", res)) return;
    if (await refuseBundled(req, res, ctx, "Bundled workflows are read-only")) return;
    // A namespaced id belongs to a nested pipeline's file: not a step this
    // route can address, so it is absent rather than refused.
    if (!RE_OWN_STEP_ID.test(stepId)) {
      await readAndDiscardBody(req, BODY_LIMIT_DEFAULT);
      json(res, 404, { error: `Step "${stepId.slice(0, 100)}" not found` });
      return;
    }
    const entry = findPipelineById(ctx.pipelinesDir, id);
    if (!entry) {
      await readAndDiscardBody(req, BODY_LIMIT_DEFAULT);
      json(res, 404, { error: `Pipeline "${id}" not found` });
      return;
    }
    const parsed = await requireJsonBody(req, res, BODY_LIMIT_DEFAULT);
    if (parsed === undefined) return;
    const { text, ifMatch } = parsed;
    if (typeof text !== "string") {
      json(res, 400, { error: 'Field "text" must be a string' });
      return;
    }
    if (typeof ifMatch !== "string") {
      json(res, 400, { error: 'Field "ifMatch" must be a string' });
      return;
    }
    // A non-llm step has no prompt file, so it is not in the map either.
    const target = ownPromptTargets(entry.filePath).get(stepId);
    if (!target) {
      json(res, 404, { error: `Step "${stepId}" has no prompt file in "${id}"` });
      return;
    }
    const promptsDir = join(dirname(dirname(resolve(entry.filePath))), "prompts");
    if (!isWritablePromptFile(target.abs, promptsDir)) {
      json(res, 403, {
        error: `Step "${stepId}" prompt "${target.rel}" is not an existing .md file under prompts/`,
      });
      return;
    }
    const current = readFileSync(target.abs, "utf8");
    if (hashContent(current) !== ifMatch) {
      json(res, 409, {
        ok: false,
        reason: "conflict",
        message: `Prompt "${target.rel}" changed on disk since it was loaded — write refused`,
      });
      return;
    }
    // Validate before writing, exactly as the YAML save path does: the new text
    // is handed to the loader in place of the file so an unknown placeholder is
    // reported instead of persisted.
    try {
      loadPipeline(entry.filePath, {
        readFile: (p) => (resolve(p) === target.abs ? text : readFileSync(p, "utf8")),
      });
    } catch (err) {
      json(res, 422, { error: safePath((err as Error).message, root) });
      return;
    }
    // Write to a sibling temp file and rename over the target, so a crash
    // mid-write cannot leave a truncated prompt behind. The temp file starts at
    // 0o600 and takes the target's mode before the rename, so the prompt keeps
    // the permissions it already had.
    // The rename goes onto the realpath so a symlink inside `prompts/` is
    // followed exactly as writeFileSync followed it, not replaced.
    const realTarget = realpathSync(target.abs);
    const tmpPath = join(dirname(realTarget), `.${basename(realTarget)}.${randomUUID()}.tmp`);
    try {
      writeFileSync(tmpPath, text, { encoding: "utf8", mode: 0o600, flag: "wx" });
      chmodSync(tmpPath, statSync(realTarget).mode & 0o777);
      renameSync(tmpPath, realTarget);
    } catch (err) {
      rmSync(tmpPath, { force: true });
      throw err;
    }
    json(res, 200, { ok: true, hash: hashContent(text) });
    return;
  }

  // GET /api/pipelines/:id
  // No isSafeId check here: findPipelineById scans loaded pipeline ids for an
  // exact match and never joins `id` into a filesystem path, so an unsafe id
  // simply fails to match and falls through to 404. Safe only because of that
  // — a future rewrite that resolves the id into a path directly must add
  // validation before doing so.
  const pipelineDetailMatch = RE_PIPELINE_DETAIL.exec(pathname);
  if (method === "GET" && pipelineDetailMatch) {
    const id = decodeURIComponent(pipelineDetailMatch[1]);
    // Same exact-literal enum as the listing route: reads a bundled definition
    // rather than the merged view (spec 037 D4).
    const source = url.searchParams.get("source");
    if (source !== null && source !== "bundled") {
      json(res, 400, { error: "invalid source" });
      return;
    }
    const found =
      source === "bundled"
        ? findPipelineById(ctx.bundledPipelinesDir, id)
        : findMergedPipeline(ctx.catalog, id);
    if (!found) {
      json(res, 404, { error: `Pipeline "${id}" not found` });
      return;
    }
    const { def, prompts } = found.loaded;
    json(res, 200, {
      def,
      prompts,
      levels: pipelineLevels(def.steps),
      graph: pipelineToGraph(def.steps),
    });
    return;
  }

  // DELETE /api/pipelines/:id — remove a pipeline from the project canon directory
  if (method === "DELETE" && pipelineDetailMatch) {
    const id = decodeURIComponent(pipelineDetailMatch[1]);
    // Validate the decoded id so that percent-encoded traversal attempts are caught.
    if (!requireSafeId(id, "Pipeline", res)) return;
    // Refuse mutations against the bundled catalog.
    if (isBundledCatalog(ctx)) {
      json(res, 403, { error: "Cannot delete from the bundled pipeline catalog" });
      return;
    }
    const entry = findPipelineById(ctx.pipelinesDir, id);
    if (!entry) {
      json(res, 404, { error: `Pipeline "${id}" not found` });
      return;
    }
    // Refuse if any sibling pipeline nests this one — deleting it would break their loads.
    const dependants = findDependants(ctx.pipelinesDir, id);
    if (dependants.length > 0) {
      json(res, 409, {
        error: `Cannot delete "${id}": referenced by ${dependants.join(", ")}`,
      });
      return;
    }
    await readAndDiscardBody(req, BODY_LIMIT_DEFAULT); // consume body
    rmSync(entry.filePath);
    json(res, 200, { ok: true, id });
    return;
  }

  // POST /api/pipelines/:id/drafts
  // No isSafeId check here — see the rationale on GET /api/pipelines/:id above;
  // the same findPipelineById lookup makes an unsafe id fail as a plain 404.
  const openDraftMatch = RE_PIPELINE_DRAFTS.exec(pathname);
  if (method === "POST" && openDraftMatch) {
    const id = decodeURIComponent(openDraftMatch[1]);
    // Refuse mutations against the bundled catalog — a draft is the first step
    // of a write, so it is refused here and not only at save time.
    if (
      await refuseBundled(req, res, ctx, "Cannot open drafts against the bundled pipeline catalog")
    )
      return;
    const entry = findPipelineById(ctx.pipelinesDir, id);
    if (!entry) {
      json(res, 404, { error: `Pipeline "${id}" not found` });
      return;
    }
    // Consume the (empty) body to satisfy HTTP spec — no useful payload expected.
    await readAndDiscardBody(req, BODY_LIMIT_DEFAULT);
    const body = readFileSync(entry.filePath, "utf8");
    const baseHash = hashContent(body);
    const relPath = relative(root, entry.filePath);
    const sourceId = indexSource(ctx.db, root, relPath, "pipeline", baseHash);
    const draftId = openDraft(ctx.db, sourceId, body, baseHash);
    json(res, 200, { draftId, body, baseHash });
    return;
  }

  // POST /api/drafts/:draftId/preview — validate a draft body plus the prompt
  // texts being edited alongside it, without writing anything (spec 037 FR-004).
  // Registered before PUT /api/drafts/:draftId so the /preview suffix can never
  // be captured by the draft-detail route.
  //
  // Validation runs through loadPipeline's injected readFile — the same seam
  // saveDraft uses — rather than a temp copy of the canon directory: a copy
  // would silently redefine what "escapes the pipeline root" means, and the
  // nested pipelines the loader resolves would be the copies, not the siblings
  // that actually run.
  const previewMatch = RE_DRAFT_PREVIEW.exec(pathname);
  if (method === "POST" && previewMatch) {
    const draftId = parseInt(previewMatch[1], 10);
    const draft = getDraft(ctx.db, draftId);
    if (!draft) {
      await readAndDiscardBody(req, BODY_LIMIT_PREVIEW);
      json(res, 404, { error: `Draft ${draftId} not found` });
      return;
    }
    const source = getSource(ctx.db, draft.sourceId);
    if (!source) {
      await readAndDiscardBody(req, BODY_LIMIT_PREVIEW);
      json(res, 404, { error: `Draft ${draftId} not found` });
      return;
    }
    const parsed = await requireJsonBody(req, res, BODY_LIMIT_PREVIEW);
    if (parsed === undefined) return;
    const promptsField = parsed.prompts;
    if (
      promptsField !== undefined &&
      (typeof promptsField !== "object" || promptsField === null || Array.isArray(promptsField))
    ) {
      json(res, 400, { error: 'Field "prompts" must be an object' });
      return;
    }
    const promptTexts = (promptsField ?? {}) as Record<string, unknown>;
    for (const [stepId, value] of Object.entries(promptTexts)) {
      if (typeof value !== "string") {
        json(res, 400, { error: `Prompt "${stepId.slice(0, 100)}" must be a string` });
        return;
      }
    }
    const filePath = join(source.root, source.relPath);
    // The prompt paths come from the DRAFT body, not from disk: the body is
    // what the operator is validating, and it may have re-pointed a step.
    const pipelineRoot = dirname(dirname(resolve(filePath)));
    const overrides = new Map<string, string>([[resolve(filePath), draft.body]]);
    let draftDoc: unknown;
    try {
      draftDoc = parse(draft.body);
    } catch {
      draftDoc = null; // malformed YAML: let the loader produce the message
    }
    const draftSteps = (draftDoc as { steps?: unknown } | null)?.steps;
    if (Array.isArray(draftSteps)) {
      for (const step of draftSteps as { id?: unknown; kind?: unknown; prompt?: unknown }[]) {
        if (step?.kind !== "llm") continue;
        if (typeof step.id !== "string" || typeof step.prompt !== "string") continue;
        const text = promptTexts[step.id];
        if (typeof text !== "string") continue;
        overrides.set(resolve(pipelineRoot, step.prompt), text);
      }
    }
    let loaded: ReturnType<typeof loadPipeline>;
    try {
      loaded = loadPipeline(filePath, {
        readFile: (p) => overrides.get(resolve(p)) ?? readFileSync(p, "utf8"),
      });
    } catch (err) {
      json(res, 422, { error: safePath((err as Error).message, root) });
      return;
    }
    // S9: prompts are deliberately absent from the response — a draft that
    // points a step at providers.yaml must not turn preview into a file reader.
    json(res, 200, {
      def: loaded.def,
      levels: pipelineLevels(loaded.def.steps),
      graph: pipelineToGraph(loaded.def.steps),
    });
    return;
  }

  // PUT /api/drafts/:draftId
  const updateDraftMatch = RE_DRAFT_BY_ID.exec(pathname);
  if (method === "PUT" && updateDraftMatch) {
    const draftId = parseInt(updateDraftMatch[1], 10);
    if (await refuseBundled(req, res, ctx, "Cannot edit drafts of the bundled pipeline catalog"))
      return;
    const draft = getDraft(ctx.db, draftId);
    if (!draft) {
      json(res, 404, { error: `Draft ${draftId} not found` });
      return;
    }
    const parsed = await requireJsonBody(req, res, BODY_LIMIT_DEFAULT);
    if (parsed === undefined) return;
    const { body: newBody } = parsed;
    if (typeof newBody !== "string") {
      json(res, 400, { error: 'Field "body" must be a string' });
      return;
    }
    updateDraftBody(ctx.db, draftId, newBody);
    json(res, 200, { ok: true });
    return;
  }

  // POST /api/drafts/:draftId/save
  const saveDraftMatch = RE_DRAFT_SAVE.exec(pathname);
  if (method === "POST" && saveDraftMatch) {
    const draftId = parseInt(saveDraftMatch[1], 10);
    if (await refuseBundled(req, res, ctx, "Cannot save into the bundled pipeline catalog")) return;
    const draft = getDraft(ctx.db, draftId);
    if (!draft) {
      json(res, 404, { error: `Draft ${draftId} not found` });
      return;
    }
    await readAndDiscardBody(req, BODY_LIMIT_DEFAULT); // consume body
    // Saving writes the YAML and nothing else. Binding A (the Claude Code
    // script under `<root>/.claude/workflows/<id>.js`) is an export produced
    // only by the CLI — `agent-flows generate claude` — because regenerating it
    // from a network-editable YAML would write an executable file at a
    // YAML-controlled path.
    const result = saveDraft(ctx.db, draftId);
    if (result.ok) {
      json(res, 200, { ok: true });
      return;
    }
    if (result.reason === "conflict") {
      json(res, 409, { ok: false, reason: "conflict", message: result.message });
      return;
    }
    // reason === "invalid"
    json(res, 422, {
      ok: false,
      reason: "invalid",
      message: safePath(result.message, root),
    });
    return;
  }

  // POST /api/runs/decide — deterministic entry-point selection (spec 029 FR-005).
  // Must be checked BEFORE the bare POST /api/runs handler (which matches only the
  // exact path "/api/runs", but a future edit might accidentally collide).
  if (method === "POST" && pathname === "/api/runs/decide") {
    const parsed = await requireJsonBody(req, res, BODY_LIMIT_DEFAULT);
    if (parsed === undefined) return;
    const { input, kind } = parsed as { input?: unknown; kind?: unknown };
    if (typeof input !== "string" || input.trim() === "") {
      json(res, 400, { error: 'Field "input" must be a non-empty string' });
      return;
    }
    if (kind !== undefined && typeof kind !== "string") {
      json(res, 400, { error: 'Field "kind" must be a string when provided' });
      return;
    }
    const decision = decideEntryPoint(input, kind);
    if (!decision.ok) {
      json(res, 400, { error: decision.error });
      return;
    }
    json(res, 200, { pipeline: decision.pipeline, reason: decision.reason });
    return;
  }

  // POST /api/runs
  if (method === "POST" && pathname === "/api/runs") {
    const { runService } = ctx;
    if (!requireRunService(runService, res)) return;
    const parsed = await requireJsonBody(req, res, BODY_LIMIT_RUN);
    if (parsed === undefined) return;
    const { pipeline, inputs, models, provider, gateMode, artifactPath } = parsed as {
      pipeline?: unknown;
      inputs?: unknown;
      models?: unknown;
      provider?: unknown;
      gateMode?: unknown;
      artifactPath?: unknown;
    };
    if (typeof pipeline !== "string") {
      json(res, 400, { error: 'Field "pipeline" must be a string' });
      return;
    }
    if (gateMode !== undefined && gateMode !== "manual" && gateMode !== "auto") {
      json(res, 400, { error: 'Field "gateMode" must be "manual" or "auto"' });
      return;
    }
    // FR-009/S6: inputs are workflow input values, so every one of them must be
    // a string — a nested object reaches a z.string() input and produces a run
    // that appears to succeed on garbled data.
    if (typeof inputs === "object" && inputs !== null && !Array.isArray(inputs)) {
      for (const [key, value] of Object.entries(inputs as Record<string, unknown>)) {
        if (typeof value !== "string") {
          json(res, 400, { error: `Input "${key.slice(0, 100)}" must be a string` });
          return;
        }
      }
    }

    // Resolve pipeline step defs for provenance recording (spec 029 FR-002) and
    // to get the declared inputs list for artifact resolution (spec 029 FR-003).
    // If the pipeline is not found (e.g. not yet written to disk), omit steps —
    // transportPerStep will be empty rather than wrong.
    // Run entry resolution goes through the merged view (D13): a run may name a
    // workflow from any layer, not only the one writes target.
    const pipelineEntry = findMergedPipeline(ctx.catalog, pipeline);
    const pipelineDef = pipelineEntry?.loaded.def;

    // FR-009/S6: the per-step model override map is a flat step id → model id
    // record. Keys must name steps of this pipeline and values must be
    // registry-id-shaped, so a typo fails here rather than silently running the
    // profile default, and nothing unvalidated reaches the CLI argv.
    if (models !== undefined) {
      // The pipeline name is caller-supplied like the keys are, so it is
      // truncated the same way — an error message is not a place to echo an
      // unbounded request field back.
      const shownPipeline = pipeline.slice(0, 100);
      if (typeof models !== "object" || models === null || Array.isArray(models)) {
        json(res, 400, { error: 'Field "models" must be an object' });
        return;
      }
      if (!pipelineDef) {
        json(res, 400, {
          error: `Field "models" cannot be validated: pipeline "${shownPipeline}" not found`,
        });
        return;
      }
      const stepIds = new Set(pipelineDef.steps.map((s) => s.id));
      for (const [stepId, model] of Object.entries(models as Record<string, unknown>)) {
        if (!stepIds.has(stepId)) {
          json(res, 400, {
            error: `Model override "${stepId.slice(0, 100)}" is not a step of "${shownPipeline}"`,
          });
          return;
        }
        if (typeof model !== "string" || model.length > 100 || !CLI_MODEL_RE.test(model)) {
          json(res, 400, { error: `Model override "${stepId.slice(0, 100)}" must be a model id` });
          return;
        }
      }
    }

    // The per-run provider names a profile, not a model. It is resolved here so
    // an unknown id fails at the boundary rather than inside a step, and so the
    // run's provenance records the profile the run will actually use.
    let runProfile: ProviderProfile | undefined;
    if (provider !== undefined) {
      if (typeof provider !== "string") {
        json(res, 400, { error: 'Field "provider" must be a string' });
        return;
      }
      // The same array the workflows were built with, so validation and
      // execution can never disagree about which profiles exist.
      let declaredProfiles: ProviderProfile[];
      if (ctx.providerProfiles !== undefined) {
        declaredProfiles = ctx.providerProfiles;
      } else {
        try {
          declaredProfiles = loadProviders(ctx.projectDir).profiles;
        } catch (err) {
          json(res, 400, {
            error: `Field "provider" cannot be validated: ${err instanceof Error ? err.message : String(err)}`,
          });
          return;
        }
      }
      const known = new Set([...declaredProfiles.map((p) => p.id), ...builtInProfileIds()]);
      if (!known.has(provider)) {
        json(res, 400, {
          error: `Provider "${provider.slice(0, 100)}" does not name a known profile. Available: ${[...known].join(", ")}`,
        });
        return;
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
    const reservedKey = explicitInputKeys.find((key) => RESERVED_CONTEXT_KEYS.has(key));
    if (reservedKey !== undefined) {
      json(res, 400, {
        error: `Input "${reservedKey}" is reserved — pass it as the top-level "${reservedKey}" field instead`,
      });
      return;
    }
    if (explicitInputKeys.length > 0) {
      const shownPipeline = pipeline.slice(0, 100);
      if (!pipelineDef) {
        json(res, 400, {
          error: `Field "inputs" cannot be validated: pipeline "${shownPipeline}" not found`,
        });
        return;
      }
      const declared = new Set(pipelineDef.inputs ?? []);
      const unknownKey = explicitInputKeys.find((key) => !declared.has(key));
      if (unknownKey !== undefined) {
        json(res, 400, {
          error: `Input "${unknownKey.slice(0, 100)}" is not an input of "${shownPipeline}". Declared: ${[...declared].join(", ")}`,
        });
        return;
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
        projectDir: ctx.projectDir,
        stateRoot: stateRootOf(ctx.state),
        pipelineDef,
        explicitInputs,
      });
      if (!resolved.ok) {
        json(res, 400, { error: resolved.error });
        return;
      }
      artifactDerivedInputs = resolved.inputs;
      chainArtifactDir = resolved.chainDir;
    }

    // inputs is required when no artifactPath is provided (existing behaviour).
    if (artifactPath === undefined) {
      if (typeof inputs !== "object" || inputs === null || Array.isArray(inputs)) {
        json(res, 400, { error: 'Field "inputs" must be an object' });
        return;
      }
    }

    // Merge explicit inputs and artifact-derived inputs; artifact takes priority
    // when both are present (FR-003: "artifactPath takes priority").
    const wfInput: Record<string, unknown> = {
      ...explicitInputs,
      ...artifactDerivedInputs,
      ...(models !== undefined ? { models } : {}),
      ...(runProfile !== undefined ? { provider: runProfile.id } : {}),
    };

    const result = await runService.start(pipeline, wfInput, {
      gateMode: gateMode ?? "manual",
      ...(pipelineEntry !== undefined ? { pipelineSteps: pipelineEntry.loaded.def.steps } : {}),
      ...(chainArtifactDir !== undefined ? { chainArtifactDir } : {}),
      ...(typeof artifactPath === "string" ? { artifactPath } : {}),
      ...(runProfile !== undefined ? { provider: runProfile } : {}),
    });
    json(res, 200, result);
    return;
  }

  // GET /api/runs — list all runs in creation order (FR-002)
  if (method === "GET" && pathname === "/api/runs") {
    const { runService } = ctx;
    if (!requireRunService(runService, res)) return;
    json(res, 200, { runs: runService.list() });
    return;
  }

  // GET /api/runs/:id/events  — SSE (must precede the bare GET /api/runs/:id check)
  const sseMatch = RE_RUN_EVENTS.exec(pathname);
  if (method === "GET" && sseMatch) {
    const { runService } = ctx;
    if (!requireRunService(runService, res)) return;
    const id = decodeURIComponent(sseMatch[1]);
    const snapshot = requireRun(runService, res, id);
    if (!snapshot) return;

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    // Snapshot first — allows a client connecting mid-run to catch up.
    res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`);

    // A run restored from its artifact will never emit another event (spec 034
    // FR-011). Subscribing would register a listener on a run the service does
    // not hold and leave the client waiting on a stream that can never speak.
    if (snapshot.source === "disk") {
      res.end();
      return;
    }

    const safeWrite = (data: string): void => {
      if (!res.destroyed) res.write(data);
    };

    // Relay step lifecycle events with normalised status strings.
    // step-finish additionally carries outputExcerpt/outputTruncated (FR-006).
    const unsub = runService.subscribe(id, (event: StepEvent) => {
      const status = STEP_STATUS[event.kind];
      const payload: Record<string, unknown> = { stepId: event.stepId, status };
      if (event.kind === "step-finish") {
        if (event.outputExcerpt !== undefined) payload.outputExcerpt = event.outputExcerpt;
        if (event.outputTruncated !== undefined) payload.outputTruncated = event.outputTruncated;
      }
      safeWrite(`event: step\ndata: ${JSON.stringify(payload)}\n\n`);
    });

    // Spec 036 D4: inner step events, already on disk when they arrive here, so
    // a client that also fetches the backfill can de-duplicate on seq.
    const unsubLog = runService.subscribeLog(id, (event) => {
      safeWrite(`event: log\ndata: ${JSON.stringify(event)}\n\n`);
    });

    // Heartbeat comment every 15 s to keep proxies alive.
    const heartbeat = setInterval(() => {
      safeWrite(": heartbeat\n\n");
    }, 15_000);

    // Clean up on client disconnect — no listener leaks.
    req.on("close", () => {
      clearInterval(heartbeat);
      unsub();
      unsubLog();
    });

    return; // Connection is kept open; do not call res.end().
  }

  // GET /api/runs/:id/log?after=<seq> — NDJSON backfill of the step log (spec 036 D4).
  // Must precede GET /api/runs/:id, whose bare-id regex would eat the suffix.
  const runLogMatch = RE_RUN_LOG.exec(pathname);
  if (method === "GET" && runLogMatch) {
    const { runService } = ctx;
    if (!requireRunService(runService, res)) return;
    const id = decodeURIComponent(runLogMatch[1]);
    const afterRaw = url.searchParams.get("after");
    if (afterRaw !== null && !RE_AFTER_SEQ.test(afterRaw)) {
      json(res, 400, { error: "invalid after" });
      return;
    }
    if (!requireRun(runService, res, id)) return;
    // A run recorded before this spec has no events file: an empty body, not a 404.
    const location = runService.logLocation(id);
    const after = Number(afterRaw ?? 0);
    // The pipeline id comes from a persisted artifact, so it is untrusted input
    // to a path join: an unsafe one is a run whose log cannot be addressed.
    let file: string | undefined;
    try {
      file = location === undefined ? undefined : runLogFile(location.dir, location.pipelineId);
    } catch (err) {
      if (!(err instanceof RangeError)) throw err;
      runNotFound(res, id);
      return;
    }
    res.writeHead(200, {
      "Content-Type": "application/x-ndjson",
      "X-Content-Type-Options": "nosniff",
    });
    // Streamed line by line: a long run's log must not be held in memory per request.
    if (file !== undefined) await pipeRunLog(file, res, { after });
    res.end();
    return;
  }

  // GET /api/runs/:id/steps/:stepId/output — one step's full output (spec 036 D6).
  const stepOutputMatch = RE_RUN_STEP_OUTPUT.exec(pathname);
  if (method === "GET" && stepOutputMatch) {
    const { runService } = ctx;
    if (!requireRunService(runService, res)) return;
    const id = decodeURIComponent(stepOutputMatch[1]);
    const stepId = decodeURIComponent(stepOutputMatch[2]);
    if (!isSafeStepId(stepId)) {
      json(res, 400, { error: `Step id "${stepId}" is invalid` });
      return;
    }
    if (!requireRun(runService, res, id)) return;
    const location = runService.logLocation(id);
    let output: unknown;
    try {
      output =
        location === undefined
          ? undefined
          : readStepOutput(stepOutputFile(location.dir, location.pipelineId, stepId));
    } catch (err) {
      if (!(err instanceof RangeError)) throw err;
      runNotFound(res, id);
      return;
    }
    if (output === undefined) {
      json(res, 404, { error: `No output recorded for step "${stepId}"` });
      return;
    }
    json(res, 200, output);
    return;
  }

  // GET /api/runs/:id/manifest — return the chain manifest for a run (spec 029 FR-006).
  // Must precede GET /api/runs/:id to avoid the bare-id regex eating the "/manifest" suffix.
  // Reads from disk keyed by id as the directory anchor — the run need not be in the
  // registry. Artifacts and the manifest exist precisely so a chain survives a daemon
  // restart and can be picked up later, possibly under a different provider.
  const manifestMatch = RE_RUN_MANIFEST.exec(pathname);
  if (method === "GET" && manifestMatch) {
    const id = decodeURIComponent(manifestMatch[1]);
    // Validate the id before joining it into a path — a crafted id must not escape runs/.
    // Follows the same isSafeId pattern used for DELETE /api/pipelines/:id.
    if (!requireSafeId(id, "Run", res)) return;
    const runDir = join(ctx.state.runsDir, id);
    if (!existsSync(join(runDir, "manifest.json"))) {
      runNotFound(res, id);
      return;
    }
    let manifest: unknown;
    try {
      // readManifest reconciles the file against artifacts present in the same
      // directory, so stages that wrote an artifact but missed their manifest
      // entry (write failure or pre-manifest artifact) are still visible.
      manifest = await readManifest(runDir);
    } catch {
      json(res, 500, { error: `Cannot read manifest for run "${id}"` });
      return;
    }
    json(res, 200, manifest);
    return;
  }

  // GET /api/runs/:id
  const runGetMatch = RE_RUN_BY_ID.exec(pathname);
  if (method === "GET" && runGetMatch) {
    const { runService } = ctx;
    if (!requireRunService(runService, res)) return;
    const id = decodeURIComponent(runGetMatch[1]);
    const state = requireRun(runService, res, id);
    if (!state) return;
    json(res, 200, state);
    return;
  }

  // POST /api/runs/:id/approve
  const approveMatch = RE_RUN_APPROVE.exec(pathname);
  if (method === "POST" && approveMatch) {
    const { runService } = ctx;
    if (!requireRunService(runService, res)) return;
    const id = decodeURIComponent(approveMatch[1]);
    const parsed = await requireJsonBody(req, res, BODY_LIMIT_DEFAULT);
    if (parsed === undefined) return;
    const { approved, reason } = parsed;
    if (typeof approved !== "boolean") {
      json(res, 400, { error: 'Field "approved" must be a boolean' });
      return;
    }
    // reason is optional free-text; ignore anything that is not a string (FR-006).
    const reasonStr = typeof reason === "string" ? reason : undefined;
    const result = await runService.approve(id, approved, reasonStr);
    if (result.status === undefined) {
      // The call could not be processed (no run, wrong status, etc.) — 409.
      json(res, 409, { error: result.error });
      return;
    }
    json(res, 200, result);
    return;
  }

  // POST /api/runs/:id/cancel — abort an in-flight run (spec 033 D2/FR-005)
  const cancelMatch = RE_RUN_CANCEL.exec(pathname);
  if (method === "POST" && cancelMatch) {
    const { runService } = ctx;
    if (!requireRunService(runService, res)) return;
    const id = decodeURIComponent(cancelMatch[1]);
    // The body is optional — an empty request is a cancel with no reason.
    const parsed = await requireJsonBody(req, res, BODY_LIMIT_DEFAULT);
    if (parsed === undefined) return;
    const { reason } = parsed;
    const reasonStr = typeof reason === "string" ? reason : undefined;
    const result = await runService.cancel(id, reasonStr);
    if (result === undefined) {
      runNotFound(res, id);
      return;
    }
    if (!result.ok) {
      json(res, 409, {
        error: `Run ${id} cannot be cancelled (status: ${result.status})`,
        status: result.status,
      });
      return;
    }
    res.writeHead(204).end();
    return;
  }

  // POST /api/gate-judge — stateless judge-as-a-service for external callers (FR-012)
  if (method === "POST" && pathname === "/api/gate-judge") {
    const { runService } = ctx;
    if (!requireRunService(runService, res)) return;
    const parsed = await requireJsonBody(req, res, BODY_LIMIT_DEFAULT);
    if (parsed === undefined) return;
    const { gateMessage, spec, pipelineId } = parsed as {
      gateMessage?: unknown;
      spec?: unknown;
      pipelineId?: unknown;
    };
    if (typeof gateMessage !== "string") {
      json(res, 400, { error: 'Field "gateMessage" must be a string' });
      return;
    }
    const result = await runService.gateJudge({
      gateMessage,
      spec,
      pipelineId: typeof pipelineId === "string" ? pipelineId : undefined,
    });
    if ("error" in result) {
      json(res, 502, { error: result.error });
      return;
    }
    json(res, 200, { verdict: result.verdict, reason: result.reason });
    return;
  }

  // GET /api/environment — describe the launch-point context
  if (method === "GET" && pathname === "/api/environment") {
    const skillsSubdir = join(ctx.skillsBase, "skills");
    const agentsSubdir = join(ctx.skillsBase, "agents");

    // Skills: subdirectory (or symlink-to-directory) names inside <skillsBase>/skills/.
    // Return names only; never read file contents.
    let skills: string[] = [];
    try {
      skills = readdirSync(skillsSubdir)
        .filter((name) => {
          try {
            return statSync(join(skillsSubdir, name)).isDirectory();
          } catch {
            return false;
          }
        })
        .sort();
    } catch {
      // skills subdirectory does not exist — return empty
    }

    // Agents: .md filenames (minus extension) in <skillsBase>/agents/.
    // Return names only; never read file contents.
    let agents: string[] = [];
    try {
      agents = readdirSync(agentsSubdir)
        .filter((f) => f.endsWith(".md"))
        .map((f) => f.slice(0, -3))
        .sort();
    } catch {
      // agents subdirectory does not exist — return empty
    }

    const isBundled = isBundledCatalog(ctx);

    // spec 034 D6: the Settings view reports which provider profile is in force.
    // A profile that cannot be resolved is reported as "unknown" rather than
    // failing the whole environment response.
    const profile = activeProfileIdOrUnknown();

    json(res, 200, {
      projectDir: ctx.projectDir,
      stateDir: ctx.state.dir,
      runsDir: ctx.state.runsDir,
      dbPath: ctx.dbPath,
      pipelinesSource: isBundled ? "bundled" : "project",
      pipelinesDir: ctx.pipelinesDir,
      port: ctx.boundPort,
      profile,
      skills,
      agents,
    });
    return;
  }

  // GET /api/providers — the role × profile matrix the Settings view edits (spec 039).
  if (method === "GET" && pathname === "/api/providers") {
    let text: string | undefined;
    try {
      text = readProvidersText(ctx.projectDir);
    } catch (err) {
      json(res, 500, {
        error: `Cannot read ${PROVIDERS_RELATIVE_PATH}: ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }
    // A malformed file must still open the editor — refusing here would leave the
    // only way to fix providers.yaml outside the page that exists to edit it.
    let config: ProviderConfig = { models: [], profiles: [] };
    let fileError: string | undefined;
    if (text !== undefined && text !== "") {
      try {
        config = parseProviders(text, PROVIDERS_RELATIVE_PATH);
      } catch (err) {
        fileError = err instanceof Error ? err.message : String(err);
      }
    }

    const { profiles, models } = providerView(config, process.env);
    const activeProfile = activeProfileIdOrUnknown(process.env, config);
    // The daemon resolves steps from its startup snapshot, so a file edited
    // since then is on disk but not in force. Reporting the divergence lets the
    // page say so instead of implying a saved change took effect.
    const restartRequired =
      ctx.providerProfiles !== undefined &&
      JSON.stringify(ctx.providerProfiles) !== JSON.stringify(config.profiles);

    json(res, 200, {
      path: PROVIDERS_RELATIVE_PATH,
      exists: text !== undefined,
      hash: text === undefined ? "" : hashContent(text),
      roles: PROVIDER_ROLE_IDS,
      activeProfile,
      ...(config.defaultProvider !== undefined ? { defaultProvider: config.defaultProvider } : {}),
      profiles,
      models,
      // 042 D23: which account each CLI is signed in as. Probed once at startup —
      // it is two subprocesses, and a plan does not change between page loads.
      accounts: providerAccounts(),
      restartRequired,
      ...(fileError !== undefined ? { fileError } : {}),
    });
    return;
  }

  // PUT /api/providers — write <projectDir>/.agent-flows/providers.yaml.
  // The target path is assembled from ctx.projectDir and a module constant; no
  // part of it is caller-supplied.
  if (method === "PUT" && pathname === "/api/providers") {
    const parsed = await requireJsonBody(req, res, BODY_LIMIT_DEFAULT);
    if (parsed === undefined) return;
    const { config, ifMatch } = parsed;
    if (typeof config !== "object" || config === null || Array.isArray(config)) {
      json(res, 400, { error: 'Field "config" must be an object' });
      return;
    }
    if (typeof ifMatch !== "string") {
      json(res, 400, { error: 'Field "ifMatch" must be a string' });
      return;
    }

    // Serialise, then hand the result to the loader's own parser. Validation is
    // never duplicated here: whatever the daemon would refuse to load, this
    // route refuses to write — and it refuses before touching the filesystem.
    let text: string;
    try {
      text = stringify(config);
    } catch (err) {
      json(res, 400, {
        error: `Cannot serialise ${PROVIDERS_RELATIVE_PATH}: ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }
    try {
      parseProviders(text, PROVIDERS_RELATIVE_PATH);
    } catch (err) {
      json(res, 400, { error: err instanceof Error ? err.message : String(err) });
      return;
    }

    let current: string | undefined;
    try {
      current = readProvidersText(ctx.projectDir);
    } catch (err) {
      json(res, 500, {
        error: `Cannot read ${PROVIDERS_RELATIVE_PATH}: ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }
    if ((current === undefined ? "" : hashContent(current)) !== ifMatch) {
      json(res, 409, {
        ok: false,
        reason: "conflict",
        message: `${PROVIDERS_RELATIVE_PATH} changed on disk since it was loaded — write refused`,
      });
      return;
    }

    const filePath = providersFilePath(ctx.projectDir);
    const containingDir = dirname(filePath);
    mkdirSync(containingDir, { recursive: true });
    // Containment is re-checked after symlink resolution, mirroring loadProviders:
    // a `.agent-flows` symlinked out of the project must not become a write target.
    let realDir: string;
    let realProjectDir: string;
    try {
      realProjectDir = realpathSync(ctx.projectDir);
      realDir = realpathSync(containingDir);
    } catch (err) {
      json(res, 500, {
        error: `Cannot resolve ${PROVIDERS_RELATIVE_PATH}: ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }
    const rootWithSep = realProjectDir.endsWith(sep) ? realProjectDir : realProjectDir + sep;
    if (!(realDir + sep).startsWith(rootWithSep)) {
      json(res, 403, {
        error: `${PROVIDERS_RELATIVE_PATH} resolves outside the project directory — write refused`,
      });
      return;
    }
    const targetPath = join(realDir, basename(filePath));
    // Unlike a prompt file, providers.yaml is never followed through a symlink:
    // the loader already rejects one that escapes the project, and a write has
    // no reason to be more permissive than the read.
    let mode = 0o600;
    try {
      const existing = lstatSync(targetPath);
      if (existing.isSymbolicLink()) {
        json(res, 403, {
          error: `${PROVIDERS_RELATIVE_PATH} is a symlink — write refused`,
        });
        return;
      }
      mode = existing.mode & 0o777;
    } catch {
      // Absent — a new file keeps the 0o600 the temp file is created with.
    }

    const tmpPath = join(realDir, `.providers.yaml.${randomUUID()}.tmp`);
    try {
      writeFileSync(tmpPath, text, { encoding: "utf8", mode: 0o600, flag: "wx" });
      chmodSync(tmpPath, mode);
      renameSync(tmpPath, targetPath);
    } catch (err) {
      rmSync(tmpPath, { force: true });
      throw err;
    }
    // The daemon's registry, active profile and profile list are all startup
    // snapshots baked into every built workflow, so a saved file is not yet in
    // force. Refreshing only the profile list would be worse than not
    // refreshing: a new profile would resolve while the models it names would
    // still be missing from the registry, moving the failure from this boundary
    // into the middle of a run.
    json(res, 200, { ok: true, hash: hashContent(text), restartRequired: true });
    return;
  }

  if (handleContentRoutes(req, res, ctx, method, pathname)) return;

  // GET /api/export/:id — export a pipeline and its full closure as a YAML bundle
  const exportMatch = RE_EXPORT.exec(pathname);
  if (method === "GET" && exportMatch) {
    const id = decodeURIComponent(exportMatch[1]);
    if (!requireSafeId(id, "Pipeline", res)) return;
    // FR-029: the layer that owns the id decides which pipelines directory the
    // bundle is read from — exporting a bundled workflow from a project that has
    // a canon of its own must not look for it in that canon.
    const owner = ctx.catalog.entries.get(id);
    if (owner === undefined) {
      json(res, 422, { error: `Pipeline "${id}" not found` });
      return;
    }
    try {
      // The closure is resolved through the merged view, so a parent that
      // mounts a child owned by another layer exports that child too (D13/D16).
      const bundle = exportBundle(
        id,
        owner.layer.pipelinesDir,
        (nestedId) => ctx.catalog.entries.get(nestedId)?.filePath
      );
      const yamlText = stringifyBundle(bundle);
      res.writeHead(200, {
        "Content-Type": "application/x-yaml",
        "Content-Disposition": `attachment; filename="${id}.agent-flows-bundle.yaml"`,
      });
      res.end(yamlText);
    } catch (err) {
      json(res, 422, { error: safePath((err as Error).message, root) });
    }
    return;
  }

  // POST /api/import — import a workflow bundle into .agent-flows/
  if (method === "POST" && pathname === "/api/import") {
    const parsed = await requireJsonBody(req, res, BODY_LIMIT_IMPORT);
    if (parsed === undefined) return;
    const { bundle: bundleText, overwrite, target } = parsed;
    if (typeof bundleText !== "string") {
      json(res, 400, { error: 'Field "bundle" must be a string' });
      return;
    }
    if (target !== undefined && target !== "user" && target !== "repo") {
      json(res, 400, { error: 'Field "target" must be "user" or "repo"' });
      return;
    }
    // FR-027: the target layer moves, the guards do not — the allowlist, the
    // normalisation gate and the realpath containment are all measured against
    // whichever root is chosen here.
    const targetRoot =
      target === "repo" ? repoCanonRoot(ctx.projectDir) : userLibraryRoot(process.env);
    const doOverwrite = overwrite === true;
    try {
      const bundle = parseBundle(bundleText);
      const report = importBundle(bundle, targetRoot, doOverwrite);
      json(res, 200, { ...report, target: target === "repo" ? "repo" : "user", root: targetRoot });
    } catch (err) {
      json(res, 422, { error: safePath((err as Error).message, root) });
    }
    return;
  }

  json(res, 404, { error: `Not found: ${method} ${pathname}` });
}

// ── CLI entrypoint ─────────────────────────────────────────────────────────────

function getArgValue(flag: string, fallback: string): string {
  const idx = process.argv.indexOf(flag);
  return idx !== -1 && idx + 1 < process.argv.length
    ? (process.argv[idx + 1] ?? fallback)
    : fallback;
}

if (process.argv[1] === __filename) {
  process.env.MASTRA_TELEMETRY_DISABLED = "1";

  const portChoice = resolvePortChoice(process.argv, process.env);
  const projectDir = resolveProjectDir();
  console.log(`agent-flows serve: running steps in ${projectDir}`);
  const startupCatalog = resolveCatalog(projectDir);
  console.log(
    `agent-flows serve: workflow layers ${startupCatalog.layers
      .map((l) => `${l.source} (${l.root})`)
      .join(", ")}`
  );

  // Spec 032: machine-local state lives outside the project tree.
  const state = ensureProjectState(projectDir, process.env, (m) => {
    console.error(m);
  });
  console.log(`agent-flows serve: state in ${state.dir}`);
  const dbPath = getArgValue("--db", state.dbPath);

  const legacyNotice = legacyDbNotice(process.cwd(), dbPath, state.dbPath);
  if (legacyNotice !== undefined) console.error(legacyNotice);

  // Non-literal specifiers prevent import-x/no-cycle from traversing into
  // @mastra/core's deep subpath exports, which crash the resolver —
  // see the eslint override on src/bindings/mastra/** for context.
  // The values resolve correctly at runtime; only static analysis is bypassed.
  const mastraCoreSpec = "@mastra/core/mastra";
  const mastraLibsqlSpec = "@mastra/libsql";
  const bindingsBuildSpec = "../bindings/mastra/build.js" as string;
  const bindingsPathsSpec = "../bindings/mastra/paths.js" as string;
  const registrySpec = "../canon/registry.js" as string;
  const sqliteSpec = "../store/sqlite.js" as string;
  const runServiceSpec = "../runtime/runService.js" as string;

  /* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call */
  const { Mastra } = await import(mastraCoreSpec);
  const { LibSQLStore } = await import(mastraLibsqlSpec);
  const { buildPipelineWorkflow } = await import(bindingsBuildSpec);
  const { mastraDbPath } = await import(bindingsPathsSpec);
  const { defaultRegistry, getActiveProfile } = await import(registrySpec);
  const { DrizzleTicketStore } = await import(sqliteSpec);
  const { RunService: RunServiceClass } = await import(runServiceSpec);

  const mastraDb = mastraDbPath(dbPath);
  const mastraStorage = new LibSQLStore({ id: "agent-flows-mastra", url: `file:${mastraDb}` });
  const db = makeDb(dbPath);
  const store = new DrizzleTicketStore(db);
  const providers = loadProviders(projectDir);
  const registry = defaultRegistry(process.env, providers.models);
  const profile = getActiveProfile(process.env, providers);

  // FR-003: read once at startup; the resolved value is baked into each workflow
  // at build time. readAgentFlowsConfig throws loudly on malformed config so a
  // misconfigured project never silently falls back to the default gate.
  const checkCommand = readAgentFlowsConfig(projectDir);

  const { loaded: startupPipelines } = loadCatalogPipelines(startupCatalog);
  const workflows: Record<string, unknown> = {};
  for (const { loaded } of startupPipelines) {
    workflows[loaded.def.id] = buildPipelineWorkflow(loaded, {
      registry,
      store,
      profile,
      providerProfiles: providers.profiles,
      cwd: projectDir,
      ...(checkCommand !== undefined ? { checkCommand } : {}),
    });
  }

  const initialMastra = new Mastra({ storage: mastraStorage, workflows });

  // FR-004: wrap the Mastra instance so that pipelines installed or edited while
  // the daemon is running become executable without a restart.  The wrapper catches
  // "not found" throws from getWorkflow, rescans the current canon, rebuilds all
  // workflow objects, and retries — matching the per-request canon resolution that
  // the listing endpoint already performs.
  const mastra = createDynamicMastra(
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    initialMastra,
    {
      MastraClass: Mastra,
      mastraStorage,
      buildFn: buildPipelineWorkflow,
      buildDeps: {
        registry,
        store,
        profile,
        providerProfiles: providers.profiles,
        cwd: projectDir,
        ...(checkCommand !== undefined ? { checkCommand } : {}),
      },
      projectDir,
    }
  );

  // Pass the state runs dir, profile, and registry so the service can write durable
  // artifacts with full provenance (spec 029 FR-001/FR-002) without requiring
  // judgeDeps in production.
  const runService = new RunServiceClass(mastra, undefined, state.runsDir, profile, registry);

  const cliIo: CliIo = {
    error: (m) => {
      console.error(m);
    },
    exit: (code) => process.exit(code),
  };

  // FR-004: pipelinesDir is NOT passed to startServer so the HTTP layer resolves
  // the canon directory per-request.
  const listenOn = async (port: number): Promise<ServeHandle> =>
    startServer({
      port,
      dbPath,
      runService,
      projectDir,
      state,
      // The same snapshot the workflows above were built with (spec 039 review).
      providerProfiles: providers.profiles,
    });

  let handle: ServeHandle;
  try {
    handle = await listenOn(portChoice.port);
  } catch (err: unknown) {
    if (portChoice.explicit || (err as NodeJS.ErrnoException | null)?.code !== "EADDRINUSE") {
      handleListenError(err, portChoice.port, cliIo);
    }
    console.error(
      `agent-flows serve: port ${portChoice.port} is in use; taking an OS-assigned port instead.`
    );
    handle = await listenOn(0).catch((e: unknown) => handleListenError(e, 0, cliIo));
  }
  /* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call */
  console.log(`agent-flows serve listening on http://127.0.0.1:${handle.port}`);

  // FR-011: drop daemon.json on a graceful exit. Removal is pid-checked, so a
  // signal arriving after a newer daemon has replaced the record leaves that
  // record alone. process.exit() in the handler keeps the default termination
  // behaviour that installing a listener would otherwise suppress.
  const dropRecord = (): void => {
    removeDaemonRecordIfOwned(state.dir, process.pid);
  };
  process.on("exit", dropRecord);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, () => {
      dropRecord();
      process.exit(0);
    });
  }
}
