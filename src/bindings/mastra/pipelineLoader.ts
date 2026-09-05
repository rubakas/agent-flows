import { listPipelines, loadPipeline } from "../../canon/load.js";
import type { LoadedPipeline } from "../../canon/types.js";

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
