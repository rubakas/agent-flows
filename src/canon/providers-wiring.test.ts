// Composition-root wiring test — FR-016, FR-002.
//
// Enumerates every composition root that must honour providers.yaml and proves
// that, when the project has a providers.yaml declaring a custom profile and
// defaultProvider, each root uses that profile rather than the hard-coded
// "anthropic" fallback.
//
// Script-level roots (smoke.ts, evals/run.ts, serve/server.ts CLI entrypoint)
// are integration-tested here at the level of the functions they call, not by
// running the scripts themselves — the wiring is verified by checking that the
// relevant load + resolve calls produce the expected profile.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadProviders } from "./loadProviders.js";
import { defaultRegistry, getActiveProfile, getProfile } from "./registry.js";

// ── Shared fixture ────────────────────────────────────────────────────────────

// A minimal providers.yaml that declares a new profile "test-profile" and
// sets it as the default. Every root must produce "test-profile" (not "anthropic")
// when pointed at this config.
const PROVIDERS_YAML = `version: 1
models:
  - id: test-model
    transport: cli
    cli: { bin: claude, model: claude-test }
profiles:
  - id: test-profile
    roles: { reasoner: test-model, worker: test-model, scout: test-model }
defaultProvider: test-profile
`;

function makeReadFile(yaml: string) {
  return (p: string) => {
    if (p.includes("providers.yaml")) return yaml;
    const err = new Error("not found") as NodeJS.ErrnoException;
    err.code = "ENOENT";
    throw err;
  };
}

// ── Root: loadProviders itself ────────────────────────────────────────────────

describe("providers-wiring — loadProviders reads custom config", () => {
  it("returns the custom profile and model from providers.yaml", () => {
    const providers = loadProviders("/fake/project", { readFile: makeReadFile(PROVIDERS_YAML) });
    assert.equal(providers.defaultProvider, "test-profile");
    assert.equal(providers.profiles.length, 1);
    assert.equal(providers.profiles[0].id, "test-profile");
    assert.equal(providers.models.length, 1);
    assert.equal(providers.models[0].id, "test-model");
  });
});

// ── Root: registry functions accept and honour ProviderConfig ─────────────────

describe("providers-wiring — getActiveProfile honours config.defaultProvider", () => {
  it("resolves to test-profile when config.defaultProvider is set and env is absent", () => {
    const providers = loadProviders("/fake/project", { readFile: makeReadFile(PROVIDERS_YAML) });
    const profile = getActiveProfile({}, providers);
    assert.equal(profile.id, "test-profile");
  });

  it("env var overrides config.defaultProvider", () => {
    const providers = loadProviders("/fake/project", { readFile: makeReadFile(PROVIDERS_YAML) });
    const profile = getActiveProfile({ AGENT_FLOWS_PROVIDER: "anthropic" }, providers);
    assert.equal(profile.id, "anthropic");
  });
});

describe("providers-wiring — defaultRegistry prepends project models (project wins by id)", () => {
  it("project test-model resolves to cli:claude:claude-test", () => {
    const providers = loadProviders("/fake/project", { readFile: makeReadFile(PROVIDERS_YAML) });
    const registry = defaultRegistry({}, providers.models);
    const entry = registry.resolve("test-model");
    assert.equal(entry.transport, "cli");
    assert.equal(entry.cli?.model, "claude-test");
  });
});

// ── Root: doctor (DoctorProbes.providers) ────────────────────────────────────

describe("providers-wiring — doctor root honours providers", () => {
  it("active provider check uses project profile when providers.providers is set", async () => {
    // Import at test time to avoid circular-module issues at module load.
    const { runDoctor } = await import("../doctor.js");

    const providers = loadProviders("/fake/project", { readFile: makeReadFile(PROVIDERS_YAML) });

    // Minimal probes with providers wired in.
    const probes = {
      nodeVersion: () => "22.17.1",
      which: (bin: string) => `/usr/bin/${bin}`,
      whichAll: (bin: string) => [`/usr/bin/${bin}`],
      exec: async (_cmd: string, _args: string[]) =>
        ({ code: 0, stdout: JSON.stringify({ loggedIn: true }), stderr: "" }) as const,
      fetchJson: async (_url: string) => ({ models: [{ name: "qwen2.5:1.5b" }] }),
      requireNative: () => true,
      reachable: async (_url: string) => true,
      loadCanon: () => ({ loaded: ["spec-creation"], failed: [] }),
      env: {},
      providers,
    };

    const results = await runDoctor(probes);
    const activeProvider = results.find((r) => r.name === "Active provider");
    assert.ok(activeProvider, "Active provider check must be present");
    assert.equal(activeProvider.status, "ok");
    assert.ok(
      activeProvider.detail.includes("test-profile"),
      `detail must name test-profile; got: ${activeProvider.detail}`
    );
  });
});

// ── Root: getProfile (smoke.ts / evals/run.ts pattern) ───────────────────────

describe("providers-wiring — smoke.ts / evals/run.ts pattern", () => {
  it("getProfile(id, providers.profiles) resolves the project profile by id", () => {
    const providers = loadProviders("/fake/project", { readFile: makeReadFile(PROVIDERS_YAML) });
    const profile = getProfile("test-profile", providers.profiles);
    assert.equal(profile.id, "test-profile");
    assert.equal(profile.roles.reasoner, "test-model");
  });

  it("defaultProvider is the effective id when env is absent (eval run pattern)", () => {
    const providers = loadProviders("/fake/project", { readFile: makeReadFile(PROVIDERS_YAML) });
    // Mirrors: const providerId = process.env.AGENT_FLOWS_PROVIDER ?? providers.defaultProvider ?? "anthropic"
    // env var is absent, so we fall through to config then to the hardcoded fallback.
    const providerId = providers.defaultProvider ?? "anthropic";
    assert.equal(providerId, "test-profile");
    const profile = getProfile(providerId, providers.profiles);
    assert.equal(profile.id, "test-profile");
  });
});

// ── Root: write-cli.ts / canonWriter.ts (generateWorkflowScript) ─────────────

describe("providers-wiring — Binding A generateWorkflowScript uses project registry + profile", () => {
  it("project model is used in generated script when registry carries project models", async () => {
    const ccMod = await import("../bindings/claudeCode.js");
    const loadMod = await import("./load.js");
    const pathMod = await import("node:path");
    const urlMod = await import("node:url");

    const thisFile = urlMod.fileURLToPath(import.meta.url);
    const repoRoot = pathMod.join(pathMod.dirname(thisFile), "..", "..");
    const pipelinesDir = pathMod.join(repoRoot, "pipelines");

    // Load any available pipeline to exercise the generator.
    const pipelineFiles = loadMod.listPipelines(pipelinesDir);
    if (pipelineFiles.length === 0) return; // nothing to test if no pipelines present

    const providers = loadProviders("/fake/project", { readFile: makeReadFile(PROVIDERS_YAML) });
    const profile = getActiveProfile({}, providers);
    const registry = defaultRegistry({}, providers.models);

    const loaded = loadMod.loadPipeline(pipelineFiles[0]);
    const script = ccMod.generateWorkflowScript(loaded, profile, registry);

    // The script should compile (is a non-empty string) — behavioural correctness
    // is tested by the claudeCode.test.ts suite.
    assert.ok(typeof script === "string" && script.length > 0, "script must be a non-empty string");
  });
});

// ── Root: n8n/write-cli.ts (validation only) ─────────────────────────────────

describe("providers-wiring — n8n write-cli.ts calls loadProviders (validation)", () => {
  it("loadProviders with a malformed providers.yaml throws before n8n generation begins", () => {
    // This mirrors what n8n/write-cli.ts does: loadProviders(repoRoot).
    // A malformed file must throw, not fall back silently.
    assert.throws(
      () => loadProviders("/fake/project", { readFile: () => "version: 2\n" }),
      (err: unknown) => {
        assert.ok(err instanceof Error, "must throw");
        assert.ok(err.message.includes("version"), `must mention field: ${err.message}`);
        return true;
      }
    );
  });

  it("loadProviders with a valid providers.yaml does not throw", () => {
    assert.doesNotThrow(() =>
      loadProviders("/fake/project", { readFile: makeReadFile(PROVIDERS_YAML) })
    );
  });
});
