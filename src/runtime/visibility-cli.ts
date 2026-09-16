#!/usr/bin/env tsx
// `agent-flows enable <id>` / `agent-flows disable <id>` (spec 038 FR-025).
//
// Edits this project's `<stateDir>/visibility.json`. Hiding declutters the chat
// surface: a hidden workflow is unlisted, never refused.

import { resolveProjectDir } from "../bindings/mastra/projectDir.js";
import { resolveCatalog } from "../canon/layers.js";
import { resolveProjectState } from "./projectState.js";
import { setHidden } from "./visibility.js";

const [, , verb, id] = process.argv;

if (verb !== "enable" && verb !== "disable") {
  console.error("Usage: agent-flows enable|disable <id>");
  process.exit(1);
}

if (!id || id.startsWith("-")) {
  console.error(`agent-flows ${verb}: a workflow id is required.`);
  process.exit(1);
}

const projectDir = resolveProjectDir();
const state = resolveProjectState(projectDir);
const hide = verb === "disable";
const hidden = setHidden(state.dir, id, hide);

// An id the merged view does not (or no longer does) define is recorded anyway:
// a layer can add it later, and refusing here would make the file unable to
// express "keep this hidden if it comes back".
if (!resolveCatalog(projectDir).entries.has(id)) {
  console.log(`Note: no workflow "${id}" in this project's layers right now.`);
}

console.log(hide ? `Hidden: ${id}` : `Visible: ${id}`);
console.log(`Hidden in this project: ${hidden.length > 0 ? hidden.join(", ") : "(none)"}`);
