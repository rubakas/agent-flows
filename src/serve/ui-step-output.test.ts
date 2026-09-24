// The step excerpt must be readable, and must never pass itself off as whole.
//
// Two defects the owner hit on the same screen: expanding an excerpt only made
// the box taller — the client held nothing but the 2048-char excerpt, so the
// text stayed cut — and the daemon's `outputTruncated` flag was dropped on
// arrival, so nothing on the page said the text was cut at all.
//
// The page has no DOM harness (there is no jsdom in this repo), so this reads
// the shipped inline script as text, one function at a time. That is weaker
// than running it, but it is exactly strong enough to catch the two things
// that regress: a destructure that forgets a field, and a toggle that fetches
// nothing.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { packageRoot } from "../packageRoot.js";

const UI = readFileSync(join(packageRoot(), "src", "serve", "ui.html"), "utf8");

/** The source of one top-level function in the page's inline script. */
function fnSource(name: string): string {
  const start = UI.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `ui.html declares no ${name}()`);
  const rest = UI.slice(start + 1);
  const next = rest.search(/\n {6}(?:async )?function /u);
  assert.notEqual(next, -1, `cannot find where ${name}() ends`);
  return rest.slice(0, next);
}

describe("an excerpt opens into the real output (042 D18)", () => {
  it("expanding an excerpt fetches the step's full output", () => {
    const toggles = fnSource("wireExcerptToggles");
    assert.match(
      toggles,
      /loadFullOutput\(/u,
      "expanding only changes max-height; the client still holds nothing but the excerpt"
    );
  });

  it("the full output comes from the existing route, through the existing renderer", () => {
    const fetcher = fnSource("fetchStepOutput");
    assert.match(
      fetcher,
      /\/api\/runs\/\$\{encodeURIComponent\(runId\)\}\/steps\/\$\{encodeURIComponent\(stepId\)\}\/output/u,
      "the excerpt loader must reuse GET /api/runs/:id/steps/:stepId/output"
    );
    assert.match(fnSource("loadFullOutput"), /renderOutput\(/u, "must render, not dump text");
  });

  it("a second open of the same excerpt costs no second request", () => {
    const fetcher = fnSource("fetchStepOutput");
    assert.match(fetcher, /_fullOutputs\.has\(key\)/u, "no cache lookup before the fetch");
    assert.match(fetcher, /_fullOutputs\.set\(key/u, "nothing is ever put in the cache");
  });

  it("a 404 or a failed request leaves the excerpt on screen", () => {
    const loader = fnSource("loadFullOutput");
    assert.match(loader, /res\.status === 404|payload === null/u, "no branch for 'none persisted'");
    assert.match(loader, /catch \(e\)/u, "a failed fetch would reject unhandled");
    assert.ok(
      !/catch \(e\) \{[^}]*innerHTML\s*=/u.test(loader),
      "the failure path must not overwrite the text the operator is already reading"
    );
  });
});

describe("the page says when the text it shows is cut (FR-006)", () => {
  it("the live step update keeps outputTruncated instead of dropping it", () => {
    const update = fnSource("updateStepRow");
    assert.match(
      update,
      /const \{[^}]*outputTruncated[^}]*\} = data;/u,
      "updateStepRow destructures the SSE payload without outputTruncated, so the flag dies here"
    );
    assert.match(update, /setExcerptNote\(/u, "the flag is read but nothing is shown for it");
  });

  it("a truncated step renders a note and an untruncated one does not", () => {
    const rowHtml = fnSource("stepRowHtml");
    assert.match(
      rowHtml,
      /if \(st\.outputTruncated\) \{/u,
      "the snapshot's truncation flag is never consulted when the row is built"
    );
    // The note is conditional on the flag — an untruncated step cannot get one.
    assert.equal(
      (rowHtml.match(/step-output-note/gu) ?? []).length,
      1,
      "exactly one place in a step row emits the note"
    );
  });

  it("the note is dropped once the full output has been loaded", () => {
    assert.match(
      fnSource("loadFullOutput"),
      /setExcerptNote\(row, el, null\)/u,
      "after the full text arrives the page would still claim it is cut"
    );
  });

  it("the note has a style of its own, so it does not read as output", () => {
    assert.ok(UI.includes(".step-output-note {"), "no .step-output-note rule");
  });
});
