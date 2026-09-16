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
  loadCatalogPipelines,
  loadFromCatalog,
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

/** A pipeline with one llm step reading `prompts/<promptName>.md` of its own layer. */
function writePromptPipeline(
  layer: CanonLayer,
  id: string,
  promptName: string,
  promptText: string
): void {
  writeFileSync(
    join(layer.pipelinesDir, `${id}.yaml`),
    [
      `id: ${id}`,
      "version: 1",
      `description: ${id}`,
      "inputs: []",
      "steps:",
      "  - id: write",
      "    kind: llm",
      "    role: worker",
      `    prompt: prompts/${promptName}.md`,
      "",
    ].join("\n")
  );
  writeFileSync(join(layer.promptsDir, `${promptName}.md`), promptText);
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

// ── Per-layer prompts (FR-018) ────────────────────────────────────────────────

describe("prompts resolve within the owning layer (FR-018)", () => {
  it("two layers holding a prompt file of the same name each read their own", () => {
    const dir = tempDir("af-layers-prompts-");
    try {
      const bundled = makeLayer("bundled", join(dir, "package"));
      const repo = makeLayer("repo", join(dir, "project", ".agent-flows"));
      writePromptPipeline(bundled, "bundled-writer", "shared", "BUNDLED PROMPT BODY");
      writePromptPipeline(repo, "repo-writer", "shared", "REPO PROMPT BODY");

      const catalog = mergedCatalog([bundled, repo]);

      const fromBundled = loadFromCatalog(catalog, "bundled-writer");
      const fromRepo = loadFromCatalog(catalog, "repo-writer");
      assert.ok(fromBundled && fromRepo);
      assert.equal(
        fromBundled.loaded.prompts.write,
        "BUNDLED PROMPT BODY",
        "a bundled pipeline must not read the repository copy of prompts/shared.md"
      );
      assert.equal(
        fromRepo.loaded.prompts.write,
        "REPO PROMPT BODY",
        "a repository pipeline must not read the bundled copy of prompts/shared.md"
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a nested child's prompts come from the child's layer, not the parent's", () => {
    const dir = tempDir("af-layers-nested-prompts-");
    try {
      const bundled = makeLayer("bundled", join(dir, "package"));
      const repo = makeLayer("repo", join(dir, "project", ".agent-flows"));
      writePromptPipeline(bundled, "child", "shared", "BUNDLED PROMPT BODY");
      writeFileSync(join(repo.promptsDir, "shared.md"), "REPO PROMPT BODY");
      writeFileSync(
        join(repo.pipelinesDir, "parent.yaml"),
        [
          "id: parent",
          "version: 1",
          "description: repo parent",
          "inputs: []",
          "steps:",
          "  - id: mount",
          "    kind: pipeline",
          "    pipeline: child",
          "",
        ].join("\n")
      );

      const catalog = mergedCatalog([bundled, repo]);
      const parent = loadFromCatalog(catalog, "parent");
      assert.ok(parent);
      assert.equal(
        parent.loaded.prompts["mount.write"],
        "BUNDLED PROMPT BODY",
        "the mounted child's prompt must come from the child's own layer"
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── Cross-layer nesting (FR-019) ──────────────────────────────────────────────

describe("nested pipelines resolve across layers (FR-019)", () => {
  it("a repository parent mounts a bundled child and a user-library child in one run", () => {
    const dir = tempDir("af-layers-mount-");
    try {
      const bundled = makeLayer("bundled", join(dir, "package"));
      const user = makeLayer("user", join(dir, "home", "workflows"));
      const repo = makeLayer("repo", join(dir, "project", ".agent-flows"));
      writeGatePipeline(bundled, "bundled-child", "shipped child");
      writeGatePipeline(user, "user-child", "personal child");
      writeFileSync(
        join(repo.pipelinesDir, "parent.yaml"),
        [
          "id: parent",
          "version: 1",
          "description: forked parent in the repository layer",
          "inputs: []",
          "steps:",
          "  - id: from-bundled",
          "    kind: pipeline",
          "    pipeline: bundled-child",
          "  - id: from-user",
          "    kind: pipeline",
          "    pipeline: user-child",
          "    dependsOn: [from-bundled]",
          "",
        ].join("\n")
      );

      const catalog = mergedCatalog([bundled, user, repo]);
      const parent = loadFromCatalog(catalog, "parent");
      assert.ok(parent, "the repository parent must load");
      assert.deepEqual(
        parent.loaded.def.steps.map((s) => s.id),
        ["from-bundled.start", "from-user.start"],
        "both mounts expand into the parent's step list"
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a user-library parent mounts a bundled child, including as a loop body", () => {
    const dir = tempDir("af-layers-mount-user-");
    try {
      const bundled = makeLayer("bundled", join(dir, "package"));
      const user = makeLayer("user", join(dir, "home", "workflows"));
      writeFileSync(
        join(bundled.pipelinesDir, "round.yaml"),
        [
          "id: round",
          "version: 1",
          "description: bundled loop body",
          "inputs: []",
          "steps:",
          "  - id: check",
          "    kind: check",
          "    command: true",
          "",
        ].join("\n")
      );
      writeFileSync(
        join(user.pipelinesDir, "personal.yaml"),
        [
          "id: personal",
          "version: 1",
          "description: user-library parent",
          "inputs: []",
          "steps:",
          "  - id: converge",
          "    kind: loop",
          "    pipeline: round",
          "    maxIterations: 2",
          "    until: check.passed",
          "",
        ].join("\n")
      );

      const catalog = mergedCatalog([bundled, user]);
      const personal = loadFromCatalog(catalog, "personal");
      assert.ok(personal, "the user-library parent must load");
      assert.deepEqual(
        personal.loaded.bodies?.converge.def.steps.map((s) => s.id),
        ["check"],
        "the loop body is the bundled child, resolved across layers"
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a later layer's copy of a child id is the one a parent mounts", () => {
    const dir = tempDir("af-layers-mount-shadow-");
    try {
      const bundled = makeLayer("bundled", join(dir, "package"));
      const repo = makeLayer("repo", join(dir, "project", ".agent-flows"));
      writePromptPipeline(bundled, "child", "child", "BUNDLED CHILD PROMPT");
      writePromptPipeline(repo, "child", "child", "FORKED CHILD PROMPT");
      writeFileSync(
        join(bundled.pipelinesDir, "parent.yaml"),
        [
          "id: parent",
          "version: 1",
          "description: bundled parent",
          "inputs: []",
          "steps:",
          "  - id: mount",
          "    kind: pipeline",
          "    pipeline: child",
          "",
        ].join("\n")
      );

      const catalog = mergedCatalog([bundled, repo]);
      const parent = loadFromCatalog(catalog, "parent");
      assert.ok(parent);
      assert.equal(
        parent.loaded.prompts["mount.write"],
        "FORKED CHILD PROMPT",
        "the forked child wins over the bundled one it shadows"
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports a cycle that only exists because a later layer shadows a child id", () => {
    const dir = tempDir("af-layers-cycle-");
    try {
      const bundled = makeLayer("bundled", join(dir, "package"));
      const repo = makeLayer("repo", join(dir, "project", ".agent-flows"));
      writeGatePipeline(bundled, "child", "harmless bundled child");
      writeFileSync(
        join(bundled.pipelinesDir, "parent.yaml"),
        [
          "id: parent",
          "version: 1",
          "description: bundled parent",
          "inputs: []",
          "steps:",
          "  - id: mount",
          "    kind: pipeline",
          "    pipeline: child",
          "",
        ].join("\n")
      );
      // The fork of `child` mounts `parent` — a cycle that does not exist in
      // either layer on its own.
      writeFileSync(
        join(repo.pipelinesDir, "child.yaml"),
        [
          "id: child",
          "version: 1",
          "description: forked child that mounts its own parent",
          "inputs: []",
          "steps:",
          "  - id: back",
          "    kind: pipeline",
          "    pipeline: parent",
          "",
        ].join("\n")
      );

      const catalog = mergedCatalog([bundled, repo]);
      assert.throws(
        () => loadFromCatalog(catalog, "parent"),
        /cycle detected in nested pipelines/,
        "a cross-layer cycle must be reported, not recursed into"
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("names a mount that no layer defines", () => {
    const dir = tempDir("af-layers-missing-");
    try {
      const repo = makeLayer("repo", join(dir, "project", ".agent-flows"));
      writeFileSync(
        join(repo.pipelinesDir, "parent.yaml"),
        [
          "id: parent",
          "version: 1",
          "description: parent with a dangling mount",
          "inputs: []",
          "steps:",
          "  - id: mount",
          "    kind: pipeline",
          "    pipeline: nowhere",
          "",
        ].join("\n")
      );
      const catalog = mergedCatalog([repo]);
      assert.throws(
        () => loadFromCatalog(catalog, "parent"),
        /nested pipeline "nowhere" is not defined in any workflow layer/
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── Loading the whole merged view ─────────────────────────────────────────────

describe("loadCatalogPipelines — the listing path", () => {
  it("returns one entry per id with its layer, and a malformed file as an error", () => {
    const dir = tempDir("af-layers-load-all-");
    try {
      const bundled = makeLayer("bundled", join(dir, "package"));
      const repo = makeLayer("repo", join(dir, "project", ".agent-flows"));
      writeGatePipeline(bundled, "alpha", "bundled alpha");
      writeGatePipeline(repo, "alpha", "forked alpha");
      writeGatePipeline(bundled, "beta", "bundled beta");
      writeFileSync(join(repo.pipelinesDir, "broken.yaml"), "id: broken\nsteps: [{ id: x }]\n");

      const { loaded, errors } = loadCatalogPipelines(mergedCatalog([bundled, repo]));
      assert.deepEqual(
        loaded.map(({ entry }) => [entry.id, entry.layer.source]),
        [
          ["alpha", "repo"],
          ["beta", "bundled"],
        ]
      );
      assert.equal(loaded[0].loaded.def.description, "forked alpha");
      assert.equal(errors.length, 1, `one broken file must be reported: ${JSON.stringify(errors)}`);
      assert.match(errors[0].file, /broken\.yaml$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
