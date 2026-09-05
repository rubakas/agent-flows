import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GraphError } from "./graph.js";
import { expandNested } from "./nest.js";
import type { LoadedPipeline, StepDef } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePipeline(
  id: string,
  steps: StepDef[],
  prompts: Record<string, string> = {}
): LoadedPipeline {
  return {
    def: { id, version: 1, description: "test", inputs: [], steps },
    prompts,
  };
}

function neverResolve(id: string): never {
  throw new Error(`resolve must not be called; got "${id}"`);
}

// ---------------------------------------------------------------------------
// expandNested
// ---------------------------------------------------------------------------

describe("expandNested", () => {
  it("returns the input unchanged (same reference) when no steps have kind pipeline", () => {
    const loaded = makePipeline("parent", [{ id: "a", kind: "llm", role: "worker" }], {
      a: "prompt text",
    });
    const result = expandNested(loaded, neverResolve);
    assert.strictEqual(result, loaded);
  });

  it("expands a single nested pipeline: ids namespaced, edges rewired, prompts re-keyed", () => {
    // inner: x (entry) -> y (terminal)
    // parent: a -> n[pipeline:inner] -> b
    // expected: a -> n.x -> n.y -> b
    const inner = makePipeline(
      "inner",
      [
        { id: "x", kind: "llm", role: "worker" },
        { id: "y", kind: "llm", role: "worker", dependsOn: ["x"] },
      ],
      { x: "prompt x", y: "prompt y" }
    );
    const parent = makePipeline(
      "parent",
      [
        { id: "a", kind: "llm", role: "worker" },
        { id: "n", kind: "pipeline", pipeline: "inner", dependsOn: ["a"] },
        { id: "b", kind: "llm", role: "worker", dependsOn: ["n"] },
      ],
      { a: "prompt a" }
    );

    const result = expandNested(parent, (id) => {
      assert.equal(id, "inner");
      return inner;
    });

    assert.deepEqual(
      result.def.steps.map((s) => s.id),
      ["a", "n.x", "n.y", "b"]
    );
    // n.x is entry: inherits n's dependsOn
    assert.deepEqual(result.def.steps[1].dependsOn, ["a"]);
    // n.y is internal: namespaced edge
    assert.deepEqual(result.def.steps[2].dependsOn, ["n.x"]);
    // b was depending on n (nesting step): rewired to n.y (terminal)
    assert.deepEqual(result.def.steps[3].dependsOn, ["n.y"]);
    // prompts re-keyed; parent prompt preserved
    assert.deepEqual(result.prompts, {
      a: "prompt a",
      "n.x": "prompt x",
      "n.y": "prompt y",
    });
  });

  it("entry steps with no nesting-step dependsOn have no dependsOn after expansion", () => {
    // parent has pipeline step n with NO dependsOn; inner has entry step x
    const inner = makePipeline("inner", [{ id: "x", kind: "llm", role: "worker" }]);
    const parent = makePipeline("parent", [{ id: "n", kind: "pipeline", pipeline: "inner" }]);

    const result = expandNested(parent, () => inner);
    assert.equal(result.def.steps.length, 1);
    assert.equal(result.def.steps[0].id, "n.x");
    assert.equal(result.def.steps[0].dependsOn, undefined);
  });

  it("expands two levels of nesting (A nests B nests C)", () => {
    // C: p (leaf)
    // B: q (pipeline:C)
    // A: n (pipeline:B)
    // expected result: n.q.p
    const pC = makePipeline("C", [{ id: "p", kind: "llm", role: "worker" }]);
    const pB = makePipeline("B", [{ id: "q", kind: "pipeline", pipeline: "C" }]);
    const pA = makePipeline("A", [{ id: "n", kind: "pipeline", pipeline: "B" }]);

    const resolve = (id: string): LoadedPipeline => {
      if (id === "B") return pB;
      if (id === "C") return pC;
      throw new Error(`unexpected: ${id}`);
    };

    const result = expandNested(pA, resolve);
    assert.deepEqual(
      result.def.steps.map((s) => s.id),
      ["n.q.p"]
    );
  });

  it("throws GraphError with the cycle chain when a direct cycle is detected", () => {
    // A nests B, B nests A
    const pA = makePipeline("A", [{ id: "s", kind: "pipeline", pipeline: "B" }]);
    const pB = makePipeline("B", [{ id: "t", kind: "pipeline", pipeline: "A" }]);

    const resolve = (id: string): LoadedPipeline => {
      if (id === "A") return pA;
      if (id === "B") return pB;
      throw new Error(`unexpected: ${id}`);
    };

    assert.throws(
      () => expandNested(pA, resolve),
      (err: unknown) => {
        assert.ok(err instanceof GraphError, "should be GraphError");
        assert.ok(
          err.message.startsWith("cycle detected in nested pipelines:"),
          `unexpected message: ${String(err)}`
        );
        assert.ok(err.message.includes("A"), "chain names A");
        assert.ok(err.message.includes("B"), "chain names B");
        return true;
      }
    );
  });

  it("throws GraphError when nesting depth exceeds maxDepth", () => {
    // A -> B -> C; with maxDepth:2, expanding C (depth=2) throws
    const pA = makePipeline("A", [{ id: "n", kind: "pipeline", pipeline: "B" }]);
    const pB = makePipeline("B", [{ id: "n", kind: "pipeline", pipeline: "C" }]);
    const pC = makePipeline("C", [{ id: "n", kind: "pipeline", pipeline: "D" }]);
    const pD = makePipeline("D", [{ id: "x", kind: "llm", role: "worker" }]);

    const resolve = (id: string): LoadedPipeline => {
      if (id === "B") return pB;
      if (id === "C") return pC;
      if (id === "D") return pD;
      throw new Error(`unexpected: ${id}`);
    };

    assert.throws(
      () => expandNested(pA, resolve, { maxDepth: 2 }),
      (err: unknown) => {
        assert.ok(err instanceof GraphError, "should be GraphError");
        assert.ok(err.message.includes("max depth"), `unexpected message: ${String(err)}`);
        return true;
      }
    );
  });

  it("keeps a loop step intact in the step list and stores its resolved body in bodies", () => {
    // parent: loop step L with body pipeline B
    // expected: L remains in step list, bodies["L"] = expanded B
    const body = makePipeline("B", [{ id: "x", kind: "llm", role: "worker" }], { x: "prompt x" });
    const parent = makePipeline("parent", [
      {
        id: "L",
        kind: "loop",
        pipeline: "B",
        maxIterations: 3,
        until: "passed",
      },
    ]);

    const result = expandNested(parent, (id) => {
      assert.equal(id, "B");
      return body;
    });

    // The loop step L must remain as-is in the step list.
    assert.equal(result.def.steps.length, 1);
    assert.equal(result.def.steps[0].id, "L");
    assert.equal(result.def.steps[0].kind, "loop");
    assert.equal(result.def.steps[0].maxIterations, 3);
    assert.equal(result.def.steps[0].until, "passed");
    // The body must be resolved and stored.
    assert.ok(result.bodies, "bodies map should be set");
    assert.ok("L" in result.bodies, "bodies should contain key L");
    assert.equal(result.bodies.L.def.id, "B");
  });

  it("expands a plain pipeline step inside a loop body", () => {
    // inner: a plain nested pipeline step inside the loop body
    // loop body B contains: n (pipeline:inner), where inner has step x
    // after expand: B's bodies["L"] has steps [n.x], not [n]
    const inner = makePipeline("inner", [{ id: "x", kind: "llm", role: "worker" }], {
      x: "prompt x",
    });
    const body = makePipeline("B", [{ id: "n", kind: "pipeline", pipeline: "inner" }]);
    const parent = makePipeline("parent", [
      { id: "L", kind: "loop", pipeline: "B", maxIterations: 2, until: "done" },
    ]);

    const resolve = (id: string): LoadedPipeline => {
      if (id === "B") return body;
      if (id === "inner") return inner;
      throw new Error(`unexpected: ${id}`);
    };

    const result = expandNested(parent, resolve);

    assert.ok(result.bodies?.L, "loop body L must be resolved");
    const resolvedBody = result.bodies?.L;
    // The pipeline step inside the body should have been expanded to n.x
    assert.deepEqual(
      resolvedBody.def.steps.map((s) => s.id),
      ["n.x"]
    );
  });

  it("throws GraphError with the cycle chain when a loop body references its own pipeline", () => {
    // pipeline A has a loop step whose body is A itself
    const pA = makePipeline("A", [
      { id: "loopStep", kind: "loop", pipeline: "A", maxIterations: 3, until: "done" },
    ]);

    assert.throws(
      () => expandNested(pA, () => pA),
      (err: unknown) => {
        assert.ok(err instanceof GraphError, "should be GraphError");
        assert.ok(
          err.message.startsWith("cycle detected in nested pipelines:"),
          `unexpected message: ${String(err)}`
        );
        assert.ok(err.message.includes("A"), "chain names A");
        return true;
      }
    );
  });

  it("preserves all non-id fields (role, timeoutMs, message, workspace) on expanded steps", () => {
    const inner = makePipeline("inner", [
      {
        id: "s",
        kind: "llm",
        role: "reasoner",
        timeoutMs: 5000,
        message: "custom message",
        workspace: "read",
      },
    ]);
    const parent = makePipeline("parent", [{ id: "n", kind: "pipeline", pipeline: "inner" }]);

    const result = expandNested(parent, () => inner);
    const step = result.def.steps[0];

    assert.deepEqual(step.id, "n.s");
    assert.deepEqual(step.kind, "llm");
    assert.deepEqual(step.role, "reasoner");
    assert.deepEqual(step.timeoutMs, 5000);
    assert.deepEqual(step.message, "custom message");
    assert.deepEqual(step.workspace, "read");
    // pipeline field must NOT be present on the expanded step
    assert.equal("pipeline" in step ? step.pipeline : undefined, undefined);
  });
});
