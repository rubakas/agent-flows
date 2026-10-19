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

describe("the poller asks one question — what is allowed to poll right now", () => {
  /** The visibilitychange handler, from its registration to the end of the call. */
  function visibilityHandler(): string {
    const start = UI.indexOf('addEventListener("visibilitychange"');
    assert.notEqual(start, -1, "nothing reacts to the tab being hidden or shown");
    return UI.slice(start, UI.indexOf("});", start));
  }

  /** route() runs to the hashchange listener below it; it is the last function there. */
  function routeSource(): string {
    const start = UI.indexOf("function route(");
    const end = UI.indexOf('window.addEventListener("hashchange"', start);
    assert.ok(start !== -1 && end > start, "cannot find where route() ends");
    return UI.slice(start, end);
  }

  it("currentPollers reads the view, the layout and the tab's visibility", () => {
    const source = fnSource("currentPollers");
    assert.match(source, /pollersFor\(/u, "the answer does not come from the route table");
    assert.match(source, /parseHash\(location\.hash\)\.view/u, "the view on screen is not read");
    assert.match(
      source,
      /wide: WIDE\.matches/u,
      "the layout is not read: a split view is never polled"
    );
    assert.match(source, /hidden: document\.hidden/u, "a hidden tab would be polled");
  });

  it("the interval polls the daemons panel and the list, behind that question", () => {
    const poller = fnSource("startRunsPoller");
    const gate = poller.indexOf('currentPollers().includes("runs")');
    assert.notEqual(gate, -1, "the interval polls whatever the screen shows");
    assert.ok(poller.indexOf("loadDaemons()") > gate, "the daemons panel is not refreshed");
    assert.ok(poller.indexOf("loadRuns()") > gate, "the runs list is not refreshed");
  });

  it("the visibility handler and the router ask it too, instead of testing the view themselves", () => {
    assert.match(visibilityHandler(), /currentPollers\(\)\.includes\("runs"\)/u);
    assert.match(routeSource(), /currentPollers\(\)\.includes\("runs"\)/u);
    for (const [where, source] of [
      ["the interval", fnSource("startRunsPoller")],
      ["the visibility handler", visibilityHandler()],
      ["the router's poller start", routeSource()],
    ] as const) {
      assert.ok(
        !/pollersFor\(|document\.hidden/u.test(source),
        `${where} decides what to poll by itself instead of asking currentPollers()`
      );
    }
  });

  it("returning to a visible tab polls at once, not at the next tick", () => {
    const handler = visibilityHandler();
    assert.match(handler, /startRunsPoller\(\)/u, "the interval is not restarted");
    assert.match(handler, /loadDaemons\(\)/u, "the daemons panel waits for the next tick");
    assert.match(handler, /loadRuns\(\)/u, "the list waits for the next tick");
  });

  it("does not wait on a stream: the list is not driven by one", () => {
    assert.ok(
      !/activeRunEs|streamState/u.test(fnSource("startRunsPoller") + visibilityHandler()),
      "the poller still skips work for a stream that cannot be open while the list is on screen"
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
      /restoreExpandedOutputs\(body, session, expanded\)/u,
      "the expanded outputs are recorded and never re-opened"
    );
  });

  it("the restore re-opens through loadFullOutput, so a cached output costs no request", () => {
    const restore = fnSource("restoreExpandedOutputs");
    assert.match(restore, /loadFullOutput\(el, session\)/u, "the full text is never fetched back");
    assert.match(restore, /classList\.add\("expanded"\)/u, "the block is filled but stays clamped");
  });
});
