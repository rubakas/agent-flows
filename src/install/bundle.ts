// Workflow bundle: export a pipeline's transitive closure to a portable YAML
// file, and import such a bundle back into a project's .agent-flows/ directory.
//
// Format choice: plain YAML with bundleVersion, exportedAt, sourcePipeline, and
// a files[] array (path + content). Human-readable, diffable, no binary encoding,
// no absolute machine paths. The owner can open, read, and git-diff a bundle.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

import { parse, stringify } from "yaml";

import { loadPipeline } from "../canon/load.js";
import { computeClosure } from "./install.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface BundleFile {
  /** Relative to the .agent-flows/ root, e.g. "pipelines/cycle.yaml" or "prompts/intake.md". */
  path: string;
  content: string;
}

export interface WorkflowBundle {
  bundleVersion: 1;
  /** ISO-8601 timestamp of when this bundle was created. */
  exportedAt: string;
  /** The root pipeline ID that was exported. */
  sourcePipeline: string;
  files: BundleFile[];
}

// ── Export ────────────────────────────────────────────────────────────────────

/**
 * Exports a pipeline and its full transitive closure (all nested pipelines and
 * all prompt files it references) as a self-contained bundle.
 *
 * Uses computeClosure from install.ts — no re-implementation of the traversal.
 *
 * @param pipelineId Root pipeline to export.
 * @param pipelinesDir Directory containing the pipeline YAML files.
 */
export function exportBundle(pipelineId: string, pipelinesDir: string): WorkflowBundle {
  const { pipelines, prompts } = computeClosure(pipelineId, pipelinesDir);
  const root = dirname(pipelinesDir); // parent of the pipelines/ directory

  const files: BundleFile[] = [];

  for (const id of [...pipelines].sort()) {
    const filePath = join(pipelinesDir, `${id}.yaml`);
    files.push({ path: `pipelines/${id}.yaml`, content: readFileSync(filePath, "utf8") });
  }

  for (const promptPath of [...prompts].sort()) {
    const filePath = join(root, promptPath);
    files.push({ path: promptPath, content: readFileSync(filePath, "utf8") });
  }

  return {
    bundleVersion: 1,
    exportedAt: new Date().toISOString(),
    sourcePipeline: pipelineId,
    files,
  };
}

/**
 * Serialises a WorkflowBundle to a YAML string.
 * Multi-line content uses block scalars (|), making the output diffable.
 */
export function stringifyBundle(bundle: WorkflowBundle): string {
  return stringify(bundle);
}

// ── Parse / validate ──────────────────────────────────────────────────────────

/**
 * Parses and validates a YAML bundle string.
 * Throws a descriptive Error if the bundle is malformed or missing required fields.
 */
export function parseBundle(text: string): WorkflowBundle {
  let raw: unknown;
  try {
    raw = parse(text);
  } catch (err) {
    throw new Error(`Bundle is not valid YAML: ${(err as Error).message}`, { cause: err });
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("Bundle must be a YAML mapping object");
  }
  const obj = raw as Record<string, unknown>;

  if (obj.bundleVersion !== 1) {
    throw new Error(`Unsupported bundleVersion: ${String(obj.bundleVersion)}`);
  }
  if (typeof obj.sourcePipeline !== "string" || !obj.sourcePipeline) {
    throw new Error('Bundle is missing required field "sourcePipeline"');
  }
  if (typeof obj.exportedAt !== "string" || !obj.exportedAt) {
    throw new Error('Bundle is missing required field "exportedAt"');
  }
  if (!Array.isArray(obj.files)) {
    throw new Error('Bundle is missing required field "files" (must be an array)');
  }

  const files: BundleFile[] = [];
  for (let i = 0; i < (obj.files as unknown[]).length; i++) {
    const f = (obj.files as unknown[])[i];
    if (typeof f !== "object" || f === null || Array.isArray(f)) {
      throw new Error(`files[${i}] must be an object with "path" and "content" fields`);
    }
    const ff = f as Record<string, unknown>;
    if (typeof ff.path !== "string" || !ff.path) {
      throw new Error(`files[${i}].path must be a non-empty string`);
    }
    if (typeof ff.content !== "string") {
      throw new Error(`files[${i}].content must be a string`);
    }
    files.push({ path: ff.path, content: ff.content });
  }

  return {
    bundleVersion: 1,
    exportedAt: obj.exportedAt,
    sourcePipeline: obj.sourcePipeline,
    files,
  };
}

// ── Containment check ─────────────────────────────────────────────────────────

/** Returns true iff the resolved filePath is strictly inside dir. */
function isContained(dir: string, filePath: string): boolean {
  const base = resolve(dir);
  const target = resolve(filePath);
  return target === base || target.startsWith(base + sep);
}

/**
 * Validates that a bundle file path cannot escape destRoot.
 * Treats every path in the bundle as potentially hostile (it came from another machine).
 *
 * Rejects paths that:
 * - are empty or contain null bytes
 * - start with "/" or "\" (absolute paths — path.join strips the leading slash,
 *   so "/etc/passwd" would otherwise appear to be inside destRoot after joining)
 * - resolve to a location outside destRoot after join+resolve (catches "../" traversal)
 */
function assertSafePath(destRoot: string, entryPath: string): void {
  if (!entryPath || entryPath.includes("\0")) {
    throw new Error(`Bundle contains invalid path: ${JSON.stringify(entryPath)}`);
  }
  // Absolute paths must be rejected before calling path.join, because join()
  // strips the leading slash from non-first arguments, making "/etc/passwd"
  // appear to resolve inside destRoot.
  if (entryPath.startsWith("/") || entryPath.startsWith("\\")) {
    throw new Error(
      `Bundle path ${JSON.stringify(entryPath)} escapes the destination directory — import rejected`
    );
  }
  const resolved = resolve(join(destRoot, entryPath));
  if (!isContained(destRoot, resolved)) {
    throw new Error(
      `Bundle path ${JSON.stringify(entryPath)} escapes the destination directory — import rejected`
    );
  }
}

// ── Import ────────────────────────────────────────────────────────────────────

export interface BundleImportReport {
  written: string[];
  /** Each entry is "<relative-path> (already exists)". */
  skipped: string[];
}

/**
 * Imports a workflow bundle into <projectDir>/.agent-flows/.
 *
 * Validation-first: writes all bundle files to a temp directory, then calls
 * loadPipeline on every pipeline in the bundle. If any pipeline fails to load,
 * the temp directory is deleted and an error is thrown — nothing is written to
 * the project.
 *
 * Path containment: every entry path is checked before any I/O. A path that
 * resolves outside .agent-flows/ causes immediate rejection and zero writes.
 *
 * Skip semantics: existing files in the project are skipped by default.
 * overwrite=true replaces them.
 *
 * @throws if any path escapes .agent-flows/, if the bundle fails validation,
 *         or if any pipeline in the bundle fails to load.
 */
export function importBundle(
  bundle: WorkflowBundle,
  projectDir: string,
  overwrite: boolean
): BundleImportReport {
  const destRoot = resolve(join(projectDir, ".agent-flows"));

  // Phase 1: Validate all paths before touching the filesystem.
  for (const entry of bundle.files) {
    assertSafePath(destRoot, entry.path);
  }

  // Phase 2: Write files to a temp directory and validate each pipeline loads.
  // realpathSync ensures the macOS /tmp → /private/tmp symlink is resolved so
  // loadPipeline's containment check (which also uses realpathSync) passes.
  const tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), "agent-flows-import-")));
  try {
    for (const entry of bundle.files) {
      const destPath = join(tmpRoot, entry.path);
      mkdirSync(dirname(destPath), { recursive: true });
      writeFileSync(destPath, entry.content, "utf8");
    }

    const pipelineFiles = bundle.files.filter((f) => f.path.startsWith("pipelines/"));
    for (const f of pipelineFiles) {
      const yamlPath = join(tmpRoot, f.path);
      try {
        loadPipeline(yamlPath);
      } catch (err) {
        throw new Error(`Bundle validation failed for "${f.path}": ${(err as Error).message}`, {
          cause: err,
        });
      }
    }

    // Phase 3: All pipelines are valid — copy to the project directory.
    const written: string[] = [];
    const skipped: string[] = [];

    for (const entry of bundle.files) {
      const destPath = join(destRoot, entry.path);
      mkdirSync(dirname(destPath), { recursive: true });
      if (existsSync(destPath) && !overwrite) {
        skipped.push(`${entry.path} (already exists)`);
        continue;
      }
      writeFileSync(destPath, entry.content, "utf8");
      written.push(entry.path);
    }

    return { written, skipped };
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
}
