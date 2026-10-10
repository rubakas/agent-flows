// Pipeline by id: the one place that answers "which file is this pipeline, what
// does it load to, which prompt files does it own, and who nests it" across the
// workflow layers (spec 047 FR-12).
//
// Before this module each caller took a pipeline YAML path to `loadPipeline`,
// which resolved a nested child as a sibling file of its parent: a repository
// fork whose children live in another layer could not be loaded, validated or
// edited, and "who nests this" was answered from one layer's directory only.
// A `Pipelines` is a view over an ordered set of layers; every answer goes
// through the merged catalogue, so nesting, precedence and the prompts directory
// are decided here and nowhere else.
//
// The view is a snapshot: it lists the layers' files once, when it is built, and
// is meant to be built per request (or per CLI invocation). Loading is lazy.

import { readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, resolve, sep } from "node:path";

import { parse } from "yaml";

import { packageRoot } from "../packageRoot.js";
import {
  layerFrom,
  mergedCatalog,
  resolveLayers,
  type CanonLayer,
  type CatalogEntry,
  type CatalogError,
  type LayerSource,
  type MergedCatalog,
} from "./layers.js";
import { loadPipeline } from "./load.js";
import { readRawPipeline } from "./rawPipeline.js";
import type { LoadedPipeline } from "./types.js";
import type { StateEnv } from "../runtime/projectState.js";

/** One own llm step's prompt file, as the on-disk pipeline declares it. */
export interface PromptFile {
  /** The path exactly as written in the YAML, relative to the layer root. */
  rel: string;
  /** The absolute path the loader reads it from. */
  abs: string;
  /**
   * Whether a write may replace it: an existing `.md` file whose realpath sits
   * inside the realpath of the layer's `prompts/` directory. A prompt the loader
   * accepts but that fails this (`prompt: providers.yaml`) is listed, so the
   * caller can tell "refused" from "no such step", but must never be read or
   * written.
   */
  writable: boolean;
}

/** The winning file of one id, as the editor and the listings need it. */
export interface PipelineFile {
  id: string;
  filePath: string;
  layer: CanonLayer;
  /** Layers holding a same-id workflow this one shadows, lowest precedence first. */
  shadows: readonly LayerSource[];
  /** False for the bundled layer, which is never written. */
  editable: boolean;
  /**
   * The prompt file of every OWN llm step, read from the YAML on disk rather than
   * from the loaded definition: expansion inlines nested pipelines under
   * `parent.child` ids whose prompts belong to another file. A document that does
   * not parse yields an empty map.
   */
  readonly prompts: ReadonlyMap<string, PromptFile>;
}

/** A pipeline file together with what it loads to. */
export interface Found {
  file: PipelineFile;
  loaded: LoadedPipeline;
}

export type Lookup =
  | { kind: "absent" }
  /** Defined but unloadable. Kept apart from absent; the original error is kept. */
  | { kind: "broken"; file: PipelineFile; error: Error }
  | { kind: "ok"; file: PipelineFile; loaded: LoadedPipeline };

/** `check` was handed a path that is not a pipeline file of any layer of the view. */
export class PipelinePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PipelinePathError";
  }
}

export interface Pipelines {
  readonly layers: readonly CanonLayer[];
  /**
   * The merged catalogue this view was built from, for the operations that work
   * on layers and entries rather than on loaded pipelines (fork, export).
   */
  readonly catalog: MergedCatalog;
  /** The winning pipeline for `id`, nesting resolved through the merged view. */
  get(id: string): Lookup;
  /** Every winning pipeline that loads, and everything that did not. */
  all(): { found: Found[]; errors: CatalogError[] };
  /**
   * Validate one pipeline file of this view with in-memory edits, as the loader
   * would see them on disk: `body` replaces the file's text, `prompts` replaces
   * the text of own steps' prompt files. When `body` is given the prompt paths
   * are taken from that body (it may re-point a step), otherwise from disk.
   * Throws the load error. Throws `PipelinePathError` for a path that is not a
   * pipeline file of one of the view's layers.
   */
  check(
    filePath: string,
    edits?: { body?: string; prompts?: Record<string, string> }
  ): LoadedPipeline;
  /** The layer whose `pipelines/` directory holds `filePath`, if any. */
  layerOf(filePath: string): CanonLayer | undefined;
  /**
   * Ids of the WINNING pipelines, in any layer, that mount `id` with a pipeline
   * or loop step of their own. A shadowed copy is not counted: it is not in use.
   */
  nesters(id: string): string[];
}

/** The view over exactly these layers, lowest precedence first. */
export function pipelinesIn(layers: readonly CanonLayer[]): Pipelines {
  return viewOf(mergedCatalog(layers));
}

/** The layers present for `projectDir` (bundled, user library, repository canon). */
export function projectPipelines(projectDir: string, env: StateEnv = process.env): Pipelines {
  return pipelinesIn(resolveLayers(projectDir, env));
}

/** The pipelines shipped with the package, and nothing else. */
export function bundledPipelines(): Pipelines {
  return pipelinesIn([layerFrom("bundled", packageRoot())]);
}

function viewOf(catalog: MergedCatalog): Pipelines {
  const resolvePath = (id: string): string | undefined => catalog.entries.get(id)?.filePath;
  const rows = (): CatalogEntry[] =>
    [...catalog.entries.values()].sort((a, b) => a.id.localeCompare(b.id));

  function layerOf(filePath: string): CanonLayer | undefined {
    if (!/\.ya?ml$/u.test(filePath)) return undefined;
    let dir: string;
    try {
      dir = realpathSync(dirname(resolve(filePath)));
    } catch {
      return undefined;
    }
    return catalog.layers.find((layer) => {
      try {
        return realpathSync(layer.pipelinesDir) === dir;
      } catch {
        return false;
      }
    });
  }

  return {
    layers: catalog.layers,
    catalog,

    get(id) {
      const entry = catalog.entries.get(id);
      if (entry === undefined) return { kind: "absent" };
      const file = fileOf(entry);
      try {
        return { kind: "ok", file, loaded: loadPipeline(entry.filePath, { resolvePath }) };
      } catch (err) {
        return { kind: "broken", file, error: err instanceof Error ? err : new Error(String(err)) };
      }
    },

    all() {
      const found: Found[] = [];
      const errors: CatalogError[] = [...catalog.errors];
      for (const entry of rows()) {
        try {
          found.push({
            file: fileOf(entry),
            loaded: loadPipeline(entry.filePath, { resolvePath }),
          });
        } catch (err) {
          errors.push({
            file: entry.filePath,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      return { found, errors };
    },

    check(filePath, edits) {
      const layer = layerOf(filePath);
      if (layer === undefined) {
        throw new PipelinePathError(
          `${basename(filePath)} is not a pipeline file of any workflow layer`
        );
      }
      const target = resolve(filePath);
      const overrides = new Map<string, string>();
      if (edits?.body !== undefined) overrides.set(target, edits.body);
      const texts = edits?.prompts ?? {};
      for (const [stepId, prompt] of ownLlmPrompts(
        edits?.body !== undefined ? { text: edits.body } : { path: target }
      )) {
        const text = texts[stepId];
        if (text !== undefined) overrides.set(resolve(layer.root, prompt), text);
      }
      return loadPipeline(target, {
        resolvePath,
        readFile: (p) => overrides.get(resolve(p)) ?? readFileSync(p, "utf8"),
      });
    },

    layerOf,

    nesters(id) {
      const ids: string[] = [];
      for (const entry of rows()) {
        if (entry.id === id) continue;
        let steps: unknown;
        try {
          steps = readRawPipeline(entry.filePath).steps;
        } catch {
          continue; // an unparseable file nests nothing it can be shown to
        }
        if (!Array.isArray(steps)) continue;
        const mounts = (steps as ({ kind?: unknown; pipeline?: unknown } | null)[]).some(
          (s) => (s?.kind === "pipeline" || s?.kind === "loop") && s.pipeline === id
        );
        if (mounts) ids.push(entry.id);
      }
      return ids;
    },
  };
}

function fileOf(entry: CatalogEntry): PipelineFile {
  let prompts: ReadonlyMap<string, PromptFile> | undefined;
  return {
    id: entry.id,
    filePath: entry.filePath,
    layer: entry.layer,
    shadows: [...entry.shadows],
    editable: entry.layer.source !== "bundled",
    get prompts() {
      prompts ??= promptFilesOf(entry.filePath, entry.layer);
      return prompts;
    },
  };
}

/** Own llm steps' declared prompt paths (step id → path as written). */
function ownLlmPrompts(source: { text: string } | { path: string }): Map<string, string> {
  const out = new Map<string, string>();
  let doc: unknown;
  try {
    doc = parse("text" in source ? source.text : readFileSync(source.path, "utf8"));
  } catch {
    return out; // malformed YAML: let the loader produce the message
  }
  const steps = (doc as { steps?: unknown } | null)?.steps;
  if (!Array.isArray(steps)) return out;
  for (const step of steps as ({ id?: unknown; kind?: unknown; prompt?: unknown } | null)[]) {
    if (step?.kind !== "llm") continue;
    if (typeof step.id !== "string" || typeof step.prompt !== "string") continue;
    out.set(step.id, step.prompt);
  }
  return out;
}

function promptFilesOf(filePath: string, layer: CanonLayer): Map<string, PromptFile> {
  const files = new Map<string, PromptFile>();
  for (const [stepId, rel] of ownLlmPrompts({ path: filePath })) {
    const abs = resolve(layer.root, rel);
    files.set(stepId, { rel, abs, writable: isWritablePrompt(abs, layer.promptsDir) });
  }
  return files;
}

/**
 * Whether a write may replace `absPath`: an existing `.md` file whose realpath
 * sits inside the realpath of the layer's `prompts/` directory.
 *
 * The loader's own containment is not sufficient for a write — it accepts any
 * path under the layer root, `providers.yaml` included — so this is a second,
 * narrower gate, applied after realpath so a symlink planted inside `prompts/`
 * cannot redirect the write. Hard links are not detected: that residual needs
 * prior local write access to the directory.
 */
function isWritablePrompt(absPath: string, promptsDir: string): boolean {
  if (!absPath.endsWith(".md")) return false;
  let realTarget: string;
  let realDir: string;
  try {
    realTarget = realpathSync(absPath);
    realDir = realpathSync(promptsDir);
  } catch {
    return false; // the prompt file, or the prompts directory itself, is absent
  }
  if (!realTarget.endsWith(".md")) return false;
  if (!statSync(realTarget).isFile()) return false;
  const dirWithSep = realDir.endsWith(sep) ? realDir : realDir + sep;
  return realTarget.startsWith(dirWithSep);
}
