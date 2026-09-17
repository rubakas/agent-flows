// Tests for the daemon authentication token (spec 039 D15).

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { newToken, tokensMatch } from "./daemonToken.js";

describe("newToken — fresh, url-safe, at least 32 bytes of entropy", () => {
  it("two tokens differ", () => {
    assert.notEqual(newToken(), newToken());
  });

  it("is url-safe and long enough to encode 32 bytes", () => {
    const token = newToken();
    assert.match(token, /^[A-Za-z0-9_-]+$/);
    assert.ok(token.length >= 43, `expected at least 43 chars, got ${token.length}`);
  });
});

describe("tokensMatch — constant-time comparison", () => {
  it("a token matches itself", () => {
    const token = newToken();
    assert.equal(tokensMatch(token, token), true);
  });

  it("a token does not match a truncated copy of itself", () => {
    const token = newToken();
    assert.equal(tokensMatch(token, token.slice(0, -1)), false);
  });

  it("two fresh tokens do not match", () => {
    assert.equal(tokensMatch(newToken(), newToken()), false);
  });

  it("rejects a missing or empty candidate", () => {
    const token = newToken();
    assert.equal(tokensMatch(token, undefined), false);
    assert.equal(tokensMatch(undefined, token), false);
    assert.equal(tokensMatch(token, ""), false);
    assert.equal(tokensMatch("", token), false);
    assert.equal(tokensMatch(undefined, undefined), false);
  });
});
