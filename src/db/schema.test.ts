// The bootstrap DDL in index.ts and the Drizzle schema in schema.ts describe the
// same nine tables twice, by hand. Both run in production: makeDb applies the DDL
// to the real file database and Drizzle then queries it by the schema's column
// names. A column present in one and not the other fails only at runtime, on the
// first query that touches it. This pins the two to each other.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { is } from "drizzle-orm";
import { getTableConfig, SQLiteTable, type AnySQLiteColumn } from "drizzle-orm/sqlite-core";

import * as schema from "./schema.js";
import { makeInMemoryDb } from "./index.js";
import type Database from "better-sqlite3";

interface TableInfoRow {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

interface ForeignKeyRow {
  table: string;
  from: string;
  to: string;
  on_update: string;
  on_delete: string;
}

const drizzleTables = Object.values(schema).filter((v) => is(v, SQLiteTable)) as SQLiteTable[];
// DbInstance is declared without the client Drizzle attaches at runtime.
const sqlite = (makeInMemoryDb() as unknown as { $client: Database.Database }).$client;

/** The SQL literal SQLite reports in `dflt_value` for a Drizzle JS default. */
function defaultLiteral(column: AnySQLiteColumn): string | null {
  const value: unknown = column.default;
  if (value === undefined) return null;
  if (typeof value === "string") return `'${value.replaceAll("'", "''")}'`;
  if (typeof value === "boolean") return value ? "1" : "0";
  if (typeof value === "number") return String(value);
  throw new Error(
    `${column.name}: unsupported default (${typeof value}) — extend this test to render it`
  );
}

describe("bootstrap DDL matches the Drizzle schema", () => {
  it("covers all nine tables", () => {
    assert.equal(drizzleTables.length, 9, "schema.ts exports a table this test no longer sees");
  });

  it("creates exactly the tables Drizzle declares", () => {
    const created = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all() as { name: string }[];
    assert.deepEqual(
      created.map((t) => t.name).sort(),
      drizzleTables.map((t) => getTableConfig(t).name).sort()
    );
  });

  for (const table of drizzleTables) {
    const config = getTableConfig(table);

    describe(config.name, () => {
      const info = sqlite.prepare(`PRAGMA table_info("${config.name}")`).all() as TableInfoRow[];
      const byName = new Map(info.map((row) => [row.name, row]));

      it("has the same column names on both sides", () => {
        assert.deepEqual([...byName.keys()].sort(), config.columns.map((c) => c.name).sort());
      });

      for (const column of config.columns) {
        it(`column ${column.name}: type, nullability, default and key agree`, () => {
          const row = byName.get(column.name);
          assert.ok(row, `the DDL has no column ${column.name}`);
          assert.equal(row.type.toLowerCase(), column.getSQLType(), "type");
          // PRAGMA reports notnull=0 for an INTEGER PRIMARY KEY; Drizzle says notNull.
          assert.equal(row.notnull === 1 || row.pk > 0, column.notNull, "nullability");
          assert.equal(row.dflt_value, defaultLiteral(column), "default");
          assert.equal(row.pk > 0, column.primary, "primary key");
        });
      }

      it("uses AUTOINCREMENT exactly where Drizzle does", () => {
        const { sql } = sqlite
          .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
          .get(config.name) as { sql: string };
        const drizzleAuto = config.columns.some(
          (c) => (c as { autoIncrement?: boolean }).autoIncrement === true
        );
        assert.equal(/\bAUTOINCREMENT\b/u.test(sql), drizzleAuto);
      });

      it("has the same foreign keys", () => {
        for (const fk of config.foreignKeys) {
          const ref = fk.reference();
          assert.equal(ref.columns.length, 1, "composite foreign key — extend this test");
          assert.equal(ref.foreignColumns.length, 1, "composite foreign key — extend this test");
        }
        const fromDdl = (
          sqlite.prepare(`PRAGMA foreign_key_list("${config.name}")`).all() as ForeignKeyRow[]
        ).map(({ table: foreign, from, to, on_update, on_delete }) => ({
          table: foreign,
          from,
          to,
          onUpdate: on_update,
          onDelete: on_delete,
        }));
        const fromDrizzle = config.foreignKeys.map((fk) => {
          const ref = fk.reference();
          return {
            table: getTableConfig(ref.foreignTable).name,
            from: ref.columns[0].name,
            to: ref.foreignColumns[0].name,
            onUpdate: (fk.onUpdate ?? "no action").toUpperCase(),
            onDelete: (fk.onDelete ?? "no action").toUpperCase(),
          };
        });
        const byKey = (a: { from: string }, b: { from: string }): number =>
          a.from.localeCompare(b.from);
        assert.deepEqual(fromDdl.sort(byKey), fromDrizzle.sort(byKey));
      });

      it("declares no index, unique, check or composite key this test does not compare", () => {
        assert.deepEqual(
          [
            config.indexes.length,
            config.uniqueConstraints.length,
            config.checks.length,
            config.primaryKeys.length,
          ],
          [0, 0, 0, 0],
          "schema.ts gained a constraint — extend this test to compare it with the DDL"
        );
        const { sql } = sqlite
          .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
          .get(config.name) as { sql: string };
        assert.doesNotMatch(sql, /\bCHECK\b/iu, "the DDL gained a CHECK — extend this test");
        const indexes = sqlite.prepare(`PRAGMA index_list("${config.name}")`).all();
        assert.deepEqual(indexes, [], "the DDL gained an index — extend this test");
      });
    });
  }
});
