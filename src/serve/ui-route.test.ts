// Tests for the served page's hash router (spec 034 V2/FR-001).
//
// The router is the one piece of page logic that can be tested without a
// browser, so it carries the whole of FR-001's route table.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_VIEW, hashFor, parseHash, pollersFor } from "./ui-route.js";

describe("parseHash — route table (FR-001)", () => {
  it("falls back to the runs view for no hash, a bare '#', and unknown routes", () => {
    for (const hash of ["", "#", "#/", "#/nope", "#/runs-old", "#/settings/extra/deep", "/"]) {
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
    assert.deepEqual(parseHash("#/templates"), { view: "templates" });
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
  });
});

describe("pollersFor — the runs poller is view-gated (spec 037 D9/FR-010)", () => {
  it("allows the runs poller only on the runs list", () => {
    assert.deepEqual(pollersFor("runs"), ["runs"]);
  });

  it("leaves every other view idle, including the run details", () => {
    for (const view of ["run", "workflows", "templates", "settings", "nope"]) {
      assert.deepEqual(pollersFor(view), [], `view ${view} must poll nothing`);
    }
  });
});
