import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";

import { canonSchemas, NOT_A_DECISION } from "./schemas.js";

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
 * Three rules on `codeReviewFindings` relate one field to another, and ajv can
 * only say "must match then schema" about a failed `if/then` — a report the
 * retry prompt cannot act on. They are checked here instead so the message can
 * name both values that conflict.
 */
function crossFieldErrors(value: unknown): string[] {
  const findings = (value as { codeReviewFindings?: unknown }).codeReviewFindings;
  if (!Array.isArray(findings)) return [];
  const reports: string[] = [];
  findings.forEach((raw, index) => {
    const finding = raw as {
      verdict?: string;
      evidenceBasis?: string;
      remedyScope?: string;
      sites?: { file?: string; remedySafe?: boolean }[];
    };
    const sites = Array.isArray(finding.sites) ? finding.sites : [];
    const observed =
      finding.evidenceBasis === "file-content" || finding.evidenceBasis === "absence-of-file";
    if (finding.verdict === "CONFIRMED" && !observed) {
      reports.push(
        `codeReviewFindings.${String(index)}: verdict "CONFIRMED" needs an observation of files, but evidenceBasis is "${String(finding.evidenceBasis)}" — use PARTIAL, DECLINED or UNVERIFIABLE, or cite the file content`
      );
    }
    if (finding.remedyScope === "all-sites-verified") {
      const unsafe = sites.filter((site) => site.remedySafe === false);
      if (unsafe.length > 0) {
        const where = unsafe.map((site) => String(site.file)).join(", ");
        reports.push(
          `codeReviewFindings.${String(index)}: remedyScope "all-sites-verified" contradicts remedySafe: false at ${where} — use "sites-differ"`
        );
      }
    }
    if (finding.remedyScope === "single-site" && sites.length > 1) {
      const where = sites.map((site) => String(site.file)).join(", ");
      reports.push(
        `codeReviewFindings.${String(index)}: remedyScope "single-site" contradicts sites naming ${String(sites.length)} locations (${where}) — check the remedy at each one and use "all-sites-verified" or "sites-differ"`
      );
    }
  });
  return reports;
}

/**
 * A file-like token: a path with a separator (`app/models/lot.rb`), or a bare
 * name carrying a line reference (`lot.rb:42`, `Gemfile:3`). An `evidence`
 * string carrying neither names no file, whatever else it says — "the service
 * already does this" is a claim, and `implemented` rests on a line.
 *
 * "name with an extension" alone is not enough to be a file: `e.g.`, `i.e.` and
 * a missing space after a full stop (`vs.The`) all have that shape, so prose
 * containing "e.g." would have satisfied the check while naming nothing. A
 * separator or an explicit `:line` is what prose does not produce by accident,
 * and both are what the message asks for ("cite the path and line").
 */
const FILE_TOKEN = /[\w.-]+\/[\w.-]+|[\w-]+\.[A-Za-z]\w*:\d+/;

function isBlank(value: unknown): boolean {
  return typeof value !== "string" || value.trim().length === 0;
}

/** A required field answered with the "no decision here" convention, or not at all. */
function isUndecided(value: unknown): boolean {
  return isBlank(value) || (value as string).trim().toLowerCase() === NOT_A_DECISION;
}

/**
 * The same job as `crossFieldErrors`, for `codeReviewDelivery`: the rules that
 * make the classification vocabulary cost something to write. Without them the
 * enum is only a word the model picks — `silently-decided` with no decision
 * named is a shrug, and `implemented` with no file named is the claim the
 * dimension exists to refuse.
 */
function deliveryCrossFieldErrors(value: unknown): string[] {
  const top = value as { specSourcesProvided?: unknown; codeReviewDelivery?: unknown };
  const entries = top.codeReviewDelivery;
  if (!Array.isArray(entries)) return [];
  const reports: string[] = [];
  if (top.specSourcesProvided === false && entries.length > 0) {
    reports.push(
      `(root): specSourcesProvided "false" contradicts codeReviewDelivery holding ${String(entries.length)} entries — with no spec source there is no requirement to classify; report zero entries or set specSourcesProvided "true"`
    );
  }
  entries.forEach((raw, index) => {
    const entry = raw as {
      classification?: string;
      requirement?: unknown;
      evidence?: unknown;
      decisionTaken?: unknown;
      optionsForeclosed?: unknown;
    };
    const at = `codeReviewDelivery.${String(index)}`;
    if (entry.classification === "silently-decided") {
      if (isUndecided(entry.decisionTaken)) {
        reports.push(
          `${at}: classification "silently-decided" needs the decision named, but decisionTaken is ${JSON.stringify(entry.decisionTaken ?? "")} — name the option the change took, or classify it "implemented"`
        );
      }
      if (isUndecided(entry.optionsForeclosed)) {
        reports.push(
          `${at}: classification "silently-decided" needs the foreclosed options named, but optionsForeclosed is ${JSON.stringify(entry.optionsForeclosed ?? "")} — name what the change ruled out, or classify it "implemented"`
        );
      }
    }
    if (
      (entry.classification === "implemented" || entry.classification === "partial") &&
      !FILE_TOKEN.test(typeof entry.evidence === "string" ? entry.evidence : "")
    ) {
      reports.push(
        `${at}: classification "${entry.classification}" needs evidence naming a file, but evidence is ${JSON.stringify(entry.evidence ?? "")} — cite the path and line that satisfies it, or use "not-implemented" or "replaced-by-prose"`
      );
    }
    if (entry.classification === "correctly-deferred" && isBlank(entry.requirement)) {
      reports.push(
        `${at}: classification "correctly-deferred" needs the deferring spec line quoted, but requirement is ${JSON.stringify(entry.requirement ?? "")} — quote the line that defers it, or use "not-implemented"`
      );
    }
  });
  return reports;
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
  if (!validate(value)) return formatErrors(validate.errors ?? []);
  let crossField: string[] = [];
  if (schemaKey === "codeReviewFindings") crossField = crossFieldErrors(value);
  if (schemaKey === "codeReviewDelivery") crossField = deliveryCrossFieldErrors(value);
  return crossField.length > 0 ? crossField.join("; ") : undefined;
}
