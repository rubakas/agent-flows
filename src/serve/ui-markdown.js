// A deliberately small markdown renderer for model output (spec 042 D26).
//
// The reports these runs produce are markdown — headings, bold labels, inline
// code paths, fenced diffs — and showing them as one grey monospaced wall made
// the finding, its severity and its file path read as the same thing.
//
// THE SAFETY RULE, and the reason this is not a markdown library: the text is
// untrusted model output. Every line is escaped FIRST, and only then are our own
// tags introduced. After escaping there is no `<` left in the input, so no
// pattern below can emit a tag the model chose — the tag set is exactly what
// this file writes. A library that parses raw markdown to HTML would hand that
// choice back to the text.

/**
 * Escape HTML entities. Same rule as `escH` in ui.html — this module is plain
 * ESM the browser loads unbuilt, so it cannot import the page's copy.
 *
 * @param {unknown} s
 * @returns {string}
 */
function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Private-use marker standing in for a code span while emphasis is applied. */
const SENTINEL = "\uE000";

/**
 * Inline marks, applied to ALREADY-ESCAPED text.
 *
 * Code spans first: a deny glob inside backticks carries asterisks that must not
 * be read as emphasis, so spans are lifted out, the rest is marked, and they are
 * put back. (The example cannot be written here: it would close this comment.)
 *
 * @param {string} escaped
 * @returns {string}
 */
function inlineMarks(escaped) {
  const spans = [];
  // The sentinel is stripped from the input first, so text that happens to carry
  // it cannot forge a code span or swallow the real ones around it.
  let out = escaped.replaceAll(SENTINEL, "").replace(/`([^`]+)`/gu, (_m, code) => {
    spans.push(code);
    return `${SENTINEL}${spans.length - 1}${SENTINEL}`;
  });
  out = out
    .replace(/\*\*([^*]+)\*\*/gu, "<strong>$1</strong>")
    .replace(/(^|\s)\*([^*]+)\*(?=\s|$|[.,;:)])/gu, "$1<em>$2</em>");
  return out.replace(
    new RegExp(`${SENTINEL}(\\d+)${SENTINEL}`, "gu"),
    (_m, i) => `<code class="md-code">${spans[Number(i)]}</code>`
  );
}

/** Heading level to the class that colours it; deeper levels reuse the last. */
const HEADING_CLASS = ["md-h1", "md-h2", "md-h3"];

/**
 * Render a markdown subset as HTML.
 *
 * Supports what these reports actually contain: ATX headings, fenced code,
 * bullet lists, blockquotes, horizontal rules, bold, italic and inline code.
 * Anything else is a paragraph — an unsupported construct shows as its own
 * source text rather than disappearing.
 *
 * @param {string} text
 * @returns {string} HTML built only from the tags in this file.
 */
export function renderMarkdown(text) {
  const lines = String(text ?? "").split("\n");
  let html = "";
  let list = false;
  let fence = null;

  const closeList = () => {
    if (list) html += "</ul>";
    list = false;
  };

  for (const raw of lines) {
    if (fence !== null) {
      if (/^\s*```/u.test(raw)) {
        html += `<pre class="md-pre">${esc(fence.join("\n"))}</pre>`;
        fence = null;
      } else fence.push(raw);
      continue;
    }
    if (/^\s*```/u.test(raw)) {
      closeList();
      fence = [];
      continue;
    }

    const line = raw.trimEnd();
    if (line.trim() === "") {
      closeList();
      continue;
    }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/u.test(line)) {
      closeList();
      html += `<hr class="md-rule" />`;
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/u.exec(line);
    if (heading) {
      closeList();
      const cls = HEADING_CLASS[Math.min(heading[1].length, HEADING_CLASS.length) - 1];
      html += `<div class="md-h ${cls}">${inlineMarks(esc(heading[2]))}</div>`;
      continue;
    }

    const quote = /^>\s?(.*)$/u.exec(line);
    if (quote) {
      closeList();
      html += `<blockquote class="md-quote">${inlineMarks(esc(quote[1]))}</blockquote>`;
      continue;
    }

    const bullet = /^\s*[-*]\s+(.*)$/u.exec(line);
    if (bullet) {
      if (!list) html += `<ul class="md-list">`;
      list = true;
      html += `<li>${inlineMarks(esc(bullet[1]))}</li>`;
      continue;
    }

    closeList();
    html += `<p class="md-p">${inlineMarks(esc(line))}</p>`;
  }
  // An unterminated fence is the model's, not ours: show what it wrote.
  if (fence !== null) html += `<pre class="md-pre">${esc(fence.join("\n"))}</pre>`;
  closeList();
  return html;
}

/**
 * Whether text is worth rendering as markdown at all.
 *
 * A step that answers with one plain sentence gains nothing from a paragraph
 * tag, and a JSON blob would only be disfigured by it.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function looksLikeMarkdown(text) {
  const s = String(text ?? "");
  if (s.trimStart().startsWith("{") || s.trimStart().startsWith("[")) return false;
  return (
    /^#{1,6}\s/mu.test(s) || /^\s*[-*]\s+/mu.test(s) || /\*\*[^*]+\*\*/u.test(s) || /```/u.test(s)
  );
}
