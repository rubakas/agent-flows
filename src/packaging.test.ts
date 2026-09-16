// Spec 038 FR-005: package.json's `files` field is the enumerated allowlist that
// decides what ships.
//
// Without it npm falls back to .gitignore, whose second line is `dist/` — so a
// tarball built today would silently contain no compiled output at all. The list
// is asserted exactly, and `npm pack` is asked what it would actually ship.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { packageRoot } from "./packageRoot.js";

const ROOT = packageRoot();
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
  name: string;
  version: string;
  files?: string[];
  scripts: Record<string, string>;
};

/** The paths `npm pack` would put in the tarball, without the "package/" prefix. */
function packedFiles(): string[] {
  const out = execFileSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const report = JSON.parse(out) as { files: { path: string }[] }[];
  return report[0].files.map((f) => f.path);
}

describe("FR-005: the packaging allowlist", () => {
  it("files lists exactly the shipped roots", () => {
    // LICENSE is absent from this repository, so it is absent from the list:
    // npm warns about a `files` entry that matches nothing.
    assert.deepEqual(pkg.files, ["dist", "pipelines", "prompts", "bin", "README.md"]);
  });

  it("the package is named @rubakas/agent-flows", () => {
    assert.equal(pkg.name, "@rubakas/agent-flows");
  });

  it("build compiles and then copies the page assets", () => {
    assert.match(pkg.scripts.build, /tsc\b/u);
    assert.match(pkg.scripts.build, /copy-dist-assets\.mjs/u);
  });
});

describe("FR-005: what npm pack would ship", () => {
  const files = packedFiles();

  it("ships every bundled pipeline and prompt", () => {
    const pipelines = files.filter((f) => /^pipelines\/.+\.ya?ml$/u.test(f));
    const prompts = files.filter((f) => /^prompts\/.+\.md$/u.test(f));
    assert.ok(pipelines.includes("pipelines/investigate.yaml"), "pipelines/*.yaml must ship");
    assert.ok(pipelines.length >= 10, `expected the full pipeline set, got ${pipelines.length}`);
    assert.ok(prompts.length >= 10, `expected the full prompt set, got ${prompts.length}`);
  });

  it("ships the launcher and the manifest", () => {
    assert.ok(files.includes("bin/agent-flows"));
    assert.ok(files.includes("package.json"));
    assert.ok(files.includes("README.md"));
  });

  it("ships no sources, specs, docs, scripts or test files", () => {
    const forbidden = files.filter(
      (f) => /^(src|specs|docs|scripts|litellm)\//u.test(f) || /\.test\.[jt]s$/u.test(f)
    );
    assert.deepEqual(forbidden, [], `these must never be published: ${forbidden.join(", ")}`);
  });

  it("ships the compiled page assets once a build has run", (t) => {
    if (!existsSync(join(ROOT, "dist", "serve", "ui.html"))) {
      // The suite runs from src/ and does not build; scripts/pack-check.mjs is
      // the full-tarball gate, run by hand after `pnpm build`.
      t.skip("no dist/ present — run `pnpm build` first, or use scripts/pack-check.mjs");
      return;
    }
    for (const name of ["ui.html", "ui-route.js", "ui-graph.js", "ui-log.js", "ui-tables.js"]) {
      assert.ok(files.includes(`dist/serve/${name}`), `dist/serve/${name} must ship`);
    }
    assert.ok(files.includes("dist/cli.js"), "dist/cli.js must ship — bin/agent-flows runs it");
  });
});
