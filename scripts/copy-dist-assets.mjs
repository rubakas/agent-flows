#!/usr/bin/env node
// Copies the page assets that `tsc` never emits into dist/ (spec 038 D2, FR-001).
//
// tsconfig.json sets no `allowJs`, so the four hand-written browser modules and
// ui.html are invisible to the compiler. The daemon reads the page as
// join(__dirname, "ui.html") and each module as a sibling of it, so without this
// step every page route on a compiled build answers 503.
//
// The files are copied verbatim, never compiled: the browser and the unit tests
// must load identical bytes whether they come from src/ or dist/.

import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const PAGE_ASSETS = ["ui.html", "ui-route.js", "ui-graph.js", "ui-log.js", "ui-tables.js"];

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

export function copyPageAssets(root = packageRoot) {
  const srcDir = join(root, "src", "serve");
  const destDir = join(root, "dist", "serve");
  const missing = PAGE_ASSETS.filter((name) => !existsSync(join(srcDir, name)));
  if (missing.length > 0) {
    throw new Error(`copy-dist-assets: missing page asset(s) in ${srcDir}: ${missing.join(", ")}`);
  }
  mkdirSync(destDir, { recursive: true });
  for (const name of PAGE_ASSETS) {
    copyFileSync(join(srcDir, name), join(destDir, name));
  }
  return destDir;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const destDir = copyPageAssets();
  for (const name of PAGE_ASSETS) console.log(`Copied: ${join(destDir, name)}`);
}
