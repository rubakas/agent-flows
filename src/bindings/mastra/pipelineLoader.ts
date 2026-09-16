import { listPipelines, loadPipeline } from "../../canon/load.js";
import { bundledPipelinesDir } from "../../packageRoot.js";
import type { LoadedPipeline } from "../../canon/types.js";

// Resolved from the package root (spec 038 D5) so the same code is correct
// under tsx from src/ and compiled from dist/, and under a global install.
export const BUNDLED_PIPELINES_DIR = bundledPipelinesDir();

export interface LoadError {
  file: string;
  error: string;
}

export interface PipelineCatalog {
  loaded: LoadedPipeline[];
  errors: LoadError[];
}

/**
 * Scans pipelinesDir for YAML files and tries to load each as a pipeline.
 * Returns valid pipelines in `loaded` and per-file errors in `errors`.
 * A malformed file does not abort loading of the rest.
 */
export function loadCatalog(pipelinesDir: string): PipelineCatalog {
  const files = listPipelines(pipelinesDir);
  const loaded: LoadedPipeline[] = [];
  const errors: LoadError[] = [];
  for (const f of files) {
    try {
      loaded.push(loadPipeline(f));
    } catch (err) {
      errors.push({ file: f, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { loaded, errors };
}

// `resolveCanonDir` lived here until spec 038 D13 (Ship 3). It returned a single
// directory and flipped the whole catalogue to <projectDir>/.agent-flows the
// moment that directory held one YAML file. That exclusive flip is why an
// install step had to exist at all — a project could only use a bundled
// workflow by copying it in — and, worse, it made every later package upgrade
// invisible: a project that had ever installed anything kept answering every
// query from its own layer, so a newly shipped workflow simply never appeared.
//
// It is replaced by the merged three-layer view in src/canon/layers.ts
// (bundled < user library < repository canon, a later layer winning on an id
// collision). Every read path — the daemon's listing and detail routes, MCP
// list_pipelines, run entry resolution, the Mastra rebuild and export — resolves
// through `resolveCatalog` instead. Nothing resolves a catalogue from one
// directory any more; do not reintroduce a helper that does.
