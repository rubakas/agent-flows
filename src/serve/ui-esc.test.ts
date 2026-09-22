// The page's one escape rule.
//
// This function is the whole reason the ui-*.js helpers are testable in node at
// all: every value they interpolate is model output or repository content, and
// this is the single place that decides what survives as text. It was six
// copies before, which is six places for one of them to quietly lose a case.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { esc } from "./ui-esc.js";

describe("esc — the only thing between untrusted text and the DOM", () => {
  it("escapes all five entities, ampersand first", () => {
    // `&` must go first or the escapes of the other four are themselves escaped.
    assert.equal(esc(`&<>"'`), "&amp;&lt;&gt;&quot;&#39;");
    assert.equal(esc("&lt;"), "&amp;lt;", "an already-escaped entity is text, not markup");
  });

  it("leaves a hostile string readable and inert", () => {
    const html = esc(`<img src=x onerror=alert(1)>"'`);
    assert.ok(!html.includes("<"), `no tag may survive: ${html}`);
    assert.ok(html.includes("&lt;img"), `it must still read as what it was: ${html}`);
  });

  it("escapes the quote characters, which attribute interpolation depends on", () => {
    // Several call sites put this inside title="…" and data-…="…"; leaving a
    // quote through there ends the attribute and starts a new one.
    assert.equal(esc('" onmouseover=x'), "&quot; onmouseover=x");
    assert.equal(esc("' onmouseover=x"), "&#39; onmouseover=x");
  });

  it("stringifies whatever it is given rather than throwing", () => {
    // Callers pass `d?.pid` and friends straight in; an absent field must render
    // as text, not take the whole row down.
    assert.equal(esc(undefined), "undefined");
    assert.equal(esc(null), "null");
    assert.equal(esc(7411), "7411");
  });
});
