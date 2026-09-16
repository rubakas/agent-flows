import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
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

export interface CanonDirResult {
  pipelinesDir: string;
  source: "project" | "bundled";
}

/**
 * Resolves the directory from which pipeline YAMLs are loaded.
 *
 * Prefers <projectDir>/.agent-flows/pipelines/ when it exists and contains
 * at least one YAML file — the project's installed copy is authoritative.
 * Falls back to the bundled pipelines/ directory (this tool's own checkout).
 *
 * Callers should log the returned source so operators can see which set
 * of pipelines is active.
 */
export function resolveCanonDir(projectDir: string): CanonDirResult {
  const projectPipelinesDir = join(projectDir, ".agent-flows", "pipelines");
  if (existsSync(projectPipelinesDir)) {
    const hasYaml = readdirSync(projectPipelinesDir).some(
      (f) => f.endsWith(".yaml") || f.endsWith(".yml")
    );
    if (hasYaml) {
      return { pipelinesDir: projectPipelinesDir, source: "project" };
    }
  }
  return { pipelinesDir: BUNDLED_PIPELINES_DIR, source: "bundled" };
}
