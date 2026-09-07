import assert from "node:assert/strict";
import { request as httpRequest, type IncomingMessage, type RequestOptions } from "node:http";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { startServer, type ServeHandle } from "../server.js";

const REAL_PIPELINES_DIR = join(process.cwd(), "pipelines");

/**
 * Send a raw HTTP GET with an explicit Host header value. fetch treats "Host"
 * as a forbidden header and silently ignores overrides; node:http.request
 * does not have this restriction (mirrors server.test.ts's rawGetWithHost).
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
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") })
      );
    });
    req.on("error", reject);
    req.end();
  });
}

// The unified content handler (routes/content.ts) backs both GET /api/skills/:name
// and GET /api/agents/:name. Both routes are GET-only, so only the Host-header
// preamble guard applies here — the content-type/Origin guards only run for
// mutating methods and are covered on the n8n module's mutating routes instead.
describe("routes/content — preamble guard runs before the extracted handler", () => {
  let srv: ServeHandle;

  before(async () => {
    srv = await startServer({ port: 0, dbPath: ":memory:", pipelinesDir: REAL_PIPELINES_DIR });
  });
  after(async () => srv.close());

  it("GET /api/skills/:name with a bad Host header → 403, never reaches the handler", async () => {
    const result = await rawGetWithHost(srv.port, "/api/skills/anything", "evil.attacker.example");
    assert.equal(result.status, 403);
    const body = JSON.parse(result.body) as { error: string };
    assert.ok(body.error.toLowerCase().includes("host"), "error must mention Host");
  });

  it("GET /api/agents/:name with a bad Host header → 403, never reaches the handler", async () => {
    const result = await rawGetWithHost(srv.port, "/api/agents/anything", "evil.attacker.example");
    assert.equal(result.status, 403);
  });
});
