// The merged three-layer workflow view (spec 038 D13, FR-017–FR-020).
//
// A layer is a root directory holding `pipelines/` and a sibling `prompts/`.
// Three of them, in precedence order, a later one winning on an id collision:
//
//   1. bundled — the installed package root, always present, never written to;
//   2. user library — <stateRoot>/workflows (AGENT_FLOWS_HOME honoured);
//   3. repository canon — <projectDir>/.agent-flows.
//
// Keeping all three shaped identically is what makes the sibling-prompts rule
// uniform: a pipeline's prompts are always the `prompts/` directory of the layer
// that owns it, so a repository pipeline can never read a bundled prompt file.
//
// A layer that does not exist on disk simply contributes nothing — nothing here
// creates a directory.
//
// This module deliberately imports neither Mastra nor the server: the daemon,
// the MCP process and the unit tests all need it.

import { readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parse } from "yaml";

import { bundledPipelinesDir, packageRoot } from "../packageRoot.js";
import { stateRoot } from "../runtime/projectState.js";
import { listPipelines, loadPipeline } from "./load.js";
import type { LoadDeps } from "./load.js";
import type { LoadedPipeline } from "./types.js";
import type { StateEnv } from "../runtime/projectState.js";

/** Which of the three layers a workflow came from. */
export type LayerSource = "bundled" | "user" | "repo";

/** One root directory contributing workflows, with its two subdirectories. */
export interface CanonLayer {
  source: LayerSource;
  /** The layer root — the parent of both directories below. */
  root: string;
  /** <root>/pipelines */
  pipelinesDir: string;
  /** <root>/prompts — the only prompts directory a pipeline of this layer reads. */
  promptsDir: string;
}

/** One workflow id as the merged view resolves it. */
export interface CatalogEntry {
  id: string;
  /** The YAML file the winning layer defines this id in. */
  filePath: string;
  /** The layer that owns this id. */
  layer: CanonLayer;
  /**
   * Sources of same-id workflows in earlier layers, lowest precedence first.
   * Non-empty means this entry shadows them (FR-020).
   */
  shadows: LayerSource[];
}

/** A file that could not be read as a pipeline while building the catalogue. */
export interface CatalogError {
  file: string;
  error: string;
}

/** The merged catalogue: one winning entry per id, plus the layers it came from. */
export interface MergedCatalog {
  layers: CanonLayer[];
  entries: Map<string, CatalogEntry>;
  errors: CatalogError[];
}

/** A catalogue entry together with its fully loaded (and expanded) pipeline. */
export interface MergedPipeline {
  entry: CatalogEntry;
  loaded: LoadedPipeline;
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function layerFrom(source: LayerSource, root: string): CanonLayer {
  return {
    source,
    root,
    pipelinesDir: join(root, "pipelines"),
    promptsDir: join(root, "prompts"),
  };
}

/** <stateRoot>/workflows — the personal, machine-wide layer (D13). */
export function userLibraryRoot(env: StateEnv = process.env): string {
  return join(stateRoot(env), "workflows");
}

/** <projectDir>/.agent-flows — the committed, team-shared layer (D13). */
export function repoCanonRoot(projectDir: string): string {
  return join(projectDir, ".agent-flows");
}

/**
 * The layers present for `projectDir`, in precedence order (FR-017).
 *
 * `env` is injected rather than read from the ambient environment at the call
 * site so a test can pin AGENT_FLOWS_HOME and never touch the owner's real
 * user library.
 */
export function resolveLayers(projectDir: string, env: StateEnv = process.env): CanonLayer[] {
  const layers: CanonLayer[] = [layerFrom("bundled", packageRoot())];
  const userRoot = userLibraryRoot(env);
  if (isDir(userRoot)) layers.push(layerFrom("user", userRoot));
  const repoRoot = repoCanonRoot(projectDir);
  if (isDir(repoRoot)) layers.push(layerFrom("repo", repoRoot));
  return layers;
}

/**
 * The single layer a caller-pinned pipelines directory stands for.
 *
 * `serve --pipelines-dir` and the tests pin one directory; it still has to be a
 * layer so every read path goes through the merged view rather than keeping a
 * second, divergent code path. It is the bundled layer when it *is* the bundled
 * directory, and a repository-shaped layer otherwise.
 */
export function layerForPipelinesDir(pipelinesDir: string): CanonLayer {
  const dir = resolve(pipelinesDir);
  const source: LayerSource = dir === resolve(bundledPipelinesDir()) ? "bundled" : "repo";
  const root = dirname(dir);
  return { source, root, pipelinesDir: dir, promptsDir: join(root, "prompts") };
}

/** The declared `id` of a pipeline file, without validating the rest of it. */
function pipelineIdOf(filePath: string): string | undefined {
  const raw = parse(readFileSync(filePath, "utf8")) as { id?: unknown } | null;
  const id = raw?.id;
  return typeof id === "string" && id !== "" ? id : undefined;
}

/**
 * Merge the given layers into one catalogue, a later layer winning on an id
 * collision (FR-017).
 *
 * The id comes from the file's own `id` field via a raw parse, not from its
 * name: precedence is about ids, and a file that fails full validation still
 * has to take part in the merge rather than silently leaving the shadowed copy
 * in force.
 */
export function mergedCatalog(layers: readonly CanonLayer[]): MergedCatalog {
  const entries = new Map<string, CatalogEntry>();
  const errors: CatalogError[] = [];
  for (const layer of layers) {
    let files: string[];
    try {
      files = listPipelines(layer.pipelinesDir);
    } catch {
      continue; // a layer root without a pipelines/ directory contributes nothing
    }
    for (const filePath of [...files].sort()) {
      let id: string | undefined;
      try {
        id = pipelineIdOf(filePath);
      } catch (err) {
        errors.push({ file: filePath, error: err instanceof Error ? err.message : String(err) });
        continue;
      }
      if (id === undefined) {
        errors.push({ file: filePath, error: 'pipeline file has no "id" field' });
        continue;
      }
      const previous = entries.get(id);
      entries.set(id, {
        id,
        filePath,
        layer,
        shadows: previous ? [...previous.shadows, previous.layer.source] : [],
      });
    }
  }
  return { layers: [...layers], entries, errors };
}

/** The merged catalogue for a project — the read path every surface uses. */
export function resolveCatalog(projectDir: string, env: StateEnv = process.env): MergedCatalog {
  return mergedCatalog(resolveLayers(projectDir, env));
}

/** Catalogue entries ordered by id, for listings. */
export function catalogRows(catalog: MergedCatalog): CatalogEntry[] {
  return [...catalog.entries.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Loader dependencies that resolve a nested pipeline id through the merged view
 * (FR-019), so a forked parent in one layer can mount a child from another.
 */
export function catalogDeps(catalog: MergedCatalog, deps?: LoadDeps): LoadDeps {
  return { ...deps, resolvePath: (id: string) => catalog.entries.get(id)?.filePath };
}

/**
 * Load one id through the merged view. Returns undefined when no layer defines
 * it; a defined-but-broken pipeline throws, as `loadPipeline` does.
 */
export function loadFromCatalog(
  catalog: MergedCatalog,
  id: string,
  deps?: LoadDeps
): MergedPipeline | undefined {
  const entry = catalog.entries.get(id);
  if (entry === undefined) return undefined;
  return { entry, loaded: loadPipeline(entry.filePath, catalogDeps(catalog, deps)) };
}

/**
 * Load every id in the merged view. A pipeline that fails to load contributes an
 * error rather than aborting the rest — one malformed file must not empty a
 * listing.
 */
export function loadCatalogPipelines(
  catalog: MergedCatalog,
  deps?: LoadDeps
): { loaded: MergedPipeline[]; errors: CatalogError[] } {
  const loaded: MergedPipeline[] = [];
  const errors: CatalogError[] = [...catalog.errors];
  for (const entry of catalogRows(catalog)) {
    try {
      loaded.push({ entry, loaded: loadPipeline(entry.filePath, catalogDeps(catalog, deps)) });
    } catch (err) {
      errors.push({
        file: entry.filePath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { loaded, errors };
}

/**
 * The layer a write currently targets: the repository canon when the project has
 * one, otherwise the bundled layer — which every mutation route refuses.
 *
 * Seam for D14 (fork): once editing forks instead of installing, the target is
 * chosen by the caller (`--to user|repo`) and this default disappears.
 */
export function writeTargetLayer(layers: readonly CanonLayer[]): CanonLayer {
  return layers.find((l) => l.source === "repo") ?? layers[0];
}
