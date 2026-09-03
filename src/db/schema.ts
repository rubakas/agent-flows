// FR-003: SQLite schema via Drizzle ORM (ADR-0005 / ADR-0002).
// FR-006: Canon index and draft buffer tables.

import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// ── tickets ──────────────────────────────────────────────────────────────────

export const tickets = sqliteTable("tickets", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  slug: text("slug").notNull(),
  title: text("title").notNull(),
  body: text("body"),
  intent: text("intent"),
  // draft | hardening | ready | developed | tested | done | blocked
  state: text("state", {
    enum: ["draft", "hardening", "ready", "developed", "tested", "done", "blocked"],
  })
    .notNull()
    .default("draft"),
  // e.g. "gh#123" — nullable when seeded from free text
  sourceRef: text("source_ref"),
  createdAt: text("created_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

// ── requirements ─────────────────────────────────────────────────────────────

export const requirements = sqliteTable("requirements", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  ticketId: integer("ticket_id")
    .notNull()
    .references(() => tickets.id),
  // e.g. "FR-001"
  code: text("code").notNull(),
  text: text("text").notNull(),
});

// ── acceptance_criteria ───────────────────────────────────────────────────────

export const acceptanceCriteria = sqliteTable("acceptance_criteria", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  ticketId: integer("ticket_id")
    .notNull()
    .references(() => tickets.id),
  text: text("text").notNull(),
  // Given/When/Then assertion — null until enrichment fills it in
  testableAssertion: text("testable_assertion"),
  satisfied: integer("satisfied", { mode: "boolean" }).notNull().default(false),
});

// ── weaknesses ────────────────────────────────────────────────────────────────

export const weaknesses = sqliteTable("weaknesses", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  ticketId: integer("ticket_id")
    .notNull()
    .references(() => tickets.id),
  // e.g. "WEAK-001"
  code: text("code").notNull(),
  text: text("text").notNull(),
  severity: text("severity").notNull(),
  blocking: integer("blocking", { mode: "boolean" }).notNull().default(false),
  resolved: integer("resolved", { mode: "boolean" }).notNull().default(false),
});

// ── security_findings ─────────────────────────────────────────────────────────

export const securityFindings = sqliteTable("security_findings", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  ticketId: integer("ticket_id")
    .notNull()
    .references(() => tickets.id),
  // e.g. "SEC-001"
  code: text("code").notNull(),
  text: text("text").notNull(),
  severity: text("severity").notNull(),
  blocking: integer("blocking", { mode: "boolean" }).notNull().default(false),
  resolved: integer("resolved", { mode: "boolean" }).notNull().default(false),
});

// ── provenance ────────────────────────────────────────────────────────────────

export const provenance = sqliteTable("provenance", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  ticketId: integer("ticket_id")
    .notNull()
    .references(() => tickets.id),
  // e.g. "intake", "critic", "security"
  section: text("section").notNull(),
  agent: text("agent").notNull(),
  model: text("model").notNull(),
  runId: text("run_id").notNull(),
  at: text("at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

// ── canon_source ──────────────────────────────────────────────────────────────
// Index of discovered definition files. Files are truth; this is the index.

export const canonSource = sqliteTable("canon_source", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  root: text("root").notNull(),
  relPath: text("rel_path").notNull(),
  kind: text("kind", { enum: ["pipeline", "prompt"] }).notNull(),
  contentHash: text("content_hash").notNull(),
  // ok | error — whether the last parse of this file succeeded
  parseState: text("parse_state", { enum: ["ok", "error"] })
    .notNull()
    .default("ok"),
  updatedAt: text("updated_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

// ── canon_draft ───────────────────────────────────────────────────────────────
// An edit in progress. The body is a YAML string. baseHash is the content hash
// of the file at the moment this draft was opened — used for conflict detection.

export const canonDraft = sqliteTable("canon_draft", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  sourceId: integer("source_id")
    .notNull()
    .references(() => canonSource.id),
  body: text("body").notNull(),
  // sha256 of the file content when this draft was opened
  baseHash: text("base_hash").notNull(),
  // pending | valid | invalid
  validationState: text("validation_state", {
    enum: ["pending", "valid", "invalid"],
  })
    .notNull()
    .default("pending"),
  // set by canonWriter when validation fails
  validationMessage: text("validation_message"),
  createdAt: text("created_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

// ── canon_draft_op ────────────────────────────────────────────────────────────
// Edit operations behind a draft, ordered by seq so undo can replay them.

export const canonDraftOp = sqliteTable("canon_draft_op", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  draftId: integer("draft_id")
    .notNull()
    .references(() => canonDraft.id),
  seq: integer("seq").notNull(),
  // JSON-encoded operation payload; structure is owned by the caller
  op: text("op").notNull(),
  createdAt: text("created_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});
