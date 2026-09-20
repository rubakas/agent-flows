import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";

import { canonSchemas } from "./schemas.js";

/**
 * A declared `schema:` used to be prompt text and nothing else: the output was
 * parsed, its top-level key checked, and every `enum`, `required` and
 * `additionalProperties: false` clause in the canon schema went unchecked. This
 * module is what makes the declaration binding.
 *
 * `verbose: true` keeps the offending value on each error so the retry prompt can
 * name what the model actually wrote; `allErrors: true` so one round trip reports
 * every violation rather than the first.
 */
const ajv = new Ajv({
  allErrors: true,
  verbose: true,
  // CODE_REVIEW_FINDING declares `line: { type: ["string", "number"] }`; without
  // this ajv's strict mode logs a warning on every compile. The union is
  // deliberate, so it is allowed rather than silenced.
  allowUnionTypes: true,
});

const compiled = new Map<string, ValidateFunction>();

function validatorFor(schemaKey: string): ValidateFunction | undefined {
  const schema = canonSchemas[schemaKey as keyof typeof canonSchemas];
  if (!schema) return undefined;
  const cached = compiled.get(schemaKey);
  if (cached) return cached;
  const fn = ajv.compile(schema);
  compiled.set(schemaKey, fn);
  return fn;
}

/** Longest error report handed to a retry prompt, so a pathological list cannot blow it up. */
const MAX_REPORT_CHARS = 600;
/** Most violations named individually; the rest are counted. */
const MAX_REPORTED_ERRORS = 10;

function fieldPath(instancePath: string): string {
  if (instancePath === "") return "(root)";
  return instancePath.slice(1).replace(/\//g, ".");
}

function describeError(err: ErrorObject): string {
  const path = fieldPath(err.instancePath);
  switch (err.keyword) {
    case "enum": {
      const allowed = (err.params.allowedValues as unknown[]).join(", ");
      return `${path}: must be one of ${allowed} — got ${JSON.stringify(err.data)}`;
    }
    case "required":
      return `${path}: missing required field "${String(err.params.missingProperty)}"`;
    case "additionalProperties":
      return `${path}: unexpected field "${String(err.params.additionalProperty)}"`;
    case "type":
      return `${path}: must be ${String(err.params.type)} — got ${JSON.stringify(err.data)}`;
    default:
      return `${path}: ${err.message ?? "invalid"}`;
  }
}

function formatErrors(errors: readonly ErrorObject[]): string {
  const shown = errors.slice(0, MAX_REPORTED_ERRORS).map(describeError);
  const hidden = errors.length - shown.length;
  let report = shown.join("; ");
  if (report.length > MAX_REPORT_CHARS) report = `${report.slice(0, MAX_REPORT_CHARS)}…`;
  return hidden > 0 ? `${report} (+${hidden} more)` : report;
}

/**
 * Validates a parsed step output against the canon schema named by `schemaKey`.
 * Returns a readable report of every violation, or undefined when the value is
 * valid — or when the key names no canon schema, which the prompt builder also
 * treats as "nothing declared".
 */
export function validateCanonOutput(schemaKey: string, value: unknown): string | undefined {
  const validate = validatorFor(schemaKey);
  if (!validate) return undefined;
  if (validate(value)) return undefined;
  return formatErrors(validate.errors ?? []);
}
