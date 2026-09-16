// Tests for the page's table row renderers (spec 037 FR-008, V3).
//
// Two things are load-bearing here and neither needs a DOM: which actions a row
// offers (a bundled workflow is forked before it is edited, and cannot be
// deleted) and that every field the rows newly render — description, steps,
// inputs, layer, exportedAt — is escaped.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { runRow, templateRow, workflowRow } from "./ui-tables.js";

const HOSTILE = '<img src=x onerror=alert(1)>"';

describe("workflowRow — actions follow the row's own layer (038 D14/D15)", () => {
  it("a repository row offers Run…, View, Edit and Delete", () => {
    const html = workflowRow({ id: "investigate", layer: "repo" });
    for (const label of ["Run…", "View", "Edit", "Delete"]) {
      assert.ok(html.includes(`>${label}<`), `a repository row must offer ${label}: ${html}`);
    }
    assert.ok(html.includes('data-del-wf="investigate"'));
    assert.ok(!html.includes(">Fork…<"), "a workflow already in a writable layer needs no fork");
  });

  it("a bundled row offers Fork… instead of Edit, and never Delete", () => {
    const html = workflowRow({ id: "investigate", layer: "bundled" });
    assert.ok(html.includes('data-fork-wf="investigate"'), "a bundled row must offer Fork…");
    // Edit on a bundled row went through the fork dialog too: one control, not two.
    assert.ok(!html.includes("data-edit-wf"), `Fork… is the only way into the editor: ${html}`);
    assert.ok(!html.includes(">Delete<"), "a bundled workflow cannot be deleted");
    assert.ok(!html.includes(">Install<"), "there is no install any more (038 D16)");
  });

  it("names the owning layer and the layers a row shadows (FR-020)", () => {
    const html = workflowRow({ id: "investigate", layer: "repo", shadows: ["bundled"] });
    assert.ok(html.includes(">repo (shadows bundled)<"), `layer cell: ${html}`);
  });

  it("marks a hidden row and offers Show instead of Hide (FR-026)", () => {
    const hidden = workflowRow({ id: "investigate", layer: "repo", hidden: true });
    assert.ok(hidden.includes(">hidden</span>"), "a hidden row is marked");
    assert.ok(hidden.includes(">Show<"), "a hidden row offers Show");
    const visible = workflowRow({ id: "investigate", layer: "repo" });
    assert.ok(visible.includes(">Hide<"), "a visible row offers Hide");
    assert.ok(!visible.includes(">hidden</span>"), "a visible row carries no hidden mark");
  });

  it("carries the visibility state in a data attribute, not in the button label", () => {
    // The page reads this attribute to decide what a click means; a renamed
    // label must not be able to invert it.
    assert.ok(
      workflowRow({ id: "x", layer: "repo", hidden: true }).includes('data-wf-hidden="true"')
    );
    assert.ok(workflowRow({ id: "x", layer: "repo" }).includes('data-wf-hidden="false"'));
  });

  it("renders the description, step count and declared inputs", () => {
    const html = workflowRow({
      id: "cycle",
      description: "Plan and build",
      steps: 7,
      inputs: ["task", "plan"],
      layer: "repo",
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
      layer: "repo",
    });
    assert.ok(!html.includes("<img"), `raw markup must not reach the row: ${html}`);
    assert.ok(html.includes("&lt;img src=x onerror=alert(1)&gt;&quot;"));
  });
});

describe("templateRow — bundled and saved sections (FR-008)", () => {
  it("a bundled template offers Preview and Export, never Install (038 D16)", () => {
    const html = templateRow({ section: "bundled", id: "cycle", description: "d", steps: 3 });
    assert.ok(html.includes(">Preview<"));
    assert.ok(html.includes('data-export-bundled="cycle"'));
    assert.ok(!html.includes(">Install<"), "install is gone; Templates is import/export only");
    assert.ok(!html.includes(">Delete<"), "the shipped catalogue cannot be deleted from the page");
  });

  it("a saved template shows exportedAt and offers Preview, Import and Delete", () => {
    const html = templateRow({
      section: "yours",
      templateId: "mine",
      sourcePipeline: "cycle",
      exportedAt: "2026-09-14T10:00:00.000Z",
    });
    assert.ok(html.includes("2026-09-14T10:00:00.000Z"), "exportedAt is shown");
    for (const label of ["Preview", "Import", "Delete"]) {
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
