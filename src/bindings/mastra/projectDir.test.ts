// Tests for resolveProjectDir.
//
// Covers: env-var preference, cwd fallback, missing-directory error, and the
// forwarding path from resolver → buildPipelineWorkflow → step runner (the
// class of bug that caused steps to silently execute in the tool's own repo).

import assert from "node:assert/strict";
import { unlinkSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Mastra } from "@mastra/core/mastra";
import { LibSQLStore } from "@mastra/libsql";
import { ModelRegistry } from "../../canon/registry.js";
import { makeInMemoryDb } from "../../db/index.js";
import { DrizzleTicketStore } from "../../store/sqlite.js";
import { buildPipelineWorkflow } from "./build.js";
import { resolveProjectDir } from "./projectDir.js";
import type { runLlmStep } from "../../canon/runStep.js";

// ── resolveProjectDir ─────────────────────────────────────────────────────────

describe("resolveProjectDir", () => {
  const savedEnv = process.env.AGENT_FLOWS_PROJECT_DIR;

  function restoreEnv() {
    if (savedEnv === undefined) {
      delete process.env.AGENT_FLOWS_PROJECT_DIR;
    } else {
      process.env.AGENT_FLOWS_PROJECT_DIR = savedEnv;
    }
  }

  it("prefers AGENT_FLOWS_PROJECT_DIR when set", async () => {
    const dir = await mkdtemp(join(tmpdir(), "af-pdir-"));
    try {
      process.env.AGENT_FLOWS_PROJECT_DIR = dir;
      assert.equal(resolveProjectDir(), dir);
    } finally {
      restoreEnv();
      await rm(dir, { recursive: true });
    }
  });

  it("falls back to process.cwd() when AGENT_FLOWS_PROJECT_DIR is unset", () => {
    delete process.env.AGENT_FLOWS_PROJECT_DIR;
    try {
      assert.equal(resolveProjectDir(), process.cwd());
    } finally {
      restoreEnv();
    }
  });

  it("throws a clear error when the configured directory does not exist", () => {
    const missing = join(tmpdir(), "af-no-such-dir-xyz-999");
    process.env.AGENT_FLOWS_PROJECT_DIR = missing;
    try {
      assert.throws(() => resolveProjectDir(), { message: /does not exist/ });
    } finally {
      restoreEnv();
    }
  });
});

// ── forwarding: resolver → buildPipelineWorkflow → step runner ────────────────
// Regression guard for the forwarding bug: servers called buildPipelineWorkflow
// without a cwd, so steps always executed in the tool's own checkout regardless
// of which project the operator launched from.

describe("resolveProjectDir → buildPipelineWorkflow forwards cwd to the runner", () => {
  it("the built workflow receives the resolved directory as cwd", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "af-pdir-fwd-"));
    const dbPath = join(tmpdir(), `af-pdir-fwd-${Date.now()}.db`);
    const storage = new LibSQLStore({ id: "test-pdir-fwd", url: `file:${dbPath}` });
    const db = makeInMemoryDb();
    const store = new DrizzleTicketStore(db);
    const registry = new ModelRegistry([]);

    const seen: { dir?: string }[] = [];
    const capturingRunner: typeof runLlmStep = async (_entry, _prompt, runnerDeps) => {
      seen.push({ dir: runnerDeps?.workspaceDir });
      return "ok";
    };

    const pipeline = {
      def: {
        id: "pdir-fwd",
        version: 1,
        description: "cwd forwarding check",
        inputs: ["request"],
        steps: [
          {
            id: "survey",
            kind: "llm" as const,
            model: "sonnet",
            permissions: { contents: "read" as const },
          },
        ],
      },
      prompts: { survey: "look at {{request}}" },
    };

    try {
      // This is the pattern the servers must follow: obtain cwd from
      // resolveProjectDir() and pass it to buildPipelineWorkflow.
      const wf = buildPipelineWorkflow(pipeline, {
        registry,
        store,
        runner: capturingRunner,
        cwd: projectDir,
      });

      const mastra = new Mastra({ storage, workflows: { "pdir-fwd": wf } });
      const run = await mastra.getWorkflow("pdir-fwd").createRun();
      await run.start({ inputData: { request: "audit" } });

      assert.equal(seen.length, 1, "runner called once");
      assert.equal(seen[0].dir, projectDir, "resolved project dir must reach the step runner");
    } finally {
      await rm(projectDir, { recursive: true });
      try {
        unlinkSync(dbPath);
        unlinkSync(`${dbPath}-shm`);
        unlinkSync(`${dbPath}-wal`);
      } catch {
        /* ignore */
      }
    }
  });
});
