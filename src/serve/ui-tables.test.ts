// Tests for the page's table row renderers (spec 037 FR-008, V3).
//
// Two things are load-bearing here and neither needs a DOM: which actions a row
// offers (a bundled workflow is forked before it is edited, and cannot be
// deleted) and that every field the rows newly render — description, steps,
// inputs, layer, exportedAt — is escaped.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  emptyRunsMessage,
  resolveRunsFilter,
  progressCell,
  runProgress,
  runRow,
  terminalStepId,
  workflowRow,
} from "./ui-tables.js";

const HOSTILE = '<img src=x onerror=alert(1)>"';

describe("terminalStepId — the step whose output is the run's answer (042 D17)", () => {
  it("picks the one step nothing depends on", () => {
    assert.equal(
      terminalStepId([
        { id: "radius" },
        { id: "correctness", dependsOn: ["radius"] },
        { id: "verify", dependsOn: ["correctness"] },
        { id: "synthesis", dependsOn: ["verify"] },
      ]),
      "synthesis"
    );
  });

  it("refuses to guess when a pipeline has two sinks", () => {
    assert.equal(
      terminalStepId([{ id: "a" }, { id: "b", dependsOn: ["a"] }, { id: "c", dependsOn: ["a"] }]),
      null,
      "two possible answers means the run has no single one to show"
    );
  });

  it("ignores Mastra's synthetic merge steps", () => {
    assert.equal(
      terminalStepId([
        { id: "a" },
        { id: "__merge_level_0", dependsOn: ["a"] },
        { id: "b", dependsOn: ["a"] },
      ]),
      "b"
    );
  });

  it("has no answer for an empty pipeline", () => {
    assert.equal(terminalStepId([]), null);
    assert.equal(terminalStepId(undefined), null);
  });
});

describe("workflowRow — actions follow the row's own layer (038 D14/D15)", () => {
  it("a repository row offers Run…, Edit and Delete", () => {
    const html = workflowRow({ id: "investigate", layer: "repo" });
    for (const label of ["Run…", "Edit", "Delete"]) {
      assert.ok(html.includes(`>${label}<`), `a repository row must offer ${label}: ${html}`);
    }
    assert.ok(html.includes('data-del-wf="investigate"'));
    assert.ok(!html.includes(">Fork…<"), "a workflow already in a writable layer needs no fork");
  });

  // The name is the way into a workflow, so a View button beside it said the
  // same thing twice; the link has to carry that job on its own now.
  it("the name links to the workflow, and no separate View button remains", () => {
    const html = workflowRow({ id: "investigate", layer: "repo" });
    assert.ok(
      html.includes('href="#/workflows/investigate"'),
      `the name must open the workflow: ${html}`
    );
    assert.ok(!html.includes(">View<"), `View duplicated the name link: ${html}`);
  });

  it("escapes an id inside the name link's href as well as its text", () => {
    const html = workflowRow({ id: HOSTILE, layer: "repo" });
    assert.ok(!html.includes("<img"), `raw markup must not reach the row: ${html}`);
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

describe("runProgress — where a run has got to (spec 042 D7, V3)", () => {
  const DECLARED = ["survey", "plan", "build", "verify"];

  it("names the running step and its position among the declared steps", () => {
    const progress = runProgress(
      {
        survey: {
          status: "succeeded",
          startedAt: "2026-09-21T10:00:00.000Z",
          finishedAt: "2026-09-21T10:01:00.000Z",
        },
        plan: { status: "running", startedAt: "2026-09-21T10:01:00.000Z" },
      },
      DECLARED
    );
    assert.deepEqual(progress, { stepId: "plan", current: true, n: 2, m: 4 });
  });

  it("never names a __merge_level_* step as the current step (V3)", () => {
    const progress = runProgress(
      {
        survey: {
          status: "succeeded",
          startedAt: "2026-09-21T10:00:00.000Z",
          finishedAt: "2026-09-21T10:01:00.000Z",
        },
        __merge_level_1: { status: "running", startedAt: "2026-09-21T10:01:00.000Z" },
      },
      DECLARED
    );
    assert.ok(progress, "a run with one finished step has progress to report");
    assert.equal(
      progress.stepId,
      "survey",
      "a synthetic merge step is Mastra bookkeeping — showing it tells the operator nothing"
    );
    assert.equal(progress.current, false, "nothing the author declared is running right now");
  });

  it("never counts a __merge_level_* step toward M (V3)", () => {
    const progress = runProgress(
      {
        survey: {
          status: "succeeded",
          startedAt: "2026-09-21T10:00:00.000Z",
          finishedAt: "2026-09-21T10:01:00.000Z",
        },
        __merge_level_1: {
          status: "succeeded",
          startedAt: "2026-09-21T10:01:00.000Z",
          finishedAt: "2026-09-21T10:01:01.000Z",
        },
        plan: { status: "running", startedAt: "2026-09-21T10:01:01.000Z" },
      },
      DECLARED
    );
    assert.ok(progress);
    assert.equal(progress.m, 4, "M is the pipeline's own declared step count");
    assert.equal(progress.n, 2, "N is the declared position of plan, unshifted by the merge step");
    assert.ok(
      !JSON.stringify(progress).includes("__merge_level"),
      `no synthetic id may reach the row: ${JSON.stringify(progress)}`
    );
  });

  it("falls back to the last step to finish when none is running", () => {
    const progress = runProgress(
      {
        survey: {
          status: "succeeded",
          startedAt: "2026-09-21T10:00:00.000Z",
          finishedAt: "2026-09-21T10:01:00.000Z",
        },
        plan: {
          status: "succeeded",
          startedAt: "2026-09-21T10:01:00.000Z",
          finishedAt: "2026-09-21T10:02:00.000Z",
        },
      },
      DECLARED
    );
    assert.ok(progress);
    assert.equal(progress.stepId, "plan");
    assert.equal(progress.current, false);
  });

  it("keeps the step id but drops the position when the pipeline no longer declares it", () => {
    const progress = runProgress({ gone: { status: "running" } }, DECLARED);
    assert.deepEqual(progress, { stepId: "gone", current: true, n: null, m: 4 });
    assert.equal(progressCell(progress), '<span class="step-id">gone</span>');
  });

  it("is null before any step has fired", () => {
    assert.equal(runProgress({}, DECLARED), null);
    assert.equal(runProgress({ __merge_level_1: { status: "running" } }, DECLARED), null);
  });

  it("renders into the run row and escapes the step id", () => {
    const html = runRow(
      {
        runId: "r1",
        pipelineId: "investigate",
        status: "running",
        createdAt: "2026-09-21T10:00:00.000Z",
      },
      { progress: { stepId: HOSTILE, current: true, n: 2, m: 4 } }
    );
    assert.ok(html.includes("2 of 4"), `the row must carry the position: ${html}`);
    assert.ok(!html.includes("<img"), `raw markup must not reach the row: ${html}`);
  });
});

describe("emptyRunsMessage — an empty list invites an action (spec 042 FR-006, V5)", () => {
  it("every chip's empty state names the next move", () => {
    for (const filter of ["active", "finished", "all"]) {
      const msg = emptyRunsMessage(filter);
      assert.match(
        msg,
        /href="#\/workflows"/u,
        `the ${filter} empty state must point somewhere: ${msg}`
      );
      assert.ok(msg.length > 20, `a bare "nothing here" is the state FR-006 forbids: ${msg}`);
    }
  });

  it("says which list is empty, not just that something is", () => {
    assert.match(emptyRunsMessage("active"), /Nothing is running/u);
    assert.match(emptyRunsMessage("finished"), /No run has finished/u);
    assert.match(emptyRunsMessage("all"), /No runs on record/u);
  });
});

describe("resolveRunsFilter — the lit chip owns the rows under it (spec 042 D24)", () => {
  it("leaves the default on In flight while anything is in flight", () => {
    assert.equal(resolveRunsFilter("active", { activeCount: 1 }), "active");
  });

  it("resolves the default to All once nothing is in flight", () => {
    // The bug this replaces: In flight stayed lit over a list of finished runs.
    assert.equal(resolveRunsFilter("active", { activeCount: 0 }), "all");
  });

  it("never overrides a chip the operator clicked", () => {
    assert.equal(resolveRunsFilter("active", { activeCount: 0, pinned: true }), "active");
    assert.equal(resolveRunsFilter("finished", { activeCount: 0 }), "finished");
    assert.equal(resolveRunsFilter("all", { activeCount: 3 }), "all");
  });
});
