import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { RunService, type MastraLike } from "../runtime/runService.js";
import { isSafeId, isSafeName } from "./route-helpers.js";
import { startServer, type ServeHandle } from "./server.js";

const REAL_PIPELINES_DIR = join(process.cwd(), "pipelines");

async function mutate(
  port: number,
  method: string,
  path: string,
  body: unknown
): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ── isSafeId vs isSafeName: accept-sets differ exactly where the routes need them to ──

describe("isSafeId and isSafeName — accept-sets diverge as intended", () => {
  it("isSafeId rejects uppercase; isSafeName accepts it", () => {
    assert.equal(isSafeId("Bad-Id"), false);
    assert.equal(isSafeName("Bad-Name"), true);
  });

  it("isSafeId rejects a mid-name dot; isSafeName accepts it", () => {
    assert.equal(isSafeId("a.b"), false);
    assert.equal(isSafeName("a.b"), true);
  });

  it("isSafeId rejects unicode; isSafeName accepts it", () => {
    assert.equal(isSafeId("café"), false);
    assert.equal(isSafeName("café"), true);
  });

  it("both reject a leading-dot traversal attempt", () => {
    assert.equal(isSafeId(".."), false);
    assert.equal(isSafeName(".."), false);
  });

  it("both reject an embedded slash", () => {
    assert.equal(isSafeId("a/b"), false);
    assert.equal(isSafeName("a/b"), false);
  });

  it("isSafeId accepts lowercase alphanumeric with hyphens", () => {
    assert.equal(isSafeId("my-pipeline-01"), true);
  });
});

// ── Capped read-and-discard: 413 on a route other than POST /api/install ──────

describe("readAndDiscardBody — 413 on an oversized body (DELETE /api/pipelines/:id)", () => {
  let srv: ServeHandle;
  let tmpRoot: string;
  let tmpPipelinesDir: string;

  before(async () => {
    tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), "agent-flows-drain-413-")));
    tmpPipelinesDir = join(tmpRoot, "pipelines");
    mkdirSync(tmpPipelinesDir);
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

  it("an oversized body on DELETE /api/pipelines/:id yields 413, not 400", async () => {
    const oversized = "x".repeat(70_000);
    const res = await fetch(`http://127.0.0.1:${srv.port}/api/pipelines/orphan`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: oversized,
    });
    assert.equal(res.status, 413, `expected 413, got ${res.status}`);
  });
});

// ── safePath redaction: an unexpected error surfaces as 500 with paths redacted ──

describe("safePath redaction — unexpected error surfaces as 500 with <root>", () => {
  let srv: ServeHandle;
  let tmpRoot: string;
  let tmpPipelinesDir: string;

  before(async () => {
    tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), "agent-flows-safepath-500-")));
    tmpPipelinesDir = join(tmpRoot, "pipelines");
    mkdirSync(tmpPipelinesDir);

    // A RunService whose workflow lookup throws synchronously with the launch
    // root embedded in the message — start() awaits this without a local
    // try/catch, so the rejection propagates to the outer 500 handler.
    const throwingMastra: MastraLike = {
      getWorkflow: (_id) => {
        throw new Error(`cannot load workflow from ${tmpPipelinesDir}/x.yaml`);
      },
    };
    const runService = new RunService(throwingMastra);

    srv = await startServer({
      port: 0,
      dbPath: ":memory:",
      pipelinesDir: tmpPipelinesDir,
      runService,
    });
  });
  after(async () => {
    await srv.close();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("500 body replaces the launch root with <root> and omits the real path", async () => {
    const res = await mutate(srv.port, "POST", "/api/runs", { pipeline: "x", inputs: {} });
    assert.equal(res.status, 500, `expected 500, got ${res.status}`);
    const body = (await res.json()) as { error: string };
    assert.ok(body.error.includes("<root>"), `error must contain <root>; got: ${body.error}`);
    assert.ok(
      !body.error.includes(tmpRoot),
      `error must not leak the real filesystem root; got: ${body.error}`
    );
  });
});

// ── Ordering: POST /api/templates/from-n8n reaches its own handler ────────────

describe("dispatch ordering — POST /api/templates/from-n8n is not captured by template-detail", () => {
  let srv: ServeHandle;

  before(async () => {
    srv = await startServer({ port: 0, dbPath: ":memory:", pipelinesDir: REAL_PIPELINES_DIR });
  });
  after(async () => srv.close());

  it("a body missing workflowId gets the from-n8n-specific 400, proving its own handler ran", async () => {
    const res = await mutate(srv.port, "POST", "/api/templates/from-n8n", {});
    assert.equal(res.status, 400, `expected 400, got ${res.status}`);
    const body = (await res.json()) as { error: string };
    assert.ok(
      body.error.includes("workflowId"),
      `error must be the from-n8n workflowId message, not a template-detail message; got: ${body.error}`
    );
  });
});
