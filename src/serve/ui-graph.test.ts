// Tests for the levels diagram (spec 037 D7/FR-007, V3).
//
// The diagram is generated from the same levelling the binder runs, so what it
// has to be held to is structural: one box per step, one line per dependsOn,
// the gate/loop/unreachable markers, and — because step ids come from YAML in
// the checkout — escaping on every id that reaches the SVG.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { pipelineLevels, pipelineToGraph } from "../canon/graph.js";
import { BOX_W, COL_GAP, renderLevelsSvg } from "./ui-graph.js";

const STEPS = [
  { id: "intake", kind: "llm", role: "scout" },
  { id: "approve", kind: "gate", dependsOn: ["intake"] },
  { id: "work", kind: "loop", pipeline: "cycle", dependsOn: ["approve"] },
  { id: "verify", kind: "check", dependsOn: ["approve"] },
];

function render(steps: typeof STEPS): string {
  return renderLevelsSvg(pipelineLevels(steps), pipelineToGraph(steps), { steps });
}

const count = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

describe("renderLevelsSvg — nodes and edges (FR-007)", () => {
  it("renders one box per step and one line per dependsOn edge", () => {
    const svg = render(STEPS);
    assert.equal(count(svg, "<rect"), STEPS.length, "one rect per step");
    assert.equal(count(svg, "<line"), 3, "one line per dependsOn entry");
    for (const s of STEPS) {
      assert.ok(svg.includes(`data-step="${s.id}"`), `step ${s.id} must carry a data-step hook`);
    }
  });

  it("puts each level in its own column, left to right", () => {
    const svg = render(STEPS);
    const xOf = (id: string): number => {
      const box = svg.slice(svg.indexOf(`data-step="${id}"`));
      return Number(/<rect x="(\d+)"/u.exec(box)![1]);
    };
    assert.ok(xOf("intake") < xOf("approve"), "a dependency sits left of its dependant");
    assert.ok(xOf("approve") < xOf("work"));
    assert.equal(xOf("work"), xOf("verify"), "same level, same column");
  });

  it("the width grows with the level count", () => {
    const widthOf = (svg: string): number => Number(/width="(\d+)"/u.exec(svg)![1]);
    const oneLevel = widthOf(renderLevelsSvg([["a"]], { edges: [] }));
    const threeLevels = widthOf(renderLevelsSvg([["a"], ["b"], ["c"]], { edges: [] }));
    assert.equal(
      threeLevels - oneLevel,
      2 * (BOX_W + COL_GAP),
      "each extra level adds one box plus one gap"
    );
  });

  it("marks the gate box and the loop box carrying a mounted pipeline id", () => {
    const svg = render(STEPS);
    assert.ok(/class="[^"]*kind-gate[^"]*" data-step="approve"/u.test(svg), "gate box is marked");
    assert.ok(/class="[^"]*kind-loop[^"]*" data-step="work"/u.test(svg), "loop box is marked");
    assert.ok(svg.includes("↻ cycle"), "the loop box names the pipeline it mounts");
  });

  it("marks a nested-origin step with its parent prefix", () => {
    const svg = renderLevelsSvg([["cycle.plan"]], { edges: [] });
    assert.ok(svg.includes("in cycle"), "a parent.child id shows the parent as a muted label");
  });

  it("marks a step with no path from a root as unreachable", () => {
    // A self-dependent step has no root to reach it from; the graph module would
    // reject it, but a hand-edited draft can still reach the renderer.
    const svg = renderLevelsSvg([["a"], ["b"]], { edges: [{ from: "b", to: "b" }] });
    assert.ok(/class="[^"]*unreachable[^"]*" data-step="b"/u.test(svg));
    assert.ok(!/class="[^"]*unreachable[^"]*" data-step="a"/u.test(svg), "a is reachable");
  });
});

describe("renderLevelsSvg — escaping (V3/S7)", () => {
  const HOSTILE = '<img onerror=x>"';

  it("escapes a hostile step id in the text node and in data-step", () => {
    const svg = renderLevelsSvg(
      [[HOSTILE]],
      { edges: [] },
      {
        steps: [{ id: HOSTILE, kind: "llm", role: "worker" }],
      }
    );
    assert.ok(!svg.includes("<img"), `raw markup must not reach the svg: ${svg}`);
    assert.ok(svg.includes("&lt;img onerror=x&gt;&quot;"), "the id is entity-escaped");
    assert.equal(count(svg, 'data-step="&lt;img onerror=x&gt;&quot;"'), 1);
  });

  it("escapes the kind/role line and the mounted pipeline id", () => {
    const svg = renderLevelsSvg(
      [["a"]],
      { edges: [] },
      {
        steps: [{ id: "a", kind: "loop", role: HOSTILE, pipeline: HOSTILE }],
      }
    );
    assert.ok(!svg.includes("<img"), `raw markup must not reach the svg: ${svg}`);
    assert.equal(
      count(svg, "&lt;img onerror=x&gt;&quot;"),
      2,
      "role and pipeline are both escaped"
    );
  });

  it("never puts a step id in an href", () => {
    const svg = render(STEPS);
    assert.ok(!svg.includes("href"), "ids land in text nodes and data-step only");
  });
});
