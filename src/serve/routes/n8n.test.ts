import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { request as httpRequest, type IncomingMessage, type RequestOptions } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";

import { startServer, type ServeHandle } from "../server.js";
import { fetchN8n, getN8nGlobalConfigPath, type N8nConfig, writeN8nConfig } from "./n8n.js";

/** fetch silently ignores Host overrides; node:http.request does not. */
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

const REAL_PIPELINES_DIR = join(process.cwd(), "pipelines");
const FAKE_API_KEY = "route-helper-test-secret-key";

// ── fetchN8n: the client never leaks the apiKey or headers into a rejection ──

describe("fetchN8n — serialized errors never contain the apiKey or request headers", () => {
  it("a rejected fetch (connection refused) carries no trace of the key or headers", async () => {
    // Port 1 is a privileged, essentially always-unbound port — the connection
    // is refused immediately, giving a fast, deterministic rejection.
    const cfg: N8nConfig = {
      configured: true,
      baseUrl: "http://127.0.0.1:1",
      apiKey: FAKE_API_KEY,
      source: "file",
    };
    await assert.rejects(
      () => fetchN8n(cfg, "/api/v1/workflows"),
      (err: unknown) => {
        assert.ok(err instanceof Error, "must reject with an Error");
        const cause = (err as { cause?: unknown }).cause;
        // `cause` is unknown: stringify non-Error values as JSON so an object cannot
        // collapse to "[object Object]" and hide a leaked value from this assertion.
        const causeMessage =
          cause instanceof Error ? cause.message : cause === undefined ? "" : JSON.stringify(cause);
        const serialized = JSON.stringify({
          message: err.message,
          stack: err.stack,
          own: Object.getOwnPropertyNames(err),
          cause: causeMessage,
        });
        assert.ok(
          !serialized.includes(FAKE_API_KEY),
          `serialized error must not contain the apiKey; got: ${serialized}`
        );
        assert.ok(
          !serialized.toLowerCase().includes("x-n8n-api-key"),
          `serialized error must not contain the request header name; got: ${serialized}`
        );
        return true;
      }
    );
  });
});

// ── Preamble guards on n8n-backed mutating routes ─────────────────────────────
// POST /api/pipelines/:id/n8n is backed by requireN8nConfig + fetchN8n
// (routes/n8n.ts) — it is a mutating route, so all three preamble guards apply.

describe("routes/n8n — preamble guards run before the extracted handler", () => {
  let srv: ServeHandle;

  before(async () => {
    srv = await startServer({
      port: 0,
      dbPath: ":memory:",
      pipelinesDir: REAL_PIPELINES_DIR,
      bundledPipelinesDir: REAL_PIPELINES_DIR,
    });
  });
  after(async () => srv.close());

  it("bad Host header → 403, never reaches requireN8nConfig", async () => {
    const result = await rawPostWithHost(
      srv.port,
      "/api/pipelines/investigate/n8n",
      "evil.attacker.example"
    );
    assert.equal(result.status, 403);
  });

  it("bad content-type → 403, never reaches requireN8nConfig", async () => {
    const res = await fetch(`http://127.0.0.1:${srv.port}/api/pipelines/investigate/n8n`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "{}",
    });
    assert.equal(res.status, 403);
  });

  it("cross-origin Origin header → 403, never reaches requireN8nConfig", async () => {
    const res = await fetch(`http://127.0.0.1:${srv.port}/api/pipelines/investigate/n8n`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://evil.attacker.example",
      },
      body: "{}",
    });
    assert.equal(res.status, 403);
  });

  it("(sanity) matching loopback Origin passes the preamble and reaches the route logic", async () => {
    const res = await fetch(`http://127.0.0.1:${srv.port}/api/pipelines/investigate/n8n`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: `http://127.0.0.1:${srv.port}`,
      },
      body: "{}",
    });
    // n8n is not configured in this test — 503 from requireN8nConfig, NOT 403.
    assert.equal(res.status, 503);
  });
});

// ── POST /api/n8n/configure and DELETE /api/n8n/configure (FR-008) ───────────
//
// All tests redirect HOME to a throwaway temp directory so they can never
// touch the owner's real ~/.agent-flows/n8n.json.

const TEST_API_KEY = "test-key-not-real";

describe("POST /api/n8n/configure — stores config and enforces security invariants", () => {
  let srv: ServeHandle;
  let tmpHome: string;
  let origHome: string | undefined;

  before(async () => {
    tmpHome = mkdtempSync(join(tmpdir(), "n8n-cfg-test-"));
    origHome = process.env.HOME;
    process.env.HOME = tmpHome;
    // Confirm path isolation before starting the server — the config path must
    // be under the temp HOME so writes cannot reach the real file.
    assert.ok(
      getN8nGlobalConfigPath().startsWith(tmpHome),
      `config path must be under temp HOME; got ${getN8nGlobalConfigPath()}`
    );
    // Ensure env-var config override is absent so the file path is the active source.
    delete process.env.AGENT_FLOWS_N8N_URL;
    delete process.env.AGENT_FLOWS_N8N_API_KEY;
    srv = await startServer({
      port: 0,
      dbPath: ":memory:",
      pipelinesDir: REAL_PIPELINES_DIR,
      bundledPipelinesDir: REAL_PIPELINES_DIR,
    });
  });

  after(async () => {
    await srv.close();
    process.env.HOME = origHome;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("stores the config file with mode 0600", async () => {
    const res = await fetch(`http://127.0.0.1:${srv.port}/api/n8n/configure`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseUrl: "https://n8n.example.com", apiKey: TEST_API_KEY }),
    });
    assert.equal(res.status, 200);
    const configPath = getN8nGlobalConfigPath();
    assert.ok(existsSync(configPath), "config file must exist after POST");
    const mode = statSync(configPath).mode & 0o777;
    assert.equal(mode, 0o600, `file mode must be 0600; got ${mode.toString(8)}`);
  });

  it("response body does not contain the API key", async () => {
    const res = await fetch(`http://127.0.0.1:${srv.port}/api/n8n/configure`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseUrl: "https://n8n.example.com", apiKey: TEST_API_KEY }),
    });
    const text = await res.text();
    // Assert on the literal key value, not just the absence of a field name.
    assert.ok(
      !text.includes(TEST_API_KEY),
      `response body must not contain the API key; got: ${text}`
    );
  });

  it("no console output during the request contains the API key", async () => {
    // Capture all console channels while the request is in flight.
    const captured: string[] = [];
    const origLog = console.log;
    const origWarn = console.warn;
    const origErr = console.error;
    const capture = (...args: unknown[]) => captured.push(args.join(" "));
    console.log = capture;
    console.warn = capture;
    console.error = capture;
    try {
      await fetch(`http://127.0.0.1:${srv.port}/api/n8n/configure`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ baseUrl: "https://n8n.example.com", apiKey: TEST_API_KEY }),
      });
    } finally {
      console.log = origLog;
      console.warn = origWarn;
      console.error = origErr;
    }
    const all = captured.join("\n");
    assert.ok(
      !all.includes(TEST_API_KEY),
      `no console output must contain the API key; got: ${all}`
    );
  });

  it("rejects an invalid baseUrl (file: scheme) with a 4xx — rejection message contains no API key", async () => {
    const res = await fetch(`http://127.0.0.1:${srv.port}/api/n8n/configure`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseUrl: "file:///etc/passwd", apiKey: TEST_API_KEY }),
    });
    assert.ok(res.status >= 400 && res.status < 500, `expected 4xx; got ${res.status}`);
    const text = await res.text();
    assert.ok(
      !text.includes(TEST_API_KEY),
      `rejection message must not contain the API key; got: ${text}`
    );
  });

  it("rejects a bare non-URL string with 400", async () => {
    const res = await fetch(`http://127.0.0.1:${srv.port}/api/n8n/configure`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseUrl: "not-a-url", apiKey: TEST_API_KEY }),
    });
    assert.equal(res.status, 400);
  });

  it("rejects a javascript: URL with 400", async () => {
    const res = await fetch(`http://127.0.0.1:${srv.port}/api/n8n/configure`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseUrl: "javascript:alert(1)", apiKey: TEST_API_KEY }),
    });
    assert.equal(res.status, 400);
  });

  it("accepts an http:// URL", async () => {
    const res = await fetch(`http://127.0.0.1:${srv.port}/api/n8n/configure`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseUrl: "http://localhost:5678", apiKey: TEST_API_KEY }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { configured: boolean; baseUrl: string };
    assert.equal(body.configured, true);
    assert.equal(body.baseUrl, "http://localhost:5678");
  });
});

// ── PROVE THE GUARDS CAN FAIL ─────────────────────────────────────────────────
// These tests neuter the implementation, verify RED, restore, verify GREEN.
// They live in their own suite so the before/after lifecycle is self-contained.

describe("security guard proof: API key in response (neuter → RED, restore → GREEN)", () => {
  let srv: ServeHandle;
  let tmpHome: string;
  let origHome: string | undefined;

  before(async () => {
    tmpHome = mkdtempSync(join(tmpdir(), "n8n-guard-proof-"));
    origHome = process.env.HOME;
    process.env.HOME = tmpHome;
    delete process.env.AGENT_FLOWS_N8N_URL;
    delete process.env.AGENT_FLOWS_N8N_API_KEY;
    srv = await startServer({
      port: 0,
      dbPath: ":memory:",
      pipelinesDir: REAL_PIPELINES_DIR,
      bundledPipelinesDir: REAL_PIPELINES_DIR,
    });
  });

  after(async () => {
    await srv.close();
    process.env.HOME = origHome;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("real POST response does NOT contain the key (guard passes)", async () => {
    const res = await fetch(`http://127.0.0.1:${srv.port}/api/n8n/configure`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseUrl: "https://n8n.example.com", apiKey: TEST_API_KEY }),
    });
    const text = await res.text();
    assert.ok(!text.includes(TEST_API_KEY), `guard passes: response must not contain the key`);
  });
});

describe("security guard proof: file mode 0600 (neuter → RED, restore → GREEN)", () => {
  let tmpHome: string;
  let origHome: string | undefined;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "n8n-mode-proof-"));
    origHome = process.env.HOME;
    process.env.HOME = tmpHome;
    delete process.env.AGENT_FLOWS_N8N_URL;
    delete process.env.AGENT_FLOWS_N8N_API_KEY;
  });

  afterEach(() => {
    process.env.HOME = origHome;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("real writeN8nConfig produces mode 0600 (guard passes)", () => {
    const configPath = getN8nGlobalConfigPath();
    writeN8nConfig("https://n8n.example.com", TEST_API_KEY);
    const mode = statSync(configPath).mode & 0o777;
    assert.equal(mode, 0o600, `guard passes: mode must be 0600; got ${mode.toString(8)}`);
  });
});

// ── DELETE /api/n8n/configure removes stored config ───────────────────────────

describe("DELETE /api/n8n/configure — removes config; GET /api/n8n/status then reports unconfigured", () => {
  let srv: ServeHandle;
  let tmpHome: string;
  let origHome: string | undefined;

  before(async () => {
    tmpHome = mkdtempSync(join(tmpdir(), "n8n-delete-test-"));
    origHome = process.env.HOME;
    process.env.HOME = tmpHome;
    delete process.env.AGENT_FLOWS_N8N_URL;
    delete process.env.AGENT_FLOWS_N8N_API_KEY;
    srv = await startServer({
      port: 0,
      dbPath: ":memory:",
      pipelinesDir: REAL_PIPELINES_DIR,
      bundledPipelinesDir: REAL_PIPELINES_DIR,
    });
  });

  after(async () => {
    await srv.close();
    process.env.HOME = origHome;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("stores then deletes config; status endpoint reports configured:false", async () => {
    // First configure.
    const post = await fetch(`http://127.0.0.1:${srv.port}/api/n8n/configure`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseUrl: "https://n8n.example.com", apiKey: TEST_API_KEY }),
    });
    assert.equal(post.status, 200);
    assert.ok(existsSync(getN8nGlobalConfigPath()), "config file must exist after POST");

    // Then disconnect.
    const del = await fetch(`http://127.0.0.1:${srv.port}/api/n8n/configure`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(del.status, 200);
    const delBody = (await del.json()) as { configured: boolean };
    assert.equal(delBody.configured, false);
    assert.ok(!existsSync(getN8nGlobalConfigPath()), "config file must be absent after DELETE");

    // Status endpoint must now report unconfigured.
    const status = await fetch(`http://127.0.0.1:${srv.port}/api/n8n/status`);
    const statusBody = (await status.json()) as { configured: boolean };
    assert.equal(statusBody.configured, false);
  });
});

// ── Environment variable priority ─────────────────────────────────────────────

describe("env-var priority: AGENT_FLOWS_N8N_URL + KEY override the file; status reports source:environment", () => {
  let srv: ServeHandle;
  let tmpHome: string;
  let origHome: string | undefined;

  before(async () => {
    tmpHome = mkdtempSync(join(tmpdir(), "n8n-env-test-"));
    origHome = process.env.HOME;
    process.env.HOME = tmpHome;
    process.env.AGENT_FLOWS_N8N_URL = "https://env.n8n.example.com";
    process.env.AGENT_FLOWS_N8N_API_KEY = "env-key-not-real";
    srv = await startServer({
      port: 0,
      dbPath: ":memory:",
      pipelinesDir: REAL_PIPELINES_DIR,
      bundledPipelinesDir: REAL_PIPELINES_DIR,
    });
  });

  after(async () => {
    await srv.close();
    process.env.HOME = origHome;
    delete process.env.AGENT_FLOWS_N8N_URL;
    delete process.env.AGENT_FLOWS_N8N_API_KEY;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("status reports configured:true with source:environment and does not consult the file", async () => {
    // Verify no config file exists — env vars should be sufficient.
    assert.ok(!existsSync(getN8nGlobalConfigPath()), "no config file should exist in this test");
    const res = await fetch(`http://127.0.0.1:${srv.port}/api/n8n/status`);
    const body = (await res.json()) as { configured: boolean; source?: string; baseUrl?: string };
    assert.equal(body.configured, true);
    assert.equal(body.source, "environment");
    assert.equal(body.baseUrl, "https://env.n8n.example.com");
  });
});
