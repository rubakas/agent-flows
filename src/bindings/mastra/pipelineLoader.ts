import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { listPipelines, loadPipeline } from "../../canon/load.js";
import type { LoadedPipeline } from "../../canon/types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// When running via tsx (source), __dirname is src/bindings/mastra.
// Bundled pipelines live three directories up, then pipelines/.
export const BUNDLED_PIPELINES_DIR = join(__dirname, "..", "..", "..", "pipelines");

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
