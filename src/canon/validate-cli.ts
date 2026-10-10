import { loadBundledCatalogue } from "./pipelines.js";
import { renderPortabilityMatrix } from "./portability.js";
import { MATRIX_PROFILE_IDS, defaultRegistry, getProfile } from "./registry.js";

// Every error the catalogue reports is fatal: a file that does not parse, has no
// id, collides with another file's id or fails to load, or no file at all.
const { found, errors } = loadBundledCatalogue();
const loaded = found.map((f) => f.loaded);

for (const { loaded: pipeline } of found) {
  console.log(`${pipeline.def.id} OK (${pipeline.def.steps.length} steps)`);
}
for (const { file, error } of errors) {
  console.error(`ERROR: ${file}: ${error}`);
}
const hasError = errors.length > 0;

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
