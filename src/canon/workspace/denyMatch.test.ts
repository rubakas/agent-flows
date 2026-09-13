import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BUILD_CONFIG_DENY_PATTERNS, CREDENTIAL_DENY_PATTERNS } from "../runStep.js";
import { matchesDenyPattern } from "./denyMatch.js";

const ALL_PATTERNS: readonly string[] = [
  ...CREDENTIAL_DENY_PATTERNS,
  ...BUILD_CONFIG_DENY_PATTERNS,
];

/**
 * Turn a deny pattern into a concrete path it must match. `**` is expanded to
 * real directory segments so a pattern shape the matcher cannot handle shows
 * up as a failing assertion instead of as a silently dead entry.
 */
function synthesizePath(pattern: string): string {
  return pattern
    .replace(/^\*\*\//, "alpha/beta/")
    .replace(/\/\*\*$/, "/gamma/delta")
    .replace(/\*/g, "zeta")
    .replace(/\?/g, "q");
}

describe("matchesDenyPattern", () => {
  it("matches at least one synthetic path for every pattern in both arrays", () => {
    const dead: string[] = [];
    for (const pattern of ALL_PATTERNS) {
      const candidate = synthesizePath(pattern);
      if (!matchesDenyPattern(candidate, [pattern])) dead.push(`${pattern} !~ ${candidate}`);
    }
    assert.deepEqual(dead, [], "every deny pattern must match a synthetic path");
  });

  it("matches case-insensitively", () => {
    assert.equal(matchesDenyPattern("Config/SECRETS.YAML", ALL_PATTERNS), true);
    assert.equal(matchesDenyPattern("a/B/Server.Key", ALL_PATTERNS), true);
  });

  it("matches `**` spanning zero directories", () => {
    assert.equal(matchesDenyPattern(".npmrc", ALL_PATTERNS), true);
    assert.equal(matchesDenyPattern("id_rsa", ALL_PATTERNS), true);
  });

  it("supports ? as a single-character wildcard", () => {
    assert.equal(matchesDenyPattern("a/bc", ["**/b?"]), true);
    assert.equal(matchesDenyPattern("a/bcd", ["**/b?"]), false);
  });

  it("leaves ordinary source paths alone", () => {
    for (const ordinary of ["src/index.ts", "docs/readme.md", "README.md", "src/keys/reader.ts"]) {
      assert.equal(matchesDenyPattern(ordinary, ALL_PATTERNS), false, ordinary);
    }
  });

  it("returns false for an empty path", () => {
    assert.equal(matchesDenyPattern("", ALL_PATTERNS), false);
  });
});
