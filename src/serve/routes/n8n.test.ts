import assert from "node:assert/strict";
import { request as httpRequest, type IncomingMessage, type RequestOptions } from "node:http";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { startServer, type ServeHandle } from "../server.js";
import { fetchN8n, type N8nConfig } from "./n8n.js";

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
