#!/usr/bin/env tsx
// Workflow installer for agent-flows.
//
// Usage:
//   tsx src/install/run.ts install [--overwrite-installed] [<id>...]
//   tsx src/install/run.ts list
//
// install: copies named workflows (or all) and their transitive dependencies
//          into <projectDir>/.agent-flows/. Skips existing files by default.
//          Use --overwrite-installed to replace them.
// list:    shows which workflows are installed and which are available.

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveProjectDir } from "../bindings/mastra/projectDir.js";
import { installWorkflow, listAvailable, listInstalled } from "./install.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = join(__dirname, "..", "..");
const bundledPipelinesDir = join(repoRoot, "pipelines");

const [, , subcommand, ...rest] = process.argv;

if (!subcommand || subcommand === "--help" || subcommand === "-h") {
  console.log("Usage:");
  console.log("  tsx src/install/run.ts install [--overwrite-installed] [<id>...]");
  console.log("  tsx src/install/run.ts list");
  process.exit(0);
}

const projectDir = resolveProjectDir();

if (subcommand === "list") {
  const available = listAvailable(bundledPipelinesDir);
  const installed = new Set(listInstalled(projectDir));
  console.log(`Project: ${projectDir}`);
  console.log("");
  console.log("AVAILABLE WORKFLOWS:");
  for (const id of available) {
    const status = installed.has(id) ? "[installed]" : "[not installed]";
    console.log(`  ${id.padEnd(20)} ${status}`);
  }
  process.exit(0);
}

if (subcommand === "install") {
  const overwrite = rest.includes("--overwrite-installed");
  const ids = rest.filter((a) => !a.startsWith("--"));
  const targets = ids.length > 0 ? ids : listAvailable(bundledPipelinesDir);

  console.log(`Installing into ${projectDir}/.agent-flows/`);
  console.log(`Workflows: ${targets.join(", ")}`);
  console.log(`Overwrite existing: ${overwrite ? "yes (--overwrite-installed)" : "no"}`);
  console.log("");

  const { written, skipped } = installWorkflow(targets, bundledPipelinesDir, projectDir, overwrite);

  if (written.length > 0) {
    console.log(`WRITTEN (${written.length.toString()}):`);
    for (const f of written) console.log(`  + ${f}`);
  }
  if (skipped.length > 0) {
    console.log(
      `SKIPPED (${skipped.length.toString()}) — file already exists; use --overwrite-installed to replace:`
    );
    for (const f of skipped) console.log(`  = ${f}`);
  }
  if (written.length === 0 && skipped.length === 0) {
    console.log("Nothing to install.");
  }
  process.exit(0);
}

console.error(`Unknown subcommand: ${subcommand}`);
console.error("Run with --help for usage.");
process.exit(1);
