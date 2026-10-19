// The Copy button on a settled run's Result must hand over the Result, always.
//
// The button carries only an index into _copyPayloads, and renderRunDetail
// empties that registry on every render. The Result block's HTML used to be
// cached per run and put back verbatim, so a re-opened run restored a button
// whose index pointed into a registry that had since been rebuilt: Copy did
// nothing, or copied some other block's text.
//
// The page has no DOM harness (there is no jsdom in this repo), so this reads
// the shipped inline script as text, one function at a time — the same pattern
// as ui-step-output.test.ts. The rest of the behaviour is the browser test's.

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

describe("the Result block's Copy button indexes the current payloads", () => {
  it("keeps no rendered Result markup between renders", () => {
    assert.ok(
      !UI.includes("_runResultHtml"),
      "a cached Result block carries a data-copy-idx from a registry that has since been emptied"
    );
  });

  it("registers its copy payload every time it builds the block", () => {
    assert.match(
      fnSource("fillRunResult"),
      /copyButton\(source/u,
      "the Result block no longer registers its text, so its Copy button has nothing to copy"
    );
  });

  it("every render that empties the payloads also refills the Result", () => {
    const render = fnSource("renderRunDetail");
    const reset = render.indexOf("_copyPayloads = [];");
    const fill = render.indexOf("fillRunResult(session, snapshot, body)");
    assert.notEqual(reset, -1, "renderRunDetail no longer resets the copy payloads");
    assert.notEqual(fill, -1, "renderRunDetail no longer refills the Result");
    assert.ok(reset < fill, "the Result is filled before the registry it registers into is reset");
  });
});
