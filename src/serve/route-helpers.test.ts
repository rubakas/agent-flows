import assert from "node:assert/strict";
import {
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { resolveProjectState, type ProjectState } from "../runtime/projectState.js";
import { RunService, type MastraLike } from "../runtime/runService.js";
import { isSafeId, isSafeName } from "./route-helpers.js";
import { startServer, type ServeHandle } from "./server.js";

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
      state: makeState(process.cwd()),
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
      state: makeState(process.cwd()),
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

// ── Ordering: POST /api/pipelines/:id/template reaches its own handler ──────

describe("dispatch ordering — POST /api/pipelines/:id/template is not captured by pipeline-detail", () => {
  let srv: ServeHandle;
  let tmpDir: string;

  before(async () => {
    tmpDir = realpathSync(mkdtempSync(join(tmpdir(), "agent-flows-route-order-")));
    srv = await startServer({
      state: makeState(process.cwd()),
      port: 0,
      dbPath: ":memory:",
      pipelinesDir: REAL_PIPELINES_DIR,
      templatesBase: join(tmpDir, "templates"),
    });
  });
  after(async () => {
    await srv.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("the response carries templateId, proving the template handler ran, not pipeline-detail or drafts", async () => {
    const res = await mutate(srv.port, "POST", "/api/pipelines/investigate/template", {
      templateId: "ordering-check",
    });
    assert.equal(res.status, 201, `expected 201, got ${res.status}`);
    const body = (await res.json()) as { templateId?: string; def?: unknown; draftId?: number };
    assert.equal(
      body.templateId,
      "ordering-check",
      `body must be the template response, not a detail or drafts one; got: ${JSON.stringify(body)}`
    );
  });
});

// ── Ordering: the editor's routes reach their own handlers (037 FR-004/FR-005) ──

describe("dispatch ordering — the editor's suffix routes are not captured by their prefixes", () => {
  let srv: ServeHandle;
  let projectSrv: ServeHandle;
  let tmpDir: string;
  let projectRoot: string;

  before(async () => {
    tmpDir = realpathSync(mkdtempSync(join(tmpdir(), "agent-flows-route-order-editor-")));
    srv = await startServer({
      state: makeState(process.cwd()),
      port: 0,
      dbPath: ":memory:",
      pipelinesDir: REAL_PIPELINES_DIR,
      bundledPipelinesDir: REAL_PIPELINES_DIR,
      templatesBase: join(tmpDir, "templates"),
    });

    // The draft routes refuse the bundled catalogue, so their ordering is
    // proven against a project copy of the pipeline instead.
    projectRoot = realpathSync(mkdtempSync(join(tmpdir(), "agent-flows-route-order-project-")));
    const projectPipelinesDir = join(projectRoot, "pipelines");
    mkdirSync(projectPipelinesDir);
    copyFileSync(
      join(REAL_PIPELINES_DIR, "investigate.yaml"),
      join(projectPipelinesDir, "investigate.yaml")
    );
    cpSync(join(process.cwd(), "prompts"), join(projectRoot, "prompts"), { recursive: true });
    projectSrv = await startServer({
      state: makeState(projectRoot, projectRoot),
      port: 0,
      dbPath: ":memory:",
      pipelinesDir: projectPipelinesDir,
      bundledPipelinesDir: REAL_PIPELINES_DIR,
      templatesBase: join(projectRoot, "templates"),
    });
  });
  after(async () => {
    await srv.close();
    await projectSrv.close();
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it("GET /api/pipelines/:id/prompts answers 403 for the bundled catalogue, not the detail payload", async () => {
    const res = await fetch(`http://127.0.0.1:${srv.port}/api/pipelines/investigate/prompts`);
    assert.equal(res.status, 403, `expected the prompts handler's 403, got ${res.status}`);
    const body = (await res.json()) as { error?: string; def?: unknown };
    assert.equal(body.def, undefined, `pipeline-detail must not answer: ${JSON.stringify(body)}`);
  });

  it("POST /api/drafts/:id/preview answers with the preview payload, not the draft-save one", async () => {
    const open = await mutate(projectSrv.port, "POST", "/api/pipelines/investigate/drafts", {});
    assert.equal(open.status, 200);
    const { draftId } = (await open.json()) as { draftId: number };
    const res = await mutate(projectSrv.port, "POST", `/api/drafts/${draftId}/preview`, {});
    assert.equal(res.status, 200, `expected 200, got ${res.status}`);
    const body = (await res.json()) as Record<string, unknown>;
    assert.deepEqual(
      Object.keys(body).sort(),
      ["def", "graph", "levels"],
      `body must be the preview response, not a save or update one: ${JSON.stringify(body)}`
    );
  });
});
