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
//   node check.mjs verdict <runDir>
//   exit 0 valid; exit 1 invalid - an unreadable file, text that is not JSON (a fenced code
//   block, say) or a schema/rule violation - with one readable line per problem on stdout;
//   exit 2 only for a usage error (bad argv, unknown schema name), on stderr
//
// `verdict` computes the merge verdict line from <runDir>/out/verify.json (checked against the
// findings schema) and <runDir>/out/coverage.json: exit 0 and the line on stdout, also written
// to <runDir>/out/verdict.txt, when a verdict is established, ready or not; exit 1 and
// "Verdict not established: <why>" when an input is missing or invalid.

import { readFileSync, rmSync, writeFileSync } from "node:fs";
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

/** Control characters (ESC, NUL, DEL ...) become spaces, so nothing echoed can drive a terminal. */
const clean = (text) => String(text).replace(/[\u0000-\u001f\u007f]/g, " ");

const display = (value) => clean(JSON.stringify(value) ?? String(value));

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
        if (!Object.hasOwn(properties, name))
          errors.push(`${at}: unexpected field "${clean(name)}"`);
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

/** The review's worker axes, as the engine and the Codex procedure name them. */
export const AXES = ["falsifiability", "correctness", "security", "radius", "delivery"];

const oneLine = (text) => clean(text).replace(/\s+/g, " ").trim();

const REASON_MAX = 200;
const capped = (text) => {
  const line = oneLine(text);
  return line.length > REASON_MAX ? `${line.slice(0, REASON_MAX - 1)}\u2026` : line;
};

const DELIVERY_FAILED = "delivery output failed its check";

/** Returns the coverage as `{ran, failed, skipped}` or throws an Error saying what is wrong. */
function readCoverage(file) {
  let coverage;
  try {
    coverage = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(
      `${file} is not readable bare JSON - ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (typeOf(coverage) !== "object") throw new Error(`${file} must be a JSON object`);
  const unexpected = (where, object, allowed) => {
    const extra = Object.keys(object).find((key) => !allowed.includes(key));
    if (extra !== undefined) {
      throw new Error(
        `${file}: ${where} has unexpected key "${extra}" (allowed: ${allowed.join(", ")})`
      );
    }
  };
  unexpected("coverage", coverage, ["ran", "failed", "skipped"]);
  const seen = [];
  const stepOf = (where, step) => {
    if (!AXES.includes(step)) {
      throw new Error(`${file}: ${where} names ${display(step)}, not one of ${AXES.join(", ")}`);
    }
    seen.push(step);
    return step;
  };
  if (!Array.isArray(coverage.ran)) throw new Error(`${file}: "ran" must be an array of step ids`);
  const ran = coverage.ran.map((step) => stepOf("ran", step));
  const withReasons = (key) => {
    if (!Array.isArray(coverage[key])) throw new Error(`${file}: "${key}" must be an array`);
    return coverage[key].map((entry) => {
      if (typeOf(entry) !== "object" || typeof entry.reason !== "string") {
        throw new Error(`${file}: every "${key}" entry needs a step and a string reason`);
      }
      unexpected(`a "${key}" entry`, entry, ["step", "reason"]);
      return { step: stepOf(key, entry.step), reason: capped(entry.reason) };
    });
  };
  const failed = withReasons("failed");
  const skipped = withReasons("skipped");
  // A dropped axis reads as a clean one, so every axis must be accounted for exactly once.
  for (const axis of AXES) {
    const count = seen.filter((step) => step === axis).length;
    if (count !== 1) {
      throw new Error(
        `${file}: ${axis} must appear exactly once across ran, failed and skipped - found ${String(count)}`
      );
    }
  }
  return { ran, failed, skipped };
}

/** The merge verdict line (spec 049 D1-D3): code over the verified findings and the coverage. */
function computeVerdict(findings, coverage) {
  const defects = findings.filter((f) => f.kind === "defect");
  const real = (f) => f.verdict === "CONFIRMED" || f.verdict === "PARTIAL";
  const heavy = (f) => f.severity === "blocking" || f.severity === "major";
  const gate = defects.filter((f) => real(f) && f.scope !== "pre-existing");
  const blocking = gate.filter((f) => f.severity === "blocking").length;
  const major = gate.filter((f) => f.severity === "major").length;
  const failed = coverage.failed.map(({ step, reason }) => `${step} (${reason})`);

  if (blocking + major > 0) {
    const notExamined = failed.length > 0 ? ` Not examined: ${failed.join(", ")}.` : "";
    return (
      `Not ready to merge: ${String(blocking)} blocking and ${String(major)} major ` +
      `finding(s) introduced by this change.${notExamined}`
    );
  }
  if (failed.length > 0) {
    const did = coverage.failed.map(({ step, reason }) => `${step} did not run (${reason})`);
    return `Readiness not established: ${did.join(", ")}.`;
  }
  const unverifiable = defects.filter(
    (f) => f.verdict === "UNVERIFIABLE" && heavy(f) && f.scope !== "pre-existing"
  ).length;
  if (unverifiable > 0) {
    return `Readiness not established: ${String(unverifiable)} blocking or major claim(s) could not be verified.`;
  }

  const minor = gate.filter((f) => f.severity === "minor").length;
  const preExisting = defects.filter((f) => real(f) && heavy(f) && f.scope === "pre-existing");
  const questions = findings.filter((f) => f.kind !== "defect" && real(f)).length;
  let line = `Ready to merge: no blocking or major defect introduced; examined ${coverage.ran.join(", ")}`;
  for (const { step, reason } of coverage.skipped) line += `; ${step} not checked: ${reason}`;
  line += ".";
  if (minor > 0) line += ` ${String(minor)} minor finding(s).`;
  if (preExisting.length > 0) {
    line += ` ${String(preExisting.length)} pre-existing blocking/major finding(s) not introduced by this change.`;
  }
  if (questions > 0) line += ` ${String(questions)} question(s) for owners.`;
  return line;
}

/** Delivery only counts as examined when its output passes the delivery schema. */
function checkedCoverage(out, coverage) {
  if (!coverage.ran.includes("delivery")) return coverage;
  try {
    const value = JSON.parse(readFileSync(join(out, "delivery.json"), "utf8"));
    if (validate(loadSchema("delivery"), value).length === 0) return coverage;
  } catch {
    // unreadable or not JSON: the same outcome as a schema violation
  }
  return {
    ran: coverage.ran.filter((step) => step !== "delivery"),
    failed: [...coverage.failed, { step: "delivery", reason: DELIVERY_FAILED }],
    skipped: coverage.skipped,
  };
}

function verdictMain(runDir) {
  const out = join(runDir, "out");
  const verdictFile = join(out, "verdict.txt");
  const refuse = (why) => {
    process.stdout.write(`Verdict not established: ${oneLine(why)}\n`);
    return 1;
  };
  const reason = (err) => (err instanceof Error ? err.message : String(err));
  // A verdict file left by an earlier run must never outlive a refusal.
  try {
    rmSync(verdictFile, { force: true });
  } catch (err) {
    return refuse(`${verdictFile} cannot be cleared - ${reason(err)}`);
  }
  let findings;
  const verifyFile = join(out, "verify.json");
  try {
    const value = JSON.parse(readFileSync(verifyFile, "utf8"));
    const errors = validate(loadSchema("findings"), value);
    if (errors.length > 0) {
      return refuse(
        `${verifyFile} breaks the findings schema (${errors[0]}); run check.mjs findings on it`
      );
    }
    findings = value.codeReviewFindings;
  } catch (err) {
    return refuse(`${verifyFile} is not a readable bare JSON object - ${reason(err)}`);
  }
  let coverage;
  try {
    coverage = checkedCoverage(out, readCoverage(join(out, "coverage.json")));
  } catch (err) {
    return refuse(reason(err));
  }
  const line = computeVerdict(findings, coverage);
  try {
    writeFileSync(verdictFile, line + "\n");
  } catch (err) {
    return refuse(`${verdictFile} cannot be written - ${reason(err)}`);
  }
  process.stdout.write(line + "\n");
  return 0;
}

function main(argv) {
  if (argv[0] === "verdict") {
    if (argv.length === 2) return verdictMain(argv[1]);
    process.stderr.write("usage: node check.mjs verdict <runDir>\n");
    return 2;
  }
  const [name, file] = argv;
  if (argv.length !== 2 || !SCHEMAS.includes(name)) {
    process.stderr.write(
      "usage: node check.mjs <findings|delivery> <file.json> | node check.mjs verdict <runDir>\n"
    );
    return 2;
  }
  let value;
  try {
    value = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    const why = clean(err instanceof Error ? err.message : String(err));
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
