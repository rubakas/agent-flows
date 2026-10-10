// End-to-end test for createDynamicMastra (spec 028 FR-004, executor side).
//
// THE DEFECT this test encodes:
//   A pipeline installed while the daemon is running appeared in GET /api/pipelines
//   (listing reloads per-request) but POST /api/runs failed with "Workflow not found"
//   (Mastra executor was constructed once at startup and never refreshed).
//
// THE FIX:
//   createDynamicMastra wraps the initial Mastra instance.  When getWorkflow() throws,
//   it rescans the current canon dir, rebuilds all workflows from disk, and retries.
//
// PROOF the test can fail:
//   To verify the guard is real, this test was run against a version of
//   createDynamicMastra that contained only a pass-through (no rebuild on throw).
//   Step 2 (POST after install) returned HTTP 500 "Workflow with ID hot-test not found".
//   With the real implementation the test is GREEN.
//
// This file lives in src/bindings/mastra/ because that glob has import-x/no-cycle
// disabled — necessary to import @mastra/core and buildPipelineWorkflow statically
// without crashing the eslint import-cycle resolver.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";

import { Mastra } from "@mastra/core/mastra";
import { LibSQLStore } from "@mastra/libsql";

import { loadCatalogPipelines, resolveCatalog } from "../../canon/layers.js";
import { ModelRegistry } from "../../canon/registry.js";
import { makeInMemoryDb } from "../../db/index.js";
import { resolveProjectState, type ProjectState } from "../../runtime/projectState.js";
import { RunService, type MastraLike } from "../../runtime/runService.js";
import { startServer, type ServeHandle } from "../../serve/server.js";
import { DrizzleTicketStore } from "../../store/sqlite.js";
import { buildPipelineWorkflow } from "./build.js";
import { createDynamicMastra } from "./dynamicMastra.js";
import { mastraDbPath } from "./paths.js";
import type { StepRunnerDeps } from "../../canon/runStep.js";
import type { Dispatch } from "../../canon/stepAttempt.js";
import type { LoadedPipeline } from "../../canon/types.js";

const TEST_STATE_HOME = join(tmpdir(), `agent-flows-test-state-${process.pid}`);

/**
 * Machine-local state for a test server, rooted in a throwaway home so nothing
 * can fall through to the owner's real ~/.agent-flows (spec 032 V7).
 * `resolveProjectState` is pure, so the directory is created only if a test
 * actually writes into it.
 */
function makeState(projectDir: string, tmpDir?: string): ProjectState {
  const home = tmpDir !== undefined ? join(tmpDir, "state-home") : TEST_STATE_HOME;
  return resolveProjectState(projectDir, { AGENT_FLOWS_HOME: home });
}

// Simple pipeline used in the install-then-run test.  Uses a check step with a
// trivially fast, deterministic command so the run does not call a model or
// block on user input.
const HOT_TEST_YAML = `\
id: hot-test
version: 1
description: Hot-reload integration test pipeline
inputs: []
steps:
  - id: run
    kind: check
    command: echo ok
`;

describe("createDynamicMastra — installed pipeline becomes executable without restart (FR-004)", () => {
  let srv: ServeHandle;
  let tmpProjectDir: string;
  let tmpMastraDir: string;

  before(async () => {
    tmpProjectDir = realpathSync(mkdtempSync(join(tmpdir(), "agent-flows-dyn-proj-")));
    tmpMastraDir = realpathSync(mkdtempSync(join(tmpdir(), "agent-flows-dyn-mastra-")));

    // File-backed LibSQL for the Mastra storage so that multiple Mastra instances
    // created during rebuilds all read from the same on-disk database.
    const mastraDbFile = mastraDbPath(join(tmpMastraDir, "ticket.sqlite"));
    const mastraStorage = new LibSQLStore({
      id: "dyn-test-store",
      url: `file:${mastraDbFile}`,
    });

    // Start with an empty workflow set — hot-test is not registered.
    const initialMastra = new Mastra({ storage: mastraStorage, workflows: {} });

    // Build deps needed to compile newly-installed pipelines at run-start time.
    // No models are needed (the test pipeline only has a check step).
    const buildDeps = {
      registry: new ModelRegistry([]),
      store: new DrizzleTicketStore(makeInMemoryDb()),
      cwd: tmpProjectDir,
    };

    const dynamicMastra = createDynamicMastra(
      // Mastra's getWorkflow return type doesn't statically satisfy MastraLike's
      // unexported MastraWorkflow — structurally compatible at runtime, cast here.
      initialMastra as unknown as MastraLike,
      {
        MastraClass: Mastra,
        mastraStorage,
        buildFn: buildPipelineWorkflow,
        buildDeps,
        resolveCatalog: () => resolveCatalog(tmpProjectDir),
      }
    );

    const runService = new RunService(dynamicMastra);

    srv = await startServer({
      state: makeState(tmpProjectDir),
      port: 0,
      dbPath: ":memory:",
      runService,
      projectDir: tmpProjectDir,
    });
  });

  after(async () => {
    await srv.close();
    rmSync(tmpProjectDir, { recursive: true, force: true });
    rmSync(tmpMastraDir, { recursive: true, force: true });
  });

  it("POST /api/runs fails before the pipeline is installed", async () => {
    const res = await fetch(`http://127.0.0.1:${srv.port}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pipeline: "hot-test", inputs: {} }),
    });
    assert.notEqual(
      res.status,
      200,
      `expected a non-200 response before hot-test is installed; got ${String(res.status)}`
    );
    await res.body?.cancel();
  });

  it("POST /api/runs succeeds after the pipeline is installed — no restart", async () => {
    // Write the pipeline into the project's canon dir while the daemon is running.
    const projectPipelinesDir = join(tmpProjectDir, ".agent-flows", "pipelines");
    mkdirSync(projectPipelinesDir, { recursive: true });
    writeFileSync(join(projectPipelinesDir, "hot-test.yaml"), HOT_TEST_YAML);

    // The executor must detect the new pipeline and start the run without restart.
    const res = await fetch(`http://127.0.0.1:${srv.port}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pipeline: "hot-test", inputs: {} }),
    });
    assert.equal(
      res.status,
      200,
      `expected HTTP 200 after hot-test was installed; got ${String(res.status)}`
    );
    const body = (await res.json()) as { runId?: string; status?: string };
    assert.ok(
      typeof body.runId === "string" && body.runId.length > 0,
      "response must have a runId"
    );
    assert.equal(body.status, "running", "run must start immediately in 'running' state");
  });
});

// ── FR-8 (spec 047): an edited pipeline must run its edited build ─────────────
//
// THE DEFECT: the daemon builds every pipeline once at startup. The build closes
// over the step list and the prompt TEXT, so editing the YAML or a prompt file
// afterwards left runs executing the OLD build while the route validated the NEW
// definition. createDynamicMastra only rebuilt when an id was missing.
//
// PROOF the tests can fail: run against the previous createDynamicMastra (which
// rebuilt only on a lookup miss) the first test saw the "OLD" prompt and no
// second step; the third saw a generic failure instead of an error naming the id.

const llmYaml = (id: string, stepIds: string[]): string =>
  `id: ${id}\nversion: 1\ndescription: FR-8 fixture\ninputs: []\nsteps:\n` +
  stepIds
    .map(
      (sid, i) =>
        `  - id: ${sid}\n    kind: llm\n    model: ${sid}\n    prompt: prompts/${id}-${sid}.md\n` +
        (i > 0 ? `    dependsOn: [${stepIds[i - 1] ?? ""}]\n` : "")
    )
    .join("");

describe("createDynamicMastra — an edited pipeline runs its edited build (spec 047 FR-8)", () => {
  let projectDir: string;
  let mastraDir: string;
  let prompts: string[];
  let builds: string[];

  function writePipeline(id: string, stepIds: string[], promptText: string): void {
    const root = join(projectDir, ".agent-flows");
    mkdirSync(join(root, "pipelines"), { recursive: true });
    mkdirSync(join(root, "prompts"), { recursive: true });
    writeFileSync(join(root, "pipelines", `${id}.yaml`), llmYaml(id, stepIds));
    for (const sid of stepIds) {
      writeFileSync(join(root, "prompts", `${id}-${sid}.md`), `${promptText} ${sid}`);
    }
  }

  const pipelineFile = (id: string): string =>
    join(projectDir, ".agent-flows", "pipelines", `${id}.yaml`);

  // Mirrors the daemon: build every pipeline in the catalogue once, hand the
  // built list and the build failures to the wrapper so it knows what the
  // initial instance contains. A pipeline named by `failFor` always fails to build.
  function startup(failFor?: string): ReturnType<typeof createDynamicMastra> {
    const mastraStorage = new LibSQLStore({
      id: "dyn-fr8-store",
      url: `file:${mastraDbPath(join(mastraDir, "ticket.sqlite"))}`,
    });
    const runner: Dispatch = (_entry, prompt: string, _deps?: StepRunnerDeps) => {
      prompts.push(prompt);
      return Promise.resolve("ok");
    };
    const buildDeps = {
      registry: new ModelRegistry([]),
      store: new DrizzleTicketStore(makeInMemoryDb()),
      cwd: projectDir,
      runner,
    };
    const buildFn = (
      loaded: Parameters<typeof buildPipelineWorkflow>[0],
      deps: typeof buildDeps
    ) => {
      builds.push(loaded.def.id);
      if (loaded.def.id === failFor) throw new Error(`boom building ${loaded.def.id}`);
      return buildPipelineWorkflow(loaded, deps);
    };
    const { loaded: startupPipelines } = loadCatalogPipelines(resolveCatalog(projectDir));
    const workflows: Record<string, ReturnType<typeof buildPipelineWorkflow>> = {};
    const initialPipelines: LoadedPipeline[] = [];
    const initialFailures: { loaded: LoadedPipeline; message: string }[] = [];
    for (const { loaded } of startupPipelines) {
      try {
        workflows[loaded.def.id] = buildFn(loaded, buildDeps);
        initialPipelines.push(loaded);
      } catch (err) {
        initialFailures.push({ loaded, message: (err as Error).message });
      }
    }
    return createDynamicMastra(
      new Mastra({ storage: mastraStorage, workflows }) as unknown as MastraLike,
      {
        MastraClass: Mastra,
        mastraStorage,
        buildFn,
        buildDeps,
        resolveCatalog: () => resolveCatalog(projectDir),
        initialPipelines,
        initialFailures,
      }
    );
  }

  async function runToEnd(dyn: ReturnType<typeof createDynamicMastra>, id: string) {
    const run = await dyn.getWorkflow(id).createRun();
    return run.start({ inputData: {} });
  }

  beforeEach(() => {
    projectDir = realpathSync(mkdtempSync(join(tmpdir(), "agent-flows-fr8-proj-")));
    mastraDir = realpathSync(mkdtempSync(join(tmpdir(), "agent-flows-fr8-mastra-")));
    prompts = [];
    builds = [];
  });
  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(mastraDir, { recursive: true, force: true });
  });

  it("runs the edited prompt text and the added step, not the startup build", async () => {
    writePipeline("edited", ["first"], "OLD");
    const dyn = startup();

    writePipeline("edited", ["first", "second"], "NEW");
    const result = await runToEnd(dyn, "edited");

    assert.equal(result.status, "success");
    assert.deepEqual(prompts, ["NEW first", "NEW second"]);
  });

  it("returns the same workflow object, without rebuilding, while nothing was edited", () => {
    writePipeline("steady", ["only"], "SAME");
    const dyn = startup();
    const before = builds.length;

    const first = dyn.getWorkflow("steady");
    const second = dyn.getWorkflow("steady");

    assert.equal(first, second);
    assert.equal(builds.length, before, "an unchanged catalogue must not trigger a build");
  });

  it("a pipeline whose build throws does not block a healthy one, and its error names it", async () => {
    writePipeline("healthy", ["a"], "H1");
    writePipeline("broken", ["a"], "B1");
    const dyn = startup("broken");

    writePipeline("healthy", ["a"], "H2");
    const result = await runToEnd(dyn, "healthy");
    assert.equal(result.status, "success");
    assert.deepEqual(prompts, ["H2 a"]);

    assert.throws(
      () => dyn.getWorkflow("broken"),
      (err: Error) => err.message.includes("broken") && err.message.includes("boom building broken")
    );
  });

  it("a pipeline that failed to build at startup throws named, without rebuilding, and spares the rest", () => {
    writePipeline("healthy", ["a"], "H1");
    writePipeline("broken", ["a"], "B1");
    const dyn = startup("broken");
    const before = builds.length;

    assert.throws(
      () => dyn.getWorkflow("broken"),
      (err: Error) => err.message.includes("broken") && err.message.includes("boom building broken")
    );
    assert.equal(dyn.getWorkflow("healthy"), dyn.getWorkflow("healthy"));
    assert.equal(builds.length, before, "recorded startup failures must not be rebuilt per call");
  });

  it("an edit that breaks the YAML throws the load error instead of running the old build", () => {
    writePipeline("fragile", ["a"], "OK");
    const dyn = startup();
    assert.ok(dyn.getWorkflow("fragile"));

    writeFileSync(pipelineFile("fragile"), "id: fragile\nversion: 1\nsteps: [this is: not valid");

    assert.throws(() => dyn.getWorkflow("fragile"));
    assert.deepEqual(prompts, [], "nothing may have run");
  });

  it("a deleted pipeline throws instead of running from the cache", () => {
    writePipeline("doomed", ["a"], "OK");
    const dyn = startup();
    assert.ok(dyn.getWorkflow("doomed"));

    rmSync(pipelineFile("doomed"));

    assert.throws(() => dyn.getWorkflow("doomed"), /doomed/);
  });

  it("carries a neighbour forward when it breaks during another pipeline's rebuild", async () => {
    writePipeline("neighbour", ["a"], "N1");
    writePipeline("target", ["a"], "T1");
    const dyn = startup();
    const original = dyn.getWorkflow("neighbour");

    // Break the neighbour so it still parses (it keeps a catalogue entry) but no
    // longer loads (llm step without a prompt), then edit the target so a
    // rebuild happens. A file that does not even parse has no entry and is
    // dropped from the new instance instead, which is harmless: it fails closed
    // and a revert just rebuilds.
    const good = readFileSync(pipelineFile("neighbour"), "utf8");
    writeFileSync(
      pipelineFile("neighbour"),
      "id: neighbour\nversion: 1\ndescription: x\ninputs: []\nsteps:\n  - id: a\n    kind: llm\n    model: a\n"
    );
    writePipeline("target", ["a"], "T2");
    await runToEnd(dyn, "target");
    assert.throws(() => dyn.getWorkflow("neighbour"), "a broken neighbour still fails closed");

    // Reverting the neighbour to its built content serves the carried workflow:
    // same object, no rebuild, and it runs.
    writeFileSync(pipelineFile("neighbour"), good);
    const buildsBefore = builds.length;
    assert.equal(dyn.getWorkflow("neighbour"), original);
    assert.equal(builds.length, buildsBefore);
    prompts.length = 0;
    assert.equal((await runToEnd(dyn, "neighbour")).status, "success");
    assert.deepEqual(prompts, ["N1 a"]);
  });

  it("a run suspended at a gate completes on its original workflow after an edit rebuilt", async () => {
    const root = join(projectDir, ".agent-flows");
    mkdirSync(join(root, "pipelines"), { recursive: true });
    mkdirSync(join(root, "prompts"), { recursive: true });
    const gated = (text: string): void => {
      writeFileSync(
        join(root, "pipelines", "gated.yaml"),
        "id: gated\nversion: 1\ndescription: gate fixture\ninputs: []\nsteps:\n" +
          "  - id: first\n    kind: llm\n    model: first\n    prompt: prompts/gated-first.md\n" +
          "  - id: approve\n    kind: gate\n    message: ok?\n    dependsOn: [first]\n"
      );
      writeFileSync(join(root, "prompts", "gated-first.md"), text);
    };
    gated("A-BUILD");
    const dyn = startup();

    const runA = await dyn.getWorkflow("gated").createRun();
    const startedA = await runA.start({ inputData: {} });
    assert.equal(startedA.status, "suspended");
    assert.ok(Array.isArray(startedA.suspended), "A must report where it suspended");

    gated("B-BUILD");
    const runB = await dyn.getWorkflow("gated").createRun();
    const startedB = await runB.start({ inputData: {} });
    assert.equal(startedB.status, "suspended");
    assert.deepEqual(prompts, ["A-BUILD", "B-BUILD"], "B ran the edited build");

    const resumedA = await runA.resume({
      step: startedA.suspended[0],
      resumeData: { approved: true },
    });
    assert.equal(resumedA.status, "success", "A completes after the instance was swapped");
  });

  it("unregisters the replaced instance's global hooks, but never shuts it down", () => {
    writePipeline("hooked", ["a"], "V1");
    let unregistered = 0;
    let shutdowns = 0;
    const oldInstance = {
      getWorkflow: () => {
        throw new Error("not registered");
      },
      __unregisterHooks: () => {
        unregistered += 1;
      },
      shutdown: () => {
        shutdowns += 1;
      },
    };
    const dyn = createDynamicMastra(oldInstance as unknown as MastraLike, {
      MastraClass: class {
        getWorkflow = (): string => "rebuilt";
      },
      mastraStorage: undefined,
      buildFn: () => "built",
      buildDeps: {},
      resolveCatalog: () => resolveCatalog(projectDir),
    });

    assert.equal(dyn.getWorkflow("hooked") as unknown, "rebuilt");
    assert.equal(unregistered, 1);
    assert.equal(shutdowns, 0);
  });
});
