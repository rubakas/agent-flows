import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { CREDENTIAL_DENY_PATTERNS } from "./credentialPatterns.js";
import { matchesDenyPattern } from "./workspace/denyMatch.js";

describe("CREDENTIAL_DENY_PATTERNS", () => {
  // The review capture already withheld these four from a diff; the list a step's
  // own Read and Grep tools obey did not name them, so a model could open what the
  // capture had hidden from it.
  for (const path of [
    ".git-credentials",
    ".pypirc",
    ".docker/config.json",
    ".dockercfg",
    "home/user/.docker/config.json",
    "service/.PYPIRC",
  ]) {
    it(`names ${path}`, () => {
      assert.ok(matchesDenyPattern(path, CREDENTIAL_DENY_PATTERNS), `${path} is not denied`);
    });
  }

  it("leaves a docker compose file and a neighbouring config readable", () => {
    for (const path of ["docker-compose.yml", ".docker/compose.yml", "config.json"]) {
      assert.equal(matchesDenyPattern(path, CREDENTIAL_DENY_PATTERNS), false, path);
    }
  });

  it("stays a dependency-free leaf: the plugin's generated copy cannot import anything", () => {
    const source = readFileSync(
      fileURLToPath(new URL("./credentialPatterns.ts", import.meta.url)),
      "utf8"
    );
    assert.doesNotMatch(source, /^\s*(import|export)\b[^\n]*\bfrom\b/mu);
    assert.doesNotMatch(source, /^\s*import\s*["'(]/mu);
  });
});
