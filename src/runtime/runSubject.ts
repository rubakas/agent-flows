// What a run is about, in one line (spec 042 D14).
//
// The runs list said `code-review` and its current step, which answers "what is
// this doing" but not "to what". With several reviews queued against different
// pull requests those rows are indistinguishable, and the operator has to open
// each one to find out which is which.
//
// Derived, never stored by a caller and never asked of a model: the answer is
// already in the inputs the run was started with.

/** The longest string input is the substantive one; refs and commit lists are short. */
function primaryInput(inputs: unknown): string | undefined {
  if (typeof inputs !== "object" || inputs === null) return undefined;
  let best: string | undefined;
  for (const value of Object.values(inputs as Record<string, unknown>)) {
    if (typeof value !== "string") continue;
    if (best === undefined || value.length > best.length) best = value;
  }
  return best;
}

/** Strip the markdown a heading line carries, so the subject reads as prose. */
function cleanLine(line: string): string {
  return line
    .replace(/^#{1,6}\s+/u, "")
    .replace(/^[-*]\s+/u, "")
    .replace(/\*\*/gu, "")
    .replace(/`/gu, "")
    .trim();
}

/** Longest subject kept; the full text stays available on the run itself. */
export const SUBJECT_MAX = 100;

/**
 * One line naming what this run was started against, or undefined when the
 * inputs carry nothing worth showing.
 *
 * @param {unknown} invocation The run's recorded invocation.
 * @returns {string | undefined}
 */
export function runSubject(invocation: unknown): string | undefined {
  if (typeof invocation !== "object" || invocation === null) return undefined;
  const text = primaryInput((invocation as { inputs?: unknown }).inputs);
  if (text === undefined) return undefined;
  for (const raw of text.split("\n")) {
    const line = cleanLine(raw);
    if (line === "") continue;
    return line.length > SUBJECT_MAX ? `${line.slice(0, SUBJECT_MAX - 1)}…` : line;
  }
  return undefined;
}
