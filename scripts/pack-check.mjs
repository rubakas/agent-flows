#!/usr/bin/env node
// Spec 038 FR-005, run by hand after `pnpm build`:
//
//   node scripts/pack-check.mjs
//
// Packs the real tarball into a temp directory and asserts its contents against
// the D3 allowlist: the compiled page assets, every bundled pipeline and prompt,
// the launcher — and no sources, specs, docs, scripts or test files. Exits
// non-zero and lists every violation when the tarball is wrong.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outDir = mkdtempSync(join(tmpdir(), "af-pack-"));
const failures = [];

try {
  const packed = execFileSync("npm", ["pack", "--pack-destination", outDir, "--json"], {
    cwd: root,
    encoding: "utf8",
  });
  const tarball = join(outDir, JSON.parse(packed)[0].filename);
  const listing = execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" });
  const files = listing
    .split("\n")
    .filter(Boolean)
    .map((p) => p.replace(/^package\//, ""))
    .filter((p) => !p.endsWith("/"));

  const required = [
    "package.json",
    "README.md",
    "bin/agent-flows",
    "dist/cli.js",
    "dist/serve/ui.html",
    "dist/serve/ui-route.js",
    "dist/serve/ui-graph.js",
    "dist/serve/ui-log.js",
    "dist/serve/ui-tables.js",
  ];
  for (const name of required) {
    if (!files.includes(name)) failures.push(`missing from the tarball: ${name}`);
  }

  const pipelines = files.filter((f) => /^pipelines\/.+\.ya?ml$/.test(f));
  const prompts = files.filter((f) => /^prompts\/.+\.md$/.test(f));
  if (pipelines.length < 10) failures.push(`only ${pipelines.length} pipelines in the tarball`);
  if (prompts.length < 10) failures.push(`only ${prompts.length} prompts in the tarball`);

  for (const f of files) {
    if (/^(src|specs|docs|scripts|litellm)\//.test(f) || /\.test\.[jt]s$/.test(f)) {
      failures.push(`must not be published: ${f}`);
    }
  }

  console.log(`Packed ${String(files.length)} files from ${tarball}`);
} finally {
  rmSync(outDir, { recursive: true, force: true });
}

if (failures.length > 0) {
  for (const f of failures) console.error(`FAIL ${f}`);
  process.exit(1);
}
console.log("pack-check: tarball contents match the spec 038 D3 allowlist.");
