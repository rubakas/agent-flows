import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  GraphError,
  _computeLevels,
  pipelineAncestors,
  pipelineLevels,
  pipelineToGraph,
} from "./graph.js";

// ---------------------------------------------------------------------------
// pipelineLevels
// ---------------------------------------------------------------------------

describe("pipelineLevels", () => {
  it("returns empty for an empty step list", () => {
    assert.deepEqual(pipelineLevels([]), []);
  });

  it("levels a linear chain into one step per level", () => {
    const steps = [{ id: "a" }, { id: "b", dependsOn: ["a"] }, { id: "c", dependsOn: ["b"] }];
    assert.deepEqual(pipelineLevels(steps), [["a"], ["b"], ["c"]]);
  });

  it("levels a diamond into exactly three levels", () => {
    // a fans out to b and c; both converge on d
    const steps = [
      { id: "a" },
      { id: "b", dependsOn: ["a"] },
      { id: "c", dependsOn: ["a"] },
      { id: "d", dependsOn: ["b", "c"] },
    ];
    assert.deepEqual(pipelineLevels(steps), [["a"], ["b", "c"], ["d"]]);
  });

  it("interleaves two independent chains into the same levels", () => {
    // chain 1: a → b; chain 2: x → y; both start at level 0
    const steps = [
      { id: "a" },
      { id: "x" },
      { id: "b", dependsOn: ["a"] },
      { id: "y", dependsOn: ["x"] },
    ];
    assert.deepEqual(pipelineLevels(steps), [
      ["a", "x"],
      ["b", "y"],
    ]);
  });

  it("levels the spec-creation shape to match today's execution", () => {
    // intake → enrich → {critic, security} → assemble → approve → persist
    const steps = [
      { id: "intake" },
      { id: "enrich", dependsOn: ["intake"] },
      { id: "critic", dependsOn: ["enrich"] },
      { id: "security", dependsOn: ["enrich"] },
      { id: "assemble", dependsOn: ["critic", "security"] },
      { id: "approve", dependsOn: ["assemble"] },
      { id: "persist", dependsOn: ["approve"] },
    ];
    assert.deepEqual(pipelineLevels(steps), [
      ["intake"],
      ["enrich"],
      ["critic", "security"],
      ["assemble"],
      ["approve"],
      ["persist"],
    ]);
  });

  it("throws GraphError on a two-node cycle, naming both members", () => {
    const steps = [
      { id: "a", dependsOn: ["b"] },
      { id: "b", dependsOn: ["a"] },
    ];
    assert.throws(
      () => pipelineLevels(steps),
      (err: unknown) => {
        assert.ok(err instanceof GraphError, "should be GraphError");
        assert.ok(err.message.includes("a"), "message names 'a'");
        assert.ok(err.message.includes("b"), "message names 'b'");
        return true;
      }
    );
  });

  it("throws GraphError on a three-node cycle, naming all members", () => {
    const steps = [
      { id: "a", dependsOn: ["c"] },
      { id: "b", dependsOn: ["a"] },
      { id: "c", dependsOn: ["b"] },
    ];
    assert.throws(
      () => pipelineLevels(steps),
      (err: unknown) => {
        assert.ok(err instanceof GraphError, "should be GraphError");
        assert.ok(err.message.includes("a"), "message names 'a'");
        assert.ok(err.message.includes("b"), "message names 'b'");
        assert.ok(err.message.includes("c"), "message names 'c'");
        return true;
      }
    );
  });

  it("throws GraphError on a self-dependency, naming the step", () => {
    assert.throws(
      () => pipelineLevels([{ id: "a", dependsOn: ["a"] }]),
      (err: unknown) => {
        assert.ok(err instanceof GraphError, "should be GraphError");
        assert.ok(err.message.includes("a"), "message names 'a'");
        return true;
      }
    );
  });

  it("throws GraphError on an unknown dependency id, naming it", () => {
    assert.throws(
      () => pipelineLevels([{ id: "a", dependsOn: ["ghost"] }]),
      (err: unknown) => {
        assert.ok(err instanceof GraphError, "should be GraphError");
        assert.ok(err.message.includes("ghost"), "message names the unknown id");
        return true;
      }
    );
  });

  it("throws GraphError on a duplicate step id, naming it", () => {
    assert.throws(
      () => pipelineLevels([{ id: "a" }, { id: "a" }]),
      (err: unknown) => {
        assert.ok(err instanceof GraphError, "should be GraphError");
        assert.ok(err.message.includes("a"), "message names the duplicate id");
        return true;
      }
    );
  });

  // Defence-in-depth: this test calls _computeLevels directly, bypassing
  // validate(), to confirm the loop guard itself throws rather than spinning
  // when a cycle slips through. The public path cannot reach this branch today
  // (validate() catches every cycle first), but if validate() is ever weakened
  // or reordered the guard keeps the agent-flows serve daemon from hanging instead of
  // failing loudly (see ADR-0014).
  it("_computeLevels guard throws GraphError on a cycle, naming stuck ids (defence-in-depth)", () => {
    const steps = [
      { id: "a", dependsOn: ["b"] },
      { id: "b", dependsOn: ["a"] },
    ];
    assert.throws(
      () => _computeLevels(steps),
      (err: unknown) => {
        assert.ok(err instanceof GraphError, "should be GraphError");
        assert.ok(err.message.includes("a"), "message names 'a'");
        assert.ok(err.message.includes("b"), "message names 'b'");
        return true;
      }
    );
  });
});

// ---------------------------------------------------------------------------
// pipelineAncestors
// ---------------------------------------------------------------------------

describe("pipelineAncestors", () => {
  it("returns an empty ancestor set for a step with no dependencies", () => {
    const result = pipelineAncestors([{ id: "a" }]);
    assert.deepEqual([...result.get("a")!], []);
  });

  it("returns the direct parent as the sole ancestor", () => {
    const steps = [{ id: "a" }, { id: "b", dependsOn: ["a"] }];
    const result = pipelineAncestors(steps);
    assert.deepEqual(result.get("b"), new Set(["a"]));
    assert.deepEqual(result.get("a"), new Set());
  });

  it("returns transitive ancestors for a linear chain", () => {
    const steps = [{ id: "a" }, { id: "b", dependsOn: ["a"] }, { id: "c", dependsOn: ["b"] }];
    const result = pipelineAncestors(steps);
    assert.deepEqual(result.get("a"), new Set());
    assert.deepEqual(result.get("b"), new Set(["a"]));
    assert.deepEqual(result.get("c"), new Set(["a", "b"]));
  });

  it("deduplicates common ancestors in a diamond", () => {
    // a fans out to b and c; both converge on d — a appears once in d's set
    const steps = [
      { id: "a" },
      { id: "b", dependsOn: ["a"] },
      { id: "c", dependsOn: ["a"] },
      { id: "d", dependsOn: ["b", "c"] },
    ];
    const result = pipelineAncestors(steps);
    assert.deepEqual(result.get("d"), new Set(["a", "b", "c"]));
    assert.deepEqual(result.get("b"), new Set(["a"]));
    assert.deepEqual(result.get("c"), new Set(["a"]));
    assert.deepEqual(result.get("a"), new Set());
  });

  it("throws GraphError on a cycle, naming both members", () => {
    const steps = [
      { id: "a", dependsOn: ["b"] },
      { id: "b", dependsOn: ["a"] },
    ];
    assert.throws(
      () => pipelineAncestors(steps),
      (err: unknown) => {
        assert.ok(err instanceof GraphError, "should be GraphError");
        assert.ok(err.message.includes("a"), "message names 'a'");
        assert.ok(err.message.includes("b"), "message names 'b'");
        return true;
      }
    );
  });

  it("throws GraphError on an unknown dependency id, naming it", () => {
    assert.throws(
      () => pipelineAncestors([{ id: "a", dependsOn: ["ghost"] }]),
      (err: unknown) => {
        assert.ok(err instanceof GraphError, "should be GraphError");
        assert.ok(err.message.includes("ghost"), "message names the unknown id");
        return true;
      }
    );
  });
});

// ---------------------------------------------------------------------------
// pipelineToGraph
// ---------------------------------------------------------------------------

describe("pipelineToGraph", () => {
  it("returns empty nodes and edges for an empty step list", () => {
    assert.deepEqual(pipelineToGraph([]), { nodes: [], edges: [] });
  });

  it("maps a linear chain to nodes and directed edges", () => {
    const steps = [{ id: "a" }, { id: "b", dependsOn: ["a"] }, { id: "c", dependsOn: ["b"] }];
    const { nodes, edges } = pipelineToGraph(steps);
    assert.deepEqual(nodes, [{ id: "a" }, { id: "b" }, { id: "c" }]);
    assert.deepEqual(edges, [
      { from: "a", to: "b" },
      { from: "b", to: "c" },
    ]);
  });

  it("maps a diamond to the correct nodes and edges in declaration/dependency order", () => {
    const steps = [
      { id: "a" },
      { id: "b", dependsOn: ["a"] },
      { id: "c", dependsOn: ["a"] },
      { id: "d", dependsOn: ["b", "c"] },
    ];
    const { nodes, edges } = pipelineToGraph(steps);
    assert.deepEqual(nodes, [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }]);
    assert.deepEqual(edges, [
      { from: "a", to: "b" },
      { from: "a", to: "c" },
      { from: "b", to: "d" },
      { from: "c", to: "d" },
    ]);
  });

  it("maps the spec-creation shape without inference", () => {
    const steps = [
      { id: "intake" },
      { id: "enrich", dependsOn: ["intake"] },
      { id: "critic", dependsOn: ["enrich"] },
      { id: "security", dependsOn: ["enrich"] },
      { id: "assemble", dependsOn: ["critic", "security"] },
      { id: "approve", dependsOn: ["assemble"] },
      { id: "persist", dependsOn: ["approve"] },
    ];
    const { nodes, edges } = pipelineToGraph(steps);
    assert.deepEqual(
      nodes.map((n) => n.id),
      ["intake", "enrich", "critic", "security", "assemble", "approve", "persist"]
    );
    assert.deepEqual(edges, [
      { from: "intake", to: "enrich" },
      { from: "enrich", to: "critic" },
      { from: "enrich", to: "security" },
      { from: "critic", to: "assemble" },
      { from: "security", to: "assemble" },
      { from: "assemble", to: "approve" },
      { from: "approve", to: "persist" },
    ]);
  });

  it("throws GraphError on a duplicate step id", () => {
    assert.throws(() => pipelineToGraph([{ id: "a" }, { id: "a" }]), GraphError);
  });

  it("throws GraphError on an unknown dependency id", () => {
    assert.throws(() => pipelineToGraph([{ id: "a", dependsOn: ["ghost"] }]), GraphError);
  });

  it("throws GraphError on a cycle, naming the members", () => {
    const steps = [
      { id: "a", dependsOn: ["b"] },
      { id: "b", dependsOn: ["a"] },
    ];
    assert.throws(
      () => pipelineToGraph(steps),
      (err: unknown) => {
        assert.ok(err instanceof GraphError);
        assert.ok(err.message.includes("a"));
        assert.ok(err.message.includes("b"));
        return true;
      }
    );
  });
});
