import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  defaultRegistry,
  getActiveProfile,
  getProfile,
  ModelRegistry,
  resolveStepModel,
} from "./registry.js";
import type { ModelEntry } from "./registry.js";
import type { StepDef } from "./types.js";

describe("ModelRegistry", () => {
  const entries: ModelEntry[] = [
    { id: "model-a", transport: "cli", cli: { bin: "claude", model: "sonnet" } },
    { id: "model-b", transport: "api", api: { endpoint: "http://example.com/v1" } },
  ];

  it("resolves a known model by id", () => {
    const registry = new ModelRegistry(entries);
    const entry = registry.resolve("model-a");
    assert.equal(entry.id, "model-a");
    assert.equal(entry.transport, "cli");
  });

  it("returns a passthrough cli entry for unknown model id", () => {
    const registry = new ModelRegistry(entries);
    const entry = registry.resolve("claude-opus-5");
    assert.equal(entry.id, "claude-opus-5");
    assert.equal(entry.transport, "cli");
    assert.equal(entry.cli?.bin, "claude");
    assert.equal(entry.cli?.model, "claude-opus-5");
  });

  it("list() returns all entries", () => {
    const registry = new ModelRegistry(entries);
    const list = registry.list();
    assert.equal(list.length, 2);
    assert.equal(list[0].id, "model-a");
    assert.equal(list[1].id, "model-b");
  });

  it("list() returns a copy (mutation does not affect registry)", () => {
    const registry = new ModelRegistry(entries);
    const list = registry.list();
    list.push({ id: "extra", transport: "cli", cli: { bin: "codex" } });
    assert.equal(registry.list().length, 2);
  });
});

describe("defaultRegistry", () => {
  it("includes fable, opus, sonnet, haiku as cli transport entries", () => {
    const reg = defaultRegistry({});

    // All four are pinned to explicit versioned ids — bare aliases silently follow the newest
    // (most expensive) model; explicit ids make cost predictable across CLI updates.
    const expected: Record<string, string> = {
      fable: "claude-fable-5-1",
      opus: "claude-opus-5",
      sonnet: "claude-sonnet-5",
      haiku: "claude-haiku-4-5",
    };

    for (const [alias, expectedModel] of Object.entries(expected)) {
      const entry = reg.resolve(alias);
      assert.equal(entry.transport, "cli", `${alias} transport`);
      assert.equal(entry.cli?.bin, "claude", `${alias} bin`);
      assert.equal(entry.cli?.model, expectedModel, `${alias} model pinned to ${expectedModel}`);
    }
  });

  it("unknown id resolves to passthrough cli entry with model=id", () => {
    const reg = defaultRegistry({});
    const entry = reg.resolve("claude-unknown-future-model");
    assert.equal(entry.id, "claude-unknown-future-model");
    assert.equal(entry.transport, "cli");
    assert.equal(entry.cli?.bin, "claude");
    assert.equal(entry.cli?.model, "claude-unknown-future-model");
  });

  it("ollama-qwen uses env.OLLAMA_BASE_URL when set", () => {
    const reg = defaultRegistry({ OLLAMA_BASE_URL: "http://custom:11434" });
    const entry = reg.resolve("ollama-qwen");
    assert.equal(entry.transport, "api");
    assert.ok(entry.api?.endpoint.startsWith("http://custom:11434"));
  });

  it("ollama-qwen falls back to localhost:11434", () => {
    const reg = defaultRegistry({});
    const entry = reg.resolve("ollama-qwen");
    assert.ok(entry.api?.endpoint.includes("localhost:11434"));
  });

  it("litellm uses env.LITELLM_BASE_URL when set", () => {
    const reg = defaultRegistry({ LITELLM_BASE_URL: "http://litellm-proxy:4000" });
    const entry = reg.resolve("litellm");
    assert.ok(entry.api?.endpoint.startsWith("http://litellm-proxy:4000"));
    assert.equal(entry.api?.keyEnv, "LITELLM_VIRTUAL_KEY");
  });

  it("litellm falls back to localhost:4000", () => {
    const reg = defaultRegistry({});
    const entry = reg.resolve("litellm");
    assert.ok(entry.api?.endpoint.includes("localhost:4000"));
  });

  it("ollama-qwen has model qwen2.5:1.5b", () => {
    const reg = defaultRegistry({});
    const entry = reg.resolve("ollama-qwen");
    assert.equal(entry.api?.model, "qwen2.5:1.5b");
  });

  it("litellm model defaults to 'default' when LITELLM_MODEL not set", () => {
    const reg = defaultRegistry({});
    const entry = reg.resolve("litellm");
    assert.equal(entry.api?.model, "default");
  });

  it("litellm model uses LITELLM_MODEL env var when set", () => {
    const reg = defaultRegistry({ LITELLM_MODEL: "my-model" });
    const entry = reg.resolve("litellm");
    assert.equal(entry.api?.model, "my-model");
  });

  it("codex resolves with cli bin=codex and no model field", () => {
    const reg = defaultRegistry({});
    const entry = reg.resolve("codex");
    assert.equal(entry.transport, "cli");
    assert.equal(entry.cli?.bin, "codex");
    assert.equal(entry.cli?.model, undefined);
  });
});

describe("getProfile", () => {
  it("anthropic profile has correct role→model mappings", () => {
    const p = getProfile("anthropic");
    assert.equal(p.roles.reasoner, "opus");
    assert.equal(p.roles.worker, "sonnet");
    assert.equal(p.roles.scout, "haiku");
  });

  it("no built-in role profile resolves to a fable entry", () => {
    // Guard for owner instruction: fable is reserved for chat orchestration and must
    // never be wired into any workflow role. This test fails if someone maps a role to fable.
    const reg = defaultRegistry({});
    for (const profileId of ["anthropic", "openai", "local"]) {
      const profile = getProfile(profileId);
      for (const role of ["reasoner", "worker", "scout"] as const) {
        const entry = reg.resolve(profile.roles[role]);
        assert.notEqual(
          entry.id,
          "fable",
          `Profile "${profileId}" role "${role}" must not resolve to fable`
        );
      }
    }
  });

  it("openai profile maps all roles to codex", () => {
    const p = getProfile("openai");
    assert.equal(p.roles.reasoner, "codex");
    assert.equal(p.roles.worker, "codex");
    assert.equal(p.roles.scout, "codex");
  });

  it("local profile maps all roles to ollama-qwen", () => {
    const p = getProfile("local");
    assert.equal(p.roles.reasoner, "ollama-qwen");
    assert.equal(p.roles.worker, "ollama-qwen");
    assert.equal(p.roles.scout, "ollama-qwen");
  });

  it("throws on unknown profile id naming available ids", () => {
    assert.throws(
      () => getProfile("unknown-provider"),
      (err: Error) => {
        assert.ok(err.message.includes("unknown-provider"), "error should name the bad id");
        assert.ok(err.message.includes("anthropic"), "error should list anthropic");
        assert.ok(err.message.includes("openai"), "error should list openai");
        assert.ok(err.message.includes("local"), "error should list local");
        return true;
      }
    );
  });
});

describe("getActiveProfile", () => {
  it("defaults to anthropic when AGENT_FLOWS_PROVIDER not set", () => {
    const p = getActiveProfile({});
    assert.equal(p.id, "anthropic");
  });

  it("selects the profile named by AGENT_FLOWS_PROVIDER", () => {
    const p = getActiveProfile({ AGENT_FLOWS_PROVIDER: "openai" });
    assert.equal(p.id, "openai");
  });

  it("throws on unknown AGENT_FLOWS_PROVIDER value", () => {
    assert.throws(() => getActiveProfile({ AGENT_FLOWS_PROVIDER: "bad-provider" }), /bad-provider/);
  });
});

describe("resolveStepModel", () => {
  const reg = defaultRegistry({});
  const anthropic = getProfile("anthropic");
  const openai = getProfile("openai");
  const local = getProfile("local");

  function step(overrides: Partial<StepDef>): StepDef {
    return { id: "s", kind: "llm", ...overrides };
  }

  it("role=reasoner on anthropic resolves to opus entry", () => {
    const entry = resolveStepModel(step({ role: "reasoner" }), anthropic, reg);
    assert.equal(entry.id, "opus");
    assert.equal(entry.cli?.model, "claude-opus-5");
  });

  it("role=worker on anthropic resolves to sonnet entry", () => {
    const entry = resolveStepModel(step({ role: "worker" }), anthropic, reg);
    assert.equal(entry.id, "sonnet");
    assert.equal(entry.cli?.model, "claude-sonnet-5");
  });

  it("role=scout on anthropic resolves to haiku entry", () => {
    const entry = resolveStepModel(step({ role: "scout" }), anthropic, reg);
    assert.equal(entry.id, "haiku");
    assert.equal(entry.cli?.model, "claude-haiku-4-5");
  });

  it("all roles on openai resolve to codex entry with no model field", () => {
    for (const role of ["reasoner", "worker", "scout"] as const) {
      const entry = resolveStepModel(step({ role }), openai, reg);
      assert.equal(entry.id, "codex", `${role} should resolve to codex`);
      assert.equal(entry.cli?.bin, "codex");
      assert.equal(entry.cli?.model, undefined, "codex entry should have no model field");
    }
  });

  it("all roles on local resolve to ollama-qwen entry", () => {
    for (const role of ["reasoner", "worker", "scout"] as const) {
      const entry = resolveStepModel(step({ role }), local, reg);
      assert.equal(entry.id, "ollama-qwen", `${role} should resolve to ollama-qwen`);
    }
  });

  it("explicit model overrides role — model wins", () => {
    const entry = resolveStepModel(step({ model: "haiku" }), openai, reg);
    assert.equal(entry.id, "haiku");
    assert.equal(entry.cli?.bin, "claude");
  });

  it("explicit model passthrough for unknown id still works", () => {
    const entry = resolveStepModel(step({ model: "claude-opus-5" }), anthropic, reg);
    assert.equal(entry.id, "claude-opus-5");
    assert.equal(entry.cli?.bin, "claude");
    assert.equal(entry.cli?.model, "claude-opus-5");
  });
});

// ── FR-016: extended signatures (extra entries / extraProfiles / config) ──────

describe("defaultRegistry — extra entries", () => {
  it("extra-entry-overrides-builtin-by-id: project sonnet wins over built-in sonnet", () => {
    const override: ModelEntry = {
      id: "sonnet",
      transport: "api",
      api: { endpoint: "https://example.com/v1/chat/completions", model: "project-sonnet" },
    };
    const reg = defaultRegistry({}, [override]);
    const entry = reg.resolve("sonnet");
    assert.equal(entry.transport, "api");
    assert.equal(entry.api?.model, "project-sonnet");
  });

  it("builtin-survives-extra: haiku still resolves when extras are present", () => {
    const extra: ModelEntry = { id: "deepseek", transport: "cli", cli: { bin: "codex" } };
    const reg = defaultRegistry({}, [extra]);
    const entry = reg.resolve("haiku");
    assert.equal(entry.transport, "cli");
    assert.equal(entry.cli?.bin, "claude");
  });

  it("zero-arg-calls-unchanged: defaultRegistry() behaves as before extras feature", () => {
    const reg = defaultRegistry();
    const haiku = reg.resolve("haiku");
    assert.equal(haiku.id, "haiku");
    assert.equal(haiku.transport, "cli");
  });
});

describe("getProfile / getActiveProfile — extra profiles / config", () => {
  const projectProfile = {
    id: "project-custom",
    roles: { reasoner: "mymodel", worker: "mymodel", scout: "mymodel" } as const,
  };

  it("project-profile-overrides-builtin: project 'anthropic' shadows the built-in", () => {
    const customAnthropic = {
      id: "anthropic",
      roles: { reasoner: "deepseek", worker: "deepseek", scout: "deepseek" } as const,
    };
    const profile = getProfile("anthropic", [customAnthropic]);
    assert.equal(profile.roles.reasoner, "deepseek");
  });

  it("new-profile-resolvable: a project-declared profile id is found", () => {
    const profile = getProfile("project-custom", [projectProfile]);
    assert.equal(profile.id, "project-custom");
    assert.equal(profile.roles.reasoner, "mymodel");
  });

  it("unknown-profile-error-lists-union: error message names project + built-in ids", () => {
    assert.throws(
      () => getProfile("nonexistent", [projectProfile]),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.includes("nonexistent"), `must name the bad id: ${err.message}`);
        // Error must list both project and built-in ids.
        assert.ok(err.message.includes("project-custom"), `must list project id: ${err.message}`);
        assert.ok(err.message.includes("anthropic"), `must list built-in id: ${err.message}`);
        return true;
      }
    );
  });

  it("zero-arg-calls-unchanged: getProfile('anthropic') behaves as before", () => {
    const profile = getProfile("anthropic");
    assert.equal(profile.id, "anthropic");
    assert.equal(profile.roles.reasoner, "opus");
  });

  it("active-profile-precedence: env beats config.defaultProvider; config beats 'anthropic'", () => {
    const config = { models: [], profiles: [projectProfile], defaultProvider: "project-custom" };

    // env var wins over config.defaultProvider
    const fromEnv = getActiveProfile({ AGENT_FLOWS_PROVIDER: "openai" }, config);
    assert.equal(fromEnv.id, "openai");

    // config.defaultProvider wins when env is absent
    const fromConfig = getActiveProfile({}, config);
    assert.equal(fromConfig.id, "project-custom");

    // falls back to 'anthropic' when both are absent
    const fallback = getActiveProfile({}, { models: [], profiles: [] });
    assert.equal(fallback.id, "anthropic");
  });

  it("zero-arg-calls-unchanged: getActiveProfile({}) returns anthropic by default", () => {
    const profile = getActiveProfile({});
    assert.equal(profile.id, "anthropic");
  });
});
