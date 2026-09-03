// FR-006: Accessors over the canon_source / canon_draft / canon_draft_op tables.
// Policy-free: open, update, list, discard. The invariant that files are truth
// is enforced by canonWriter, not here.

import { asc, eq } from "drizzle-orm";
import { canonDraft, canonDraftOp, canonSource } from "../db/schema.js";
import type { DbInstance } from "../db/index.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export type SourceRow = typeof canonSource.$inferSelect;
export type DraftRow = typeof canonDraft.$inferSelect;
export type DraftOpRow = typeof canonDraftOp.$inferSelect;

// ── Source management ─────────────────────────────────────────────────────────

/** Record a discovered definition file in the index. Returns the new row id. */
export function indexSource(
  db: DbInstance,
  root: string,
  relPath: string,
  kind: "pipeline" | "prompt",
  contentHash: string
): number {
  const [row] = db
    .insert(canonSource)
    .values({ root, relPath, kind, contentHash })
    .returning()
    .all();
  return row.id;
}

/** Update the stored content hash after a file is written to disk. */
export function updateSourceHash(db: DbInstance, sourceId: number, contentHash: string): void {
  db.update(canonSource)
    .set({ contentHash, updatedAt: new Date().toISOString() })
    .where(eq(canonSource.id, sourceId))
    .run();
}

/** Return the source row for a given id, or undefined if not found. */
export function getSource(db: DbInstance, sourceId: number): SourceRow | undefined {
  return db.select().from(canonSource).where(eq(canonSource.id, sourceId)).get();
}

// ── Draft management ──────────────────────────────────────────────────────────

/**
 * Open a new draft for a source file.
 * body: the YAML string to start from (normally the current file content).
 * baseHash: sha256 of the file at the moment the draft was opened.
 * Returns the new draft id.
 */
export function openDraft(
  db: DbInstance,
  sourceId: number,
  body: string,
  baseHash: string
): number {
  const [row] = db.insert(canonDraft).values({ sourceId, body, baseHash }).returning().all();
  return row.id;
}

/** Fetch a draft by id. Returns undefined when not found. */
export function getDraft(db: DbInstance, draftId: number): DraftRow | undefined {
  return db.select().from(canonDraft).where(eq(canonDraft.id, draftId)).get();
}

/** Replace the draft body (called as the user edits). */
export function updateDraftBody(db: DbInstance, draftId: number, body: string): void {
  db.update(canonDraft)
    .set({
      body,
      validationState: "pending",
      validationMessage: null,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(canonDraft.id, draftId))
    .run();
}

/** Record the outcome of a validation pass. */
export function setDraftValidation(
  db: DbInstance,
  draftId: number,
  state: "pending" | "valid" | "invalid",
  message?: string
): void {
  db.update(canonDraft)
    .set({
      validationState: state,
      validationMessage: message ?? null,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(canonDraft.id, draftId))
    .run();
}

/**
 * Update the base hash after a successful save so the next save does not
 * produce a false conflict.
 */
export function updateDraftBaseHash(db: DbInstance, draftId: number, baseHash: string): void {
  db.update(canonDraft)
    .set({ baseHash, updatedAt: new Date().toISOString() })
    .where(eq(canonDraft.id, draftId))
    .run();
}

/** Delete the draft and all its ops. */
export function discardDraft(db: DbInstance, draftId: number): void {
  db.delete(canonDraftOp).where(eq(canonDraftOp.draftId, draftId)).run();
  db.delete(canonDraft).where(eq(canonDraft.id, draftId)).run();
}

// ── Op management ─────────────────────────────────────────────────────────────

/** Append an edit operation. seq must be monotonically increasing per draft. */
export function addDraftOp(db: DbInstance, draftId: number, seq: number, op: unknown): number {
  const [row] = db
    .insert(canonDraftOp)
    .values({ draftId, seq, op: JSON.stringify(op) })
    .returning()
    .all();
  return row.id;
}

/** Return all ops for a draft in ascending seq order. */
export function listDraftOps(db: DbInstance, draftId: number): DraftOpRow[] {
  return db
    .select()
    .from(canonDraftOp)
    .where(eq(canonDraftOp.draftId, draftId))
    .orderBy(asc(canonDraftOp.seq))
    .all();
}
