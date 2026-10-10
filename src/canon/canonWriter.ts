// FR-007: The only write path by which a canon draft becomes a file on disk.
//
// Save sequence (spec order):
//   1. Validate the draft body with loadPipeline.
//   2. Re-hash the file on disk.
//   3. If the disk hash differs from the draft's baseHash, refuse as conflict.
//   4. Write through yaml's Document AST to preserve comments and key order.
//   5. Update stored hashes so the next save is not a false conflict.

import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { parseDocument } from "yaml";
import { generateWorkflowScript } from "../bindings/claudeCode.js";
import { canonSource } from "../db/schema.js";
import {
  getDraft,
  setDraftValidation,
  updateDraftBaseHash,
  updateSourceHash,
} from "./draftStore.js";
import { hashContent } from "./hash.js";
import { loadProviders } from "./loadProviders.js";
import { defaultRegistry, getActiveProfile } from "./registry.js";
import type { Pipelines } from "./pipelines.js";
import type { DbInstance } from "../db/index.js";

// ── Types ─────────────────────────────────────────────────────────────────────

/** Pipeline ids that are safe to use as the base name of a generated script. */
const RE_SAFE_PIPELINE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/u;

export type SaveResult =
  | { ok: true }
  | { ok: false; reason: "conflict"; message: string }
  | { ok: false; reason: "invalid"; message: string }
  | { ok: false; reason: "forbidden"; message: string };

export type SaveAndRegenerateResult =
  | { ok: true; regenerated: string[] }
  | { ok: true; regenerated: []; regenerationError: string }
  | { ok: false; reason: "conflict"; message: string; regenerated: [] }
  | { ok: false; reason: "invalid"; message: string; regenerated: [] }
  | { ok: false; reason: "forbidden"; message: string; regenerated: [] };

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Attempt to write the draft body to disk.
 *
 * The draft and its source are looked up from the database; the caller supplies
 * the id and the view the file belongs to. The write is refused (`forbidden`)
 * unless the file is a pipeline file of a non-bundled layer of that view, so the
 * rule does not rest on the route alone. On success the draft's baseHash is updated to match the new
 * file content so subsequent saves do not produce a false conflict.
 */
export function saveDraft(db: DbInstance, draftId: number, pipelines: Pipelines): SaveResult {
  const draft = getDraft(db, draftId);
  if (!draft) throw new Error(`Draft ${draftId} not found`);

  const source = db.select().from(canonSource).where(eq(canonSource.id, draft.sourceId)).get();
  if (!source) throw new Error(`Source ${draft.sourceId} not found`);

  const filePath = join(source.root, source.relPath);

  const layer = pipelines.layerOf(filePath);
  if (layer === undefined || layer.source === "bundled") {
    return {
      ok: false,
      reason: "forbidden",
      message:
        layer === undefined
          ? `${source.relPath} is not a pipeline file of any workflow layer`
          : "The bundled pipeline catalog is read-only",
    };
  }

  // ── Step 1: validate ──────────────────────────────────────────────────────
  // The view sees the draft body in place of the YAML file and the real
  // filesystem for everything else, and resolves nested pipelines through the
  // merged layers.
  try {
    pipelines.check(filePath, { body: draft.body });
  } catch (err) {
    const message = (err as Error).message;
    setDraftValidation(db, draftId, "invalid", message);
    return { ok: false, reason: "invalid", message };
  }

  // ── Step 2: re-hash the file on disk ─────────────────────────────────────
  let diskContent: string;
  try {
    diskContent = readFileSync(filePath, "utf8");
  } catch (err) {
    throw new Error(`Cannot read ${filePath}: ${(err as Error).message}`, { cause: err });
  }

  const diskHash = hashContent(diskContent);

  // ── Step 3: conflict check ────────────────────────────────────────────────
  if (diskHash !== draft.baseHash) {
    return {
      ok: false,
      reason: "conflict",
      message: `File changed since draft was opened — save refused to prevent overwrite`,
    };
  }

  // ── Step 4: write through YAML Document AST ───────────────────────────────
  // parseDocument preserves comments and key order. toString options:
  //   flowCollectionPadding: false — keeps [intake] not [ intake ]
  //   lineWidth: 0              — disables re-wrapping of long strings
  // Together they guarantee the serialised output is byte-identical to the
  // input when the document has not been structurally modified.
  const doc = parseDocument(draft.body);
  const output = docToString(doc);
  writeFileAtomic(filePath, output);

  // ── Step 5: update stored hashes ─────────────────────────────────────────
  const newHash = hashContent(output);
  updateSourceHash(db, draft.sourceId, newHash);
  updateDraftBaseHash(db, draftId, newHash);
  setDraftValidation(db, draftId, "valid");

  return { ok: true };
}

/**
 * Perform saveDraft, and on success additionally regenerate the Claude Code
 * workflow script at <root>/.claude/workflows/<pipelineId>.js.
 *
 * Failure isolation: a generation error never rolls back the YAML write.
 * The YAML file is the truth; the workflow script is disposable output.
 * When generation fails, the result is ok:true with regenerated:[] and a
 * regenerationError message so the UI can report that the output is stale.
 */
export function saveDraftAndRegenerate(
  db: DbInstance,
  draftId: number,
  pipelines: Pipelines
): SaveAndRegenerateResult {
  const saveResult = saveDraft(db, draftId, pipelines);

  if (!saveResult.ok) {
    return { ...saveResult, regenerated: [] };
  }

  // Save succeeded — regenerate Binding A output.
  try {
    const draft = getDraft(db, draftId);
    if (!draft) throw new Error(`Draft ${draftId} not found after save`);

    const source = db.select().from(canonSource).where(eq(canonSource.id, draft.sourceId)).get();
    if (!source) throw new Error(`Source ${draft.sourceId} not found after save`);

    const filePath = join(source.root, source.relPath);
    const loaded = pipelines.check(filePath);
    // The id comes from the YAML and is about to become the name of an
    // executable file, so it is held to the same safe-id rule the HTTP routes
    // apply before joining anything into a path.
    if (!RE_SAFE_PIPELINE_ID.test(loaded.def.id) || loaded.def.id.length > 100) {
      throw new Error(
        `Pipeline id ${JSON.stringify(loaded.def.id)} is not a safe file name — ` +
          `refusing to generate a script for it`
      );
    }

    const providers = loadProviders(source.root);
    const profile = getActiveProfile(process.env, providers);
    const registry = defaultRegistry(process.env, providers.models);
    const script = generateWorkflowScript(loaded, profile, registry);

    const outDir = join(source.root, ".claude", "workflows");
    mkdirSync(outDir, { recursive: true });
    const outFile = join(outDir, `${loaded.def.id}.js`);
    writeFileSync(outFile, script, "utf8");

    return { ok: true, regenerated: [outFile] };
  } catch (err) {
    return { ok: true, regenerated: [], regenerationError: (err as Error).message };
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

export { hashContent };

/**
 * Publish `content` at `path` atomically (spec 047 FR-8).
 *
 * writeFileSync is open(O_TRUNC) → write → close, so a zero-length file exists
 * at the final name for an instant. The daemon reloads a pipeline on every run
 * start, and a load that lands in that window sees an empty pipeline. Writing a
 * sibling temp file and renaming it means a reader sees the previous file or
 * the new one, never a partial one.
 *
 * The temp file is a sibling (rename is atomic only within one filesystem) and
 * ends in ".tmp", not ".yaml", so the pipeline-directory scan cannot pick it up.
 */
function writeFileAtomic(path: string, content: string): void {
  const tempPath = `${path}.${process.pid.toString(36)}-${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(tempPath, content, "utf8");
    renameSync(tempPath, path);
  } catch (err) {
    rmSync(tempPath, { force: true });
    throw err;
  }
}

/**
 * Serialise a parsed YAML document without altering flow-collection padding or
 * line wrapping, so an unmodified document round-trips byte-identically.
 */
export function docToString(doc: ReturnType<typeof parseDocument>): string {
  return doc.toString({ flowCollectionPadding: false, lineWidth: 0 });
}
