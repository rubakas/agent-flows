// FR-007: The only write path by which a canon draft becomes a file on disk.
//
// Save sequence (spec order):
//   1. Validate the draft body with loadPipeline.
//   2. Re-hash the file on disk.
//   3. If the disk hash differs from the draft's baseHash, refuse as conflict.
//   4. Write through yaml's Document AST to preserve comments and key order.
//   5. Update stored hashes so the next save is not a false conflict.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
import { loadPipeline } from "./load.js";
import { getActiveProfile } from "./registry.js";
import type { DbInstance } from "../db/index.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export type SaveResult =
  | { ok: true }
  | { ok: false; reason: "conflict"; message: string }
  | { ok: false; reason: "invalid"; message: string };

export type SaveAndRegenerateResult =
  | { ok: true; regenerated: string[] }
  | { ok: true; regenerated: []; regenerationError: string }
  | { ok: false; reason: "conflict"; message: string; regenerated: [] }
  | { ok: false; reason: "invalid"; message: string; regenerated: [] };

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Attempt to write the draft body to disk.
 *
 * The draft and its source are looked up from the database; the caller supplies
 * only the ids. On success the draft's baseHash is updated to match the new
 * file content so subsequent saves do not produce a false conflict.
 */
export function saveDraft(db: DbInstance, draftId: number): SaveResult {
  const draft = getDraft(db, draftId);
  if (!draft) throw new Error(`Draft ${draftId} not found`);

  const source = db.select().from(canonSource).where(eq(canonSource.id, draft.sourceId)).get();
  if (!source) throw new Error(`Source ${draft.sourceId} not found`);

  const filePath = join(source.root, source.relPath);

  // ── Step 1: validate ──────────────────────────────────────────────────────
  // Pass a custom readFile so loadPipeline sees the draft body for the YAML
  // path and falls through to the real filesystem for any prompt files.
  try {
    loadPipeline(filePath, {
      readFile: (p) => (p === filePath ? draft.body : readFileSync(p, "utf8")),
    });
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
  writeFileSync(filePath, output, "utf8");

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
export function saveDraftAndRegenerate(db: DbInstance, draftId: number): SaveAndRegenerateResult {
  const saveResult = saveDraft(db, draftId);

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
    const loaded = loadPipeline(filePath);
    const profile = getActiveProfile();
    const script = generateWorkflowScript(loaded, profile);

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

export function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Serialise a parsed YAML document without altering flow-collection padding or
 * line wrapping, so an unmodified document round-trips byte-identically.
 */
export function docToString(doc: ReturnType<typeof parseDocument>): string {
  return doc.toString({ flowCollectionPadding: false, lineWidth: 0 });
}
