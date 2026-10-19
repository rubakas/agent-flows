// Tests for spec 029 FR-001/FR-002/FR-006/FR-007/FR-008/FR-009: durable artifacts and manifests.
//
// All tests write into mkdtempSync-created directories and clean up afterward.
// No artifacts are written to the repository or the owner's real projects.

import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  statSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  chmodSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, after } from "node:test";
import { ModelRegistry } from "../canon/registry.js";
import type { LoadedPipeline, StepDef } from "../canon/types.js";
import type { ManifestStage, RunManifest, StepProvenance } from "./artifactStore.js";
import {
  deriveChainStatus,
  listPersistedRuns,
  locateRun,
  setRunLookupClock,
  readManifest,
  readPersistedRun,
  upsertManifestEntry,
  writeRunArtifact,
} from "./artifactStore.js";
import { ensureProjectState, resolveProjectState } from "./projectState.js";
import { RunService } from "./runService.js";
import { recordStep } from "./stepIntrospection.js";
import type { JudgeDeps, MastraLike } from "./runService.js";
import type { RunArtifact } from "./runState.js";

// ── Mock helpers ──────────────────────────────────────────────────────────────

type WatchCallback = (event: Record<string, unknown>) => void;

interface MockRun {
  runId: string;
  watchers: WatchCallback[];
  start: (opts: unknown) => Promise<Record<string, unknown>>;
  resume: (params: unknown) => Promise<Record<string, unknown>>;
  watch: (cb: WatchCallback) => () => void;
  /** Mirrors Mastra's Run.cancel(); RunService refuses to cancel without it. */
  cancel?: () => Promise<void>;
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
    cancel: async () => undefined,
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

/**
 * Resolve the state-dir runs/ directory for a project (spec 032 FR-004).
 * AGENT_FLOWS_HOME is pinned to a temp dir so the owner's real ~/.agent-flows
 * is never touched.
 */
function makeStateRunsDir(projectDir: string): string {
  const home = mkdtempSync(join(tmpdir(), "af-artifact-home-"));
  dirsToClean.push(home);
  return resolveProjectState(projectDir, { AGENT_FLOWS_HOME: home }).runsDir;
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

/** Wait until the run has settled and its artifact write has landed. */
async function settled(service: RunService, runId: string): Promise<void> {
  assert.ok(
    (await service.waitForSettled(runId)) !== undefined,
    `run ${runId} is not live in this service`
  );
}

/** A loaded pipeline around the given steps; the rest of the definition is inert. */
function loadedOf(steps: StepDef[]): LoadedPipeline {
  return {
    def: { id: "test-pipeline", version: 1, description: "", inputs: [], steps },
    prompts: {},
  };
}

/** A complete artifact as the run service writes one, for tests of the writer. */
function sampleRunArtifact(runId: string): RunArtifact {
  return {
    runId,
    pipelineId: "test-pipeline",
    status: "succeeded",
    gateMode: "manual",
    steps: {},
    gateDecisions: [],
    provenance: {
      pipelineId: "test-pipeline",
      profileId: "anthropic",
      transportPerStep: {},
      startedAt: "2026-10-10T10:00:00.000Z",
      settledAt: "2026-10-10T10:05:00.000Z",
    },
  };
}

/** Recursive, sorted list of relative paths under dir — empty when dir is absent. */
function listTree(dir: string, prefix = ""): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = prefix === "" ? e.name : `${prefix}/${e.name}`;
    out.push(rel);
    if (e.isDirectory()) out.push(...listTree(join(dir, e.name), rel));
  }
  return out;
}

// ── Tests: FR-001 — artifact written on terminal status ────────────────────

describe("FR-001: artifact written when a run succeeds", () => {
  it("file exists at expected path and is valid JSON", async () => {
    const tmpDir = makeTmpDir();
    const runsDir = makeStateRunsDir(tmpDir);
    const runId = "run-artifact-success-001";
    const pipelineId = "test-pipeline";
    const mockRun = makeMockRun(runId, successResult());
    const service = new RunService(makeMastra(mockRun), undefined, runsDir, stubProfile);

    await service.start(pipelineId, { request: "test" });
    await settled(service, runId);

    const artifactPath = join(runsDir, runId, `${pipelineId}.json`);
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
    const runsDir = makeStateRunsDir(tmpDir);
    const runId = "run-artifact-gate-001";
    const pipelineId = "gate-pipeline";
    const mockRun = makeMockRun(runId, suspendedResult());
    const service = new RunService(makeMastra(mockRun), undefined, runsDir, stubProfile);

    await service.start(pipelineId, {});
    await settled(service, runId);

    const artifactPath = join(runsDir, runId, `${pipelineId}.json`);
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
    const runsDir = makeStateRunsDir(tmpDir);
    const runId = "run-artifact-nodaemon-001";
    const pipelineId = "nodaemon-pipeline";

    // Write via service — simulates the daemon running.
    {
      const mockRun = makeMockRun(runId, successResult());
      const service = new RunService(makeMastra(mockRun), undefined, runsDir, stubProfile);
      await service.start(pipelineId, {});
      await settled(service, runId);
      // `service` goes out of scope here — simulates daemon stopped.
    }

    // Now read directly from disk — no service involved.
    const artifactPath = join(runsDir, runId, `${pipelineId}.json`);
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

// ── Tests: spec 032 FR-008/V3 — nothing is written into the project tree ──

describe("spec 032 FR-008: a run writes nothing into <project>/.agent-flows", () => {
  it("the canon directory listing is identical before and after startup and a run", async () => {
    const tmpDir = makeTmpDir();
    const home = mkdtempSync(join(tmpdir(), "af-artifact-home-"));
    dirsToClean.push(home);

    // Seed the canon the owner committed: pipelines/, prompts/, providers.yaml, config.json.
    const canonDir = join(tmpDir, ".agent-flows");
    mkdirSync(join(canonDir, "pipelines"), { recursive: true });
    mkdirSync(join(canonDir, "prompts"), { recursive: true });
    writeFileSync(join(canonDir, "pipelines", "test.yaml"), "id: test\n", "utf8");
    writeFileSync(join(canonDir, "prompts", "test.md"), "# test\n", "utf8");
    writeFileSync(join(canonDir, "providers.yaml"), "profiles: {}\n", "utf8");
    writeFileSync(join(canonDir, "config.json"), "{}\n", "utf8");

    const before = listTree(canonDir);

    // The daemon's startup path is part of what must not touch the project tree.
    const { runsDir } = ensureProjectState(tmpDir, { AGENT_FLOWS_HOME: home }, () => undefined);

    const runId = "run-no-project-writes-001";
    const pipelineId = "no-writes-pipeline";
    const mockRun = makeMockRun(runId, successResult());
    const service = new RunService(makeMastra(mockRun), undefined, runsDir, stubProfile);

    await service.start(pipelineId, {});
    await settled(service, runId);

    assert.deepEqual(
      listTree(canonDir),
      before,
      "startup and a run must not add or remove anything under <project>/.agent-flows"
    );
    assert.ok(
      existsSync(join(runsDir, runId, `${pipelineId}.json`)),
      "the artifact must land under the state dir instead"
    );
    assert.ok(
      !existsSync(join(canonDir, ".gitignore")),
      "no .gitignore may be created inside the project"
    );
  });
});

// ── Tests: no credential in artifact ─────────────────────────────────────

describe("Security: no credential-shaped values in artifacts", () => {
  it("artifact JSON contains no API key env-var names or secret patterns", async () => {
    const tmpDir = makeTmpDir();
    const runsDir = makeStateRunsDir(tmpDir);
    const runId = "run-artifact-nosecret-001";
    const pipelineId = "nosecret-pipeline";
    const mockRun = makeMockRun(runId, successResult());
    const service = new RunService(makeMastra(mockRun), undefined, runsDir, stubProfile);

    await service.start(pipelineId, {});
    await settled(service, runId);

    const artifactPath = join(runsDir, runId, `${pipelineId}.json`);
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
    const runsDir = makeStateRunsDir(tmpDir);
    const runId = "run-artifact-profileid-001";
    const pipelineId = "profileid-pipeline";
    const mockRun = makeMockRun(runId, successResult());
    // Use a profile id that looks like a registry name, not a key.
    const profile = {
      id: "anthropic",
      roles: { reasoner: "opus", worker: "sonnet", scout: "haiku" },
    };
    const service = new RunService(makeMastra(mockRun), undefined, runsDir, profile);

    await service.start(pipelineId, {});
    await settled(service, runId);

    const artifactPath = join(runsDir, runId, `${pipelineId}.json`);
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

    const settled = await service.waitForSettled(runId);
    assert.ok(settled !== undefined);
    assert.equal(settled.status, "succeeded", "run must succeed");
  });
});

// ── Tests: failed run also writes artifact ────────────────────────────────

describe("FR-001: artifact written when a run fails", () => {
  it("file exists and status is failed", async () => {
    const tmpDir = makeTmpDir();
    const runsDir = makeStateRunsDir(tmpDir);
    const runId = "run-artifact-fail-001";
    const pipelineId = "fail-pipeline";
    const failResult: Record<string, unknown> = {
      status: "failed",
      error: new Error("Deliberate test failure"),
    };
    const mockRun = makeMockRun(runId, failResult);
    const service = new RunService(makeMastra(mockRun), undefined, runsDir, stubProfile);

    await service.start(pipelineId, {});
    await settled(service, runId);

    const artifactPath = join(runsDir, runId, `${pipelineId}.json`);
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
    const runsDir = makeStateRunsDir(tmpDir);
    const runId = "run-tps-profile-001";
    const pipelineId = "tps-pipeline";
    const mockRun = makeMockRun(runId, successResult());
    const service = new RunService(
      makeMastra(mockRun),
      undefined,
      runsDir,
      testProfileFull,
      testRegistry
    );

    await service.start(pipelineId, {}, { loaded: loadedOf(testSteps) });
    await settled(service, runId);

    const artifactPath = join(runsDir, runId, `${pipelineId}.json`);
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
    const runsDir = makeStateRunsDir(tmpDir);
    const runId = "run-tps-nonllm-001";
    const pipelineId = "tps-nonllm-pipeline";
    const mockRun = makeMockRun(runId, successResult());
    const service = new RunService(
      makeMastra(mockRun),
      undefined,
      runsDir,
      testProfileFull,
      testRegistry
    );

    await service.start(pipelineId, {}, { loaded: loadedOf(testSteps) });
    await settled(service, runId);

    const artifactPath = join(runsDir, runId, `${pipelineId}.json`);
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
    const runsDir = makeStateRunsDir(tmpDir);
    const runId = "run-tps-override-001";
    const pipelineId = "tps-override-pipeline";
    const mockRun = makeMockRun(runId, successResult());
    // Profile maps "reasoner" to "opus".
    const service = new RunService(
      makeMastra(mockRun),
      undefined,
      runsDir,
      testProfileFull,
      testRegistry
    );

    // Override: run reason-step with "haiku" instead of the profile-default "opus".
    await service.start(
      pipelineId,
      {},
      { loaded: loadedOf(testSteps), models: { "reason-step": "haiku" } }
    );
    await settled(service, runId);

    const artifactPath = join(runsDir, runId, `${pipelineId}.json`);
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

describe("spec 039: provenance records the per-run provider, not the startup default", () => {
  it("a run started under another profile records that profile's models", async () => {
    const tmpDir = makeTmpDir();
    const runsDir = makeStateRunsDir(tmpDir);
    const runId = "run-tps-provider-001";
    const pipelineId = "tps-provider-pipeline";
    const mockRun = makeMockRun(runId, successResult());
    // The daemon's startup profile maps reasoner→opus, worker→sonnet.
    const service = new RunService(
      makeMastra(mockRun),
      undefined,
      runsDir,
      testProfileFull,
      testRegistry
    );

    // The run names a different profile: every role resolves to haiku.
    await service.start(
      pipelineId,
      {},
      {
        loaded: loadedOf(testSteps),
        provider: { id: "cheap", roles: { reasoner: "haiku", worker: "haiku", scout: "haiku" } },
      }
    );
    await settled(service, runId);

    const artifactPath = join(runsDir, runId, `${pipelineId}.json`);
    const parsed = JSON.parse(readFileSync(artifactPath, "utf8")) as Record<string, unknown>;
    const prov = parsed.provenance as Record<string, unknown>;
    const tps = prov.transportPerStep as Record<string, StepProvenance>;

    assert.equal(
      tps["reason-step"].modelId,
      "haiku",
      "provenance must name the profile the run actually used"
    );
    assert.equal(tps["work-step"].modelId, "haiku");

    assert.equal(
      prov.profileId,
      "cheap",
      "provenance.profileId must name the run's profile, not the daemon default"
    );

    const invocation = parsed.invocation as Record<string, unknown>;
    assert.equal(invocation.provider, "cheap", "the invocation must record the provider");
    assert.equal(
      (invocation.inputs as Record<string, unknown>).provider,
      undefined,
      "provider is a run control field, not a pipeline input"
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
    const runsDir = makeStateRunsDir(tmpDir);
    const runId = "run-manifest-first-001";
    const pipelineId = "investigate";
    const mockRun = makeMockRun(runId, successResult());
    const service = new RunService(makeMastra(mockRun), undefined, runsDir, stubProfile);

    await service.start(pipelineId, {});
    await settled(service, runId);

    const manifestPath = join(runsDir, runId, "manifest.json");
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
    const runsDir = makeStateRunsDir(tmpDir);

    // Stage 1: run investigate, write artifact and manifest into runs/stage1-id/
    const stage1RunId = "run-manifest-chain-s1";
    const stage1Pipeline = "investigate";
    const mockRun1 = makeMockRun(stage1RunId, successResult());
    const service1 = new RunService(makeMastra(mockRun1), undefined, runsDir, stubProfile);

    await service1.start(stage1Pipeline, {});
    await settled(service1, stage1RunId);

    // Stage 2: run spec-creation using chainArtifactDir pointing to stage 1's directory.
    // This simulates what the server does when POST /api/runs includes artifactPath.
    const stage2RunId = "run-manifest-chain-s2";
    const stage2Pipeline = "spec-creation";
    const mockRun2 = makeMockRun(stage2RunId, successResult());
    const chainArtifactDir = join(runsDir, stage1RunId);
    const service2 = new RunService(makeMastra(mockRun2), undefined, runsDir, stubProfile);

    await service2.start(
      stage2Pipeline,
      {},
      {
        chain: {
          dir: chainArtifactDir,
          artifactPath: join(chainArtifactDir, `${stage1Pipeline}.json`),
        },
      }
    );
    await settled(service2, stage2RunId);

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
    const runsDir = makeStateRunsDir(tmpDir);

    const stage1RunId = "run-manifest-artdir-s1";
    const mockRun1 = makeMockRun(stage1RunId, successResult());
    const service1 = new RunService(makeMastra(mockRun1), undefined, runsDir, stubProfile);
    await service1.start("investigate", {});
    await settled(service1, stage1RunId);

    const chainDir = join(runsDir, stage1RunId);
    const stage2RunId = "run-manifest-artdir-s2";
    const mockRun2 = makeMockRun(stage2RunId, successResult());
    const service2 = new RunService(makeMastra(mockRun2), undefined, runsDir, stubProfile);
    await service2.start(
      "spec-creation",
      {},
      { chain: { dir: chainDir, artifactPath: join(chainDir, "investigate.json") } }
    );
    await settled(service2, stage2RunId);

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
    const runsDir = makeStateRunsDir(tmpDir);
    const runId = "run-manifest-nodaemon-001";
    const pipelineId = "investigate";

    // Write via service — then let the reference go out of scope.
    {
      const mockRun = makeMockRun(runId, successResult());
      const service = new RunService(makeMastra(mockRun), undefined, runsDir, stubProfile);
      await service.start(pipelineId, {});
      await settled(service, runId);
    }

    // Read directly from disk — no service reference alive.
    const manifestPath = join(runsDir, runId, "manifest.json");
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
    const runsDir = makeStateRunsDir(tmpDir);
    const runId = "run-nochain-001";
    const pipelineId = "investigate";
    const mockRun = makeMockRun(runId, successResult());
    const service = new RunService(makeMastra(mockRun), undefined, runsDir, stubProfile);

    await service.start(pipelineId, {});
    // Let the background completion handler fire.
    await settled(service, runId);

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
    const runsDir = makeStateRunsDir(tmpDir);
    const runId = "run-nochain-manifest-001";
    const mockRun = makeMockRun(runId, successResult());
    const service = new RunService(makeMastra(mockRun), undefined, runsDir, stubProfile);

    await service.start("investigate", {});
    await settled(service, runId);

    const manifestPath = join(runsDir, runId, "manifest.json");
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
    const runsDir = makeStateRunsDir(tmpDir);
    const runId = "run-fr009-001";
    const pipelineId = "investigate";
    const mockRun = makeMockRun(runId, successResult());
    const service = new RunService(makeMastra(mockRun), undefined, runsDir, stubProfile);

    await service.start(pipelineId, {});
    await settled(service, runId);

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
    const runsDir = makeStateRunsDir(tmpDir);
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

    const service = new RunService(mastra, undefined, runsDir, stubProfile);
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

// ── Tests: spec 033 FR-004 — the manifest records the cancellation ───────────

describe("spec 033 FR-004: cancelling a run records cancelledAt and reason in the manifest", () => {
  it("the stage entry carries status, cancelledAt and reason", async () => {
    const tmpDir = makeTmpDir();
    const runsDir = makeStateRunsDir(tmpDir);
    const runId = "run-manifest-cancelled-001";

    // A run whose step never settles on its own, so it is still cancellable.
    const pendingRun: MockRun = {
      ...makeMockRun(runId, successResult()),
      start: () => new Promise<Record<string, unknown>>(() => undefined),
    };

    const service = new RunService(makeMastra(pendingRun), undefined, runsDir, stubProfile);
    await service.start("investigate", { request: "x" });

    const result = await service.cancel(runId, "operator stopped it");
    assert.deepEqual(result, { ok: true });
    await settled(service, runId);

    const manifest = await readManifest(join(runsDir, runId));
    assert.ok(manifest, "a cancelled run must still write a manifest");
    assert.equal(manifest.stages.length, 1);
    const stage = manifest.stages[0];
    assert.equal(stage.status, "cancelled");
    assert.equal(stage.reason, "operator stopped it", "the manifest must carry the reason");
    assert.ok(
      typeof stage.cancelledAt === "string",
      "the manifest must carry cancelledAt so a chain reader can see why the stage stopped"
    );
  });
});

// ── Tests: chain status derivation (spec 033 review follow-up) ───────────────

describe("deriveChainStatus: a cancelled stage is terminal, not in-progress", () => {
  const stage = (status: string): ManifestStage => ({
    stageId: `stage-${status}`,
    artifactPath: `/tmp/${status}.json`,
    profileId: "test-provider",
    status,
    settledAt: "2026-09-13T10:00:00.000Z",
  });

  it("a lone cancelled stage makes the chain cancelled", () => {
    assert.equal(
      deriveChainStatus([stage("cancelled")]),
      "cancelled",
      "a fully cancelled chain must not read in-progress forever"
    );
  });

  it("a cancelled stage after a succeeded one makes the chain cancelled", () => {
    assert.equal(deriveChainStatus([stage("succeeded"), stage("cancelled")]), "cancelled");
  });

  it("failed wins over cancelled", () => {
    assert.equal(deriveChainStatus([stage("cancelled"), stage("failed")]), "failed");
    assert.equal(deriveChainStatus([stage("failed"), stage("cancelled")]), "failed");
    assert.equal(deriveChainStatus([stage("cancelled"), stage("rejected")]), "failed");
  });

  it("leaves the pre-existing outcomes untouched", () => {
    assert.equal(deriveChainStatus([]), "in-progress");
    assert.equal(deriveChainStatus([stage("succeeded")]), "completed");
    assert.equal(deriveChainStatus([stage("succeeded"), stage("running")]), "in-progress");
    assert.equal(deriveChainStatus([stage("failed")]), "failed");
  });
});

describe("spec 033 FR-004: a cancelled run's manifest reports the chain as cancelled", () => {
  it("the written manifest's top-level status is cancelled", async () => {
    const tmpDir = makeTmpDir();
    const runsDir = makeStateRunsDir(tmpDir);
    const runId = "run-manifest-chain-cancelled-001";

    const pendingRun: MockRun = {
      ...makeMockRun(runId, successResult()),
      start: () => new Promise<Record<string, unknown>>(() => undefined),
    };

    const service = new RunService(makeMastra(pendingRun), undefined, runsDir, stubProfile);
    await service.start("investigate", { request: "x" });
    assert.deepEqual(await service.cancel(runId, "stopped"), { ok: true });
    await settled(service, runId);

    const manifestPath = join(runsDir, runId, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as RunManifest;
    assert.equal(
      manifest.status,
      "cancelled",
      "the chain status must follow its only stage, not sit at in-progress"
    );
  });
});

// ── Spec 034 FR-010/FR-012: reading runs back from disk ──────────────────────

describe("listPersistedRuns / readPersistedRun — runs survive the daemon", () => {
  /** Write one run directory shaped exactly as persistArtifact writes it. */
  function writeRunDir(
    runsDir: string,
    runId: string,
    artifact: Record<string, unknown>,
    fileName = "test.json"
  ): string {
    const dir = join(runsDir, runId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, fileName), JSON.stringify(artifact, null, 2), "utf8");
    return dir;
  }

  function sampleArtifact(runId: string): Record<string, unknown> {
    return {
      runId,
      pipelineId: "test",
      status: "succeeded",
      gateMode: "manual",
      source: "live",
      invocation: {
        pipeline: "test",
        inputs: { request: "ship it" },
        gateMode: "manual",
        startedAt: "2026-09-13T10:00:00.000Z",
        source: "http",
      },
      steps: {
        run: { status: "succeeded", command: "echo hello", outputExcerpt: '{"passed":true}' },
      },
      gateDecisions: [],
      result: { run: { passed: true } },
      provenance: {
        pipelineId: "test",
        profileId: "anthropic",
        transportPerStep: {},
        startedAt: "2026-09-13T10:00:00.000Z",
        settledAt: "2026-09-13T10:06:12.000Z",
      },
    };
  }

  it("summarises a run directory and rebuilds its full state", () => {
    const runsDir = mkdtempSync(join(tmpdir(), "af-persisted-"));
    try {
      writeRunDir(runsDir, "run-one", sampleArtifact("run-one"));

      const summaries = listPersistedRuns(runsDir);
      assert.equal(summaries.length, 1);
      assert.deepEqual(summaries[0], {
        runId: "run-one",
        pipelineId: "test",
        status: "succeeded",
        createdAt: "2026-09-13T10:00:00.000Z",
        settledAt: "2026-09-13T10:06:12.000Z",
        // Derived from the artifact's own invocation (042 D14), so a restored
        // run names what it was started against just as a live one does.
        subject: "ship it",
        source: "disk",
      });

      const full = readPersistedRun(runsDir, "run-one");
      assert.equal(full?.status, "succeeded");
      assert.equal(full?.source, "disk");
      assert.deepEqual((full?.invocation as { inputs?: unknown })?.inputs, { request: "ship it" });
      assert.equal(
        (full?.steps as Record<string, { command?: string }>).run?.command,
        "echo hello",
        "the step's recorded command must survive the restart"
      );
      assert.equal(
        full?.artifactPath,
        join(runsDir, "run-one", "test.json"),
        "the caller needs the path it was read from"
      );
    } finally {
      rmSync(runsDir, { recursive: true, force: true });
    }
  });

  it("reports an unparseable artifact as unreadable, with its path — never hides it", () => {
    const runsDir = mkdtempSync(join(tmpdir(), "af-persisted-bad-"));
    try {
      const dir = join(runsDir, "run-bad");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "test.json"), "{ this is not json", "utf8");

      const summaries = listPersistedRuns(runsDir);
      assert.equal(summaries.length, 1, "a broken artifact is still a run the operator can see");
      assert.equal(summaries[0].status, "unreadable");
      assert.equal(summaries[0].path, join(dir, "test.json"));
      assert.equal(summaries[0].pipelineId, "test", "the file's own name still titles the run");
      assert.ok(
        typeof summaries[0].error === "string" && summaries[0].error.length > 0,
        "the parse error must be reported so the operator can act on it"
      );

      const full = readPersistedRun(runsDir, "run-bad");
      assert.equal(full?.status, "unreadable");
      assert.deepEqual(full?.steps, {});
      assert.equal(full?.pipelineId, "test");
    } finally {
      rmSync(runsDir, { recursive: true, force: true });
    }
  });

  it("ignores non-directories and a missing runs dir, and refuses to escape it", () => {
    const runsDir = mkdtempSync(join(tmpdir(), "af-persisted-edge-"));
    try {
      writeFileSync(join(runsDir, "stray.json"), "{}", "utf8");
      assert.deepEqual(listPersistedRuns(runsDir), [], "a loose file is not a run");
      assert.deepEqual(
        listPersistedRuns(join(runsDir, "nope")),
        [],
        "a missing dir is not an error"
      );
      assert.equal(readPersistedRun(runsDir, "../../etc"), undefined, "no traversal via run id");
      assert.equal(readPersistedRun(runsDir, "unknown-run"), undefined);
    } finally {
      rmSync(runsDir, { recursive: true, force: true });
    }
  });

  it("prefers the artifact whose own runId matches the directory (chained stages)", () => {
    const runsDir = mkdtempSync(join(tmpdir(), "af-persisted-chain-"));
    try {
      const anchor = sampleArtifact("run-anchor");
      writeRunDir(runsDir, "run-anchor", anchor, "investigate.json");
      // A later stage of the same chain writes into the anchor's directory with
      // its own run id (spec 029 FR-006).
      const stage = {
        ...sampleArtifact("run-stage-2"),
        pipelineId: "develop",
        provenance: {
          pipelineId: "develop",
          profileId: "anthropic",
          transportPerStep: {},
          startedAt: "2026-09-13T11:00:00.000Z",
          settledAt: "2026-09-13T11:30:00.000Z",
        },
      };
      writeFileSync(
        join(runsDir, "run-anchor", "develop.json"),
        JSON.stringify(stage, null, 2),
        "utf8"
      );

      const full = readPersistedRun(runsDir, "run-anchor");
      assert.equal(
        (full?.invocation as { pipeline?: string })?.pipeline,
        "test",
        "the directory's own run must win over a later stage that shares its directory"
      );
      // Deliberately changed by spec 047 FR-11: a chained stage is a run in its own
      // right (it has its own id), so the list carries one row per run, not one per
      // directory. Counting directories hid every chained stage after a restart.
      assert.deepEqual(
        listPersistedRuns(runsDir)
          .map((r) => r.runId)
          .sort(),
        ["run-anchor", "run-stage-2"],
        "a directory holding two runs lists two runs, each under its own id"
      );
    } finally {
      rmSync(runsDir, { recursive: true, force: true });
    }
  });
});

// ── Spec 047 FR-11: a run is found by its own id ─────────────────────────────

describe("spec 047 FR-11: locating a run by its own id after a restart", () => {
  /** A service with an empty registry over the same runs dir — the daemon after a restart. */
  function restarted(runsDir: string): RunService {
    return new RunService(
      makeMastra(makeMockRun("unused", successResult())),
      undefined,
      runsDir,
      stubProfile
    );
  }

  it("finds a chained child by its own id, in its anchor's directory", async () => {
    const runsDir = makeStateRunsDir(makeTmpDir());
    const anchorId = "run-locate-anchor";
    const childId = "run-locate-child";
    const chainDir = join(runsDir, anchorId);

    const first = new RunService(
      makeMastra(makeMockRun(anchorId, successResult())),
      undefined,
      runsDir,
      stubProfile
    );
    await first.start("investigate", {});
    await settled(first, anchorId);
    const second = new RunService(
      makeMastra(makeMockRun(childId, successResult())),
      undefined,
      runsDir,
      stubProfile
    );
    await second.start(
      "spec-creation",
      {},
      { chain: { dir: chainDir, artifactPath: join(chainDir, "investigate.json") } }
    );
    await settled(second, childId);

    const fresh = restarted(runsDir);

    const child = fresh.get(childId);
    assert.equal(child?.runId, childId);
    assert.equal(child?.pipelineId, "spec-creation", "the child's own state, not its anchor's");
    assert.equal(child?.source, "disk");
    assert.equal(fresh.get(anchorId)?.pipelineId, "investigate", "the anchor keeps its own");

    const listed = fresh.list().map((r) => r.runId);
    assert.ok(listed.includes(childId), "a chained child is a listed run");
    assert.ok(listed.includes(anchorId));

    assert.deepEqual(fresh.logLocation(childId), { dir: chainDir, pipelineId: "spec-creation" });
    assert.equal(fresh.getManifestPath(childId), join(chainDir, "manifest.json"));
  });

  it("does not find a run whose artifact a same-pipeline re-run overwrote", async () => {
    const runsDir = makeStateRunsDir(makeTmpDir());
    const firstId = "run-overwritten";
    const secondId = "run-overwriter";
    const dir = join(runsDir, firstId);

    const first = new RunService(
      makeMastra(makeMockRun(firstId, successResult())),
      undefined,
      runsDir,
      stubProfile
    );
    await first.start("investigate", {});
    await settled(first, firstId);
    const second = new RunService(
      makeMastra(makeMockRun(secondId, successResult())),
      undefined,
      runsDir,
      stubProfile
    );
    // Same pipeline into the same directory: investigate.json now describes the second run.
    await second.start(
      "investigate",
      {},
      { chain: { dir, artifactPath: join(dir, "investigate.json") } }
    );
    await settled(second, secondId);

    assert.equal(
      readPersistedRun(runsDir, firstId),
      undefined,
      "the overwritten run is gone; the file in its directory belongs to another run"
    );
    assert.equal(readPersistedRun(runsDir, secondId)?.runId, secondId);
    assert.deepEqual(
      listPersistedRuns(runsDir).map((r) => r.runId),
      [secondId],
      "the list must not show the overwritten run under the survivor's state"
    );
    assert.equal(restarted(runsDir).get(firstId), undefined);
  });

  describe("the scan reads text before it parses (pre-filter)", () => {
    function writeArtifact(runsDir: string, dirName: string, file: string, body: object): void {
      const dir = join(runsDir, dirName);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, file), JSON.stringify(body), "utf8");
    }

    it("does not attribute a run to a file that merely mentions its id", () => {
      const runsDir = makeStateRunsDir(makeTmpDir());
      // Another run's step output happens to quote the id; the parsed `runId` still decides.
      writeArtifact(runsDir, "run-holder", "investigate.json", {
        runId: "run-holder",
        pipelineId: "investigate",
        status: "succeeded",
        steps: { read: { status: "succeeded", outputExcerpt: "see run-mentioned for details" } },
      });

      assert.equal(readPersistedRun(runsDir, "run-mentioned"), undefined);
      assert.equal(locateRun(runsDir, "run-mentioned"), undefined);
    });

    it("still finds a chained child whose id the JSON escapes", () => {
      const runsDir = makeStateRunsDir(makeTmpDir());
      const childId = 'run-"quoted"';
      writeArtifact(runsDir, "run-host", "investigate.json", {
        runId: "run-host",
        pipelineId: "investigate",
        status: "succeeded",
      });
      writeArtifact(runsDir, "run-host", "build.json", {
        runId: childId,
        pipelineId: "build",
        status: "succeeded",
      });

      assert.equal(readPersistedRun(runsDir, childId)?.pipelineId, "build");
      assert.deepEqual(locateRun(runsDir, childId), {
        dir: join(runsDir, "run-host"),
        pipelineId: "build",
      });
    });

    it("reports nothing for a file it cannot parse, which could not have named the run anyway", () => {
      const runsDir = makeStateRunsDir(makeTmpDir());
      const dir = join(runsDir, "run-broken");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "investigate.json"), "{ not json", "utf8");

      assert.equal(readPersistedRun(runsDir, "run-elsewhere"), undefined);
    });
  });

  it("omits settledAt on read for a run persisted at a gate or mid-flight", () => {
    const runsDir = makeStateRunsDir(makeTmpDir());
    const dir = join(runsDir, "run-gated");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "investigate.json"),
      JSON.stringify({
        runId: "run-gated",
        pipelineId: "investigate",
        status: "awaiting_approval",
        provenance: {
          pipelineId: "investigate",
          profileId: "p",
          transportPerStep: {},
          startedAt: "2026-10-10T10:00:00.000Z",
          settledAt: "2026-10-10T10:05:00.000Z",
        },
      })
    );

    const row = listPersistedRuns(runsDir).find((r) => r.runId === "run-gated");
    assert.equal(row?.status, "awaiting_approval");
    assert.equal("settledAt" in (row ?? {}), false, "a suspended run has not settled");
    assert.equal("settledAt" in (readPersistedRun(runsDir, "run-gated") ?? {}), false);
  });
});

// ── Audit: artifacts are owner-only ──────────────────────────────────────────

describe("writeRunArtifact / upsertManifestEntry — owner-only modes", () => {
  it("creates the run dir 0700 and writes artifact and manifest 0600", async () => {
    const root = mkdtempSync(join(tmpdir(), "af-modes-"));
    try {
      const artifactDir = join(root, "run-modes-01");
      const artifactPath = await writeRunArtifact(
        artifactDir,
        "run-modes-01",
        "test",
        sampleRunArtifact("run-modes-01")
      );
      assert.ok(artifactPath !== undefined, "the artifact must be written");
      await upsertManifestEntry(artifactDir, new Date().toISOString(), {
        stageId: "test",
        artifactPath,
        profileId: "anthropic",
        status: "succeeded",
        settledAt: new Date().toISOString(),
      });

      // An artifact holds rendered prompts and step output — repository content.
      assert.equal(
        statSync(artifactDir).mode & 0o777,
        0o700,
        "the run directory must not be group- or world-readable"
      );
      assert.equal(statSync(artifactPath).mode & 0o777, 0o600, "artifact must be 0600");
      assert.equal(
        statSync(join(artifactDir, "manifest.json")).mode & 0o777,
        0o600,
        "manifest must be 0600"
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("spec 039: provenance names the provider that answered after a failover", () => {
  it("a failed-over step's transportPerStep entry is corrected, the others are not", async () => {
    const tmpDir = makeTmpDir();
    const runsDir = makeStateRunsDir(tmpDir);
    const runId = "run-tps-failover-001";
    const pipelineId = "tps-failover-pipeline";
    const mockRun = makeMockRun(runId, successResult());
    const service = new RunService(
      makeMastra(mockRun),
      undefined,
      runsDir,
      testProfileFull,
      testRegistry
    );

    // The step itself reports the crossing through the same per-run channel its
    // prompt travels on; the run id is Mastra's and is known before start().
    recordStep(runId, "work-step", {
      model: "codex (cli:codex)",
      actual: { profileId: "openai", transport: "cli", modelId: "codex", model: "gpt-5-codex" },
    });

    await service.start(pipelineId, {}, { loaded: loadedOf(testSteps) });
    await settled(service, runId);

    const artifactPath = join(runsDir, runId, `${pipelineId}.json`);
    const parsed = JSON.parse(readFileSync(artifactPath, "utf8")) as Record<string, unknown>;
    const prov = parsed.provenance as Record<string, unknown>;
    const tps = prov.transportPerStep as Record<string, StepProvenance>;

    assert.equal(
      tps["work-step"].modelId,
      "codex",
      "the artifact must name the provider that actually answered the step"
    );
    assert.equal(tps["work-step"].model, "gpt-5-codex");
    assert.equal(
      tps["reason-step"].modelId,
      "opus",
      "a step that did not fail over keeps its planned entry"
    );
  });
});

// ── Atomic publication ────────────────────────────────────────────────────────

/**
 * Count how many times a concurrent reader sees an incomplete file at `path`
 * while `write` republishes it `iterations` times.
 *
 * A non-atomic writeFile leaves a zero-length file at the final name between
 * the open and the write, and `pickArtifact` reports a run whose artifact will
 * not parse as "unreadable" — so any count above zero is a run the daemon can
 * misreport. The reader yields with setImmediate so it interleaves with the
 * write's threadpool round-trips.
 */
async function countIncompleteReads(
  path: string,
  iterations: number,
  write: (i: number) => Promise<unknown>
): Promise<number> {
  let incomplete = 0;
  let writing = true;

  const reader = (async () => {
    while (writing) {
      try {
        const raw = readFileSync(path, "utf8");
        if (raw === "") {
          incomplete++;
        } else {
          JSON.parse(raw);
        }
      } catch (err: unknown) {
        // Absent before the first publication is fine; anything else — a parse
        // error on a half-written file — is a read the daemon would have failed.
        if ((err as { code?: string }).code !== "ENOENT") incomplete++;
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  })();

  for (let i = 0; i < iterations; i++) await write(i);
  writing = false;
  await reader;

  return incomplete;
}

describe("artifact publication is atomic (spec 029 FR-001)", () => {
  it("never exposes an empty or unparseable artifact at the final path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "af-atomic-artifact-"));
    try {
      const artifactPath = join(dir, "test-pipeline.json");
      const incomplete = await countIncompleteReads(artifactPath, 500, (i) =>
        writeRunArtifact(dir, "atomic-run", "test-pipeline", {
          ...sampleRunArtifact("atomic-run"),
          result: { iteration: i },
        })
      );

      assert.equal(
        incomplete,
        0,
        `a reader observed ${incomplete} incomplete artifacts — publication must be atomic`
      );
      // No temp file may survive a successful write, and nothing beside the
      // artifact may end in .json where pickArtifact would select it.
      assert.deepEqual(readdirSync(dir), ["test-pipeline.json"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never exposes an empty or unparseable manifest at the final path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "af-atomic-manifest-"));
    try {
      const startedAt = new Date().toISOString();
      const incomplete = await countIncompleteReads(join(dir, "manifest.json"), 300, (i) =>
        upsertManifestEntry(dir, startedAt, {
          stageId: `stage-${i % 4}`,
          artifactPath: join(dir, `stage-${i % 4}.json`),
          profileId: "anthropic",
          status: "succeeded",
          settledAt: new Date().toISOString(),
        })
      );

      assert.equal(
        incomplete,
        0,
        `a reader observed ${incomplete} incomplete manifests — publication must be atomic`
      );
      assert.deepEqual(readdirSync(dir), ["manifest.json"]);
      const manifest = await readManifest(dir);
      assert.equal(manifest.stages.length, 4, "idempotent upserts must not duplicate stages");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps owner-only mode on the renamed artifact and manifest", async () => {
    const dir = mkdtempSync(join(tmpdir(), "af-atomic-mode-"));
    try {
      const path = await writeRunArtifact(
        dir,
        "mode-run",
        "test-pipeline",
        sampleRunArtifact("mode-run")
      );
      assert.ok(path !== undefined);
      assert.equal(statSync(path).mode & 0o777, 0o600);

      await upsertManifestEntry(dir, new Date().toISOString(), {
        stageId: "test-pipeline",
        artifactPath: path,
        profileId: "anthropic",
        status: "succeeded",
        settledAt: new Date().toISOString(),
      });
      assert.equal(statSync(join(dir, "manifest.json")).mode & 0o777, 0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── Spec 047 FR-10: the artifact is typed and normalised on read ─────────────

describe("spec 047 FR-10: an artifact reads back as the run it recorded", () => {
  /** A service with an empty registry over the same runs dir — the daemon after a restart. */
  function restarted(runsDir: string): RunService {
    return new RunService(
      makeMastra(makeMockRun("unused", successResult())),
      undefined,
      runsDir,
      stubProfile
    );
  }

  function emit(run: MockRun, event: Record<string, unknown>): void {
    for (const cb of run.watchers) cb(event);
  }

  /** What the HTTP layer would serve: JSON drops undefined, so compare after the same trip. */
  function wire(value: unknown): Record<string, unknown> {
    return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
  }

  /** The fields that differ by construction between a live run and its restored twin. */
  function withoutReadSideFields(state: Record<string, unknown>): Record<string, unknown> {
    const rest = { ...state };
    for (const key of ["source", "createdAt", "settledAt", "artifactPath"]) delete rest[key];
    // What a persisted run adds to the live state, checked where it matters.
    for (const key of ["provenance", "cancelledAt", "reason"]) delete rest[key];
    return rest;
  }

  /** A run that touched every part of its state: input, models, provider, steps, a gate. */
  async function startFullRun(
    runsDir: string,
    runId: string,
    run: MockRun
  ): Promise<{ service: RunService; runId: string }> {
    const service = new RunService(
      makeMastra(run),
      undefined,
      runsDir,
      testProfileFull,
      testRegistry
    );
    await service.start(
      "investigate",
      { request: "the auth bug" },
      {
        gateMode: "manual",
        loaded: loadedOf(testSteps),
        models: { "reason-step": "haiku" },
        provider: { id: "cheap", roles: { reasoner: "haiku", worker: "haiku", scout: "haiku" } },
      }
    );
    recordStep(runId, "reason-step", { prompt: "PROMPT", command: "CMD", model: "haiku (cli)" });
    emit(run, { type: "workflow-step-start", payload: { id: "reason-step" } });
    emit(run, {
      type: "workflow-step-result",
      payload: {
        id: "reason-step",
        status: "success",
        output: { request: "the auth bug", "reason-step": { answer: "x".repeat(40) } },
      },
    });
    emit(run, { type: "workflow-step-start", payload: { id: "work-step" } });
    emit(run, {
      type: "workflow-step-result",
      payload: { id: "work-step", status: "failed", error: "boom" },
    });
    return { service, runId };
  }

  async function assertRestoredMatchesLive(
    runsDir: string,
    service: RunService,
    runId: string
  ): Promise<Record<string, unknown>> {
    const live = wire(service.get(runId));
    const disk = wire(restarted(runsDir).get(runId));
    assert.equal(disk.source, "disk");
    assert.equal(typeof (disk.provenance as { profileId?: unknown }).profileId, "string");
    assert.deepEqual(withoutReadSideFields(disk), withoutReadSideFields(live));
    return live;
  }

  it("a run held at a gate", async () => {
    const runsDir = makeStateRunsDir(makeTmpDir());
    const run = makeMockRun("rt-gated", suspendedResult());
    const { service } = await startFullRun(runsDir, "rt-gated", run);
    await settled(service, "rt-gated");

    const live = await assertRestoredMatchesLive(runsDir, service, "rt-gated");
    assert.equal(live.status, "awaiting_approval");
    for (const key of ["gateMessage", "spec", "gateStepId", "invocation", "steps"]) {
      assert.ok(key in live, `the gated state must carry ${key}`);
    }
  });

  it("an approved run", async () => {
    const runsDir = makeStateRunsDir(makeTmpDir());
    const run = makeMockRun("rt-approved", suspendedResult());
    const { service } = await startFullRun(runsDir, "rt-approved", run);
    await settled(service, "rt-approved");
    await service.approve("rt-approved", true, "looks right");
    await settled(service, "rt-approved");

    const live = await assertRestoredMatchesLive(runsDir, service, "rt-approved");
    assert.equal(live.status, "succeeded");
    assert.equal((live.gateDecisions as unknown[]).length, 1);
    const steps = live.steps as Record<string, Record<string, unknown>>;
    assert.equal(steps["reason-step"].prompt, "PROMPT");
    assert.equal(steps["reason-step"].command, "CMD");
    assert.equal(steps["reason-step"].model, "haiku (cli)");
    assert.equal(steps["work-step"].error, "boom");
    assert.ok(typeof steps["reason-step"].outputExcerpt === "string");
    assert.ok(typeof steps["reason-step"].startedAt === "string");
    assert.ok(typeof steps["reason-step"].finishedAt === "string");
  });

  it("a cancelled run", async () => {
    const runsDir = makeStateRunsDir(makeTmpDir());
    const run: MockRun = {
      ...makeMockRun("rt-cancelled", successResult()),
      start: () => new Promise<Record<string, unknown>>(() => undefined),
    };
    const { service } = await startFullRun(runsDir, "rt-cancelled", run);
    assert.deepEqual(await service.cancel("rt-cancelled", "operator stopped it"), { ok: true });
    await settled(service, "rt-cancelled");

    const live = await assertRestoredMatchesLive(runsDir, service, "rt-cancelled");
    assert.equal(live.status, "cancelled");
    assert.equal((live.cancelled as { reason?: string }).reason, "operator stopped it");
    const disk = wire(restarted(runsDir).get("rt-cancelled"));
    assert.equal(disk.reason, "operator stopped it");
    assert.equal(typeof disk.cancelledAt, "string");
  });

  it("an auto run: a judge that lost the race, a degraded gate, a truncated excerpt, a failover", async () => {
    const runsDir = makeStateRunsDir(makeTmpDir());
    const runId = "rt-everything";
    let releaseJudge!: (raw: string) => void;
    const firstVerdict = new Promise<string>((resolve) => {
      releaseJudge = resolve;
    });
    let judgeCalls = 0;
    const judgeDeps: JudgeDeps = {
      // The first gate's judge is slow; the second gate's answers with no verdict.
      runner: async () => (++judgeCalls === 1 ? firstVerdict : "no verdict in here"),
      registry: testRegistry,
      profile: testProfileFull,
      projectDir: "/tmp",
      judgePrompt: "You are the gate judge.",
    };
    let finishResume!: (result: Record<string, unknown>) => void;
    const run = makeMockRun(runId, suspendedResult());
    let resumes = 0;
    // The first resume (the human's) is held open; cancelling the second gate resumes it too.
    run.resume = () =>
      ++resumes === 1
        ? new Promise<Record<string, unknown>>((resolve) => {
            finishResume = resolve;
          })
        : Promise.resolve(successResult());
    const service = new RunService(
      makeMastra(run),
      judgeDeps,
      runsDir,
      testProfileFull,
      testRegistry
    );
    await service.start("investigate", { request: "r" }, { gateMode: "auto" });
    recordStep(runId, "reason-step", {
      actual: { profileId: "openai", transport: "cli", modelId: "codex", model: "gpt-5-codex" },
    });
    emit(run, { type: "workflow-step-start", payload: { id: "reason-step" } });
    emit(run, {
      type: "workflow-step-result",
      payload: {
        id: "reason-step",
        status: "success",
        output: { "reason-step": { answer: "y".repeat(5000) } },
      },
    });
    // The human answers gate one while its judge is still thinking.
    const approving = service.approve(runId, true, "I got there first");
    releaseJudge('{"verdict":"approve","reason":"too late"}');
    for (let i = 0; i < 200 && (service.get(runId)?.gateDecisions.length ?? 0) < 2; i++) {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    finishResume(suspendedResult());
    await approving;
    // Gate two is judged next; the judge gives no verdict and the gate degrades.
    for (let i = 0; i < 200 && service.get(runId)?.judgeError === undefined; i++) {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    assert.ok(service.get(runId)?.judgeError !== undefined, "the second gate must degrade");
    assert.deepEqual(await service.cancel(runId, "enough"), { ok: true });
    await settled(service, runId);
    const live = await assertRestoredMatchesLive(runsDir, service, runId);
    const decisions = live.gateDecisions as Record<string, unknown>[];
    assert.deepEqual(
      decisions.map((d) => [d.decidedBy, d.superseded]),
      [
        ["human", undefined],
        ["agent", true],
        ["human", undefined],
      ]
    );
    assert.equal(typeof decisions[1].judgeModelId, "string");
    assert.equal(decisions[1].workspaceAccess, true);
    assert.equal(typeof live.judgeError, "string");
    const step = (live.steps as Record<string, Record<string, unknown>>)["reason-step"];
    assert.equal(step.outputTruncated, true);
    assert.equal((step.actual as { modelId?: string }).modelId, "codex");
  });

  it("a gate with its summary, as the artifact records it", () => {
    // A summary arrives after the write that suspends the run, so the service only
    // persists one when a later write catches it; the reader must keep it then.
    const runsDir = makeStateRunsDir(makeTmpDir());
    const dir = join(runsDir, "rt-summary");
    mkdirSync(dir, { recursive: true });
    const fields = {
      gateMessage: "Approve this spec?",
      spec: { title: "T" },
      gateSummary: "Approving ships the plan as written.",
      gateStepId: "approve",
      judgeError: "no verdict",
    };
    writeFileSync(
      join(dir, "investigate.json"),
      JSON.stringify({
        runId: "rt-summary",
        pipelineId: "investigate",
        status: "awaiting_approval",
        ...fields,
      })
    );

    const restored = readPersistedRun(runsDir, "rt-summary");
    assert.ok(restored !== undefined);
    for (const [key, value] of Object.entries(fields)) {
      assert.deepEqual((restored as unknown as Record<string, unknown>)[key], value, key);
    }
  });

  describe("an artifact this build cannot read as written", () => {
    function writeArtifactFile(
      runsDir: string,
      runId: string,
      body: Record<string, unknown>
    ): void {
      const dir = join(runsDir, runId);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "investigate.json"), JSON.stringify({ runId, ...body }), "utf8");
    }

    it("reports a status this build does not know as unreadable, naming it", () => {
      const runsDir = makeStateRunsDir(makeTmpDir());
      writeArtifactFile(runsDir, "run-v9", {
        pipelineId: "investigate",
        status: "paused-by-v9",
        gateMode: "manual",
        steps: {},
        gateDecisions: [],
      });

      const full = readPersistedRun(runsDir, "run-v9");
      assert.equal(full?.status, "unreadable");
      assert.match(String(full?.error), /paused-by-v9/);
      const row = listPersistedRuns(runsDir).find((r) => r.runId === "run-v9");
      assert.equal(row?.status, "unreadable");
      assert.match(String(row?.error), /paused-by-v9/);
    });

    it("replaces malformed fields with their empty value instead of passing them on", () => {
      const runsDir = makeStateRunsDir(makeTmpDir());
      writeArtifactFile(runsDir, "run-garbled", {
        pipelineId: "investigate",
        status: "succeeded",
        gateMode: 7,
        steps: [],
        gateDecisions: "x",
        invocation: "s",
      });

      const full = readPersistedRun(runsDir, "run-garbled");
      assert.equal(full?.status, "succeeded");
      assert.equal(full?.gateMode, "manual");
      assert.deepEqual(full?.steps, {});
      assert.deepEqual(full?.gateDecisions, []);
      assert.equal(full?.invocation, undefined);
    });

    it("ignores a step id that would set the steps object's prototype", () => {
      const runsDir = makeStateRunsDir(makeTmpDir());
      const dir = join(runsDir, "run-proto");
      mkdirSync(dir, { recursive: true });
      // JSON.parse makes "__proto__" an own key, which a plain assignment would not.
      writeFileSync(
        join(dir, "investigate.json"),
        '{"runId":"run-proto","pipelineId":"investigate","status":"succeeded","steps":' +
          '{"__proto__":{"status":"failed","error":"inherited"},"a":{"status":"succeeded"}}}'
      );

      const steps = readPersistedRun(runsDir, "run-proto")?.steps as Record<string, unknown>;
      assert.deepEqual(steps, { a: { status: "succeeded" } });
      assert.equal(Object.getPrototypeOf(steps), Object.prototype);
      assert.equal("status" in steps, false, "nothing is inherited from the artifact");
    });

    it("keeps the provider a failed-over step ran on, field by field", () => {
      const runsDir = makeStateRunsDir(makeTmpDir());
      writeArtifactFile(runsDir, "run-failover", {
        pipelineId: "investigate",
        status: "succeeded",
        steps: {
          moved: {
            status: "succeeded",
            actual: { profileId: "openai", transport: "cli", modelId: "codex", model: "gpt-5" },
          },
          bare: {
            status: "succeeded",
            actual: { profileId: "openai", transport: "api", modelId: "o", extra: 1 },
          },
          bad: { status: "succeeded", actual: { profileId: "openai", transport: "pigeon" } },
        },
      });

      assert.deepEqual(readPersistedRun(runsDir, "run-failover")?.steps, {
        moved: {
          status: "succeeded",
          actual: { profileId: "openai", transport: "cli", modelId: "codex", model: "gpt-5" },
        },
        bare: {
          status: "succeeded",
          actual: { profileId: "openai", transport: "api", modelId: "o" },
        },
        bad: { status: "succeeded" },
      });
    });

    it("drops a step whose status is unknown and keeps its neighbours", () => {
      const runsDir = makeStateRunsDir(makeTmpDir());
      writeArtifactFile(runsDir, "run-steps", {
        pipelineId: "investigate",
        status: "succeeded",
        steps: {
          good: { status: "succeeded", prompt: "P", outputTruncated: true },
          odd: { status: "levitating" },
          junk: "nope",
          typed: { status: "failed", error: 7, prompt: { not: "a string" } },
        },
      });

      const steps = readPersistedRun(runsDir, "run-steps")?.steps;
      assert.deepEqual(steps, {
        good: { status: "succeeded", prompt: "P", outputTruncated: true },
        typed: { status: "failed" },
      });
    });
  });
});

// ── Spec 047 FR-11: a chained stage that crashed before it wrote an artifact ─

describe("spec 047 FR-11: locating a chained stage from its events file", () => {
  const EVENTS_HEAD_BYTES = 64 * 1024;

  /** One events line as stepLog's writeEvent serialises it: payload first, ids after. */
  function eventLine(runId: string, extra: Record<string, unknown> = {}): string {
    return JSON.stringify({
      kind: "step.start",
      model: "m",
      transport: "cli",
      ...extra,
      seq: 1,
      at: "2026-10-10T10:00:00.000Z",
      runId,
      pipelineId: "build",
      stepId: "s",
    });
  }

  function writeDirFile(runsDir: string, dirName: string, file: string, text: string): string {
    const dir = join(runsDir, dirName);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, file), text, "utf8");
    return dir;
  }

  function writeAnchorArtifact(runsDir: string, anchorId: string): string {
    return writeDirFile(
      runsDir,
      anchorId,
      "investigate.json",
      JSON.stringify({ runId: anchorId, pipelineId: "investigate", status: "succeeded" })
    );
  }

  it("names a run's pipeline the same way when locating it as when reading it", () => {
    const runsDir = makeStateRunsDir(makeTmpDir());
    // No top-level pipelineId: the provenance block is the next place the artifact says it.
    writeDirFile(
      runsDir,
      "run-prov",
      "file-stem.json",
      JSON.stringify({
        runId: "run-prov",
        status: "succeeded",
        provenance: { pipelineId: "from-provenance" },
      })
    );

    assert.equal(locateRun(runsDir, "run-prov")?.pipelineId, "from-provenance");
    assert.equal(readPersistedRun(runsDir, "run-prov")?.pipelineId, "from-provenance");
  });

  it("finds a crashed child by the events file in its anchor's directory", () => {
    const runsDir = makeStateRunsDir(makeTmpDir());
    const anchorDir = writeAnchorArtifact(runsDir, "run-anchor");
    writeFileSync(join(anchorDir, "build.events.jsonl"), `${eventLine("run-child")}\n`);

    assert.deepEqual(locateRun(runsDir, "run-child"), { dir: anchorDir, pipelineId: "build" });
    assert.deepEqual(locateRun(runsDir, "run-anchor"), {
      dir: anchorDir,
      pipelineId: "investigate",
    });
  });

  it("does not hand a crashed child's events file to the anchor whose artifact is gone", () => {
    const runsDir = makeStateRunsDir(makeTmpDir());
    const anchorDir = writeDirFile(
      runsDir,
      "run-anchor",
      "build.events.jsonl",
      `${eventLine("run-child")}\n`
    );

    assert.equal(locateRun(runsDir, "run-anchor"), undefined);
    assert.deepEqual(locateRun(runsDir, "run-child"), { dir: anchorDir, pipelineId: "build" });
  });

  it("takes an empty events file, as a run's own crash before its first event", () => {
    const runsDir = makeStateRunsDir(makeTmpDir());
    const dir = writeDirFile(runsDir, "run-empty", "build.events.jsonl", "");

    assert.deepEqual(locateRun(runsDir, "run-empty"), { dir, pipelineId: "build" });
  });

  it("does not attribute a non-empty events file that names no run", () => {
    const runsDir = makeStateRunsDir(makeTmpDir());
    // Content, but no line that parses: it belongs to some run, not necessarily this one.
    writeDirFile(runsDir, "run-torn", "build.events.jsonl", '{"kind":"step.start","ru');
    writeDirFile(runsDir, "run-noise", "build.events.jsonl", "not json at all\n");

    assert.equal(locateRun(runsDir, "run-torn"), undefined);
    assert.equal(locateRun(runsDir, "run-noise"), undefined);
  });

  it("prefers the events file that names the run over one that names nothing", () => {
    const runsDir = makeStateRunsDir(makeTmpDir());
    const dir = writeDirFile(runsDir, "run-two", "a-empty.events.jsonl", "");
    writeFileSync(join(dir, "z-named.events.jsonl"), `${eventLine("run-two")}\n`);

    assert.deepEqual(locateRun(runsDir, "run-two"), { dir, pipelineId: "z-named" });
  });

  it("does not attribute a run to an events line that quotes its id in a nested field", () => {
    const runsDir = makeStateRunsDir(makeTmpDir());
    // A tool call's input is an object; a model can put `"runId":"run-decoy"` in it.
    const dir = writeDirFile(
      runsDir,
      "run-A",
      "build.events.jsonl",
      `${eventLine("run-A", { kind: "tool.call", input: { runId: "run-decoy" } })}\n`
    );

    assert.equal(locateRun(runsDir, "run-decoy"), undefined);
    assert.deepEqual(locateRun(runsDir, "run-A"), { dir, pipelineId: "build" });
  });

  it("never opens an events file that is not a regular file", () => {
    const runsDir = makeStateRunsDir(makeTmpDir());
    // A link to a file outside the state dir that happens to name the run.
    const outside = join(makeTmpDir(), "elsewhere.jsonl");
    writeFileSync(outside, `${eventLine("run-linked")}\n`);
    const anchorDir = writeAnchorArtifact(runsDir, "run-anchor");
    symlinkSync(outside, join(anchorDir, "build.events.jsonl"));
    const ownDir = join(runsDir, "run-own");
    mkdirSync(ownDir, { recursive: true });
    symlinkSync(outside, join(ownDir, "build.events.jsonl"));

    assert.equal(locateRun(runsDir, "run-linked"), undefined, "not found through a link");
    assert.equal(locateRun(runsDir, "run-own"), undefined, "a link is not an empty file either");
  });

  it("reads only the head of an events file", () => {
    const runsDir = makeStateRunsDir(makeTmpDir());
    const filler = `${eventLine("run-A", { kind: "message", text: "x".repeat(1000) })}\n`;
    const padding = filler.repeat(Math.ceil(EVENTS_HEAD_BYTES / filler.length) + 1);
    const anchorDir = writeAnchorArtifact(runsDir, "run-anchor");
    writeFileSync(
      join(anchorDir, "build.events.jsonl"),
      `${eventLine("run-early")}\n${padding}${eventLine("run-late")}\n`
    );

    assert.equal(locateRun(runsDir, "run-early")?.pipelineId, "build");
    assert.equal(
      locateRun(runsDir, "run-late"),
      undefined,
      "a run whose first line is past the head is not found: the scan never reads a whole file"
    );
  });
});

describe("spec 047 FR-11: a missed run lookup is remembered briefly", () => {
  const TTL_MS = 2000;

  function writeChild(runsDir: string, childId: string): string {
    const dir = join(runsDir, "run-anchor");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${childId}.json`),
      JSON.stringify({ runId: childId, pipelineId: "build", status: "succeeded" })
    );
    return dir;
  }

  it("answers a second miss without reading the directories, and looks again after the TTL", () => {
    let now = 1_000_000;
    setRunLookupClock(() => now);
    try {
      const runsDir = makeStateRunsDir(makeTmpDir());
      mkdirSync(join(runsDir, "run-anchor"), { recursive: true });
      assert.equal(locateRun(runsDir, "run-late"), undefined);

      // The artifact appears. A lookup that read the directories would find it.
      const dir = writeChild(runsDir, "run-late");
      now += TTL_MS - 1;
      assert.equal(locateRun(runsDir, "run-late"), undefined, "inside the TTL: remembered");
      assert.equal(readPersistedRun(runsDir, "run-late"), undefined);

      now += 2;
      assert.deepEqual(locateRun(runsDir, "run-late"), { dir, pipelineId: "build" });
    } finally {
      setRunLookupClock();
    }
  });

  it("never holds a miss past the TTL when the clock steps backwards", () => {
    let now = 10_000;
    setRunLookupClock(() => now);
    try {
      const runsDir = makeStateRunsDir(makeTmpDir());
      mkdirSync(join(runsDir, "run-anchor"), { recursive: true });
      assert.equal(locateRun(runsDir, "run-late"), undefined);

      const dir = writeChild(runsDir, "run-late");
      now = 0;
      assert.deepEqual(locateRun(runsDir, "run-late"), { dir, pipelineId: "build" });
    } finally {
      setRunLookupClock();
    }
  });

  it("does not remember a miss from a scan that could not read a directory", (t) => {
    if (process.getuid?.() === 0) {
      t.skip("root reads a mode-000 directory");
      return;
    }
    setRunLookupClock(() => 20_000);
    const runsDir = makeStateRunsDir(makeTmpDir());
    const locked = join(runsDir, "run-locked");
    mkdirSync(locked, { recursive: true });
    try {
      chmodSync(locked, 0o000);
      assert.equal(locateRun(runsDir, "run-hidden"), undefined, "the scan cannot see inside");

      chmodSync(locked, 0o700);
      writeFileSync(
        join(locked, "build.json"),
        JSON.stringify({ runId: "run-hidden", pipelineId: "build", status: "succeeded" })
      );
      assert.deepEqual(locateRun(runsDir, "run-hidden"), { dir: locked, pipelineId: "build" });
    } finally {
      chmodSync(locked, 0o700);
      setRunLookupClock();
    }
  });

  it("remembers a miss per runs dir and per id", () => {
    setRunLookupClock(() => 5_000_000);
    try {
      const runsDir = makeStateRunsDir(makeTmpDir());
      const otherRunsDir = makeStateRunsDir(makeTmpDir());
      assert.equal(locateRun(runsDir, "run-x"), undefined);
      writeChild(runsDir, "run-y");
      writeChild(otherRunsDir, "run-x");

      assert.ok(
        locateRun(runsDir, "run-y") !== undefined,
        "another id is not remembered as missing"
      );
      assert.ok(locateRun(otherRunsDir, "run-x") !== undefined, "another runs dir is its own");
    } finally {
      setRunLookupClock();
    }
  });

  it("holds a bounded number of misses, forgetting the oldest first", () => {
    setRunLookupClock(() => 9_000_000);
    try {
      const runsDir = makeStateRunsDir(makeTmpDir());
      mkdirSync(join(runsDir, "run-anchor"), { recursive: true });
      for (let i = 0; i < 300; i++) assert.equal(locateRun(runsDir, `run-miss-${i}`), undefined);
      writeChild(runsDir, "run-miss-0");
      writeChild(runsDir, "run-miss-299");

      assert.ok(locateRun(runsDir, "run-miss-0") !== undefined, "the oldest miss was evicted");
      assert.equal(locateRun(runsDir, "run-miss-299"), undefined, "the newest is still held");
    } finally {
      setRunLookupClock();
    }
  });
});
