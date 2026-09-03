// Tests for the yoke serve HTTP server.
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
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { request as httpRequest, type IncomingMessage, type RequestOptions } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { RunService, type MastraLike } from "../runtime/runService.js";
import { startServer, type ServeHandle } from "./server.js";

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

// ── Pipeline listing & detail ─────────────────────────────────────────────────

describe("GET /api/pipelines — lists real pipelines", () => {
  let srv: ServeHandle;

  before(async () => {
    srv = await startServer({
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

  before(async () => {
    srv = await startServer({
      port: 0,
      dbPath: ":memory:",
      pipelinesDir: REAL_PIPELINES_DIR,
    });
  });
  after(async () => srv.close());

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
    tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), "yoke-serve-test-")));
    tmpPipelinesDir = join(tmpRoot, "pipelines");
    mkdirSync(tmpPipelinesDir);

    // Copy the pipeline YAML and all prompt files into the temp layout:
    //   <tmpRoot>/pipelines/spec-creation.yaml
    //   <tmpRoot>/prompts/*.md
    // loadPipeline derives its root as dirname(dirname(yamlPath)) = tmpRoot,
    // so "prompts/intake.md" resolves correctly under that root.
    writeFileSync(
      join(tmpPipelinesDir, "spec-creation.yaml"),
      readFileSync(join(REAL_REPO_ROOT, "pipelines", "spec-creation.yaml"), "utf8")
    );
    cpSync(join(REAL_REPO_ROOT, "prompts"), join(tmpRoot, "prompts"), { recursive: true });

    srv = await startServer({
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

  before(async () => {
    mockRun = makeMockRun("http-sse-run-01", successResult(), successResult());
    const service = new RunService(makeMastra(mockRun));
    // Register the run via service.start() directly so it is in the registry
    // before the HTTP tests run. The run settles to success immediately (mock).
    const startResult = await service.start("spec-creation", { request: "test" });
    svcRunId = startResult.runId;

    srv = await startServer({
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
