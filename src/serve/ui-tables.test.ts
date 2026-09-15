// Tests for the page's table row renderers (spec 037 FR-008, V3).
//
// Two things are load-bearing here and neither needs a DOM: which actions a row
// offers (a bundled workflow cannot be edited or deleted) and that every field
// the rows newly render — description, steps, inputs, exportedAt — is escaped.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { runRow, templateRow, workflowRow } from "./ui-tables.js";

const HOSTILE = '<img src=x onerror=alert(1)>"';

describe("workflowRow — actions follow the row's own source (FR-008)", () => {
  it("a project row offers Run…, View, Edit and Delete", () => {
    const html = workflowRow({ id: "investigate", source: "project" });
    for (const label of ["Run…", "View", "Edit", "Delete"]) {
      assert.ok(html.includes(`>${label}<`), `a project row must offer ${label}: ${html}`);
    }
    assert.ok(html.includes('data-del-wf="investigate"'));
  });

  it("a bundled row offers Install and never Edit or Delete", () => {
    const html = workflowRow({ id: "investigate", source: "bundled" });
    assert.ok(html.includes(">Install<"), "a bundled row must offer Install");
    assert.ok(!html.includes(">Edit<"), "a bundled workflow is read-only");
    assert.ok(!html.includes(">Delete<"), "a bundled workflow cannot be deleted");
  });

  it("renders the description, step count and declared inputs", () => {
    const html = workflowRow({
      id: "cycle",
      description: "Plan and build",
      steps: 7,
      inputs: ["task", "plan"],
      source: "project",
    });
    assert.ok(html.includes("Plan and build"));
    assert.ok(html.includes(">7<"), `the step count must be shown: ${html}`);
    assert.ok(html.includes("task, plan"), "inputs are comma-separated");
  });

  it("escapes id, description and inputs", () => {
    const html = workflowRow({
      id: HOSTILE,
      description: HOSTILE,
      steps: 1,
      inputs: [HOSTILE],
      source: "project",
    });
    assert.ok(!html.includes("<img"), `raw markup must not reach the row: ${html}`);
    assert.ok(html.includes("&lt;img src=x onerror=alert(1)&gt;&quot;"));
  });
});

describe("templateRow — bundled and saved sections (FR-008)", () => {
  it("a bundled template offers Preview and Install", () => {
    const html = templateRow({ section: "bundled", id: "cycle", description: "d", steps: 3 });
    assert.ok(html.includes(">Preview<"));
    assert.ok(html.includes('data-install-bundled="cycle"'));
    assert.ok(!html.includes(">Delete<"), "the shipped catalogue cannot be deleted from the page");
  });

  it("a saved template shows exportedAt and offers Preview, Install and Delete", () => {
    const html = templateRow({
      section: "yours",
      templateId: "mine",
      sourcePipeline: "cycle",
      exportedAt: "2026-09-14T10:00:00.000Z",
    });
    assert.ok(html.includes("2026-09-14T10:00:00.000Z"), "exportedAt is shown");
    for (const label of ["Preview", "Install", "Delete"]) {
      assert.ok(html.includes(`>${label}<`), `a saved template must offer ${label}`);
    }
  });

  it("escapes description and inputs on a bundled row", () => {
    const html = templateRow({
      section: "bundled",
      id: HOSTILE,
      description: HOSTILE,
      inputs: [HOSTILE],
      steps: 2,
    });
    assert.ok(!html.includes("<img"), `raw markup must not reach the row: ${html}`);
  });

  it("escapes templateId, sourcePipeline and exportedAt on a saved row", () => {
    const html = templateRow({
      section: "yours",
      templateId: HOSTILE,
      sourcePipeline: HOSTILE,
      exportedAt: HOSTILE,
    });
    assert.ok(!html.includes("<img"), `raw markup must not reach the row: ${html}`);
    assert.equal(
      html.split("&lt;img src=x onerror=alert(1)&gt;&quot;").length - 1,
      7,
      "templateId in the row hook, its cell and three button attributes, plus sourcePipeline and exportedAt"
    );
  });
});

describe("runRow — unchanged behaviour, including the disk badge", () => {
  it("renders the status, pipeline id and a Details action", () => {
    const html = runRow({
      runId: "r1",
      pipelineId: "investigate",
      status: "running",
      createdAt: new Date().toISOString(),
    });
    assert.ok(html.includes('data-run-row="r1"'));
    assert.ok(html.includes('class="badge running"'));
    assert.ok(html.includes('data-run-details="r1"'));
  });

  it("marks a run restored from disk and a selected row", () => {
    const html = runRow(
      { runId: "r1", status: "succeeded", createdAt: "2026-09-14T10:00:00.000Z", source: "disk" },
      { selected: true }
    );
    assert.ok(html.includes(">disk<"), "a persisted run says so in the row");
    assert.ok(html.includes('class="selected"'));
    assert.ok(html.includes("—"), "a run with no settledAt shows no duration");
  });

  it("gives a cancelled run its own badge class, not the failed one", () => {
    const html = runRow({
      runId: "r1",
      pipelineId: "investigate",
      status: "cancelled",
      createdAt: "2026-09-14T10:00:00.000Z",
    });
    assert.ok(
      html.includes('class="badge cancelled"'),
      `a cancelled run must reach the .badge.cancelled rule: ${html}`
    );
  });

  it("escapes the run id, pipeline id and status", () => {
    const html = runRow({ runId: HOSTILE, pipelineId: HOSTILE, status: HOSTILE });
    assert.ok(!html.includes("<img"), `raw markup must not reach the row: ${html}`);
  });
});
