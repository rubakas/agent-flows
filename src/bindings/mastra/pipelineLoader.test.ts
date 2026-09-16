import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
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

// Asserted `resolveCanonDir`'s project/bundled flip until spec 038 D13 removed
// it; the per-call property it guards — a workflow added after startup is
// visible on the next call — now belongs to the merged layer view.
describe("FR-010 defect fix: list_pipelines resolves the layers per call (not at startup)", () => {
  it("the merged view reports a workflow added to the repository canon post-startup", async () => {
    const dir = await mkdtemp(join(await realpath(tmpdir()), "agent-flows-mcp-staleness-"));
    const home = await mkdtemp(join(await realpath(tmpdir()), "agent-flows-mcp-home-"));
    try {
      // A project with no .agent-flows/ at all at "startup" time.
      const projectDir = dir;
      const { resolveCatalog } = await import("../../canon/layers.js");

      const before = resolveCatalog(projectDir, { AGENT_FLOWS_HOME: home });
      assert.deepEqual(
        before.layers.map((l) => l.source),
        ["bundled"],
        "before any customisation only the bundled layer is present"
      );
      assert.ok(!before.entries.has("alpha"), "alpha does not exist yet");

      const projectPipelinesDir = join(projectDir, ".agent-flows", "pipelines");
      const { mkdir, writeFile } = await import("node:fs/promises");
      await mkdir(projectPipelinesDir, { recursive: true });
      await writeFile(
        join(projectPipelinesDir, "alpha.yaml"),
        ["id: alpha", "version: 1", "description: Alpha pipeline", "inputs: []", "steps: []"].join(
          "\n"
        ),
        "utf8"
      );

      // Resolve AGAIN — what the per-call resolution inside list_pipelines does.
      const after = resolveCatalog(projectDir, { AGENT_FLOWS_HOME: home });
      const alpha = after.entries.get("alpha");
      assert.equal(alpha?.layer.source, "repo", "the new workflow comes from the repository layer");
      assert.ok(
        alpha?.filePath.includes(".agent-flows"),
        "it is read from the project's .agent-flows/pipelines dir"
      );
      assert.ok(
        after.entries.has("spec-creation"),
        "and the bundled catalogue is still there — no exclusive flip"
      );
    } finally {
      const { rm } = await import("node:fs/promises");
      await rm(dir, { recursive: true });
      await rm(home, { recursive: true });
    }
  });
});
