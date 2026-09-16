#!/usr/bin/env node
// Generates Claude Code workflow bindings for the bundled pipelines.
//
// Usage: agent-flows generate claude [--help]
//
// Spec 038 D12/FR-007: nothing here touches the filesystem before the
// arguments are parsed, and the output goes into the *project* — under a global
// install the package directory may be root-owned, so a top-level mkdirSync was
// an EACCES on every invocation, `--help` included, and it wrote generated
// workflows into the tool instead of the user's repository.

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { listPipelines, loadPipeline } from "../canon/load.js";
import { loadProviders } from "../canon/loadProviders.js";
import { defaultRegistry, getActiveProfile } from "../canon/registry.js";
import { bundledPipelinesDir } from "../packageRoot.js";
import { generateWorkflowScript } from "./claudeCode.js";
import { resolveProjectDir } from "./mastra/projectDir.js";

function usage(): void {
  console.log("Usage: agent-flows generate claude");
  console.log("");
  console.log("Writes a Claude Code workflow script per bundled pipeline into");
  console.log("<project>/.claude/workflows/, where <project> is");
  console.log("AGENT_FLOWS_PROJECT_DIR or the current directory.");
}

function main(args: string[]): void {
  if (args.includes("--help") || args.includes("-h")) {
    usage();
    return;
  }

  // The pipelines are read from the package (spec 038 D5); everything written
  // and every project override read belongs to the project directory.
  const pipelinesDir = bundledPipelinesDir();
  const projectDir = resolveProjectDir();
  const outDir = join(projectDir, ".claude", "workflows");

  mkdirSync(outDir, { recursive: true });

  const providers = loadProviders(projectDir);
  const profile = getActiveProfile(process.env, providers);
  const registry = defaultRegistry(process.env, providers.models);
  const yamlFiles = listPipelines(pipelinesDir);
  for (const yamlFile of yamlFiles) {
    const loaded = loadPipeline(yamlFile);
    const outFile = join(outDir, `${loaded.def.id}.js`);
    let script: string;
    try {
      script = generateWorkflowScript(loaded, profile, registry);
    } catch (err) {
      // A pipeline with unsupported step kinds is refused loudly. Delete any stale
      // artifact so the directory does not contain silently-broken workflows.
      console.error(`Skipped ${loaded.def.id}: ${(err as Error).message}`);
      try {
        rmSync(outFile);
        console.log(`Deleted stale artifact: ${outFile}`);
      } catch {
        // File may not exist; that is fine.
      }
      continue;
    }
    writeFileSync(outFile, script);
    console.log(`Written: ${outFile}`);
  }
}

main(process.argv.slice(2));
