// FR-010 / FR-019 — loopback-only HTTP + SSE editor server (ADR-0013).
// Serves the DAG editor UI, relays run events over SSE, and enforces
// DNS-rebinding and simple-form CSRF mitigations. Zero new runtime
// dependencies — node:http only.

import { createHash } from "node:crypto";
import {
  existsSync,
  realpathSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import {
  createServer as nodeCreateServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parse, stringify } from "yaml";

import { createDynamicMastra } from "../bindings/mastra/dynamicMastra.js";
import { BUNDLED_PIPELINES_DIR, resolveCanonDir } from "../bindings/mastra/pipelineLoader.js";
import { resolveProjectDir } from "../bindings/mastra/projectDir.js";
import { saveDraft, type SaveResult } from "../canon/canonWriter.js";
import { getDraft, indexSource, openDraft, updateDraftBody } from "../canon/draftStore.js";
import { renderSpecKitSpec } from "../canon/exportSpec.js";
import { pipelineToGraph, pipelineLevels } from "../canon/graph.js";
import { listPipelines, loadPipeline } from "../canon/load.js";
import { loadProviders } from "../canon/loadProviders.js";
import { getActiveProfile } from "../canon/registry.js";
import { makeDb, type DbInstance } from "../db/index.js";
import { exportBundle, importBundle, parseBundle, stringifyBundle } from "../install/bundle.js";
import { installWorkflow, listAvailable, listInstalled } from "../install/install.js";
import { assertSafePath, isContained } from "../install/paths.js";
import { readManifest } from "../runtime/artifactStore.js";
import { decideEntryPoint } from "../runtime/entryPoint.js";
import { ensureProjectState, type ProjectState } from "../runtime/projectState.js";
import {
  isSafeStepId,
  pipeRunLog,
  readStepOutput,
  runLogFile,
  stepOutputFile,
} from "../runtime/stepLog.js";

import {
  isSafeId,
  json,
  parseJsonBody,
  readAndDiscardBody,
  readBody,
  readJsonBody,
  requireRunService,
  RequestTooLargeError,
  safePath,
} from "./route-helpers.js";
import { CONTENT_CAP, handleNamedContent } from "./routes/content.js";
import type { HardenedSpec } from "../canon/types.js";
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
const RE_DRAFT_BY_ID = /^\/api\/drafts\/(\d+)$/u;
const RE_DRAFT_SAVE = /^\/api\/drafts\/(\d+)\/save$/u;
const RE_RUN_EVENTS = /^\/api\/runs\/([^/]+)\/events$/u;
const RE_RUN_LOG = /^\/api\/runs\/([^/]+)\/log$/u;
const RE_RUN_STEP_OUTPUT = /^\/api\/runs\/([^/]+)\/steps\/([^/]+)\/output$/u;
const RE_AFTER_SEQ = /^\d+$/u;
const RE_RUN_BY_ID = /^\/api\/runs\/([^/]+)$/u;
const RE_RUN_APPROVE = /^\/api\/runs\/([^/]+)\/approve$/u;
const RE_RUN_CANCEL = /^\/api\/runs\/([^/]+)\/cancel$/u;
const RE_RUN_MANIFEST = /^\/api\/runs\/([^/]+)\/manifest$/u;
const RE_SKILL_CONTENT = /^\/api\/skills\/([^/]+)$/u;
const RE_AGENT_CONTENT = /^\/api\/agents\/([^/]+)$/u;
const RE_EXPORT = /^\/api\/export\/([^/]+)$/u;
const RE_TEMPLATE_DETAIL = /^\/api\/templates\/([^/]+)$/u;
const RE_TEMPLATE_INSTALL = /^\/api\/templates\/([^/]+)\/install$/u;

// Body size limits for readBody().
const BODY_LIMIT_DEFAULT = 65_536; // 64 KB — all mutating routes except /api/import
const BODY_LIMIT_IMPORT = 4 * 1024 * 1024; // 4 MB — /api/import carries a YAML bundle

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
 * projectDir; the same containment principle as assertSafePath (install/paths.ts)
 * applies but adapted for the absolute-path cross-project use case.
 */
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
  /** The tool's bundled pipeline catalog directory. Defaults to BUNDLED_PIPELINES_DIR. */
  bundledPipelinesDir?: string;
  /** Root directory containing skills/ and agents/ subdirs. Defaults to AGENT_FLOWS_SKILLS_DIR or ~/.claude. */
  skillsBase?: string;
  /**
   * Directory for the global template store. Defaults to `~/.agent-flows/templates/`.
   * Each template is one `<templateId>.yaml` bundle file (FR-001).
   */
  templatesBase?: string;
}

export interface ServeHandle {
  port: number;
  close(): Promise<void>;
}

// ── Handler context ────────────────────────────────────────────────────────────

interface HandlerCtx {
  pipelinesDir: string;
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
  /** Global template store directory (FR-001). */
  templatesBase: string;
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
  const bundledPipelinesDir = opts.bundledPipelinesDir ?? BUNDLED_PIPELINES_DIR;

  const skillsBase =
    opts.skillsBase ?? process.env.AGENT_FLOWS_SKILLS_DIR ?? join(homedir(), ".claude");

  const templatesBase =
    opts.templatesBase ??
    process.env.AGENT_FLOWS_TEMPLATES_DIR ??
    join(homedir(), ".agent-flows", "templates");

  // boundPort is updated once the OS assigns a port (important when port: 0).
  let boundPort = opts.port ?? 7411;

  // FR-004: tracks the last-logged source so we emit one log line per transition,
  // not one per request. null means no line has been emitted yet.
  let lastCanonSource: "bundled" | "project" | null = null;

  const server = nodeCreateServer((req, res) => {
    // FR-004: resolve the pipelines directory per-request so that a workflow
    // installed while the daemon is running is reflected on the very next request,
    // with no restart required. When an explicit pipelinesDir was passed (test/legacy
    // path), skip resolution and use it directly.
    let pipelinesDir: string;
    if (explicitPipelinesDir !== undefined) {
      pipelinesDir = explicitPipelinesDir;
    } else {
      const resolved = resolveCanonDir(projectDir);
      if (resolved.source !== lastCanonSource) {
        console.log(
          `agent-flows serve: pipelines from ${resolved.source} (${resolved.pipelinesDir})`
        );
        lastCanonSource = resolved.source;
      }
      pipelinesDir = resolved.pipelinesDir;
    }
    const root = dirname(pipelinesDir);

    void handleRequest(req, res, {
      pipelinesDir,
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
      templatesBase,
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
    server.listen(opts.port ?? 7411, "127.0.0.1", () => {
      const info = server.address() as AddressInfo;
      boundPort = info.port;
      server.off("error", onListenError);
      server.on("error", (err: Error) => {
        console.error(`agent-flows serve: server error: ${err.message}`);
      });
      resolve({
        port: info.port,
        close: () =>
          new Promise<void>((r, e) => {
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

/**
 * Resolve the daemon's listen port: `--port` wins, then `AGENT_FLOWS_PORT`,
 * then 7411. Reading the variable here makes README.md:84's long-standing claim
 * true and matches the MCP client, which already reads the same variable.
 *
 * A value that is not a usable TCP port exits 1 with an explanation rather than
 * reaching listen(): `parseInt("abc")` is NaN and `listen(NaN)` silently binds a
 * random ephemeral port, so the daemon would come up somewhere nobody is looking.
 */
export function resolvePort(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  io: CliIo = DEFAULT_CLI_IO
): number {
  const idx = argv.indexOf("--port");
  const flagValue = idx !== -1 && idx + 1 < argv.length ? argv[idx + 1] : undefined;
  const raw = flagValue ?? env.AGENT_FLOWS_PORT ?? "7411";
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    io.error(portInvalidMessage(raw));
    io.exit(1);
  }
  return port;
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

  // GET /ui-route.js — the page's hash router, kept as a real module file so it
  // can be unit-tested without a DOM (spec 034 D7/V2). Served from the same
  // directory as ui.html; no build step.
  if (method === "GET" && pathname === "/ui-route.js") {
    const routePath = join(dirname(ctx.uiPath), "ui-route.js");
    if (!existsSync(routePath)) {
      res.writeHead(503, { "Content-Type": "text/plain" });
      res.end("UI router absent: src/serve/ui-route.js is missing");
      return;
    }
    res.writeHead(200, {
      "Content-Type": "text/javascript; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    });
    res.end(readFileSync(routePath, "utf8"));
    return;
  }

  // GET /api/pipelines
  if (method === "GET" && pathname === "/api/pipelines") {
    let files: string[];
    try {
      files = listPipelines(ctx.pipelinesDir);
    } catch {
      files = [];
    }
    const pipelines: { id: string; description: string; path: string }[] = [];
    for (const filePath of files) {
      try {
        const loaded = loadPipeline(filePath);
        pipelines.push({
          id: loaded.def.id,
          description: loaded.def.description,
          path: relative(root, filePath),
        });
      } catch {
        // Silently omit files that fail to parse; they are visible as errors
        // on disk and will be flagged by `agent-flows canon:check`.
      }
    }
    json(res, 200, { pipelines });
    return;
  }

  // POST /api/pipelines — create a new pipeline in the project canon directory
  if (method === "POST" && pathname === "/api/pipelines") {
    const parsed = await readJsonBody(req, BODY_LIMIT_DEFAULT);
    if (!parsed.ok) {
      json(res, 400, { error: "Malformed JSON body" });
      return;
    }
    const { id, description } = parsed.value;
    if (typeof id !== "string" || !isSafeId(id)) {
      json(res, 400, {
        error:
          'Field "id" must be a non-empty lowercase alphanumeric+hyphen string (no dots or slashes)',
      });
      return;
    }
    // Refuse mutations against the bundled catalog — only project copies are writable.
    if (resolve(ctx.pipelinesDir) === resolve(ctx.bundledPipelinesDir)) {
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

  // GET /api/pipelines/:id
  // No isSafeId check here: findPipelineById scans loaded pipeline ids for an
  // exact match and never joins `id` into a filesystem path, so an unsafe id
  // simply fails to match and falls through to 404. Safe only because of that
  // — a future rewrite that resolves the id into a path directly must add
  // validation before doing so.
  const pipelineDetailMatch = RE_PIPELINE_DETAIL.exec(pathname);
  if (method === "GET" && pipelineDetailMatch) {
    const id = decodeURIComponent(pipelineDetailMatch[1]);
    const entry = findPipelineById(ctx.pipelinesDir, id);
    if (!entry) {
      json(res, 404, { error: `Pipeline "${id}" not found` });
      return;
    }
    const { def, prompts } = entry.loaded;
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
    if (!isSafeId(id)) {
      json(res, 400, { error: `Pipeline id "${id}" is invalid` });
      return;
    }
    // Refuse mutations against the bundled catalog.
    if (resolve(ctx.pipelinesDir) === resolve(ctx.bundledPipelinesDir)) {
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
    const entry = findPipelineById(ctx.pipelinesDir, id);
    if (!entry) {
      json(res, 404, { error: `Pipeline "${id}" not found` });
      return;
    }
    // Consume the (empty) body to satisfy HTTP spec — no useful payload expected.
    await readAndDiscardBody(req, BODY_LIMIT_DEFAULT);
    const body = readFileSync(entry.filePath, "utf8");
    const baseHash = createHash("sha256").update(body).digest("hex");
    const relPath = relative(root, entry.filePath);
    const sourceId = indexSource(ctx.db, root, relPath, "pipeline", baseHash);
    const draftId = openDraft(ctx.db, sourceId, body, baseHash);
    json(res, 200, { draftId, body, baseHash });
    return;
  }

  // PUT /api/drafts/:draftId
  const updateDraftMatch = RE_DRAFT_BY_ID.exec(pathname);
  if (method === "PUT" && updateDraftMatch) {
    const draftId = parseInt(updateDraftMatch[1], 10);
    const draft = getDraft(ctx.db, draftId);
    if (!draft) {
      json(res, 404, { error: `Draft ${draftId} not found` });
      return;
    }
    const parsed = await readJsonBody(req, BODY_LIMIT_DEFAULT);
    if (!parsed.ok) {
      json(res, 400, { error: "Malformed JSON body" });
      return;
    }
    const { body: newBody } = parsed.value;
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
    const draft = getDraft(ctx.db, draftId);
    if (!draft) {
      json(res, 404, { error: `Draft ${draftId} not found` });
      return;
    }
    await readAndDiscardBody(req, BODY_LIMIT_DEFAULT); // consume body
    // TODO(serve): switch to saveDraftAndRegenerate once another agent adds that export
    const result: SaveResult & { regenerated?: string[] } = saveDraft(ctx.db, draftId);
    if (result.ok) {
      json(res, 200, { ok: true, regenerated: result.regenerated ?? [] });
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
    const parsed = await readJsonBody(req, BODY_LIMIT_DEFAULT);
    if (!parsed.ok) {
      json(res, 400, { error: "Malformed JSON body" });
      return;
    }
    const { input, kind } = parsed.value as { input?: unknown; kind?: unknown };
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
    const parsed = await readJsonBody(req, BODY_LIMIT_DEFAULT);
    if (!parsed.ok) {
      json(res, 400, { error: "Malformed JSON body" });
      return;
    }
    const { pipeline, inputs, models, gateMode, artifactPath } = parsed.value as {
      pipeline?: unknown;
      inputs?: unknown;
      models?: unknown;
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

    // Resolve pipeline step defs for provenance recording (spec 029 FR-002) and
    // to get the declared inputs list for artifact resolution (spec 029 FR-003).
    // If the pipeline is not found (e.g. not yet written to disk), omit steps —
    // transportPerStep will be empty rather than wrong.
    const pipelineEntry = findPipelineById(ctx.pipelinesDir, pipeline);
    const pipelineDef = pipelineEntry?.loaded.def;

    // Extract explicit inputs early so the artifact check can skip inputs that
    // the operator already provided — those don't need to come from the artifact.
    const explicitInputs =
      typeof inputs === "object" && inputs !== null && !Array.isArray(inputs)
        ? (inputs as Record<string, unknown>)
        : {};

    // ── Artifact-path input resolution (spec 029 FR-003) ──────────────────────
    // When artifactPath is provided, inputs may be omitted; the artifact seeds
    // the run's inputs. If both are provided, artifact-derived values take
    // priority — the operator is being explicit about what to hand off.
    const artifactDerivedInputs: Record<string, unknown> = {};
    if (artifactPath !== undefined) {
      if (typeof artifactPath !== "string") {
        json(res, 400, { error: 'Field "artifactPath" must be a string' });
        return;
      }

      // Resolve and contain the path — absolute paths cross project boundaries
      // (allowed by design), relative paths must stay inside projectDir.
      const pathResult = resolveArtifactPath(ctx.projectDir, artifactPath, stateRootOf(ctx.state));
      if (!pathResult.ok) {
        json(res, 400, { error: pathResult.error });
        return;
      }

      // Load the artifact file.
      let artifactRaw: string;
      try {
        artifactRaw = readFileSync(pathResult.resolved, "utf8");
      } catch {
        json(res, 400, { error: `Artifact file not found: ${pathResult.resolved}` });
        return;
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
          json(res, 400, { error: "Artifact is not a valid JSON object" });
          return;
        }
        artifact = artifactParsed as Record<string, unknown>;
      } catch {
        json(res, 400, { error: "Artifact file contains invalid JSON" });
        return;
      }

      // Reject artifacts without a status field — not an artifact shape.
      const artifactStatus = artifact.status;
      if (typeof artifactStatus !== "string") {
        json(res, 400, { error: "Not a valid artifact: missing or non-string status field" });
        return;
      }

      // Reject in-flight artifacts — their content is incomplete (FR-003).
      if (artifactStatus === "running") {
        json(res, 400, {
          error: "Cannot use an artifact from a running stage — wait for it to settle first",
        });
        return;
      }

      // Reject unknown statuses — indicates a corrupt or incompatible artifact.
      const KNOWN_STATUSES = new Set(["succeeded", "awaiting_approval", "failed", "rejected"]);
      if (!KNOWN_STATUSES.has(artifactStatus)) {
        json(res, 400, {
          error: `Artifact has unknown status "${artifactStatus}" — not a recognisable terminal artifact`,
        });
        return;
      }

      // FR-004: log when crossing provider boundaries. Informational, not a warning —
      // this is the intended path for "continue on GPT when Claude is down".
      const artifactProvenance = artifact.provenance as Record<string, unknown> | undefined;
      const artifactProfileId =
        typeof artifactProvenance?.profileId === "string"
          ? artifactProvenance.profileId
          : undefined;
      let currentProfileId: string;
      try {
        currentProfileId = getActiveProfile().id;
      } catch {
        currentProfileId = "unknown";
      }
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
                artifactDerivedInputs[inputName] = renderSpecKitSpec(
                  obj as unknown as HardenedSpec
                );
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
                    nested === undefined
                      ? `key "${inputName}" is absent`
                      : `type "${typeof nested}"`;
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
        json(res, 400, { error: resolveError });
        return;
      }

      if (unresolved.length > 0) {
        json(res, 400, {
          error:
            `Cannot resolve required input(s) [${unresolved.join(", ")}] from artifact. ` +
            `Artifact carried fields: [${artifactFields.join(", ")}]. ` +
            `Known mappings: plan←artifact.spec (string), findings←artifact.result.findings (string).`,
        });
        return;
      }
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
    };

    // FR-006: when chaining from a parent artifact, write the new stage's artifact
    // into the parent run's directory so all stages in a chain accumulate there.
    // The chain dir is the directory that contains the source artifact file.
    let chainArtifactDir: string | undefined;
    if (artifactPath !== undefined && typeof artifactPath === "string") {
      const pathResult = resolveArtifactPath(ctx.projectDir, artifactPath, stateRootOf(ctx.state));
      if (pathResult.ok) {
        chainArtifactDir = dirname(pathResult.resolved);
      }
    }

    const result = await runService.start(pipeline, wfInput, {
      gateMode: gateMode ?? "manual",
      ...(pipelineEntry !== undefined ? { pipelineSteps: pipelineEntry.loaded.def.steps } : {}),
      ...(chainArtifactDir !== undefined ? { chainArtifactDir } : {}),
      ...(typeof artifactPath === "string" ? { artifactPath } : {}),
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
    const snapshot = runService.get(id);
    if (!snapshot) {
      json(res, 404, { error: `Run "${id}" not found` });
      return;
    }

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
    if (!runService.get(id)) {
      json(res, 404, { error: `Run "${id}" not found` });
      return;
    }
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
      json(res, 404, { error: `Run "${id}" not found` });
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
    if (!runService.get(id)) {
      json(res, 404, { error: `Run "${id}" not found` });
      return;
    }
    const location = runService.logLocation(id);
    let output: unknown;
    try {
      output =
        location === undefined
          ? undefined
          : readStepOutput(stepOutputFile(location.dir, location.pipelineId, stepId));
    } catch (err) {
      if (!(err instanceof RangeError)) throw err;
      json(res, 404, { error: `Run "${id}" not found` });
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
    // Follows the same isSafeId pattern used for DELETE /api/pipelines/:id and template routes.
    if (!isSafeId(id)) {
      json(res, 400, { error: `Run id "${id}" is invalid` });
      return;
    }
    const runDir = join(ctx.state.runsDir, id);
    if (!existsSync(join(runDir, "manifest.json"))) {
      json(res, 404, { error: `Run "${id}" not found` });
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
    const state = runService.get(id);
    if (!state) {
      json(res, 404, { error: `Run "${id}" not found` });
      return;
    }
    json(res, 200, state);
    return;
  }

  // POST /api/runs/:id/approve
  const approveMatch = RE_RUN_APPROVE.exec(pathname);
  if (method === "POST" && approveMatch) {
    const { runService } = ctx;
    if (!requireRunService(runService, res)) return;
    const id = decodeURIComponent(approveMatch[1]);
    const parsed = await readJsonBody(req, BODY_LIMIT_DEFAULT);
    if (!parsed.ok) {
      json(res, 400, { error: "Malformed JSON body" });
      return;
    }
    const { approved, reason } = parsed.value;
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
    const parsed = await readJsonBody(req, BODY_LIMIT_DEFAULT);
    if (!parsed.ok) {
      json(res, 400, { error: "Malformed JSON body" });
      return;
    }
    const { reason } = parsed.value;
    const reasonStr = typeof reason === "string" ? reason : undefined;
    const result = await runService.cancel(id, reasonStr);
    if (result === undefined) {
      json(res, 404, { error: `Run "${id}" not found` });
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
    const parsed = await readJsonBody(req, BODY_LIMIT_DEFAULT);
    if (!parsed.ok) {
      json(res, 400, { error: "Malformed JSON body" });
      return;
    }
    const { gateMessage, spec, pipelineId } = parsed.value as {
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

  // POST /api/install — install bundled workflows into the project directory
  if (method === "POST" && pathname === "/api/install") {
    const parsed = await readJsonBody(req, BODY_LIMIT_DEFAULT);
    if (!parsed.ok) {
      json(res, 400, { error: "Malformed JSON body" });
      return;
    }
    const { ids, overwrite } = parsed.value;
    if (
      !Array.isArray(ids) ||
      ids.length === 0 ||
      !(ids as unknown[]).every((i) => typeof i === "string")
    ) {
      json(res, 400, { error: 'Field "ids" must be a non-empty array of strings' });
      return;
    }
    for (const id of ids as string[]) {
      if (!isSafeId(id)) {
        json(res, 400, {
          error: `Invalid pipeline id "${id}": must be lowercase alphanumeric and hyphens only`,
        });
        return;
      }
    }
    const doOverwrite = overwrite === true;
    try {
      const report = installWorkflow(
        ids as string[],
        ctx.bundledPipelinesDir,
        ctx.projectDir,
        doOverwrite
      );
      json(res, 200, report);
    } catch (err) {
      json(res, 422, { error: safePath((err as Error).message, root) });
    }
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

    const isBundled = resolve(ctx.pipelinesDir) === resolve(ctx.bundledPipelinesDir);

    // spec 034 D6: the Settings view reports which provider profile is in force.
    // A profile that cannot be resolved is reported as "unknown" rather than
    // failing the whole environment response.
    let profile: string;
    try {
      profile = getActiveProfile().id;
    } catch {
      profile = "unknown";
    }

    json(res, 200, {
      projectDir: ctx.projectDir,
      stateDir: ctx.state.dir,
      runsDir: ctx.state.runsDir,
      dbPath: ctx.dbPath,
      pipelinesSource: isBundled ? "bundled" : "project",
      pipelinesDir: ctx.pipelinesDir,
      port: ctx.boundPort,
      profile,
      installed: listInstalled(ctx.projectDir),
      available: listAvailable(ctx.bundledPipelinesDir),
      skills,
      agents,
    });
    return;
  }

  // GET /api/skills/:name — return the content of one skill's SKILL.md
  const skillMatch = RE_SKILL_CONTENT.exec(pathname);
  if (method === "GET" && skillMatch) {
    handleNamedContent(res, ctx.skillsBase, "skill", decodeURIComponent(skillMatch[1]));
    return;
  }

  // GET /api/agents/:name — return the content of one agent's .md file
  const agentMatch = RE_AGENT_CONTENT.exec(pathname);
  if (method === "GET" && agentMatch) {
    handleNamedContent(res, ctx.skillsBase, "agent", decodeURIComponent(agentMatch[1]));
    return;
  }

  // GET /api/export/:id — export a pipeline and its full closure as a YAML bundle
  const exportMatch = RE_EXPORT.exec(pathname);
  if (method === "GET" && exportMatch) {
    const id = decodeURIComponent(exportMatch[1]);
    if (!isSafeId(id)) {
      json(res, 400, { error: `Pipeline id "${id}" is invalid` });
      return;
    }
    try {
      const bundle = exportBundle(id, ctx.pipelinesDir);
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
    const parsed = await readJsonBody(req, BODY_LIMIT_IMPORT);
    if (!parsed.ok) {
      json(res, 400, { error: "Malformed JSON body" });
      return;
    }
    const { bundle: bundleText, overwrite } = parsed.value;
    if (typeof bundleText !== "string") {
      json(res, 400, { error: 'Field "bundle" must be a string' });
      return;
    }
    const doOverwrite = overwrite === true;
    try {
      const bundle = parseBundle(bundleText);
      const report = importBundle(bundle, ctx.projectDir, doOverwrite);
      json(res, 200, report);
    } catch (err) {
      json(res, 422, { error: safePath((err as Error).message, root) });
    }
    return;
  }

  // ── Template routes (FR-002) ───────────────────────────────────────────────

  // GET /api/templates — list all templates in the global store
  if (method === "GET" && pathname === "/api/templates") {
    const templates: { templateId: string; sourcePipeline: string; exportedAt: string }[] = [];
    const errors: string[] = [];
    if (existsSync(ctx.templatesBase)) {
      for (const f of readdirSync(ctx.templatesBase).sort()) {
        if (!f.endsWith(".yaml") && !f.endsWith(".yml")) continue;
        const templateId = f.replace(/\.ya?ml$/u, "");
        const filePath = join(ctx.templatesBase, f);
        try {
          const bundle = parseBundle(readFileSync(filePath, "utf8"));
          templates.push({
            templateId,
            sourcePipeline: bundle.sourcePipeline,
            exportedAt: bundle.exportedAt,
          });
        } catch (err) {
          errors.push(`${f}: ${(err as Error).message}`);
        }
      }
    }
    json(res, 200, { templates, ...(errors.length > 0 ? { errors } : {}) });
    return;
  }

  // GET /api/templates/:id — get template details
  const templateDetailMatch = RE_TEMPLATE_DETAIL.exec(pathname);
  if (method === "GET" && templateDetailMatch) {
    const tId = decodeURIComponent(templateDetailMatch[1]);
    if (!isSafeId(tId)) {
      json(res, 400, { error: `Template id "${tId}" is invalid` });
      return;
    }
    try {
      assertSafePath(ctx.templatesBase, `${tId}.yaml`);
    } catch {
      json(res, 400, { error: `Template id "${tId}" would escape the templates directory` });
      return;
    }
    const templatePath = join(ctx.templatesBase, `${tId}.yaml`);
    if (!existsSync(templatePath)) {
      json(res, 404, { error: `Template "${tId}" not found` });
      return;
    }
    try {
      const bundle = parseBundle(readFileSync(templatePath, "utf8"));
      json(res, 200, {
        templateId: tId,
        sourcePipeline: bundle.sourcePipeline,
        exportedAt: bundle.exportedAt,
        files: bundle.files.map((f) => f.path),
      });
    } catch (err) {
      json(res, 422, { error: `Template "${tId}" is invalid: ${(err as Error).message}` });
    }
    return;
  }

  // DELETE /api/templates/:id
  if (method === "DELETE" && templateDetailMatch) {
    const tId = decodeURIComponent(templateDetailMatch[1]);
    if (!isSafeId(tId)) {
      json(res, 400, { error: `Template id "${tId}" is invalid` });
      return;
    }
    try {
      assertSafePath(ctx.templatesBase, `${tId}.yaml`);
    } catch {
      json(res, 400, { error: `Template id "${tId}" would escape the templates directory` });
      return;
    }
    await readAndDiscardBody(req, BODY_LIMIT_DEFAULT); // consume body
    const templatePath = join(ctx.templatesBase, `${tId}.yaml`);
    if (!existsSync(templatePath)) {
      json(res, 404, { error: `Template "${tId}" not found` });
      return;
    }
    rmSync(templatePath);
    json(res, 200, { ok: true, id: tId });
    return;
  }

  // POST /api/templates/:id/install — install a template into the project (FR-002)
  const templateInstallMatch = RE_TEMPLATE_INSTALL.exec(pathname);
  if (method === "POST" && templateInstallMatch) {
    const tId = decodeURIComponent(templateInstallMatch[1]);
    if (!isSafeId(tId)) {
      json(res, 400, { error: `Template id "${tId}" is invalid` });
      return;
    }
    try {
      assertSafePath(ctx.templatesBase, `${tId}.yaml`);
    } catch {
      json(res, 400, { error: `Template id "${tId}" would escape the templates directory` });
      return;
    }
    const templatePath = join(ctx.templatesBase, `${tId}.yaml`);
    if (!existsSync(templatePath)) {
      json(res, 404, { error: `Template "${tId}" not found` });
      return;
    }
    // Deliberately lenient: an unparseable body falls back to overwrite:false
    // rather than 400 — this route only ever reads one optional boolean field,
    // so readJsonBody's stricter "malformed body" rejection is not used here.
    const bodyRaw = await readBody(req, BODY_LIMIT_DEFAULT);
    const bodyParsed = parseJsonBody(bodyRaw);
    const doOverwrite = bodyParsed.ok && bodyParsed.value.overwrite === true;
    try {
      const bundle = parseBundle(readFileSync(templatePath, "utf8"));
      const report = importBundle(bundle, ctx.projectDir, doOverwrite);
      json(res, 200, report);
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

  const port = resolvePort(process.argv, process.env);
  const projectDir = resolveProjectDir();
  console.log(`agent-flows serve: running steps in ${projectDir}`);
  const { pipelinesDir, source: pipelinesSource } = resolveCanonDir(projectDir);
  console.log(`agent-flows serve: pipelines from ${pipelinesSource} (${pipelinesDir})`);

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

  const pipelineFiles = listPipelines(pipelinesDir);
  const loadedPipelines = pipelineFiles.map((f) => loadPipeline(f));
  const workflows: Record<string, unknown> = {};
  for (const loaded of loadedPipelines) {
    workflows[loaded.def.id] = buildPipelineWorkflow(loaded, {
      registry,
      store,
      profile,
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

  // FR-004: pipelinesDir is NOT passed to startServer so the HTTP layer resolves
  // the canon directory per-request.
  const handle = await startServer({ port, dbPath, runService, projectDir, state }).catch(
    (err: unknown) =>
      handleListenError(err, port, {
        error: (m) => {
          console.error(m);
        },
        exit: (code) => process.exit(code),
      })
  );
  /* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call */
  console.log(`agent-flows serve listening on http://127.0.0.1:${handle.port}`);
}
