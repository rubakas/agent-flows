#!/usr/bin/env tsx
// `agent-flows fork <id> [--to user|repo] [--overwrite]` (spec 038 FR-021).

import { resolveProjectDir } from "../bindings/mastra/projectDir.js";
import { flag, option } from "../cliArgs.js";
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
const overwrite = flag(args, "--overwrite");

let requested: ForkTarget | undefined;
const to = option(args, "--to");
if (to !== undefined) {
  if (to !== "user" && to !== "repo") {
    console.error(`agent-flows fork: --to must be "user" or "repo", got ${JSON.stringify(to)}`);
    process.exit(1);
  }
  requested = to;
}

const projectDir = resolveProjectDir();
const catalog = resolveCatalog(projectDir);
const target = resolveForkTarget(projectDir, catalog.layers, requested);

try {
  const report = forkPipeline({ id, catalog, target, overwrite });
  console.log(`Forked "${report.id}" from the ${report.from} layer into ${report.root}`);
  for (const path of report.written) console.log(`  + ${path}`);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
