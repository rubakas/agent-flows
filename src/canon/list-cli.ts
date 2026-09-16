#!/usr/bin/env tsx
// `agent-flows list` — the workflows this project can run (spec 038 FR-020).

import { resolveProjectDir } from "../bindings/mastra/projectDir.js";
import { resolveProjectState } from "../runtime/projectState.js";
import { readHidden } from "../runtime/visibility.js";
import { catalogRows, resolveCatalog } from "./layers.js";

const projectDir = resolveProjectDir();
const state = resolveProjectState(projectDir);
const catalog = resolveCatalog(projectDir);
const hidden = readHidden(state.dir);

console.log(`Project: ${projectDir}`);
console.log(`State:   ${state.dir}`);
console.log("");
console.log("LAYERS:");
for (const layer of catalog.layers) {
  console.log(`  ${layer.source.padEnd(8)} ${layer.root}`);
}
console.log("");
console.log("AVAILABLE WORKFLOWS:");
for (const entry of catalogRows(catalog)) {
  const shadowed = entry.shadows.length > 0 ? ` (shadows ${entry.shadows.join(", ")})` : "";
  // A hidden workflow still runs when named by id (spec 038 FR-026) — the mark
  // says it is unlisted on the chat and page surfaces, not that it is refused.
  const mark = hidden.has(entry.id) ? " [hidden]" : "";
  console.log(`  ${entry.id.padEnd(24)} [${entry.layer.source}]${shadowed}${mark}`);
}

for (const err of catalog.errors) {
  console.error(`  ! ${err.file}: ${err.error}`);
}
