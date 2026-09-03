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
import type { runLlmStep } from "../../canon/runStep.js";
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
