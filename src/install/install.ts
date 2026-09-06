import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse } from "yaml";

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
  /** Prompt paths relative to the bundled root (e.g. "prompts/foo.md"). */
  prompts: Set<string>;
}

/**
 * Computes the transitive closure of pipeline IDs and prompt paths for the
 * given pipeline, reading from bundledPipelinesDir.
 *
 * Traverses kind:pipeline and kind:loop steps recursively.
 * Does not call loadPipeline — raw parse only, so no validation overhead.
 */
export function computeClosure(pipelineId: string, bundledPipelinesDir: string): PipelineClosure {
  const pipelines = new Set<string>();
  const prompts = new Set<string>();

  function visit(id: string): void {
    if (pipelines.has(id)) return;
    const yamlPath = join(bundledPipelinesDir, `${id}.yaml`);
    if (!existsSync(yamlPath)) {
      throw new Error(`Pipeline "${id}" not found in bundled catalog at ${yamlPath}`);
    }
    pipelines.add(id);
    const raw = parseRaw(yamlPath);
    for (const step of raw.steps ?? []) {
      if (step.prompt) {
        prompts.add(step.prompt);
      }
      if ((step.kind === "pipeline" || step.kind === "loop") && step.pipeline) {
        visit(step.pipeline);
      }
    }
  }

  visit(pipelineId);
  return { pipelines, prompts };
}

export interface InstallReport {
  written: string[];
  /** Each entry is "<relative-path> (already exists)" */
  skipped: string[];
}

/**
 * Installs one or more workflows (and their transitive closure) into
 * <projectDir>/.agent-flows/.
 *
 * Default: skip files that already exist and report each skip.
 * overwrite=true: overwrite existing files silently.
 */
export function installWorkflow(
  pipelineIds: string[],
  bundledPipelinesDir: string,
  projectDir: string,
  overwrite: boolean
): InstallReport {
  const bundledRoot = dirname(bundledPipelinesDir);
  const destRoot = join(projectDir, ".agent-flows");

  const allPipelines = new Set<string>();
  const allPrompts = new Set<string>();
  for (const id of pipelineIds) {
    const { pipelines, prompts } = computeClosure(id, bundledPipelinesDir);
    for (const p of pipelines) allPipelines.add(p);
    for (const p of prompts) allPrompts.add(p);
  }

  const written: string[] = [];
  const skipped: string[] = [];

  function copyFile(srcPath: string, destPath: string, label: string): void {
    mkdirSync(dirname(destPath), { recursive: true });
    if (existsSync(destPath) && !overwrite) {
      skipped.push(`${label} (already exists)`);
      return;
    }
    writeFileSync(destPath, readFileSync(srcPath));
    written.push(label);
  }

  for (const id of [...allPipelines].sort()) {
    const src = join(bundledPipelinesDir, `${id}.yaml`);
    const dest = join(destRoot, "pipelines", `${id}.yaml`);
    copyFile(src, dest, `pipelines/${id}.yaml`);
  }

  for (const promptPath of [...allPrompts].sort()) {
    const src = join(bundledRoot, promptPath);
    const dest = join(destRoot, promptPath);
    copyFile(src, dest, promptPath);
  }

  return { written, skipped };
}

/** Returns the IDs of all available pipelines in bundledPipelinesDir. */
export function listAvailable(bundledPipelinesDir: string): string[] {
  return readdirSync(bundledPipelinesDir)
    .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
    .map((f) => f.replace(/\.ya?ml$/u, ""))
    .sort();
}

/** Returns the IDs of all installed pipelines in <projectDir>/.agent-flows/pipelines/. */
export function listInstalled(projectDir: string): string[] {
  const installedDir = join(projectDir, ".agent-flows", "pipelines");
  if (!existsSync(installedDir)) return [];
  return readdirSync(installedDir)
    .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
    .map((f) => f.replace(/\.ya?ml$/u, ""))
    .sort();
}
