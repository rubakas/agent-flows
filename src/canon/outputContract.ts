// The output contract of a schema-gated llm step: what the step must answer
// with, how a raw answer is turned into a value, and what to tell the model when
// it is not. Parsing lives here, away from any one binding, so every consumer of
// a declared `schema:` reads the answer the same way.

import { canonSchemas } from "./schemas.js";
import { validateCanonOutput } from "./validateOutput.js";

/**
 * Why a raw answer was rejected. `parse` = no JSON could be read out of it;
 * `schema` = it parsed but broke the declared schema. The step log's `retry`
 * event carries it.
 */
export interface OutputRejection {
  ok: false;
  reason: "parse" | "schema";
  /** What a failed step reports. */
  error: string;
  /** What the one retry tells the model. */
  retryNote: string;
}

export type OutputParse = { ok: true; value: unknown } | OutputRejection;

export interface OutputContract {
  /**
   * The JSON Schema the transports that can enforce one hand to the model (the
   * claude adapter turns it into `--json-schema`); the others ignore it.
   */
  jsonSchema?: unknown;
  parse(raw: string): OutputParse;
}

function stripFences(text: string): string {
  return text
    .replace(/^```(?:json)?\s*\n?/im, "")
    .replace(/\n?```\s*$/im, "")
    .trim();
}

/**
 * The first complete, balanced JSON object or array in `text`, or undefined.
 *
 * Character-by-character with string and escape state rather than a regex: a
 * greedy `\{[\s\S]*\}` swallows trailing prose, and a lazy one stops at the
 * first `}` inside a string value. Both are routine in a model's answer.
 */
function extractFirstJsonValue(text: string): string | undefined {
  for (let start = 0; start < text.length; start += 1) {
    const open = text[start];
    if (open !== "{" && open !== "[") continue;
    const close = open === "{" ? "}" : "]";
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i += 1) {
      const ch = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === open) depth += 1;
      else if (ch === close) {
        depth -= 1;
        if (depth === 0) return text.slice(start, i + 1);
      }
    }
    // Unterminated from here: the next opening character gets its own attempt,
    // so a stray brace in the preamble does not hide the real object.
  }
  return undefined;
}

/**
 * The candidate texts to try parsing, in decreasing order of trust: the answer
 * as given, the answer with markdown fences removed, then the first balanced
 * JSON value found anywhere in it. The last one is what survives a narrated
 * preamble ("Now producing the final critique as JSON.") ahead of the fence.
 */
function jsonCandidates(raw: string): string[] {
  const candidates = [raw.trim()];
  const stripped = stripFences(raw);
  if (!candidates.includes(stripped)) candidates.push(stripped);
  const scanned = extractFirstJsonValue(raw);
  if (scanned !== undefined && !candidates.includes(scanned)) candidates.push(scanned);
  return candidates;
}

/** Closing instruction every retry note ends with. */
const RETRY_SUFFIX = " Return ONLY the JSON object.";

/**
 * The contract of a step declaring `schema: <schemaKey>`: the answer is a JSON
 * object holding the key, and valid against the canon schema of that name.
 * A schema violation names the field and the constraint in both `error` and
 * `retryNote`.
 */
export function schemaContract(schemaKey: string): OutputContract {
  const jsonSchema = canonSchemas[schemaKey as keyof typeof canonSchemas];
  return {
    ...(jsonSchema !== undefined ? { jsonSchema } : {}),
    parse: (raw) => parseSchemaOutput(raw, schemaKey),
  };
}

function parseSchemaOutput(raw: string, schemaKey: string): OutputParse {
  const candidates = jsonCandidates(raw);
  let parsed: unknown;
  let text = candidates[0];
  let parseError = "";
  let ok = false;
  for (const candidate of candidates) {
    try {
      parsed = JSON.parse(candidate) as unknown;
      text = candidate;
      ok = true;
      break;
    } catch (err) {
      // The strict attempt's message is the one reported: it describes the
      // answer as the model actually gave it, not a rescue attempt's remains.
      if (parseError === "") parseError = err instanceof Error ? err.message : String(err);
    }
  }
  if (!ok) {
    return {
      ok: false,
      reason: "parse",
      error: parseError,
      retryNote: `Your previous output was not valid JSON (${parseError}).${RETRY_SUFFIX}`,
    };
  }
  if (typeof parsed !== "object" || parsed === null || !(schemaKey in parsed)) {
    const error = `output missing required key "${schemaKey}". Got: ${text.slice(0, 200)}`;
    return {
      ok: false,
      reason: "schema",
      error,
      // It parsed: telling the model its JSON was invalid sends it to fix the
      // one thing that was already right and leaves the missing key missing.
      retryNote:
        `Your previous output was valid JSON but had no top-level "${schemaKey}" key.` +
        ` Return an object whose "${schemaKey}" key holds the result.${RETRY_SUFFIX}`,
    };
  }
  const violations = validateCanonOutput(schemaKey, parsed);
  if (violations !== undefined) {
    return {
      ok: false,
      reason: "schema",
      error: `output does not match schema "${schemaKey}": ${violations}. Got: ${text.slice(0, 200)}`,
      retryNote:
        `Your previous output did not match the required JSON Schema` +
        ` (${violations}).${RETRY_SUFFIX}`,
    };
  }
  return { ok: true, value: parsed };
}
