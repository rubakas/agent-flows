import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { describe, it } from "node:test";

import { assertSafePath, isContained } from "./paths.js";

function makeTempDir(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

describe("isContained — adversarial edge cases", () => {
  it("accepts the base directory itself", () => {
    const base = resolve("/tmp/agent-flows-base");
    assert.equal(isContained(base, base), true);
  });

  it("accepts a direct child of the base", () => {
    const base = resolve("/tmp/agent-flows-base");
    assert.equal(isContained(base, join(base, "child.txt")), true);
  });

  it("rejects a sibling directory that shares the base as a string prefix", () => {
    // "/base-evil" starts with the string "/base" but is not inside it — a naive
    // `target.startsWith(base)` check (without the separator) would wrongly accept this.
    const base = resolve("/tmp/agent-flows-base");
    const evilSibling = resolve("/tmp/agent-flows-base-evil/secret.txt");
    assert.equal(isContained(base, evilSibling), false);
  });

  it("treats a trailing separator on the target the same as without one", () => {
    const base = resolve("/tmp/agent-flows-base");
    const withTrailingSep = `${join(base, "child")}${sep}`;
    assert.equal(isContained(base, withTrailingSep), true);
  });

  it("rejects a path built from .. segments that escape the base", () => {
    const base = resolve("/tmp/agent-flows-base/inner");
    const escaped = join(base, "..", "..", "escape.txt");
    assert.equal(isContained(base, escaped), false);
  });

  it("accepts a path with .. segments that stay within the base after resolution", () => {
    const base = resolve("/tmp/agent-flows-base");
    const staysInside = join(base, "child", "..", "other.txt");
    assert.equal(isContained(base, staysInside), true);
  });

  it("accepts non-normalized input that resolves inside the base", () => {
    const base = resolve("/tmp/agent-flows-base");
    const nonNormalized = `${base}/./child/./file.txt`;
    assert.equal(isContained(base, nonNormalized), true);
  });

  it("rejects a decoded traversal sequence (..%2F, post-decode) joined into the target", () => {
    // Simulates the server's flow: decodeURIComponent("..%2Fescape") -> "../escape",
    // then join(subdir, decoded) before the containment check.
    const subdir = resolve("/tmp/agent-flows-base/skills");
    const decoded = decodeURIComponent("..%2F..%2Fescape");
    const target = join(subdir, decoded);
    assert.equal(isContained(subdir, target), false);
  });

  it("rejects a %2e%2e (post-decode '..') traversal sequence", () => {
    const subdir = resolve("/tmp/agent-flows-base/skills");
    const decoded = decodeURIComponent("%2e%2e/%2e%2e/escape");
    const target = join(subdir, decoded);
    assert.equal(isContained(subdir, target), false);
  });
});

describe("assertSafePath — adversarial edge cases", () => {
  it("rejects an entryPath containing a null byte", () => {
    assert.throws(() => assertSafePath("/tmp/agent-flows-base", "evil\0.txt"), /invalid path/i);
  });

  it("rejects an entryPath that is empty", () => {
    assert.throws(() => assertSafePath("/tmp/agent-flows-base", ""), /invalid path/i);
  });

  it("rejects an absolute-looking entryPath", () => {
    assert.throws(() => assertSafePath("/tmp/agent-flows-base", "/etc/passwd"), /escapes/i);
  });

  it("accepts a real nested file that resolves inside root", () => {
    const root = makeTempDir("agent-flows-assert-safe-");
    try {
      assert.doesNotThrow(() => assertSafePath(root, "nested/dir/file.txt"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
