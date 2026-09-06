import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { loadCatalog } from "./pipelineLoader.js";

// ── Minimal pipeline fixtures ─────────────────────────────────────────────────

const VALID_PIPELINE = `\
id: alpha
version: 1
description: Alpha pipeline
inputs: []
steps: []
`;

const VALID_PIPELINE_EDITED = `\
id: alpha
version: 1
description: Alpha pipeline (updated)
inputs:
  - request
steps: []
`;

// An llm step with no role or model triggers the validation error in load.ts.
const MALFORMED_PIPELINE = `\
id: broken
version: 1
description: Broken pipeline
inputs: []
steps:
  - id: step1
    kind: llm
    prompt: prompts/foo.md
`;

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("loadCatalog — pipeline added after initial load", () => {
  it("new file becomes visible on next loadCatalog call", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-flows-loader-add-"));
    try {
      const c1 = loadCatalog(dir);
      assert.equal(c1.loaded.length, 0, "directory starts empty");

      await writeFile(join(dir, "alpha.yaml"), VALID_PIPELINE);

      const c2 = loadCatalog(dir);
      assert.equal(c2.loaded.length, 1, "new file visible on second call");
      assert.equal(c2.loaded[0].def.id, "alpha");
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});

describe("loadCatalog — edited pipeline picked up in new form", () => {
  it("changed file content is reflected on next loadCatalog call", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-flows-loader-edit-"));
    try {
      await writeFile(join(dir, "alpha.yaml"), VALID_PIPELINE);

      const c1 = loadCatalog(dir);
      assert.equal(c1.loaded.length, 1);
      assert.equal(c1.loaded[0].def.description, "Alpha pipeline");
      assert.deepEqual(c1.loaded[0].def.inputs, []);

      await writeFile(join(dir, "alpha.yaml"), VALID_PIPELINE_EDITED);

      const c2 = loadCatalog(dir);
      assert.equal(c2.loaded.length, 1);
      assert.equal(c2.loaded[0].def.description, "Alpha pipeline (updated)");
      assert.deepEqual(c2.loaded[0].def.inputs, ["request"]);
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});

describe("loadCatalog — malformed pipeline does not take down valid ones", () => {
  it("valid pipeline loads and malformed one is reported as an error", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-flows-loader-err-"));
    try {
      await writeFile(join(dir, "alpha.yaml"), VALID_PIPELINE);
      await writeFile(join(dir, "broken.yaml"), MALFORMED_PIPELINE);

      const catalog = loadCatalog(dir);

      assert.equal(catalog.loaded.length, 1, "valid pipeline present");
      assert.equal(catalog.loaded[0].def.id, "alpha");

      assert.equal(catalog.errors.length, 1, "broken pipeline reported as error");
      assert.ok(
        catalog.errors[0].file.endsWith("broken.yaml"),
        `error file should be broken.yaml, got: ${catalog.errors[0].file}`
      );
      assert.ok(catalog.errors[0].error.length > 0, "error message should be non-empty");
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});
