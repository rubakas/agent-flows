// Spec 042 D12 — what the cross-project proxy will and will not forward.
//
// The refusals carry the weight. The port is never taken from the request, so a
// caller cannot aim this at something else; a nested proxy path is refused so
// two daemons cannot bounce a request between them; and a project whose daemon
// is recorded but dead is refused by name rather than connected to blindly.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { resolveProxyTarget, splitProxyPath } from "./proxy.js";
import type { RoutableDaemon } from "./proxy.js";

const LIVE: RoutableDaemon = {
  projectKey: "-Users-en3e-code-domcap-ascent-portal",
  projectDir: "/Users/en3e/code/domcap/ascent-portal",
  port: 7413,
  live: true,
};
const DEAD: RoutableDaemon = {
  projectKey: "-Users-en3e-code-old",
  projectDir: "/Users/en3e/code/old",
  port: 51000,
  live: false,
};

describe("splitProxyPath — which paths are forwarded at all", () => {
  it("splits the project key from the path to forward", () => {
    assert.deepEqual(splitProxyPath("/api/projects/-Users-en3e-code-x/api/runs"), {
      projectKey: "-Users-en3e-code-x",
      rest: "/api/runs",
    });
  });

  it("keeps the query string with the forwarded path's caller, not here", () => {
    // Only the pathname reaches this function; the caller re-attaches search.
    assert.deepEqual(splitProxyPath("/api/projects/k/api/runs/abc/events"), {
      projectKey: "k",
      rest: "/api/runs/abc/events",
    });
  });

  it("refuses a nested proxy path — two daemons must not bounce a request", () => {
    assert.equal(splitProxyPath("/api/projects/a/api/projects/b/api/runs"), undefined);
  });

  it("refuses anything that is not an API path on the target", () => {
    assert.equal(splitProxyPath("/api/projects/k/"), undefined);
    assert.equal(splitProxyPath("/api/projects/k/ui-daemons.js"), undefined);
    assert.equal(splitProxyPath("/api/projects//api/runs"), undefined);
  });

  it("is not a proxy path at all without the prefix", () => {
    assert.equal(splitProxyPath("/api/runs"), undefined);
    assert.equal(splitProxyPath("/"), undefined);
  });
});

describe("resolveProxyTarget — the port comes from the record, never the request", () => {
  it("routes a live project to its recorded port", () => {
    assert.deepEqual(resolveProxyTarget(LIVE.projectKey, [LIVE, DEAD]), {
      port: 7413,
      projectDir: LIVE.projectDir,
    });
  });

  it("refuses an unknown project by name", () => {
    const refusal = resolveProxyTarget("-Users-en3e-nope", [LIVE]);
    assert.equal(typeof refusal, "string");
    assert.match(refusal as string, /-Users-en3e-nope/u);
  });

  it("refuses a recorded but dead daemon, naming the project and port", () => {
    const refusal = resolveProxyTarget(DEAD.projectKey, [LIVE, DEAD]);
    assert.equal(typeof refusal, "string");
    assert.match(refusal as string, /\/Users\/en3e\/code\/old/u);
    assert.match(refusal as string, /51000/u);
  });
});
