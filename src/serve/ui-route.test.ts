// Tests for the served page's hash router (spec 034 V2/FR-001).
//
// The router is the one piece of page logic that can be tested without a
// browser, so it carries the whole of FR-001's route table.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_VIEW, hashFor, parseHash, pathFor, pollersFor, VIEWS } from "./ui-route.js";

describe("parseHash — route table (FR-001)", () => {
  it("falls back to the runs view for no hash, a bare '#', and unknown routes", () => {
    for (const hash of [
      "",
      "#",
      "#/",
      "#/nope",
      "#/runs-old",
      "#/settings/extra/deep",
      "/",
      // The Templates surface was removed; its links are now stale routes.
      "#/templates",
      "#/templates/cycle",
    ]) {
      assert.equal(
        parseHash(hash).view,
        "runs",
        `hash ${JSON.stringify(hash)} must fall back to the default view`
      );
    }
    assert.equal(DEFAULT_VIEW, "runs", "the default view is the runs list");
  });

  it("maps each tab route to its view", () => {
    assert.deepEqual(parseHash("#/runs"), { view: "runs" });
    assert.deepEqual(parseHash("#/workflows"), { view: "workflows" });
    assert.deepEqual(parseHash("#/settings"), { view: "settings" });
  });

  it("extracts the run id from #/runs/<id>", () => {
    assert.deepEqual(parseHash("#/runs/6ec5b59d-277b-43f3-a4ab-3f422fcd4e6b"), {
      view: "run",
      runId: "6ec5b59d-277b-43f3-a4ab-3f422fcd4e6b",
    });
    assert.deepEqual(
      parseHash("#/runs/run%20one"),
      { view: "run", runId: "run one" },
      "a percent-encoded run id must be decoded"
    );
  });

  it("a malformed escape in the run id falls back to the list, not a throw", () => {
    assert.deepEqual(parseHash("#/runs/%E0%A4%A"), { view: "runs" });
  });

  it("accepts a hash with no leading '#' (hashchange gives both forms)", () => {
    assert.deepEqual(parseHash("/workflows"), { view: "workflows" });
  });

  it("hashFor is the inverse used for navigation", () => {
    assert.equal(hashFor("runs"), "#/runs");
    assert.equal(hashFor("settings"), "#/settings");
    assert.equal(hashFor("run", "abc def"), "#/runs/abc%20def");
    assert.equal(parseHash(hashFor("run", "abc def")).runId, "abc def");
    assert.equal(hashFor("workflow", "a b"), "#/workflows/a%20b");
    assert.equal(hashFor("workflow-edit", "a b"), "#/workflows/a%20b/edit");
    for (const view of ["workflow", "workflow-edit"]) {
      const round = parseHash(hashFor(view, "a b"));
      assert.equal(round.view, view, `hashFor(${view}) must parse back to ${view}`);
      assert.equal(round.id, "a b");
    }
  });
});

describe("parseHash — dot-segment run ids are not runs", () => {
  it("treats '.' and '..', plain or percent-encoded, as no run at all", () => {
    // encodeURIComponent leaves dots alone, so such an id would climb out of
    // /api/runs/<id>/… once it is put into a request path.
    for (const hash of ["#/runs/.", "#/runs/..", "#/runs/%2e", "#/runs/%2E%2E", "#/runs/%2e%2E"]) {
      assert.deepEqual(parseHash(hash), { view: "runs" }, `${hash} must fall back to the list`);
    }
  });

  it("still opens ids that merely contain dots", () => {
    assert.deepEqual(parseHash("#/runs/a..b"), { view: "run", runId: "a..b" });
    assert.deepEqual(parseHash("#/runs/..x"), { view: "run", runId: "..x" });
  });
});

describe("parseHash — catalogue detail routes (spec 037 D2/FR-006)", () => {
  it("maps the workflow and editor routes to their views", () => {
    assert.deepEqual(parseHash("#/workflows/investigate"), {
      view: "workflow",
      id: "investigate",
    });
    assert.deepEqual(parseHash("#/workflows/investigate/edit"), {
      view: "workflow-edit",
      id: "investigate",
    });
  });

  it("only 'edit' is a valid third segment; anything else falls back to runs", () => {
    for (const hash of ["#/workflows/investigate/view", "#/workflows/investigate/edit/more"]) {
      assert.equal(parseHash(hash).view, "runs", `${hash} must fall back`);
    }
  });

  it("a malformed escape in a detail id falls back to that route's list", () => {
    assert.deepEqual(parseHash("#/workflows/%E0%A4%A"), { view: "workflows" });
  });

  it("VIEWS names every view parseHash can return", () => {
    for (const hash of [
      "#/runs",
      "#/runs/r1",
      "#/workflows",
      "#/workflows/x",
      "#/workflows/x/edit",
      "#/settings",
    ]) {
      assert.ok(
        VIEWS.includes(parseHash(hash).view),
        `VIEWS must contain the view for ${hash} (${parseHash(hash).view})`
      );
    }
  });
});

describe("pollersFor — the runs poller is view-gated (spec 037 D9/FR-010)", () => {
  it("allows the runs poller on the runs list, whatever the layout", () => {
    assert.deepEqual(pollersFor("runs"), ["runs"]);
    assert.deepEqual(pollersFor("runs", { wide: false }), ["runs"]);
    assert.deepEqual(pollersFor("runs", { wide: true }), ["runs"]);
  });

  it("keeps the list polled beside an open run on a wide screen only", () => {
    assert.deepEqual(pollersFor("run", { wide: true }), ["runs"]);
    assert.deepEqual(pollersFor("run", { wide: false }), []);
    assert.deepEqual(pollersFor("run"), []);
  });

  it("leaves every other view idle, wide or not", () => {
    for (const view of ["workflows", "workflow", "workflow-edit", "settings", "nope"]) {
      for (const wide of [false, true]) {
        assert.deepEqual(
          pollersFor(view, { wide }),
          [],
          `view ${view} (wide ${wide}) polls nothing`
        );
      }
    }
  });

  it("polls nothing at all in a hidden tab", () => {
    for (const view of ["runs", "run", "workflows", "settings"]) {
      for (const wide of [false, true]) {
        assert.deepEqual(
          pollersFor(view, { wide, hidden: true }),
          [],
          `a hidden tab on ${view} (wide ${wide}) must not poll`
        );
      }
    }
  });
});

describe("pathFor — which daemon a request goes to (spec 042 D13)", () => {
  it("leaves this daemon's own paths alone", () => {
    assert.equal(pathFor("", "/api/runs/r1"), "/api/runs/r1");
  });

  it("forwards another project's paths through /api/projects/<key>", () => {
    assert.equal(pathFor("k", "/api/runs/r1"), "/api/projects/k/api/runs/r1");
  });

  it("encodes a key that is itself a path, so it stays one segment", () => {
    assert.equal(pathFor("k/x", "/api/runs"), "/api/projects/k%2Fx/api/runs");
  });
});
