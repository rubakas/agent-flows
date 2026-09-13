/**
 * Read a pipeline step's accumulated-context entry as text.
 *
 * A plain step stores the raw model output, a string. A step that declares a
 * `schema:` stores the PARSED OBJECT instead (src/bindings/mastra/buildSteps.ts:
 * `value = r1.value`), and the context schema `z.record(z.string(), z.unknown())`
 * passes that object through untouched. Reading such an entry with a
 * `typeof x === "string"` test therefore yields "" on every successful run.
 *
 * The scorers take JSON as a string and parse it themselves, so re-serialising
 * the object is the whole conversion.
 */
export function stepOutputText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null) return JSON.stringify(value);
  return "";
}
