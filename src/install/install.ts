// Closure computation for `exportBundle` (spec 038 D16). `installWorkflow`,
// `listAvailable` and `listInstalled` were removed with the install verb: there
// is no install any more, and editing forks instead (D14). `computeClosure`
// stays because the exporter needs it.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse } from "yaml";

import { assertSafePath } from "./paths.js";

// Minimal raw shape needed for closure computation. Full validation happens at load time.
interface RawStep {
  kind?: string;
  prompt?: string;
  pipeline?: string;
}

interface RawPipeline {
  steps?: RawStep[];
}

function parseRaw(yamlPath: string): RawPipeline {
  return parse(readFileSync(yamlPath, "utf8")) as RawPipeline;
}

export interface PipelineClosure {
  /** Pipeline IDs in the transitive closure (including the root). */
  pipelines: Set<string>;
  /** Prompt paths relative to the owning pipeline's root (e.g. "prompts/foo.md"). */
  prompts: Set<string>;
  /** Pipeline ID → the YAML file it was read from. */
  pipelineFiles: Map<string, string>;
  /** Prompt path → the file it was read from, resolved against its own pipeline's root. */
  promptFiles: Map<string, string>;
}

/**
 * Computes the transitive closure of pipeline IDs and prompt paths for the
 * given pipeline, reading from pipelinesDir.
 *
 * Traverses kind:pipeline and kind:loop steps recursively.
 * Does not call loadPipeline — raw parse only, so no validation overhead.
 *
 * `resolvePath` maps a nested pipeline id to the file that defines it. The
 * merged three-layer view (spec 038 D13) passes one, so exporting a repository
 * parent that mounts a bundled child resolves that child where it actually
 * lives instead of failing inside one directory. Without it the legacy rule
 * holds: a sibling file in `pipelinesDir`.
 *
 * The two maps record which file each entry came from, because with a resolver
 * the closure can span layer roots and "the" root is no longer well-defined.
 */
export function computeClosure(
  pipelineId: string,
  pipelinesDir: string,
  resolvePath?: (id: string) => string | undefined
): PipelineClosure {
  const pipelines = new Set<string>();
  const prompts = new Set<string>();
  const pipelineFiles = new Map<string, string>();
  const promptFiles = new Map<string, string>();

  function visit(id: string): void {
    if (pipelines.has(id)) return;
    const resolved = resolvePath?.(id);
    // Containment is asserted here, where the directory a path is resolved
    // against is known — a caller reading the maps afterwards cannot tell which
    // root an entry came from. A path the resolver supplied came from a
    // directory listing of a layer, not from the YAML, so it cannot traverse.
    if (resolved === undefined) assertSafePath(pipelinesDir, `${id}.yaml`);
    const yamlPath = resolved ?? join(pipelinesDir, `${id}.yaml`);
    if (!existsSync(yamlPath)) {
      throw new Error(`Pipeline "${id}" not found in bundled catalog at ${yamlPath}`);
    }
    pipelines.add(id);
    pipelineFiles.set(id, yamlPath);
    // A pipeline's prompts are the sibling prompts/ directory of its own layer
    // root — the parent of the directory the YAML sits in (spec 038 FR-018).
    const root = dirname(dirname(yamlPath));
    const raw = parseRaw(yamlPath);
    for (const step of raw.steps ?? []) {
      if (step.prompt) {
        assertSafePath(root, step.prompt);
        prompts.add(step.prompt);
        // First writer wins: the root pipeline is visited first, so its own
        // layer supplies a prompt path two layers happen to share.
        if (!promptFiles.has(step.prompt)) promptFiles.set(step.prompt, join(root, step.prompt));
      }
      if ((step.kind === "pipeline" || step.kind === "loop") && step.pipeline) {
        visit(step.pipeline);
      }
    }
  }

  visit(pipelineId);
  return { pipelines, prompts, pipelineFiles, promptFiles };
}
