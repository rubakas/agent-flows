// FR-003: better-sqlite3 + Drizzle connection factories (ADR-0005 / ADR-0002).

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";

export type DbInstance = BetterSQLite3Database<typeof schema>;

// DDL that matches schema.ts — used only to bootstrap an in-memory DB for tests.
const SCHEMA_DDL = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  intent TEXT,
  state TEXT NOT NULL DEFAULT 'draft',
  source_ref TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS requirements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL REFERENCES tickets(id),
  code TEXT NOT NULL,
  text TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS acceptance_criteria (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL REFERENCES tickets(id),
  text TEXT NOT NULL,
  testable_assertion TEXT,
  satisfied INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS weaknesses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL REFERENCES tickets(id),
  code TEXT NOT NULL,
  text TEXT NOT NULL,
  severity TEXT NOT NULL,
  blocking INTEGER NOT NULL DEFAULT 0,
  resolved INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS security_findings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL REFERENCES tickets(id),
  code TEXT NOT NULL,
  text TEXT NOT NULL,
  severity TEXT NOT NULL,
  blocking INTEGER NOT NULL DEFAULT 0,
  resolved INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS provenance (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL REFERENCES tickets(id),
  section TEXT NOT NULL,
  agent TEXT NOT NULL,
  model TEXT NOT NULL,
  run_id TEXT NOT NULL,
  at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS canon_source (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  root TEXT NOT NULL,
  rel_path TEXT NOT NULL,
  kind TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  parse_state TEXT NOT NULL DEFAULT 'ok',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS canon_draft (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id INTEGER NOT NULL REFERENCES canon_source(id),
  body TEXT NOT NULL,
  base_hash TEXT NOT NULL,
  validation_state TEXT NOT NULL DEFAULT 'pending',
  validation_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS canon_draft_op (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  draft_id INTEGER NOT NULL REFERENCES canon_draft(id),
  seq INTEGER NOT NULL,
  op TEXT NOT NULL,
  created_at TEXT NOT NULL
);

`;

/** Open (or create) a file-backed SQLite database at the given path. Applies schema DDL idempotently. */
export function makeDb(path: string): DbInstance {
  const sqlite = new Database(path);
  sqlite.pragma("foreign_keys = ON");
  sqlite.exec(SCHEMA_DDL);
  return drizzle(sqlite, { schema });
}

/**
 * Create an in-memory SQLite database with all schema tables.
 * Intended for use in tests — no migrations needed.
 */
export function makeInMemoryDb(): DbInstance {
  const sqlite = new Database(":memory:");
  sqlite.exec(SCHEMA_DDL);
  return drizzle(sqlite, { schema });
}
