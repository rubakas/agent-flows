// Spec 043 V2/V3/V4 — the box a person decides from.
//
// The load-bearing assertions are the ones about telling the two summaries
// apart (D4) and about the material staying reachable (D6). A summary is model
// output about model output; if the page cannot say which text is which, or
// hides what the text is describing, it has made the gate less trustworthy than
// the bare question it replaced.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { gateBox, structuralSummary } from "./ui-gate.js";

const HOSTILE = '<img src=x onerror=alert(1)>"';

const SPEC = {
  title: "Pin one Node version",
  description: "Declare the version once and derive it everywhere else.",
  requirements: ["engines.node is the source", "the launcher reads it"],
  acceptanceCriteria: ["pnpm refuses a wrong Node"],
  weaknesses: [{ severity: "minor", title: "bootstrap.sh reads a file it may not have" }],
};

describe("gateBox — approve and reject are always reachable (FR-006)", () => {
  const cases: [string, { gateMessage: string; gateSummary?: string; spec?: unknown }][] = [
    ["a model summary", { gateMessage: "Approve?", gateSummary: "It pins Node.", spec: SPEC }],
    ["only a spec", { gateMessage: "Approve?", spec: SPEC }],
    ["neither", { gateMessage: "Commit all staged changes locally?" }],
  ];
  for (const [name, gate] of cases) {
    it(`offers both buttons with ${name}`, () => {
      const html = gateBox(gate);
      assert.ok(html.includes('id="btn-approve-run"'), html);
      assert.ok(html.includes('id="btn-reject-run"'), html);
      assert.ok(html.includes(gate.gateMessage), "the question is never dropped");
    });
  }
});

describe("gateBox — the two summaries are distinguishable (spec 043 D4, V2)", () => {
  it("says a model wrote the summary when one did", () => {
    const html = gateBox({ gateSummary: "It pins the Node version to 22.", spec: SPEC });
    assert.match(html, /written by a model/u, html);
    assert.ok(html.includes("It pins the Node version to 22."), html);
  });

  it("says the fields are the spec's own when no summary was produced", () => {
    const html = gateBox({ spec: SPEC });
    assert.match(html, /the spec's own fields/u, html);
    assert.ok(!html.includes("written by a model"), "nothing may claim a summary that is not one");
  });

  it("a model summary does not hide the fields — they move under the expander", () => {
    const html = gateBox({ gateSummary: "A paragraph.", spec: SPEC });
    assert.ok(html.includes("Pin one Node version"), `the title must survive: ${html}`);
  });
});

describe("gateBox — the material stays one click away (spec 043 D6, V3)", () => {
  it("carries every list of the spec, in full", () => {
    const html = gateBox({ gateSummary: "A paragraph.", spec: SPEC });
    assert.ok(html.includes("<details"), `it must be expandable, not gone: ${html}`);
    assert.ok(html.includes("engines.node is the source"), html);
    assert.ok(html.includes("pnpm refuses a wrong Node"), html);
    assert.ok(html.includes("bootstrap.sh reads a file it may not have"), html);
    assert.ok(html.includes("minor"), "a finding's severity travels with it");
  });

  it("with nothing attached, says what was looked for (FR-005)", () => {
    const html = gateBox({ gateMessage: "Commit all staged changes locally?", gateStepId: "ship" });
    assert.match(html, /no spec payload and no summary/u, html);
    assert.ok(html.includes("ship"), "the gate step is named");
    assert.ok(!html.includes("<details"), `an empty expander is worse than none: ${html}`);
  });
});

describe("gateBox — every field is untrusted (V4)", () => {
  it("escapes the summary, the question and every spec field", () => {
    const html = gateBox({
      gateMessage: HOSTILE,
      gateSummary: HOSTILE,
      gateStepId: HOSTILE,
      spec: {
        title: HOSTILE,
        description: HOSTILE,
        requirements: [HOSTILE],
        weaknesses: [{ severity: HOSTILE, title: HOSTILE, location: HOSTILE }],
      },
    });
    assert.ok(!html.includes("<img"), `raw markup must not reach the box: ${html}`);
    assert.ok(html.includes("&lt;img"), "it must still be readable as text");
  });
});

describe("structuralSummary", () => {
  it("counts only the lists that have something in them", () => {
    const html = structuralSummary(SPEC);
    assert.match(html, /2 requirements/u, html);
    assert.match(html, /1 acceptance criteria/u, html);
    assert.ok(!html.includes("security findings"), `an empty list is not a count: ${html}`);
  });

  it("is empty for a payload with nothing to say, so the caller can tell", () => {
    assert.equal(structuralSummary(undefined), "");
    assert.equal(structuralSummary("a string"), "");
    assert.equal(structuralSummary({}), "");
  });
});
