#!/usr/bin/env node
// Validates a review step's JSON output against the two schemas in
// ../references/schemas/. Node >= 18, node builtins only.
//
// This is a deliberately small JSON-schema checker: it supports exactly the keywords
// those schemas use and THROWS on any other keyword, so a future schema edit cannot
// be silently left unchecked. Codex has no subagent-side schema validation, so this
// is the gate its procedure (references/codex.md) runs on verify and delivery output.
//
//   node check.mjs <findings|delivery> <file.json>
//   exit 0 valid; exit 1 invalid - an unreadable file, text that is not JSON (a fenced code
//   block, say) or a schema/rule violation - with one readable line per problem on stdout;
//   exit 2 only for a usage error (bad argv, unknown schema name), on stderr

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Keywords that carry no validation meaning. */
const ANNOTATIONS = new Set(["$schema", "title", "description"]);

/** Keywords validated below. */
const SUPPORTED = new Set([
  "type",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "const",
  "maxItems",
  "pattern",
  "allOf",
  "if",
  "then",
  "not",
]);

const SCHEMAS = ["findings", "delivery"];

function typeOf(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

const display = (value) => JSON.stringify(value) ?? String(value);

/** Throws on any keyword this checker does not implement. */
function assertSupported(schema, path) {
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) {
    throw new Error(`schema at ${path || "(root)"} is not an object`);
  }
  for (const keyword of Object.keys(schema)) {
    if (!ANNOTATIONS.has(keyword) && !SUPPORTED.has(keyword)) {
      throw new Error(`unsupported schema keyword "${keyword}" at ${path || "(root)"}`);
    }
  }
}

/** Checks every subschema up front, so a keyword in a branch that never fires still throws. */
function assertTreeSupported(schema, path) {
  assertSupported(schema, path);
  for (const [name, sub] of Object.entries(schema.properties ?? {})) {
    assertTreeSupported(sub, `${path}/properties/${name}`);
  }
  if (schema.additionalProperties !== undefined && schema.additionalProperties !== false) {
    throw new Error(`unsupported additionalProperties value at ${path || "(root)"}`);
  }
  for (const key of ["items", "if", "then", "not"]) {
    if (schema[key] !== undefined) assertTreeSupported(schema[key], `${path}/${key}`);
  }
  (schema.allOf ?? []).forEach((sub, index) =>
    assertTreeSupported(sub, `${path}/allOf/${String(index)}`)
  );
}

function collect(schema, value, path, errors) {
  const at = path === "" ? "(root)" : path;

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.includes(typeOf(value))) {
      errors.push(`${at}: must be ${types.join(" or ")} — got ${display(value)}`);
      return;
    }
  }
  if (schema.enum !== undefined && !schema.enum.some((option) => deepEqual(option, value))) {
    errors.push(
      `${at}: must be one of ${schema.enum.map(display).join(", ")} — got ${display(value)}`
    );
  }
  if (schema.const !== undefined && !deepEqual(schema.const, value)) {
    errors.push(`${at}: must be ${display(schema.const)} — got ${display(value)}`);
  }
  if (typeof value === "string") {
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, "u").test(value)) {
      errors.push(`${at}: must match pattern ${schema.pattern} — got ${display(value)}`);
    }
  }
  if (Array.isArray(value)) {
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      errors.push(`${at}: must have at most ${String(schema.maxItems)} items`);
    }
    if (schema.items !== undefined) {
      value.forEach((item, index) =>
        collect(schema.items, item, `${path}/${String(index)}`, errors)
      );
    }
  }
  if (typeOf(value) === "object") {
    for (const name of schema.required ?? []) {
      if (!Object.hasOwn(value, name)) errors.push(`${at}: missing required field "${name}"`);
    }
    const properties = schema.properties ?? {};
    for (const [name, sub] of Object.entries(properties)) {
      if (Object.hasOwn(value, name)) collect(sub, value[name], `${path}/${name}`, errors);
    }
    if (schema.additionalProperties === false) {
      for (const name of Object.keys(value)) {
        if (!Object.hasOwn(properties, name)) errors.push(`${at}: unexpected field "${name}"`);
      }
    }
  }
  for (const sub of schema.allOf ?? []) collect(sub, value, path, errors);
  if (schema.if !== undefined) {
    const probe = [];
    collect(schema.if, value, path, probe);
    if (probe.length === 0 && schema.then !== undefined) {
      const failed = [];
      collect(schema.then, value, path, failed);
      // The rule's own description is the actionable part; the sub-errors say where.
      if (failed.length > 0) {
        const rule = schema.description ?? "a conditional requirement is not met";
        errors.push(`${at}: ${rule} [${failed.join("; ")}]`);
      }
    }
  }
  if (schema.not !== undefined) {
    const probe = [];
    collect(schema.not, value, path, probe);
    if (probe.length === 0)
      errors.push(`${at}: must not match the forbidden form — got ${display(value)}`);
  }
}

/**
 * @param schema a parsed JSON schema (only the keywords listed above)
 * @param value the parsed value to check
 * @returns one `path: message` string per violation; empty when valid
 * @throws when the schema uses a keyword this checker does not implement
 */
export function validate(schema, value) {
  assertTreeSupported(schema, "");
  const errors = [];
  collect(schema, value, "", errors);
  return errors;
}

export function loadSchema(name) {
  const here = dirname(fileURLToPath(import.meta.url));
  return JSON.parse(
    readFileSync(join(here, "..", "references", "schemas", `${name}.json`), "utf8")
  );
}

function main(argv) {
  const [name, file] = argv;
  if (argv.length !== 2 || !SCHEMAS.includes(name)) {
    process.stderr.write("usage: node check.mjs <findings|delivery> <file.json>\n");
    return 2;
  }
  let value;
  try {
    value = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    process.stdout.write(
      `(root): ${file} is not a readable bare JSON object (no code fences, no prose) - ${why}\n`
    );
    return 1;
  }
  const errors = validate(loadSchema(name), value);
  if (errors.length > 0) process.stdout.write(errors.join("\n") + "\n");
  return errors.length > 0 ? 1 : 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
