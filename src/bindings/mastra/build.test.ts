// Tests for buildPipelineWorkflow.
//
// Mastra suspend/resume requires file-backed SQLite (LibSQL :memory: creates a
// new connection per Mastra instance so the snapshot table is not shared).
// Each test uses a unique temp file and cleans up on completion.
//
// Registry strategy: CANNED_PIPELINE uses step IDs as model IDs (e.g. model:"intake").
// FAKE_REGISTRY is empty, so ModelRegistry.resolve() uses its passthrough — any unknown
// id becomes { id: <that-id>, transport:"cli", ... }. This means entry.id === step.id
// inside the fake runner, letting CANNED_RESPONSES key by step id cleanly.

import assert from "node:assert/strict";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Mastra } from "@mastra/core/mastra";
import { LibSQLStore } from "@mastra/libsql";
import { ModelRegistry } from "../../canon/registry.js";
import { makeInMemoryDb } from "../../db/index.js";
import { DrizzleTicketStore } from "../../store/sqlite.js";
import { buildPipelineWorkflow, mastraDbPath, validateModelOverrides } from "./build.js";
import type { StepRunnerDeps, runLlmStep } from "../../canon/runStep.js";
import type { LoadedPipeline } from "../../canon/types.js";

// ── Test pipeline fixture ─────────────────────────────────────────────────────

// Each step uses its own id as the model name so that FAKE_REGISTRY's passthrough
// gives entry.id === step.id, making CANNED_RESPONSES routing unambiguous.
const CANNED_PIPELINE: LoadedPipeline = {
  def: {
    id: "test-pipeline",
    version: 1,
    description: "Test pipeline",
    inputs: ["request"],
    steps: [
      { id: "intake", kind: "llm", model: "intake", prompt: "prompts/intake.md" },
      {
        id: "enrich",
        kind: "llm",
        model: "enrich",
        prompt: "prompts/enrich.md",
        dependsOn: ["intake"],
      },
      {
        id: "critic",
        kind: "llm",
        model: "critic",
        prompt: "prompts/critic.md",
        schema: "weaknesses",
        dependsOn: ["enrich"],
      },
      {
        id: "security",
        kind: "llm",
        model: "security",
        prompt: "prompts/security.md",
        schema: "securityFindings",
        dependsOn: ["enrich"],
      },
      { id: "assemble", kind: "assemble-spec", dependsOn: ["critic", "security"] },
      { id: "approve", kind: "gate", message: "Approve this spec?", dependsOn: ["assemble"] },
      { id: "persist", kind: "persist-ticket", dependsOn: ["approve"] },
    ],
  },
  prompts: {
    intake: "Draft a spec for: {{request}}",
    enrich: "Enrich the draft:\n{{intake}}",
    critic: "Critique:\n{{intake}}\n{{enrich}}",
    security: "Security review:\n{{intake}}\n{{enrich}}",
  },
};

// ── Fake runner ───────────────────────────────────────────────────────────────

// Returns canned responses keyed by entry.id (= step.id with passthrough registry).
function makeFakeRunner(responses: Record<string, string>): typeof runLlmStep {
  return async (entry, _prompt) => {
    const resp = responses[entry.id];
    if (resp === undefined) throw new Error(`fake runner: no canned response for "${entry.id}"`);
    return resp;
  };
}

const INTAKE_MD = `# Feature T\n\nA feature description.\n\n## Requirements\n- Req 1\n- Req 2\n\n## Acceptance Criteria\n- AC 1\n`;
const ENRICH_MD = `## Enrichment additions\n- Edge case 1\n`;
// Plain JSON (no fences) — schema steps now also get plain JSON from real models when prompted correctly.
const CRITIC_JSON = `{"weaknesses":[{"text":"Ambiguous","severity":"medium","blocking":false}]}`;
const SECURITY_JSON = `{"securityFindings":[{"text":"No auth","severity":"high","blocking":true}]}`;

const CANNED_RESPONSES: Record<string, string> = {
  intake: INTAKE_MD,
  enrich: ENRICH_MD,
  critic: CRITIC_JSON,
  security: SECURITY_JSON,
};

// ── Test storage helpers ──────────────────────────────────────────────────────

interface TestFixture {
  storage: LibSQLStore;
  store: DrizzleTicketStore;
  cleanup: () => void;
}

function makeTestFixture(suffix: string): TestFixture {
  const dbPath = join(tmpdir(), `yoke-mastra-test-${suffix}-${Date.now()}.db`);
  const storage = new LibSQLStore({ id: `test-${suffix}`, url: `file:${dbPath}` });
  const db = makeInMemoryDb();
  const store = new DrizzleTicketStore(db);
  return {
    storage,
    store,
    cleanup: () => {
      try {
        unlinkSync(dbPath);
        unlinkSync(`${dbPath}-shm`);
        unlinkSync(`${dbPath}-wal`);
      } catch {
        /* ignore */
      }
    },
  };
}

// Empty registry: resolve() uses passthrough, giving entry.id === the looked-up model id.
const FAKE_REGISTRY = new ModelRegistry([]);

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("buildPipelineWorkflow — happy path (approve)", () => {
  it("suspends at gate, resumes approved, creates ticket", async () => {
    const { storage, store, cleanup } = makeTestFixture("happy");
    try {
      const wf = buildPipelineWorkflow(CANNED_PIPELINE, {
        registry: FAKE_REGISTRY,
        store,
        runner: makeFakeRunner(CANNED_RESPONSES),
      });

      const mastra = new Mastra({ storage, workflows: { [CANNED_PIPELINE.def.id]: wf } });
      const mastraWf = mastra.getWorkflow(CANNED_PIPELINE.def.id);
      const run = await mastraWf.createRun();
      const r1 = await run.start({ inputData: { request: "Add dark mode" } });

      assert.equal(r1.status, "suspended", "workflow should suspend at gate");
      assert.ok(Array.isArray(r1.suspended), "r1.suspended should be array");
      assert.equal(r1.suspended[0]?.[0], "approve", "suspended at approve step");

      // Check suspend payload has spec
      const gateStep = r1.steps?.approve as Record<string, unknown> | undefined;
      const suspendPayload = gateStep?.suspendPayload as Record<string, unknown> | undefined;
      assert.ok(suspendPayload?.spec, "suspend payload should include spec");
      const spec = suspendPayload?.spec as Record<string, unknown>;
      assert.ok(typeof spec.title === "string", "spec should have title");

      // Resume with approved=true
      const r2 = await run.resume({
        step: r1.suspended[0],
        resumeData: { approved: true },
      });

      assert.equal(r2.status, "success", "workflow should succeed after approval");

      // Ticket should be in store
      const tickets = await store.listTickets();
      assert.equal(tickets.length, 1, "one ticket should be created");
      assert.ok(tickets[0].title.length > 0, "ticket should have title");
    } finally {
      cleanup();
    }
  });
});

describe("buildPipelineWorkflow — rejected gate", () => {
  it("resumes rejected, no ticket created", async () => {
    const { storage, store, cleanup } = makeTestFixture("reject");
    try {
      const wf = buildPipelineWorkflow(CANNED_PIPELINE, {
        registry: FAKE_REGISTRY,
        store,
        runner: makeFakeRunner(CANNED_RESPONSES),
      });

      const mastra = new Mastra({ storage, workflows: { [CANNED_PIPELINE.def.id]: wf } });
      const mastraWf = mastra.getWorkflow(CANNED_PIPELINE.def.id);
      const run = await mastraWf.createRun();
      const r1 = await run.start({ inputData: { request: "Add dark mode" } });

      assert.equal(r1.status, "suspended");

      const r2 = await run.resume({
        step: r1.suspended[0],
        resumeData: { approved: false },
      });

      assert.equal(r2.status, "success", "workflow should succeed");
      // approved:false → persist-ticket step skips → no ticket
      const tickets = await store.listTickets();
      assert.equal(tickets.length, 0, "no ticket should be created on rejection");

      // Result should carry approved:false
      const result = r2.result as Record<string, unknown> | undefined;
      assert.equal(result?.approved, false, "result should have approved:false");
    } finally {
      cleanup();
    }
  });
});

describe("buildPipelineWorkflow — models override", () => {
  it("routes step to overridden model from registry", async () => {
    const capturedEntries: string[] = [];
    const trackingRunner: typeof runLlmStep = async (entry, _prompt) => {
      capturedEntries.push(entry.id);
      return CANNED_RESPONSES[entry.id] ?? INTAKE_MD;
    };

    // Registry with an explicit alt-model entry; other step ids use passthrough.
    const altRegistry = new ModelRegistry([
      {
        id: "alt-model",
        transport: "api",
        api: { endpoint: "http://localhost:11434/v1/chat/completions", model: "qwen2.5:1.5b" },
      },
    ]);

    const { storage, store, cleanup } = makeTestFixture("override");
    try {
      const wf = buildPipelineWorkflow(CANNED_PIPELINE, {
        registry: altRegistry,
        store,
        runner: trackingRunner,
      });

      const mastra = new Mastra({ storage, workflows: { [CANNED_PIPELINE.def.id]: wf } });
      const mastraWf = mastra.getWorkflow(CANNED_PIPELINE.def.id);
      const run = await mastraWf.createRun();
      // Override intake to use alt-model
      const r1 = await run.start({
        inputData: { request: "Feature X", models: { intake: "alt-model" } },
      });

      // entry.id for the intake step should be "alt-model" (not "intake")
      assert.ok(
        capturedEntries.includes("alt-model"),
        `expected alt-model to be used; got entries: ${capturedEntries.join(", ")}`
      );

      // Clean up suspended run
      if (r1.status === "suspended") {
        await run.resume({ step: r1.suspended[0], resumeData: { approved: false } });
      }
    } finally {
      cleanup();
    }
  });
});

describe("buildPipelineWorkflow — schema validation", () => {
  it("fails step when output missing required schema key", async () => {
    const badRunner: typeof runLlmStep = async (entry) => {
      if (entry.id === "critic") return '{"wrong_key": []}'; // missing "weaknesses"
      return CANNED_RESPONSES[entry.id] ?? INTAKE_MD;
    };

    const { storage, store, cleanup } = makeTestFixture("schema-fail");
    try {
      const wf = buildPipelineWorkflow(CANNED_PIPELINE, {
        registry: FAKE_REGISTRY,
        store,
        runner: badRunner,
      });

      const mastra = new Mastra({ storage, workflows: { [CANNED_PIPELINE.def.id]: wf } });
      const mastraWf = mastra.getWorkflow(CANNED_PIPELINE.def.id);
      const run = await mastraWf.createRun();
      const r1 = await run.start({ inputData: { request: "Feature Y" } });

      assert.equal(r1.status, "failed", "workflow should fail when schema key missing");
    } finally {
      cleanup();
    }
  });
});

describe("buildPipelineWorkflow — JSON retry", () => {
  it("succeeds when first call returns non-JSON but retry returns valid JSON", async () => {
    const callCounts: Record<string, number> = {};
    const retryRunner: typeof runLlmStep = async (entry, _prompt) => {
      callCounts[entry.id] = (callCounts[entry.id] ?? 0) + 1;
      if (entry.id === "critic" && callCounts.critic === 1) {
        // First attempt: return markdown prose (not JSON)
        return "Here are the weaknesses I found: the spec lacks error handling.";
      }
      if (entry.id === "critic") {
        // Second attempt (retry): return valid JSON
        return CRITIC_JSON;
      }
      return CANNED_RESPONSES[entry.id] ?? INTAKE_MD;
    };

    const { storage, store, cleanup } = makeTestFixture("retry-ok");
    try {
      const wf = buildPipelineWorkflow(CANNED_PIPELINE, {
        registry: FAKE_REGISTRY,
        store,
        runner: retryRunner,
      });

      const mastra = new Mastra({ storage, workflows: { [CANNED_PIPELINE.def.id]: wf } });
      const mastraWf = mastra.getWorkflow(CANNED_PIPELINE.def.id);
      const run = await mastraWf.createRun();
      const r1 = await run.start({ inputData: { request: "Dark mode" } });

      // Workflow should still reach the gate (critic succeeded on retry)
      assert.equal(r1.status, "suspended", "should suspend at gate after retry success");
      assert.equal(callCounts.critic, 2, "runner should have been called twice for critic");

      // Clean up
      if (r1.status === "suspended") {
        await run.resume({ step: r1.suspended[0], resumeData: { approved: false } });
      }
    } finally {
      cleanup();
    }
  });

  it("fails step when both attempts return non-JSON", async () => {
    const callCounts: Record<string, number> = {};
    const alwaysBadRunner: typeof runLlmStep = async (entry, _prompt) => {
      callCounts[entry.id] = (callCounts[entry.id] ?? 0) + 1;
      if (entry.id === "critic") {
        return "I cannot produce JSON output for this critique.";
      }
      return CANNED_RESPONSES[entry.id] ?? INTAKE_MD;
    };

    const { storage, store, cleanup } = makeTestFixture("retry-fail");
    try {
      const wf = buildPipelineWorkflow(CANNED_PIPELINE, {
        registry: FAKE_REGISTRY,
        store,
        runner: alwaysBadRunner,
      });

      const mastra = new Mastra({ storage, workflows: { [CANNED_PIPELINE.def.id]: wf } });
      const mastraWf = mastra.getWorkflow(CANNED_PIPELINE.def.id);
      const run = await mastraWf.createRun();
      const r1 = await run.start({ inputData: { request: "Dark mode" } });

      assert.equal(r1.status, "failed", "should fail when both attempts return non-JSON");
      assert.equal(callCounts.critic, 2, "runner should have been called twice for critic");
    } finally {
      cleanup();
    }
  });
});

describe("validateModelOverrides", () => {
  const reg = new ModelRegistry([
    { id: "sonnet", transport: "cli", cli: { bin: "claude", model: "sonnet" } },
    { id: "haiku", transport: "cli", cli: { bin: "claude", model: "haiku" } },
  ]);

  it("returns null when all step model ids are known", () => {
    const result = validateModelOverrides({ intake: "sonnet", enrich: "haiku" }, reg);
    assert.equal(result, null);
  });

  it("returns an error string naming the step and the bad model id when unknown", () => {
    const result = validateModelOverrides({ intake: "../../../../evil" }, reg);
    assert.ok(result !== null, "should return an error");
    assert.ok(result.includes("intake"), "error should name the step id");
    assert.ok(result.includes("../../../../evil"), "error should name the bad id");
    assert.ok(result.includes("sonnet") && result.includes("haiku"), "error should list valid ids");
  });

  it("returns an error for an unknown id even if another step uses a valid id", () => {
    const result = validateModelOverrides({ intake: "sonnet", "bad-step": "unknown-model" }, reg);
    assert.ok(result !== null);
    assert.ok(result.includes("unknown-model"));
  });
});

// ── dependsOn pipeline fixtures ───────────────────────────────────────────────

// Sequential: a → b (two levels, one step each)
const SEQUENTIAL_DEPENDS_ON: LoadedPipeline = {
  def: {
    id: "sequential-depends-on",
    version: 1,
    description: "Sequential dependsOn pipeline",
    inputs: ["request"],
    steps: [
      { id: "a", kind: "llm", model: "a", prompt: "prompts/a.md", dependsOn: [] },
      { id: "b", kind: "llm", model: "b", prompt: "prompts/b.md", dependsOn: ["a"] },
    ],
  },
  prompts: {
    a: "Step A: {{request}}",
    b: "Step B after A: {{a}}",
  },
};

// Diamond: a → b, a → c, b+c → d
// Level 0: [a], Level 1: [b, c] (parallel), Level 2: [d]
const DIAMOND_DEPENDS_ON: LoadedPipeline = {
  def: {
    id: "diamond-depends-on",
    version: 1,
    description: "Diamond dependsOn pipeline",
    inputs: ["request"],
    steps: [
      { id: "a", kind: "llm", model: "a", prompt: "prompts/a.md", dependsOn: [] },
      { id: "b", kind: "llm", model: "b", prompt: "prompts/b.md", dependsOn: ["a"] },
      { id: "c", kind: "llm", model: "c", prompt: "prompts/c.md", dependsOn: ["a"] },
      { id: "d", kind: "llm", model: "d", prompt: "prompts/d.md", dependsOn: ["b", "c"] },
    ],
  },
  prompts: {
    a: "Step A: {{request}}",
    b: "Step B: {{a}}",
    c: "Step C: {{a}}",
    d: "Step D: {{b}} {{c}}",
  },
};

// Two independent chains — used to test FR-005 context scoping.
// Level 0: [a, chain_c] (parallel), Level 1: [b, chain_d] (parallel)
// b depends only on a; chain_d depends only on chain_c.
// With FR-005: b's rendered prompt must not contain chain_c's output value.
const PARALLEL_CHAINS: LoadedPipeline = {
  def: {
    id: "parallel-chains",
    version: 1,
    description: "Two independent chains",
    inputs: ["request"],
    steps: [
      { id: "chain_a", kind: "llm", model: "chain_a", prompt: "prompts/a.md", dependsOn: [] },
      { id: "chain_c", kind: "llm", model: "chain_c", prompt: "prompts/c.md", dependsOn: [] },
      {
        id: "chain_b",
        kind: "llm",
        model: "chain_b",
        prompt: "prompts/b.md",
        dependsOn: ["chain_a"],
      },
      {
        id: "chain_d",
        kind: "llm",
        model: "chain_d",
        prompt: "prompts/d.md",
        dependsOn: ["chain_c"],
      },
    ],
  },
  prompts: {
    chain_a: "Step A: {{request}}",
    chain_c: "Step C: {{request}}",
    chain_b: "Step B sees: {{chain_a}}",
    chain_d: "Step D sees: {{chain_c}}",
  },
};

const DEPENDS_ON_RESPONSES: Record<string, string> = {
  a: "OUTPUT_A",
  b: "OUTPUT_B",
  c: "OUTPUT_C",
  d: "OUTPUT_D",
  chain_a: "CHAIN_A_OUTPUT",
  chain_b: "CHAIN_B_OUTPUT",
  chain_c: "CHAIN_C_OUTPUT",
  chain_d: "CHAIN_D_OUTPUT",
};

describe("buildPipelineWorkflow — dependsOn sequential pipeline", () => {
  it("compiles and runs a sequential dependsOn pipeline to completion", async () => {
    const { storage, store, cleanup } = makeTestFixture("dep-seq");
    try {
      const wf = buildPipelineWorkflow(SEQUENTIAL_DEPENDS_ON, {
        registry: FAKE_REGISTRY,
        store,
        runner: makeFakeRunner(DEPENDS_ON_RESPONSES),
      });

      const mastra = new Mastra({ storage, workflows: { [SEQUENTIAL_DEPENDS_ON.def.id]: wf } });
      const mastraWf = mastra.getWorkflow(SEQUENTIAL_DEPENDS_ON.def.id);
      const run = await mastraWf.createRun();
      const r1 = await run.start({ inputData: { request: "test request" } });

      assert.equal(r1.status, "success", "sequential dependsOn pipeline should succeed");
      const result = r1.result as Record<string, unknown>;
      assert.ok("a" in result, "result should contain step a output");
      assert.ok("b" in result, "result should contain step b output");
    } finally {
      cleanup();
    }
  });
});

describe("buildPipelineWorkflow — diamond dependsOn pipeline", () => {
  it("produces a parallel level for b and c with a merge, then runs d", async () => {
    const { storage, store, cleanup } = makeTestFixture("dep-diamond");
    try {
      const wf = buildPipelineWorkflow(DIAMOND_DEPENDS_ON, {
        registry: FAKE_REGISTRY,
        store,
        runner: makeFakeRunner(DEPENDS_ON_RESPONSES),
      });

      const mastra = new Mastra({ storage, workflows: { [DIAMOND_DEPENDS_ON.def.id]: wf } });
      const mastraWf = mastra.getWorkflow(DIAMOND_DEPENDS_ON.def.id);
      const run = await mastraWf.createRun();
      const r1 = await run.start({ inputData: { request: "diamond input" } });

      assert.equal(r1.status, "success", "diamond pipeline should succeed");
      const result = r1.result as Record<string, unknown>;
      assert.ok("a" in result, "result should contain step a output");
      assert.ok("b" in result, "result should contain step b output (parallel level)");
      assert.ok("c" in result, "result should contain step c output (parallel level)");
      assert.ok("d" in result, "result should contain step d output (post-merge)");
    } finally {
      cleanup();
    }
  });
});

describe("buildPipelineWorkflow — FR-005 context scoping", () => {
  it("step sees ancestor output but not non-ancestor output in rendered prompt", async () => {
    const capturedPrompts: Record<string, string> = {};
    const capturingRunner: typeof runLlmStep = async (entry, prompt) => {
      capturedPrompts[entry.id] = prompt;
      const resp = DEPENDS_ON_RESPONSES[entry.id];
      if (resp === undefined) throw new Error(`no canned response for "${entry.id}"`);
      return resp;
    };

    const { storage, store, cleanup } = makeTestFixture("dep-fr005");
    try {
      const wf = buildPipelineWorkflow(PARALLEL_CHAINS, {
        registry: FAKE_REGISTRY,
        store,
        runner: capturingRunner,
      });

      const mastra = new Mastra({ storage, workflows: { [PARALLEL_CHAINS.def.id]: wf } });
      const mastraWf = mastra.getWorkflow(PARALLEL_CHAINS.def.id);
      const run = await mastraWf.createRun();
      const r1 = await run.start({ inputData: { request: "fr005 test" } });

      assert.equal(r1.status, "success", "parallel chains pipeline should succeed");

      // chain_b depends on chain_a → chain_a's output must appear in chain_b's prompt.
      assert.ok(
        capturedPrompts.chain_b?.includes("CHAIN_A_OUTPUT"),
        "chain_b prompt should contain chain_a's output (ancestor)"
      );

      // chain_c is NOT an ancestor of chain_b — its output must not appear.
      assert.ok(
        !capturedPrompts.chain_b?.includes("CHAIN_C_OUTPUT"),
        "chain_b prompt must not contain chain_c's output (non-ancestor, FR-005)"
      );

      // Symmetric check for chain_d / chain_a.
      assert.ok(
        capturedPrompts.chain_d?.includes("CHAIN_C_OUTPUT"),
        "chain_d prompt should contain chain_c's output (ancestor)"
      );
      assert.ok(
        !capturedPrompts.chain_d?.includes("CHAIN_A_OUTPUT"),
        "chain_d prompt must not contain chain_a's output (non-ancestor, FR-005)"
      );
    } finally {
      cleanup();
    }
  });
});

// ── Per-step timeout wiring ───────────────────────────────────────────────────

describe("buildPipelineWorkflow — per-step timeout wiring", () => {
  it("passes step.timeoutMs and pipeline.defaultTimeoutMs to the runner for precedence resolution", async () => {
    const capturedDeps: Record<string, StepRunnerDeps> = {};
    const trackingRunner: typeof runLlmStep = async (entry, _prompt, deps) => {
      capturedDeps[entry.id] = { ...(deps ?? {}) };
      return "output";
    };

    const pipelineWithTimeout: LoadedPipeline = {
      def: {
        id: "timeout-wiring",
        version: 1,
        description: "Timeout wiring test pipeline",
        inputs: ["request"],
        defaultTimeoutMs: 5000,
        steps: [
          {
            id: "with-step-timeout",
            kind: "llm",
            model: "with-step-timeout",
            prompt: "prompts/a.md",
            timeoutMs: 1000,
          },
          {
            id: "without-step-timeout",
            kind: "llm",
            model: "without-step-timeout",
            prompt: "prompts/b.md",
            dependsOn: ["with-step-timeout"],
          },
        ],
      },
      prompts: {
        "with-step-timeout": "{{request}}",
        "without-step-timeout": "{{with-step-timeout}}",
      },
    };

    const { storage, store, cleanup } = makeTestFixture("timeout-wire");
    try {
      const wf = buildPipelineWorkflow(pipelineWithTimeout, {
        registry: FAKE_REGISTRY,
        store,
        runner: trackingRunner,
      });

      const mastra = new Mastra({ storage, workflows: { "timeout-wiring": wf } });
      const mastraWf = mastra.getWorkflow("timeout-wiring");
      const run = await mastraWf.createRun();
      await run.start({ inputData: { request: "test" } });

      // Step with step-level timeout: both timeoutMs and defaultTimeoutMs should be present.
      // runLlmStep resolves the effective timeout as timeoutMs ?? defaultTimeoutMs = 1000.
      assert.equal(
        capturedDeps["with-step-timeout"]?.timeoutMs,
        1000,
        "step-level timeoutMs should be passed to the runner"
      );
      assert.equal(
        capturedDeps["with-step-timeout"]?.defaultTimeoutMs,
        5000,
        "pipeline defaultTimeoutMs should also be present for transparency"
      );

      // Step without step-level timeout: only the pipeline default is passed.
      assert.equal(
        capturedDeps["without-step-timeout"]?.timeoutMs,
        undefined,
        "step without timeoutMs should not have a step-level timeoutMs in runner deps"
      );
      assert.equal(
        capturedDeps["without-step-timeout"]?.defaultTimeoutMs,
        5000,
        "pipeline defaultTimeoutMs should be passed for steps without their own timeout"
      );
    } finally {
      cleanup();
    }
  });
});

describe("mastraDbPath", () => {
  it("strips .sqlite and appends -mastra.db", () => {
    assert.equal(mastraDbPath("/tmp/yoke.sqlite"), "/tmp/yoke-mastra.db");
  });

  it("strips .db and appends -mastra.db", () => {
    assert.equal(mastraDbPath("/tmp/yoke.db"), "/tmp/yoke-mastra.db");
  });

  it("appends -mastra.db when no recognised extension", () => {
    assert.equal(mastraDbPath("/tmp/yoke"), "/tmp/yoke-mastra.db");
  });

  it("does not strip a .db component in a directory name", () => {
    assert.equal(mastraDbPath("/some/path/db.dir/yoke"), "/some/path/db.dir/yoke-mastra.db");
  });
});

// ── Loop step fixtures ─────────────────────────────────────────────────────────

// Body pipeline: one LLM step "eval" whose output becomes the "until" key.
const LOOP_BODY_PIPELINE: LoadedPipeline = {
  def: {
    id: "build-round",
    version: 1,
    description: "Loop body",
    inputs: ["request"],
    steps: [{ id: "eval", kind: "llm", model: "eval", prompt: "check prompt" }],
  },
  prompts: { eval: "Evaluate: {{request}}" },
};

// Parent pipeline: one loop step "round" over LOOP_BODY_PIPELINE, until "eval" is truthy.
const LOOP_PIPELINE: LoadedPipeline = {
  def: {
    id: "loop-pipeline",
    version: 1,
    description: "Pipeline with a bounded loop",
    inputs: ["request"],
    steps: [
      {
        id: "round",
        kind: "loop",
        pipeline: "build-round",
        maxIterations: 3,
        until: "eval",
      },
    ],
  },
  prompts: {},
  bodies: { round: LOOP_BODY_PIPELINE },
};

describe("buildPipelineWorkflow — loop converges before maxIterations", () => {
  it("runs the expected number of iterations and records converged=true", async () => {
    const callCounts: Record<string, number> = {};
    const runner: typeof runLlmStep = async (entry, _prompt) => {
      callCounts[entry.id] = (callCounts[entry.id] ?? 0) + 1;
      // "eval" returns truthy on the 2nd call so the loop converges at iteration 2.
      if (entry.id === "eval") return callCounts.eval >= 2 ? "done" : "";
      return "";
    };

    const { storage, store, cleanup } = makeTestFixture("loop-converge");
    try {
      const wf = buildPipelineWorkflow(LOOP_PIPELINE, {
        registry: FAKE_REGISTRY,
        store,
        runner,
      });

      const mastra = new Mastra({ storage, workflows: { [LOOP_PIPELINE.def.id]: wf } });
      const mastraWf = mastra.getWorkflow(LOOP_PIPELINE.def.id);
      const run = await mastraWf.createRun();
      const r1 = await run.start({ inputData: { request: "test" } });

      assert.equal(r1.status, "success", "loop pipeline should succeed");
      const result = r1.result as Record<string, unknown>;
      const outcome = result.round as { converged: boolean; iterations: number };
      assert.equal(outcome.converged, true, "should report converged=true");
      assert.equal(outcome.iterations, 2, "should report 2 iterations");
    } finally {
      cleanup();
    }
  });
});

describe("buildPipelineWorkflow — loop exhausts maxIterations without converging", () => {
  it("stops at maxIterations without throwing and records converged=false", async () => {
    const runner: typeof runLlmStep = async (_entry, _prompt) => "";

    const { storage, store, cleanup } = makeTestFixture("loop-exhaust");
    try {
      const wf = buildPipelineWorkflow(LOOP_PIPELINE, {
        registry: FAKE_REGISTRY,
        store,
        runner,
      });

      const mastra = new Mastra({ storage, workflows: { [LOOP_PIPELINE.def.id]: wf } });
      const mastraWf = mastra.getWorkflow(LOOP_PIPELINE.def.id);
      const run = await mastraWf.createRun();
      const r1 = await run.start({ inputData: { request: "test" } });

      assert.equal(r1.status, "success", "loop pipeline must succeed even when not converged");
      const result = r1.result as Record<string, unknown>;
      const outcome = result.round as { converged: boolean; iterations: number };
      assert.equal(outcome.converged, false, "should report converged=false");
      assert.equal(outcome.iterations, 3, "should report 3 iterations (= maxIterations)");
    } finally {
      cleanup();
    }
  });
});

describe("buildPipelineWorkflow — loop run independence (regression: no closure state leak)", () => {
  it("two sequential runs on the same built workflow each report their own correct outcome", async () => {
    // Phase 1 runner: eval returns truthy on the 2nd call so run 1 converges at iteration 2.
    // Phase 2 runner: eval always returns falsy so run 2 exhausts maxIterations.
    let phase = 1;
    let run1EvalCount = 0;

    const runner: typeof runLlmStep = async (entry, _prompt) => {
      if (entry.id !== "eval") return "";
      if (phase === 1) {
        run1EvalCount += 1;
        return run1EvalCount >= 2 ? "done" : "";
      }
      return "";
    };

    // Build the workflow ONCE; both runs reuse the same artifact.
    const wf = buildPipelineWorkflow(LOOP_PIPELINE, {
      registry: FAKE_REGISTRY,
      store: new DrizzleTicketStore(makeInMemoryDb()),
      runner,
    });

    // ── Run 1: should converge at iteration 2 ────────────────────────────────
    const { storage: s1, store: store1, cleanup: cleanup1 } = makeTestFixture("loop-indep-r1");
    try {
      const mastra1 = new Mastra({ storage: s1, workflows: { [LOOP_PIPELINE.def.id]: wf } });
      const mastraWf1 = mastra1.getWorkflow(LOOP_PIPELINE.def.id);
      const run1 = await mastraWf1.createRun();
      const r1 = await run1.start({ inputData: { request: "run-1" } });

      assert.equal(r1.status, "success", "run 1 should succeed");
      const outcome1 = (r1.result as Record<string, unknown>).round as {
        converged: boolean;
        iterations: number;
      };
      assert.equal(outcome1.converged, true, "run 1: should report converged=true");
      assert.equal(outcome1.iterations, 2, "run 1: should report iterations=2");
    } finally {
      cleanup1();
      void store1;
    }

    // Switch runner to phase 2 (never converges).
    phase = 2;

    // ── Run 2: should exhaust maxIterations without converging ───────────────
    const { storage: s2, store: store2, cleanup: cleanup2 } = makeTestFixture("loop-indep-r2");
    try {
      const mastra2 = new Mastra({ storage: s2, workflows: { [LOOP_PIPELINE.def.id]: wf } });
      const mastraWf2 = mastra2.getWorkflow(LOOP_PIPELINE.def.id);
      const run2 = await mastraWf2.createRun();
      const r2 = await run2.start({ inputData: { request: "run-2" } });

      assert.equal(r2.status, "success", "run 2 should succeed");
      const outcome2 = (r2.result as Record<string, unknown>).round as {
        converged: boolean;
        iterations: number;
      };
      assert.equal(
        outcome2.converged,
        false,
        "run 2: should report converged=false (no closure leak from run 1)"
      );
      assert.equal(
        outcome2.iterations,
        LOOP_PIPELINE.def.steps[0].maxIterations,
        "run 2: should report iterations=maxIterations (no closure leak from run 1)"
      );
    } finally {
      cleanup2();
      void store2;
    }
  });
});

// ── Check step fixtures ────────────────────────────────────────────────────────

// A single-step pipeline with a check step that always passes.
const CHECK_PASS_PIPELINE: LoadedPipeline = {
  def: {
    id: "check-pass-pipeline",
    version: 1,
    description: "Pipeline with a passing check step",
    inputs: [],
    steps: [{ id: "test", kind: "check", command: "exit 0" }],
  },
  prompts: {},
};

// A single-step pipeline with a check step that always fails.
const CHECK_FAIL_PIPELINE: LoadedPipeline = {
  def: {
    id: "check-fail-pipeline",
    version: 1,
    description: "Pipeline with a failing check step",
    inputs: [],
    steps: [{ id: "test", kind: "check", command: "exit 1" }],
  },
  prompts: {},
};

describe("buildPipelineWorkflow — check step result in context", () => {
  it("passing check step lands { passed:true, exitCode:0 } in ctx under step id", async () => {
    const { storage, store, cleanup } = makeTestFixture("check-pass");
    try {
      const wf = buildPipelineWorkflow(CHECK_PASS_PIPELINE, { registry: FAKE_REGISTRY, store });
      const mastra = new Mastra({ storage, workflows: { [CHECK_PASS_PIPELINE.def.id]: wf } });
      const mastraWf = mastra.getWorkflow(CHECK_PASS_PIPELINE.def.id);
      const run = await mastraWf.createRun();
      const r1 = await run.start({ inputData: {} });

      assert.equal(r1.status, "success");
      const result = r1.result as Record<string, unknown>;
      const check = result.test as { passed: boolean; exitCode: number; output: string };
      assert.equal(check.passed, true, "passed should be true for exit 0");
      assert.equal(check.exitCode, 0);
      assert.equal(typeof check.output, "string");
    } finally {
      cleanup();
    }
  });

  it("failing check step lands { passed:false, exitCode:1 } in ctx without throwing", async () => {
    const { storage, store, cleanup } = makeTestFixture("check-fail");
    try {
      const wf = buildPipelineWorkflow(CHECK_FAIL_PIPELINE, { registry: FAKE_REGISTRY, store });
      const mastra = new Mastra({ storage, workflows: { [CHECK_FAIL_PIPELINE.def.id]: wf } });
      const mastraWf = mastra.getWorkflow(CHECK_FAIL_PIPELINE.def.id);
      const run = await mastraWf.createRun();
      const r1 = await run.start({ inputData: {} });

      assert.equal(r1.status, "success", "workflow must succeed even when check fails");
      const result = r1.result as Record<string, unknown>;
      const check = result.test as { passed: boolean; exitCode: number; output: string };
      assert.equal(check.passed, false, "passed should be false for exit 1");
      assert.equal(check.exitCode, 1);
    } finally {
      cleanup();
    }
  });
});

// Loop body pipeline: one check step whose exit code determines convergence.
const CHECK_LOOP_BODY_PASS: LoadedPipeline = {
  def: {
    id: "check-body-pass",
    version: 1,
    description: "Loop body with always-passing check",
    inputs: [],
    steps: [{ id: "test", kind: "check", command: "exit 0" }],
  },
  prompts: {},
};

const CHECK_LOOP_BODY_FAIL: LoadedPipeline = {
  def: {
    id: "check-body-fail",
    version: 1,
    description: "Loop body with always-failing check",
    inputs: [],
    steps: [{ id: "test", kind: "check", command: "exit 1" }],
  },
  prompts: {},
};

// Loop reads `test.passed` via dot-notation to decide convergence.
const LOOP_CHECK_PASS_PIPELINE: LoadedPipeline = {
  def: {
    id: "loop-check-pass",
    version: 1,
    description: "Loop converging on check.passed",
    inputs: [],
    steps: [
      {
        id: "run",
        kind: "loop",
        pipeline: "check-body-pass",
        maxIterations: 3,
        until: "test.passed",
      },
    ],
  },
  prompts: {},
  bodies: { run: CHECK_LOOP_BODY_PASS },
};

const LOOP_CHECK_FAIL_PIPELINE: LoadedPipeline = {
  def: {
    id: "loop-check-fail",
    version: 1,
    description: "Loop that never converges (check always fails)",
    inputs: [],
    steps: [
      {
        id: "run",
        kind: "loop",
        pipeline: "check-body-fail",
        maxIterations: 2,
        until: "test.passed",
      },
    ],
  },
  prompts: {},
  bodies: { run: CHECK_LOOP_BODY_FAIL },
};

describe("buildPipelineWorkflow — loop terminates on check.passed (the convergence signal)", () => {
  it("loop converges after 1 iteration when check passes (exit 0)", async () => {
    const { storage, store, cleanup } = makeTestFixture("loop-check-converge");
    try {
      const wf = buildPipelineWorkflow(LOOP_CHECK_PASS_PIPELINE, {
        registry: FAKE_REGISTRY,
        store,
      });
      const mastra = new Mastra({ storage, workflows: { [LOOP_CHECK_PASS_PIPELINE.def.id]: wf } });
      const mastraWf = mastra.getWorkflow(LOOP_CHECK_PASS_PIPELINE.def.id);
      const run = await mastraWf.createRun();
      const r1 = await run.start({ inputData: {} });

      assert.equal(r1.status, "success");
      const result = r1.result as Record<string, unknown>;
      const outcome = result.run as { converged: boolean; iterations: number };
      assert.equal(outcome.converged, true, "should converge when check.passed is true");
      assert.equal(outcome.iterations, 1, "should stop after 1 iteration (exit 0 always passes)");
    } finally {
      cleanup();
    }
  });

  it("loop exhausts maxIterations when check never passes (exit 1)", async () => {
    const { storage, store, cleanup } = makeTestFixture("loop-check-exhaust");
    try {
      const wf = buildPipelineWorkflow(LOOP_CHECK_FAIL_PIPELINE, {
        registry: FAKE_REGISTRY,
        store,
      });
      const mastra = new Mastra({ storage, workflows: { [LOOP_CHECK_FAIL_PIPELINE.def.id]: wf } });
      const mastraWf = mastra.getWorkflow(LOOP_CHECK_FAIL_PIPELINE.def.id);
      const run = await mastraWf.createRun();
      const r1 = await run.start({ inputData: {} });

      assert.equal(r1.status, "success", "loop must not throw when check never passes");
      const result = r1.result as Record<string, unknown>;
      const outcome = result.run as { converged: boolean; iterations: number };
      assert.equal(
        outcome.converged,
        false,
        "should not converge when check.passed is always false"
      );
      assert.equal(outcome.iterations, 2, "should exhaust maxIterations");
    } finally {
      cleanup();
    }
  });
});

// ── Regression: nested-namespace assemble ─────────────────────────────────────
//
// When spec-creation is embedded as a `plan` step in a parent pipeline,
// expandNested namespaces every step id: intake → plan.intake, etc.
// buildAssembleStep must read plan.intake / plan.enrich / plan.critic /
// plan.security — not the bare keys — otherwise assembleSpec receives
// undefined arguments and throws "Cannot read properties of undefined".
//
// This test fails against the unfixed code (status === "failed") and
// passes after the namespace-aware nsKey fix (status === "suspended").

const NESTED_ASSEMBLE_PIPELINE: LoadedPipeline = {
  def: {
    id: "nested-assemble",
    version: 1,
    description: "Regression: assemble must read namespaced context keys",
    inputs: ["request"],
    steps: [
      { id: "plan.intake", kind: "llm", model: "plan.intake", dependsOn: [] },
      { id: "plan.enrich", kind: "llm", model: "plan.enrich", dependsOn: ["plan.intake"] },
      {
        id: "plan.critic",
        kind: "llm",
        model: "plan.critic",
        schema: "weaknesses",
        dependsOn: ["plan.enrich"],
      },
      {
        id: "plan.security",
        kind: "llm",
        model: "plan.security",
        schema: "securityFindings",
        dependsOn: ["plan.enrich"],
      },
      { id: "plan.assemble", kind: "assemble-spec", dependsOn: ["plan.critic", "plan.security"] },
      { id: "plan.approve", kind: "gate", message: "Approve?", dependsOn: ["plan.assemble"] },
      { id: "plan.persist", kind: "persist-ticket", dependsOn: ["plan.approve"] },
    ],
  },
  prompts: {
    "plan.intake": "Draft a spec for: {{request}}",
    "plan.enrich": "Enrich: {{plan.intake}}",
    "plan.critic": "Critique: {{plan.intake}} {{plan.enrich}}",
    "plan.security": "Security: {{plan.intake}} {{plan.enrich}}",
  },
};

const NESTED_ASSEMBLE_RESPONSES: Record<string, string> = {
  "plan.intake": INTAKE_MD,
  "plan.enrich": ENRICH_MD,
  "plan.critic": CRITIC_JSON,
  "plan.security": SECURITY_JSON,
};

describe("buildPipelineWorkflow — nested namespace assemble (regression)", () => {
  it("assemble step reads plan.intake / plan.enrich / … — not bare undefined keys", async () => {
    const { storage, store, cleanup } = makeTestFixture("nested-assemble");
    try {
      const wf = buildPipelineWorkflow(NESTED_ASSEMBLE_PIPELINE, {
        registry: FAKE_REGISTRY,
        store,
        runner: makeFakeRunner(NESTED_ASSEMBLE_RESPONSES),
      });

      const mastra = new Mastra({
        storage,
        workflows: { [NESTED_ASSEMBLE_PIPELINE.def.id]: wf },
      });
      const mastraWf = mastra.getWorkflow(NESTED_ASSEMBLE_PIPELINE.def.id);
      const run = await mastraWf.createRun();
      const r1 = await run.start({ inputData: { request: "Add dark mode" } });

      assert.equal(
        r1.status,
        "suspended",
        "workflow must suspend at plan.approve gate — not fail on undefined intake"
      );
      const gateStep = r1.steps?.["plan.approve"] as Record<string, unknown> | undefined;
      const suspendPayload = gateStep?.suspendPayload as Record<string, unknown> | undefined;
      assert.ok(suspendPayload?.spec, "gate suspend payload must include spec");
      const spec = suspendPayload?.spec as Record<string, unknown>;
      assert.ok(
        typeof spec.title === "string" && spec.title.length > 0,
        `spec.title must be a non-empty string — got: ${JSON.stringify(spec.title)}`
      );

      await run.resume({ step: r1.suspended[0], resumeData: { approved: false } });
    } finally {
      cleanup();
    }
  });
});

// ── Workspace access reaches the runner ───────────────────────────────────────
// Regression: the canon declared `workspace: read|write` but buildLlmStep only
// threaded timeouts into the runner deps, so the declaration was silently
// dropped and the agent ran with no repo access.

describe("buildPipelineWorkflow — workspace access is forwarded to the runner", () => {
  it("passes the declared workspace and the build cwd through to runLlmStep", async () => {
    const { storage, store, cleanup } = makeTestFixture("workspace-forward");
    try {
      const seen: { access?: string; dir?: string }[] = [];
      const capturingRunner: typeof runLlmStep = async (_entry, _prompt, runnerDeps) => {
        seen.push({ access: runnerDeps?.workspaceAccess, dir: runnerDeps?.workspaceDir });
        return "surveyed";
      };

      const pipeline = {
        def: {
          id: "ws-forward",
          version: 1,
          description: "workspace forwarding",
          inputs: ["request"],
          steps: [
            { id: "survey", kind: "llm" as const, model: "sonnet", workspace: "read" as const },
          ],
        },
        prompts: { survey: "Look at {{request}}" },
      };

      const wf = buildPipelineWorkflow(pipeline, {
        registry: FAKE_REGISTRY,
        store,
        runner: capturingRunner,
        cwd: "/tmp/some-project",
      });

      const mastra = new Mastra({ storage, workflows: { "ws-forward": wf } });
      const run = await mastra.getWorkflow("ws-forward").createRun();
      await run.start({ inputData: { request: "audit the loader" } });

      assert.equal(seen.length, 1, "runner should be called once");
      assert.equal(seen[0].access, "read", "declared workspace must reach the runner");
      assert.equal(seen[0].dir, "/tmp/some-project", "build cwd must reach the runner");
    } finally {
      cleanup();
    }
  });
});
