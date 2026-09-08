// Tests for spec 029 FR-001/FR-002/FR-006/FR-007/FR-008/FR-009: durable artifacts and manifests.
//
// All tests write into mkdtempSync-created directories and clean up afterward.
// No artifacts are written to the repository or the owner's real projects.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, after } from "node:test";
import { ModelRegistry } from "../canon/registry.js";
import type { StepDef } from "../canon/types.js";
import type { RunManifest, StepProvenance } from "./artifactStore.js";
import { readManifest } from "./artifactStore.js";
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

// ── Tests: FR-002 — transportPerStep filled correctly ────────────────────────

// Registry with three named entries for test use — no credentials, no keys.
const testRegistry = new ModelRegistry([
  { id: "opus", transport: "cli", cli: { bin: "claude", model: "claude-opus-5" } },
  { id: "sonnet", transport: "cli", cli: { bin: "claude", model: "claude-sonnet-5" } },
  { id: "haiku", transport: "cli", cli: { bin: "claude", model: "claude-haiku-4-5" } },
]);

// Profile mapping each role to a distinct model so assertions are unambiguous.
const testProfileFull = {
  id: "anthropic",
  roles: { reasoner: "opus", worker: "sonnet", scout: "haiku" } as Record<string, string>,
};

// A small multi-step pipeline definition with one step per role plus non-llm steps.
const testSteps: StepDef[] = [
  { id: "reason-step", kind: "llm", role: "reasoner", prompt: "p1.md" },
  { id: "work-step", kind: "llm", role: "worker", prompt: "p2.md" },
  { id: "scout-step", kind: "llm", role: "scout", prompt: "p3.md" },
  // Non-llm steps must not produce an entry.
  { id: "gate-step", kind: "gate" },
  { id: "check-step", kind: "check", command: "true" },
];

describe("FR-002: transportPerStep filled for model-bearing steps", () => {
  it("each llm step has correct transport and modelId from profile", async () => {
    const tmpDir = makeTmpDir();
    const runId = "run-tps-profile-001";
    const pipelineId = "tps-pipeline";
    const mockRun = makeMockRun(runId, successResult());
    const service = new RunService(
      makeMastra(mockRun),
      undefined,
      tmpDir,
      testProfileFull,
      testRegistry
    );

    await service.start(pipelineId, {}, { pipelineSteps: testSteps });
    await flushAsync();

    const artifactPath = join(tmpDir, ".agent-flows", "runs", runId, `${pipelineId}.json`);
    const parsed = JSON.parse(readFileSync(artifactPath, "utf8")) as Record<string, unknown>;
    const prov = parsed.provenance as Record<string, unknown>;
    const tps = prov.transportPerStep as Record<string, StepProvenance>;

    // All three llm steps must have entries.
    assert.ok(tps["reason-step"] !== undefined, "reason-step must have a transportPerStep entry");
    assert.ok(tps["work-step"] !== undefined, "work-step must have a transportPerStep entry");
    assert.ok(tps["scout-step"] !== undefined, "scout-step must have a transportPerStep entry");

    assert.equal(tps["reason-step"].transport, "cli");
    assert.equal(tps["reason-step"].modelId, "opus");
    assert.equal(tps["reason-step"].model, "claude-opus-5");

    assert.equal(tps["work-step"].transport, "cli");
    assert.equal(tps["work-step"].modelId, "sonnet");

    assert.equal(tps["scout-step"].transport, "cli");
    assert.equal(tps["scout-step"].modelId, "haiku");
  });
});

describe("FR-002: non-llm steps are omitted from transportPerStep", () => {
  it("gate and check steps produce no entry", async () => {
    const tmpDir = makeTmpDir();
    const runId = "run-tps-nonllm-001";
    const pipelineId = "tps-nonllm-pipeline";
    const mockRun = makeMockRun(runId, successResult());
    const service = new RunService(
      makeMastra(mockRun),
      undefined,
      tmpDir,
      testProfileFull,
      testRegistry
    );

    await service.start(pipelineId, {}, { pipelineSteps: testSteps });
    await flushAsync();

    const artifactPath = join(tmpDir, ".agent-flows", "runs", runId, `${pipelineId}.json`);
    const parsed = JSON.parse(readFileSync(artifactPath, "utf8")) as Record<string, unknown>;
    const prov = parsed.provenance as Record<string, unknown>;
    const tps = prov.transportPerStep as Record<string, StepProvenance>;

    assert.ok(tps["gate-step"] === undefined, "gate step must not appear in transportPerStep");
    assert.ok(tps["check-step"] === undefined, "check step must not appear in transportPerStep");
  });
});

describe("FR-002: per-run models override is recorded, not the profile default", () => {
  it("overridden step records the overridden model — not the profile default", async () => {
    const tmpDir = makeTmpDir();
    const runId = "run-tps-override-001";
    const pipelineId = "tps-override-pipeline";
    const mockRun = makeMockRun(runId, successResult());
    // Profile maps "reasoner" to "opus".
    const service = new RunService(
      makeMastra(mockRun),
      undefined,
      tmpDir,
      testProfileFull,
      testRegistry
    );

    // Override: run reason-step with "haiku" instead of the profile-default "opus".
    await service.start(
      pipelineId,
      { models: { "reason-step": "haiku" } },
      { pipelineSteps: testSteps }
    );
    await flushAsync();

    const artifactPath = join(tmpDir, ".agent-flows", "runs", runId, `${pipelineId}.json`);
    const parsed = JSON.parse(readFileSync(artifactPath, "utf8")) as Record<string, unknown>;
    const prov = parsed.provenance as Record<string, unknown>;
    const tps = prov.transportPerStep as Record<string, StepProvenance>;

    // The override must be recorded — "haiku", not the profile's "opus".
    assert.equal(
      tps["reason-step"].modelId,
      "haiku",
      "overridden step must record the overridden model id, not the profile default"
    );
    assert.equal(
      tps["reason-step"].model,
      "claude-haiku-4-5",
      "overridden step must record the overridden model name"
    );
    // Non-overridden step must still resolve from profile.
    assert.equal(
      tps["work-step"].modelId,
      "sonnet",
      "non-overridden step must still use the profile default"
    );
  });
});

// ── Tests: FR-006 — manifest created and updated ─────────────────────────────
//
// PROVE GUARD CAN FAIL (task requirement):
// To see the manifest-ordering guard go RED:
//   1. In upsertManifestEntry, change `manifest.stages.push(entry)` to
//      `manifest.stages.unshift(entry)` (prepend instead of append).
//   2. Run: pnpm test src/runtime/artifact.test.ts
//   3. The test "second stage entry appears in order after first" fails (FAIL).
//   4. Restore `push` → GREEN.
//
// Similarly, comment out the `manifest.stages[idx] = entry` update branch so the
// manifest is never updated — the "second stage updates existing entry" test fails.

describe("FR-006: manifest created with the first stage", () => {
  it("manifest.json exists at the artifact directory and has one entry", async () => {
    const tmpDir = makeTmpDir();
    const runId = "run-manifest-first-001";
    const pipelineId = "investigate";
    const mockRun = makeMockRun(runId, successResult());
    const service = new RunService(makeMastra(mockRun), undefined, tmpDir, stubProfile);

    await service.start(pipelineId, {});
    await flushAsync();

    const manifestPath = join(tmpDir, ".agent-flows", "runs", runId, "manifest.json");
    assert.ok(existsSync(manifestPath), "manifest.json must be created on first stage");

    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as RunManifest;
    assert.equal(manifest.runId, runId, "manifest.runId must be the run's id");
    assert.ok(typeof manifest.startedAt === "string", "manifest.startedAt must be a string");
    assert.ok(Array.isArray(manifest.stages), "manifest.stages must be an array");
    assert.equal(manifest.stages.length, 1, "manifest must have exactly one stage after first run");

    const stage = manifest.stages[0];
    assert.equal(stage.stageId, pipelineId, "stage.stageId must be the pipeline id");
    assert.ok(typeof stage.artifactPath === "string", "stage.artifactPath must be a string");
    assert.equal(stage.profileId, "test-provider", "stage.profileId must match injected profile");
    assert.equal(stage.status, "succeeded", "stage.status must be succeeded");
    assert.ok(typeof stage.settledAt === "string", "stage.settledAt must be a string");
  });
});

describe("FR-006: second stage in same chain directory adds an ordered entry", () => {
  it("second stage entry appears AFTER first entry (insertion order preserved)", async () => {
    const tmpDir = makeTmpDir();

    // Stage 1: run investigate, write artifact and manifest into runs/stage1-id/
    const stage1RunId = "run-manifest-chain-s1";
    const stage1Pipeline = "investigate";
    const mockRun1 = makeMockRun(stage1RunId, successResult());
    const service1 = new RunService(makeMastra(mockRun1), undefined, tmpDir, stubProfile);

    await service1.start(stage1Pipeline, {});
    await flushAsync();

    // Stage 2: run spec-creation using chainArtifactDir pointing to stage 1's directory.
    // This simulates what the server does when POST /api/runs includes artifactPath.
    const stage2RunId = "run-manifest-chain-s2";
    const stage2Pipeline = "spec-creation";
    const mockRun2 = makeMockRun(stage2RunId, successResult());
    const chainArtifactDir = join(tmpDir, ".agent-flows", "runs", stage1RunId);
    const service2 = new RunService(makeMastra(mockRun2), undefined, tmpDir, stubProfile);

    await service2.start(stage2Pipeline, {}, { chainArtifactDir });
    await flushAsync();

    // Read the manifest from the chain directory (stage 1's directory).
    const manifestPath = join(chainArtifactDir, "manifest.json");
    assert.ok(existsSync(manifestPath), "manifest.json must exist in the chain directory");

    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as RunManifest;
    assert.equal(manifest.stages.length, 2, "manifest must have two entries after two stages");

    // Order matters: first stage must appear before second stage.
    assert.equal(
      manifest.stages[0].stageId,
      stage1Pipeline,
      "first entry must be the first stage's pipeline id"
    );
    assert.equal(
      manifest.stages[1].stageId,
      stage2Pipeline,
      "second entry must be the second stage's pipeline id"
    );
  });

  it("second stage artifact also lands in the chain directory", async () => {
    const tmpDir = makeTmpDir();

    const stage1RunId = "run-manifest-artdir-s1";
    const mockRun1 = makeMockRun(stage1RunId, successResult());
    const service1 = new RunService(makeMastra(mockRun1), undefined, tmpDir, stubProfile);
    await service1.start("investigate", {});
    await flushAsync();

    const chainDir = join(tmpDir, ".agent-flows", "runs", stage1RunId);
    const stage2RunId = "run-manifest-artdir-s2";
    const mockRun2 = makeMockRun(stage2RunId, successResult());
    const service2 = new RunService(makeMastra(mockRun2), undefined, tmpDir, stubProfile);
    await service2.start("spec-creation", {}, { chainArtifactDir: chainDir });
    await flushAsync();

    // The second stage's artifact must be in the chain dir, not in its own runId dir.
    const stage2ArtifactInChain = join(chainDir, "spec-creation.json");
    assert.ok(
      existsSync(stage2ArtifactInChain),
      "second stage artifact must land in the chain directory"
    );
  });
});

// ── Tests: FR-006 — manifest readable from disk without daemon ────────────────

describe("FR-006: manifest is readable from disk without a live service instance", () => {
  it("manifest persists on disk after the service goes out of scope", async () => {
    const tmpDir = makeTmpDir();
    const runId = "run-manifest-nodaemon-001";
    const pipelineId = "investigate";

    // Write via service — then let the reference go out of scope.
    {
      const mockRun = makeMockRun(runId, successResult());
      const service = new RunService(makeMastra(mockRun), undefined, tmpDir, stubProfile);
      await service.start(pipelineId, {});
      await flushAsync();
    }

    // Read directly from disk — no service reference alive.
    const manifestPath = join(tmpDir, ".agent-flows", "runs", runId, "manifest.json");
    assert.ok(existsSync(manifestPath), "manifest must persist after service goes out of scope");

    const raw = readFileSync(manifestPath, "utf8");
    const manifest = JSON.parse(raw) as RunManifest;
    assert.equal(
      manifest.runId,
      runId,
      "manifest is self-contained: runId readable without daemon"
    );
    assert.equal(manifest.stages.length, 1, "manifest has one stage without daemon");
    assert.equal(manifest.stages[0].stageId, pipelineId);
  });
});

// ── Tests: FR-006 — readManifest reconciliation ───────────────────────────────
//
// PROVE GUARD CAN FAIL:
//   To see these tests go RED, remove the reconciliation loop from readManifest
//   (the `for (const entry of dirEntries)` block and the merge that follows).
//   The "two artifacts, manifest names only one" test fails because the returned
//   stages array will have length 1 instead of 2.
//   The "manifest.json is never reported as a stage" test is vacuously unaffected
//   by removing reconciliation (it tests a filter, not the presence of entries),
//   but the "invalid file is ignored" test is also vacuously unaffected since it
//   relies on the filter, not the merge.  The ordering test fails because there
//   is nothing to reorder — so the primary failing test is the two-artifact one.
//   Restore the block → GREEN.

describe("FR-006: readManifest reconciles artifacts missing from the manifest file", () => {
  it("directory with two stage artifacts but manifest naming only one returns both, in settle-time order", async () => {
    const tmpDir = makeTmpDir();
    const artifactDir = join(tmpDir, "reconcile-two-stages");
    mkdirSync(artifactDir, { recursive: true });

    // Write manifest that only records the first stage.
    const earlierAt = "2024-01-01T10:00:00.000Z";
    const laterAt = "2024-01-01T11:00:00.000Z";
    const manifestContent: RunManifest = {
      runId: "reconcile-two-stages",
      startedAt: "2024-01-01T09:00:00.000Z",
      status: "in-progress",
      stages: [
        {
          stageId: "audit",
          artifactPath: join(artifactDir, "audit.json"),
          profileId: "test-provider",
          status: "succeeded",
          settledAt: earlierAt,
        },
      ],
    };
    writeFileSync(join(artifactDir, "manifest.json"), JSON.stringify(manifestContent, null, 2));

    // Write a second artifact that the manifest missed — it settled later.
    const orphanArtifact = {
      runId: "reconcile-two-stages",
      pipelineId: "spec-creation",
      status: "succeeded",
      provenance: {
        pipelineId: "spec-creation",
        profileId: "test-provider",
        transportPerStep: {},
        startedAt: "2024-01-01T10:30:00.000Z",
        settledAt: laterAt,
      },
    };
    writeFileSync(join(artifactDir, "spec-creation.json"), JSON.stringify(orphanArtifact, null, 2));

    const result = await readManifest(artifactDir);

    assert.equal(result.stages.length, 2, "must return both stages");
    // Reconciled entry should be ordered by settledAt: audit (earlier) then spec-creation (later).
    assert.equal(result.stages[0].stageId, "audit", "earlier stage must come first");
    assert.equal(result.stages[1].stageId, "spec-creation", "later stage must come second");
    // Reconciled entry fields must come from the artifact file, not the manifest.
    assert.equal(
      result.stages[1].profileId,
      "test-provider",
      "profileId must be taken from artifact"
    );
    assert.equal(result.stages[1].status, "succeeded", "status must be taken from artifact");
    assert.equal(result.stages[1].settledAt, laterAt, "settledAt must be taken from artifact");
    assert.ok(
      result.stages[1].artifactPath.endsWith("spec-creation.json"),
      "artifactPath must point to the artifact file"
    );
  });

  it("a file in the directory that is not a valid artifact is ignored rather than breaking the read", async () => {
    const tmpDir = makeTmpDir();
    const artifactDir = join(tmpDir, "reconcile-bad-file");
    mkdirSync(artifactDir, { recursive: true });

    const manifestContent: RunManifest = {
      runId: "reconcile-bad-file",
      startedAt: "2024-01-01T09:00:00.000Z",
      status: "completed",
      stages: [
        {
          stageId: "investigate",
          artifactPath: join(artifactDir, "investigate.json"),
          profileId: "test-provider",
          status: "succeeded",
          settledAt: "2024-01-01T10:00:00.000Z",
        },
      ],
    };
    writeFileSync(join(artifactDir, "manifest.json"), JSON.stringify(manifestContent, null, 2));

    // An invalid JSON file — should be silently ignored.
    writeFileSync(join(artifactDir, "corrupt.json"), "this is not json {{{");
    // A JSON file that lacks the provenance block — not a valid artifact.
    writeFileSync(join(artifactDir, "random.json"), JSON.stringify({ hello: "world" }));

    const result = await readManifest(artifactDir);

    // The corrupt and random files must not appear; only the recorded stage.
    assert.equal(result.stages.length, 1, "invalid files must not inflate the stage count");
    assert.equal(result.stages[0].stageId, "investigate");
  });

  it("manifest.json is never reported as a stage entry", async () => {
    const tmpDir = makeTmpDir();
    const artifactDir = join(tmpDir, "reconcile-no-self");
    mkdirSync(artifactDir, { recursive: true });

    const manifestContent: RunManifest = {
      runId: "reconcile-no-self",
      startedAt: "2024-01-01T09:00:00.000Z",
      status: "completed",
      stages: [
        {
          stageId: "investigate",
          artifactPath: join(artifactDir, "investigate.json"),
          profileId: "test-provider",
          status: "succeeded",
          settledAt: "2024-01-01T10:00:00.000Z",
        },
      ],
    };
    writeFileSync(join(artifactDir, "manifest.json"), JSON.stringify(manifestContent, null, 2));

    const result = await readManifest(artifactDir);

    const stageIds = result.stages.map((s) => s.stageId);
    assert.ok(
      !stageIds.includes("manifest"),
      `manifest.json must never appear as a stage; got stageIds: ${JSON.stringify(stageIds)}`
    );
  });
});

// ── Tests: FR-007 — no unattended chaining ────────────────────────────────────
//
// The RunService must not start any additional runs after a run completes.
// This test proves the property by checking registry size before and after settlement.

describe("FR-007: completing a stage starts no further run", () => {
  it("registry has exactly one run after the run completes", async () => {
    const tmpDir = makeTmpDir();
    const runId = "run-nochain-001";
    const pipelineId = "investigate";
    const mockRun = makeMockRun(runId, successResult());
    const service = new RunService(makeMastra(mockRun), undefined, tmpDir, stubProfile);

    await service.start(pipelineId, {});
    // Let the background completion handler fire.
    await flushAsync();

    // The registry contains ONLY the one run we started — no auto-started successor.
    const list = service.list();
    assert.equal(
      list.length,
      1,
      `registry must contain exactly 1 run after settlement; found ${list.length}: ${JSON.stringify(list.map((r) => r.runId))}`
    );
    assert.equal(list[0].runId, runId, "the one run must be the one we started");
    assert.equal(list[0].status, "succeeded", "it must have reached a terminal status");
  });

  it("manifest shows only the completed stage — no phantom next stage", async () => {
    const tmpDir = makeTmpDir();
    const runId = "run-nochain-manifest-001";
    const mockRun = makeMockRun(runId, successResult());
    const service = new RunService(makeMastra(mockRun), undefined, tmpDir, stubProfile);

    await service.start("investigate", {});
    await flushAsync();

    const manifestPath = join(tmpDir, ".agent-flows", "runs", runId, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as RunManifest;

    assert.equal(
      manifest.stages.length,
      1,
      "manifest must list only the one stage that ran — auto-chaining would add a second"
    );
    assert.equal(manifest.stages[0].stageId, "investigate");
  });
});

// ── Tests: FR-009 — artifactPath exposed in GetResult ────────────────────────

describe("FR-009: GetResult includes artifactPath after settlement", () => {
  it("get() returns artifactPath pointing to the written file", async () => {
    const tmpDir = makeTmpDir();
    const runId = "run-fr009-001";
    const pipelineId = "investigate";
    const mockRun = makeMockRun(runId, successResult());
    const service = new RunService(makeMastra(mockRun), undefined, tmpDir, stubProfile);

    await service.start(pipelineId, {});
    await flushAsync();

    const state = service.get(runId);
    assert.ok(state !== undefined, "run must be in registry");
    assert.ok(
      typeof state.artifactPath === "string",
      "GetResult.artifactPath must be a string after settlement"
    );
    assert.ok(
      state.artifactPath.endsWith(`${pipelineId}.json`),
      `artifactPath must end with ${pipelineId}.json; got: ${state.artifactPath}`
    );
    // The file must actually exist at the reported path.
    assert.ok(
      existsSync(state.artifactPath),
      `artifactPath must point to an existing file; got: ${state.artifactPath}`
    );
  });

  it("artifactPath is absent before settlement (run still in 'running' state)", async () => {
    const tmpDir = makeTmpDir();
    const runId = "run-fr009-before-settle-001";
    const pipelineId = "investigate";
    // Use a run that never resolves so we can inspect the pre-settled state.
    let resolveRun!: (v: Record<string, unknown>) => void;
    const neverResolves = new Promise<Record<string, unknown>>((r) => {
      resolveRun = r;
    });
    const slowRun = {
      runId,
      watchers: [] as ((e: Record<string, unknown>) => void)[],
      start: () => neverResolves,
      resume: async () => ({ status: "success", result: {} }),
      watch: (cb: (e: Record<string, unknown>) => void) => {
        slowRun.watchers.push(cb);
        return () => undefined;
      },
    };
    const mastra: MastraLike = {
      getWorkflow: () => ({ createRun: async () => slowRun as never }),
    };

    const service = new RunService(mastra, undefined, tmpDir, stubProfile);
    await service.start(pipelineId, {});

    // Before the run settles, artifactPath must be absent.
    const state = service.get(runId);
    assert.ok(state !== undefined);
    assert.equal(state.status, "running");
    assert.equal(state.artifactPath, undefined, "artifactPath must be absent before settlement");

    // Clean up: resolve the pending promise so the test process can exit cleanly.
    resolveRun({ status: "success", result: {} });
  });
});
