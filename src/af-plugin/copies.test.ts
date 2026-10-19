// The plugin carries its own copies of af's code-review prompts (spec 046 D2, D9).
// A copy that drifts from its source is a review that no longer matches the pipeline
// it claims to port, so each one is pinned byte-for-byte.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { STEPS } from "./buildReviewEngine.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("plugin prompt copies", () => {
  it("covers the eight review steps", () => {
    assert.deepEqual([...STEPS].sort(), [
      "brief",
      "correctness",
      "delivery",
      "falsifiability",
      "radius",
      "security",
      "synthesis",
      "verify",
    ]);
  });

  for (const step of STEPS) {
    it(`${step}.md is byte-equal to prompts/code-review-${step}.md`, () => {
      const copy = readFileSync(
        join(root, "plugin", "skills", "review", "references", "prompts", `${step}.md`)
      );
      const source = readFileSync(join(root, "prompts", `code-review-${step}.md`));
      assert.ok(copy.equals(source), `${step}.md differs from its source in prompts/`);
    });
  }
});
