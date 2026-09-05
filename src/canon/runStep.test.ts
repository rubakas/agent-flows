import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";
import { DEFAULT_STEP_TIMEOUT_MS, StepTimeoutError, runCheckStep, runLlmStep } from "./runStep.js";
import { makeFakeChild, makeFakeSpawn } from "./testing/fakeSpawn.js";
import type { ModelEntry } from "./registry.js";
import type { SpawnFn } from "./runClaudeCli.js";

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

// ── Deadline enforcement ──────────────────────────────────────────────────────

// A spawn that hangs until kill() is called, then closes.
// The real fake spawn always closes via setImmediate; this one simulates a stuck provider.
function makeHangingSpawn(): { spawn: SpawnFn; killCalls: string[] } {
  const killCalls: string[] = [];
  const spawn = ((_cmd: string, _args: string[]) => {
    const emitter = new EventEmitter();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdin = new PassThrough();
    const child = Object.assign(emitter, {
      stdout,
      stderr,
      stdin,
      kill(sig?: string) {
        killCalls.push(sig ?? "SIGTERM");
        // Emit close to unblock the Promise, as a real killed process would.
        setImmediate(() => {
          stdout.push(null);
          stderr.push(null);
          emitter.emit("close", null);
        });
      },
    });
    // Never emit close naturally — the child hangs until killed.
    return child;
  }) as unknown as SpawnFn;
  return { spawn, killCalls };
}

describe("runLlmStep — deadline enforcement", () => {
  const entry: ModelEntry = {
    id: "haiku",
    transport: "cli",
    cli: { bin: "claude", model: "haiku" },
  };

  it("aborts a hung step and surfaces StepTimeoutError", async () => {
    const { spawn, killCalls } = makeHangingSpawn();
    await assert.rejects(runLlmStep(entry, "hang", { spawn, timeoutMs: 50 }), (err: unknown) => {
      assert.ok(err instanceof StepTimeoutError, `expected StepTimeoutError, got ${String(err)}`);
      assert.ok(err.message.includes("50"), "error message should include the timeout value");
      return true;
    });
    assert.ok(killCalls.length > 0, "child should have been killed when deadline fired");
  });

  it("resolves normally when step finishes before the deadline", async () => {
    const { spawn } = makeFakeSpawn({ stdoutChunks: ["done"] });
    const result = await runLlmStep(entry, "ping", { spawn, timeoutMs: 5000 });
    assert.equal(result, "done");
  });

  it("step-level timeoutMs overrides defaultTimeoutMs", async () => {
    // step timeoutMs: 50ms fires before defaultTimeoutMs: 10000ms
    const { spawn } = makeHangingSpawn();
    await assert.rejects(
      runLlmStep(entry, "hang", { spawn, timeoutMs: 50, defaultTimeoutMs: 10_000 }),
      (err: unknown) => {
        assert.ok(err instanceof StepTimeoutError);
        assert.equal(err.timeoutMs, 50, "should use step-level timeout, not the pipeline default");
        return true;
      }
    );
  });

  it("uses defaultTimeoutMs when timeoutMs is not set", async () => {
    const { spawn } = makeHangingSpawn();
    await assert.rejects(
      runLlmStep(entry, "hang", { spawn, defaultTimeoutMs: 50 }),
      (err: unknown) => {
        assert.ok(err instanceof StepTimeoutError);
        assert.equal(err.timeoutMs, 50);
        return true;
      }
    );
  });

  it("does not keep the process alive when step completes before its deadline", async () => {
    // A very long timeout that would block process exit if not cleared.
    // The step completes immediately (fast spawn). The test suite exits promptly,
    // proving the timer was removed by clearTimeout in the finally block.
    const { spawn } = makeFakeSpawn({ stdoutChunks: ["quick"] });
    const result = await runLlmStep(entry, "hi", { spawn, timeoutMs: 300_000 });
    assert.equal(result, "quick");
    // If clearTimeout were not called, the 300-second timer would hold the process
    // alive. The test suite completing promptly proves it was cleared.
  });

  it("applies the built-in DEFAULT_STEP_TIMEOUT_MS when no timeout is declared anywhere", async () => {
    // When deps has no timeoutMs or defaultTimeoutMs, the built-in constant fires.
    // DEFAULT_STEP_TIMEOUT_MS is 10 minutes — far too long to await in a test.
    // _builtInTimeoutMs overrides the constant so the built-in path is observable.
    assert.equal(DEFAULT_STEP_TIMEOUT_MS, 600_000, "built-in should be 10 minutes");
    const { spawn } = makeHangingSpawn();
    await assert.rejects(
      runLlmStep(entry, "hang", { spawn, _builtInTimeoutMs: 50 }),
      (err: unknown) => {
        assert.ok(
          err instanceof StepTimeoutError,
          "built-in path must surface StepTimeoutError, not a generic hang"
        );
        assert.equal(err.timeoutMs, 50);
        return true;
      }
    );
  });

  it("timeoutMs: 0 is an explicit escape hatch that disables the deadline", async () => {
    // Without the escape hatch, a 0ms timeout would fire immediately, aborting
    // even a fast step before it completes. timeoutMs: 0 must mean "no deadline".
    const { spawn } = makeFakeSpawn({ stdoutChunks: ["done"] });
    const result = await runLlmStep(entry, "hi", { spawn, timeoutMs: 0 });
    assert.equal(result, "done", "step with timeoutMs:0 must complete without being aborted");
  });
});

// ── workspace: "read" ─────────────────────────────────────────────────────────

// workspaceDir must be a real directory on disk; use the repo root (always exists).
const repoRoot = new URL("../../..", import.meta.url).pathname.replace(/\/$/, "");

describe('runLlmStep — workspace: "read"', () => {
  it('claude: spawns with --restricted --strict-mcp-config --tools Read,Glob --allowedTools Read,Glob and cwd=workspaceDir when contentsAccess is "read"', async () => {
    const entry: ModelEntry = {
      id: "haiku",
      transport: "cli",
      cli: { bin: "claude", model: "haiku" },
    };
    const { child } = makeFakeChild({ stdoutChunks: ["analysis result"] });
    let capturedArgs: string[] = [];
    let capturedCwd: string | undefined;
    const spawn = ((_cmd: string, args: string[], opts: { cwd?: string }) => {
      capturedArgs = args;
      capturedCwd = opts.cwd;
      return child;
    }) as unknown as SpawnFn;

    await runLlmStep(entry, "analyze repo", {
      spawn,
      contentsAccess: "read",
      workspaceDir: repoRoot,
    });

    assert.ok(capturedArgs.includes("--restricted"), "must include --restricted flag");
    assert.ok(
      capturedArgs.includes("--strict-mcp-config"),
      "must include --strict-mcp-config flag"
    );
    assert.ok(capturedArgs.includes("--tools"), "must include --tools flag");
    assert.ok(capturedArgs.includes("--allowedTools"), "must include --allowedTools flag");
    // Both flags must carry exactly the same restricted set.
    const toolsIdx = capturedArgs.indexOf("--tools");
    const allowedIdx = capturedArgs.indexOf("--allowedTools");
    assert.equal(capturedArgs[toolsIdx + 1], "Read,Glob", "--tools must be Read,Glob");
    assert.equal(capturedArgs[allowedIdx + 1], "Read,Glob", "--allowedTools must be Read,Glob");
    assert.equal(capturedCwd, repoRoot, "must set cwd to workspaceDir");
  });

  it('claude: spawns with --restricted --strict-mcp-config --tools Read,Glob,Edit,Write --allowedTools Read,Glob,Edit,Write and cwd=workspaceDir when contentsAccess is "write"', async () => {
    const entry: ModelEntry = {
      id: "haiku",
      transport: "cli",
      cli: { bin: "claude", model: "haiku" },
    };
    const { child } = makeFakeChild({ stdoutChunks: ["wrote file"] });
    let capturedArgs: string[] = [];
    let capturedCwd: string | undefined;
    const spawn = ((_cmd: string, args: string[], opts: { cwd?: string }) => {
      capturedArgs = args;
      capturedCwd = opts.cwd;
      return child;
    }) as unknown as SpawnFn;

    await runLlmStep(entry, "edit file", {
      spawn,
      contentsAccess: "write",
      workspaceDir: repoRoot,
    });

    assert.ok(capturedArgs.includes("--restricted"), "must include --restricted flag");
    assert.ok(
      capturedArgs.includes("--strict-mcp-config"),
      "must include --strict-mcp-config flag"
    );
    assert.ok(capturedArgs.includes("--tools"), "must include --tools flag");
    assert.ok(capturedArgs.includes("--allowedTools"), "must include --allowedTools flag");
    const toolsIdx = capturedArgs.indexOf("--tools");
    const allowedIdx = capturedArgs.indexOf("--allowedTools");
    assert.equal(
      capturedArgs[toolsIdx + 1],
      "Read,Glob,Edit,Write",
      "--tools must be Read,Glob,Edit,Write"
    );
    assert.equal(
      capturedArgs[allowedIdx + 1],
      "Read,Glob,Edit,Write",
      "--allowedTools must be Read,Glob,Edit,Write"
    );
    // Bash must not appear in the tool set.
    assert.ok(!capturedArgs.includes("Bash"), "Bash must not be granted in write mode");
    assert.equal(capturedCwd, repoRoot, "must set cwd to workspaceDir");
  });

  it("claude: read mode exact arg list includes --restricted and --strict-mcp-config before tool flags", async () => {
    const entry: ModelEntry = {
      id: "haiku",
      transport: "cli",
      cli: { bin: "claude", model: "haiku" },
    };
    const { child } = makeFakeChild({ stdoutChunks: ["ok"] });
    let capturedArgs: string[] = [];
    const spawn = ((_cmd: string, args: string[]) => {
      capturedArgs = args;
      return child;
    }) as unknown as SpawnFn;

    await runLlmStep(entry, "read something", {
      spawn,
      contentsAccess: "read",
      workspaceDir: repoRoot,
    });

    // --restricted and --strict-mcp-config must both appear in the argument list.
    // They must appear before --tools so the CLI processes them first.
    const restrictedIdx = capturedArgs.indexOf("--restricted");
    const strictMcpIdx = capturedArgs.indexOf("--strict-mcp-config");
    const toolsIdx = capturedArgs.indexOf("--tools");
    assert.ok(restrictedIdx !== -1, "read mode must pass --restricted");
    assert.ok(strictMcpIdx !== -1, "read mode must pass --strict-mcp-config");
    assert.ok(restrictedIdx < toolsIdx, "--restricted must appear before --tools");
    assert.ok(strictMcpIdx < toolsIdx, "--strict-mcp-config must appear before --tools");
  });

  it("claude: write mode exact arg list includes --restricted and --strict-mcp-config before tool flags", async () => {
    const entry: ModelEntry = {
      id: "haiku",
      transport: "cli",
      cli: { bin: "claude", model: "haiku" },
    };
    const { child } = makeFakeChild({ stdoutChunks: ["ok"] });
    let capturedArgs: string[] = [];
    const spawn = ((_cmd: string, args: string[]) => {
      capturedArgs = args;
      return child;
    }) as unknown as SpawnFn;

    await runLlmStep(entry, "write something", {
      spawn,
      contentsAccess: "write",
      workspaceDir: repoRoot,
    });

    const restrictedIdx = capturedArgs.indexOf("--restricted");
    const strictMcpIdx = capturedArgs.indexOf("--strict-mcp-config");
    const toolsIdx = capturedArgs.indexOf("--tools");
    assert.ok(restrictedIdx !== -1, "write mode must pass --restricted");
    assert.ok(strictMcpIdx !== -1, "write mode must pass --strict-mcp-config");
    assert.ok(restrictedIdx < toolsIdx, "--restricted must appear before --tools");
    assert.ok(strictMcpIdx < toolsIdx, "--strict-mcp-config must appear before --tools");
  });

  it("claude: no --allowedTools and no cwd when contentsAccess is not set", async () => {
    const entry: ModelEntry = {
      id: "haiku",
      transport: "cli",
      cli: { bin: "claude", model: "haiku" },
    };
    const { child } = makeFakeChild({ stdoutChunks: ["answer"] });
    let capturedArgs: string[] = [];
    let capturedCwd: string | undefined;
    const spawn = ((_cmd: string, args: string[], opts: { cwd?: string }) => {
      capturedArgs = args;
      capturedCwd = opts.cwd;
      return child;
    }) as unknown as SpawnFn;

    await runLlmStep(entry, "hello", { spawn });

    assert.ok(
      !capturedArgs.includes("--allowedTools"),
      "must not add --allowedTools when no workspace declared"
    );
    assert.equal(capturedCwd, undefined, "must not set cwd when no workspace declared");
  });

  it('codex: sets cwd=workspaceDir when contentsAccess is "read" (already has -s read-only)', async () => {
    const entry: ModelEntry = {
      id: "codex-test",
      transport: "cli",
      cli: { bin: "codex", model: "o4-mini" },
    };
    const { child } = makeFakeChild({ stdoutChunks: [makeCodexJsonlOutput("ok")] });
    let capturedCwd: string | undefined;
    const spawn = ((_cmd: string, _args: string[], opts: { cwd?: string }) => {
      capturedCwd = opts.cwd;
      return child;
    }) as unknown as SpawnFn;

    await runLlmStep(entry, "analyze", { spawn, contentsAccess: "read", workspaceDir: repoRoot });

    assert.equal(capturedCwd, repoRoot, "must set cwd to workspaceDir");
  });

  it("codex: no cwd when contentsAccess is not set", async () => {
    const entry: ModelEntry = {
      id: "codex-test",
      transport: "cli",
      cli: { bin: "codex", model: "o4-mini" },
    };
    const { child } = makeFakeChild({ stdoutChunks: [makeCodexJsonlOutput("answer")] });
    let capturedCwd: string | undefined;
    const spawn = ((_cmd: string, _args: string[], opts: { cwd?: string }) => {
      capturedCwd = opts.cwd;
      return child;
    }) as unknown as SpawnFn;

    await runLlmStep(entry, "hello", { spawn });

    assert.equal(capturedCwd, undefined, "must not set cwd when no workspace declared");
  });

  it('codex: rejects when contentsAccess is "write" (codex always runs read-only)', async () => {
    const entry: ModelEntry = {
      id: "codex-test",
      transport: "cli",
      cli: { bin: "codex", model: "o4-mini" },
    };
    const { spawn } = makeFakeSpawn({ stdoutChunks: [makeCodexJsonlOutput("irrelevant")] });

    await assert.rejects(
      runLlmStep(entry, "hi", { spawn, contentsAccess: "write", workspaceDir: repoRoot }),
      /codex.*write|write.*codex/i
    );
  });

  it('api transport: rejects when contentsAccess is "read" (no CLI sandbox available)', async () => {
    const entry: ModelEntry = {
      id: "ollama-qwen",
      transport: "api",
      api: { endpoint: "http://localhost:11434/v1/chat/completions", model: "qwen2.5:1.5b" },
    };

    await assert.rejects(
      runLlmStep(entry, "hi", { contentsAccess: "read", workspaceDir: repoRoot }),
      /api.*permissions|permissions.*api/i
    );
  });

  it('api transport: rejects when contentsAccess is "write" (no CLI sandbox available)', async () => {
    const entry: ModelEntry = {
      id: "ollama-qwen",
      transport: "api",
      api: { endpoint: "http://localhost:11434/v1/chat/completions", model: "qwen2.5:1.5b" },
    };

    await assert.rejects(
      runLlmStep(entry, "hi", { contentsAccess: "write", workspaceDir: repoRoot }),
      /api.*permissions|permissions.*api/i
    );
  });

  it("rejects when workspaceDir is not a real directory", async () => {
    const entry: ModelEntry = {
      id: "haiku",
      transport: "cli",
      cli: { bin: "claude", model: "haiku" },
    };
    const { spawn } = makeFakeSpawn({ stdoutChunks: ["irrelevant"] });

    await assert.rejects(
      runLlmStep(entry, "hi", {
        spawn,
        contentsAccess: "read",
        workspaceDir: "/definitely/does/not/exist/yoke-test-9482",
      }),
      /workspaceDir/
    );
  });
});

// ── codex key scrubbing (Fix 3) ───────────────────────────────────────────────

describe("runLlmStep — codex key isolation", () => {
  it("codex: SCRUBBED_KEYS are absent from the env passed to spawn", async () => {
    const codexEntry: ModelEntry = {
      id: "codex-scrub-test",
      transport: "cli",
      cli: { bin: "codex", model: "o4-mini" },
    };
    let capturedEnv: NodeJS.ProcessEnv | undefined;
    const spawn = ((_cmd: string, _args: string[], opts: { env?: NodeJS.ProcessEnv }) => {
      capturedEnv = opts.env;
      const { child } = makeFakeChild({ stdoutChunks: [makeCodexJsonlOutput("ok")] });
      return child;
    }) as unknown as SpawnFn;

    await runLlmStep(codexEntry, "hello", {
      spawn,
      env: {
        PATH: "/usr/bin",
        ANTHROPIC_API_KEY: "sk-ant-secret",
        OPENAI_API_KEY: "sk-openai-secret",
        LITELLM_VIRTUAL_KEY: "vk-secret",
      },
    });

    assert.ok(capturedEnv !== undefined, "spawn must have been called");
    assert.equal(capturedEnv.ANTHROPIC_API_KEY, undefined, "ANTHROPIC_API_KEY must be scrubbed");
    assert.equal(capturedEnv.OPENAI_API_KEY, undefined, "OPENAI_API_KEY must be scrubbed");
    assert.equal(
      capturedEnv.LITELLM_VIRTUAL_KEY,
      undefined,
      "LITELLM_VIRTUAL_KEY must be scrubbed"
    );
    assert.equal(capturedEnv.PATH, "/usr/bin", "non-scrubbed keys must be preserved");
  });
});

// ── runCheckStep — real execution ─────────────────────────────────────────────

describe("runCheckStep — real execution", () => {
  it("command exiting 0 yields passed:true with exitCode 0", async () => {
    const result = await runCheckStep("exit 0");
    assert.equal(result.passed, true);
    assert.equal(result.exitCode, 0);
    assert.equal(typeof result.output, "string");
  });

  it("command exiting non-zero yields passed:false with that exit code, no throw", async () => {
    const result = await runCheckStep("exit 1");
    assert.equal(result.passed, false);
    assert.equal(result.exitCode, 1);
  });

  it("command exiting with arbitrary code captures that exact code", async () => {
    const result = await runCheckStep("exit 42");
    assert.equal(result.passed, false);
    assert.equal(result.exitCode, 42);
  });

  it("stdout is captured in the output field", async () => {
    const result = await runCheckStep("printf 'hello world'");
    assert.ok(result.output.includes("hello world"), "output should contain printed text");
  });

  it("timeout yields passed:false and output mentions the timeout", async () => {
    const result = await runCheckStep("sleep 60", { timeoutMs: 100 });
    assert.equal(result.passed, false);
    assert.equal(result.exitCode, -1);
    assert.ok(
      result.output.toLowerCase().includes("timeout") || result.output.includes("100ms"),
      `output should mention timeout; got: ${result.output}`
    );
  });
});
