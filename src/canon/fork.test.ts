// Forking a workflow into a writable layer (spec 038 D14, FR-021–FR-023).
//
// Every case builds its own layers under mkdtemp and passes an explicit env, so
// the owner's real ~/.agent-flows/workflows is never read and never written:
// `resolveForkTarget`'s default target IS that directory, which makes an
// unpinned test here a write into the owner's machine.

import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { packageRoot } from "../packageRoot.js";
import { assertWritableRoot, forkPipeline, resolveForkTarget } from "./fork.js";
import {
  loadFromCatalog,
  mergedCatalog,
  userLibraryRoot,
  type CanonLayer,
  type LayerSource,
} from "./layers.js";

function tempDir(prefix: string): string {
  return realpathSync(mkdtempSync(join(realpathSync(tmpdir()), prefix)));
}

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

/** A parent with one llm step (its own prompt) and one mounted child. */
function writeParent(layer: CanonLayer): void {
  writeFileSync(
    join(layer.pipelinesDir, "parent.yaml"),
    [
      "id: parent",
      "version: 1",
      "description: a parent that mounts a child",
      "inputs: []",
      "steps:",
      "  - id: think",
      "    kind: llm",
      "    role: worker",
      "    prompt: prompts/parent-think.md",
      "  - id: nested",
      "    kind: pipeline",
      "    pipeline: child",
      "    dependsOn: [think]",
      "",
    ].join("\n")
  );
  writeFileSync(join(layer.promptsDir, "parent-think.md"), "think about it\n");
}

function writeChild(layer: CanonLayer): void {
  writeFileSync(
    join(layer.pipelinesDir, "child.yaml"),
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
}

describe("FR-021: fork copies one workflow and its own prompts into a writable layer", () => {
  it("copies into the user library, creating pipelines/ and prompts/", () => {
    const dir = tempDir("af-fork-user-");
    try {
      const source = makeLayer("bundled", join(dir, "package"));
      writeParent(source);
      writeChild(source);
      const userRoot = join(dir, "home", "workflows");
      assert.ok(!existsSync(userRoot), "the user library does not exist before the first fork");

      const report = forkPipeline({
        id: "parent",
        catalog: mergedCatalog([source]),
        target: { target: "user", root: userRoot },
        overwrite: false,
      });

      assert.equal(report.from, "bundled");
      assert.equal(report.target, "user");
      assert.deepEqual(report.written, ["pipelines/parent.yaml", "prompts/parent-think.md"]);
      assert.ok(statSync(join(userRoot, "pipelines")).isDirectory(), "pipelines/ is created");
      assert.ok(statSync(join(userRoot, "prompts")).isDirectory(), "prompts/ is created");
      assert.equal(
        readFileSync(join(userRoot, "prompts", "parent-think.md"), "utf8"),
        "think about it\n",
        "the fork carries its own prompt file"
      );
      assert.ok(
        !existsSync(join(userRoot, "pipelines", "child.yaml")),
        "the nested child is NOT copied — the merged view resolves the mount across layers"
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("copies into the repository canon", () => {
    const dir = tempDir("af-fork-repo-");
    try {
      const source = makeLayer("bundled", join(dir, "package"));
      writeParent(source);
      writeChild(source);
      const repoRoot = join(dir, "project", ".agent-flows");

      const report = forkPipeline({
        id: "parent",
        catalog: mergedCatalog([source]),
        target: { target: "repo", root: repoRoot },
        overwrite: false,
      });

      assert.equal(report.target, "repo");
      assert.ok(existsSync(join(repoRoot, "pipelines", "parent.yaml")));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the forked copy still mounts the child it mounted before the fork", () => {
    const dir = tempDir("af-fork-mount-");
    try {
      const source = makeLayer("bundled", join(dir, "package"));
      writeParent(source);
      writeChild(source);
      const repoRoot = join(dir, "project", ".agent-flows");

      forkPipeline({
        id: "parent",
        catalog: mergedCatalog([source]),
        target: { target: "repo", root: repoRoot },
        overwrite: false,
      });

      const repo: CanonLayer = {
        source: "repo",
        root: repoRoot,
        pipelinesDir: join(repoRoot, "pipelines"),
        promptsDir: join(repoRoot, "prompts"),
      };
      const catalog = mergedCatalog([source, repo]);
      const parent = loadFromCatalog(catalog, "parent");
      assert.ok(parent, "the forked parent must load");
      assert.equal(parent.entry.layer.source, "repo", "the fork owns the id now");
      assert.deepEqual(
        parent.loaded.def.steps.map((s) => s.id),
        ["think", "nested.start"],
        "the child from the source layer is still mounted"
      );
      assert.equal(
        parent.loaded.prompts.think,
        "think about it\n",
        "and the prompt read is the fork's own copy"
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("FR-021: the default fork target", () => {
  it("is the repository canon when the project has one", () => {
    const dir = tempDir("af-fork-default-repo-");
    try {
      mkdirSync(join(dir, ".agent-flows"), { recursive: true });
      const target = resolveForkTarget(dir, undefined, { AGENT_FLOWS_HOME: join(dir, "home") });
      assert.equal(target.target, "repo");
      assert.equal(target.root, join(dir, ".agent-flows"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is the user library when the project has no canon directory", () => {
    const dir = tempDir("af-fork-default-user-");
    try {
      const home = join(dir, "home");
      const target = resolveForkTarget(dir, undefined, { AGENT_FLOWS_HOME: home });
      assert.equal(target.target, "user");
      assert.equal(target.root, userLibraryRoot({ AGENT_FLOWS_HOME: home }));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("an explicit --to wins over both defaults", () => {
    const dir = tempDir("af-fork-explicit-");
    try {
      mkdirSync(join(dir, ".agent-flows"), { recursive: true });
      const home = join(dir, "home");
      const user = resolveForkTarget(dir, "user", { AGENT_FLOWS_HOME: home });
      assert.equal(user.target, "user", "--to user overrides an existing repository canon");
      const repo = resolveForkTarget(dir, "repo", { AGENT_FLOWS_HOME: home });
      assert.equal(repo.target, "repo");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("FR-021: fork refuses to overwrite an id the target layer already holds", () => {
  it("names the layer that holds it and leaves the file untouched", () => {
    const dir = tempDir("af-fork-overwrite-");
    try {
      const source = makeLayer("bundled", join(dir, "package"));
      writeParent(source);
      writeChild(source);
      const repo = makeLayer("repo", join(dir, "project", ".agent-flows"));
      writeFileSync(
        join(repo.pipelinesDir, "parent.yaml"),
        "id: parent\nversion: 1\ndescription: mine\ninputs: []\nsteps: []\n"
      );
      const catalog = mergedCatalog([source, repo]);

      assert.throws(
        () =>
          forkPipeline({
            id: "parent",
            catalog,
            target: { target: "repo", root: repo.root },
            overwrite: false,
          }),
        (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.match(err.message, /already exists in the repo layer/u, err.message);
          return true;
        }
      );
      assert.match(
        readFileSync(join(repo.pipelinesDir, "parent.yaml"), "utf8"),
        /description: mine/u,
        "the existing copy is untouched"
      );

      const report = forkPipeline({
        id: "parent",
        catalog,
        target: { target: "repo", root: repo.root },
        overwrite: true,
      });
      assert.ok(report.written.includes("pipelines/parent.yaml"));
      assert.match(
        readFileSync(join(repo.pipelinesDir, "parent.yaml"), "utf8"),
        /description: a parent that mounts a child/u,
        "--overwrite replaces it"
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses an id no layer defines", () => {
    const dir = tempDir("af-fork-unknown-");
    try {
      const source = makeLayer("bundled", join(dir, "package"));
      assert.throws(
        () =>
          forkPipeline({
            id: "nope",
            catalog: mergedCatalog([source]),
            target: { target: "repo", root: join(dir, "project", ".agent-flows") },
            overwrite: false,
          }),
        /no workflow "nope"/u
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── FR-023: nothing writes under the resolved package root ───────────────────
//
// The Ship 1 half asserts a misresolved package root is rejected; this is the
// other half — the resolved root is never a write target. Both write paths that
// take a layer root (fork and import) are checked against the real resolved
// root, not a stand-in, because a guard that only knows about a fixture proves
// nothing about the installed package.

describe("FR-023: no code path writes into the package directory", () => {
  it("assertWritableRoot refuses the package root itself", () => {
    assert.throws(
      () => assertWritableRoot(packageRoot()),
      /refusing to write into the installed package/u
    );
  });

  it("assertWritableRoot refuses a directory inside the package", () => {
    assert.throws(
      () => assertWritableRoot(join(packageRoot(), "pipelines")),
      /refusing to write into the installed package/u
    );
    assert.throws(
      () => assertWritableRoot(join(packageRoot(), "a", "..", "prompts")),
      /refusing to write into the installed package/u
    );
  });

  it("forking into the package root throws and writes nothing", () => {
    const dir = tempDir("af-fork-package-");
    try {
      const source = makeLayer("bundled", join(dir, "package"));
      writeParent(source);
      writeChild(source);
      const before = statSync(join(packageRoot(), "pipelines")).mtimeMs;

      assert.throws(
        () =>
          forkPipeline({
            id: "parent",
            catalog: mergedCatalog([source]),
            target: { target: "repo", root: packageRoot() },
            overwrite: true,
          }),
        /refusing to write into the installed package/u
      );

      assert.ok(
        !existsSync(join(packageRoot(), "pipelines", "parent.yaml")),
        "the fixture pipeline must not appear in the package"
      );
      assert.equal(
        statSync(join(packageRoot(), "pipelines")).mtimeMs,
        before,
        "the package is untouched"
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a layer root outside the package is accepted", () => {
    const dir = tempDir("af-fork-outside-");
    try {
      assertWritableRoot(join(dir, "workflows"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
