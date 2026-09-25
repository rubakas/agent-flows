// Tests for the agent-flows serve HTTP server.
//
// Uses port 0 for ephemeral binding. Draft tests copy the real pipeline YAML
// and its prompts into a tmp directory so saveDraft can write without touching
// the working tree. The tmp root is resolved through realpathSync so that
// macOS's /tmp → /private/tmp symlink does not break loadPipeline's containment
// check.
//
// Host-header tests use node:http.request instead of fetch because the Fetch
// API treats "Host" as a forbidden header and silently ignores overrides.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import {
  createServer as createHttpServer,
  request as httpRequest,
  type IncomingMessage,
  type RequestOptions,
} from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";

import { Mastra } from "@mastra/core";
import { buildPipelineWorkflow } from "../bindings/mastra/build.js";
import { renderSpecKitSpec } from "../canon/exportSpec.js";
import { loadPipeline } from "../canon/load.js";
import { ModelRegistry } from "../canon/registry.js";
import { bundledPipelinesDir, packageRoot, packageVersion } from "../packageRoot.js";
import { probeDaemon, readDaemonRecord, type DaemonRecord } from "../runtime/daemonRecord.js";
import { resolveProjectState, type ProjectState } from "../runtime/projectState.js";
import { RunService, type JudgeDeps, type MastraLike } from "../runtime/runService.js";
import { clearRun, recordStep } from "../runtime/stepIntrospection.js";
import { appendStepLog, writeStepOutput } from "../runtime/stepLog.js";
import {
  startServer,
  readAgentFlowsConfig,
  legacyDbNotice,
  portInvalidMessage,
  type CliIo,
  handleListenError,
  portInUseMessage,
  resolvePortChoice,
  DEFAULT_PORT,
  AUTOSTART_ENV,
  type ServeHandle,
  CONTENT_CAP,
} from "./server.js";
import { stopProjectDaemon } from "./stop.js";
import type { ModelEntry, ProviderProfile } from "../canon/registry.js";
import type { TicketStore } from "../module/seams.js";
import type { AddressInfo } from "node:net";

const TEST_STATE_HOME = join(tmpdir(), `agent-flows-test-state-${process.pid}`);

/**
 * Machine-local state for a test server, rooted in a throwaway home so nothing
 * can fall through to the owner's real ~/.agent-flows (spec 032 V7).
 * `resolveProjectState` is pure, so the directory is created only if a test
 * actually writes into it.
 */
function makeState(projectDir: string, tmpDir?: string): ProjectState {
  const home = tmpDir !== undefined ? join(tmpDir, "state-home") : TEST_STATE_HOME;
  return resolveProjectState(projectDir, { AGENT_FLOWS_HOME: home });
}

// ── Mock RunService helpers (mirrors runService.test.ts pattern) ──────────────

type WatchCallback = (event: Record<string, unknown>) => void;

interface MockRun {
  readonly runId: string;
  readonly watchers: WatchCallback[];
  start(opts: unknown): Promise<Record<string, unknown>>;
  resume(params: unknown): Promise<Record<string, unknown>>;
  watch(cb: WatchCallback): () => void;
  emit(event: Record<string, unknown>): void;
}

function makeMockRun(
  runId: string,
  startResult: Record<string, unknown>,
  resumeResult: Record<string, unknown>
): MockRun {
  const watchers: WatchCallback[] = [];
  return {
    runId,
    watchers,
    start: async () => startResult,
    resume: async () => resumeResult,
    watch: (cb) => {
      watchers.push(cb);
      return () => {
        const i = watchers.indexOf(cb);
        if (i !== -1) watchers.splice(i, 1);
      };
    },
    emit: (event) => {
      for (const cb of watchers) cb(event);
    },
  };
}

function makeMastra(run: MockRun): MastraLike {
  return {
    getWorkflow: (_id) => ({
      createRun: async () =>
        run as unknown as Awaited<ReturnType<ReturnType<MastraLike["getWorkflow"]>["createRun"]>>,
    }),
  };
}

function successResult(): Record<string, unknown> {
  return { status: "success", result: { ticketId: 1 } };
}

// ── Shared helpers ────────────────────────────────────────────────────────────

const REAL_PIPELINES_DIR = join(process.cwd(), "pipelines");
const REAL_REPO_ROOT = process.cwd();

/** POST/PUT fetch with the correct content-type for mutation routes. */
async function mutate(
  port: number,
  method: string,
  path: string,
  body: unknown,
  extraHeaders: Record<string, string> = {}
): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { "content-type": "application/json", ...extraHeaders },
    body: JSON.stringify(body),
  });
}

/**
 * Send a raw HTTP GET with an explicit Host header value.
 * fetch treats "Host" as a forbidden header and silently ignores overrides;
 * node:http.request does not have this restriction.
 */
function rawGetWithHost(
  port: number,
  path: string,
  hostHeader: string
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const opts: RequestOptions = {
      hostname: "127.0.0.1",
      port,
      path,
      method: "GET",
      headers: { Host: hostHeader },
    };
    const req = httpRequest(opts, (res: IncomingMessage) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () =>
        resolve({
          status: res.statusCode ?? 0,
          body: Buffer.concat(chunks).toString("utf8"),
        })
      );
    });
    req.on("error", reject);
    req.end();
  });
}

/**
 * Send a raw HTTP POST with an explicit Host header value, for the mutating-route
 * preamble guards. fetch ignores Host overrides; node:http.request does not.
 */
function rawPostWithHost(
  port: number,
  path: string,
  hostHeader: string
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const opts: RequestOptions = {
      hostname: "127.0.0.1",
      port,
      path,
      method: "POST",
      headers: { Host: hostHeader, "content-type": "application/json", "content-length": 2 },
    };
    const req = httpRequest(opts, (res: IncomingMessage) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () =>
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") })
      );
    });
    req.on("error", reject);
    req.end("{}");
  });
}

// ── Pipeline listing & detail ─────────────────────────────────────────────────

describe("GET /api/pipelines — lists real pipelines", () => {
  let srv: ServeHandle;

  before(async () => {
    srv = await startServer({
      state: makeState(REAL_REPO_ROOT),
      port: 0,
      dbPath: ":memory:",
      pipelinesDir: REAL_PIPELINES_DIR,
    });
  });
  after(async () => srv.close());

  it("returns spec-creation in the list", async () => {
    const res = await fetch(`http://127.0.0.1:${srv.port}/api/pipelines`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      pipelines: { id: string; description: string; path: string }[];
    };
    const entry = body.pipelines.find((p) => p.id === "spec-creation");
    assert.ok(entry, "spec-creation must be listed");
    assert.ok(entry.description.length > 0, "description must be non-empty");
    assert.ok(entry.path.endsWith("spec-creation.yaml"), "path must end with yaml filename");
  });

  it("GET /api/pipelines/spec-creation returns def, prompts, levels, graph", async () => {
    const res = await fetch(`http://127.0.0.1:${srv.port}/api/pipelines/spec-creation`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      def: { id: string; steps: unknown[] };
      prompts: Record<string, string>;
      levels: string[][];
      graph: { nodes: unknown[]; edges: unknown[] };
    };
    assert.equal(body.def.id, "spec-creation");
    assert.ok(
      Array.isArray(body.def.steps) && body.def.steps.length > 0,
      "steps must be non-empty"
    );
    assert.ok(typeof body.prompts === "object", "prompts must be an object");
    assert.ok(Array.isArray(body.levels) && body.levels.length > 0, "levels must be non-empty");
    assert.ok(Array.isArray(body.graph.nodes) && body.graph.nodes.length > 0, "graph nodes");
    assert.ok(Array.isArray(body.graph.edges), "graph edges");
  });

  it("GET /api/pipelines/nonexistent → 404", async () => {
    const res = await fetch(`http://127.0.0.1:${srv.port}/api/pipelines/nonexistent`);
    assert.equal(res.status, 404);
    const body = (await res.json()) as { error: string };
    assert.ok(body.error.includes("nonexistent"), "error should name the unknown id");
  });
});

// ── Security: Host header rejection ──────────────────────────────────────────

describe("FR-019: Host header rejection", () => {
  let srv: ServeHandle;

  before(async () => {
    srv = await startServer({
      state: makeState(REAL_REPO_ROOT),
      port: 0,
      dbPath: ":memory:",
      pipelinesDir: REAL_PIPELINES_DIR,
    });
  });
  after(async () => srv.close());

  it("rejects a request with a non-loopback Host header → 403", async () => {
    // Use node:http.request — fetch treats Host as a forbidden header and
    // silently ignores any override, making it impossible to test DNS-rebinding
    // defence via fetch.
    const result = await rawGetWithHost(srv.port, "/api/pipelines", "evil.attacker.example");
    assert.equal(result.status, 403);
    const body = JSON.parse(result.body) as { error: string };
    assert.ok(body.error.toLowerCase().includes("host"), "error must mention Host");
  });

  it("accepts localhost as Host (via raw http.request)", async () => {
    const result = await rawGetWithHost(srv.port, "/api/pipelines", `localhost:${srv.port}`);
    assert.equal(result.status, 200);
  });
});

// ── Security: mutation guards ─────────────────────────────────────────────────

describe("FR-019: content-type and Origin guards on mutating requests", () => {
  let srv: ServeHandle;

  before(async () => {
    srv = await startServer({
      state: makeState(REAL_REPO_ROOT),
      port: 0,
      dbPath: ":memory:",
      pipelinesDir: REAL_PIPELINES_DIR,
    });
  });
  after(async () => srv.close());

  it("POST without application/json content-type → 403", async () => {
    const res = await fetch(`http://127.0.0.1:${srv.port}/api/runs`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "hello",
    });
    assert.equal(res.status, 403);
    const body = (await res.json()) as { error: string };
    assert.ok(body.error.toLowerCase().includes("content-type"), "error must mention content-type");
  });

  it("POST with cross-origin Origin header → 403", async () => {
    const res = await fetch(`http://127.0.0.1:${srv.port}/api/runs`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://evil.attacker.example",
      },
      body: JSON.stringify({ pipeline: "x", inputs: {} }),
    });
    assert.equal(res.status, 403);
    const body = (await res.json()) as { error: string };
    assert.ok(
      body.error.toLowerCase().includes("cross-origin") ||
        body.error.toLowerCase().includes("origin"),
      "error must mention Origin"
    );
  });

  it("POST with matching loopback Origin → passes origin check (proceeds to route logic)", async () => {
    // The request will fail for a different reason (no RunService), not origin rejection.
    const res = await mutate(
      srv.port,
      "POST",
      "/api/runs",
      { pipeline: "x", inputs: {} },
      { origin: `http://127.0.0.1:${srv.port}` }
    );
    // 503 because no RunService, NOT 403
    assert.notEqual(res.status, 403, "loopback origin must not be rejected");
  });
});

// ── 404s ──────────────────────────────────────────────────────────────────────

describe("404 responses for unknown ids", () => {
  let srv: ServeHandle;
  let tmpPipelinesDir: string;

  before(async () => {
    // A project-mode canon dir: REAL_PIPELINES_DIR is the bundled catalogue, and
    // the draft routes refuse writes there before an id is ever looked up.
    tmpPipelinesDir = realpathSync(mkdtempSync(join(tmpdir(), "agent-flows-404-")));
    srv = await startServer({
      state: makeState(REAL_REPO_ROOT),
      port: 0,
      dbPath: ":memory:",
      pipelinesDir: tmpPipelinesDir,
    });
  });
  after(async () => {
    await srv.close();
    rmSync(tmpPipelinesDir, { recursive: true, force: true });
  });

  it("PUT /api/drafts/99999 → 404 for unknown draft", async () => {
    const res = await mutate(srv.port, "PUT", "/api/drafts/99999", { body: "x" });
    assert.equal(res.status, 404);
    const body = (await res.json()) as { error: string };
    assert.ok(body.error.includes("99999"), "error must name the draft id");
  });

  it("GET /api/runs/nonexistent-id → 503 (no RunService in this instance)", async () => {
    const res = await fetch(`http://127.0.0.1:${srv.port}/api/runs/nonexistent-id`);
    assert.equal(res.status, 503);
  });

  it("unknown route → 404", async () => {
    const res = await fetch(`http://127.0.0.1:${srv.port}/api/unknown-route`);
    assert.equal(res.status, 404);
  });
});

// ── Draft round trip ──────────────────────────────────────────────────────────

describe("draft open → update → save round trip", () => {
  let srv: ServeHandle;
  let tmpRoot: string;
  let tmpPipelinesDir: string;

  before(async () => {
    // realpathSync resolves the macOS /tmp → /private/tmp symlink so that
    // loadPipeline's containment check (which uses realpathSync on prompt paths)
    // passes — without it, the root computed from the yaml path won't match
    // the realpath of the prompt files.
    tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), "agent-flows-serve-test-")));
    tmpPipelinesDir = join(tmpRoot, "pipelines");
    mkdirSync(tmpPipelinesDir);

    // Copy the pipeline YAML and all prompt files into the temp layout:
    //   <tmpRoot>/pipelines/spec-creation.yaml
    //   <tmpRoot>/prompts/*.md
    // loadPipeline derives its root as dirname(dirname(yamlPath)) = tmpRoot,
    // so "prompts/intake.md" resolves correctly under that root.
    for (const yml of ["spec-creation.yaml", "audit.yaml", "correct-plan.yaml"]) {
      writeFileSync(
        join(tmpPipelinesDir, yml),
        readFileSync(join(REAL_REPO_ROOT, "pipelines", yml), "utf8")
      );
    }
    cpSync(join(REAL_REPO_ROOT, "prompts"), join(tmpRoot, "prompts"), { recursive: true });

    srv = await startServer({
      state: makeState(REAL_REPO_ROOT),
      port: 0,
      dbPath: ":memory:",
      pipelinesDir: tmpPipelinesDir,
    });
  });

  after(async () => {
    await srv.close();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("open draft, update body, save → 200 ok", async () => {
    // Open draft
    const openRes = await mutate(srv.port, "POST", "/api/pipelines/spec-creation/drafts", {});
    assert.equal(openRes.status, 200, "open draft must succeed");
    const {
      draftId,
      body: originalBody,
      baseHash,
    } = (await openRes.json()) as {
      draftId: number;
      body: string;
      baseHash: string;
    };
    assert.ok(typeof draftId === "number", "draftId must be a number");
    assert.ok(typeof originalBody === "string" && originalBody.length > 0, "body must be a string");
    assert.ok(typeof baseHash === "string" && baseHash.length === 64, "baseHash must be sha256");

    // Update the draft body with the same valid YAML (no structural change).
    const updateRes = await mutate(srv.port, "PUT", `/api/drafts/${draftId}`, {
      body: originalBody,
    });
    assert.equal(updateRes.status, 200);
    const updateBody = (await updateRes.json()) as { ok: boolean };
    assert.equal(updateBody.ok, true);

    // Save — should succeed since the file has not changed since draft was opened.
    const saveRes = await mutate(srv.port, "POST", `/api/drafts/${draftId}/save`, {});
    assert.equal(saveRes.status, 200, "save must succeed when no conflict");
    const saveBody = (await saveRes.json()) as { ok: boolean };
    assert.equal(saveBody.ok, true);
  });

  it("save → 409 conflict when file changed since draft was opened", async () => {
    // Open a fresh draft.
    const openRes = await mutate(srv.port, "POST", "/api/pipelines/spec-creation/drafts", {});
    assert.equal(openRes.status, 200);
    const { draftId } = (await openRes.json()) as { draftId: number };

    // Simulate an external edit — write different content to the file on disk
    // after the draft was opened (changing its hash).
    const filePath = join(tmpPipelinesDir, "spec-creation.yaml");
    const existing = readFileSync(filePath, "utf8");
    writeFileSync(filePath, `${existing}\n# externally modified\n`);

    // Attempt to save — must be refused as a conflict.
    const saveRes = await mutate(srv.port, "POST", `/api/drafts/${draftId}/save`, {});
    assert.equal(saveRes.status, 409, "save must return 409 on conflict");
    const saveBody = (await saveRes.json()) as { ok: boolean; reason: string };
    assert.equal(saveBody.ok, false);
    assert.equal(saveBody.reason, "conflict");
  });
});

// ── POST /api/runs non-blocking + SSE step events ────────────────────────────

describe("POST /api/runs — non-blocking start + SSE step events", () => {
  let srv: ServeHandle;
  let mockRun: MockRun;
  let svcRunId: string;
  let runService: RunService;

  before(async () => {
    mockRun = makeMockRun("http-sse-run-01", successResult(), successResult());
    const service = new RunService(makeMastra(mockRun));
    runService = service;
    // Register the run via service.start() directly so it is in the registry
    // before the HTTP tests run. The run settles to success immediately (mock).
    const startResult = await service.start("spec-creation", { request: "test" });
    svcRunId = startResult.runId;

    srv = await startServer({
      state: makeState(REAL_REPO_ROOT),
      port: 0,
      dbPath: ":memory:",
      pipelinesDir: REAL_PIPELINES_DIR,
      runService: service,
    });
  });
  after(async () => srv.close());

  it("POST /api/runs returns { runId, status: 'running' } before run settles", async () => {
    // The mock run's start() resolves immediately, but service.start() is
    // non-blocking — it always returns { runId, status: 'running' } and lets
    // the run advance in the background.
    const res = await mutate(srv.port, "POST", "/api/runs", {
      pipeline: "spec-creation",
      inputs: { request: "test" },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { runId: string; status: string };
    assert.equal(
      body.status,
      "running",
      "POST /api/runs must return status 'running', not block for completion"
    );
    assert.ok(
      typeof body.runId === "string" && body.runId.length > 0,
      "runId must be present in response"
    );
  });

  it("POST /api/runs with an unknown provider → 400 naming the field", async () => {
    const res = await mutate(srv.port, "POST", "/api/runs", {
      pipeline: "spec-creation",
      inputs: { request: "test" },
      provider: "no-such-profile",
    });
    assert.equal(res.status, 400, "an unknown provider must fail at the boundary");
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /no-such-profile/);
  });

  // A run's inputs carry the change under review, which is the one body on this
  // daemon that is legitimately large: a 35-file pull request diff is ~77 KB and
  // a ~100k-line one is ~4.5 MB, while the 64 KB default refused both at the
  // boundary before the reviewer ever ran.
  it("POST /api/runs accepts a diff-sized body, and still refuses an absurd one", async () => {
    const bigDiff = await mutate(srv.port, "POST", "/api/runs", {
      pipeline: "no-such-pipeline",
      inputs: { plan: "d".repeat(6 * 1024 * 1024) },
    });
    assert.notEqual(
      bigDiff.status,
      413,
      "a 6 MB diff — larger than a 100k-line change — must reach the handler"
    );

    const absurd = await mutate(srv.port, "POST", "/api/runs", {
      pipeline: "no-such-pipeline",
      inputs: { plan: "d".repeat(80 * 1024 * 1024) },
    });
    assert.equal(absurd.status, 413, "the cap is raised, not removed");
  });

  it("POST /api/runs with a non-string provider → 400", async () => {
    const res = await mutate(srv.port, "POST", "/api/runs", {
      pipeline: "spec-creation",
      inputs: { request: "test" },
      provider: 7,
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /provider/);
  });

  it("POST /api/runs with a built-in provider reaches both the workflow input and the run options", async () => {
    // A 200 alone cannot tell a wired provider from one dropped between the
    // validation above and the two places it has to land (spec 039 review).
    const original = runService.start.bind(runService);
    let seen: { wfInput: Record<string, unknown>; providerId?: string } | undefined;
    runService.start = (pipelineId, wfInput, opts) => {
      seen = { wfInput, ...(opts?.provider ? { providerId: opts.provider.id } : {}) };
      return original(pipelineId, wfInput, opts);
    };

    let res: Response;
    try {
      res = await mutate(srv.port, "POST", "/api/runs", {
        pipeline: "spec-creation",
        inputs: { request: "test" },
        provider: "openai",
      });
    } finally {
      runService.start = original;
    }

    assert.equal(res.status, 200, "a known profile id must be accepted");
    assert.ok(seen, "the route must have started a run");
    assert.equal(
      seen.wfInput.provider,
      "openai",
      "the validated provider must reach the workflow context the steps resolve from"
    );
    assert.equal(
      seen.providerId,
      "openai",
      "the resolved profile must reach opts.provider, which provenance is written from"
    );
  });

  it("POST /api/runs cannot smuggle a provider through inputs", async () => {
    const original = runService.start.bind(runService);
    let started = false;
    runService.start = (pipelineId, wfInput, opts) => {
      started = true;
      return original(pipelineId, wfInput, opts);
    };

    let res: Response;
    try {
      res = await mutate(srv.port, "POST", "/api/runs", {
        pipeline: "spec-creation",
        inputs: { request: "test", provider: "local" },
      });
    } finally {
      runService.start = original;
    }

    assert.equal(res.status, 400, "a reserved key inside inputs must be refused at the boundary");
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /provider/, `the error must name the key: ${body.error}`);
    assert.equal(started, false, "the run must never reach the workflow");
  });

  it("POST /api/runs refuses an input the pipeline does not declare", async () => {
    const res = await mutate(srv.port, "POST", "/api/runs", {
      pipeline: "spec-creation",
      inputs: { request: "test", models: { intake: "haiku" } },
    });
    assert.equal(res.status, 400, "`models` inside inputs is the same bypass as `provider`");
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /models/);
  });

  it("SSE /api/runs/:id/events delivers step events for a running run", async () => {
    const res = await fetch(`http://127.0.0.1:${srv.port}/api/runs/${svcRunId}/events`);
    assert.equal(res.status, 200);

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    // Read the snapshot first — this also confirms the subscription is wired.
    const { value: snapVal } = await reader.read();
    const snapChunk = decoder.decode(snapVal);
    assert.ok(snapChunk.includes("event: snapshot"), "first chunk must be snapshot event");

    // Emit a step-start event on the mock run. The SSE subscription was
    // established when the GET /events request was processed (before snapshot
    // was sent), so the watcher fires synchronously here.
    mockRun.emit({ type: "workflow-step-start", payload: { id: "intake" } });

    // Read the step event delivered to the SSE stream.
    const { value: stepVal, done } = await reader.read();
    assert.equal(done, false, "stream must not be done after a step event");
    const stepChunk = decoder.decode(stepVal);
    assert.ok(
      stepChunk.includes("event: step"),
      `expected step event, got: ${JSON.stringify(stepChunk)}`
    );
    assert.ok(stepChunk.includes('"stepId":"intake"'), "step event must name the stepId");
    assert.ok(
      stepChunk.includes('"status":"started"'),
      "workflow-step-start must map to status 'started'"
    );

    await reader.cancel();
  });
});

// ── SSE: snapshot first + clean disconnect ────────────────────────────────────

describe("SSE /api/runs/:id/events delivers snapshot first", () => {
  let srv: ServeHandle;
  let runId: string;

  before(async () => {
    const mockRun = makeMockRun("sse-run-01", successResult(), successResult());
    const service = new RunService(makeMastra(mockRun));
    // Register the run so RunService.get() returns a snapshot.
    const startResult = await service.start("test-pipeline", { request: "test" });
    runId = startResult.runId;

    srv = await startServer({
      state: makeState(REAL_REPO_ROOT),
      port: 0,
      dbPath: ":memory:",
      pipelinesDir: REAL_PIPELINES_DIR,
      runService: service,
    });
  });
  after(async () => srv.close());

  it("returns text/event-stream and delivers snapshot as first event", async () => {
    const res = await fetch(`http://127.0.0.1:${srv.port}/api/runs/${runId}/events`);
    assert.equal(res.status, 200);
    assert.ok(
      res.headers.get("content-type")?.startsWith("text/event-stream"),
      "content-type must be text/event-stream"
    );

    // Read the first chunk — must contain the snapshot event.
    const reader = res.body!.getReader();
    const { value, done } = await reader.read();
    assert.equal(done, false, "stream must not be immediately done");
    const chunk = new TextDecoder().decode(value);
    assert.ok(
      chunk.startsWith("event: snapshot\n"),
      `first chunk must be snapshot event; got: ${JSON.stringify(chunk)}`
    );
    assert.ok(chunk.includes(`"runId":"${runId}"`), "snapshot must include runId");

    // Cancel the reader to disconnect. The server's 'close' event fires,
    // clearing the heartbeat interval and calling unsub() — must not throw.
    await reader.cancel();
  });

  it("GET /api/runs/nonexistent/events → 404", async () => {
    const res = await fetch(`http://127.0.0.1:${srv.port}/api/runs/no-such-run/events`);
    assert.equal(res.status, 404);
    const body = (await res.json()) as { error: string };
    assert.ok(body.error.includes("no-such-run"), "error must name the unknown run id");
  });
});

// ── GET /api/runs/:id on a suspended run includes gate payload ────────────────

describe("GET /api/runs/:id — suspended run includes gate payload", () => {
  let srv: ServeHandle;
  let runId: string;

  before(async () => {
    const suspendedStart = {
      status: "suspended",
      suspended: [["approve"]],
      steps: {
        approve: { suspendPayload: { message: "Approve this spec?", spec: { title: "T" } } },
      },
    };
    const mockRun = makeMockRun("get-gate-run-01", suspendedStart, successResult());
    const service = new RunService(makeMastra(mockRun));
    const startResult = await service.start("test-pipeline", { request: "test" });
    runId = startResult.runId;
    // Wait for the background run to settle at the gate before the test checks state.
    await service.waitForSettled(runId);

    srv = await startServer({
      state: makeState(REAL_REPO_ROOT),
      port: 0,
      dbPath: ":memory:",
      pipelinesDir: REAL_PIPELINES_DIR,
      runService: service,
    });
  });
  after(async () => srv.close());

  it("returns gateMessage and spec when the run is suspended at a gate", async () => {
    const res = await fetch(`http://127.0.0.1:${srv.port}/api/runs/${runId}`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { status: string; gateMessage?: string; spec?: unknown };
    assert.equal(body.status, "awaiting_approval");
    assert.ok(
      typeof body.gateMessage === "string" && body.gateMessage.length > 0,
      `gateMessage must be a non-empty string; got ${JSON.stringify(body.gateMessage)}`
    );
    assert.ok(
      body.spec !== undefined && body.spec !== null,
      `spec must be present in GET /api/runs/:id response; got ${JSON.stringify(body.spec)}`
    );
  });
});

// ── Step log: SSE channel, backfill route, output route (spec 036 D4/D6) ─────

describe("step log delivery (FR-006/FR-007/FR-008)", () => {
  let srv: ServeHandle;
  let runsDir: string;
  let liveRunId: string;
  const DISK_RUN = "disk-log-run";
  const NOLOG_RUN = "disk-nolog-run";

  /** A settled run as a previous daemon left it, with or without an events file. */
  function writeDiskRun(runId: string, withLog: boolean): void {
    const dir = join(runsDir, runId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "test-pipeline.json"),
      JSON.stringify({
        runId,
        pipelineId: "test-pipeline",
        status: "succeeded",
        steps: {},
        gateDecisions: [],
        provenance: {
          pipelineId: "test-pipeline",
          profileId: "anthropic",
          transportPerStep: {},
          startedAt: "2026-09-14T09:00:00.000Z",
          settledAt: "2026-09-14T09:01:00.000Z",
        },
      })
    );
    if (!withLog) return;
    const line = {
      seq: 1,
      at: "2026-09-14T09:00:30.000Z",
      runId,
      pipelineId: "test-pipeline",
      stepId: "one",
      kind: "message",
      role: "assistant",
      text: "from disk",
    };
    writeFileSync(join(dir, "test-pipeline.events.jsonl"), `${JSON.stringify(line)}\n`);
  }

  before(async () => {
    runsDir = mkdtempSync(join(tmpdir(), "af-serve-log-"));
    writeDiskRun(DISK_RUN, true);
    writeDiskRun(NOLOG_RUN, false);

    const mockRun = makeMockRun("serve-log-run", successResult(), successResult());
    // A run that never settles, so its log stays open for the whole suite.
    mockRun.start = () => new Promise<Record<string, unknown>>(() => undefined);
    const service = new RunService(makeMastra(mockRun), undefined, runsDir);
    const started = await service.start("test-pipeline", { request: "x" });
    liveRunId = started.runId;

    srv = await startServer({
      state: makeState(REAL_REPO_ROOT),
      port: 0,
      dbPath: ":memory:",
      pipelinesDir: REAL_PIPELINES_DIR,
      runService: service,
    });
  });
  after(async () => {
    await srv.close();
    rmSync(runsDir, { recursive: true, force: true });
  });

  it("SSE delivers a log event for a live run once the line is on disk", async () => {
    const res = await fetch(`http://127.0.0.1:${srv.port}/api/runs/${liveRunId}/events`);
    assert.equal(res.status, 200);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    const { value: snapshot } = await reader.read();
    assert.ok(decoder.decode(snapshot).includes("event: snapshot"));

    appendStepLog(liveRunId, "sse.step", { kind: "message", role: "assistant", text: "live line" });

    const { value, done } = await reader.read();
    assert.equal(done, false);
    const chunk = decoder.decode(value);
    assert.ok(chunk.startsWith("event: log\n"), `expected a log event; got: ${chunk}`);
    assert.ok(chunk.includes('"text":"live line"'));
    assert.ok(chunk.includes('"stepId":"sse.step"'));
    await reader.cancel();
  });

  it("GET /api/runs/:id/log returns NDJSON in seq order and honours after", async () => {
    appendStepLog(liveRunId, "one", { kind: "message", role: "assistant", text: "second" });
    appendStepLog(liveRunId, "one", { kind: "step.result", status: "succeeded", durationMs: 1 });

    const res = await fetch(`http://127.0.0.1:${srv.port}/api/runs/${liveRunId}/log`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "application/x-ndjson");
    const all = (await res.text())
      .split("\n")
      .filter((l) => l !== "")
      .map((l) => JSON.parse(l) as { seq: number; kind: string });
    assert.deepEqual(
      all.map((e) => e.seq),
      all.map((_e, i) => i + 1),
      "lines must arrive in seq order with no gaps"
    );
    assert.equal(all[all.length - 1].kind, "step.result");

    const afterRes = await fetch(
      `http://127.0.0.1:${srv.port}/api/runs/${liveRunId}/log?after=${all.length - 1}`
    );
    const tail = (await afterRes.text()).split("\n").filter((l) => l !== "");
    assert.equal(tail.length, 1, "after must return only the lines beyond the given seq");
  });

  it("filters to the kinds asked for, and rejects a malformed list (FR-lifecycle)", async () => {
    appendStepLog(liveRunId, "two", { kind: "step.start", model: "m", transport: "t" });
    appendStepLog(liveRunId, "two", { kind: "message", role: "assistant", text: "chatter" });
    appendStepLog(liveRunId, "two", { kind: "step.result", status: "succeeded", durationMs: 1 });

    const url = `http://127.0.0.1:${srv.port}/api/runs/${liveRunId}/log`;
    const res = await fetch(`${url}?kinds=step.start,step.result`);
    assert.equal(res.status, 200);
    const kinds = (await res.text())
      .split("\n")
      .filter((l) => l !== "")
      .map((l) => (JSON.parse(l) as { kind: string }).kind);
    assert.deepEqual(
      [...new Set(kinds)].sort(),
      ["step.result", "step.start"],
      "a kind outside the allowlist must not be on the wire at all"
    );
    assert.ok(kinds.length > 0, "the filter must not swallow the lines it was asked for");

    // The identity headers are what make one request enough for a poller.
    assert.equal(res.headers.get("x-run-status"), "running");
    assert.equal(res.headers.get("x-run-pipeline-id"), "test-pipeline");
    // The run's own highest seq, not the highest this filtered body carries:
    // without it a poller's cursor never clears the lines the filter dropped.
    const unfiltered = (await (await fetch(url)).text()).split("\n").filter((l) => l !== "");
    const lastSeq = (JSON.parse(unfiltered[unfiltered.length - 1]) as { seq: number }).seq;
    assert.ok(lastSeq > kinds.length, "the fixture must have lines the filter drops");
    assert.equal(Number(res.headers.get("x-run-max-seq")), lastSeq);
    assert.ok(
      decodeURIComponent(res.headers.get("x-run-events-path") ?? "").endsWith(
        "test-pipeline.events.jsonl"
      )
    );

    const bad = await fetch(`${url}?kinds=step.start,../../etc`);
    assert.equal(bad.status, 400);
    assert.deepEqual(await bad.json(), { error: "invalid kinds" });
  });

  it("rejects a non-numeric after with 400 and an unknown run with 404", async () => {
    const logUrl = `http://127.0.0.1:${srv.port}/api/runs/${liveRunId}/log`;
    const bad = await fetch(`${logUrl}?after=abc`);
    assert.equal(bad.status, 400);
    assert.deepEqual(await bad.json(), { error: "invalid after" });

    const negative = await fetch(`${logUrl}?after=-1`);
    assert.equal(negative.status, 400);

    const missing = await fetch(`http://127.0.0.1:${srv.port}/api/runs/no-such-run/log`);
    assert.equal(missing.status, 404);
  });

  it("returns an empty 200 body for a run recorded before the log existed", async () => {
    const res = await fetch(`http://127.0.0.1:${srv.port}/api/runs/${NOLOG_RUN}/log`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "");
  });

  it("serves a disk run's log from the runs dir this server never ran (FR-007)", async () => {
    const res = await fetch(`http://127.0.0.1:${srv.port}/api/runs/${DISK_RUN}/log`);
    assert.equal(res.status, 200);
    const lines = (await res.text()).split("\n").filter((l) => l !== "");
    assert.equal(lines.length, 1);
    assert.deepEqual(JSON.parse(lines[0]), {
      seq: 1,
      at: "2026-09-14T09:00:30.000Z",
      runId: DISK_RUN,
      pipelineId: "test-pipeline",
      stepId: "one",
      kind: "message",
      role: "assistant",
      text: "from disk",
    });
  });

  it("serves a step's persisted output, 404 when absent and 400 when the id is unsafe", async () => {
    writeStepOutput(liveRunId, "survey", { kind: "json", output: { findings: [] } });

    const res = await fetch(
      `http://127.0.0.1:${srv.port}/api/runs/${liveRunId}/steps/survey/output`
    );
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      runId: liveRunId,
      pipelineId: "test-pipeline",
      stepId: "survey",
      kind: "json",
      output: { findings: [] },
    });

    const absent = await fetch(
      `http://127.0.0.1:${srv.port}/api/runs/${liveRunId}/steps/never-ran/output`
    );
    assert.equal(absent.status, 404);

    const unsafe = await fetch(
      `http://127.0.0.1:${srv.port}/api/runs/${liveRunId}/steps/bad!id/output`
    );
    assert.equal(unsafe.status, 400);

    const unknownRun = await fetch(
      `http://127.0.0.1:${srv.port}/api/runs/no-such-run/steps/survey/output`
    );
    assert.equal(unknownRun.status, 404);
  });
});

// ── Audit: the pipelineId of a persisted artifact is untrusted path input ─────
//
// Both log routes join it into a file name. An artifact on disk is written by
// whatever produced it, so a traversing id must not make the daemon read a file
// outside the run directory.

describe("step log routes — a traversing pipelineId in an artifact", () => {
  let srv: ServeHandle;
  let root: string;
  let runsDir: string;
  const EVIL_RUN = "evil-pipeline-run";
  const PLANTED = "planted-outside-the-run-dir";

  before(async () => {
    root = mkdtempSync(join(tmpdir(), "af-serve-evil-"));
    runsDir = join(root, "state", "runs");
    mkdirSync(join(runsDir, EVIL_RUN), { recursive: true });
    writeFileSync(
      join(runsDir, EVIL_RUN, "artifact.json"),
      JSON.stringify({
        runId: EVIL_RUN,
        pipelineId: "../../x",
        status: "succeeded",
        steps: {},
        gateDecisions: [],
      })
    );
    // What `../../x` resolves to from the run directory: two levels up is
    // `root/state`, where these stand in for a file the daemon must not serve.
    writeFileSync(
      join(root, "state", "x.events.jsonl"),
      `${JSON.stringify({ seq: 1, kind: "message", role: "assistant", text: PLANTED })}\n`
    );
    mkdirSync(join(root, "state", "x.outputs"), { recursive: true });
    writeFileSync(
      join(root, "state", "x.outputs", "one.json"),
      JSON.stringify({ output: PLANTED })
    );

    const service = new RunService(
      makeMastra(makeMockRun("evil-log-run", successResult(), successResult())),
      undefined,
      runsDir
    );
    srv = await startServer({
      state: makeState(REAL_REPO_ROOT),
      port: 0,
      dbPath: ":memory:",
      pipelinesDir: REAL_PIPELINES_DIR,
      runService: service,
    });
  });
  after(async () => {
    await srv.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("404s both log routes and reads nothing outside the run dir", async () => {
    const log = await fetch(`http://127.0.0.1:${srv.port}/api/runs/${EVIL_RUN}/log`);
    assert.equal(log.status, 404);
    assert.equal((await log.text()).includes(PLANTED), false, "no file outside the run dir");

    const output = await fetch(
      `http://127.0.0.1:${srv.port}/api/runs/${EVIL_RUN}/steps/one/output`
    );
    assert.equal(output.status, 404);
    assert.equal((await output.text()).includes(PLANTED), false, "no file outside the run dir");
  });
});

// ── SSE snapshot carries gate payload for clients connecting after suspension ─
// This is the bug scenario: a client connects AFTER the gate was raised.
// The live gate.raised event has already fired; only the snapshot can deliver it.

describe("SSE /api/runs/:id/events — snapshot carries gate payload for late-connecting clients", () => {
  let srv: ServeHandle;
  let runId: string;

  before(async () => {
    const suspendedStart = {
      status: "suspended",
      suspended: [["approve"]],
      steps: {
        approve: { suspendPayload: { message: "Approve this spec?", spec: { title: "T" } } },
      },
    };
    const mockRun = makeMockRun("sse-gate-run-01", suspendedStart, successResult());
    const service = new RunService(makeMastra(mockRun));
    const startResult = await service.start("test-pipeline", { request: "test" });
    runId = startResult.runId;
    // Gate fires here — waitForSettled resolves once the run is suspended.
    // The client will connect AFTER this point, so the live event has already fired.
    await service.waitForSettled(runId);

    srv = await startServer({
      state: makeState(REAL_REPO_ROOT),
      port: 0,
      dbPath: ":memory:",
      pipelinesDir: REAL_PIPELINES_DIR,
      runService: service,
    });
  });
  after(async () => srv.close());

  it("snapshot event for a client connecting after the gate fires includes gateMessage and spec", async () => {
    // The gate was raised BEFORE this SSE connection is opened — this is the bug.
    // A client that connects now can only learn the pending gate via the snapshot.
    const res = await fetch(`http://127.0.0.1:${srv.port}/api/runs/${runId}/events`);
    assert.equal(res.status, 200);
    const reader = res.body!.getReader();
    const { value, done } = await reader.read();
    assert.equal(done, false, "stream must not be immediately done");
    const chunk = new TextDecoder().decode(value);
    assert.ok(
      chunk.startsWith("event: snapshot\n"),
      `first chunk must be the snapshot event; got: ${JSON.stringify(chunk)}`
    );
    const dataLine = chunk.split("\n").find((l) => l.startsWith("data: "));
    assert.ok(dataLine, "snapshot chunk must contain a data: line");
    const snapshot = JSON.parse(dataLine.slice(6)) as {
      status: string;
      gateMessage?: string;
      spec?: unknown;
    };
    assert.equal(snapshot.status, "awaiting_approval");
    assert.ok(
      typeof snapshot.gateMessage === "string" && snapshot.gateMessage.length > 0,
      `snapshot.gateMessage must be a non-empty string; got ${JSON.stringify(snapshot.gateMessage)}`
    );
    assert.ok(
      snapshot.spec !== undefined && snapshot.spec !== null,
      `snapshot.spec must be present; got ${JSON.stringify(snapshot.spec)}`
    );
    await reader.cancel();
  });
});

// ── GET /api/runs — FR-002 list route ────────────────────────────────────────

describe("GET /api/runs — FR-002: list route returns summaries in creation order", () => {
  let srv: ServeHandle;
  let service: ReturnType<typeof makeRunService>;

  function makeRunService() {
    const runA = makeMockRun("list-run-a", successResult(), successResult());
    const runB = makeMockRun("list-run-b", successResult(), successResult());
    let callCount = 0;
    const mastra: MastraLike = {
      getWorkflow: (_id) => ({
        createRun: async () => {
          callCount++;
          return (callCount === 1 ? runA : runB) as unknown as Awaited<
            ReturnType<ReturnType<MastraLike["getWorkflow"]>["createRun"]>
          >;
        },
      }),
    };
    return new RunService(mastra);
  }

  before(async () => {
    service = makeRunService();
    await service.start("pipeline-a", {});
    await service.start("pipeline-b", {});
    srv = await startServer({
      state: makeState(REAL_REPO_ROOT),
      port: 0,
      dbPath: ":memory:",
      pipelinesDir: REAL_PIPELINES_DIR,
      runService: service,
    });
  });
  after(async () => srv.close());

  it("returns { runs: [...] } with two summaries in creation order", async () => {
    const res = await fetch(`http://127.0.0.1:${srv.port}/api/runs`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      runs: { runId: string; pipelineId: string; status: string; createdAt: string }[];
    };
    assert.ok(Array.isArray(body.runs), "body.runs must be an array");
    assert.equal(body.runs.length, 2, "must return exactly two runs");
    assert.equal(body.runs[0].pipelineId, "pipeline-a", "first run must be pipeline-a");
    assert.equal(body.runs[1].pipelineId, "pipeline-b", "second run must be pipeline-b");
  });

  it("each summary has exactly {runId, pipelineId, status, createdAt} and no extra fields", async () => {
    const res = await fetch(`http://127.0.0.1:${srv.port}/api/runs`);
    const body = (await res.json()) as { runs: Record<string, unknown>[] };
    const summary = body.runs[0];
    assert.ok("runId" in summary, "must have runId");
    assert.ok("pipelineId" in summary, "must have pipelineId");
    assert.ok("status" in summary, "must have status");
    assert.ok("createdAt" in summary, "must have createdAt");
    assert.ok(!("result" in summary), "must NOT have result");
    assert.ok(!("spec" in summary), "must NOT have spec");
    assert.ok(!("gateMessage" in summary), "must NOT have gateMessage");
    assert.ok(!("steps" in summary), "must NOT have steps");
    const cat = summary.createdAt;
    assert.ok(
      typeof cat === "string" && !isNaN(Date.parse(cat)),
      "createdAt must be a valid ISO date string"
    );
  });

  it("GET /api/runs → 503 when no RunService", async () => {
    const noSvcSrv = await startServer({
      state: makeState(REAL_REPO_ROOT),
      port: 0,
      dbPath: ":memory:",
      pipelinesDir: REAL_PIPELINES_DIR,
    });
    try {
      const res = await fetch(`http://127.0.0.1:${noSvcSrv.port}/api/runs`);
      assert.equal(res.status, 503);
    } finally {
      await noSvcSrv.close();
    }
  });
});

// ── GET /api/runs/:id — steps field present (FR-006) ─────────────────────────

describe("GET /api/runs/:id — steps field always present in GetResult (FR-006)", () => {
  let srv: ServeHandle;
  let runId: string;
  let mockRun: MockRun;

  before(async () => {
    mockRun = makeMockRun("steps-test-run", successResult(), successResult());
    const svc = new RunService(makeMastra(mockRun));
    const start = await svc.start("test-pipeline", {});
    runId = start.runId;
    srv = await startServer({
      state: makeState(REAL_REPO_ROOT),
      port: 0,
      dbPath: ":memory:",
      pipelinesDir: REAL_PIPELINES_DIR,
      runService: svc,
    });
  });
  after(async () => srv.close());

  it("GET /api/runs/:id includes steps:{} before any events", async () => {
    const res = await fetch(`http://127.0.0.1:${srv.port}/api/runs/${runId}`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { steps: unknown };
    assert.ok(typeof body.steps === "object" && body.steps !== null, "steps must be an object");
  });

  it("SSE step event carries outputExcerpt when step has output", async () => {
    const svc2 = new RunService(
      makeMastra(makeMockRun("sse-out-run", successResult(), successResult()))
    );
    const s = await svc2.start("p", {});
    const srv2 = await startServer({
      state: makeState(REAL_REPO_ROOT),
      port: 0,
      dbPath: ":memory:",
      pipelinesDir: REAL_PIPELINES_DIR,
      runService: svc2,
    });
    try {
      const sseRes = await fetch(`http://127.0.0.1:${srv2.port}/api/runs/${s.runId}/events`);
      const reader = sseRes.body!.getReader();
      // consume snapshot
      await reader.read();

      // Emit a step-result with output via the raw run mock.
      // The run registered by svc2.start() is under the hood; find it via subscribe watcher.
      // We need a handle to the mock run — use a local reference.
      const localRun = makeMockRun("sse-out-run-2", successResult(), successResult());
      const svc3 = new RunService(makeMastra(localRun));
      const s3 = await svc3.start("p", {});
      await reader.cancel();
      await srv2.close();

      const srv3 = await startServer({
        state: makeState(REAL_REPO_ROOT),
        port: 0,
        dbPath: ":memory:",
        pipelinesDir: REAL_PIPELINES_DIR,
        runService: svc3,
      });
      try {
        const sseRes3 = await fetch(`http://127.0.0.1:${srv3.port}/api/runs/${s3.runId}/events`);
        const reader3 = sseRes3.body!.getReader();
        const dec3 = new TextDecoder();
        await reader3.read(); // snapshot

        localRun.emit({
          type: "workflow-step-result",
          // Wrap under the step id key as Mastra does: output = { ...ctx, q: ownOutput }.
          payload: {
            id: "q",
            stepCallId: "c",
            status: "success",
            output: { request: "r", q: { msg: "hello" } },
          },
        });

        const { value: stepVal } = await reader3.read();
        const chunk = dec3.decode(stepVal);
        assert.ok(
          chunk.includes("outputExcerpt"),
          `SSE step event must carry outputExcerpt; got: ${chunk}`
        );
        assert.ok(chunk.includes("hello"), "outputExcerpt must contain step output text");
        await reader3.cancel();
      } finally {
        await srv3.close();
      }
    } catch (e) {
      await srv2.close();
      throw e;
    }
  });
});

// ── POST /api/pipelines — create ─────────────────────────────────────────────

describe("POST /api/pipelines — create new pipeline", () => {
  let srv: ServeHandle;
  let tmpRoot: string;
  let tmpPipelinesDir: string;

  before(async () => {
    tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), "agent-flows-create-test-")));
    tmpPipelinesDir = join(tmpRoot, "pipelines");
    mkdirSync(tmpPipelinesDir);
    srv = await startServer({
      state: makeState(REAL_REPO_ROOT),
      port: 0,
      dbPath: ":memory:",
      pipelinesDir: tmpPipelinesDir,
      bundledPipelinesDir: REAL_PIPELINES_DIR,
    });
  });
  after(async () => {
    await srv.close();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("creates a valid pipeline that is immediately loadable (201)", async () => {
    const res = await mutate(srv.port, "POST", "/api/pipelines", {
      id: "my-new-pipeline",
      description: "A test pipeline",
    });
    assert.equal(res.status, 201, `expected 201, got ${res.status}`);
    const body = (await res.json()) as { id: string; path: string };
    assert.equal(body.id, "my-new-pipeline");
    assert.ok(body.path.endsWith("my-new-pipeline.yaml"), "path must end with yaml filename");

    // Verify the file is on disk and loadable via GET.
    const getRes = await fetch(`http://127.0.0.1:${srv.port}/api/pipelines/my-new-pipeline`);
    assert.equal(getRes.status, 200, "created pipeline must be immediately loadable via GET");
    const getBody = (await getRes.json()) as { def: { id: string } };
    assert.equal(getBody.def.id, "my-new-pipeline");
  });

  it("rejects a duplicate id → 409", async () => {
    await mutate(srv.port, "POST", "/api/pipelines", { id: "dup-pipeline" });
    const res = await mutate(srv.port, "POST", "/api/pipelines", { id: "dup-pipeline" });
    assert.equal(res.status, 409);
    const body = (await res.json()) as { error: string };
    assert.ok(body.error.includes("dup-pipeline"), "error must name the duplicate id");
  });

  it("rejects a path-traversal id with ../ → 400", async () => {
    const res = await mutate(srv.port, "POST", "/api/pipelines", { id: "../evil" });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.ok(body.error.toLowerCase().includes("id"), "error must mention id");
  });

  it("rejects an id with uppercase letters → 400", async () => {
    const res = await mutate(srv.port, "POST", "/api/pipelines", { id: "Bad-Id" });
    assert.equal(res.status, 400);
  });

  it("POST without application/json content-type → 403", async () => {
    const res = await fetch(`http://127.0.0.1:${srv.port}/api/pipelines`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ id: "x" }),
    });
    assert.equal(res.status, 403);
  });
});

// ── Preamble guards on a mutating route (relocated from the deleted route test) ─
// The content-type/Origin/Host guards run before any route handler and are
// shared by every mutating route. POST /api/pipelines is the surviving carrier
// of that regression coverage (spec 037 D1).

describe("preamble guards run before the POST /api/pipelines handler", () => {
  let srv: ServeHandle;
  let tmpRoot: string;

  before(async () => {
    tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), "agent-flows-preamble-test-")));
    mkdirSync(join(tmpRoot, "pipelines"));
    srv = await startServer({
      state: makeState(REAL_REPO_ROOT),
      port: 0,
      dbPath: ":memory:",
      pipelinesDir: join(tmpRoot, "pipelines"),
      bundledPipelinesDir: REAL_PIPELINES_DIR,
    });
  });
  after(async () => {
    await srv.close();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("bad Host header → 403, never reaches the handler", async () => {
    const result = await rawPostWithHost(srv.port, "/api/pipelines", "evil.attacker.example");
    assert.equal(result.status, 403);
  });

  it("bad content-type → 403, never reaches the handler", async () => {
    const res = await fetch(`http://127.0.0.1:${srv.port}/api/pipelines`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "{}",
    });
    assert.equal(res.status, 403);
  });

  it("cross-origin Origin header → 403, never reaches the handler", async () => {
    const res = await mutate(
      srv.port,
      "POST",
      "/api/pipelines",
      {},
      { origin: "http://evil.attacker.example" }
    );
    assert.equal(res.status, 403);
  });

  it("(sanity) matching loopback Origin passes the preamble and reaches the route logic", async () => {
    const res = await mutate(
      srv.port,
      "POST",
      "/api/pipelines",
      {},
      { origin: `http://127.0.0.1:${srv.port}` }
    );
    // The body has no "id" — a 400 from the route itself, NOT a 403 preamble refusal.
    assert.equal(res.status, 400);
  });
});

// ── DELETE /api/pipelines/:id ─────────────────────────────────────────────────

describe("DELETE /api/pipelines/:id — remove project pipeline", () => {
  let srv: ServeHandle;
  let tmpRoot: string;
  let tmpPipelinesDir: string;

  before(async () => {
    tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), "agent-flows-delete-test-")));
    tmpPipelinesDir = join(tmpRoot, "pipelines");
    mkdirSync(tmpPipelinesDir);

    // Write a standalone pipeline and a parent that nests it.
    writeFileSync(
      join(tmpPipelinesDir, "leaf.yaml"),
      "id: leaf\nversion: 1\ndescription: leaf\ninputs: []\nsteps:\n  - id: start\n    kind: gate\n"
    );
    writeFileSync(
      join(tmpPipelinesDir, "parent.yaml"),
      "id: parent\nversion: 1\ndescription: parent\ninputs: []\nsteps:\n  - id: child\n    kind: pipeline\n    pipeline: leaf\n"
    );
    writeFileSync(
      join(tmpPipelinesDir, "orphan.yaml"),
      "id: orphan\nversion: 1\ndescription: orphan\ninputs: []\nsteps:\n  - id: start\n    kind: gate\n"
    );

    srv = await startServer({
      state: makeState(REAL_REPO_ROOT),
      port: 0,
      dbPath: ":memory:",
      pipelinesDir: tmpPipelinesDir,
      bundledPipelinesDir: REAL_PIPELINES_DIR,
    });
  });
  after(async () => {
    await srv.close();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("deletes an unreferenced project pipeline → 200", async () => {
    const res = await mutate(srv.port, "DELETE", "/api/pipelines/orphan", {});
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; id: string };
    assert.equal(body.ok, true);
    assert.equal(body.id, "orphan");
    assert.equal(existsSync(join(tmpPipelinesDir, "orphan.yaml")), false, "file must be removed");
  });

  it("refuses to delete a pipeline nested by another → 409 naming the dependant", async () => {
    const res = await mutate(srv.port, "DELETE", "/api/pipelines/leaf", {});
    assert.equal(res.status, 409);
    const body = (await res.json()) as { error: string };
    assert.ok(body.error.includes("parent"), "error must name the dependant pipeline");
    assert.ok(
      existsSync(join(tmpPipelinesDir, "leaf.yaml")),
      "leaf must still exist after refusal"
    );
  });

  it("refuses to delete from the bundled catalog → 403", async () => {
    const bundledSrv = await startServer({
      state: makeState(REAL_REPO_ROOT),
      port: 0,
      dbPath: ":memory:",
      pipelinesDir: REAL_PIPELINES_DIR,
      bundledPipelinesDir: REAL_PIPELINES_DIR,
    });
    try {
      const res = await mutate(bundledSrv.port, "DELETE", "/api/pipelines/spec-creation", {});
      assert.equal(res.status, 403);
      const body = (await res.json()) as { error: string };
      assert.ok(body.error.toLowerCase().includes("bundled"), "error must mention bundled");
    } finally {
      await bundledSrv.close();
    }
  });

  it("DELETE without application/json content-type → 403", async () => {
    const res = await fetch(`http://127.0.0.1:${srv.port}/api/pipelines/leaf`, {
      method: "DELETE",
      headers: { "content-type": "text/plain" },
    });
    assert.equal(res.status, 403);
  });
});

describe("GET / — security headers", () => {
  let srv: ServeHandle;

  before(async () => {
    srv = await startServer({
      state: makeState(REAL_REPO_ROOT),
      port: 0,
      dbPath: ":memory:",
      pipelinesDir: REAL_PIPELINES_DIR,
      bundledPipelinesDir: REAL_PIPELINES_DIR,
    });
  });
  after(async () => srv.close());

  it("responds with Content-Security-Policy, X-Content-Type-Options, and Referrer-Policy", async () => {
    const res = await fetch(`http://127.0.0.1:${srv.port}/`);
    assert.equal(res.status, 200);
    const csp = res.headers.get("content-security-policy");
    assert.ok(csp && csp.length > 0, "must have Content-Security-Policy header");
    assert.ok(csp.includes("default-src"), "CSP must include default-src");
    assert.ok(csp.includes("frame-ancestors"), "CSP must include frame-ancestors");
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.equal(res.headers.get("referrer-policy"), "no-referrer");
  });
});

// ── GET /api/environment ──────────────────────────────────────────────────────

describe("GET /api/environment — launch-point description", () => {
  let bundledSrv: ServeHandle;
  let projectSrv: ServeHandle;
  let tmpProjectDir: string;

  before(async () => {
    tmpProjectDir = realpathSync(mkdtempSync(join(tmpdir(), "agent-flows-env-test-")));

    // Server A: pipelinesDir === bundledPipelinesDir → source = "bundled"
    bundledSrv = await startServer({
      state: makeState(tmpProjectDir),
      port: 0,
      dbPath: ":memory:",
      pipelinesDir: REAL_PIPELINES_DIR,
      bundledPipelinesDir: REAL_PIPELINES_DIR,
      projectDir: tmpProjectDir,
    });

    // Server B: pipelinesDir is a project copy → source = "project"
    const projectPipelinesDir = join(tmpProjectDir, ".agent-flows", "pipelines");
    mkdirSync(projectPipelinesDir, { recursive: true });
    writeFileSync(
      join(projectPipelinesDir, "custom.yaml"),
      "id: custom\nversion: 1\ndescription: custom\ninputs: []\nsteps:\n  - id: s\n    kind: gate\n"
    );
    projectSrv = await startServer({
      state: makeState(tmpProjectDir),
      port: 0,
      dbPath: ":memory:",
      pipelinesDir: projectPipelinesDir,
      bundledPipelinesDir: REAL_PIPELINES_DIR,
      projectDir: tmpProjectDir,
    });
  });
  after(async () => {
    await bundledSrv.close();
    await projectSrv.close();
    rmSync(tmpProjectDir, { recursive: true, force: true });
  });

  it("reports pipelinesSource=bundled, and no installed/available split (038 FR-028)", async () => {
    const res = await fetch(`http://127.0.0.1:${bundledSrv.port}/api/environment`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown> & {
      pipelinesSource: string;
      skills: string[];
      agents: string[];
    };
    assert.equal(body.pipelinesSource, "bundled");
    // The installed/available split died with the install verb: every bundled
    // workflow is present in every project now (D13).
    assert.ok(!("installed" in body), "installed must be gone from /api/environment");
    assert.ok(!("available" in body), "available must be gone from /api/environment");
    assert.ok(Array.isArray(body.skills), "skills must be an array");
    assert.ok(Array.isArray(body.agents), "agents must be an array");
    for (const skill of body.skills) {
      assert.equal(typeof skill, "string", "each skill must be a string name — no file contents");
    }
  });

  it("reports pipelinesSource=project for a project write target", async () => {
    const res = await fetch(`http://127.0.0.1:${projectSrv.port}/api/environment`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { pipelinesSource: string };
    assert.equal(body.pipelinesSource, "project");
  });

  it("bad Host header → 403", async () => {
    const result = await rawGetWithHost(
      bundledSrv.port,
      "/api/environment",
      "evil.attacker.example"
    );
    assert.equal(result.status, 403);
  });
});

// ── GET /api/skills/:name and GET /api/agents/:name ───────────────────────────

describe("GET /api/skills/:name and GET /api/agents/:name — content endpoints", () => {
  let srv: ServeHandle;
  let tmpRoot: string;

  before(async () => {
    tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), "agent-flows-content-test-")));
    const skillsDir = join(tmpRoot, "skills");
    const agentsDir = join(tmpRoot, "agents");

    mkdirSync(join(skillsDir, "my-skill"), { recursive: true });
    writeFileSync(join(skillsDir, "my-skill", "SKILL.md"), "# My Skill\nThis skill does things.\n");

    // A large skill used to test truncation: CONTENT_CAP + 100 bytes of content
    mkdirSync(join(skillsDir, "big-skill"), { recursive: true });
    writeFileSync(join(skillsDir, "big-skill", "SKILL.md"), "x".repeat(CONTENT_CAP + 100));

    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(join(agentsDir, "my-agent.md"), "# My Agent\nThis agent does things.\n");

    srv = await startServer({
      state: makeState(REAL_REPO_ROOT),
      port: 0,
      dbPath: ":memory:",
      pipelinesDir: REAL_PIPELINES_DIR,
      skillsBase: tmpRoot,
    });
  });

  after(async () => {
    await srv.close();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("fetching an existing skill returns its content (200)", async () => {
    const res = await fetch(`http://127.0.0.1:${srv.port}/api/skills/my-skill`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      kind: string;
      name: string;
      filePath: string;
      content: string;
      truncated: boolean;
    };
    assert.equal(body.kind, "skill");
    assert.equal(body.name, "my-skill");
    assert.ok(body.content.includes("My Skill"), "content must include skill text");
    assert.equal(body.truncated, false);
    assert.ok(
      typeof body.filePath === "string" && body.filePath.length > 0,
      "filePath must be present"
    );
  });

  it("fetching an existing agent returns its content (200)", async () => {
    const res = await fetch(`http://127.0.0.1:${srv.port}/api/agents/my-agent`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      kind: string;
      name: string;
      filePath: string;
      content: string;
      truncated: boolean;
    };
    assert.equal(body.kind, "agent");
    assert.equal(body.name, "my-agent");
    assert.ok(body.content.includes("My Agent"), "content must include agent text");
    assert.equal(body.truncated, false);
    assert.ok(
      typeof body.filePath === "string" && body.filePath.length > 0,
      "filePath must be present"
    );
  });

  it("a traversal name (encoded slash) is rejected with 400", async () => {
    // encodeURIComponent("../evil") → "..%2Fevil"; the %2F is preserved in the path
    // segment and decoded server-side, revealing the slash which isSafeName rejects.
    const res1 = await fetch(
      `http://127.0.0.1:${srv.port}/api/skills/${encodeURIComponent("../evil")}`
    );
    assert.equal(res1.status, 400, "skill traversal must be rejected");
    const body1 = (await res1.json()) as { error: string };
    assert.ok(body1.error.length > 0, "error message must be non-empty");

    const res2 = await fetch(
      `http://127.0.0.1:${srv.port}/api/agents/${encodeURIComponent("../evil")}`
    );
    assert.equal(res2.status, 400, "agent traversal must be rejected");
  });

  it("an unknown skill returns 404 with the name in the error", async () => {
    const res = await fetch(`http://127.0.0.1:${srv.port}/api/skills/nonexistent`);
    assert.equal(res.status, 404);
    const body = (await res.json()) as { error: string };
    assert.ok(body.error.includes("nonexistent"), "error must name the unknown skill");
  });

  it("an unknown agent returns 404 with the name in the error", async () => {
    const res = await fetch(`http://127.0.0.1:${srv.port}/api/agents/nonexistent`);
    assert.equal(res.status, 404);
    const body = (await res.json()) as { error: string };
    assert.ok(body.error.includes("nonexistent"), "error must name the unknown agent");
  });

  it("content is truncated and truncated=true when file exceeds CONTENT_CAP", async () => {
    const res = await fetch(`http://127.0.0.1:${srv.port}/api/skills/big-skill`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { content: string; truncated: boolean };
    assert.equal(body.truncated, true, "truncated must be true for oversized file");
    assert.equal(body.content.length, CONTENT_CAP, "content must be exactly CONTENT_CAP bytes");
  });
});

// ── GET /api/export/:id and POST /api/import ──────────────────────────────────

describe("GET /api/export/:id — export workflow bundle", () => {
  let srv: ServeHandle;

  before(async () => {
    srv = await startServer({
      state: makeState(REAL_REPO_ROOT),
      port: 0,
      dbPath: ":memory:",
      pipelinesDir: REAL_PIPELINES_DIR,
    });
  });
  after(async () => srv.close());

  it("returns 200 with application/x-yaml content for a known pipeline", async () => {
    const res = await fetch(`http://127.0.0.1:${srv.port}/api/export/investigate`);
    assert.equal(res.status, 200);
    const ct = res.headers.get("content-type") ?? "";
    assert.ok(
      ct.startsWith("application/x-yaml"),
      `content-type must be application/x-yaml; got ${ct}`
    );
    const body = await res.text();
    assert.ok(body.includes("bundleVersion"), "bundle must contain bundleVersion field");
    assert.ok(body.includes("sourcePipeline"), "bundle must contain sourcePipeline field");
    assert.ok(body.includes("investigate"), "bundle must reference the pipeline id");
  });

  it("returns Content-Disposition attachment header for browser download", async () => {
    const res = await fetch(`http://127.0.0.1:${srv.port}/api/export/investigate`);
    assert.equal(res.status, 200);
    const cd = res.headers.get("content-disposition") ?? "";
    assert.ok(
      cd.includes("attachment") && cd.includes("investigate.agent-flows-bundle.yaml"),
      `Content-Disposition must be attachment with filename; got: "${cd}"`
    );
  });

  it("returns 422 for a non-existent pipeline id", async () => {
    const res = await fetch(`http://127.0.0.1:${srv.port}/api/export/nonexistent-pipeline`);
    assert.equal(res.status, 422);
    const body = (await res.json()) as { error: string };
    assert.ok(body.error.length > 0, "error must be non-empty");
  });

  it("returns 400 for an unsafe pipeline id", async () => {
    const res = await fetch(`http://127.0.0.1:${srv.port}/api/export/..%2Fevil`);
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.ok(body.error.length > 0, "error must be non-empty");
  });
});

// Every case here names target: "repo" deliberately. The route defaults to the
// machine-wide user library (FR-027), and a test that took the default would
// read and write the owner's real ~/.agent-flows/workflows. The default target
// is covered in importTarget.test.ts, which pins AGENT_FLOWS_HOME.
describe("POST /api/import — import workflow bundle", () => {
  let srv: ServeHandle;
  let tmpProjectDir: string;

  before(async () => {
    tmpProjectDir = realpathSync(mkdtempSync(join(tmpdir(), "agent-flows-import-http-test-")));
    srv = await startServer({
      state: makeState(tmpProjectDir),
      port: 0,
      dbPath: ":memory:",
      pipelinesDir: REAL_PIPELINES_DIR,
      projectDir: tmpProjectDir,
    });
  });
  after(async () => {
    await srv.close();
    rmSync(tmpProjectDir, { recursive: true, force: true });
  });

  it("imports a valid bundle and returns written/skipped report", async () => {
    // Export investigate from the server itself, then post it back as import.
    const exportRes = await fetch(`http://127.0.0.1:${srv.port}/api/export/investigate`);
    assert.equal(exportRes.status, 200, "export must succeed before import test");
    const bundleText = await exportRes.text();

    const importRes = await mutate(srv.port, "POST", "/api/import", {
      bundle: bundleText,
      overwrite: false,
      target: "repo",
    });
    assert.equal(importRes.status, 200);
    const body = (await importRes.json()) as { written: string[]; skipped: string[] };
    assert.ok(Array.isArray(body.written), "written must be an array");
    assert.ok(Array.isArray(body.skipped), "skipped must be an array");
    assert.ok(body.written.length > 0, "at least one file must be written");
  });

  it("skips files on second import of the same bundle", async () => {
    const exportRes = await fetch(`http://127.0.0.1:${srv.port}/api/export/investigate`);
    const bundleText = await exportRes.text();

    // Second import — files already exist from the previous test.
    const importRes = await mutate(srv.port, "POST", "/api/import", {
      bundle: bundleText,
      overwrite: false,
      target: "repo",
    });
    assert.equal(importRes.status, 200);
    const body = (await importRes.json()) as { written: string[]; skipped: string[] };
    assert.equal(body.written.length, 0, "second import must write nothing");
    assert.ok(body.skipped.length > 0, "second import must report skips");
  });

  it("rejects a bundle with a traversal path and returns 422", async () => {
    const maliciousBundle =
      "bundleVersion: 1\nsourcePipeline: evil\nexportedAt: 2026-01-01T00:00:00.000Z\n" +
      'files:\n  - path: "../evil.txt"\n    content: "# bad"\n';

    const res = await mutate(srv.port, "POST", "/api/import", {
      bundle: maliciousBundle,
      target: "repo",
    });
    assert.equal(res.status, 422);
    const body = (await res.json()) as { error: string };
    assert.ok(body.error.length > 0, "error must be non-empty");
  });

  it("rejects an invalid bundle and returns 422", async () => {
    const res = await mutate(srv.port, "POST", "/api/import", {
      bundle: "this is not a valid bundle yaml",
    });
    assert.equal(res.status, 422);
    const body = (await res.json()) as { error: string };
    assert.ok(body.error.length > 0, "error message must be non-empty");
  });

  it("returns 400 when bundle field is missing", async () => {
    const res = await mutate(srv.port, "POST", "/api/import", { overwrite: false });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.ok(body.error.includes("bundle"), "error must mention the missing field");
  });
});

// ── FR-012: POST /api/gate-judge — judge-as-a-service ──────────────────────────

const gateJudgeStubEntry: ModelEntry = {
  id: "stub-model",
  transport: "cli",
  cli: { bin: "claude" },
};
const gateJudgeStubRegistry = new ModelRegistry([gateJudgeStubEntry]);
const gateJudgeStubProfile: ProviderProfile = {
  id: "stub",
  roles: { reasoner: "stub-model", worker: "stub-model", scout: "stub-model" },
};

function makeGateJudgeDeps(verdictJson: string): JudgeDeps {
  return {
    runner: async (_entry, _prompt) => verdictJson,
    registry: gateJudgeStubRegistry,
    profile: gateJudgeStubProfile,
    projectDir: process.cwd(),
    judgePrompt: "Gate judge prompt.",
  };
}

function makeMastraStubForGateJudge(): MastraLike {
  const dummyRun = {
    runId: "stub-run",
    watchers: [] as ((e: Record<string, unknown>) => void)[],
    start: async () => ({ status: "success", result: {} }),
    resume: async () => ({ status: "success", result: {} }),
    watch: (_cb: (e: Record<string, unknown>) => void) => () => undefined,
    emit: (_e: Record<string, unknown>) => undefined,
  };
  return {
    getWorkflow: (_id) => ({
      createRun: async () =>
        dummyRun as unknown as Awaited<
          ReturnType<ReturnType<MastraLike["getWorkflow"]>["createRun"]>
        >,
    }),
  };
}

describe("POST /api/gate-judge — FR-012 judge-as-a-service", () => {
  let srv: ServeHandle;

  before(async () => {
    const mastra = makeMastraStubForGateJudge();
    const judgeDeps = makeGateJudgeDeps('{"verdict":"approve","reason":"Looks good."}');
    const runService = new RunService(mastra, judgeDeps);
    srv = await startServer({
      state: makeState(REAL_REPO_ROOT),
      port: 0,
      dbPath: ":memory:",
      runService,
    });
  });

  after(async () => {
    await srv.close();
  });

  it("valid body → 200 { verdict, reason } from the stubbed judge", async () => {
    const res = await mutate(srv.port, "POST", "/api/gate-judge", {
      gateMessage: "Approve this change?",
      pipelineId: "test-pipeline",
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.verdict, "approve");
    assert.equal(body.reason, "Looks good.");
  });

  it("judge failure → 502 { error }", async () => {
    const mastra = makeMastraStubForGateJudge();
    // Return malformed verdict twice → judge failure
    const failDeps: JudgeDeps = {
      runner: async () => "not json",
      registry: gateJudgeStubRegistry,
      profile: gateJudgeStubProfile,
      projectDir: process.cwd(),
      judgePrompt: "Gate judge prompt.",
    };
    const failService = new RunService(mastra, failDeps);
    const failSrv = await startServer({
      state: makeState(REAL_REPO_ROOT),
      port: 0,
      dbPath: ":memory:",
      runService: failService,
    });
    try {
      const res = await mutate(failSrv.port, "POST", "/api/gate-judge", {
        gateMessage: "Approve this?",
      });
      assert.equal(res.status, 502);
      const body = (await res.json()) as Record<string, unknown>;
      assert.ok(typeof body.error === "string" && body.error.length > 0, "502 must include error");
    } finally {
      await failSrv.close();
    }
  });

  it("missing gateMessage → 400", async () => {
    const res = await mutate(srv.port, "POST", "/api/gate-judge", { spec: { foo: 1 } });
    assert.equal(res.status, 400);
    const body = (await res.json()) as Record<string, unknown>;
    assert.ok(
      typeof body.error === "string" && body.error.includes("gateMessage"),
      `error must mention gateMessage; got: ${JSON.stringify(body.error)}`
    );
  });

  it("malformed JSON body → 400", async () => {
    const res = await fetch(`http://127.0.0.1:${srv.port}/api/gate-judge`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{bad json",
    });
    assert.equal(res.status, 400);
  });

  it("no RunService → 503", async () => {
    const noSrv = await startServer({
      state: makeState(REAL_REPO_ROOT),
      port: 0,
      dbPath: ":memory:",
    });
    try {
      const res = await mutate(noSrv.port, "POST", "/api/gate-judge", {
        gateMessage: "Approve?",
      });
      assert.equal(res.status, 503);
    } finally {
      await noSrv.close();
    }
  });

  it("optional fields (spec, pipelineId) are accepted without error", async () => {
    const res = await mutate(srv.port, "POST", "/api/gate-judge", {
      gateMessage: "Gate check",
      spec: { title: "My spec", acceptanceCriteria: ["AC-1"] },
      pipelineId: "ship",
    });
    assert.equal(res.status, 200);
  });
});

// ── FR-003: readAgentFlowsConfig — all four paths ─────────────────────────────
// Testing the extracted function directly is faster (no port, no server boot)
// and reaches paths the server harness cannot (absent file, malformed JSON).

describe("readAgentFlowsConfig (FR-003)", () => {
  it("returns undefined when the config file is absent", () => {
    const projectDir = realpathSync(mkdtempSync(join(tmpdir(), "agent-flows-cfg-")));
    try {
      assert.strictEqual(readAgentFlowsConfig(projectDir), undefined);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("returns the checkCommand string when the file is valid", () => {
    const projectDir = realpathSync(mkdtempSync(join(tmpdir(), "agent-flows-cfg-")));
    try {
      mkdirSync(join(projectDir, ".agent-flows"), { recursive: true });
      writeFileSync(
        join(projectDir, ".agent-flows", "config.json"),
        JSON.stringify({ checkCommand: "pnpm check" })
      );
      assert.strictEqual(readAgentFlowsConfig(projectDir), "pnpm check");
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("throws naming the file when JSON is malformed", () => {
    const projectDir = realpathSync(mkdtempSync(join(tmpdir(), "agent-flows-cfg-")));
    try {
      mkdirSync(join(projectDir, ".agent-flows"), { recursive: true });
      writeFileSync(join(projectDir, ".agent-flows", "config.json"), "{bad json");
      assert.throws(
        () => readAgentFlowsConfig(projectDir),
        (err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          assert.ok(msg.includes("config.json"), `error must name the file; got: ${msg}`);
          return true;
        }
      );
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("throws naming the file and key when checkCommand is the wrong type, without the value", () => {
    // FR-003: wrong-typed key is malformed config — a silent fallback would hide a
    // misconfigured project. The error must name the key and typeof, NOT the raw value.
    const projectDir = realpathSync(mkdtempSync(join(tmpdir(), "agent-flows-cfg-")));
    try {
      mkdirSync(join(projectDir, ".agent-flows"), { recursive: true });
      writeFileSync(
        join(projectDir, ".agent-flows", "config.json"),
        JSON.stringify({ checkCommand: 42 })
      );
      assert.throws(
        () => readAgentFlowsConfig(projectDir),
        (err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          assert.ok(msg.includes("config.json"), `error must name the config file; got: ${msg}`);
          assert.ok(msg.includes("checkCommand"), `error must name the offending key; got: ${msg}`);
          // The message legitimately embeds the config path, and mkdtemp's random
          // suffix can itself contain "42" — mask the known dir so the value check
          // tests the message, not the luck of the draw.
          const withoutDir = msg.replaceAll(projectDir, "<projectDir>");
          assert.ok(
            !withoutDir.includes("42"),
            `error must not include the value; got: ${withoutDir}`
          );
          return true;
        }
      );
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});

// ── Path traversal guard: all id-bearing routes reject hostile ids ────────────

describe("path traversal guard — id-bearing routes reject hostile ids (FR-002/FR-006)", () => {
  let srv: ServeHandle;
  let tmpDir: string;
  let projectDir: string;

  before(async () => {
    tmpDir = realpathSync(mkdtempSync(join(tmpdir(), "agent-flows-traversal-")));
    projectDir = join(tmpDir, "project");
    mkdirSync(projectDir, { recursive: true });
    srv = await startServer({
      state: makeState(projectDir),
      port: 0,
      dbPath: ":memory:",
      pipelinesDir: REAL_PIPELINES_DIR,
      bundledPipelinesDir: REAL_PIPELINES_DIR,
      projectDir,
    });
  });
  after(async () => {
    await srv.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // Hostile id values (decoded form); they will be percent-encoded before
  // insertion into the URL path so the URL parser does not normalize them away.
  const HOSTILE_IDS = [
    "../x",
    "..%2Fx",
    "%2e%2e%2fx",
    "/etc/passwd",
    "a/b",
    "a".repeat(101), // exceeds the isSafeId length limit
  ];

  for (const id of HOSTILE_IDS) {
    const seg = encodeURIComponent(id);

    it(`DELETE /api/pipelines/${id} → 400`, async () => {
      const res = await mutate(srv.port, "DELETE", `/api/pipelines/${seg}`, {});
      assert.equal(res.status, 400, `DELETE /api/pipelines/${id} must be rejected with 400`);
    });
  }
});

// ── FR-003/FR-004/FR-006: run observability wired in served UI ────────────────
// This test fails if the Active Runs UI is removed from ui.html, preventing a
// repeat of the spec-022 regression where the rewrite silently dropped the
// run-observability feature added in spec-020.

describe("GET / — run observability wired in served HTML (FR-003/FR-004/FR-006)", () => {
  let srv: ServeHandle;

  before(async () => {
    srv = await startServer({
      state: makeState(REAL_REPO_ROOT),
      port: 0,
      dbPath: ":memory:",
      pipelinesDir: REAL_PIPELINES_DIR,
    });
  });
  after(async () => srv.close());

  it("served HTML references /api/runs for the run list (loadRuns)", async () => {
    const res = await fetch(`http://127.0.0.1:${srv.port}/`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(
      html.includes("/api/runs"),
      'served HTML must contain "/api/runs" — run list fetch wiring is missing'
    );
    assert.ok(
      html.includes("loadRuns"),
      'served HTML must contain "loadRuns" — run list function is missing'
    );
    assert.ok(
      html.includes('id="view-runs"'),
      'served HTML must contain the "view-runs" container — the runs view is missing'
    );
  });

  it("served HTML references /events SSE endpoint for live run attachment (FR-004)", async () => {
    const res = await fetch(`http://127.0.0.1:${srv.port}/`);
    const html = await res.text();
    assert.ok(
      html.includes("/events"),
      'served HTML must reference the SSE "/events" path — live run attachment is missing'
    );
    assert.ok(
      html.includes("openRunView"),
      'served HTML must contain "openRunView" — live run attachment is missing'
    );
  });

  it("served HTML wires approve/reject for suspended runs (FR-006)", async () => {
    const res = await fetch(`http://127.0.0.1:${srv.port}/`);
    const html = await res.text();
    assert.ok(
      html.includes("/approve"),
      'served HTML must reference "/approve" endpoint — gate approval wiring is missing'
    );
    assert.ok(
      html.includes("gateMessage"),
      'served HTML must reference "gateMessage" — suspended gate display is missing'
    );
  });

  it("UI uses awaiting_approval status string, not suspended", async () => {
    const res = await fetch(`http://127.0.0.1:${srv.port}/`);
    const html = await res.text();
    // FR-005: the old "suspended" status string must not appear in the UI logic.
    // The CSS class and JS comparisons must use "awaiting_approval".
    assert.ok(
      html.includes("awaiting_approval"),
      'served HTML must use "awaiting_approval" status string (FR-005)'
    );
    assert.ok(
      !html.includes('"suspended"'),
      'served HTML must not compare against "suspended" status string (FR-005)'
    );
    assert.ok(
      !html.includes('=== "success"'),
      'served HTML must not compare against "success" status string (FR-005); use "succeeded"'
    );
  });
});

// ── Spec 033 D6: run details on the route and in the served page ─────────────

describe("GET /api/runs/:id — invocation and step introspection (FR-016/FR-017)", () => {
  let srv: ServeHandle;
  let runId: string;

  before(async () => {
    const mockRun = makeMockRun("details-run-01", successResult(), successResult());
    const svc = new RunService(makeMastra(mockRun));
    const start = await svc.start(
      "test-pipeline",
      { request: "fix the auth bug" },
      { gateMode: "auto" }
    );
    runId = start.runId;
    // Stand in for an executing step: buildLlmStep's own recording call is
    // covered by runService.test.ts; this test owns the route contract.
    recordStep(runId, "investigate.survey", {
      prompt: "Survey this: fix the auth bug",
      model: "sonnet (cli:claude)",
    });
    recordStep(runId, "develop.check", { command: "echo hello" });
    srv = await startServer({
      state: makeState(REAL_REPO_ROOT),
      port: 0,
      dbPath: ":memory:",
      pipelinesDir: REAL_PIPELINES_DIR,
      runService: svc,
    });
  });
  after(async () => {
    clearRun(runId);
    await srv.close();
  });

  it("returns the invocation and per-step prompt/model/command", async () => {
    const res = await fetch(`http://127.0.0.1:${srv.port}/api/runs/${runId}`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      invocation?: { pipeline?: string; inputs?: Record<string, unknown>; gateMode?: string };
      steps: Record<string, { prompt?: string; model?: string; command?: string }>;
    };
    assert.equal(body.invocation?.pipeline, "test-pipeline", "invocation must reach the route");
    assert.deepEqual(body.invocation?.inputs, { request: "fix the auth bug" });
    assert.equal(body.invocation?.gateMode, "auto");
    assert.equal(body.steps["investigate.survey"]?.prompt, "Survey this: fix the auth bug");
    assert.equal(body.steps["investigate.survey"]?.model, "sonnet (cli:claude)");
    assert.equal(body.steps["develop.check"]?.command, "echo hello");
  });

  it("GET /api/runs summaries stay light — no invocation or step data", async () => {
    const res = await fetch(`http://127.0.0.1:${srv.port}/api/runs`);
    const body = (await res.json()) as { runs: Record<string, unknown>[] };
    const summary = body.runs.find((r) => r.runId === runId);
    assert.ok(summary !== undefined, "the run must appear in the list");
    assert.equal(summary.invocation, undefined, "summaries must not carry the invocation");
    assert.equal(summary.steps, undefined, "summaries must not carry step state");
  });
});

describe("GET / — run details panel wired in served HTML (FR-019/FR-020/FR-021)", () => {
  let srv: ServeHandle;
  let html: string;
  let tables: string;

  before(async () => {
    srv = await startServer({
      state: makeState(REAL_REPO_ROOT),
      port: 0,
      dbPath: ":memory:",
      pipelinesDir: REAL_PIPELINES_DIR,
    });
    html = await (await fetch(`http://127.0.0.1:${srv.port}/`)).text();
    // The row markup moved into the served ui-tables.js module (spec 037
    // FR-008); the page is what wires the rows it renders.
    tables = await (await fetch(`http://127.0.0.1:${srv.port}/ui-tables.js`)).text();
  });
  after(async () => srv.close());

  it('the run-list button reads "Details", not "Attach"', () => {
    assert.ok(tables.includes('"Details"'), 'run list button must read "Details" — FR-019');
    assert.ok(!html.includes(">Attach<"), 'the old "Attach" button label must be gone — FR-019');
    assert.ok(!tables.includes("Attach"), 'the old "Attach" button label must be gone — FR-019');
    assert.ok(
      tables.includes("data-run-details"),
      "the Details button must carry data-run-details"
    );
    assert.ok(
      html.includes("[data-run-details]"),
      "the page must wire the Details button the row renderer emits"
    );
  });

  it("the detail panel carries the run-id, invocation and step-detail elements", () => {
    for (const id of [
      "run-detail-title",
      "run-detail-id",
      "run-invocation-chat",
      "run-invocation-curl",
      "step-detail",
    ]) {
      assert.ok(html.includes(id), `served HTML must contain the "${id}" element — FR-019/FR-020`);
    }
    // The three sections a run reads as (042 D18), matched on their markup
    // rather than their bare words: a phrase alone also matches the comment
    // above the block and would survive the block being deleted.
    for (const section of ["Result", "Progress", "Request"]) {
      assert.ok(
        html.includes(`<h3>${section}</h3>`),
        `served HTML must carry the "${section}" section — 042 D18`
      );
    }
    assert.ok(html.includes("run_pipeline("), "served HTML must render the chat call — FR-020");
    assert.ok(html.includes("curl -X POST"), "served HTML must render the curl call — FR-020");
  });
});

describe("GET /api/runs — summaries carry settledAt once terminal (spec 034 FR-002)", () => {
  let srv: ServeHandle;
  let runId: string;

  before(async () => {
    const svc = new RunService(
      makeMastra(makeMockRun("summary-settled", successResult(), successResult()))
    );
    const start = await svc.start("test-pipeline", {});
    runId = start.runId;
    await svc.waitForSettled(runId);
    srv = await startServer({
      state: makeState(REAL_REPO_ROOT),
      port: 0,
      dbPath: ":memory:",
      pipelinesDir: REAL_PIPELINES_DIR,
      runService: svc,
    });
  });
  after(async () => srv.close());

  it("the list route reports createdAt and settledAt for a finished run", async () => {
    const res = await fetch(`http://127.0.0.1:${srv.port}/api/runs`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      runs: { runId: string; createdAt: string; settledAt?: string }[];
    };
    const summary = body.runs.find((r) => r.runId === runId);
    assert.ok(summary !== undefined, "the run must appear in the list");
    assert.ok(
      typeof summary.settledAt === "string",
      `GET /api/runs must carry settledAt for a settled run; got ${JSON.stringify(summary)}`
    );
    assert.ok(
      Date.parse(summary.settledAt) >= Date.parse(summary.createdAt),
      "settledAt must not precede createdAt"
    );
  });
});

// ── Spec 034 FR-010/FR-011: persisted runs served after a restart ────────────

/** Write a settled run's artifact into a state dir, exactly as persistArtifact does. */
function writePersistedRun(runsDir: string, runId: string): void {
  const dir = join(runsDir, runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "test.json"),
    JSON.stringify({
      runId,
      pipelineId: "test",
      status: "succeeded",
      gateMode: "manual",
      invocation: {
        pipeline: "test",
        inputs: { request: "ship it" },
        gateMode: "manual",
        startedAt: "2026-09-13T09:00:00.000Z",
        source: "http",
      },
      steps: { run: { status: "succeeded", command: "echo hello" } },
      gateDecisions: [],
      provenance: {
        pipelineId: "test",
        profileId: "anthropic",
        transportPerStep: {},
        startedAt: "2026-09-13T09:00:00.000Z",
        settledAt: "2026-09-13T09:01:00.000Z",
      },
    }),
    "utf8"
  );
}

describe("Persisted runs are served by a daemon that never ran them (FR-010/FR-011)", () => {
  let srv: ServeHandle;
  let tmpDir: string;
  const runId = "persisted-run-01";

  before(async () => {
    tmpDir = realpathSync(mkdtempSync(join(tmpdir(), "agent-flows-persisted-")));
    const state = makeState(REAL_REPO_ROOT, tmpDir);
    mkdirSync(state.runsDir, { recursive: true });
    writePersistedRun(state.runsDir, runId);
    // A fresh RunService: its registry has never heard of the run above.
    const svc = new RunService(
      makeMastra(makeMockRun("unrelated", successResult(), successResult())),
      undefined,
      state.runsDir
    );
    srv = await startServer({
      state,
      port: 0,
      dbPath: ":memory:",
      pipelinesDir: REAL_PIPELINES_DIR,
      runService: svc,
    });
  });
  after(async () => {
    await srv.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("GET /api/runs lists it, marked as coming from disk", async () => {
    const res = await fetch(`http://127.0.0.1:${srv.port}/api/runs`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      runs: { runId: string; source?: string; settledAt?: string; status: string }[];
    };
    const summary = body.runs.find((r) => r.runId === runId);
    assert.ok(summary !== undefined, "a run left on disk must appear in the list after a restart");
    assert.equal(summary.source, "disk");
    assert.equal(summary.status, "succeeded");
    assert.equal(summary.settledAt, "2026-09-13T09:01:00.000Z");
  });

  it("GET /api/runs/:id rebuilds its invocation and steps from the artifact", async () => {
    const res = await fetch(`http://127.0.0.1:${srv.port}/api/runs/${runId}`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      source?: string;
      invocation?: { inputs?: Record<string, unknown> };
      steps: Record<string, { command?: string }>;
    };
    assert.equal(body.source, "disk");
    assert.deepEqual(body.invocation?.inputs, { request: "ship it" });
    assert.equal(body.steps.run?.command, "echo hello");
  });

  it("its events stream sends one snapshot and closes", async () => {
    // A live run's stream stays open with heartbeats, so a regression here would
    // hang this test forever. The abort turns that hang into a failure.
    const ac = new AbortController();
    const guard = setTimeout(() => ac.abort(), 5_000);
    const res = await fetch(`http://127.0.0.1:${srv.port}/api/runs/${runId}/events`, {
      signal: ac.signal,
    });
    assert.equal(res.status, 200);
    let text: string;
    try {
      text = await res.text();
    } catch (err) {
      assert.fail(
        `the events stream for a restored run must end on its own: ${String(err)} — FR-011`
      );
    } finally {
      clearTimeout(guard);
    }
    assert.match(text, /^event: snapshot\n/u, "the one event must be the snapshot");
    assert.equal(
      text.split("event: snapshot").length - 1,
      1,
      "a restored run has exactly one thing to say"
    );
    assert.ok(!text.includes("event: step"), "a restored run emits no step events");
  });

  it("cancelling it is a 409 naming its status, not a 404", async () => {
    const res = await fetch(`http://127.0.0.1:${srv.port}/api/runs/${runId}/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(res.status, 409);
    const body = (await res.json()) as { status?: string; error?: string };
    assert.equal(body.status, "succeeded");
  });

  it("approving it is a 409 too", async () => {
    const res = await fetch(`http://127.0.0.1:${srv.port}/api/runs/${runId}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ approved: true }),
    });
    assert.equal(res.status, 409);
    const body = (await res.json()) as { error?: string };
    assert.match(String(body.error), /restored from its artifact/u);
  });
});

describe("A restart keeps a real run visible (spec 034 V5)", () => {
  let tmpDir: string;
  let state: ProjectState;
  let runId: string;

  before(async () => {
    tmpDir = realpathSync(mkdtempSync(join(tmpdir(), "agent-flows-restart-")));
    state = makeState(REAL_REPO_ROOT, tmpDir);

    // First daemon: a real `test` pipeline (one check step) run to completion.
    const pipeline = loadPipeline(join(bundledPipelinesDir(), "test.yaml"));
    const wf = buildPipelineWorkflow(pipeline, {
      registry: new ModelRegistry([]),
      store: {} as unknown as TicketStore,
      checkCommand: "echo hello",
    });
    const mastra = new Mastra({ workflows: { [pipeline.def.id]: wf } });
    const svc = new RunService(mastra, undefined, state.runsDir);
    const first = await startServer({
      state,
      port: 0,
      dbPath: ":memory:",
      pipelinesDir: bundledPipelinesDir(),
      runService: svc,
    });
    const started = await fetch(`http://127.0.0.1:${first.port}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pipeline: "test", inputs: {} }),
    });
    runId = ((await started.json()) as { runId: string }).runId;
    await svc.waitForSettled(runId);
    // persistArtifact is fire-and-forget; wait for the file to land.
    const artifactDir = join(state.runsDir, runId);
    for (let i = 0; i < 100 && !existsSync(join(artifactDir, "test.json")); i++) {
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    }
    await first.close();
  });
  after(() => rmSync(tmpDir, { recursive: true, force: true }));

  it("a NEW daemon on the same state dir still lists and serves the run", async () => {
    // Second daemon: a different RunService whose registry is empty. Nothing but
    // the state dir connects it to the run above.
    const fresh = new RunService(
      makeMastra(makeMockRun("fresh", successResult(), successResult())),
      undefined,
      state.runsDir
    );
    const srv = await startServer({
      state,
      port: 0,
      dbPath: ":memory:",
      pipelinesDir: bundledPipelinesDir(),
      runService: fresh,
    });
    try {
      const list = (await (await fetch(`http://127.0.0.1:${srv.port}/api/runs`)).json()) as {
        runs: { runId: string; source?: string; status: string }[];
      };
      const summary = list.runs.find((r) => r.runId === runId);
      assert.ok(summary !== undefined, "the run must survive the restart in GET /api/runs");
      assert.equal(summary.source, "disk");
      assert.equal(summary.status, "succeeded");

      const detail = (await (
        await fetch(`http://127.0.0.1:${srv.port}/api/runs/${runId}`)
      ).json()) as {
        invocation?: { pipeline?: string };
        steps: Record<string, { command?: string }>;
      };
      assert.equal(detail.invocation?.pipeline, "test", "the invocation must survive the restart");
      assert.equal(
        detail.steps.run?.command,
        "echo hello",
        "the step's command must survive the restart"
      );
    } finally {
      await srv.close();
    }
  });
});

// ── Audit: artifactPath must stay under the state root ───────────────────────
//
// artifactPath decides where the NEXT stage's artifacts are written
// (chainArtifactDir), so an unconstrained value is an arbitrary-write primitive.

describe("POST /api/runs — artifactPath is confined to the state root", () => {
  let srv: ServeHandle;
  let tmpDir: string;
  let projectDir: string;
  let stateRunsDir: string;

  function writeArtifactAt(path: string): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        runId: "src-run",
        pipelineId: "spec-creation",
        status: "succeeded",
        gateMode: "manual",
        spec: { title: "T", description: "D" },
        steps: {},
        gateDecisions: [],
      }),
      "utf8"
    );
  }

  before(async () => {
    tmpDir = realpathSync(mkdtempSync(join(tmpdir(), "af-artifact-root-")));
    projectDir = join(tmpDir, "project");
    mkdirSync(projectDir, { recursive: true });
    stateRunsDir = makeState(projectDir).runsDir;
    srv = await startServer({
      state: makeState(projectDir),
      port: 0,
      dbPath: ":memory:",
      pipelinesDir: REAL_PIPELINES_DIR,
      projectDir,
      runService: new RunService(
        makeMastra(makeMockRun("artifact-root-run", successResult(), successResult()))
      ),
    });
  });
  after(async () => {
    await srv.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("accepts a path inside the state root", async () => {
    const inside = join(stateRunsDir, "inside-run", "spec-creation.json");
    writeArtifactAt(inside);
    const res = await mutate(srv.port, "POST", "/api/runs", {
      pipeline: "build",
      artifactPath: inside,
    });
    const body = (await res.json()) as { error?: string };
    assert.ok(
      !body.error?.includes("must be under"),
      `a path under the state root must be accepted; got: ${JSON.stringify(body)}`
    );
  });

  it("rejects an absolute path outside the state root with 400", async () => {
    const outside = join(tmpDir, "elsewhere", "spec-creation.json");
    writeArtifactAt(outside);
    const res = await mutate(srv.port, "POST", "/api/runs", {
      pipeline: "build",
      artifactPath: outside,
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /artifactPath must be under /u);
  });

  it("rejects /tmp/x — a path the daemon never writes to", async () => {
    const res = await mutate(srv.port, "POST", "/api/runs", {
      pipeline: "build",
      artifactPath: "/tmp/x",
    });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error as string, /artifactPath must be under /u);
  });

  it("rejects <stateRoot>/../x — traversal out of the root", async () => {
    const escaped = join(stateRunsDir, "..", "..", "..", "..", "x.json");
    const res = await mutate(srv.port, "POST", "/api/runs", {
      pipeline: "build",
      artifactPath: escaped,
    });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error as string, /artifactPath must be under /u);
  });

  it("rejects a symlink inside the root that points outside it", async () => {
    const target = join(tmpDir, "linked-target");
    mkdirSync(target, { recursive: true });
    writeArtifactAt(join(target, "spec-creation.json"));
    const link = join(stateRunsDir, "link-out");
    mkdirSync(dirname(link), { recursive: true });
    try {
      symlinkSync(target, link, "dir");
    } catch {
      return; // symlinks unavailable — nothing to assert
    }
    const res = await mutate(srv.port, "POST", "/api/runs", {
      pipeline: "build",
      artifactPath: join(link, "spec-creation.json"),
    });
    assert.equal(res.status, 400, "a symlink must not be a way out of the state root");
    assert.match((await res.json()).error as string, /artifactPath must be under /u);
  });
});

// ── Spec 034: hash-routed views ──────────────────────────────────────────────

describe("GET / — four views, tabs and router wired in served HTML (V1)", () => {
  let srv: ServeHandle;
  let html: string;

  before(async () => {
    srv = await startServer({
      state: makeState(REAL_REPO_ROOT),
      port: 0,
      dbPath: ":memory:",
      pipelinesDir: REAL_PIPELINES_DIR,
    });
    html = await (await fetch(`http://127.0.0.1:${srv.port}/`)).text();
  });
  after(async () => srv.close());

  it("carries every view container and tab id", () => {
    for (const id of [
      "view-runs",
      "view-run",
      "view-workflows",
      "view-workflow",
      "view-workflow-edit",
      "view-settings",
    ])
      assert.ok(html.includes(`id="${id}"`), `served HTML must contain the "${id}" container`);
    for (const id of ["tab-runs", "tab-workflows", "tab-settings"])
      assert.ok(html.includes(`id="${id}"`), `served HTML must contain the "${id}" tab`);
    assert.ok(!html.includes(">Attach<"), 'the old "Attach" button label must be gone');
  });

  it("imports the router module and routes every tab by hash", () => {
    assert.ok(html.includes('from "/ui-route.js"'), "the page must import the shared router");
    for (const mod of ["/ui-graph.js", "/ui-tables.js", "/ui-log.js"]) {
      assert.ok(html.includes(`from "${mod}"`), `the page must import ${mod}`);
    }
    for (const hash of ["#/runs", "#/workflows", "#/settings"])
      assert.ok(html.includes(`href="${hash}"`), `the ${hash} tab link is missing`);
  });

  it("carries the split-view containers and the settings reader (D9/FR-013/FR-014)", () => {
    for (const id of [
      "runs-split",
      "runs-pane-list",
      "runs-pane-detail",
      "settings-split",
      "settings-pane-list",
      "settings-reader",
    ])
      assert.ok(html.includes(`id="${id}"`), `served HTML must contain the "${id}" pane — D9`);
    assert.ok(
      html.includes('matchMedia("(min-width: 1200px)")'),
      "the page must watch the 1200px breakpoint so a resize re-lays-out the panes"
    );
    assert.ok(
      html.includes("@media (min-width: 1200px)"),
      "the split layout must be a media query, not a JS-only layout"
    );
  });

  it("keeps the stream rule and the no-double-escape rule (FR-004, audit)", () => {
    assert.ok(html.includes("__afDebug"), "the SSE open/close counters must stay observable");
    assert.ok(html.includes("sseOpens") && html.includes("sseCloses"), "both counters must exist");
    assert.ok(
      html.includes("closeRunStream"),
      "the stream must still be closed explicitly on selection change"
    );
    assert.ok(
      !html.includes("textContent = escH("),
      "textContent escapes on assignment — escaping first double-escapes the text"
    );
  });
});

describe("GET /ui-*.js — the page's ESM helpers are served next to it (D7, 037 FR-015)", () => {
  let srv: ServeHandle;

  before(async () => {
    srv = await startServer({
      state: makeState(REAL_REPO_ROOT),
      port: 0,
      dbPath: ":memory:",
      pipelinesDir: REAL_PIPELINES_DIR,
    });
  });
  after(async () => srv.close());

  it("serves the module with a JavaScript content type", async () => {
    const res = await fetch(`http://127.0.0.1:${srv.port}/ui-route.js`);
    assert.equal(res.status, 200);
    const ctype = res.headers.get("content-type") ?? "";
    assert.match(ctype, /javascript/u, `expected a JS content type, got "${ctype}"`);
    const body = await res.text();
    assert.ok(body.includes("export function parseHash"), "the module must export parseHash");
  });

  it("serves the run-view renderers the same way (spec 036 D10)", async () => {
    const res = await fetch(`http://127.0.0.1:${srv.port}/ui-log.js`);
    assert.equal(res.status, 200);
    const ctype = res.headers.get("content-type") ?? "";
    assert.match(ctype, /javascript/u, `expected a JS content type, got "${ctype}"`);
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    const body = await res.text();
    assert.ok(body.includes("export function renderLogEvent"), "must export renderLogEvent");
  });

  it("serves the diagram and table modules Ship 2 adds (037 D7/FR-008)", async () => {
    for (const [name, exported] of [
      ["ui-graph.js", "export function renderLevelsSvg"],
      ["ui-tables.js", "export function workflowRow"],
    ]) {
      const res = await fetch(`http://127.0.0.1:${srv.port}/${name}`);
      assert.equal(res.status, 200, `${name} must be served`);
      assert.match(res.headers.get("content-type") ?? "", /javascript/u);
      assert.ok((await res.text()).includes(exported), `${name} must export its renderer`);
    }
  });

  it("404s a module name that is not on the allowlist (FR-015)", async () => {
    const res = await fetch(`http://127.0.0.1:${srv.port}/ui-other.js`);
    assert.equal(res.status, 404, "only the listed module names are served");
    await res.text();
  });
});

describe("GET /api/environment — port and provider profile (D6/FR-007)", () => {
  let srv: ServeHandle;

  before(async () => {
    srv = await startServer({
      state: makeState(REAL_REPO_ROOT),
      port: 0,
      dbPath: ":memory:",
      pipelinesDir: REAL_PIPELINES_DIR,
    });
  });
  after(async () => srv.close());

  it("reports the bound port and the active profile id", async () => {
    const res = await fetch(`http://127.0.0.1:${srv.port}/api/environment`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { port?: number; profile?: string };
    assert.equal(body.port, srv.port, "port must be the actually-bound port, not the requested 0");
    assert.ok(
      typeof body.profile === "string" && body.profile.length > 0,
      `profile must be a non-empty string; got ${JSON.stringify(body.profile)}`
    );
  });
});

// ── GET/PUT /api/providers (spec 039) ────────────────────────────────────────

describe("GET/PUT /api/providers — the provider matrix", () => {
  let srv: ServeHandle;
  let tmpProjectDir: string;
  let providersPath: string;
  // A value that stands in for a real API key. Nothing in any response body may
  // ever contain it — the daemon reports the variable's NAME, never its value.
  const FAKE_KEY = "s3cr3t-value-that-must-never-leave-the-daemon";

  const DOC = [
    "version: 1",
    "models:",
    "  - id: house-llm",
    "    transport: api",
    "    api:",
    "      endpoint: https://models.example.com/v1/chat/completions",
    "      keyEnv: AGENT_FLOWS_TEST_FAKE_KEY",
    "profiles:",
    "  - id: house",
    "    roles:",
    "      reasoner: house-llm",
    "      worker: house-llm",
    "      scout: house-llm",
    "    fallback:",
    "      - anthropic",
    "",
  ].join("\n");

  async function getProviders(): Promise<Record<string, unknown>> {
    const res = await fetch(`http://127.0.0.1:${srv.port}/api/providers`);
    assert.equal(res.status, 200);
    return (await res.json()) as Record<string, unknown>;
  }

  async function putProviders(
    body: unknown
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await fetch(`http://127.0.0.1:${srv.port}/api/providers`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  before(async () => {
    tmpProjectDir = realpathSync(mkdtempSync(join(tmpdir(), "agent-flows-providers-")));
    mkdirSync(join(tmpProjectDir, ".agent-flows"), { recursive: true });
    providersPath = join(tmpProjectDir, ".agent-flows", "providers.yaml");
    writeFileSync(providersPath, DOC);
    process.env.AGENT_FLOWS_TEST_FAKE_KEY = FAKE_KEY;
    srv = await startServer({
      state: makeState(tmpProjectDir),
      port: 0,
      dbPath: ":memory:",
      projectDir: tmpProjectDir,
    });
  });

  after(async () => {
    await srv.close();
    delete process.env.AGENT_FLOWS_TEST_FAKE_KEY;
    rmSync(tmpProjectDir, { recursive: true, force: true });
  });

  it("merges project-declared profiles with the built-ins and marks each source", async () => {
    const body = (await getProviders()) as {
      profiles: { id: string; source: string; fallback: string[] }[];
      models: { id: string; source: string }[];
      roles: string[];
      defaultProvider?: string;
    };
    const project = body.profiles.filter((p) => p.source === "project").map((p) => p.id);
    const builtin = body.profiles.filter((p) => p.source === "builtin").map((p) => p.id);
    assert.deepEqual(project, ["house"], "the project profile must come first and be marked");
    for (const id of ["anthropic", "openai", "local"]) {
      assert.ok(builtin.includes(id), `built-in profile "${id}" must be in the merged view`);
    }
    assert.deepEqual(body.roles, ["reasoner", "worker", "scout"]);
    // The chain is what drives failover, so the page has to be able to show it.
    const house = body.profiles.find((p) => p.id === "house" && p.source === "project");
    assert.deepEqual(house?.fallback, ["anthropic"]);
    const anthropic = body.profiles.find((p) => p.id === "anthropic");
    assert.deepEqual(anthropic?.fallback, ["openai"]);

    assert.equal(
      body.models[0]?.id,
      "house-llm",
      "project models are prepended, as in the registry"
    );
    assert.ok(
      body.models.some((m) => m.id === "opus" && m.source === "builtin"),
      "the built-in registry entries must be listed too"
    );
  });

  it("reports a keyEnv by NAME and never returns its value", async () => {
    const res = await fetch(`http://127.0.0.1:${srv.port}/api/providers`);
    assert.equal(res.status, 200);
    const raw = await res.text();
    assert.ok(
      raw.includes("AGENT_FLOWS_TEST_FAKE_KEY"),
      "the env var NAME is what the editor needs"
    );
    assert.ok(!raw.includes(FAKE_KEY), "the key VALUE must appear nowhere in the response body");
    const body = JSON.parse(raw) as {
      models: { id: string; api?: { keyEnv?: string; keyEnvSet?: boolean } }[];
    };
    const entry = body.models.find((m) => m.id === "house-llm");
    assert.equal(entry?.api?.keyEnv, "AGENT_FLOWS_TEST_FAKE_KEY");
    assert.equal(entry?.api?.keyEnvSet, true, "presence is reported as a boolean, not a value");
  });

  it("round-trips a matrix change through PUT and back into the file", async () => {
    const before = (await getProviders()) as { hash: string };
    const written = await putProviders({
      ifMatch: before.hash,
      config: {
        version: 1,
        models: [
          {
            id: "house-llm",
            transport: "api",
            api: {
              endpoint: "https://models.example.com/v1/chat/completions",
              keyEnv: "AGENT_FLOWS_TEST_FAKE_KEY",
            },
          },
        ],
        profiles: [
          {
            id: "house",
            roles: { reasoner: "opus", worker: "house-llm", scout: "house-llm" },
            fallback: ["anthropic"],
          },
        ],
      },
    });
    assert.equal(written.status, 200, JSON.stringify(written.body));
    assert.equal(written.body.ok, true);

    const onDisk = readFileSync(providersPath, "utf8");
    assert.match(onDisk, /reasoner:\s*opus/u, "the edited cell must have landed in the file");

    const after = (await getProviders()) as {
      profiles: { id: string; source: string; roles: Record<string, string> }[];
      hash: string;
    };
    const house = after.profiles.find((p) => p.id === "house" && p.source === "project");
    assert.equal(house?.roles.reasoner, "opus", "the read API must reflect the write");
    assert.notEqual(after.hash, before.hash, "the hash must move with the file");
  });

  it("rejects an invalid document with 400 and leaves the file byte-identical", async () => {
    const current = (await getProviders()) as { hash: string };
    const bytesBefore = readFileSync(providersPath);
    const result = await putProviders({
      ifMatch: current.hash,
      config: {
        version: 1,
        models: [],
        // Missing "scout" — the loader's own validator is what refuses this.
        profiles: [{ id: "house", roles: { reasoner: "opus", worker: "opus" } }],
      },
    });
    assert.equal(result.status, 400);
    assert.match(String(result.body.error), /scout/u, "the parse error must be returned verbatim");
    assert.deepEqual(
      readFileSync(providersPath),
      bytesBefore,
      "a rejected document must not have been written — validation runs before any write"
    );
  });

  it("refuses a stale write with 409 rather than clobbering the other editor", async () => {
    const result = await putProviders({
      ifMatch: "0".repeat(64),
      config: {
        version: 1,
        models: [],
        profiles: [{ id: "house", roles: { reasoner: "opus", worker: "opus", scout: "opus" } }],
      },
    });
    assert.equal(result.status, 409);
    assert.equal(result.body.reason, "conflict");
  });
});

// ── FR-004: per-request canon resolution ─────────────────────────────────────
//
// This test encodes the live observation from the spec:
//   1. Daemon starts with projectDir that has no .agent-flows/pipelines/ → bundled pipelines served.
//   2. Write a pipeline YAML into <projectDir>/.agent-flows/pipelines/ while daemon runs.
//   3. Next GET /api/pipelines returns the project's set — NO restart required.
//
// To prove the guard can fail: the test was authored against a version of server.ts
// that resolved pipelinesDir once at startup (the old code). Against that code,
// step 3 would still return the bundled set because startServer baked in the initial
// dir. The fix (resolving the canon per-request in the nodeCreateServer callback —
// the merged layer view since spec 038 D13) makes the test pass. Neutering the fix
// (passing explicitPipelinesDir unconditionally from the bundled initial value)
// makes it red again — confirmed during development.

describe("FR-004: per-request canon resolution — daemon serves installed pipelines without restart", () => {
  let srv: ServeHandle;
  let tmpProjectDir: string;

  before(async () => {
    tmpProjectDir = realpathSync(mkdtempSync(join(tmpdir(), "agent-flows-fr004-")));
    // Start with no .agent-flows/ at all — bundled pipelines should be served.
    srv = await startServer({
      state: makeState(tmpProjectDir),
      port: 0,
      dbPath: ":memory:",
      projectDir: tmpProjectDir,
    });
  });

  after(async () => {
    await srv.close();
    rmSync(tmpProjectDir, { recursive: true, force: true });
  });

  it("initially serves bundled pipelines when project has no .agent-flows/pipelines/", async () => {
    const res = await fetch(`http://127.0.0.1:${srv.port}/api/pipelines`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { pipelines: { id: string }[] };
    assert.ok(
      Array.isArray(body.pipelines) && body.pipelines.length > 0,
      "must serve bundled pipelines initially"
    );
    // Bundled set always includes spec-creation.
    assert.ok(
      body.pipelines.some((p) => p.id === "spec-creation"),
      "bundled pipeline 'spec-creation' must be present"
    );
  });

  it("reflects project pipeline on next request after install — no restart (FR-004)", async () => {
    // Record baseline count.
    const before = await fetch(`http://127.0.0.1:${srv.port}/api/pipelines`);
    const beforeBody = (await before.json()) as { pipelines: { id: string }[] };
    const beforeCount = beforeBody.pipelines.length;

    // Write a project pipeline into .agent-flows/pipelines/ while the daemon is running.
    const projectPipelinesDir = join(tmpProjectDir, ".agent-flows", "pipelines");
    mkdirSync(projectPipelinesDir, { recursive: true });
    writeFileSync(
      join(projectPipelinesDir, "fr004-test.yaml"),
      "id: fr004-test\nversion: 1\ndescription: FR-004 test pipeline\ninputs: []\nsteps:\n  - id: start\n    kind: gate\n"
    );

    // The very next request must reflect the installed pipeline — no restart.
    const after = await fetch(`http://127.0.0.1:${srv.port}/api/pipelines`);
    assert.equal(after.status, 200);
    const afterBody = (await after.json()) as { pipelines: { id: string }[] };

    // Project directory now has one pipeline; it replaces the bundled set.
    assert.ok(
      afterBody.pipelines.some((p) => p.id === "fr004-test"),
      `fr004-test must appear in pipeline list after install without restart; ` +
        `got: ${JSON.stringify(afterBody.pipelines.map((p) => p.id))} (before count: ${String(beforeCount)})`
    );
  });
});

// ── FR-005/FR-006/FR-007: status vocabulary and rejection outcome ─────────────

describe("FR-005: GET /api/runs/:id never returns 'suspended' or 'success' status", () => {
  let srv: ServeHandle;
  let runId: string;

  before(async () => {
    const suspendedStart = {
      status: "suspended",
      suspended: [["approve"]],
      steps: { approve: { suspendPayload: { message: "Approve?", spec: { x: 1 } } } },
    };
    const mockRun = makeMockRun("fr005-run", suspendedStart, successResult());
    const service = new RunService(makeMastra(mockRun));
    const { runId: id } = await service.start("p", {});
    runId = id;
    await service.waitForSettled(runId);
    srv = await startServer({
      state: makeState(REAL_REPO_ROOT),
      port: 0,
      dbPath: ":memory:",
      pipelinesDir: REAL_PIPELINES_DIR,
      runService: service,
    });
  });
  after(async () => srv.close());

  it("awaiting_approval run returns 'awaiting_approval', not 'suspended'", async () => {
    const res = await fetch(`http://127.0.0.1:${srv.port}/api/runs/${encodeURIComponent(runId)}`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { status: string };
    assert.equal(
      body.status,
      "awaiting_approval",
      "GET /api/runs/:id must return awaiting_approval, not suspended"
    );
    assert.notEqual(body.status, "suspended", "old 'suspended' status must not appear");
  });
});

describe("FR-006/FR-007: gate rejection returns HTTP 200 with status:'rejected', not an error payload", () => {
  let srv: ServeHandle;
  let runId: string;
  let service: RunService;

  before(async () => {
    const suspendedStart = {
      status: "suspended",
      suspended: [["approve"]],
      steps: { approve: { suspendPayload: { message: "Approve?", spec: { x: 1 } } } },
    };
    const rejectedResult = {
      status: "failed",
      error: Object.assign(new Error('Gate "approve" rejected (manual): no reason given'), {
        name: "GateRejectedError",
      }),
    };
    const mockRun = makeMockRun("fr006-reject-run", suspendedStart, rejectedResult);
    service = new RunService(makeMastra(mockRun));
    const { runId: id } = await service.start("p", {});
    runId = id;
    await service.waitForSettled(runId);
    srv = await startServer({
      state: makeState(REAL_REPO_ROOT),
      port: 0,
      dbPath: ":memory:",
      pipelinesDir: REAL_PIPELINES_DIR,
      runService: service,
    });
  });
  after(async () => srv.close());

  it("POST /api/runs/:id/approve with approved:false returns 200 with status:'rejected'", async () => {
    const res = await fetch(
      `http://127.0.0.1:${srv.port}/api/runs/${encodeURIComponent(runId)}/approve`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ approved: false }),
      }
    );
    // FR-006: rejection is a normal outcome — HTTP 200, not 4xx.
    assert.equal(res.status, 200, "gate rejection must return HTTP 200, not 4xx");
    const body = (await res.json()) as { status?: string; error?: string };
    assert.equal(body.status, "rejected", "body must carry status:'rejected'");
    // No top-level error field that would indicate a tool failure.
    assert.ok(
      body.error !== undefined || body.status === "rejected",
      "rejection outcome: status must be 'rejected'"
    );
  });

  it("GET /api/runs/:id after rejection returns status:'rejected'", async () => {
    const res = await fetch(`http://127.0.0.1:${srv.port}/api/runs/${encodeURIComponent(runId)}`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { status: string };
    assert.equal(body.status, "rejected", "run status must be 'rejected' after gate rejection");
  });
});

describe("FR-006: optional rejection reason stored on gate decision", () => {
  let srv: ServeHandle;
  let runId: string;
  let service: RunService;

  before(async () => {
    const suspendedStart = {
      status: "suspended",
      suspended: [["approve"]],
      steps: { approve: { suspendPayload: { message: "Approve?", spec: { x: 1 } } } },
    };
    const rejectedResult = {
      status: "failed",
      error: Object.assign(new Error('Gate "approve" rejected (manual): user said no'), {
        name: "GateRejectedError",
      }),
    };
    const mockRun = makeMockRun("fr006-reason-run", suspendedStart, rejectedResult);
    service = new RunService(makeMastra(mockRun));
    const { runId: id } = await service.start("p", {});
    runId = id;
    await service.waitForSettled(runId);
    srv = await startServer({
      state: makeState(REAL_REPO_ROOT),
      port: 0,
      dbPath: ":memory:",
      pipelinesDir: REAL_PIPELINES_DIR,
      runService: service,
    });
  });
  after(async () => srv.close());

  it("supplied reason is stored on the gate decision; absent reason is handled honestly", async () => {
    // Reject with a reason.
    const res = await fetch(
      `http://127.0.0.1:${srv.port}/api/runs/${encodeURIComponent(runId)}/approve`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ approved: false, reason: "Not convinced by the approach." }),
      }
    );
    assert.equal(res.status, 200, "rejection with reason must return 200");
    const body = (await res.json()) as { status: string };
    assert.equal(body.status, "rejected");

    // The reason must be recorded on the gate decision.
    const runState = service.get(runId);
    assert.ok(runState !== undefined);
    const decision = runState.gateDecisions[0];
    assert.ok(decision !== undefined, "must have one gate decision");
    assert.equal(decision.decidedBy, "human");
    assert.equal(
      decision.reason,
      "Not convinced by the approach.",
      "reason must be stored on decision"
    );
  });
});

// ── spec 029 FR-003/FR-004: POST /api/runs with artifactPath ─────────────────
//
// These tests cover stage handoff via durable artifacts: a completed run writes
// an artifact, and a NEW run (different server instance) reads it as input.
// The decisive test (V-9 analogue) uses two separate RunService instances to
// prove the handoff goes through the file, not through shared in-memory state.

describe("FR-003: POST /api/runs — artifactPath seeds inputs from artifact file", () => {
  let srv: ServeHandle;
  let tmpDir: string;
  let projectDir: string;

  before(async () => {
    tmpDir = realpathSync(mkdtempSync(join(tmpdir(), "af-handoff-")));
    projectDir = join(tmpDir, "project");
    mkdirSync(projectDir, { recursive: true });
    // A minimal RunService so the server can process /api/runs requests.
    // Tests that need to inspect capturedInput create their own server/service.
    const sharedRun = makeMockRun("shared-run-01", successResult(), successResult());
    srv = await startServer({
      state: makeState(projectDir),
      port: 0,
      dbPath: ":memory:",
      pipelinesDir: REAL_PIPELINES_DIR,
      projectDir,
      runService: new RunService(makeMastra(sharedRun)),
    });
  });
  after(async () => {
    await srv.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // Write a synthetic artifact to disk — simulates a completed spec-creation run.
  //
  // Shape mirrors what the real runtime writes (spec 029 FR-001):
  //   spec   — the assembled HardenedSpec written as a plain-text string (markdown),
  //            because build/audit/develop declare plan as z.string() and the
  //            resolution rule refuses to serialise objects silently.
  //   result — the run's accumulated context keyed by step id, matching what Mastra
  //            returns as r.result. The "findings" step output is at result.findings.
  function writeArtifact(dir: string, overrides: Record<string, unknown> = {}): string {
    const runsDir = join(makeState(dir).runsDir, "run-handoff-src");
    mkdirSync(runsDir, { recursive: true });
    const artifactPath = join(runsDir, "spec-creation.json");
    const artifact = {
      runId: "run-handoff-src",
      pipelineId: "spec-creation",
      status: "succeeded",
      gateMode: "manual",
      steps: {},
      gateDecisions: [],
      // spec is a string — the resolution rule maps plan←artifact.spec and requires a string.
      spec: "My Feature Spec: Implement dark mode",
      // result is the accumulated context object keyed by step id. The findings
      // key matches the "findings" step of the investigate pipeline. The resolution
      // rule maps findings←artifact.result.findings (not the whole result object).
      result: {
        request: "Implement dark mode",
        survey: "Surveyed the codebase; dark-mode token system is partially in place.",
        findings: "No security issues found",
      },
      provenance: {
        pipelineId: "spec-creation",
        profileId: "anthropic",
        transportPerStep: {},
        startedAt: new Date().toISOString(),
        settledAt: new Date().toISOString(),
      },
      ...overrides,
    };
    writeFileSync(artifactPath, JSON.stringify(artifact, null, 2), "utf8");
    return artifactPath;
  }

  it("seeds plan input from artifact.spec when build pipeline is targeted", async () => {
    // Two-run handoff (V-9 analogue): stage A artifact → new run (stage B).
    // The artifact was produced by a previous run (now gone from memory). A NEW
    // server instance reads the file and seeds the next run's inputs from it.
    const artifactFile = writeArtifact(projectDir);

    // The mock run captures inputData so we can assert the plan was injected.
    let capturedInput: Record<string, unknown> | undefined;
    const mockRun: MockRun = {
      runId: "run-handoff-dst",
      watchers: [],
      start: async (opts) => {
        capturedInput = (opts as { inputData: Record<string, unknown> }).inputData;
        return { status: "success", result: { done: true } };
      },
      resume: async () => ({ status: "success", result: { done: true } }),
      watch: (cb) => {
        mockRun.watchers.push(cb);
        return () => {
          const i = mockRun.watchers.indexOf(cb);
          if (i !== -1) mockRun.watchers.splice(i, 1);
        };
      },
      emit: (event) => {
        for (const cb of mockRun.watchers) cb(event);
      },
    };

    // New server (new daemon) with a fresh RunService — no shared memory with stage A.
    const srv2 = await startServer({
      state: makeState(projectDir),
      port: 0,
      dbPath: ":memory:",
      pipelinesDir: REAL_PIPELINES_DIR,
      projectDir,
      runService: new RunService(makeMastra(mockRun)),
    });

    try {
      const res = await mutate(srv2.port, "POST", "/api/runs", {
        pipeline: "build",
        artifactPath: artifactFile,
      });
      assert.equal(res.status, 200, `POST /api/runs must succeed; got ${res.status}`);

      // The run must have received the spec from the artifact as its plan.
      // This asserts the two-run file-based handoff — not memory sharing.
      // plan must be a string: the resolution rule maps plan←artifact.spec and
      // spec is stored as a string (z.string() rejects objects at the Mastra boundary).
      assert.ok(capturedInput !== undefined, "mock run must have been started");
      assert.equal(
        typeof capturedInput.plan,
        "string",
        "plan input must be a string resolved from artifact.spec"
      );
      assert.equal(
        capturedInput.plan,
        "My Feature Spec: Implement dark mode",
        "plan must equal artifact.spec verbatim"
      );
    } finally {
      await srv2.close();
    }
  });

  it("seeds findings input from artifact.result when spec-creation pipeline is targeted", async () => {
    const artifactFile = writeArtifact(projectDir);
    let capturedInput: Record<string, unknown> | undefined;
    const mockRun: MockRun = {
      runId: "run-handoff-findings",
      watchers: [],
      start: async (opts) => {
        capturedInput = (opts as { inputData: Record<string, unknown> }).inputData;
        return { status: "success", result: {} };
      },
      resume: async () => ({ status: "success", result: {} }),
      watch: (cb) => {
        mockRun.watchers.push(cb);
        return () => {
          const i = mockRun.watchers.indexOf(cb);
          if (i !== -1) mockRun.watchers.splice(i, 1);
        };
      },
      emit: (event) => {
        for (const cb of mockRun.watchers) cb(event);
      },
    };

    const srv2 = await startServer({
      state: makeState(projectDir),
      port: 0,
      dbPath: ":memory:",
      pipelinesDir: REAL_PIPELINES_DIR,
      projectDir,
      runService: new RunService(makeMastra(mockRun)),
    });

    try {
      // spec-creation has request (required) and findings (optional).
      // With only an artifact, findings comes from artifact.result.findings (the
      // string value at the "findings" step id key of the accumulated context).
      // request must be provided explicitly since the artifact has no mapping for it.
      const res = await mutate(srv2.port, "POST", "/api/runs", {
        pipeline: "spec-creation",
        inputs: { request: "Implement dark mode" },
        artifactPath: artifactFile,
      });
      assert.equal(res.status, 200, `POST /api/runs must succeed; body: ${await res.text()}`);
      assert.ok(capturedInput !== undefined);
      // findings must be the string at artifact.result.findings — not the whole result
      // object. Passing the object would fail z.string() at the Mastra boundary.
      assert.equal(
        typeof capturedInput.findings,
        "string",
        "findings must be resolved to a string from artifact.result.findings"
      );
      assert.equal(
        capturedInput.findings,
        "No security issues found",
        "findings must equal artifact.result.findings verbatim"
      );
    } finally {
      await srv2.close();
    }
  });

  it("returns 400 for a non-existent artifact file", async () => {
    const res = await mutate(srv.port, "POST", "/api/runs", {
      pipeline: "build",
      artifactPath: "/nonexistent/path/artifact.json",
    });
    assert.equal(res.status, 400, "missing artifact file must return 400");
    const body = (await res.json()) as { error: string };
    assert.ok(
      body.error.toLowerCase().includes("not found") ||
        body.error.toLowerCase().includes("artifact"),
      `error message must mention the artifact; got: ${body.error}`
    );
  });

  it("returns 400 for a file that is not valid JSON", async () => {
    const badPath = join(makeState(projectDir).runsDir, "bad-artifact.json");
    mkdirSync(dirname(badPath), { recursive: true });
    writeFileSync(badPath, "not json {{{", "utf8");
    const res = await mutate(srv.port, "POST", "/api/runs", {
      pipeline: "build",
      artifactPath: badPath,
    });
    assert.equal(res.status, 400, "invalid JSON artifact must return 400");
    const body = (await res.json()) as { error: string };
    assert.ok(
      body.error.toLowerCase().includes("json"),
      `error must mention JSON; got: ${body.error}`
    );
  });

  it("returns 400 for an artifact whose status is running", async () => {
    const artifactFile = writeArtifact(projectDir, { status: "running" });
    const res = await mutate(srv.port, "POST", "/api/runs", {
      pipeline: "build",
      artifactPath: artifactFile,
    });
    assert.equal(res.status, 400, "running artifact must return 400");
    const body = (await res.json()) as { error: string };
    assert.ok(
      body.error.toLowerCase().includes("running"),
      `error must mention running; got: ${body.error}`
    );
  });

  it("returns 400 when a required input cannot be resolved from the artifact (unresolvable guard)", async () => {
    // Write an artifact that has neither spec nor result — no mappable fields.
    const runsDir = join(makeState(projectDir).runsDir, "run-no-mappable");
    mkdirSync(runsDir, { recursive: true });
    const noMappablePath = join(runsDir, "empty.json");
    writeFileSync(
      noMappablePath,
      JSON.stringify({
        runId: "run-no-mappable",
        pipelineId: "investigate",
        status: "succeeded",
        gateMode: "manual",
        steps: {},
        gateDecisions: [],
        // Deliberately omit spec and result.
        provenance: {
          pipelineId: "investigate",
          profileId: "anthropic",
          transportPerStep: {},
          startedAt: new Date().toISOString(),
          settledAt: new Date().toISOString(),
        },
      }),
      "utf8"
    );

    // build pipeline requires `plan` input, which maps to artifact.spec — absent here.
    const res = await mutate(srv.port, "POST", "/api/runs", {
      pipeline: "build",
      artifactPath: noMappablePath,
    });
    assert.equal(res.status, 400, "unresolvable required input must return 400");
    const body = (await res.json()) as { error: string };
    // The error must name the unresolved input.
    assert.ok(
      body.error.includes("plan"),
      `error must name the unresolved input 'plan'; got: ${body.error}`
    );
  });

  it("returns 400 when artifact's mapped field is an object with no key matching the input name", async () => {
    // This is the live defect: artifact.result is an accumulated-context object
    // (keyed by step id) but the target input name does not appear as a key.
    // Silently passing the object into z.string() produces a zod failure deep
    // in the workflow engine — the guard must catch it at the HTTP boundary instead.
    const runsDir = join(makeState(projectDir).runsDir, "run-no-findings-key");
    mkdirSync(runsDir, { recursive: true });
    const noFindingsKeyPath = join(runsDir, "investigate.json");
    writeFileSync(
      noFindingsKeyPath,
      JSON.stringify({
        runId: "run-no-findings-key",
        pipelineId: "investigate",
        status: "succeeded",
        gateMode: "manual",
        steps: {},
        gateDecisions: [],
        // result is an accumulated-context object, but the "findings" key is absent —
        // the step that produces findings was named differently or did not complete.
        result: {
          request: "Implement dark mode",
          survey: "Survey output goes here",
          // "findings" key is intentionally absent
        },
        provenance: {
          pipelineId: "investigate",
          profileId: "anthropic",
          transportPerStep: {},
          startedAt: new Date().toISOString(),
          settledAt: new Date().toISOString(),
        },
      }),
      "utf8"
    );

    let runStarted = false;
    const mockRun: MockRun = {
      runId: "run-should-not-start",
      watchers: [],
      start: async () => {
        runStarted = true;
        return { status: "success", result: {} };
      },
      resume: async () => ({ status: "success", result: {} }),
      watch: (cb) => {
        mockRun.watchers.push(cb);
        return () => {
          const i = mockRun.watchers.indexOf(cb);
          if (i !== -1) mockRun.watchers.splice(i, 1);
        };
      },
      emit: (event) => {
        for (const cb of mockRun.watchers) cb(event);
      },
    };
    const srv2 = await startServer({
      state: makeState(projectDir),
      port: 0,
      dbPath: ":memory:",
      pipelinesDir: REAL_PIPELINES_DIR,
      projectDir,
      runService: new RunService(makeMastra(mockRun)),
    });

    try {
      // spec-creation expects findings (optional) from artifact.result.findings.
      // The artifact's result object has no "findings" key → must be refused at the
      // HTTP boundary, not silently passed to the workflow engine.
      const res = await mutate(srv2.port, "POST", "/api/runs", {
        pipeline: "spec-creation",
        inputs: { request: "Implement dark mode" },
        artifactPath: noFindingsKeyPath,
      });
      assert.equal(
        res.status,
        400,
        `object with no matching key must be refused with 400; got ${res.status}`
      );
      const body = (await res.json()) as { error: string };
      // Error must name the input, describe what the artifact held, and identify the file.
      assert.ok(
        body.error.includes("findings"),
        `error must name the unresolvable input; got: ${body.error}`
      );
      assert.ok(
        body.error.includes("absent") || body.error.includes("available keys"),
        `error must describe what the artifact held; got: ${body.error}`
      );
      assert.ok(!runStarted, "run must NOT have been started when input is unresolvable");
    } finally {
      await srv2.close();
    }
  });

  it("starts the run normally when both inputs and artifactPath are present (artifact takes priority)", async () => {
    const artifactFile = writeArtifact(projectDir);
    let capturedInput: Record<string, unknown> | undefined;
    const mockRun: MockRun = {
      runId: "run-handoff-priority",
      watchers: [],
      start: async (opts) => {
        capturedInput = (opts as { inputData: Record<string, unknown> }).inputData;
        return { status: "success", result: {} };
      },
      resume: async () => ({ status: "success", result: {} }),
      watch: (cb) => {
        mockRun.watchers.push(cb);
        return () => {
          const i = mockRun.watchers.indexOf(cb);
          if (i !== -1) mockRun.watchers.splice(i, 1);
        };
      },
      emit: (event) => {
        for (const cb of mockRun.watchers) cb(event);
      },
    };

    const srv2 = await startServer({
      state: makeState(projectDir),
      port: 0,
      dbPath: ":memory:",
      pipelinesDir: REAL_PIPELINES_DIR,
      projectDir,
      runService: new RunService(makeMastra(mockRun)),
    });
    try {
      const res = await mutate(srv2.port, "POST", "/api/runs", {
        pipeline: "build",
        // Explicit plan is an object — artifact.spec (string) must win and the
        // string overrides whatever the operator passed.
        inputs: { plan: "explicit plan — should be overridden by artifact" },
        artifactPath: artifactFile,
      });
      assert.equal(res.status, 200, `must succeed; got ${res.status}`);
      assert.ok(capturedInput !== undefined);
      // Artifact-derived plan (string) must override the explicit inputs.plan (FR-003).
      assert.equal(
        capturedInput.plan,
        "My Feature Spec: Implement dark mode",
        "artifact.spec must override explicit inputs.plan"
      );
    } finally {
      await srv2.close();
    }
  });

  it("renders a structured HardenedSpec artifact.spec to the canonical plan text", async () => {
    // This is the primary spec-creation → build handoff: spec-creation stores a
    // HardenedSpec object in artifact.spec; the server must render it with
    // renderSpecKitSpec so the plan text the next stage receives is byte-identical
    // to the spec.md the operator reviewed at the gate.
    //
    // The fixture uses the real HardenedSpec shape — the same fields spec-creation
    // stores — so if the shape changes this test breaks rather than silently passing
    // on a mismatch.
    const hardenedSpec = {
      title: "Dark Mode",
      description: "Add a dark mode theme toggle to the application",
      requirements: ["System MUST provide a theme toggle", "System MUST persist the selection"],
      acceptanceCriteria: [
        "Given a light theme, when the user clicks the toggle, then the dark theme is applied",
      ],
      weaknesses: [
        { text: "Toggle state not persisted across sessions", severity: "medium" as const },
      ],
      securityFindings: [],
    };

    const runsDir = join(makeState(projectDir).runsDir, "run-structured-spec");
    mkdirSync(runsDir, { recursive: true });
    const artifactPath = join(runsDir, "spec-creation.json");
    writeFileSync(
      artifactPath,
      JSON.stringify({
        runId: "run-structured-spec",
        pipelineId: "spec-creation",
        status: "succeeded",
        gateMode: "manual",
        steps: {},
        gateDecisions: [],
        // spec is the structured HardenedSpec that spec-creation's assemble-spec step writes.
        spec: hardenedSpec,
        provenance: {
          pipelineId: "spec-creation",
          profileId: "anthropic",
          transportPerStep: {},
          startedAt: new Date().toISOString(),
          settledAt: new Date().toISOString(),
        },
      }),
      "utf8"
    );

    let capturedInput: Record<string, unknown> | undefined;
    const mockRun: MockRun = {
      runId: "run-structured-dst",
      watchers: [],
      start: async (opts) => {
        capturedInput = (opts as { inputData: Record<string, unknown> }).inputData;
        return { status: "success", result: { done: true } };
      },
      resume: async () => ({ status: "success", result: { done: true } }),
      watch: (cb) => {
        mockRun.watchers.push(cb);
        return () => {
          const i = mockRun.watchers.indexOf(cb);
          if (i !== -1) mockRun.watchers.splice(i, 1);
        };
      },
      emit: (event) => {
        for (const cb of mockRun.watchers) cb(event);
      },
    };

    const srv2 = await startServer({
      state: makeState(projectDir),
      port: 0,
      dbPath: ":memory:",
      pipelinesDir: REAL_PIPELINES_DIR,
      projectDir,
      runService: new RunService(makeMastra(mockRun)),
    });

    try {
      const res = await mutate(srv2.port, "POST", "/api/runs", {
        pipeline: "build",
        artifactPath,
      });
      assert.equal(
        res.status,
        200,
        `spec-creation → build handoff must succeed; got ${res.status}`
      );
      assert.ok(capturedInput !== undefined, "mock run must have been started");

      // plan must be the rendered markdown — compare against renderSpecKitSpec's own
      // output so the test breaks if the rendering function ever diverges from what
      // export-spec writes to disk.
      const expectedPlan = renderSpecKitSpec(hardenedSpec);
      assert.equal(
        capturedInput.plan,
        expectedPlan,
        "plan must equal renderSpecKitSpec(hardenedSpec) — rendered markdown, not JSON"
      );

      // Sanity: the rendered text must contain the spec title, not a JSON brace.
      assert.ok(
        typeof capturedInput.plan === "string" && capturedInput.plan.includes("Dark Mode"),
        "rendered plan must include the spec title"
      );
      assert.ok(
        !capturedInput.plan.toString().startsWith("{"),
        "rendered plan must not be a JSON-serialised object"
      );
    } finally {
      await srv2.close();
    }
  });
});

// ── FR-003: path safety — traversal outside project directory ─────────────────

describe("FR-003: artifactPath traversal outside project directory is rejected", () => {
  let srv: ServeHandle;
  let tmpDir: string;
  let projectDir: string;

  before(async () => {
    tmpDir = realpathSync(mkdtempSync(join(tmpdir(), "af-traversal-")));
    projectDir = join(tmpDir, "project");
    mkdirSync(projectDir, { recursive: true });
    // Plant a file outside the project to verify the traversal guard stops access.
    writeFileSync(
      join(tmpDir, "outside.json"),
      '{"status":"succeeded","runId":"x","pipelineId":"x","gateMode":"manual","steps":{},"gateDecisions":[]}',
      "utf8"
    );
    const traversalRun = makeMockRun("traversal-run-01", successResult(), successResult());
    srv = await startServer({
      state: makeState(projectDir),
      port: 0,
      dbPath: ":memory:",
      pipelinesDir: REAL_PIPELINES_DIR,
      projectDir,
      runService: new RunService(makeMastra(traversalRun)),
    });
  });
  after(async () => {
    await srv.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("rejects a relative path that traverses outside the project directory", async () => {
    // "../outside.json" relative to projectDir resolves to tmpDir/outside.json — outside.
    const res = await mutate(srv.port, "POST", "/api/runs", {
      pipeline: "build",
      artifactPath: "../outside.json",
    });
    assert.equal(res.status, 400, "traversal path must be rejected with 400");
    const body = (await res.json()) as { error: string };
    assert.ok(
      body.error.toLowerCase().includes("escapes") ||
        body.error.toLowerCase().includes("project directory"),
      `error must mention containment violation; got: ${body.error}`
    );
  });

  it("allows an absolute path under the state root (cross-project handoff)", async () => {
    // Cross-project handoff is still the point of absolute paths (FR-003), and it
    // still works: every project's artifacts live under the one state root, so a
    // path there passes the guard. The request may then fail for the unresolvable
    // 'plan' input — that is a different error, and the assertion below says so.
    const insidePath = join(makeState(projectDir).runsDir, "other-project", "spec-creation.json");
    mkdirSync(dirname(insidePath), { recursive: true });
    writeFileSync(
      insidePath,
      '{"status":"succeeded","runId":"x","pipelineId":"x","gateMode":"manual","steps":{},"gateDecisions":[]}',
      "utf8"
    );
    const res = await mutate(srv.port, "POST", "/api/runs", {
      pipeline: "build",
      artifactPath: insidePath,
    });
    const body = (await res.json()) as { error?: string };
    if (body.error !== undefined) {
      assert.ok(
        !body.error.toLowerCase().includes("must be under") &&
          !body.error.toLowerCase().includes("escapes"),
        `a path under the state root must pass the containment guard; got: ${body.error}`
      );
    }
  });
});

// ── FR-004: cross-provider artifact handoff ───────────────────────────────────

describe("FR-004: artifact from a different provider profile starts a new run under current profile", () => {
  let tmpDir: string;
  let projectDir: string;

  before(() => {
    tmpDir = realpathSync(mkdtempSync(join(tmpdir(), "af-crossprovider-")));
    projectDir = join(tmpDir, "project");
    mkdirSync(projectDir, { recursive: true });
  });
  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("accepts an artifact produced by a different profile and starts the run", async () => {
    // Write an artifact with profileId "anthropic".
    const runsDir = join(makeState(projectDir).runsDir, "run-cross-profile");
    mkdirSync(runsDir, { recursive: true });
    const artifactPath = join(runsDir, "spec-creation.json");
    writeFileSync(
      artifactPath,
      JSON.stringify({
        runId: "run-cross-profile",
        pipelineId: "spec-creation",
        status: "succeeded",
        gateMode: "manual",
        steps: {},
        gateDecisions: [],
        // spec is a string — resolution rule requires a string for the plan input.
        spec: "Cross-profile spec: test content",
        provenance: {
          pipelineId: "spec-creation",
          profileId: "anthropic", // different from the "openai" profile we'll use below
          transportPerStep: {},
          startedAt: new Date().toISOString(),
          settledAt: new Date().toISOString(),
        },
      }),
      "utf8"
    );

    let capturedInput: Record<string, unknown> | undefined;
    const mockRun: MockRun = {
      runId: "run-cross-dst",
      watchers: [],
      start: async (opts) => {
        capturedInput = (opts as { inputData: Record<string, unknown> }).inputData;
        return { status: "success", result: { output: "done on openai" } };
      },
      resume: async () => ({ status: "success", result: {} }),
      watch: (cb) => {
        mockRun.watchers.push(cb);
        return () => {
          const i = mockRun.watchers.indexOf(cb);
          if (i !== -1) mockRun.watchers.splice(i, 1);
        };
      },
      emit: (event) => {
        for (const cb of mockRun.watchers) cb(event);
      },
    };

    // Simulate a daemon running under a different profile (e.g. "openai") by
    // providing a profile that differs from the artifact's "anthropic".
    // We inject a custom profile to avoid touching env vars in tests.
    const openaiProfile: ProviderProfile = {
      id: "openai",
      roles: { reasoner: "codex", worker: "codex", scout: "codex" },
    };
    const registry = new ModelRegistry([
      { id: "codex", transport: "cli", cli: { bin: "codex", model: "codex-1" } },
    ]);

    const service = new RunService(
      makeMastra(mockRun),
      undefined,
      join(tmpDir, "state-runs"),
      openaiProfile,
      registry
    );

    const srv = await startServer({
      state: makeState(projectDir),
      port: 0,
      dbPath: ":memory:",
      pipelinesDir: REAL_PIPELINES_DIR,
      projectDir,
      runService: service,
    });

    try {
      const res = await mutate(srv.port, "POST", "/api/runs", {
        pipeline: "build",
        artifactPath,
      });
      // The cross-profile handoff must start the run successfully.
      assert.equal(
        res.status,
        200,
        `cross-profile handoff must succeed; body: ${await res.text()}`
      );
      assert.ok(capturedInput !== undefined, "mock run must have been started");
      // plan must be seeded from the anthropic artifact's spec (a string).
      assert.equal(
        capturedInput.plan,
        "Cross-profile spec: test content",
        "plan must carry the artifact's spec string"
      );
    } finally {
      await srv.close();
    }
  });
});

// ── FR-005: POST /api/runs/decide ─────────────────────────────────────────────

describe("FR-005: POST /api/runs/decide — entry-point decision route", () => {
  let srv: ServeHandle;
  let tmpDir: string;
  let projectDir: string;

  before(async () => {
    tmpDir = realpathSync(mkdtempSync(join(tmpdir(), "af-decide-")));
    projectDir = join(tmpDir, "project");
    mkdirSync(projectDir, { recursive: true });
    srv = await startServer({
      state: makeState(projectDir),
      port: 0,
      dbPath: ":memory:",
      pipelinesDir: REAL_PIPELINES_DIR,
      projectDir,
    });
  });
  after(async () => {
    await srv.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("free text → investigate (conservative default)", async () => {
    const res = await mutate(srv.port, "POST", "/api/runs/decide", {
      input: "I want to add dark mode to the settings page",
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { pipeline: string; reason: string };
    assert.equal(body.pipeline, "investigate");
    assert.ok(body.reason.length > 0, "reason must be non-empty");
  });

  it("explicit kind 'feature-request' → investigate", async () => {
    const res = await mutate(srv.port, "POST", "/api/runs/decide", {
      input: "Add OAuth login",
      kind: "feature-request",
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { pipeline: string; reason: string };
    assert.equal(body.pipeline, "investigate");
    assert.ok(
      body.reason.includes("feature-request"),
      `reason must mention feature-request; got: ${body.reason}`
    );
  });

  it("explicit kind 'task-description' → develop", async () => {
    const res = await mutate(srv.port, "POST", "/api/runs/decide", {
      input: "Implement the OAuth flow described in the spec",
      kind: "task-description",
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { pipeline: string; reason: string };
    assert.equal(body.pipeline, "develop");
    assert.ok(
      body.reason.includes("task-description"),
      `reason must mention task-description; got: ${body.reason}`
    );
  });

  it("explicit kind 'review-request' → code-review", async () => {
    const res = await mutate(srv.port, "POST", "/api/runs/decide", {
      input: "have a look at what I just pushed",
      kind: "review-request",
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { pipeline: string; reason: string };
    assert.equal(body.pipeline, "code-review");
    assert.ok(
      body.reason.includes("review-request"),
      `reason must mention review-request; got: ${body.reason}`
    );
  });

  it("free text asking for a review of a branch → code-review", async () => {
    const res = await mutate(srv.port, "POST", "/api/runs/decide", {
      input: "review the changes on this branch",
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { pipeline: string; reason: string };
    assert.equal(
      body.pipeline,
      "code-review",
      `a review request must route without the caller naming a kind; got: ${body.pipeline}`
    );
  });

  it("artifact with spec+gateDecisions → develop", async () => {
    // Write a synthetic artifact file with the artifact signature.
    const artifactDir = join(makeState(projectDir).runsDir, "decide-src-001");
    mkdirSync(artifactDir, { recursive: true });
    const artifactPath = join(artifactDir, "spec-creation.json");
    writeFileSync(
      artifactPath,
      JSON.stringify({
        runId: "decide-src-001",
        pipelineId: "spec-creation",
        status: "succeeded",
        spec: { title: "My spec", description: "desc" },
        gateDecisions: [],
      }),
      "utf8"
    );

    const res = await mutate(srv.port, "POST", "/api/runs/decide", {
      input: artifactPath,
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { pipeline: string; reason: string };
    assert.equal(body.pipeline, "develop");
    assert.ok(
      body.reason.includes("spec") && body.reason.includes("gateDecisions"),
      `reason must mention spec and gateDecisions; got: ${body.reason}`
    );
  });

  it("path to non-existent file → 400", async () => {
    const res = await mutate(srv.port, "POST", "/api/runs/decide", {
      input: "/nonexistent/path/to/file.json",
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.ok(body.error.length > 0, "error must be non-empty");
  });

  it("missing input → 400", async () => {
    const res = await mutate(srv.port, "POST", "/api/runs/decide", {});
    assert.equal(res.status, 400);
  });
});

// ── FR-006: GET /api/runs/:id/manifest ────────────────────────────────────────

describe("FR-006: GET /api/runs/:id/manifest — manifest HTTP route", () => {
  let srv: ServeHandle;
  let tmpDir: string;
  let projectDir: string;
  let state: ProjectState;

  before(async () => {
    tmpDir = realpathSync(mkdtempSync(join(tmpdir(), "af-manifest-http-")));
    projectDir = join(tmpDir, "project");
    mkdirSync(projectDir, { recursive: true });
    state = makeState(projectDir, tmpDir);
  });
  after(async () => {
    await srv.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns 404 before the manifest is written", async () => {
    // A mock run that completes immediately.
    const runId = "run-manifest-http-notyet";
    const mockRun = makeMockRun(runId, successResult(), successResult());

    // Server started with a RunService that has no projectDir → no artifacts written.
    srv = await startServer({
      port: 0,
      dbPath: ":memory:",
      pipelinesDir: REAL_PIPELINES_DIR,
      projectDir,
      state,
      runService: new RunService(makeMastra(mockRun)),
    });

    // Start the run.
    const startRes = await mutate(srv.port, "POST", "/api/runs", {
      pipeline: "investigate",
      inputs: { request: "test" },
    });
    assert.equal(startRes.status, 200);
    const { runId: returnedId } = (await startRes.json()) as { runId: string };

    const manifestRes = await fetch(
      `http://127.0.0.1:${srv.port}/api/runs/${encodeURIComponent(returnedId)}/manifest`
    );
    // No projectDir → no artifact → manifest not written → 404.
    assert.equal(manifestRes.status, 404);
  });

  it("returns the manifest after the run settles", async () => {
    const runId = "run-manifest-http-settled";
    const mockRun = makeMockRun(runId, successResult(), successResult());
    const profile = { id: "test-profile", roles: { reasoner: "m", worker: "m", scout: "m" } };

    const service = new RunService(makeMastra(mockRun), undefined, state.runsDir, profile);
    const srv2 = await startServer({
      port: 0,
      dbPath: ":memory:",
      pipelinesDir: REAL_PIPELINES_DIR,
      projectDir,
      state,
      runService: service,
    });

    try {
      await mutate(srv2.port, "POST", "/api/runs", {
        pipeline: "investigate",
        inputs: { request: "test" },
      });

      // Wait for the fire-and-forget artifact + manifest writes to complete.
      await new Promise<void>((resolve) => setTimeout(resolve, 100));

      const manifestRes = await fetch(
        `http://127.0.0.1:${srv2.port}/api/runs/${encodeURIComponent(runId)}/manifest`
      );
      assert.equal(
        manifestRes.status,
        200,
        `manifest route must return 200; body: ${await manifestRes.clone().text()}`
      );
      const manifest = (await manifestRes.json()) as {
        runId: string;
        stages: { stageId: string }[];
      };
      assert.equal(manifest.runId, runId);
      assert.equal(manifest.stages.length, 1);
      assert.equal(manifest.stages[0].stageId, "investigate");
    } finally {
      await srv2.close();
    }
  });

  it("returns 404 for an unknown run id", async () => {
    // srv is still alive from the first test.
    const manifestRes = await fetch(
      `http://127.0.0.1:${srv.port}/api/runs/nonexistent-run-id/manifest`
    );
    assert.equal(manifestRes.status, 404);
  });
});

// ── FR-006: GET /api/runs/:id/manifest — disk fallback after daemon restart ───
//
// This is the scenario that the live defect (ae3eff75 404) required but was
// missing: the registry is empty, the chain directory is on disk, and the
// manifest must be served directly from there.
//
// To see the disk-read test go RED: change the manifest handler in server.ts
// to re-add the `requireRunService` + `runService.getManifestPath(id)` guard
// (restoring the old registry-only path). The "returns manifest from disk" test
// will fail with 404 instead of 200 — the run is not in the registry.
//
// To see the traversal-guard test go RED: remove the `if (!isSafeId(id))`
// check in the manifest handler. The traversal-id test will fail with 404
// instead of 400 — the check never runs and the id reaches existsSync.

describe("FR-006: GET /api/runs/:id/manifest — disk fallback, no live run required", () => {
  let srv: ServeHandle;
  let tmpDir: string;
  let projectDir: string;
  let state: ProjectState;

  before(async () => {
    tmpDir = realpathSync(mkdtempSync(join(tmpdir(), "af-manifest-disk-")));
    projectDir = join(tmpDir, "project");
    mkdirSync(projectDir, { recursive: true });
    state = makeState(projectDir, tmpDir);
    // Registry has never seen any of the run ids used in this suite.
    srv = await startServer({
      port: 0,
      dbPath: ":memory:",
      pipelinesDir: REAL_PIPELINES_DIR,
      projectDir,
      state,
      runService: new RunService(
        makeMastra(makeMockRun("unrelated-run", successResult(), successResult()))
      ),
    });
  });
  after(async () => {
    await srv.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns manifest from disk when the run is not in the registry", async () => {
    // Produce a chain directory the way a real daemon would — write the manifest
    // and one stage artifact directly. The registry has never seen this runId.
    const runId = "ae3eff75-dead-beef-cafe-000000000001";
    const runDir = join(state.runsDir, runId);
    mkdirSync(runDir, { recursive: true });

    const artifactPath = join(runDir, "spec-creation.json");
    writeFileSync(
      artifactPath,
      JSON.stringify({
        status: "succeeded",
        spec: "the spec text",
        provenance: {
          pipelineId: "spec-creation",
          profileId: "anthropic",
          transportPerStep: {},
          startedAt: "2026-09-07T00:00:00.000Z",
          settledAt: "2026-09-07T00:01:00.000Z",
        },
      }),
      "utf8"
    );
    writeFileSync(
      join(runDir, "manifest.json"),
      JSON.stringify({
        runId,
        startedAt: "2026-09-07T00:00:00.000Z",
        status: "completed",
        stages: [
          {
            stageId: "spec-creation",
            artifactPath,
            profileId: "anthropic",
            status: "succeeded",
            settledAt: "2026-09-07T00:01:00.000Z",
          },
        ],
      }),
      "utf8"
    );

    const res = await fetch(
      `http://127.0.0.1:${srv.port}/api/runs/${encodeURIComponent(runId)}/manifest`
    );
    assert.equal(res.status, 200, `expected 200; body: ${await res.clone().text()}`);
    const body = (await res.json()) as { runId: string; stages: { stageId: string }[] };
    assert.equal(body.runId, runId);
    assert.equal(body.stages.length, 1);
    assert.equal(body.stages[0].stageId, "spec-creation");
  });

  it("returns 404 when no run directory exists on disk for the id", async () => {
    const res = await fetch(`http://127.0.0.1:${srv.port}/api/runs/no-such-run-abcdef123/manifest`);
    assert.equal(res.status, 404);
  });

  it("refuses run ids containing path-traversal characters", async () => {
    // Each of these ids must be rejected at the isSafeId guard, before any fs lookup.
    const badIds = ["../etc", "a/b", "a.b", "UPPER", "has space"];
    for (const bad of badIds) {
      const res = await fetch(
        `http://127.0.0.1:${srv.port}/api/runs/${encodeURIComponent(bad)}/manifest`
      );
      assert.equal(res.status, 400, `expected 400 for id ${JSON.stringify(bad)}`);
    }
  });
});

// ── FR-009: GET /api/runs/:id includes artifactPath ───────────────────────────

describe("FR-009: GET /api/runs/:id includes artifactPath after settlement", () => {
  let srv: ServeHandle;
  let tmpDir: string;
  let projectDir: string;
  let state: ProjectState;

  before(async () => {
    tmpDir = realpathSync(mkdtempSync(join(tmpdir(), "af-fr009-http-")));
    projectDir = join(tmpDir, "project");
    mkdirSync(projectDir, { recursive: true });
    state = makeState(projectDir, tmpDir);
  });
  after(async () => {
    await srv.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("artifactPath field appears in the GET response after the run completes", async () => {
    const runId = "run-fr009-http-001";
    const mockRun = makeMockRun(runId, successResult(), successResult());
    const profile = { id: "http-profile", roles: { reasoner: "m", worker: "m", scout: "m" } };
    const service = new RunService(makeMastra(mockRun), undefined, state.runsDir, profile);

    srv = await startServer({
      port: 0,
      dbPath: ":memory:",
      pipelinesDir: REAL_PIPELINES_DIR,
      projectDir,
      state,
      runService: service,
    });

    await mutate(srv.port, "POST", "/api/runs", {
      pipeline: "investigate",
      inputs: { request: "test" },
    });

    // Wait for the fire-and-forget artifact write to complete.
    await new Promise<void>((resolve) => setTimeout(resolve, 100));

    const getRes = await fetch(
      `http://127.0.0.1:${srv.port}/api/runs/${encodeURIComponent(runId)}`
    );
    assert.equal(getRes.status, 200);
    const runState = (await getRes.json()) as { status: string; artifactPath?: string };
    assert.equal(runState.status, "succeeded");
    assert.ok(
      typeof runState.artifactPath === "string",
      `artifactPath must be present in GET /api/runs/:id after settlement; got: ${JSON.stringify(runState.artifactPath)}`
    );
    assert.ok(
      runState.artifactPath.startsWith(state.runsDir),
      `artifactPath must live under the state dir; got: ${runState.artifactPath}`
    );
    assert.ok(
      runState.artifactPath.endsWith("investigate.json"),
      `artifactPath must end with investigate.json; got: ${runState.artifactPath}`
    );
  });
});

// ── Run cancellation (spec 033 D2/FR-005/FR-003) ─────────────────────────────

/** A run whose step never finishes on its own, so the run stays "running". */
function makePendingRun(runId: string): MockRun & { cancel: () => Promise<void> } {
  const watchers: WatchCallback[] = [];
  return {
    runId,
    watchers,
    start: () => new Promise<Record<string, unknown>>(() => undefined),
    resume: async () => successResult(),
    watch: (cb) => {
      watchers.push(cb);
      return () => {
        const i = watchers.indexOf(cb);
        if (i !== -1) watchers.splice(i, 1);
      };
    },
    emit: (event) => {
      for (const cb of watchers) cb(event);
    },
    cancel: async () => undefined,
  };
}

/** A Mastra mock that hands out a different run object per createRun() call. */
function makeMastraQueue(runs: MockRun[]): MastraLike {
  const queue = [...runs];
  return {
    getWorkflow: (_id) => ({
      createRun: async () =>
        queue.shift() as unknown as Awaited<
          ReturnType<ReturnType<MastraLike["getWorkflow"]>["createRun"]>
        >,
    }),
  };
}

describe("POST /api/runs/:id/cancel", () => {
  let srv: ServeHandle;
  let service: RunService;
  let pendingRun: MockRun;
  let runningId: string;
  let doneId: string;

  before(async () => {
    pendingRun = makePendingRun("cancel-http-running");
    const doneRun = makeMockRun("cancel-http-done", successResult(), successResult());
    service = new RunService(makeMastraQueue([pendingRun, doneRun]));
    runningId = (await service.start("spec-creation", { request: "a" })).runId;
    doneId = (await service.start("spec-creation", { request: "b" })).runId;
    await service.waitForSettled(doneId);

    srv = await startServer({
      state: makeState(REAL_REPO_ROOT),
      port: 0,
      dbPath: ":memory:",
      pipelinesDir: REAL_PIPELINES_DIR,
      runService: service,
    });
  });
  after(async () => srv.close());

  it("204 for a running run, 409 for the second call", async () => {
    const sse = await fetch(`http://127.0.0.1:${srv.port}/api/runs/${runningId}/events`);
    const reader = sse.body!.getReader();
    const decoder = new TextDecoder();
    await reader.read(); // snapshot

    pendingRun.emit({ type: "workflow-step-start", payload: { id: "intake" } });
    await reader.read(); // step-start

    const res = await mutate(srv.port, "POST", `/api/runs/${runningId}/cancel`, {
      reason: "operator stopped it",
    });
    assert.equal(res.status, 204, "cancelling a running run must answer 204");

    // FR-003: the synthetic step-cancelled event reaches the SSE stream.
    const { value } = await reader.read();
    const chunk = decoder.decode(value);
    assert.ok(chunk.includes("event: step"), `expected a step event, got ${JSON.stringify(chunk)}`);
    assert.ok(chunk.includes('"stepId":"intake"'));
    assert.ok(
      chunk.includes('"status":"cancelled"'),
      "step-cancelled must map to status 'cancelled' over SSE"
    );
    await reader.cancel();

    const second = await mutate(srv.port, "POST", `/api/runs/${runningId}/cancel`, {});
    assert.equal(second.status, 409, "a second cancel must be refused");
    const body = (await second.json()) as { error: string; status: string };
    assert.equal(body.status, "cancelled", "the 409 body must name the current status");
    assert.match(body.error, /cancelled/);
  });

  it("409 for a run that already succeeded", async () => {
    const res = await mutate(srv.port, "POST", `/api/runs/${doneId}/cancel`, {});
    assert.equal(res.status, 409);
    const body = (await res.json()) as { status: string };
    assert.equal(body.status, "succeeded");
  });

  it("404 for an unknown run id", async () => {
    const res = await mutate(srv.port, "POST", "/api/runs/no-such-run/cancel", {});
    assert.equal(res.status, 404);
  });

  it("GET /api/runs/:id reports the cancelled run and its step timestamps", async () => {
    const res = await fetch(`http://127.0.0.1:${srv.port}/api/runs/${runningId}`);
    assert.equal(res.status, 200);
    const state = (await res.json()) as {
      status: string;
      cancelled?: { at: string; reason?: string };
      steps: Record<string, { status: string; startedAt?: string; finishedAt?: string }>;
    };
    assert.equal(state.status, "cancelled");
    assert.equal(state.cancelled?.reason, "operator stopped it");
    assert.ok(state.cancelled?.at, "cancelled.at must be present");
    const step = state.steps.intake;
    assert.equal(step?.status, "cancelled");
    assert.ok(step.startedAt, "steps must carry startedAt — spec 033 D3");
    assert.ok(step.finishedAt, "a cancelled step must carry finishedAt — spec 033 D3");
  });
});

// ── Port resolution and EADDRINUSE (spec 033 D4/FR-011/FR-012) ───────────────

describe("resolvePortChoice — --port, then AGENT_FLOWS_PORT, then 7411 (spec 038 FR-012)", () => {
  it("uses AGENT_FLOWS_PORT when --port is absent, and calls it explicit", () => {
    assert.deepEqual(resolvePortChoice(["node", "server.ts"], { AGENT_FLOWS_PORT: "8123" }), {
      port: 8123,
      explicit: true,
    });
  });

  it("--port wins over AGENT_FLOWS_PORT", () => {
    assert.deepEqual(
      resolvePortChoice(["node", "server.ts", "--port", "9001"], { AGENT_FLOWS_PORT: "8123" }),
      { port: 9001, explicit: true }
    );
  });

  it("falls back to 7411 — not explicit, so a taken port steps aside", () => {
    assert.deepEqual(resolvePortChoice(["node", "server.ts"], {}), {
      port: DEFAULT_PORT,
      explicit: false,
    });
  });

  it("an auto-started daemon always takes an ephemeral port", () => {
    assert.deepEqual(resolvePortChoice(["node", "server.ts"], { [AUTOSTART_ENV]: "1" }), {
      port: 0,
      explicit: false,
    });
  });

  it("an explicit port still wins for an auto-started daemon", () => {
    assert.deepEqual(
      resolvePortChoice(["node", "server.ts", "--port", "9100"], { [AUTOSTART_ENV]: "1" }),
      { port: 9100, explicit: true }
    );
  });

  it("an empty AGENT_FLOWS_PORT counts as unset", () => {
    assert.deepEqual(resolvePortChoice(["node", "server.ts"], { AGENT_FLOWS_PORT: "" }), {
      port: DEFAULT_PORT,
      explicit: false,
    });
  });
});

describe("resolvePortChoice — an unusable port exits 1 instead of reaching listen()", () => {
  class Exit extends Error {}

  function failingIo(): { printed: string[]; exited: number[]; io: CliIo } {
    const printed: string[] = [];
    const exited: number[] = [];
    return {
      printed,
      exited,
      io: {
        error: (m) => printed.push(m),
        exit: (code) => {
          exited.push(code);
          throw new Exit();
        },
      },
    };
  }

  for (const [label, argv, env, bad] of [
    ["--port abc", ["node", "server.ts", "--port", "abc"], {}, "abc"],
    ["AGENT_FLOWS_PORT=abc", ["node", "server.ts"], { AGENT_FLOWS_PORT: "abc" }, "abc"],
    ["--port 70000", ["node", "server.ts", "--port", "70000"], {}, "70000"],
    ["--port 0", ["node", "server.ts", "--port", "0"], {}, "0"],
  ] as [string, string[], NodeJS.ProcessEnv, string][]) {
    it(`rejects ${label}`, () => {
      const { printed, exited, io } = failingIo();
      assert.throws(() => resolvePortChoice(argv, env, io), Exit);
      assert.deepEqual(exited, [1], "an unusable port must exit 1");
      assert.deepEqual(printed, [portInvalidMessage(bad)]);
    });
  }

  it("the message names the value and the allowed range", () => {
    assert.equal(
      portInvalidMessage("abc"),
      'agent-flows serve: invalid port "abc" — pass --port <1-65535> or set AGENT_FLOWS_PORT'
    );
  });
});

describe("handleListenError — EADDRINUSE exits 1 with an operator message (FR-012)", () => {
  it("prints the exact message and exits 1", () => {
    const printed: string[] = [];
    const exited: number[] = [];
    class Exit extends Error {}
    const err = Object.assign(new Error("listen EADDRINUSE"), { code: "EADDRINUSE" });

    assert.throws(
      () =>
        handleListenError(err, 7411, {
          error: (m) => printed.push(m),
          exit: (code) => {
            exited.push(code);
            throw new Exit();
          },
        }),
      Exit
    );

    assert.deepEqual(exited, [1], "EADDRINUSE must exit 1");
    assert.deepEqual(printed, [
      "agent-flows serve: port 7411 is already in use — is another agent-flows daemon running? Pass --port <other> or stop it.",
    ]);
  });

  it("rethrows any other listen error untouched", () => {
    const err = Object.assign(new Error("listen EACCES"), { code: "EACCES" });
    assert.throws(
      () =>
        handleListenError(err, 7411, {
          error: () => undefined,
          exit: () => {
            throw new Error("must not exit");
          },
        }),
      /EACCES/
    );
  });
});

describe("agent-flows serve on a taken port — live CLI (V4)", () => {
  it("prints the port-in-use message on stderr and exits 1", async () => {
    // Reserve a port with a plain socket server so the daemon's listen fails.
    const blocker = createNetServer();
    const port = await new Promise<number>((resolve) => {
      blocker.listen(0, "127.0.0.1", () => {
        resolve((blocker.address() as { port: number }).port);
      });
    });

    const tmpHome = mkdtempSync(join(realpathSync(tmpdir()), "af-port-"));
    try {
      const child = spawn(
        process.execPath,
        ["--import", "tsx", join(REAL_REPO_ROOT, "src/serve/server.ts"), "--port", String(port)],
        {
          cwd: REAL_REPO_ROOT,
          env: {
            ...process.env,
            AGENT_FLOWS_HOME: tmpHome,
            AGENT_FLOWS_PROJECT_DIR: REAL_REPO_ROOT,
          },
        }
      );
      let stderr = "";
      child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
      child.stdout.resume();

      const code = await new Promise<number | null>((resolve) => {
        child.on("exit", (c) => resolve(c));
      });

      assert.equal(code, 1, `daemon must exit 1 on a taken port; stderr was:\n${stderr}`);
      assert.ok(
        stderr.includes(portInUseMessage(port)),
        `stderr must carry the port-in-use message; got:\n${stderr}`
      );
      assert.ok(!stderr.includes("at Server."), "no stack trace may be printed");
    } finally {
      rmSync(tmpHome, { recursive: true, force: true });
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });
});

// ── FR-010 legacy database notice (spec 032 review follow-up) ────────────────

describe("legacyDbNotice", () => {
  const cwd = "/proj";
  const legacy = join(cwd, "agent-flows.sqlite");
  const stateDb = "/home/.agent-flows/projects/proj/agent-flows.sqlite";

  it("warns when a legacy db exists and the state db does not", () => {
    const notice = legacyDbNotice(cwd, stateDb, stateDb, (p) => p === legacy);
    assert.ok(notice, "an unmigrated legacy db must be reported");
    assert.match(notice, /NOT migrated/);
    assert.ok(notice.includes(legacy) && notice.includes(stateDb));
  });

  it("stays silent when --db already points at the legacy database", () => {
    assert.equal(
      legacyDbNotice(cwd, legacy, stateDb, (p) => p === legacy),
      undefined,
      "telling the operator to pass the --db they just passed is noise"
    );
  });

  it("stays silent once the state db exists", () => {
    assert.equal(
      legacyDbNotice(cwd, stateDb, stateDb, () => true),
      undefined
    );
  });

  it("stays silent when there is no legacy db", () => {
    assert.equal(
      legacyDbNotice(cwd, stateDb, stateDb, () => false),
      undefined
    );
  });
});

// ── Spec 037 Ship 2: catalogue routes ────────────────────────────────────────

describe("GET /api/pipelines?source=bundled — the shipped catalogue (037 FR-002)", () => {
  let srv: ServeHandle;
  let tmpDir: string;
  let projectDir: string;
  let projectPipelines: string;

  before(async () => {
    tmpDir = realpathSync(mkdtempSync(join(tmpdir(), "agent-flows-source-")));
    projectDir = join(tmpDir, "project");
    projectPipelines = join(projectDir, ".agent-flows", "pipelines");
    mkdirSync(projectPipelines, { recursive: true });
    // One project pipeline with a shape no bundled workflow has, so the two
    // branches of the route are told apart by their content, not their size.
    writeFileSync(
      join(projectPipelines, "solo.yaml"),
      [
        "id: solo",
        "version: 1",
        "description: the only project workflow",
        "inputs: [task, extra]",
        "steps:",
        "  - id: start",
        "    kind: gate",
      ].join("\n"),
      "utf8"
    );
    srv = await startServer({
      state: makeState(projectDir),
      port: 0,
      dbPath: ":memory:",
      pipelinesDir: projectPipelines,
      bundledPipelinesDir: REAL_PIPELINES_DIR,
      projectDir,
    });
  });
  after(async () => {
    await srv.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const list = async (query: string): Promise<Response> =>
    fetch(`http://127.0.0.1:${srv.port}/api/pipelines${query}`);

  it("without the parameter the route still lists the project's own pipelines", async () => {
    const res = await list("");
    assert.equal(res.status, 200);
    const body = (await res.json()) as { pipelines: { id: string }[] };
    assert.deepEqual(
      body.pipelines.map((p) => p.id),
      ["solo"]
    );
  });

  it("?source=bundled lists the shipped catalogue regardless of the project", async () => {
    const res = await list("?source=bundled");
    assert.equal(res.status, 200);
    const body = (await res.json()) as { pipelines: { id: string }[] };
    const ids = body.pipelines.map((p) => p.id);
    assert.ok(
      ids.includes("spec-creation"),
      `bundled listing must carry spec-creation: ${ids.join(", ")}`
    );
    assert.ok(!ids.includes("solo"), "the project's own pipeline is not part of the catalogue");
  });

  it("every row carries the step count and declared inputs, in both branches", async () => {
    const project = (await (await list("")).json()) as {
      pipelines: { id: string; steps: number; inputs: string[] }[];
    };
    assert.equal(project.pipelines[0].steps, 1);
    assert.deepEqual(project.pipelines[0].inputs, ["task", "extra"]);

    const bundled = (await (await list("?source=bundled")).json()) as {
      pipelines: { id: string; steps: number; inputs: string[] }[];
    };
    for (const row of bundled.pipelines) {
      assert.equal(typeof row.steps, "number", `${row.id} must carry a step count`);
      assert.ok(row.steps > 0, `${row.id} must have at least one step`);
      assert.ok(Array.isArray(row.inputs), `${row.id} must carry an inputs array`);
    }
  });

  it("any other source value is a 400, never a directory name", async () => {
    for (const value of ["project", "../../etc", "", "BUNDLED"]) {
      const res = await list(`?source=${encodeURIComponent(value)}`);
      assert.equal(res.status, 400, `source=${value} must be rejected`);
      const body = (await res.json()) as { error: string };
      assert.equal(body.error, "invalid source");
    }
  });

  it("the detail route takes the same parameter, with the same enum rule", async () => {
    const ok = await fetch(
      `http://127.0.0.1:${srv.port}/api/pipelines/spec-creation?source=bundled`
    );
    assert.equal(ok.status, 200, "a bundled definition is readable without installing it");
    const missing = await fetch(`http://127.0.0.1:${srv.port}/api/pipelines/spec-creation`);
    assert.equal(missing.status, 404, "it is not in the project, so the plain route 404s");
    const bad = await fetch(`http://127.0.0.1:${srv.port}/api/pipelines/solo?source=nope`);
    assert.equal(bad.status, 400);
  });
});

describe("POST /api/runs — the provider is validated against the snapshot the steps use", () => {
  let srv: ServeHandle;
  let tmpDir: string;

  before(async () => {
    tmpDir = realpathSync(mkdtempSync(join(tmpdir(), "agent-flows-provider-snapshot-")));
    // providers.yaml on disk declares a profile the running workflows were NOT
    // built with — exactly the state after an edit without a daemon restart.
    mkdirSync(join(tmpDir, ".agent-flows"), { recursive: true });
    writeFileSync(
      join(tmpDir, ".agent-flows", "providers.yaml"),
      [
        "profiles:",
        "  added-after-startup:",
        "    reasoner: claude-opus-4-1",
        "    worker: claude-sonnet-4-5",
        "    scout: claude-haiku-4-5",
      ].join("\n") + "\n",
      "utf8"
    );
    srv = await startServer({
      state: makeState(tmpDir),
      port: 0,
      dbPath: ":memory:",
      pipelinesDir: REAL_PIPELINES_DIR,
      bundledPipelinesDir: REAL_PIPELINES_DIR,
      projectDir: tmpDir,
      // The startup snapshot: no project profiles at all.
      providerProfiles: [],
      runService: new RunService(
        makeMastra(makeMockRun("run-provider-snapshot-01", successResult(), successResult()))
      ),
    });
  });
  after(async () => {
    await srv.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("a profile added to providers.yaml after startup is refused at the boundary, not mid-run", async () => {
    const res = await mutate(srv.port, "POST", "/api/runs", {
      pipeline: "investigate",
      inputs: { request: "t" },
      provider: "added-after-startup",
    });
    assert.equal(
      res.status,
      400,
      "a profile the running workflows cannot resolve must fail at the boundary"
    );
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /added-after-startup/);
  });

  it("a built-in profile is still accepted", async () => {
    const res = await mutate(srv.port, "POST", "/api/runs", {
      pipeline: "investigate",
      inputs: { request: "t" },
      provider: "anthropic",
    });
    assert.equal(res.status, 200, `expected 200, got ${res.status}`);
  });
});

describe("POST /api/runs — inputs and model overrides are validated (037 FR-009)", () => {
  let srv: ServeHandle;
  let tmpDir: string;

  before(async () => {
    tmpDir = realpathSync(mkdtempSync(join(tmpdir(), "agent-flows-run-validate-")));
    srv = await startServer({
      state: makeState(tmpDir),
      port: 0,
      dbPath: ":memory:",
      pipelinesDir: REAL_PIPELINES_DIR,
      bundledPipelinesDir: REAL_PIPELINES_DIR,
      projectDir: tmpDir,
      runService: new RunService(
        makeMastra(makeMockRun("run-validate-01", successResult(), successResult()))
      ),
    });
  });
  after(async () => {
    await srv.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const start = async (body: Record<string, unknown>): Promise<Response> =>
    mutate(srv.port, "POST", "/api/runs", { pipeline: "investigate", ...body });

  it("a non-string input value is a 400 naming the key", async () => {
    const res = await start({ inputs: { task: { nested: "object" } } });
    assert.equal(res.status, 400, `expected 400, got ${res.status}`);
    const body = (await res.json()) as { error: string };
    assert.ok(body.error.includes("task"), `the error must name the key: ${body.error}`);
  });

  it("a models map that is not a flat object is a 400", async () => {
    const res = await start({ inputs: { task: "t" }, models: ["gpt"] });
    assert.equal(res.status, 400);
  });

  it("a model override for a step the pipeline does not have is a 400 naming the key", async () => {
    const res = await start({ inputs: { task: "t" }, models: { "no-such-step": "opus" } });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.ok(body.error.includes("no-such-step"), `the error must name the key: ${body.error}`);
  });

  it("a model id that is not registry-shaped is a 400 naming the step", async () => {
    const def = (await (
      await fetch(`http://127.0.0.1:${srv.port}/api/pipelines/investigate`)
    ).json()) as { def: { steps: { id: string }[] } };
    const stepId = def.def.steps[0].id;
    const res = await start({
      inputs: { task: "t" },
      models: { [stepId]: "not a model id; rm -rf" },
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.ok(body.error.includes(stepId), `the error must name the step: ${body.error}`);
  });

  it("a well-formed override for a real step is accepted", async () => {
    const def = (await (
      await fetch(`http://127.0.0.1:${srv.port}/api/pipelines/investigate`)
    ).json()) as { def: { steps: { id: string }[] } };
    const stepId = def.def.steps[0].id;
    const res = await start({
      inputs: { request: "t" },
      models: { [stepId]: "claude-sonnet-4-5" },
    });
    assert.equal(res.status, 200, `expected 200, got ${res.status}`);
  });

  it("an unknown pipeline name is truncated in the models error, like the keys are", async () => {
    const longName = "z".repeat(500);
    const res = await mutate(srv.port, "POST", "/api/runs", {
      pipeline: longName,
      inputs: {},
      models: { some: "claude-sonnet-4-5" },
    });
    assert.equal(res.status, 400, `expected 400, got ${res.status}`);
    const body = (await res.json()) as { error: string };
    assert.ok(
      !body.error.includes(longName),
      `the error must not echo the whole caller-supplied name: ${body.error.length} chars`
    );
    assert.ok(
      body.error.includes("z".repeat(100)),
      `the error must still name the first 100 chars: ${body.error}`
    );
  });
});

// ── 037 Ship 3: the editor's routes ───────────────────────────────────────────

/**
 * A temp project laid out the way loadPipeline expects — `<root>/pipelines/*.yaml`
 * beside `<root>/prompts/*.md` — plus the two hostile prompt targets FR-005 has
 * to refuse: a file outside `prompts/` that the loader's own containment
 * accepts, and a non-`.md` file inside it.
 */
function makeEditorProject(): { tmpRoot: string; pipelinesDir: string } {
  const tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), "agent-flows-editor-")));
  const pipelinesDir = join(tmpRoot, "pipelines");
  mkdirSync(pipelinesDir);
  for (const yml of ["spec-creation.yaml", "audit.yaml", "correct-plan.yaml"]) {
    writeFileSync(join(pipelinesDir, yml), readFileSync(join(REAL_REPO_ROOT, "pipelines", yml)));
  }
  cpSync(join(REAL_REPO_ROOT, "prompts"), join(tmpRoot, "prompts"), { recursive: true });

  // The loader accepts any path under the pipeline root, providers.yaml
  // included — this pipeline is what proves the write route does not.
  writeFileSync(join(tmpRoot, "providers.yaml"), "profiles: {}\n");
  writeFileSync(
    join(pipelinesDir, "outside-prompt.yaml"),
    "id: outside-prompt\nversion: 1\ndescription: prompt outside prompts/\ninputs: []\n" +
      "steps:\n  - id: only\n    kind: llm\n    role: worker\n    prompt: providers.yaml\n"
  );
  // An llm-only workflow: Binding A could generate a script for it, so it is
  // the one that proves the save route generates nothing at all.
  writeFileSync(join(tmpRoot, "prompts", "simple.md"), "{{request}}\n");
  writeFileSync(
    join(pipelinesDir, "simple.yaml"),
    "id: simple\nversion: 1\ndescription: one llm step\ninputs:\n  - request\n" +
      "steps:\n  - id: only\n    kind: llm\n    role: worker\n    prompt: prompts/simple.md\n"
  );

  writeFileSync(join(tmpRoot, "prompts", "evil.yaml"), "not markdown\n");
  writeFileSync(
    join(pipelinesDir, "yaml-prompt.yaml"),
    "id: yaml-prompt\nversion: 1\ndescription: non-md prompt inside prompts/\ninputs: []\n" +
      "steps:\n  - id: only\n    kind: llm\n    role: worker\n    prompt: prompts/evil.yaml\n" +
      "  - id: after\n    kind: gate\n    dependsOn: [only]\n"
  );
  return { tmpRoot, pipelinesDir };
}

/** mtime + content of every file under `dir`, for the no-write assertions. */
function fileSnapshot(dir: string): Map<string, string> {
  const snapshot = new Map<string, string>();
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const st = statSync(full);
      snapshot.set(full, `${st.mtimeMs}:${readFileSync(full, "utf8")}`);
    }
  };
  walk(dir);
  return snapshot;
}

function assertSnapshotEqual(before: Map<string, string>, after: Map<string, string>): void {
  const changed = [...after].filter(([p, v]) => before.get(p) !== v).map(([p]) => p);
  const removed = [...before.keys()].filter((p) => !after.has(p));
  assert.deepEqual(changed, [], `no file may change: ${changed.join(", ")}`);
  assert.deepEqual(removed, [], `no file may be removed: ${removed.join(", ")}`);
}

describe("GET /api/pipelines/:id/prompts — the editable prompt files (037 D6)", () => {
  let srv: ServeHandle;
  let tmpRoot: string;

  before(async () => {
    const project = makeEditorProject();
    tmpRoot = project.tmpRoot;
    srv = await startServer({
      state: makeState(REAL_REPO_ROOT),
      port: 0,
      dbPath: ":memory:",
      pipelinesDir: project.pipelinesDir,
      bundledPipelinesDir: REAL_PIPELINES_DIR,
    });
  });
  after(async () => {
    await srv.close();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("lists the pipeline's own llm steps with path, text and sha256", async () => {
    const res = await fetch(`http://127.0.0.1:${srv.port}/api/pipelines/spec-creation/prompts`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, { path: string; text: string; hash: string }>;
    assert.deepEqual(Object.keys(body).sort(), ["critic", "enrich", "intake", "security"]);
    assert.equal(body.intake.path, join("prompts", "intake.md"));
    assert.equal(body.intake.text, readFileSync(join(tmpRoot, "prompts", "intake.md"), "utf8"));
    assert.equal(
      body.intake.hash,
      createHash("sha256").update(body.intake.text).digest("hex"),
      "hash must be the sha256 of the file content"
    );
  });

  it("a nested pipeline's steps are absent — they belong to another file", async () => {
    const res = await fetch(`http://127.0.0.1:${srv.port}/api/pipelines/spec-creation/prompts`);
    const body = (await res.json()) as Record<string, unknown>;
    const namespaced = Object.keys(body).filter((k) => k.includes("."));
    assert.deepEqual(namespaced, [], `namespaced ids must not be listed: ${namespaced.join(", ")}`);
    assert.equal(body.synthesis, undefined, "a step of the nested audit must not be listed");
  });

  it("an unknown pipeline is a 404", async () => {
    const res = await fetch(`http://127.0.0.1:${srv.port}/api/pipelines/no-such/prompts`);
    assert.equal(res.status, 404);
  });

  it("a step whose prompt is outside prompts/ is omitted — the file is never read", async () => {
    const res = await fetch(`http://127.0.0.1:${srv.port}/api/pipelines/outside-prompt/prompts`);
    assert.equal(res.status, 200);
    const raw = await res.text();
    const body = JSON.parse(raw) as Record<string, unknown>;
    assert.equal(body.only, undefined, `providers.yaml must not be listed: ${raw}`);
    assert.deepEqual(Object.keys(body), [], "the pipeline has no editable prompt at all");
    const secret = readFileSync(join(tmpRoot, "providers.yaml"), "utf8").trim();
    assert.ok(!raw.includes(secret), `the file's text must not reach the client: ${raw}`);
  });

  it("a step whose prompt is a non-.md file inside prompts/ is omitted", async () => {
    const res = await fetch(`http://127.0.0.1:${srv.port}/api/pipelines/yaml-prompt/prompts`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.only, undefined, "prompts/evil.yaml must not be listed");
  });
});

describe("PUT /api/pipelines/:id/prompts/:stepId — the only prompt write route (037 FR-005)", () => {
  let srv: ServeHandle;
  let tmpRoot: string;
  let pipelinesDir: string;

  const hashOf = (p: string): string =>
    createHash("sha256").update(readFileSync(p, "utf8")).digest("hex");

  before(async () => {
    const project = makeEditorProject();
    tmpRoot = project.tmpRoot;
    pipelinesDir = project.pipelinesDir;
    srv = await startServer({
      state: makeState(REAL_REPO_ROOT),
      port: 0,
      dbPath: ":memory:",
      pipelinesDir,
      bundledPipelinesDir: REAL_PIPELINES_DIR,
    });
  });
  after(async () => {
    await srv.close();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("writes exactly the referenced file and leaves every sibling untouched", async () => {
    const target = join(tmpRoot, "prompts", "intake.md");
    const before = fileSnapshot(tmpRoot);
    before.delete(target);
    const text = `${readFileSync(target, "utf8")}\n<!-- edited by the editor -->\n`;
    const res = await mutate(srv.port, "PUT", "/api/pipelines/spec-creation/prompts/intake", {
      text,
      ifMatch: hashOf(target),
    });
    assert.equal(res.status, 200, `expected 200, got ${res.status}`);
    const body = (await res.json()) as { ok: boolean; hash: string };
    assert.equal(body.ok, true);
    assert.equal(readFileSync(target, "utf8"), text, "the prompt file must hold the new text");
    assert.equal(body.hash, hashOf(target), "the returned hash must be the new file's sha256");
    const after = fileSnapshot(tmpRoot);
    after.delete(target);
    assertSnapshotEqual(before, after);
  });

  it("a stale ifMatch is a 409 and the file is unchanged", async () => {
    const target = join(tmpRoot, "prompts", "enrich.md");
    const original = readFileSync(target, "utf8");
    const res = await mutate(srv.port, "PUT", "/api/pipelines/spec-creation/prompts/enrich", {
      text: "replaced",
      ifMatch: "0".repeat(64),
    });
    assert.equal(res.status, 409, `expected 409, got ${res.status}`);
    assert.equal(readFileSync(target, "utf8"), original, "a conflict must write nothing");
  });

  it("an unknown placeholder is a 422 carrying the loader's message, and writes nothing", async () => {
    const target = join(tmpRoot, "prompts", "enrich.md");
    const original = readFileSync(target, "utf8");
    const res = await mutate(srv.port, "PUT", "/api/pipelines/spec-creation/prompts/enrich", {
      text: "{{nonesuch}}",
      ifMatch: hashOf(target),
    });
    assert.equal(res.status, 422, `expected 422, got ${res.status}`);
    const body = (await res.json()) as { error: string };
    assert.ok(
      body.error.includes("nonesuch"),
      `the message must name the placeholder: ${body.error}`
    );
    assert.equal(readFileSync(target, "utf8"), original, "an invalid prompt must not be written");
  });

  it("a prompt outside prompts/ is a 403 even though the loader accepts it", async () => {
    const target = join(tmpRoot, "providers.yaml");
    const original = readFileSync(target, "utf8");
    const res = await mutate(srv.port, "PUT", "/api/pipelines/outside-prompt/prompts/only", {
      text: "profiles: {owned: true}\n",
      ifMatch: hashOf(target),
    });
    assert.equal(res.status, 403, `expected 403, got ${res.status}`);
    assert.equal(readFileSync(target, "utf8"), original, "providers.yaml must be untouched");
  });

  it("a non-.md prompt inside prompts/ is a 403", async () => {
    const target = join(tmpRoot, "prompts", "evil.yaml");
    const original = readFileSync(target, "utf8");
    const res = await mutate(srv.port, "PUT", "/api/pipelines/yaml-prompt/prompts/only", {
      text: "owned\n",
      ifMatch: hashOf(target),
    });
    assert.equal(res.status, 403, `expected 403, got ${res.status}`);
    assert.equal(readFileSync(target, "utf8"), original, "the .yaml must be untouched");
  });

  it("a namespaced nested-pipeline step id is a 404", async () => {
    const res = await mutate(
      srv.port,
      "PUT",
      "/api/pipelines/spec-creation/prompts/verify.synthesis",
      { text: "x", ifMatch: "0".repeat(64) }
    );
    assert.equal(res.status, 404, `expected 404, got ${res.status}`);
  });

  it("a step that is not an llm step is a 404", async () => {
    const res = await mutate(srv.port, "PUT", "/api/pipelines/yaml-prompt/prompts/after", {
      text: "x",
      ifMatch: "0".repeat(64),
    });
    assert.equal(res.status, 404, `expected 404, got ${res.status}`);
  });

  it("an unknown pipeline is a 404", async () => {
    const res = await mutate(srv.port, "PUT", "/api/pipelines/no-such/prompts/only", {
      text: "x",
      ifMatch: "0".repeat(64),
    });
    assert.equal(res.status, 404, `expected 404, got ${res.status}`);
  });
});

describe("prompt routes against the bundled catalogue are refused (037 FR-005)", () => {
  let srv: ServeHandle;
  let tmpDir: string;

  before(async () => {
    tmpDir = realpathSync(mkdtempSync(join(tmpdir(), "agent-flows-editor-bundled-")));
    srv = await startServer({
      state: makeState(REAL_REPO_ROOT),
      port: 0,
      dbPath: ":memory:",
      pipelinesDir: REAL_PIPELINES_DIR,
      bundledPipelinesDir: REAL_PIPELINES_DIR,
    });
  });
  after(async () => {
    await srv.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("GET the prompt map of a bundled workflow → 403", async () => {
    const res = await fetch(`http://127.0.0.1:${srv.port}/api/pipelines/investigate/prompts`);
    assert.equal(res.status, 403, `expected 403, got ${res.status}`);
  });

  it("PUT a bundled workflow's prompt → 403", async () => {
    const before = fileSnapshot(join(REAL_REPO_ROOT, "prompts"));
    const res = await mutate(srv.port, "PUT", "/api/pipelines/investigate/prompts/survey", {
      text: "owned",
      ifMatch: "0".repeat(64),
    });
    assert.equal(res.status, 403, `expected 403, got ${res.status}`);
    assertSnapshotEqual(before, fileSnapshot(join(REAL_REPO_ROOT, "prompts")));
  });
});

describe("POST /api/drafts/:id/preview — validate without writing (037 FR-004)", () => {
  let srv: ServeHandle;
  let tmpRoot: string;
  let pipelinesDir: string;

  const openDraftFor = async (id: string): Promise<{ draftId: number; body: string }> => {
    const res = await mutate(srv.port, "POST", `/api/pipelines/${id}/drafts`, {});
    assert.equal(res.status, 200);
    return (await res.json()) as { draftId: number; body: string };
  };

  before(async () => {
    const project = makeEditorProject();
    tmpRoot = project.tmpRoot;
    pipelinesDir = project.pipelinesDir;
    srv = await startServer({
      state: makeState(REAL_REPO_ROOT),
      port: 0,
      dbPath: ":memory:",
      pipelinesDir,
      bundledPipelinesDir: REAL_PIPELINES_DIR,
    });
  });
  after(async () => {
    await srv.close();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("returns def, levels and graph — and never the prompts it read", async () => {
    const { draftId, body } = await openDraftFor("spec-creation");
    const before = fileSnapshot(tmpRoot);
    const res = await mutate(srv.port, "POST", `/api/drafts/${draftId}/preview`, {
      prompts: { intake: "{{request}} edited in the editor" },
    });
    assert.equal(res.status, 200, `expected 200, got ${res.status}`);
    const payload = (await res.json()) as Record<string, unknown>;
    assert.deepEqual(Object.keys(payload).sort(), ["def", "graph", "levels"]);
    assert.equal((payload.def as { id: string }).id, "spec-creation");
    assert.ok(Array.isArray(payload.levels) && (payload.levels as unknown[]).length > 0);
    // The nested closure — audit.yaml, correct-plan.yaml and their prompts — is
    // read from disk during expansion, so it is part of the no-write proof.
    assertSnapshotEqual(before, fileSnapshot(tmpRoot));
    assert.ok(body.includes("spec-creation"), "the draft body is the file's own YAML");
  });

  it("an unknown placeholder is a 422 with the loader's message, and still writes nothing", async () => {
    const { draftId } = await openDraftFor("spec-creation");
    const before = fileSnapshot(tmpRoot);
    const res = await mutate(srv.port, "POST", `/api/drafts/${draftId}/preview`, {
      prompts: { intake: "{{nonesuch}}" },
    });
    assert.equal(res.status, 422, `expected 422, got ${res.status}`);
    const payload = (await res.json()) as { error: string };
    assert.ok(payload.error.includes("nonesuch"), `message must name it: ${payload.error}`);
    assertSnapshotEqual(before, fileSnapshot(tmpRoot));
  });

  it("a prompt text of half a megabyte is accepted where the default-limit route rejects it", async () => {
    const { draftId, body } = await openDraftFor("spec-creation");
    const big = `{{request}} ${"x".repeat(512 * 1024)}`;
    const preview = await mutate(srv.port, "POST", `/api/drafts/${draftId}/preview`, {
      prompts: { intake: big },
    });
    assert.equal(preview.status, 200, `preview must accept 1 MiB, got ${preview.status}`);
    const update = await mutate(srv.port, "PUT", `/api/drafts/${draftId}`, {
      body: `${body}\n# ${"x".repeat(512 * 1024)}\n`,
    });
    assert.equal(
      update.status,
      413,
      `the default-limit route must reject it, got ${update.status}`
    );
  });

  it("an unknown draft is a 404", async () => {
    const res = await mutate(srv.port, "POST", "/api/drafts/999999/preview", {});
    assert.equal(res.status, 404, `expected 404, got ${res.status}`);
  });

  it("save writes the YAML and no Claude Code script — Binding A is a CLI-only export", async () => {
    const { draftId, body } = await openDraftFor("simple");
    const update = await mutate(srv.port, "PUT", `/api/drafts/${draftId}`, { body });
    assert.equal(update.status, 200);
    const res = await mutate(srv.port, "POST", `/api/drafts/${draftId}/save`, {});
    assert.equal(res.status, 200, `expected 200, got ${res.status}`);
    const payload = (await res.json()) as Record<string, unknown>;
    assert.deepEqual(payload, { ok: true });
    assert.ok(
      !existsSync(join(tmpRoot, ".claude", "workflows", "simple.js")),
      "the save route must not write an executable at a YAML-controlled path"
    );
  });

  it("a workflow Binding A cannot generate saves like any other", async () => {
    const { draftId, body } = await openDraftFor("spec-creation");
    const update = await mutate(srv.port, "PUT", `/api/drafts/${draftId}`, { body });
    assert.equal(update.status, 200);
    const res = await mutate(srv.port, "POST", `/api/drafts/${draftId}/save`, {});
    assert.equal(res.status, 200, `expected 200, got ${res.status}`);
    const payload = (await res.json()) as Record<string, unknown>;
    assert.deepEqual(payload, { ok: true });
    assert.ok(!existsSync(join(tmpRoot, ".claude")), "no Binding A output at all");
  });
});

describe("draft routes against the bundled catalogue are refused (037 FR-005)", () => {
  let srv: ServeHandle;
  let tmpDir: string;

  before(async () => {
    tmpDir = realpathSync(mkdtempSync(join(tmpdir(), "agent-flows-drafts-bundled-")));
    srv = await startServer({
      state: makeState(REAL_REPO_ROOT),
      port: 0,
      dbPath: ":memory:",
      pipelinesDir: REAL_PIPELINES_DIR,
      bundledPipelinesDir: REAL_PIPELINES_DIR,
    });
  });
  after(async () => {
    await srv.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("POST a draft of a bundled workflow → 403 and the catalogue is untouched", async () => {
    const before = fileSnapshot(REAL_PIPELINES_DIR);
    const res = await mutate(srv.port, "POST", "/api/pipelines/investigate/drafts", {});
    assert.equal(res.status, 403, `expected 403, got ${res.status}`);
    assertSnapshotEqual(before, fileSnapshot(REAL_PIPELINES_DIR));
  });

  it("PUT a draft body → 403 before the draft is even looked up", async () => {
    const before = fileSnapshot(REAL_PIPELINES_DIR);
    const res = await mutate(srv.port, "PUT", "/api/drafts/1", { body: "id: owned\n" });
    assert.equal(res.status, 403, `expected 403, got ${res.status}`);
    assertSnapshotEqual(before, fileSnapshot(REAL_PIPELINES_DIR));
  });

  it("POST a draft save → 403 and no bundled YAML is rewritten", async () => {
    const before = fileSnapshot(REAL_PIPELINES_DIR);
    const res = await mutate(srv.port, "POST", "/api/drafts/1/save", {});
    assert.equal(res.status, 403, `expected 403, got ${res.status}`);
    assertSnapshotEqual(before, fileSnapshot(REAL_PIPELINES_DIR));
  });
});

describe("GET / — the workflow editor is wired in the served HTML (037 D6)", () => {
  let srv: ServeHandle;
  let html: string;

  before(async () => {
    srv = await startServer({
      state: makeState(REAL_REPO_ROOT),
      port: 0,
      dbPath: ":memory:",
      pipelinesDir: REAL_PIPELINES_DIR,
    });
    html = await (await fetch(`http://127.0.0.1:${srv.port}/`)).text();
  });
  after(async () => srv.close());

  it("opens a draft, the prompt map and the definition when the edit route is entered", () => {
    assert.ok(!html.includes("Editor arrives in Ship 3"), "the placeholder must be gone");
    assert.ok(html.includes("openWorkflowEditor"), "the edit route must open the editor");
    for (const call of ["/drafts`", "/prompts`", "/preview`"]) {
      assert.ok(html.includes(call), `the editor must call ${call.replace("`", "")}`);
    }
  });

  it("validates through the preview route and never writes a canon file to render", () => {
    assert.ok(html.includes("validateEditor"), "Validate must go through one function");
    assert.ok(
      html.includes("renderLevelsSvg(d.levels, d.graph"),
      "the diagram must be re-rendered from the preview result"
    );
  });

  it("writes every changed prompt before the YAML, each conditional on its hash", () => {
    const promptWrite = html.indexOf("/prompts/${encodeURIComponent(stepId)}");
    const draftSave = html.indexOf("/save`");
    assert.ok(promptWrite > 0, "the prompt write route must be called");
    assert.ok(draftSave > 0, "the draft save route must be called");
    assert.ok(
      promptWrite < draftSave,
      "prompts are written before the YAML — a failed prompt write must stop the save"
    );
    assert.ok(html.includes("ifMatch"), "every prompt write must carry the hash it is based on");
  });

  it("guards an unsaved buffer and offers a reload on a conflict", () => {
    assert.ok(html.includes("confirmLeaveEditor"), "leaving the route must be guarded");
    assert.ok(html.includes("Reload draft"), "a conflict must offer to reopen the draft");
  });

  it("uses classes, not ids, for the editor's hooks", () => {
    for (const hook of ["editor-yaml", "editor-validate", "editor-save", "editor-status"]) {
      assert.ok(!html.includes(`id="${hook}"`), `"${hook}" must not be an id`);
      assert.ok(html.includes(hook), `the "${hook}" hook must exist`);
    }
  });
});

// ── Spec 038 FR-008: the prompt READ route is guarded in bundled mode too ─────
//
// Verified before this test was written: the GET route already carries the same
// `resolve(ctx.pipelinesDir) === resolve(ctx.bundledPipelinesDir)` guard as the
// PUT route, so this pins existing behaviour rather than adding it. It matters
// more under a global install than it did before: "bundled" is then one shared
// directory for every project on the machine, and the editor loads a workflow's
// prompts through this route before offering to save them.

describe("FR-008: the prompts routes refuse the package's own catalogue", () => {
  let srv: ServeHandle;
  let tmpDir: string;

  before(async () => {
    tmpDir = realpathSync(mkdtempSync(join(tmpdir(), "agent-flows-pkg-bundled-")));
    srv = await startServer({
      state: makeState(REAL_REPO_ROOT, tmpDir),
      port: 0,
      dbPath: ":memory:",
      // Both directories resolved from the package root (spec 038 D5) — this is
      // exactly the shape a global install serves with.
      pipelinesDir: bundledPipelinesDir(),
      bundledPipelinesDir: bundledPipelinesDir(),
    });
  });
  after(async () => {
    await srv.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("GET /api/pipelines/:id/prompts → 403 and returns no prompt text", async () => {
    const res = await fetch(`http://127.0.0.1:${srv.port}/api/pipelines/investigate/prompts`);
    assert.equal(res.status, 403, `expected 403, got ${res.status}`);
    const body = (await res.json()) as Record<string, unknown>;
    assert.deepEqual(
      Object.keys(body),
      ["error"],
      `no prompt may be returned: ${JSON.stringify(body)}`
    );
  });

  it("PUT /api/pipelines/:id/prompts/:stepId → 403 and changes no bundled prompt", async () => {
    const before = fileSnapshot(join(packageRoot(), "prompts"));
    const res = await mutate(srv.port, "PUT", "/api/pipelines/investigate/prompts/survey", {
      text: "rewritten for every project on this machine",
      ifMatch: "0".repeat(64),
    });
    assert.equal(res.status, 403, `expected 403, got ${res.status}`);
    assertSnapshotEqual(before, fileSnapshot(join(packageRoot(), "prompts")));
  });
});

// ── Daemon identity route and record (spec 038 D8, FR-011/FR-012) ─────────────

describe("GET /api/daemon — identity, health and version in one route (FR-011)", () => {
  let srv: ServeHandle;
  let tmpDir: string;
  let state: ProjectState;

  before(async () => {
    tmpDir = realpathSync(mkdtempSync(join(tmpdir(), "agent-flows-daemon-id-")));
    state = makeState(REAL_REPO_ROOT, tmpDir);
    srv = await startServer({
      state,
      port: 0,
      dbPath: ":memory:",
      projectDir: REAL_REPO_ROOT,
      pipelinesDir: REAL_PIPELINES_DIR,
    });
  });

  after(async () => {
    await srv.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns exactly {projectDir, version, pid, startedAt}", async () => {
    const res = await fetch(`http://127.0.0.1:${srv.port}/api/daemon`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.deepEqual(Object.keys(body).sort(), ["pid", "projectDir", "startedAt", "version"]);
    assert.equal(body.projectDir, REAL_REPO_ROOT);
    assert.equal(body.version, packageVersion());
    assert.equal(body.pid, process.pid);
    assert.ok(
      !Number.isNaN(Date.parse(String(body.startedAt))),
      `startedAt must be an ISO timestamp, got ${String(body.startedAt)}`
    );
  });

  it("daemon.json matches the route, adds the port, and is mode 0600", async () => {
    const res = await fetch(`http://127.0.0.1:${srv.port}/api/daemon`);
    const identity = (await res.json()) as Record<string, unknown>;
    const record = readDaemonRecord(state.dir);
    assert.deepEqual(record, { ...identity, port: srv.port });
    assert.equal(statSync(join(state.dir, "daemon.json")).mode & 0o777, 0o600);
  });
});

describe("GET /api/daemons — every daemon on the machine (spec 042 FR-001)", () => {
  let srv: ServeHandle;
  let tmpDir: string;
  let state: ProjectState;

  before(async () => {
    tmpDir = realpathSync(mkdtempSync(join(tmpdir(), "agent-flows-daemons-")));
    state = makeState(REAL_REPO_ROOT, tmpDir);
    srv = await startServer({
      state,
      port: 0,
      dbPath: ":memory:",
      projectDir: REAL_REPO_ROOT,
      pipelinesDir: REAL_PIPELINES_DIR,
    });
  });

  after(async () => {
    await srv.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("reports the serving daemon as live and marked self", async () => {
    const res = await fetch(`http://127.0.0.1:${srv.port}/api/daemons`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { daemons: Record<string, unknown>[] };
    const mine = body.daemons.find((d) => d.pid === process.pid);
    assert.ok(mine, `the serving daemon must list itself: ${JSON.stringify(body.daemons)}`);
    assert.equal(mine.live, true);
    assert.equal(mine.self, true);
    assert.equal(mine.port, srv.port);
    assert.equal(mine.projectDir, REAL_REPO_ROOT);
  });

  it("reports a neighbouring project's stale record as not live (D3)", async () => {
    // A crashed daemon's leftovers: a record on a port nothing is listening on.
    const ghostProject = join(tmpDir, "ghost-project");
    mkdirSync(ghostProject, { recursive: true });
    const ghostState = resolveProjectState(ghostProject, {
      AGENT_FLOWS_HOME: join(tmpDir, "state-home"),
    }).dir;
    mkdirSync(ghostState, { recursive: true });
    writeFileSync(
      join(ghostState, "daemon.json"),
      JSON.stringify({
        projectDir: ghostProject,
        version: "0.1.0",
        pid: 999999,
        startedAt: "2026-09-21T10:00:00.000Z",
        port: 1,
      })
    );

    const res = await fetch(`http://127.0.0.1:${srv.port}/api/daemons`);
    const body = (await res.json()) as { daemons: Record<string, unknown>[] };
    const ghost = body.daemons.find((d) => d.projectDir === ghostProject);
    assert.ok(ghost, "a stale record is reported, never omitted");
    assert.equal(ghost.live, false);
    assert.equal(ghost.self, false);
  });
});

describe("POST /api/daemons/:projectKey/stop — the page's Stop (spec 042 FR-003)", () => {
  let srv: ServeHandle;
  let tmpDir: string;
  let stateHome: string;

  /** A project under this test's state home, with a daemon.json naming `port`. */
  function recordGhost(name: string, port: number, pid: number): string {
    const projectDir = join(tmpDir, name);
    mkdirSync(projectDir, { recursive: true });
    const ghost = resolveProjectState(projectDir, { AGENT_FLOWS_HOME: stateHome });
    mkdirSync(ghost.dir, { recursive: true });
    writeFileSync(
      join(ghost.dir, "daemon.json"),
      JSON.stringify({
        projectDir,
        version: "0.1.0",
        pid,
        startedAt: "2026-09-21T10:00:00.000Z",
        port,
      })
    );
    return ghost.key;
  }

  before(async () => {
    tmpDir = realpathSync(mkdtempSync(join(tmpdir(), "agent-flows-daemon-stop-")));
    stateHome = join(tmpDir, "state-home");
    srv = await startServer({
      state: makeState(REAL_REPO_ROOT, tmpDir),
      port: 0,
      dbPath: ":memory:",
      projectDir: REAL_REPO_ROOT,
      pipelinesDir: REAL_PIPELINES_DIR,
    });
  });

  after(async () => {
    await srv.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns the same StopReport stopProjectDaemon returns for that state dir (V2)", async () => {
    // Port 1 is not bound, so the record is stale and pid 999999 must NOT be
    // signalled — a SIGTERM to a pid that does not exist throws ESRCH, and this
    // route would answer 500 instead of the refusal report.
    const key = recordGhost("stale-ghost", 1, 999999);
    const stateDir = join(stateHome, "projects", key);

    const res = await mutate(srv.port, "POST", `/api/daemons/${encodeURIComponent(key)}/stop`, {});
    assert.equal(res.status, 200, `expected the refusal report, got ${res.status}`);
    const viaRoute = await res.json();
    const viaCall = await stopProjectDaemon(stateDir);
    assert.deepEqual(
      viaRoute,
      viaCall,
      "the route must drive stop.ts, not a second kill path of its own"
    );
    assert.equal((viaRoute as { outcome: string }).outcome, "no-daemon");
  });

  it("refuses a record whose port is held by another pid, and signals nothing", async () => {
    const holder = createHttpServer((_req, hres) => {
      hres.writeHead(200, { "Content-Type": "application/json" });
      hres.end(
        JSON.stringify({
          projectDir: join(tmpDir, "impostor"),
          version: "0.1.0",
          pid: 123456,
          startedAt: "2026-09-21T10:00:00.000Z",
        })
      );
    });
    const port = await new Promise<number>((resolve) => {
      holder.listen(0, "127.0.0.1", () => resolve((holder.address() as AddressInfo).port));
    });

    try {
      const key = recordGhost("impostor", port, 999999);
      const res = await mutate(
        srv.port,
        "POST",
        `/api/daemons/${encodeURIComponent(key)}/stop`,
        {}
      );
      assert.equal(res.status, 200);
      const report = (await res.json()) as { outcome: string; reason: string };
      assert.equal(report.outcome, "unresolved");
      assert.match(report.reason, /held by pid 123456, not the recorded pid 999999/u);
      assert.match(report.reason, /nothing was signalled/u);
    } finally {
      holder.closeAllConnections();
      await new Promise<void>((resolve) => holder.close(() => resolve()));
    }
  });

  it("404s an unknown project key and never joins it onto a path", async () => {
    for (const key of ["no-such-project", "..", "../.."]) {
      const res = await mutate(
        srv.port,
        "POST",
        `/api/daemons/${encodeURIComponent(key)}/stop`,
        {}
      );
      assert.equal(res.status, 404, `key ${key} must resolve to no project`);
    }
  });
});

describe("daemon.json is removed on a graceful close (FR-011)", () => {
  it("close() drops the record it wrote", async () => {
    const tmpDir = realpathSync(mkdtempSync(join(tmpdir(), "agent-flows-daemon-close-")));
    const state = makeState(REAL_REPO_ROOT, tmpDir);
    try {
      const srv = await startServer({
        state,
        port: 0,
        dbPath: ":memory:",
        projectDir: REAL_REPO_ROOT,
        pipelinesDir: REAL_PIPELINES_DIR,
      });
      assert.ok(readDaemonRecord(state.dir) !== undefined, "the record must exist while listening");
      await srv.close();
      assert.equal(readDaemonRecord(state.dir), undefined);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("live daemon — port selection and record lifecycle (FR-011/FR-012/FR-015)", () => {
  /**
   * Spawn the real daemon with an environment built from scratch except for
   * PATH and HOME: a daemon that inherited the runner's AGENT_FLOWS_* variables
   * would be testing the runner's configuration, not the port selection.
   */
  function spawnDaemon(extra: Record<string, string>): ReturnType<typeof spawn> {
    return spawn(
      process.execPath,
      ["--import", "tsx", join(REAL_REPO_ROOT, "src/serve/server.ts")],
      {
        cwd: REAL_REPO_ROOT,
        env: {
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "",
          ...extra,
        },
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
  }

  async function waitForRecord(stateDir: string, timeoutMs = 60_000): Promise<DaemonRecord> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const record = readDaemonRecord(stateDir);
      if (record !== undefined) return record;
      if (Date.now() >= deadline)
        throw new Error(`no daemon.json in ${stateDir} after ${timeoutMs}ms`);
      await new Promise<void>((r) => setTimeout(r, 100));
    }
  }

  it("an auto-started daemon takes an ephemeral port, records it, and cleans up on SIGTERM", async () => {
    const tmpDir = realpathSync(mkdtempSync(join(tmpdir(), "agent-flows-autostart-")));
    const project = join(tmpDir, "project");
    mkdirSync(project);
    const env = { AGENT_FLOWS_HOME: join(tmpDir, "home"), AGENT_FLOWS_PROJECT_DIR: project };
    const stateDir = resolveProjectState(project, env).dir;
    // Hold 7411 when it is free, so "took an ephemeral port" cannot pass by luck;
    // when something else already holds it, that is the same situation (FR-015).
    const blocker = createNetServer();
    const blockerHolds = await new Promise<boolean>((resolve) => {
      blocker.once("error", () => resolve(false));
      blocker.listen(DEFAULT_PORT, "127.0.0.1", () => resolve(true));
    });

    const child = spawnDaemon({ ...env, AGENT_FLOWS_AUTOSTART: "1" });
    let stderr = "";
    child.stderr?.on("data", (c: Buffer) => (stderr += c.toString()));
    child.stdout?.resume();

    try {
      const record = await waitForRecord(stateDir);
      assert.notEqual(record.port, DEFAULT_PORT, `stderr:\n${stderr}`);
      assert.equal(record.pid, child.pid);
      assert.equal(record.version, packageVersion());
      assert.equal(realpathSync(record.projectDir), realpathSync(project));

      const identity = await probeDaemon(record.port);
      assert.deepEqual(identity, {
        projectDir: record.projectDir,
        version: record.version,
        pid: record.pid,
        startedAt: record.startedAt,
      });

      if (blockerHolds) {
        assert.ok(blocker.listening, "a listener on 7411 must never be disturbed");
      }

      child.kill("SIGTERM");
      await new Promise<void>((resolve) => child.on("exit", () => resolve()));
      assert.equal(
        readDaemonRecord(stateDir),
        undefined,
        "a graceful exit must remove the record it wrote"
      );
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      if (blockerHolds) await new Promise<void>((r) => blocker.close(() => r()));
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // Spec 042 D11. The exit path ends the process, so the only honest test of the
  // WIRING — as opposed to the policy, which `idleShutdown.test.ts` covers — is
  // to spawn a real daemon and watch it go.
  it("an auto-started daemon stops itself once idle, and a human's daemon does not", async () => {
    const tmpDir = realpathSync(mkdtempSync(join(tmpdir(), "agent-flows-idle-")));
    const project = join(tmpDir, "project");
    mkdirSync(project);
    const env = {
      AGENT_FLOWS_HOME: join(tmpDir, "home"),
      AGENT_FLOWS_PROJECT_DIR: project,
      AGENT_FLOWS_IDLE_MS: "400",
    };
    const stateDir = resolveProjectState(project, env).dir;

    const reaped = spawnDaemon({ ...env, AGENT_FLOWS_AUTOSTART: "1" });
    reaped.stdout?.resume();
    reaped.stderr?.resume();
    try {
      await waitForRecord(stateDir);
      const code = await new Promise<number | null>((resolve) => {
        const timer = setTimeout(() => resolve(null), 20_000);
        reaped.on("exit", (c) => {
          clearTimeout(timer);
          resolve(c);
        });
      });
      assert.equal(code, 0, "an idle auto-started daemon must stop on its own");
      assert.equal(
        readDaemonRecord(stateDir),
        undefined,
        "and must drop the record, or the panel shows a daemon that is gone"
      );
    } finally {
      if (reaped.exitCode === null && reaped.signalCode === null) reaped.kill("SIGKILL");
    }

    // Same span, same quiet, no autostart marker: this one must still be there.
    const kept = spawnDaemon(env);
    kept.stdout?.resume();
    kept.stderr?.resume();
    try {
      const record = await waitForRecord(stateDir);
      await new Promise<void>((r) => setTimeout(r, 2_000));
      assert.equal(
        kept.exitCode,
        null,
        "a daemon a human started must survive any amount of quiet"
      );
      assert.deepEqual(readDaemonRecord(stateDir)?.pid, record.pid);
    } finally {
      kept.kill("SIGKILL");
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
