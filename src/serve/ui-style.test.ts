// Spec 037 FR-013 / D8 — the developer-UI style gate.
//
// The page has no DOM test and its look is the owner's to judge, but the parts
// of D8 that are mechanical — one table class, one badge set, one accent, a
// token per theme, no shadows — are exactly the parts that rot silently when a
// later view adds its own `<table>` or its own chip. This reads the shipped
// page and the two ESM helpers that also emit markup, as text, and fails on
// anything that drifts back.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { packageRoot } from "../packageRoot.js";

// The page assets are read from the package root (spec 038 FR-004/FR-009), the
// same directory the build copies into dist/serve/.
const HERE = join(packageRoot(), "src", "serve");

const UI = readFileSync(join(HERE, "ui.html"), "utf8");
const MARKUP = {
  "ui.html": UI,
  "ui-tables.js": readFileSync(join(HERE, "ui-tables.js"), "utf8"),
  "ui-log.js": readFileSync(join(HERE, "ui-log.js"), "utf8"),
};

/** The body of a `{ … }` block that starts at the given opening line. */
function blockAfter(css: string, opener: string): string {
  const start = css.indexOf(opener);
  assert.notEqual(start, -1, `missing block: ${opener}`);
  const end = css.indexOf("}", start);
  assert.notEqual(end, -1, `unterminated block: ${opener}`);
  return css.slice(start, end);
}

describe("the page uses one visual language (spec 037 D8/FR-013)", () => {
  it("no tier class survives in the page or the markup helpers", () => {
    for (const [name, text] of Object.entries(MARKUP)) {
      assert.ok(
        !text.includes("tier-"),
        `${name} still carries a tier- class; the source column replaced them`
      );
    }
  });

  it("every table is the shared .table", () => {
    for (const [name, text] of Object.entries(MARKUP)) {
      for (const match of text.matchAll(/<table(?<attrs>[^>]*)>/gu)) {
        assert.match(
          match.groups?.attrs ?? "",
          /^\s+class="table(\s|")/u,
          `${name} renders a table without the shared class: ${match[0]}`
        );
      }
    }
  });

  it("--warn is defined in both themes", () => {
    const light = blockAfter(UI, ":root {");
    const dark = blockAfter(UI, "@media (prefers-color-scheme: dark) {\n        :root {");
    assert.match(light, /--warn:\s*#/u, "the light theme defines no --warn");
    assert.match(dark, /--warn:\s*#/u, "the dark theme defines no --warn");
  });

  it("the base font is 13px", () => {
    assert.match(blockAfter(UI, "body {"), /font-size:\s*13px/u);
  });

  it("nothing casts a shadow", () => {
    assert.ok(!UI.includes("box-shadow"), "D8 is a flat, bordered UI");
  });

  it("one badge set covers every status the page shows", () => {
    for (const variant of [
      "running",
      "succeeded",
      "failed",
      "rejected",
      "cancelled",
      "awaiting_approval",
      "disk",
    ]) {
      assert.ok(
        UI.includes(`.badge.${variant} {`),
        `no .badge.${variant} rule — the status chip would fall back to muted`
      );
    }
  });
});
