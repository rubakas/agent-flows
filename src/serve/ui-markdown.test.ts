// Spec 042 D26 — rendering untrusted model output as markdown.
//
// The first describe is the one that matters. Everything else is presentation;
// that block is the reason this file exists instead of a markdown library.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { looksLikeMarkdown, renderMarkdown } from "./ui-markdown.js";

const HOSTILE = "<img src=x onerror=alert(1)> <script>alert(2)</script> \"quoted\" 'single'";

describe("renderMarkdown — the text is untrusted, and stays that way", () => {
  it("emits no tag the text asked for", () => {
    const html = renderMarkdown(HOSTILE);
    assert.ok(!html.includes("<img"), `raw markup must not survive: ${html}`);
    assert.ok(!html.includes("<script"), `a script tag least of all: ${html}`);
    assert.ok(html.includes("&lt;img"), "it must still be readable, as text");
  });

  it("escapes inside every construct, not only paragraphs", () => {
    for (const source of [
      `# ${HOSTILE}`,
      `- ${HOSTILE}`,
      `> ${HOSTILE}`,
      "```\n" + HOSTILE + "\n```",
      `**${HOSTILE}**`,
      "`" + HOSTILE + "`",
    ]) {
      const html = renderMarkdown(source);
      assert.ok(!html.includes("<img"), `escaped in: ${source} → ${html}`);
      assert.ok(!html.includes("<script"), `escaped in: ${source} → ${html}`);
    }
  });

  it("cannot be tricked by text carrying the code-span sentinel", () => {
    // The marker is stripped from the input before it is used, so text that
    // contains it cannot forge a code span or swallow the spans around it.
    const html = renderMarkdown("a \uE0000\uE000 b `real` c");
    assert.ok(html.includes('<code class="md-code">real</code>'), html);
    assert.ok(!html.includes("\uE000"), `the marker must not survive: ${html}`);
  });

  it("cannot be tricked into a tag by text that looks like one of ours", () => {
    const html = renderMarkdown("**a</strong><img src=x>b**");
    assert.ok(!html.includes("<img"), html);
    assert.equal((html.match(/<strong>/gu) ?? []).length, 1, `one opener only: ${html}`);
  });
});

describe("renderMarkdown — the constructs these reports actually use", () => {
  it("marks headings by level, so a finding outranks its fields", () => {
    const html = renderMarkdown("# Prioritised findings\n## 1. A folder name");
    assert.ok(html.includes("md-h1"), html);
    assert.ok(html.includes("md-h2"), html);
    assert.ok(html.includes("Prioritised findings"));
  });

  it("renders a bullet list as one list, not a list per line", () => {
    const html = renderMarkdown("- one\n- two\n- three");
    assert.equal((html.match(/<ul/gu) ?? []).length, 1, `one list: ${html}`);
    assert.equal((html.match(/<li>/gu) ?? []).length, 3);
  });

  it("closes the list when the prose resumes", () => {
    const html = renderMarkdown("- one\n\nplain text");
    assert.ok(html.indexOf("</ul>") < html.indexOf("plain text"), html);
  });

  it("keeps a fenced block verbatim, with no inline marks applied inside", () => {
    const html = renderMarkdown("```\n- **not a list**\n```");
    assert.ok(html.includes("md-pre"), html);
    assert.ok(!html.includes("<strong>"), `a fence is literal: ${html}`);
    assert.ok(!html.includes("<li>"), `and not a list: ${html}`);
  });

  it("does not read asterisks inside a code span as emphasis", () => {
    // `Read(**/*.pem)` is a real permission glob from this project's own output.
    const html = renderMarkdown("the deny glob `Read(**/*.pem)` applies");
    assert.ok(!html.includes("<strong>"), `a path is not bold: ${html}`);
    assert.ok(html.includes("md-code"), html);
  });

  it("marks bold, italic and inline code distinctly", () => {
    const html = renderMarkdown("**Severity** — *minor* at `app/models/x.rb:28`");
    assert.ok(html.includes("<strong>Severity</strong>"), html);
    assert.ok(html.includes("<em>minor</em>"), html);
    assert.ok(html.includes('<code class="md-code">app/models/x.rb:28</code>'), html);
  });

  it("renders a horizontal rule and a blockquote", () => {
    assert.ok(renderMarkdown("---").includes("md-rule"));
    assert.ok(renderMarkdown("> quoted").includes("md-quote"));
  });

  it("shows an unterminated fence rather than swallowing the rest", () => {
    const html = renderMarkdown("```\nstill here");
    assert.ok(html.includes("still here"), `the model's text survives its own typo: ${html}`);
  });
});

describe("looksLikeMarkdown — when it is worth doing at all", () => {
  it("says yes to a report and no to JSON", () => {
    assert.equal(looksLikeMarkdown("# Findings\n- one"), true);
    assert.equal(looksLikeMarkdown('{"findings": []}'), false);
    assert.equal(looksLikeMarkdown("[1, 2, 3]"), false);
  });

  it("says no to a plain sentence, which gains nothing from a tag", () => {
    assert.equal(looksLikeMarkdown("The suite passed."), false);
  });
});
