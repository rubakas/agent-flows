#!/usr/bin/env tsx
import { mkdirSync, writeFileSync } from "node:fs";
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
  const workflow = generateN8nWorkflow(loaded);
  const outFile = join(outDir, `${loaded.def.id}.json`);
  writeFileSync(outFile, JSON.stringify(workflow, null, 2));
  console.log(`Written: ${outFile}`);
}
