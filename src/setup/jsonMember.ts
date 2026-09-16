// Inserting and deleting ONE member of a JSON object without reformatting the
// rest of the file (spec 038 D10, FR-030/FR-031).
//
// `agent-flows setup` edits OpenCode's global config, which is the user's file:
// it holds their theme, their keybinds, their other MCP servers, and whatever
// formatting they chose. A parse-and-restringify round-trip rewrites all of
// that — inline arrays get exploded over four lines, two-space indentation
// becomes four — so `setup --remove` could never give the file back byte for
// byte, which is exactly what FR-031 requires.
//
// So the edit is textual: `setMember` splices our member in right after the
// object's opening brace, and `deleteMember` removes precisely that span again.
// Every other byte of the file is carried through untouched.

/** Where a member sits in the text: its key, its value, and their bounds. */
export interface MemberSpan {
  /** Index of the opening quote of the key. */
  keyStart: number;
  /** Index of the first character of the value. */
  valueStart: number;
  /** Index just past the last character of the value. */
  valueEnd: number;
}

function isWhitespace(char: string): boolean {
  return char === " " || char === "\t" || char === "\n" || char === "\r";
}

function skipWhitespace(text: string, index: number): number {
  let i = index;
  while (i < text.length && isWhitespace(text[i])) i += 1;
  return i;
}

/** Index just past the string literal starting at `index` (which must be a quote). */
function scanString(text: string, index: number): number {
  let i = index + 1;
  while (i < text.length) {
    if (text[i] === "\\") {
      i += 2;
      continue;
    }
    if (text[i] === '"') return i + 1;
    i += 1;
  }
  throw new Error("unterminated string");
}

/** Index just past the JSON value starting at `index`. */
export function scanValue(text: string, index: number): number {
  const first = text[index];
  if (first === '"') return scanString(text, index);
  if (first !== "{" && first !== "[") {
    let i = index;
    while (i < text.length && !",}] \t\n\r".includes(text[i])) i += 1;
    return i;
  }
  let depth = 0;
  let i = index;
  while (i < text.length) {
    const char = text[i];
    if (char === '"') {
      i = scanString(text, i);
      continue;
    }
    if (char === "{" || char === "[") depth += 1;
    if (char === "}" || char === "]") {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
    i += 1;
  }
  throw new Error("unterminated object or array");
}

/** Index of the object's opening brace at the top level of `text`, or -1. */
export function rootObjectStart(text: string): number {
  const start = skipWhitespace(text, 0);
  return text[start] === "{" ? start : -1;
}

/**
 * Locate member `key` of the object whose `{` is at `open`.
 *
 * Returns undefined when the member is absent; throws nothing on malformed
 * input beyond what `scanValue` throws, because every caller has already
 * confirmed the file parses as JSON.
 */
export function findMember(text: string, open: number, key: string): MemberSpan | undefined {
  let i = skipWhitespace(text, open + 1);
  while (i < text.length && text[i] !== "}") {
    if (text[i] !== '"') return undefined;
    const keyStart = i;
    const keyEnd = scanString(text, i);
    const name = JSON.parse(text.slice(keyStart, keyEnd)) as string;
    i = skipWhitespace(text, keyEnd);
    if (text[i] !== ":") return undefined;
    i = skipWhitespace(text, i + 1);
    const valueEnd = scanValue(text, i);
    if (name === key) return { keyStart, valueStart: i, valueEnd };
    i = skipWhitespace(text, valueEnd);
    if (text[i] !== ",") break;
    i = skipWhitespace(text, i + 1);
  }
  return undefined;
}

/** The leading whitespace of the line `index` sits on. */
function lineIndent(text: string, index: number): string {
  const lineStart = text.lastIndexOf("\n", index) + 1;
  const match = /^[ \t]*/u.exec(text.slice(lineStart, index));
  return match ? match[0] : "";
}

/** Render `value` as a member line, indented to sit inside `pad`. */
function renderMember(key: string, value: unknown, pad: string, unit: string): string {
  const body = JSON.stringify(value, null, unit).split("\n").join(`\n${pad}`);
  return `${JSON.stringify(key)}: ${body}`;
}

/**
 * Insert or replace `key` in the object whose `{` is at `open`.
 *
 * A new member always goes first, immediately after the brace — that is what
 * makes `deleteMember` an exact inverse: the span to remove starts at the brace
 * and ends at the comma we wrote.
 */
export function setMember(
  text: string,
  open: number,
  key: string,
  value: unknown,
  unit: string
): string {
  const existing = findMember(text, open, key);
  const pad = lineIndent(text, open) + unit;
  if (existing !== undefined) {
    const rendered = renderMember(key, value, lineIndent(text, existing.keyStart), unit);
    return text.slice(0, existing.keyStart) + rendered + text.slice(existing.valueEnd);
  }

  const closePad = lineIndent(text, open);
  const member = renderMember(key, value, pad, unit);
  const after = skipWhitespace(text, open + 1);
  // An empty object has no member to separate ours from, so ours brings its own
  // line break on both sides instead of a trailing comma.
  if (text[after] === "}") {
    return `${text.slice(0, open + 1)}\n${pad}${member}\n${closePad}${text.slice(after)}`;
  }
  return `${text.slice(0, open + 1)}\n${pad}${member},${text.slice(open + 1)}`;
}

/**
 * Delete `key` from the object whose `{` is at `open`, taking the separator
 * that belongs to it — and, when it was the object's only member, the
 * whitespace that surrounded it, so `{ }` collapses back to `{}`.
 */
export function deleteMember(text: string, open: number, key: string): string {
  const span = findMember(text, open, key);
  if (span === undefined) return text;

  // Back up over the whitespace we wrote before the key.
  let start = span.keyStart;
  while (start > open + 1 && isWhitespace(text[start - 1])) start -= 1;

  const afterValue = skipWhitespace(text, span.valueEnd);
  if (text[afterValue] === ",") {
    return text.slice(0, start) + text.slice(afterValue + 1);
  }
  // Last member: take the comma in front of it instead, or — if there is none —
  // everything up to the closing brace.
  if (text[start - 1] === ",") {
    return text.slice(0, start - 1) + text.slice(span.valueEnd);
  }
  return text.slice(0, start) + text.slice(afterValue);
}
