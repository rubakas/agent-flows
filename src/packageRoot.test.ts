// Spec 038 FR-004: the package root is resolved by walking up to package.json,
// identically under tsx (src/) and compiled (dist/), and the resolution asserts
// the root really is an agent-flows package.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { bundledPipelinesDir, packageRoot, resolvePackageRootFrom } from "./packageRoot.js";

const tmpRoots: string[] = [];

function makeTmpRoot(contents: string[]): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "af-pkg-root-")));
  tmpRoots.push(root);
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture" }));
  for (const dir of contents) mkdirSync(join(root, dir));
  return root;
}

after(() => {
  for (const root of tmpRoots) rmSync(root, { recursive: true, force: true });
});

describe("FR-004: packageRoot() resolves this package", () => {
  it("resolves the directory that holds package.json, pipelines/ and prompts/", () => {
    const root = packageRoot();
    assert.ok(existsSync(join(root, "package.json")), `${root} must hold package.json`);
    assert.ok(existsSync(join(root, "pipelines")), `${root} must hold pipelines/`);
    assert.ok(existsSync(join(root, "prompts")), `${root} must hold prompts/`);
  });

  it("derives the bundled asset directories from that root", () => {
    assert.equal(bundledPipelinesDir(), join(packageRoot(), "pipelines"));
    assert.ok(existsSync(join(bundledPipelinesDir(), "investigate.yaml")));
  });

  it("resolves the same root from a src/ module and from a dist/ module", () => {
    // Both modes ask from a directory one level below the root; the walk is what
    // makes them agree, where a fixed "../.." hop count would not.
    const root = packageRoot();
    assert.equal(resolvePackageRootFrom(join(root, "src", "bindings", "mastra")), root);
    assert.equal(resolvePackageRootFrom(join(root, "dist", "bindings", "mastra")), root);
  });

  it("stops at the nearest package.json, not the outermost one", () => {
    const outer = makeTmpRoot(["pipelines", "prompts"]);
    const inner = join(outer, "nested");
    mkdirSync(inner);
    writeFileSync(join(inner, "package.json"), JSON.stringify({ name: "inner" }));
    mkdirSync(join(inner, "pipelines"));
    mkdirSync(join(inner, "prompts"));
    assert.equal(resolvePackageRootFrom(inner), inner);
  });
});

describe("FR-004: the resolution refuses a root that is not an agent-flows package", () => {
  it("throws naming the path and the missing directory when pipelines/ is absent", () => {
    const root = makeTmpRoot(["prompts"]);
    assert.throws(
      () => resolvePackageRootFrom(root),
      (err: Error) => {
        assert.match(err.message, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")));
        assert.match(err.message, /pipelines/);
        return true;
      }
    );
  });

  it("throws naming both missing directories when neither is present", () => {
    const root = makeTmpRoot([]);
    assert.throws(() => resolvePackageRootFrom(root), /missing pipelines and prompts\//u);
  });

  it("throws when prompts/ is absent", () => {
    const root = makeTmpRoot(["pipelines"]);
    assert.throws(() => resolvePackageRootFrom(root), /missing prompts\//u);
  });

  it("throws when no package.json exists above the start directory", () => {
    // "/" has no package.json above it on any machine this runs on.
    assert.throws(() => resolvePackageRootFrom("/"), /no package\.json found above/u);
  });
});
