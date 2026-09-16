// Visibility filters the MCP `list_pipelines` tool and nothing else
// (spec 038 D15, FR-026).
//
// AGENT_FLOWS_HOME is passed explicitly to every call, so the user library
// resolved here is a mkdtemp directory and never the owner's real one.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { loadFromCatalog, resolveCatalog } from "../../canon/layers.js";
import { resolveProjectState } from "../../runtime/projectState.js";
import { setHidden } from "../../runtime/visibility.js";
import { listPipelinesPayload } from "./listPipelines.js";

function tempDir(prefix: string): string {
  return realpathSync(mkdtempSync(join(realpathSync(tmpdir()), prefix)));
}

/** A project with a repository canon holding a parent and the child it mounts. */
function makeProject(dir: string): string {
  const projectDir = join(dir, "project");
  const pipelinesDir = join(projectDir, ".agent-flows", "pipelines");
  mkdirSync(pipelinesDir, { recursive: true });
  writeFileSync(
    join(pipelinesDir, "child.yaml"),
    [
      "id: child",
      "version: 1",
      "description: the mounted child",
      "inputs: []",
      "steps:",
      "  - id: start",
      "    kind: gate",
      "",
    ].join("\n")
  );
  writeFileSync(
    join(pipelinesDir, "parent.yaml"),
    [
      "id: parent",
      "version: 1",
      "description: an enabled parent",
      "inputs: []",
      "steps:",
      "  - id: nested",
      "    kind: pipeline",
      "    pipeline: child",
      "",
    ].join("\n")
  );
  return projectDir;
}

describe("FR-026: list_pipelines is filtered by this project's visibility file", () => {
  it("a hidden workflow is absent from the payload and everything else stays", () => {
    const dir = tempDir("af-vis-mcp-");
    try {
      const projectDir = makeProject(dir);
      const env = { AGENT_FLOWS_HOME: join(dir, "home") };

      const before = listPipelinesPayload(projectDir, env).pipelines.map((p) => p.id);
      assert.ok(before.includes("child"), "the child is listed before it is hidden");
      assert.ok(before.includes("parent"));

      setHidden(resolveProjectState(projectDir, env).dir, "child", true);

      const after = listPipelinesPayload(projectDir, env).pipelines.map((p) => p.id);
      assert.ok(
        !after.includes("child"),
        `the hidden workflow must be unlisted; got: ${after.join(", ")}`
      );
      assert.ok(after.includes("parent"), "nothing else is affected");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The two non-enforcement cases. Hiding declutters the chat surface; it is not
  // access control, so neither of these may ever become a refusal.
  it("a hidden workflow still resolves when it is named explicitly by id", () => {
    const dir = tempDir("af-vis-byid-");
    try {
      const projectDir = makeProject(dir);
      const env = { AGENT_FLOWS_HOME: join(dir, "home") };
      setHidden(resolveProjectState(projectDir, env).dir, "child", true);

      // The run path resolves an entry point through the merged view — the same
      // resolution POST /api/runs and run_pipeline use — which never consults
      // visibility.
      const loaded = loadFromCatalog(resolveCatalog(projectDir, env), "child");
      assert.ok(loaded, "a hidden workflow must still load by id");
      assert.deepEqual(
        loaded.loaded.def.steps.map((s) => s.id),
        ["start"]
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a hidden child mounted by an enabled parent still executes", () => {
    const dir = tempDir("af-vis-nested-");
    try {
      const projectDir = makeProject(dir);
      const env = { AGENT_FLOWS_HOME: join(dir, "home") };
      setHidden(resolveProjectState(projectDir, env).dir, "child", true);

      const listed = listPipelinesPayload(projectDir, env).pipelines.map((p) => p.id);
      assert.ok(!listed.includes("child"), "the child is unlisted");
      assert.ok(listed.includes("parent"), "the parent is listed");

      const parent = loadFromCatalog(resolveCatalog(projectDir, env), "parent");
      assert.ok(parent);
      assert.deepEqual(
        parent.loaded.def.steps.map((s) => s.id),
        ["nested.start"],
        "the hidden child is still expanded into the parent's step list"
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
