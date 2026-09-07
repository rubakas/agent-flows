#!/usr/bin/env tsx
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { listPipelines, loadPipeline } from "../canon/load.js";
import { loadProviders } from "../canon/loadProviders.js";
import { defaultRegistry, getActiveProfile } from "../canon/registry.js";
import { generateWorkflowScript } from "./claudeCode.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = join(__dirname, "..", "..");

const pipelinesDir = join(repoRoot, "pipelines");
const outDir = join(repoRoot, ".claude", "workflows");

mkdirSync(outDir, { recursive: true });

const providers = loadProviders(repoRoot);
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
