// Forking a workflow into a writable layer (spec 038 D14, FR-021–FR-023).
//
// There is no install. Editing a workflow the project cannot write — a bundled
// one — copies exactly that workflow's YAML and its own prompt files into a
// writable layer, and the edit applies to the copy. Not its transitive closure
// of nested pipelines: the merged view (D13) resolves a mount across layers, so
// a forked parent keeps mounting the children it already mounts, wherever they
// live.
//
// The package directory is never a write target under any code path (FR-023);
// `assertWritableRoot` is the single place that is enforced.

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { parse } from "yaml";

import { assertSafePath } from "../install/paths.js";
import { packageRoot } from "../packageRoot.js";
import { mergedCatalog, repoCanonRoot, userLibraryRoot } from "./layers.js";
import type { CatalogEntry, MergedCatalog } from "./layers.js";
import type { StateEnv } from "../runtime/projectState.js";

/** Which writable layer a fork lands in. */
export type ForkTarget = "user" | "repo";

export interface ForkTargetResolution {
  target: ForkTarget;
  /** The layer root — the parent of `pipelines/` and `prompts/`. */
  root: string;
}

export interface ForkReport {
  id: string;
  /** The layer the copy was taken from. */
  from: string;
  target: ForkTarget;
  root: string;
  /** Paths written, relative to the target layer root. */
  written: string[];
}

/**
 * Where `agent-flows fork <id>` writes.
 *
 * An explicit `--to` wins. Otherwise the repository canon when the project
 * already has one, else the user library: a project that has chosen to keep
 * workflows in the tree keeps them there, and one that has not does not acquire
 * a committed directory as a side effect of editing.
 */
export function resolveForkTarget(
  projectDir: string,
  target?: ForkTarget,
  env: StateEnv = process.env
): ForkTargetResolution {
  const repoRoot = repoCanonRoot(projectDir);
  if (target === "repo") return { target: "repo", root: repoRoot };
  if (target === "user") return { target: "user", root: userLibraryRoot(env) };
  if (isDir(repoRoot)) return { target: "repo", root: repoRoot };
  return { target: "user", root: userLibraryRoot(env) };
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Refuse any write target inside the installed package (FR-023).
 *
 * The package is the one layer that is always present and never ours to edit:
 * an upgrade replaces it wholesale, so a write into it is lost at best and a
 * corrupted install at worst.
 */
export function assertWritableRoot(root: string): void {
  const pkg = resolve(packageRoot());
  const target = resolve(root);
  if (target === pkg || target.startsWith(pkg + sep)) {
    throw new Error(
      `agent-flows: refusing to write into the installed package at ${pkg} — ` +
        `fork into the user library or the repository canon instead.`
    );
  }
}

/** The prompt paths a pipeline's own steps reference, relative to its layer root. */
function ownPromptPaths(yamlPath: string): string[] {
  const raw = parse(readFileSync(yamlPath, "utf8")) as { steps?: { prompt?: unknown }[] } | null;
  const prompts = new Set<string>();
  for (const step of raw?.steps ?? []) {
    if (typeof step?.prompt === "string" && step.prompt !== "") prompts.add(step.prompt);
  }
  return [...prompts].sort();
}

/**
 * The copy a fork is taken from.
 *
 * Normally the winning entry. When the winner already lives in the target layer
 * — re-forking with `--overwrite` to get the pristine copy back — the fork is
 * taken from the highest-precedence layer BELOW the target instead, because
 * copying a file onto itself is not what the operator asked for.
 */
function sourceEntry(
  catalog: MergedCatalog,
  id: string,
  targetRoot: string
): CatalogEntry | undefined {
  const winner = catalog.entries.get(id);
  if (winner !== undefined && resolve(winner.layer.root) !== resolve(targetRoot)) return winner;
  const below = catalog.layers.filter((l) => resolve(l.root) !== resolve(targetRoot));
  return mergedCatalog(below).entries.get(id);
}

export interface ForkOptions {
  id: string;
  catalog: MergedCatalog;
  target: ForkTargetResolution;
  overwrite: boolean;
}

/**
 * Copy one workflow into a writable layer.
 *
 * This is the first code in the tree that creates a layer's directories: every
 * read path treats an absent layer as contributing nothing, and until something
 * is forked there is nothing to put in it.
 */
export function forkPipeline({ id, catalog, target, overwrite }: ForkOptions): ForkReport {
  const entry = sourceEntry(catalog, id, target.root);
  if (entry === undefined) {
    throw new Error(`agent-flows: no workflow "${id}" in this project's layers.`);
  }
  assertWritableRoot(target.root);

  const sourceRoot = entry.layer.root;
  const destPipelines = join(target.root, "pipelines");
  const destYaml = join(destPipelines, `${id}.yaml`);

  if (existsSync(destYaml) && !overwrite) {
    const holder = catalog.layers.find((l) => resolve(l.root) === resolve(target.root));
    const layerName = holder?.source ?? target.target;
    throw new Error(
      `agent-flows: "${id}" already exists in the ${layerName} layer at ${destYaml} — ` +
        `pass --overwrite to replace it.`
    );
  }

  const prompts = ownPromptPaths(entry.filePath);
  for (const promptPath of prompts) {
    assertSafePath(sourceRoot, promptPath);
    assertSafePath(target.root, promptPath);
  }

  mkdirSync(destPipelines, { recursive: true });
  mkdirSync(join(target.root, "prompts"), { recursive: true });

  const written: string[] = [];
  writeFileSync(destYaml, readFileSync(entry.filePath, "utf8"), "utf8");
  written.push(`pipelines/${id}.yaml`);

  for (const promptPath of prompts) {
    const src = join(sourceRoot, promptPath);
    if (!existsSync(src)) continue; // a broken reference is the loader's error to report, not the fork's
    const dest = join(target.root, promptPath);
    if (existsSync(dest) && !overwrite) continue;
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, readFileSync(src, "utf8"), "utf8");
    written.push(promptPath);
  }

  return { id, from: entry.layer.source, target: target.target, root: target.root, written };
}
