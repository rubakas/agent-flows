#!/usr/bin/env tsx
// `agent-flows fork <id> [--to user|repo] [--overwrite]` (spec 038 FR-021).
//
// Copies one workflow out of the layer that owns it into a writable layer, so
// it can be edited. Nested pipelines are deliberately not copied: the merged
// view resolves a mount across layers, so the fork keeps mounting the same
// children it mounted before.

import { resolveProjectDir } from "../bindings/mastra/projectDir.js";
import { forkPipeline, resolveForkTarget, type ForkTarget } from "./fork.js";
import { resolveCatalog } from "./layers.js";

const args = process.argv.slice(2);

function usage(): void {
  console.log("Usage: agent-flows fork <id> [--to user|repo] [--overwrite]");
  console.log("");
  console.log("  --to user   copy into the machine-wide user library");
  console.log("  --to repo   copy into this project's .agent-flows/ canon");
  console.log("  --overwrite replace a workflow of the same id already in the target layer");
}

if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
  usage();
  process.exit(0);
}

const id = args[0];
const overwrite = args.includes("--overwrite");

let requested: ForkTarget | undefined;
const toIndex = args.indexOf("--to");
if (toIndex !== -1) {
  const value = args[toIndex + 1];
  if (value !== "user" && value !== "repo") {
    console.error(`agent-flows fork: --to must be "user" or "repo", got ${JSON.stringify(value)}`);
    process.exit(1);
  }
  requested = value;
}

const projectDir = resolveProjectDir();
const catalog = resolveCatalog(projectDir);
const target = resolveForkTarget(projectDir, requested);

try {
  const report = forkPipeline({ id, catalog, target, overwrite });
  console.log(`Forked "${report.id}" from the ${report.from} layer into ${report.root}`);
  for (const path of report.written) console.log(`  + ${path}`);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
