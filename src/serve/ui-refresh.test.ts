// Refresh has to refresh what is on the screen.
//
// The button called loadRuns() and nothing else, so it redrew the runs table
// and left the daemons panel above it and the run detail pane beside it showing
// a moment that had already passed — the owner clicked it and saw a stale
// screen report itself as refreshed.
//
// The page has no DOM harness (there is no jsdom in this repo), so this reads
// the shipped inline script as text, one function at a time — the same pattern
// as ui-step-output.test.ts.

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

describe("Refresh refreshes the whole runs view", () => {
  it("is wired to the handler that refreshes the view, not to the list loader", () => {
    const anchor = UI.indexOf('getElementById("btn-refresh-runs").onclick');
    assert.notEqual(anchor, -1, "nothing wires the Refresh button");
    const wiring = UI.slice(anchor, anchor + 160);
    assert.match(
      wiring,
      /refreshRunsView\(\)/u,
      "Refresh still calls the runs-list loader alone, so the rest of the screen stays stale"
    );
  });

  it("reaches the list, the daemons panel and an open run's detail pane", () => {
    const refresh = fnSource("refreshRunsView");
    assert.match(refresh, /loadRuns\(/u, "the runs list is not refreshed");
    assert.match(refresh, /loadDaemons\(/u, "the daemons panel keeps whatever it last showed");
    assert.match(
      refresh,
      /refreshRunSnapshot\(/u,
      "an open run's detail pane keeps whatever it last showed"
    );
  });

  it("refreshes through the existing loaders instead of fetching for itself", () => {
    const refresh = fnSource("refreshRunsView");
    assert.ok(
      !/\bfetch\(|\bapi[A-Za-z]*\(|new EventSource\(/u.test(refresh),
      "the handler issues its own requests; it must reuse the loaders that already route them"
    );
  });

  it("says it is working while its requests are in flight", () => {
    const refresh = fnSource("refreshRunsView");
    assert.match(refresh, /disabled = true/u, "the button gives no sign that it did anything");
    assert.match(
      refresh,
      /finally \{[\s\S]*disabled = false/u,
      "a failed refresh would leave the button disabled for good"
    );
  });
});

describe("the poller keeps the daemons panel alive while a run streams", () => {
  it("refreshes daemons before the early return the open stream takes", () => {
    const poller = fnSource("startRunsPoller");
    const daemons = poller.indexOf("loadDaemons()");
    const bail = poller.search(/if \(activeRunEs !== null\) return;/u);
    assert.notEqual(daemons, -1, "the poller never refreshes the daemons panel");
    assert.notEqual(bail, -1, "the poller no longer skips work while a stream is open");
    assert.ok(
      daemons < bail,
      "the open stream drives the runs list and the detail pane, not the daemons panel — " +
        "returning before loadDaemons() freezes it for as long as the run is open"
    );
  });
});

describe("a re-render keeps the outputs the operator opened", () => {
  it("renderRunDetail reads the expanded ids before it wipes the body", () => {
    const render = fnSource("renderRunDetail");
    const capture = render.indexOf("expandedOutputStepIds(body)");
    const wipe = render.indexOf("body.innerHTML = html;");
    assert.notEqual(capture, -1, "nothing records which outputs were open");
    assert.notEqual(wipe, -1, "renderRunDetail no longer writes the body");
    assert.ok(capture < wipe, "the ids are read after the rows holding them are gone");
    assert.match(
      render,
      /restoreExpandedOutputs\(body, runId, expanded\)/u,
      "the expanded outputs are recorded and never re-opened"
    );
  });

  it("the restore re-opens through loadFullOutput, so a cached output costs no request", () => {
    const restore = fnSource("restoreExpandedOutputs");
    assert.match(restore, /loadFullOutput\(el, runId\)/u, "the full text is never fetched back");
    assert.match(restore, /classList\.add\("expanded"\)/u, "the block is filled but stays clamped");
  });
});
