#!/usr/bin/env tsx
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { listPipelines, loadPipeline } from "../../canon/load.js";
import { generateN8nWorkflow } from "./build.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = join(__dirname, "..", "..", "..");

const pipelinesDir = join(repoRoot, "pipelines");
const outDir = join(repoRoot, ".n8n-workflows");

mkdirSync(outDir, { recursive: true });

const yamlFiles = listPipelines(pipelinesDir);
for (const yamlFile of yamlFiles) {
  const loaded = loadPipeline(yamlFile);
  const outFile = join(outDir, `${loaded.def.id}.json`);
  let workflow;
  try {
    workflow = generateN8nWorkflow(loaded);
  } catch (err) {
    // FR-008: a pipeline that fails generation (e.g. FR-006 NoOp reference) must not
    // leave a stale, silently-broken artifact. Delete any existing file and skip.
    console.error(`Skipped ${loaded.def.id}: ${(err as Error).message}`);
    try {
      rmSync(outFile);
      console.log(`Deleted stale artifact: ${outFile}`);
    } catch {
      // File may not exist; that is fine.
    }
    continue;
  }
  writeFileSync(outFile, JSON.stringify(workflow, null, 2));
  console.log(`Written: ${outFile}`);
}
