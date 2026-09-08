// Tests for spec 029 FR-001/FR-002/FR-008: durable artifact writing.
//
// All tests write into mkdtempSync-created directories and clean up afterward.
// No artifacts are written to the repository or the owner's real projects.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, after } from "node:test";
import { RunService } from "./runService.js";
import type { MastraLike } from "./runService.js";

// ── Mock helpers ──────────────────────────────────────────────────────────────

type WatchCallback = (event: Record<string, unknown>) => void;

interface MockRun {
  runId: string;
  watchers: WatchCallback[];
  start: (opts: unknown) => Promise<Record<string, unknown>>;
  resume: (params: unknown) => Promise<Record<string, unknown>>;
  watch: (cb: WatchCallback) => () => void;
}

function makeMockRun(runId: string, startResult: Record<string, unknown>): MockRun {
  const watchers: WatchCallback[] = [];
  return {
    runId,
    watchers,
    start: async () => startResult,
    resume: async () => ({ status: "success", result: { done: true } }),
    watch: (cb) => {
      watchers.push(cb);
      return () => {
        const i = watchers.indexOf(cb);
        if (i !== -1) watchers.splice(i, 1);
      };
    },
  };
}

function makeMastra(run: MockRun): MastraLike {
  return {
    getWorkflow: (_id) => ({
      createRun: async () =>
        run as unknown as Awaited<ReturnType<ReturnType<MastraLike["getWorkflow"]>["createRun"]>>,
    }),
  };
}

function successResult(): Record<string, unknown> {
  return { status: "success", result: { answer: 42 } };
}

function suspendedResult(): Record<string, unknown> {
  return {
    status: "suspended",
    suspended: [["approve"]],
    steps: {
      approve: { suspendPayload: { message: "Approve this spec?", spec: { title: "MySpec" } } },
    },
  };
}

// Stub ProviderProfile for testing.
const stubProfile = { id: "test-provider", roles: { reasoner: "m", worker: "m", scout: "m" } };

// ── Temp directory lifecycle ──────────────────────────────────────────────────

// Each describe block gets its own tmpDir. We collect them and remove at the end.
const dirsToClean: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "af-artifact-test-"));
  dirsToClean.push(dir);
  return dir;
}

after(() => {
  for (const dir of dirsToClean) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Wait for all microtasks and I/O to flush so fire-and-forget writes land. */
async function flushAsync(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  // One extra tick to allow the artifact's mkdir+writeFile chain to complete.
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
}

// ── Tests: FR-001 — artifact written on terminal status ────────────────────

describe("FR-001: artifact written when a run succeeds", () => {
  it("file exists at expected path and is valid JSON", async () => {
    const tmpDir = makeTmpDir();
    const runId = "run-artifact-success-001";
    const pipelineId = "test-pipeline";
    const mockRun = makeMockRun(runId, successResult());
    const service = new RunService(makeMastra(mockRun), undefined, tmpDir, stubProfile);

    await service.start(pipelineId, { request: "test" });
    await flushAsync();

    const artifactPath = join(tmpDir, ".agent-flows", "runs", runId, `${pipelineId}.json`);
    assert.ok(existsSync(artifactPath), `artifact must exist at ${artifactPath}`);

    const raw = readFileSync(artifactPath, "utf8");
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      assert.fail("artifact must be valid JSON");
    }

    // Core GetResult fields.
    assert.equal(parsed.runId, runId, "artifact.runId must match");
    assert.equal(parsed.pipelineId, pipelineId, "artifact.pipelineId must match");
    assert.equal(parsed.status, "succeeded", "artifact.status must be succeeded");

    // Provenance block.
    assert.ok(parsed.provenance !== undefined, "artifact must contain provenance");
    const prov = parsed.provenance as Record<string, unknown>;
    assert.equal(prov.pipelineId, pipelineId, "provenance.pipelineId must match");
    assert.equal(
      prov.profileId,
      "test-provider",
      "provenance.profileId must match injected profile"
    );
    assert.ok(
      typeof prov.transportPerStep === "object",
      "provenance.transportPerStep must be an object"
    );
    assert.ok(typeof prov.startedAt === "string", "provenance.startedAt must be a string");
    assert.ok(typeof prov.settledAt === "string", "provenance.settledAt must be a string");
    // ISO-8601: parseable as a Date.
    assert.ok(!isNaN(Date.parse(String(prov.startedAt))), "provenance.startedAt must be ISO-8601");
    assert.ok(!isNaN(Date.parse(String(prov.settledAt))), "provenance.settledAt must be ISO-8601");
  });
});

// ── Tests: FR-001 — artifact written on gate suspension ───────────────────

describe("FR-001: artifact written when a run suspends at a gate", () => {
  it("file exists and status is awaiting_approval", async () => {
    const tmpDir = makeTmpDir();
    const runId = "run-artifact-gate-001";
    const pipelineId = "gate-pipeline";
    const mockRun = makeMockRun(runId, suspendedResult());
    const service = new RunService(makeMastra(mockRun), undefined, tmpDir, stubProfile);

    await service.start(pipelineId, {});
    await flushAsync();

    const artifactPath = join(tmpDir, ".agent-flows", "runs", runId, `${pipelineId}.json`);
    assert.ok(existsSync(artifactPath), "artifact must be written at gate suspension");

    const parsed = JSON.parse(readFileSync(artifactPath, "utf8")) as Record<string, unknown>;
    assert.equal(parsed.status, "awaiting_approval", "artifact status must be awaiting_approval");
    assert.ok(parsed.provenance !== undefined, "artifact must contain provenance");
  });
});

// ── Tests: artifact readable without daemon ────────────────────────────────

describe("FR-001/FR-007: artifact is readable after the service is garbage-collected", () => {
  it("file exists on disk and is parseable with no service instance alive", async () => {
    const tmpDir = makeTmpDir();
    const runId = "run-artifact-nodaemon-001";
    const pipelineId = "nodaemon-pipeline";

    // Write via service — simulates the daemon running.
    {
      const mockRun = makeMockRun(runId, successResult());
      const service = new RunService(makeMastra(mockRun), undefined, tmpDir, stubProfile);
      await service.start(pipelineId, {});
      await flushAsync();
      // `service` goes out of scope here — simulates daemon stopped.
    }

    // Now read directly from disk — no service involved.
    const artifactPath = join(tmpDir, ".agent-flows", "runs", runId, `${pipelineId}.json`);
    assert.ok(existsSync(artifactPath), "artifact must persist on disk after service is gone");

    const raw = readFileSync(artifactPath, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    assert.equal(parsed.runId, runId, "artifact is self-contained: runId readable without daemon");
    assert.equal(parsed.status, "succeeded", "artifact status readable without daemon");
    assert.ok(parsed.provenance !== undefined, "provenance readable without daemon");
    const prov = parsed.provenance as Record<string, unknown>;
    assert.equal(prov.profileId, "test-provider", "profileId readable without daemon");
  });
});

// ── Tests: FR-008 — .gitignore management ────────────────────────────────

describe("FR-008: .agent-flows/.gitignore gets a runs/ line", () => {
  it("creates .gitignore with runs/ when it does not exist", async () => {
    const tmpDir = makeTmpDir();
    const runId = "run-gitignore-create-001";
    const pipelineId = "gi-pipeline";
    const mockRun = makeMockRun(runId, successResult());
    const service = new RunService(makeMastra(mockRun), undefined, tmpDir, stubProfile);

    await service.start(pipelineId, {});
    await flushAsync();

    const gitignorePath = join(tmpDir, ".agent-flows", ".gitignore");
    assert.ok(existsSync(gitignorePath), ".gitignore must be created");
    const content = readFileSync(gitignorePath, "utf8");
    assert.ok(
      content
        .split("\n")
        .map((l) => l.trim())
        .includes("runs/"),
      ".gitignore must contain the runs/ line"
    );
  });

  it("appends runs/ to an existing .gitignore that lacks it, preserving other content", async () => {
    const tmpDir = makeTmpDir();
    // Create .agent-flows/ and pre-populate .gitignore with custom content.
    const agentFlowsDir = join(tmpDir, ".agent-flows");
    mkdirSync(agentFlowsDir, { recursive: true });
    const gitignorePath = join(agentFlowsDir, ".gitignore");
    const originalContent = "# operator custom content\n*.tmp\ncache/\n";
    writeFileSync(gitignorePath, originalContent, "utf8");

    const runId = "run-gitignore-append-001";
    const pipelineId = "gi-append-pipeline";
    const mockRun = makeMockRun(runId, successResult());
    const service = new RunService(makeMastra(mockRun), undefined, tmpDir, stubProfile);

    await service.start(pipelineId, {});
    await flushAsync();

    const content = readFileSync(gitignorePath, "utf8");
    // Original content must be preserved.
    assert.ok(content.includes("# operator custom content"), "existing content must be preserved");
    assert.ok(content.includes("*.tmp"), "existing content must be preserved");
    assert.ok(content.includes("cache/"), "existing content must be preserved");
    // runs/ must have been appended.
    assert.ok(
      content
        .split("\n")
        .map((l) => l.trim())
        .includes("runs/"),
      "runs/ must be appended"
    );
  });

  it("does not add runs/ again when it is already present", async () => {
    const tmpDir = makeTmpDir();
    const agentFlowsDir = join(tmpDir, ".agent-flows");
    mkdirSync(agentFlowsDir, { recursive: true });
    const gitignorePath = join(agentFlowsDir, ".gitignore");
    const originalContent = "# pre-existing\nruns/\ncache/\n";
    writeFileSync(gitignorePath, originalContent, "utf8");

    const runId = "run-gitignore-noop-001";
    const pipelineId = "gi-noop-pipeline";
    const mockRun = makeMockRun(runId, successResult());
    const service = new RunService(makeMastra(mockRun), undefined, tmpDir, stubProfile);

    await service.start(pipelineId, {});
    await flushAsync();

    const content = readFileSync(gitignorePath, "utf8");
    // Content must be identical — no duplicate line added.
    assert.equal(
      content,
      originalContent,
      ".gitignore must not be modified when runs/ already present"
    );
  });
});

// ── Tests: no credential in artifact ─────────────────────────────────────

describe("Security: no credential-shaped values in artifacts", () => {
  it("artifact JSON contains no API key env-var names or secret patterns", async () => {
    const tmpDir = makeTmpDir();
    const runId = "run-artifact-nosecret-001";
    const pipelineId = "nosecret-pipeline";
    const mockRun = makeMockRun(runId, successResult());
    const service = new RunService(makeMastra(mockRun), undefined, tmpDir, stubProfile);

    await service.start(pipelineId, {});
    await flushAsync();

    const artifactPath = join(tmpDir, ".agent-flows", "runs", runId, `${pipelineId}.json`);
    const raw = readFileSync(artifactPath, "utf8");

    // These patterns indicate a secret value leaking into the artifact.
    // modelId ("opus", "codex", etc.) is intentionally present and is NOT a secret.
    const credentialPatterns = [
      /ANTHROPIC_API_KEY/i,
      /OPENAI_API_KEY/i,
      /LITELLM_VIRTUAL_KEY/i,
      /keyEnv/,
      /sk-[A-Za-z0-9]{20,}/, // OpenAI key format
      /claude[_-]?api[_-]?key/i,
    ];

    for (const pattern of credentialPatterns) {
      assert.ok(
        !pattern.test(raw),
        `artifact must not contain credential-shaped value matching ${String(pattern)}`
      );
    }
  });

  it("artifact provenance.profileId is a profile name, not a secret value", async () => {
    const tmpDir = makeTmpDir();
    const runId = "run-artifact-profileid-001";
    const pipelineId = "profileid-pipeline";
    const mockRun = makeMockRun(runId, successResult());
    // Use a profile id that looks like a registry name, not a key.
    const profile = {
      id: "anthropic",
      roles: { reasoner: "opus", worker: "sonnet", scout: "haiku" },
    };
    const service = new RunService(makeMastra(mockRun), undefined, tmpDir, profile);

    await service.start(pipelineId, {});
    await flushAsync();

    const artifactPath = join(tmpDir, ".agent-flows", "runs", runId, `${pipelineId}.json`);
    const parsed = JSON.parse(readFileSync(artifactPath, "utf8")) as Record<string, unknown>;
    const prov = parsed.provenance as Record<string, unknown>;

    // profileId must be the short name, not a key value.
    assert.equal(prov.profileId, "anthropic");
    assert.ok(
      !(prov.profileId as string).startsWith("sk-"),
      "profileId must not look like an API key"
    );
  });
});

// ── Tests: artifact written even if no projectDir configured ──────────────

describe("FR-001: no artifact written when projectDir is absent", () => {
  it("run completes normally with no projectDir — no error thrown", async () => {
    const runId = "run-artifact-nodir-001";
    const pipelineId = "nodir-pipeline";
    const mockRun = makeMockRun(runId, successResult());
    // Neither judgeDeps nor standaloneProjectDir provided.
    const service = new RunService(makeMastra(mockRun));

    const { status } = await service.start(pipelineId, {});
    assert.equal(status, "running", "run must start successfully");
    await flushAsync();

    const settled = await service.waitForSettled(runId);
    assert.ok(settled !== undefined);
    assert.equal(settled.status, "succeeded", "run must succeed");
  });
});

// ── Tests: failed run also writes artifact ────────────────────────────────

describe("FR-001: artifact written when a run fails", () => {
  it("file exists and status is failed", async () => {
    const tmpDir = makeTmpDir();
    const runId = "run-artifact-fail-001";
    const pipelineId = "fail-pipeline";
    const failResult: Record<string, unknown> = {
      status: "failed",
      error: new Error("Deliberate test failure"),
    };
    const mockRun = makeMockRun(runId, failResult);
    const service = new RunService(makeMastra(mockRun), undefined, tmpDir, stubProfile);

    await service.start(pipelineId, {});
    await flushAsync();

    const artifactPath = join(tmpDir, ".agent-flows", "runs", runId, `${pipelineId}.json`);
    assert.ok(existsSync(artifactPath), "artifact must be written on failure");
    const parsed = JSON.parse(readFileSync(artifactPath, "utf8")) as Record<string, unknown>;
    assert.equal(parsed.status, "failed", "artifact status must be failed");
    assert.ok(parsed.provenance !== undefined, "artifact must contain provenance even on failure");
  });
});
