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
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { Mastra } from "@mastra/core/mastra";
import { LibSQLStore } from "@mastra/libsql";

import { ModelRegistry } from "../../canon/registry.js";
import { makeInMemoryDb } from "../../db/index.js";
import { RunService, type MastraLike } from "../../runtime/runService.js";
import { startServer, type ServeHandle } from "../../serve/server.js";
import { DrizzleTicketStore } from "../../store/sqlite.js";
import { buildPipelineWorkflow } from "./build.js";
import { createDynamicMastra } from "./dynamicMastra.js";
import { mastraDbPath } from "./paths.js";

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
        projectDir: tmpProjectDir,
      }
    );

    const runService = new RunService(dynamicMastra);

    srv = await startServer({
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
