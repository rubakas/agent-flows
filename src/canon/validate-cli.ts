import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { listPipelines, loadPipeline } from "./load.js";
import { renderPortabilityMatrix } from "./portability.js";
import { MATRIX_PROFILE_IDS, defaultRegistry, getProfile } from "./registry.js";
import type { LoadedPipeline } from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = join(__dirname, "..", "..");
const pipelinesDir = join(repoRoot, "pipelines");

const files = listPipelines(pipelinesDir);
let hasError = false;
const loaded: LoadedPipeline[] = [];

for (const file of files) {
  try {
    const pipeline = loadPipeline(file);
    loaded.push(pipeline);
    console.log(`${pipeline.def.id} OK (${pipeline.def.steps.length} steps)`);
  } catch (e) {
    console.error(`ERROR: ${file}: ${String(e)}`);
    hasError = true;
  }
}

// D4/FR-008: which pipeline runs under which provider profile, with no model calls.
console.log("\nPortability matrix (pipeline × profile):");
console.log(
  renderPortabilityMatrix(
    loaded,
    MATRIX_PROFILE_IDS.map((id) => getProfile(id)),
    defaultRegistry()
  )
);

if (hasError) process.exit(1);
