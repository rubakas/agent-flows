// Tests for the levels diagram (spec 037 D7/FR-007, V3).
//
// The diagram is generated from the same levelling the binder runs, so what it
// has to be held to is structural: one box per step, one line per dependsOn,
// the gate/loop/unreachable markers, and — because step ids come from YAML in
// the checkout — escaping on every id that reaches the SVG.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { pipelineLevels, pipelineToGraph } from "../canon/graph.js";
import { attachY, BOX_H, BOX_W, COL_GAP, edgePath, renderLevelsSvg } from "./ui-graph.js";

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
  it("renders one box per step and one edge per dependsOn entry", () => {
    const svg = render(STEPS);
    assert.equal(count(svg, "<rect"), STEPS.length, "one rect per step");
    assert.equal(count(svg, '<path class="edge"'), 3, "one edge per dependsOn entry");
    assert.equal(count(svg, "<line"), 0, "edges are routed paths, not diagonals");
    for (const s of STEPS) {
      assert.ok(svg.includes(`data-step="${s.id}"`), `step ${s.id} must carry a data-step hook`);
    }
  });

  // The diagram once drew every edge as a straight line between box edges, so a
  // cross-row edge crossed the column gap at an angle and a two-column one
  // crossed whatever box sat between. The first fix routed right angles but
  // still ran a long edge horizontally at box height, straight through the box
  // it skipped — checking only the vertical segment had missed it. This checks
  // EVERY segment against EVERY box, which is the property that actually
  // matters.
  function segmentsOf(d: string): { x1: number; y1: number; x2: number; y2: number }[] {
    const out: { x1: number; y1: number; x2: number; y2: number }[] = [];
    let x = 0;
    let y = 0;
    for (const m of d.matchAll(/([MHV])(-?[\d.]+)(?: (-?[\d.]+))?/gu)) {
      const [, cmd, a, b] = m;
      const px = x;
      const py = y;
      if (cmd === "M") {
        x = Number(a);
        y = Number(b);
        continue;
      }
      if (cmd === "H") x = Number(a);
      else y = Number(a);
      out.push({ x1: px, y1: py, x2: x, y2: y });
    }
    return out;
  }

  function crossesBox(
    seg: { x1: number; y1: number; x2: number; y2: number },
    box: { x: number; y: number; w: number; h: number }
  ): boolean {
    const [lo, hi] = [Math.min(seg.x1, seg.x2), Math.max(seg.x1, seg.x2)];
    const [top, bot] = [Math.min(seg.y1, seg.y2), Math.max(seg.y1, seg.y2)];
    // Touching an edge is how an arrow arrives; overlapping the interior is the bug.
    return hi > box.x && lo < box.x + box.w && bot > box.y && top < box.y + box.h;
  }

  it("no edge segment ever passes through a box", () => {
    const svg = render(STEPS);
    const boxes = [
      ...svg.matchAll(/<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)"/gu),
    ].map((m) => ({ x: +m[1], y: +m[2], w: +m[3], h: +m[4] }));
    const paths = [...svg.matchAll(/<path class="edge" d="([^"]+)"/gu)].map((m) => m[1]);
    assert.ok(boxes.length > 0 && paths.length > 0, "the fixture must produce boxes and edges");
    for (const d of paths) {
      for (const seg of segmentsOf(d)) {
        for (const box of boxes) {
          assert.ok(
            !crossesBox(seg, box),
            `segment ${JSON.stringify(seg)} of "${d}" runs through box ${JSON.stringify(box)}`
          );
        }
      }
    }
  });

  it("routes a same-height edge as one horizontal segment", () => {
    assert.equal(edgePath({ x: 172, y: 34 }, { x: 220, y: 34 }, 196), "M172 34 H220");
  });

  it("turns at the gutter the caller picked for a next-column edge", () => {
    assert.equal(edgePath({ x: 172, y: 34 }, { x: 220, y: 94 }, 196), "M172 34 H196 V94 H220");
  });

  it("drops a longer span into the lane below, never across the column it skips", () => {
    const d = edgePath({ x: 172, y: 94 }, { x: 428, y: 34 }, 404, 160);
    assert.ok(d.includes("V160"), `a two-column edge must use the lane: ${d}`);
  });

  // Three edges arriving at `verify` all met it at the box's middle, so their
  // three arrowheads stacked into what looked like one and no line could be
  // traced to its target. Each side of a box now spreads its edges out.
  it("spreads the edges on one side of a box to their own heights", () => {
    assert.equal(attachY(12, 0, 1), 34, "a lone edge still meets the middle");
    const three = [attachY(12, 0, 3), attachY(12, 1, 3), attachY(12, 2, 3)];
    assert.equal(new Set(three).size, 3, `three edges need three heights: ${three.join()}`);
    assert.ok(
      three.every((y) => y > 12 && y < 12 + BOX_H),
      `every attachment must stay on the box's side: ${three.join()}`
    );
  });

  it("no two edges arriving at one box share an endpoint", () => {
    const svg = render(STEPS);
    const ends = [...svg.matchAll(/<path class="edge" d="[^"]*?H(-?[\d.]+)"/gu)].map((m) => m[0]);
    const endPoints = [...svg.matchAll(/<path class="edge" d="([^"]+)"/gu)].map((m) => {
      const d = m[1];
      const lastH = [...d.matchAll(/H(-?[\d.]+)/gu)].at(-1)?.[1];
      const lastV = [...d.matchAll(/V(-?[\d.]+)/gu)].at(-1)?.[1];
      const startY = /M-?[\d.]+ (-?[\d.]+)/u.exec(d)?.[1];
      return `${lastH},${lastV ?? startY}`;
    });
    assert.equal(ends.length, endPoints.length);
    assert.equal(
      new Set(endPoints).size,
      endPoints.length,
      `stacked arrowheads read as one: ${endPoints.join(" | ")}`
    );
  });

  it("every edge ends in an arrowhead, so direction needs no tracing", () => {
    const svg = render(STEPS);
    assert.equal(count(svg, 'marker-end="url(#af-arrow)"'), 3);
    assert.ok(svg.includes('<marker id="af-arrow"'), "the marker must be defined once");
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
