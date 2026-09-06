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
import {
  cpSync,
  existsSync,
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
import { startServer, type ServeHandle, CONTENT_CAP } from "./server.js";

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
    tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), "agent-flows-serve-test-")));
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
    assert.equal(body.status, "suspended");
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
    assert.equal(snapshot.status, "suspended");
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

// ── POST /api/install ─────────────────────────────────────────────────────────

describe("POST /api/install — install from bundled catalog", () => {
  let srv: ServeHandle;
  let tmpProjectDir: string;

  before(async () => {
    tmpProjectDir = realpathSync(mkdtempSync(join(tmpdir(), "agent-flows-install-test-")));
    srv = await startServer({
      port: 0,
      dbPath: ":memory:",
      pipelinesDir: REAL_PIPELINES_DIR,
      bundledPipelinesDir: REAL_PIPELINES_DIR,
      projectDir: tmpProjectDir,
    });
  });
  after(async () => {
    await srv.close();
    rmSync(tmpProjectDir, { recursive: true, force: true });
  });

  it("installs a pipeline and returns written/skipped lists (200)", async () => {
    const res = await mutate(srv.port, "POST", "/api/install", {
      ids: ["spec-creation"],
      overwrite: false,
    });
    assert.equal(res.status, 200, `expected 200, got ${res.status}`);
    const body = (await res.json()) as { written: string[]; skipped: string[] };
    assert.ok(Array.isArray(body.written), "written must be an array");
    assert.ok(Array.isArray(body.skipped), "skipped must be an array");
    assert.ok(body.written.length > 0, "at least one file must be written");
    assert.ok(
      body.written.some((p) => p.includes("spec-creation")),
      "written must include spec-creation.yaml"
    );
  });

  it("skips existing files when overwrite is omitted", async () => {
    const res = await mutate(srv.port, "POST", "/api/install", {
      ids: ["spec-creation"],
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { written: string[]; skipped: string[] };
    assert.equal(body.written.length, 0, "nothing should be written when files already exist");
    assert.ok(body.skipped.length > 0, "existing files must be reported as skipped");
  });

  it("overwrites when overwrite=true", async () => {
    const res = await mutate(srv.port, "POST", "/api/install", {
      ids: ["spec-creation"],
      overwrite: true,
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { written: string[]; skipped: string[] };
    assert.ok(body.written.length > 0, "files must be written when overwrite=true");
    assert.equal(body.skipped.length, 0, "nothing should be skipped when overwrite=true");
  });

  it("rejects an unknown pipeline id → 422", async () => {
    const res = await mutate(srv.port, "POST", "/api/install", {
      ids: ["does-not-exist"],
    });
    assert.equal(res.status, 422);
    const body = (await res.json()) as { error: string };
    assert.ok(body.error.length > 0, "error must describe the failure");
  });

  it("POST without application/json content-type → 403", async () => {
    const res = await fetch(`http://127.0.0.1:${srv.port}/api/install`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ ids: ["spec-creation"] }),
    });
    assert.equal(res.status, 403);
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

  it("reports pipelinesSource=bundled and lists available pipelines", async () => {
    const res = await fetch(`http://127.0.0.1:${bundledSrv.port}/api/environment`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      pipelinesSource: string;
      available: string[];
      installed: string[];
      skills: string[];
      agents: string[];
    };
    assert.equal(body.pipelinesSource, "bundled");
    assert.ok(
      Array.isArray(body.available) && body.available.length > 0,
      "available must list the bundled pipelines"
    );
    assert.ok(body.available.includes("spec-creation"), "spec-creation must be in available");
    assert.ok(Array.isArray(body.installed), "installed must be an array");
    assert.ok(Array.isArray(body.skills), "skills must be an array");
    assert.ok(Array.isArray(body.agents), "agents must be an array");
    for (const skill of body.skills) {
      assert.equal(typeof skill, "string", "each skill must be a string name — no file contents");
    }
  });

  it("reports pipelinesSource=project and lists the installed pipeline", async () => {
    const res = await fetch(`http://127.0.0.1:${projectSrv.port}/api/environment`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { pipelinesSource: string; installed: string[] };
    assert.equal(body.pipelinesSource, "project");
    assert.ok(
      Array.isArray(body.installed) && body.installed.includes("custom"),
      "installed must include the project pipeline"
    );
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
