import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runLlmStep } from "./runStep.js";
import { makeFakeSpawn } from "./testing/fakeSpawn.js";
import type { ModelEntry } from "./registry.js";

// ── claude CLI ────────────────────────────────────────────────────────────────

describe("runLlmStep — claude CLI", () => {
  const entry: ModelEntry = {
    id: "haiku",
    transport: "cli",
    cli: { bin: "claude", model: "haiku" },
  };

  it("passes --model and --output-format text to claude", async () => {
    const { spawn, capturedArgs } = makeFakeSpawn({ stdoutChunks: ["answer"] });
    await runLlmStep(entry, "hello", { spawn });
    assert.ok(capturedArgs[0].includes("--model"), "should pass --model");
    assert.ok(capturedArgs[0].includes("haiku"), "should pass model name");
    assert.ok(capturedArgs[0].includes("--output-format"), "should pass --output-format");
    assert.ok(capturedArgs[0].includes("text"), "should pass text format");
  });

  it("returns trimmed stdout", async () => {
    const { spawn } = makeFakeSpawn({ stdoutChunks: ["  PONG  "] });
    const result = await runLlmStep(entry, "say PONG", { spawn });
    assert.equal(result, "PONG");
  });

  it("rejects on non-zero exit", async () => {
    const { spawn } = makeFakeSpawn({ stderrChunks: ["err"], exitCode: 1 });
    await assert.rejects(runLlmStep(entry, "hi", { spawn }), /code 1/);
  });
});

// ── codex CLI ─────────────────────────────────────────────────────────────────

// Codex outputs JSONL with --json flag; we emit a minimal realistic sequence.
function makeCodexJsonlOutput(text: string): string {
  return [
    JSON.stringify({ type: "thread.started", thread_id: "abc" }),
    JSON.stringify({ type: "turn.started" }),
    JSON.stringify({
      type: "item.completed",
      item: { id: "item_0", type: "agent_message", text },
    }),
    JSON.stringify({ type: "turn.completed" }),
  ].join("\n");
}

describe("runLlmStep — codex CLI", () => {
  const entry: ModelEntry = {
    id: "codex-test",
    transport: "cli",
    cli: { bin: "codex", model: "o4-mini" },
  };

  it("passes exec --ephemeral --json -s read-only -m <model> args to codex", async () => {
    const { spawn, capturedArgs } = makeFakeSpawn({
      stdoutChunks: [makeCodexJsonlOutput("OK")],
    });
    await runLlmStep(entry, "hello", { spawn });
    assert.ok(capturedArgs[0].includes("exec"), "should have exec subcommand");
    assert.ok(capturedArgs[0].includes("--ephemeral"), "should pass --ephemeral");
    assert.ok(capturedArgs[0].includes("--json"), "should pass --json");
    assert.ok(capturedArgs[0].includes("-m"), "should pass -m");
    assert.ok(capturedArgs[0].includes("o4-mini"), "should pass model");
  });

  it("extracts agent_message text from JSONL output", async () => {
    const { spawn } = makeFakeSpawn({
      stdoutChunks: [makeCodexJsonlOutput("Hello from codex")],
    });
    const result = await runLlmStep(entry, "hello", { spawn });
    assert.equal(result, "Hello from codex");
  });

  it("extracts last agent_message when multiple present", async () => {
    const output = [
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "first" } }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "last" } }),
    ].join("\n");
    const { spawn } = makeFakeSpawn({ stdoutChunks: [output] });
    const result = await runLlmStep(entry, "hi", { spawn });
    assert.equal(result, "last");
  });

  it("rejects when no agent_message found in output", async () => {
    const { spawn } = makeFakeSpawn({ stdoutChunks: ['not json\n{"type":"turn.started"}'] });
    await assert.rejects(runLlmStep(entry, "hi", { spawn }), /agent_message/);
  });
});

// ── API transport ─────────────────────────────────────────────────────────────

function makeFakeFetch(opts: {
  status?: number;
  body?: unknown;
  captureRequest?: (url: string, init: RequestInit) => void;
}): typeof fetch {
  const { status = 200, body = { choices: [{ message: { content: "api-reply" } }] } } = opts;
  return async (url, init) => {
    opts.captureRequest?.(url as string, init!);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as Response;
  };
}

describe("runLlmStep — API transport", () => {
  const entry: ModelEntry = {
    id: "ollama-qwen",
    transport: "api",
    api: { endpoint: "http://localhost:11434/v1/chat/completions", model: "qwen2.5:1.5b" },
  };

  it("POSTs to endpoint with correct model and message", async () => {
    let captured: { url: string; body: unknown } | null = null;
    const fetchFn = makeFakeFetch({
      captureRequest: (url, init) => {
        captured = { url, body: JSON.parse(init.body as string) };
      },
    });
    await runLlmStep(entry, "hello", { fetchFn });
    assert.ok(captured !== null, "captureRequest callback should have been called");
    // TypeScript doesn't narrow `let` vars assigned in callbacks; cast explicitly.
    // The body type change (unknown → Record) makes this more than a null assertion.
    const cap = captured as { url: string; body: Record<string, unknown> };
    assert.equal(cap.url, "http://localhost:11434/v1/chat/completions");
    assert.deepEqual(cap.body.messages, [{ role: "user", content: "hello" }]);
    assert.equal(cap.body.model, "qwen2.5:1.5b");
  });

  it("returns choices[0].message.content", async () => {
    const fetchFn = makeFakeFetch({
      body: { choices: [{ message: { content: "qwen says hi" } }] },
    });
    const result = await runLlmStep(entry, "hi", { fetchFn });
    assert.equal(result, "qwen says hi");
  });

  it("does NOT set Authorization header when keyEnv is not set", async () => {
    let headers: Record<string, string> = {};
    const fetchFn = makeFakeFetch({
      captureRequest: (_url, init) => {
        headers = init.headers as Record<string, string>;
      },
    });
    await runLlmStep(entry, "hi", { fetchFn, env: {} });
    assert.equal(headers.Authorization, undefined);
  });

  it("sets Authorization header when keyEnv is set and env contains the key", async () => {
    const entryWithKey: ModelEntry = {
      id: "litellm",
      transport: "api",
      api: {
        endpoint: "http://localhost:4000/v1/chat/completions",
        model: "default",
        keyEnv: "LITELLM_VIRTUAL_KEY",
      },
    };
    let headers: Record<string, string> = {};
    const fetchFn = makeFakeFetch({
      captureRequest: (_url, init) => {
        headers = init.headers as Record<string, string>;
      },
    });
    await runLlmStep(entryWithKey, "hi", {
      fetchFn,
      env: { LITELLM_VIRTUAL_KEY: "vk-secret" },
    });
    assert.equal(headers.Authorization, "Bearer vk-secret");
  });

  it("does NOT set Authorization when keyEnv is set but env key is missing", async () => {
    const entryWithKey: ModelEntry = {
      id: "litellm",
      transport: "api",
      api: {
        endpoint: "http://localhost:4000/v1/chat/completions",
        model: "default",
        keyEnv: "LITELLM_VIRTUAL_KEY",
      },
    };
    let headers: Record<string, string> = {};
    const fetchFn = makeFakeFetch({
      captureRequest: (_url, init) => {
        headers = init.headers as Record<string, string>;
      },
    });
    await runLlmStep(entryWithKey, "hi", { fetchFn, env: {} });
    assert.equal(headers.Authorization, undefined);
  });

  it("rejects on non-200 response", async () => {
    const fetchFn = makeFakeFetch({ status: 500, body: { error: "internal" } });
    await assert.rejects(runLlmStep(entry, "hi", { fetchFn }), /500/);
  });

  it("rejects when choices[0].message.content is missing", async () => {
    const fetchFn = makeFakeFetch({ body: { choices: [] } });
    await assert.rejects(runLlmStep(entry, "hi", { fetchFn }), /choices\[0\]\.message\.content/);
  });
});
