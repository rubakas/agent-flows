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

    // opus, sonnet, haiku use bare aliases (always-latest); fable is pinned to claude-fable-5
    for (const alias of ["opus", "sonnet", "haiku"] as const) {
      const entry = reg.resolve(alias);
      assert.equal(entry.transport, "cli", `${alias} transport`);
      assert.equal(entry.cli?.bin, "claude", `${alias} bin`);
      assert.equal(entry.cli?.model, alias, `${alias} model`);
    }

    const fable = reg.resolve("fable");
    assert.equal(fable.transport, "cli", "fable transport");
    assert.equal(fable.cli?.bin, "claude", "fable bin");
    assert.equal(fable.cli?.model, "claude-fable-5", "fable model pinned");
  });

  it("unknown id resolves to passthrough cli entry with model=id", () => {
    const reg = defaultRegistry({});
    const entry = reg.resolve("claude-fable-5-1");
    assert.equal(entry.id, "claude-fable-5-1");
    assert.equal(entry.transport, "cli");
    assert.equal(entry.cli?.bin, "claude");
    assert.equal(entry.cli?.model, "claude-fable-5-1");
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
    assert.equal(p.roles.reasoner, "fable");
    assert.equal(p.roles.worker, "sonnet");
    assert.equal(p.roles.scout, "haiku");
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

  it("role=reasoner on anthropic resolves to fable entry", () => {
    const entry = resolveStepModel(step({ role: "reasoner" }), anthropic, reg);
    assert.equal(entry.id, "fable");
    assert.equal(entry.cli?.model, "claude-fable-5");
  });

  it("role=worker on anthropic resolves to sonnet entry", () => {
    const entry = resolveStepModel(step({ role: "worker" }), anthropic, reg);
    assert.equal(entry.id, "sonnet");
    assert.equal(entry.cli?.model, "sonnet");
  });

  it("role=scout on anthropic resolves to haiku entry", () => {
    const entry = resolveStepModel(step({ role: "scout" }), anthropic, reg);
    assert.equal(entry.id, "haiku");
    assert.equal(entry.cli?.model, "haiku");
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
