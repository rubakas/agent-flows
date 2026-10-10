// Tests for the merged three-layer workflow view (spec 038 D13, FR-017–FR-019).
//
// AGENT_FLOWS_HOME is pinned to a mkdtemp directory in every test that touches
// the user library, so the owner's real ~/.agent-flows/workflows is never read
// and never written.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  catalogRows,
  mergedCatalog,
  resolveCatalog,
  resolveLayers,
  userLibraryRoot,
  type CanonLayer,
  type LayerSource,
} from "./layers.js";

function tempDir(prefix: string): string {
  return realpathSync(mkdtempSync(join(realpathSync(tmpdir()), prefix)));
}

/** A layer root with both directories created, ready to be written into. */
function makeLayer(source: LayerSource, root: string): CanonLayer {
  const layer = {
    source,
    root,
    pipelinesDir: join(root, "pipelines"),
    promptsDir: join(root, "prompts"),
  };
  mkdirSync(layer.pipelinesDir, { recursive: true });
  mkdirSync(layer.promptsDir, { recursive: true });
  return layer;
}

/** A one-gate-step pipeline, the smallest thing that loads. */
function writeGatePipeline(layer: CanonLayer, id: string, description: string): void {
  writeFileSync(
    join(layer.pipelinesDir, `${id}.yaml`),
    [
      `id: ${id}`,
      "version: 1",
      `description: ${description}`,
      "inputs: []",
      "steps:",
      "  - id: start",
      "    kind: gate",
      "",
    ].join("\n")
  );
}

// ── Precedence (FR-017) ───────────────────────────────────────────────────────

describe("mergedCatalog — precedence across the three layers (FR-017)", () => {
  it("resolves an id present in all three layers to the repository copy and records what it shadows", () => {
    const dir = tempDir("af-layers-precedence-");
    try {
      const bundled = makeLayer("bundled", join(dir, "package"));
      const user = makeLayer("user", join(dir, "home", "workflows"));
      const repo = makeLayer("repo", join(dir, "project", ".agent-flows"));
      writeGatePipeline(bundled, "shared", "bundled copy");
      writeGatePipeline(user, "shared", "user copy");
      writeGatePipeline(repo, "shared", "repo copy");
      writeGatePipeline(bundled, "bundled-only", "only in the package");
      writeGatePipeline(user, "user-only", "only in the user library");

      const catalog = mergedCatalog([bundled, user, repo]);

      const shared = catalog.entries.get("shared");
      assert.ok(shared, "the collided id must be in the merged view");
      assert.equal(shared.layer.source, "repo", "the last layer wins on an id collision");
      assert.equal(shared.filePath, join(repo.pipelinesDir, "shared.yaml"));
      assert.deepEqual(
        shared.shadows,
        ["bundled", "user"],
        "the shadowed layers are recorded lowest precedence first (FR-020)"
      );

      assert.equal(catalog.entries.get("bundled-only")?.layer.source, "bundled");
      assert.equal(catalog.entries.get("user-only")?.layer.source, "user");
      assert.deepEqual(
        catalogRows(catalog).map((e) => e.id),
        ["bundled-only", "shared", "user-only"],
        "every id from every layer is visible, not just the last layer's"
      );
      assert.deepEqual(
        catalog.entries.get("bundled-only")?.shadows,
        [],
        "an id present in only one layer shadows nothing"
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a workflow added to the bundled layer appears in a project that already has its own repository canon — the upgrade the old exclusive flip broke", () => {
    const dir = tempDir("af-layers-upgrade-");
    try {
      const bundled = makeLayer("bundled", join(dir, "package"));
      const repo = makeLayer("repo", join(dir, "project", ".agent-flows"));
      writeGatePipeline(bundled, "investigate", "shipped with the package");
      writeGatePipeline(repo, "our-own", "written by this team");

      const before = mergedCatalog([bundled, repo]);
      assert.deepEqual(
        catalogRows(before)
          .map((e) => e.id)
          .sort(),
        ["investigate", "our-own"]
      );

      // The package upgrade: a new bundled workflow the project never installed.
      writeGatePipeline(bundled, "ship", "added by the upgrade");

      const after = mergedCatalog([bundled, repo]);
      assert.ok(
        after.entries.has("ship"),
        "a newly bundled workflow must be visible to a project that has a canon of its own; " +
          `got: ${catalogRows(after)
            .map((e) => e.id)
            .join(", ")}`
      );
      assert.equal(after.entries.get("ship")?.layer.source, "bundled");
      assert.ok(after.entries.has("our-own"), "the project's own workflow is still there");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("resolveLayers — which layers a project contributes (FR-017)", () => {
  it("is the bundled layer alone for a project with no canon and no user library", () => {
    const dir = tempDir("af-layers-bare-");
    const home = tempDir("af-layers-home-");
    try {
      const layers = resolveLayers(dir, { AGENT_FLOWS_HOME: home });
      assert.deepEqual(
        layers.map((l) => l.source),
        ["bundled"]
      );
      assert.equal(layers[0].pipelinesDir, join(layers[0].root, "pipelines"));
      assert.equal(layers[0].promptsDir, join(layers[0].root, "prompts"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("adds the user library and the repository canon, in that order, once they exist", () => {
    const dir = tempDir("af-layers-three-");
    const home = tempDir("af-layers-home-");
    try {
      mkdirSync(join(userLibraryRoot({ AGENT_FLOWS_HOME: home }), "pipelines"), {
        recursive: true,
      });
      mkdirSync(join(dir, ".agent-flows", "pipelines"), { recursive: true });

      const layers = resolveLayers(dir, { AGENT_FLOWS_HOME: home });
      assert.deepEqual(
        layers.map((l) => l.source),
        ["bundled", "user", "repo"]
      );
      assert.equal(layers[1].root, join(home, "workflows"));
      assert.equal(layers[2].root, join(dir, ".agent-flows"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("a repository canon does not hide the bundled workflows (FR-017)", () => {
    const dir = tempDir("af-layers-project-");
    const home = tempDir("af-layers-home-");
    try {
      const repo = makeLayer("repo", join(dir, ".agent-flows"));
      writeGatePipeline(repo, "our-own", "written by this team");

      const catalog = resolveCatalog(dir, { AGENT_FLOWS_HOME: home });
      const ids = catalogRows(catalog).map((e) => e.id);
      assert.ok(ids.includes("our-own"), "the project's own workflow is listed");
      assert.ok(
        ids.includes("spec-creation"),
        `the bundled catalogue is still listed; got: ${ids.join(", ")}`
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });
});
