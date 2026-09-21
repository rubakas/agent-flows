import assert from "node:assert/strict";
import { spawn as realSpawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";
import { packageRoot } from "../packageRoot.js";
import { StepBudgetExceededError } from "./runClaudeCli.js";
import {
  BUILD_CONFIG_DENY_PATTERNS,
  CREDENTIAL_DENY_PATTERNS,
  DEFAULT_STEP_TIMEOUT_MS,
  StepTimeoutError,
  StepWatchdogError,
  WATCHDOG_DIGEST_OPEN,
  WATCHDOG_DIGEST_CLOSE,
  runCheckStep,
  runLlmStep,
} from "./runStep.js";
import {
  makeFakeChild,
  makeFakeSpawn,
  makeStreamJsonStdout,
  makeStreamJsonChild,
} from "./testing/fakeSpawn.js";
import type { ModelEntry } from "./registry.js";
import type { SpawnFn } from "./runClaudeCli.js";
import type { StepRunnerDeps } from "./runStep.js";
import type { StepLogEventInput } from "./stepLogEvents.js";

// ── claude CLI ────────────────────────────────────────────────────────────────

describe("runLlmStep — claude CLI", () => {
  const entry: ModelEntry = {
    id: "haiku",
    transport: "cli",
    cli: { bin: "claude", model: "haiku" },
  };

  it("passes --model and --output-format stream-json to claude (FR-001)", async () => {
    const { spawn, capturedArgs } = makeFakeSpawn({
      stdoutChunks: [makeStreamJsonStdout("answer")],
    });
    await runLlmStep(entry, "hello", { spawn });
    assert.ok(capturedArgs[0].includes("--model"), "should pass --model");
    assert.ok(capturedArgs[0].includes("haiku"), "should pass model name");
    assert.ok(capturedArgs[0].includes("--output-format"), "should pass --output-format");
    assert.ok(capturedArgs[0].includes("stream-json"), "should pass stream-json format (not text)");
    assert.ok(capturedArgs[0].includes("--verbose"), "should pass --verbose");
    assert.ok(
      capturedArgs[0].includes("--include-partial-messages"),
      "should pass --include-partial-messages"
    );
  });

  it("returns trimmed result text from stream-json result event", async () => {
    const { spawn } = makeFakeSpawn({ stdoutChunks: [makeStreamJsonStdout("  PONG  ")] });
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

  it("passes exec --ephemeral --json -m <model> args to codex, and never -s", async () => {
    const { spawn, capturedArgs } = makeFakeSpawn({
      stdoutChunks: [makeCodexJsonlOutput("OK")],
    });
    await runLlmStep(entry, "hello", { spawn });
    assert.ok(capturedArgs[0].includes("exec"), "should have exec subcommand");
    assert.ok(capturedArgs[0].includes("--ephemeral"), "should pass --ephemeral");
    assert.ok(capturedArgs[0].includes("--json"), "should pass --json");
    assert.ok(capturedArgs[0].includes("-m"), "should pass -m");
    assert.ok(capturedArgs[0].includes("o4-mini"), "should pass model");
    // Spec 031 D2: `-s` does not confine reads and cannot be combined with
    // default_permissions; the composed profile replaces it.
    assert.ok(!capturedArgs[0].includes("-s"), "must not pass -s");
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
    const { spawn } = makeFakeSpawn({ stdoutChunks: [makeStreamJsonStdout("done")] });
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
    const { spawn } = makeFakeSpawn({ stdoutChunks: [makeStreamJsonStdout("quick")] });
    const result = await runLlmStep(entry, "hi", { spawn, timeoutMs: 300_000 });
    assert.equal(result, "quick");
    // If clearTimeout were not called, the 300-second timer would hold the process
    // alive. The test suite completing promptly proves it was cleared.
  });

  it("_builtInTimeoutMs override fires on hanging claude step when explicitly set", async () => {
    // FR-008: claude-transport steps have no built-in duration fallback by default
    // (watchdog supervises them). But _builtInTimeoutMs can still be used to inject
    // a test-only fallback. This tests the _builtInTimeoutMs path is still wired.
    assert.equal(
      DEFAULT_STEP_TIMEOUT_MS,
      600_000,
      "built-in constant value must remain 10 minutes"
    );
    const { spawn } = makeHangingSpawn();
    await assert.rejects(
      runLlmStep(entry, "hang", { spawn, _builtInTimeoutMs: 50 }),
      (err: unknown) => {
        assert.ok(
          err instanceof StepTimeoutError,
          "_builtInTimeoutMs path must surface StepTimeoutError"
        );
        assert.equal(err.timeoutMs, 50);
        return true;
      }
    );
  });

  it("timeoutMs: 0 disables the deadline on claude, whose watchdog supervises", async () => {
    // Without the escape hatch, a 0ms timeout would fire immediately, aborting
    // even a fast step before it completes. On claude, timeoutMs: 0 means "no
    // deadline" and the progress watchdog remains the supervisor; on codex and
    // api it is clamped back to the built-in fallback (withDeadline), because
    // there it would mean no supervision at all.
    const { spawn } = makeFakeSpawn({ stdoutChunks: [makeStreamJsonStdout("done")] });
    const result = await runLlmStep(entry, "hi", { spawn, timeoutMs: 0 });
    assert.equal(result, "done", "step with timeoutMs:0 must complete without being aborted");
  });
});

// ── FR-008: claude transport has no built-in deadline ────────────────────────

describe("runLlmStep — FR-008 timeout matrix", () => {
  const claudeEntry: ModelEntry = {
    id: "haiku",
    transport: "cli",
    cli: { bin: "claude", model: "haiku" },
  };
  const apiEntry: ModelEntry = {
    id: "ollama",
    transport: "api",
    api: { endpoint: "http://localhost:11434/v1/chat/completions", model: "qwen" },
  };

  it("claude step with explicit timeoutMs: 50 still fires StepTimeoutError", async () => {
    const { spawn } = makeHangingSpawn();
    await assert.rejects(
      runLlmStep(claudeEntry, "hang", { spawn, timeoutMs: 50 }),
      (err: unknown) => {
        assert.ok(err instanceof StepTimeoutError);
        assert.equal(err.timeoutMs, 50);
        return true;
      }
    );
  });

  it("claude step with no timeout fields: fast step resolves (no built-in deadline)", async () => {
    const { spawn } = makeFakeSpawn({ stdoutChunks: [makeStreamJsonStdout("done")] });
    const result = await runLlmStep(claudeEntry, "hi", { spawn });
    assert.equal(result, "done");
  });

  it("api step with _builtInTimeoutMs still fires StepTimeoutError (api keeps built-in)", async () => {
    // fetchFn must honour the AbortSignal so the deadline can interrupt it
    const fetchFn: typeof fetch = async (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        const sig = init?.signal;
        const abort = () => reject(new DOMException("The operation was aborted.", "AbortError"));
        if (sig?.aborted) {
          abort();
          return;
        }
        sig?.addEventListener("abort", abort, { once: true });
      });
    await assert.rejects(
      runLlmStep(apiEntry, "hang", { fetchFn, _builtInTimeoutMs: 50 }),
      (err: unknown) => {
        assert.ok(err instanceof StepTimeoutError, `expected StepTimeoutError, got ${String(err)}`);
        return true;
      }
    );
  });
});

// ── Watchdog: retry and failure (FR-005, FR-006) ──────────────────────────────

describe("runLlmStep — watchdog retry (FR-005/FR-006)", () => {
  const entry: ModelEntry = {
    id: "haiku",
    transport: "cli",
    cli: { bin: "claude", model: "haiku" },
  };

  it("T-4 loop: 4 identical tool_use blocks trip loop detector → WatchdogTrip → retry resolves", async () => {
    // Build a fake attempt-1 stream with 4 identical Read tool_use blocks
    // followed by a result event. The loop detector trips on the 4th pair,
    // kills the child, and runClaudeCli rejects with WatchdogTrip.
    // Then runLlmStep retries with attempt 2 which returns clean output.
    const assistantWithLoopEvent = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", id: "t1", name: "Read", input: { path: "/same.ts" } },
          { type: "tool_use", id: "t2", name: "Read", input: { path: "/same.ts" } },
          { type: "tool_use", id: "t3", name: "Read", input: { path: "/same.ts" } },
          { type: "tool_use", id: "t4", name: "Read", input: { path: "/same.ts" } },
        ],
      },
    });

    let callCount = 0;
    let secondStdin = "";

    const spawn = ((_cmd: string, _args: string[]) => {
      callCount++;
      const emitter = new EventEmitter();
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const stdin = new PassThrough();
      stdin.on("data", (d: Buffer) => (secondStdin += d.toString()));

      const child = Object.assign(emitter, {
        stdout,
        stderr,
        stdin,
        kill(_sig?: string) {
          setImmediate(() => {
            if (!stdout.destroyed) stdout.push(null);
            if (!stderr.destroyed) stderr.push(null);
            emitter.emit("close", null);
          });
        },
      });

      if (callCount === 1) {
        // Attempt 1: emit assistant event with 4 identical tool_use → loop trips
        setImmediate(() => {
          stdout.push(assistantWithLoopEvent + "\n");
          // The loop detector fires synchronously in the data handler and kills the child.
          // Close happens via kill above. Don't close stdout here; kill() handles it.
        });
      } else {
        // Attempt 2: clean result
        setImmediate(() => {
          stdout.push(makeStreamJsonStdout("attempt 2 clean result"));
          stdout.push(null);
          stderr.push(null);
          emitter.emit("close", 0);
        });
      }

      return child;
    }) as unknown as SpawnFn;

    const result = await runLlmStep(entry, "do something", { spawn, _stallSilenceMs: 30_000 });
    assert.equal(result, "attempt 2 clean result");
    assert.equal(callCount, 2, "must have made exactly 2 spawn calls");
  });

  it("T-5: loop trip on both attempts → StepWatchdogError naming both pathologies", async () => {
    // Both attempts emit 4 identical tool_use blocks → loop trips on both
    const assistantWithLoopEvent = JSON.stringify({
      type: "assistant",
      message: {
        content: Array.from({ length: 4 }, (_, i) => ({
          type: "tool_use",
          id: `t${i}`,
          name: "Read",
          input: { path: "/stuck.ts" },
        })),
      },
    });

    let callCount = 0;
    const spawn = ((_cmd: string, _args: string[]) => {
      callCount++;
      const emitter = new EventEmitter();
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const stdin = new PassThrough();
      const child = Object.assign(emitter, {
        stdout,
        stderr,
        stdin,
        kill() {
          setImmediate(() => {
            if (!stdout.destroyed) stdout.push(null);
            if (!stderr.destroyed) stderr.push(null);
            emitter.emit("close", null);
          });
        },
      });
      setImmediate(() => {
        stdout.push(assistantWithLoopEvent + "\n");
      });
      return child;
    }) as unknown as SpawnFn;

    await assert.rejects(
      runLlmStep(entry, "stuck", { spawn, _stallSilenceMs: 30_000 }),
      (err: unknown) => {
        assert.ok(
          err instanceof StepWatchdogError,
          `expected StepWatchdogError, got ${String(err)}`
        );
        assert.ok(err.message.includes("2 attempts"), `message: ${err.message}`);
        assert.ok(err.message.includes("loop"), `message: ${err.message}`);
        assert.equal(callCount, 2, "must have made exactly 2 spawn calls");
        return true;
      }
    );
  });

  it("T-7: BLOCKED report on attempt 2 → step fails (never returned as output)", async () => {
    // Attempt 1: loop trips (same as above)
    // Attempt 2: returns "BLOCKED: cannot read that file"
    const assistantWithLoopEvent = JSON.stringify({
      type: "assistant",
      message: {
        content: Array.from({ length: 4 }, (_, i) => ({
          type: "tool_use",
          id: `t${i}`,
          name: "Read",
          input: { path: "/b.ts" },
        })),
      },
    });

    let callCount = 0;
    const spawn = ((_cmd: string, _args: string[]) => {
      callCount++;
      const emitter = new EventEmitter();
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const stdin = new PassThrough();
      const child = Object.assign(emitter, {
        stdout,
        stderr,
        stdin,
        kill() {
          setImmediate(() => {
            if (!stdout.destroyed) stdout.push(null);
            if (!stderr.destroyed) stderr.push(null);
            emitter.emit("close", null);
          });
        },
      });
      if (callCount === 1) {
        setImmediate(() => {
          stdout.push(assistantWithLoopEvent + "\n");
        });
      } else {
        setImmediate(() => {
          stdout.push(makeStreamJsonStdout("BLOCKED: cannot read restricted file"));
          stdout.push(null);
          stderr.push(null);
          emitter.emit("close", 0);
        });
      }
      return child;
    }) as unknown as SpawnFn;

    await assert.rejects(
      runLlmStep(entry, "blocked task", { spawn, _stallSilenceMs: 30_000 }),
      (err: unknown) => {
        assert.ok(
          err instanceof StepWatchdogError,
          `expected StepWatchdogError, got ${String(err)}`
        );
        // The BLOCKED text must be in the error, not returned as step output
        assert.ok(
          err.message.includes("BLOCKED:") ||
            err.trips?.some((t: unknown) =>
              String((t as { detail?: string }).detail ?? "").includes("BLOCKED:")
            ),
          `expected BLOCKED in error: ${err.message}`
        );
        return true;
      }
    );
  });

  it("T-3: reformulated prompt on retry contains original prompt, 'attempt 2 of 2', and digest delimiters", async () => {
    // Trip attempt 1 with loop, capture what was sent to attempt 2's stdin
    const assistantWithLoopEvent = JSON.stringify({
      type: "assistant",
      message: {
        content: Array.from({ length: 4 }, (_, i) => ({
          type: "tool_use",
          id: `t${i}`,
          name: "Glob",
          input: { pattern: "*.ts" },
        })),
      },
    });

    let callCount = 0;
    let capturedStdin = "";
    const spawn = ((_cmd: string, _args: string[]) => {
      callCount++;
      const emitter = new EventEmitter();
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const stdin = new PassThrough();
      if (callCount === 2) {
        stdin.on("data", (d: Buffer) => (capturedStdin += d.toString()));
      }
      const child = Object.assign(emitter, {
        stdout,
        stderr,
        stdin,
        kill() {
          setImmediate(() => {
            if (!stdout.destroyed) stdout.push(null);
            if (!stderr.destroyed) stderr.push(null);
            emitter.emit("close", null);
          });
        },
      });
      if (callCount === 1) {
        setImmediate(() => {
          stdout.push(assistantWithLoopEvent + "\n");
        });
      } else {
        setImmediate(() => {
          stdout.push(makeStreamJsonStdout("retry succeeded"));
          stdout.push(null);
          stderr.push(null);
          emitter.emit("close", 0);
        });
      }
      return child;
    }) as unknown as SpawnFn;

    const result = await runLlmStep(entry, "my original prompt", {
      spawn,
      _stallSilenceMs: 30_000,
    });
    assert.equal(result, "retry succeeded");

    // Verify reformulated prompt structure
    assert.ok(
      capturedStdin.includes("my original prompt"),
      "reformulated prompt must include original prompt verbatim"
    );
    assert.ok(
      capturedStdin.includes("attempt 2 of 2"),
      `reformulated prompt must include 'attempt 2 of 2', got: ${capturedStdin.slice(0, 200)}`
    );
    assert.ok(
      capturedStdin.includes(WATCHDOG_DIGEST_OPEN),
      "reformulated prompt must include digest open sentinel"
    );
    assert.ok(
      capturedStdin.includes(WATCHDOG_DIGEST_CLOSE),
      "reformulated prompt must include digest close sentinel"
    );
  });
});

// ── FR-007: budget wiring in runLlmStep ──────────────────────────────────────

describe("runLlmStep — FR-007 budget wiring", () => {
  const entry: ModelEntry = {
    id: "haiku",
    transport: "cli",
    cli: { bin: "claude", model: "haiku" },
  };

  it("maxBudgetUsd: 2 on deps yields --max-budget-usd 2 in argv", async () => {
    const { spawn, capturedArgs } = makeFakeSpawn({
      stdoutChunks: [makeStreamJsonStdout("ok")],
    });
    await runLlmStep(entry, "hi", { spawn, maxBudgetUsd: 2 });
    const budgetIdx = capturedArgs[0].indexOf("--max-budget-usd");
    assert.ok(budgetIdx !== -1, "--max-budget-usd must be in argv");
    assert.equal(capturedArgs[0][budgetIdx + 1], "2");
  });

  it("absent maxBudgetUsd: --max-budget-usd flag absent", async () => {
    const { spawn, capturedArgs } = makeFakeSpawn({
      stdoutChunks: [makeStreamJsonStdout("ok")],
    });
    await runLlmStep(entry, "hi", { spawn });
    assert.ok(!capturedArgs[0].includes("--max-budget-usd"), "flag must be absent");
  });

  it("api transport rejects if maxBudgetUsd is set (runtime error)", async () => {
    const apiEntry: ModelEntry = {
      id: "api-test",
      transport: "api",
      api: { endpoint: "http://localhost/v1/chat", model: "gpt" },
    };
    const fetchFn = async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: "ok" } }] }),
        text: async () => "{}",
      }) as Response;
    await assert.rejects(
      runLlmStep(apiEntry, "hi", { fetchFn, maxBudgetUsd: 1 }),
      /maxBudgetUsd.*not supported.*api/i
    );
  });

  it("StepBudgetExceededError propagates from runClaudeCli to runLlmStep caller", async () => {
    const budgetLine = JSON.stringify({
      type: "result",
      subtype: "error_max_budget_usd",
      is_error: true,
      result: "Budget exceeded",
      total_cost_usd: 3.0,
      num_turns: 5,
    });
    const stdout = JSON.stringify({ type: "system", subtype: "init" }) + "\n" + budgetLine + "\n";
    const { spawn } = makeFakeSpawn({ stdoutChunks: [stdout] });
    await assert.rejects(runLlmStep(entry, "hi", { spawn, maxBudgetUsd: 2 }), (err: unknown) => {
      assert.ok(
        err instanceof StepBudgetExceededError,
        `expected StepBudgetExceededError, got ${String(err)}`
      );
      assert.equal(err.limitUsd, 2);
      assert.equal(err.estimatedUsd, 3.0);
      return true;
    });
  });
});

// ── workspace: "read" ─────────────────────────────────────────────────────────

// workspaceDir must be a real directory on disk; use the package root's parent
// (always exists, and deliberately not a git work tree — see the sanitizer test).
const repoRoot = dirname(packageRoot());

describe('runLlmStep — workspace: "read"', () => {
  it('claude: spawns with --restricted --strict-mcp-config --tools Read,Glob,Grep --allowedTools Read,Glob,Grep and cwd=workspaceDir when contentsAccess is "read"', async () => {
    const entry: ModelEntry = {
      id: "haiku",
      transport: "cli",
      cli: { bin: "claude", model: "haiku" },
    };
    const { child } = makeStreamJsonChild("analysis result");
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
    assert.equal(capturedArgs[toolsIdx + 1], "Read,Glob,Grep", "--tools must be Read,Glob,Grep");
    assert.equal(
      capturedArgs[allowedIdx + 1],
      "Read,Glob,Grep",
      "--allowedTools must be Read,Glob,Grep"
    );
    assert.equal(capturedCwd, repoRoot, "must set cwd to workspaceDir");
  });

  it('claude: spawns with --restricted --strict-mcp-config --tools Read,Glob,Grep,Edit,Write --allowedTools Read,Glob,Grep,Edit,Write and cwd=workspaceDir when contentsAccess is "write"', async () => {
    const entry: ModelEntry = {
      id: "haiku",
      transport: "cli",
      cli: { bin: "claude", model: "haiku" },
    };
    const { child } = makeStreamJsonChild("wrote file");
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
      "Read,Glob,Grep,Edit,Write",
      "--tools must be Read,Glob,Grep,Edit,Write"
    );
    assert.equal(
      capturedArgs[allowedIdx + 1],
      "Read,Glob,Grep,Edit,Write",
      "--allowedTools must be Read,Glob,Grep,Edit,Write"
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
    const { child } = makeStreamJsonChild("ok");
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
    const { child } = makeStreamJsonChild("ok");
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

  it("claude: no-permissions step gets --restricted --strict-mcp-config --tools Read,Glob and no cwd", async () => {
    // This test previously asserted the VULNERABLE behaviour: that no extra args
    // were emitted when no permissions were declared. That assertion encoded the
    // bug — a step with no permissions inherited the full default tool set
    // (Bash, WebFetch, operator settings). It is now inverted: hardening is
    // unconditional, so even a pure text step is confined.
    //
    // Note: the CLI help documents `--tools ""` as disabling all tools; empirically
    // it re-enables Bash even under --restricted. The safe fallback is "Read,Glob"
    // which reliably limits the session to read-only file operations.
    const entry: ModelEntry = {
      id: "haiku",
      transport: "cli",
      cli: { bin: "claude", model: "haiku" },
    };
    const { child } = makeStreamJsonChild("answer");
    let capturedArgs: string[] = [];
    let capturedCwd: string | undefined;
    const spawn = ((_cmd: string, args: string[], opts: { cwd?: string }) => {
      capturedArgs = args;
      capturedCwd = opts.cwd;
      return child;
    }) as unknown as SpawnFn;

    await runLlmStep(entry, "hello", { spawn });

    assert.ok(
      capturedArgs.includes("--restricted"),
      "no-permissions step must get --restricted (hardening is unconditional)"
    );
    assert.ok(
      capturedArgs.includes("--strict-mcp-config"),
      "no-permissions step must get --strict-mcp-config"
    );
    const toolsIdx = capturedArgs.indexOf("--tools");
    assert.ok(toolsIdx !== -1, "no-permissions step must get --tools");
    assert.equal(
      capturedArgs[toolsIdx + 1],
      "Read,Glob",
      "--tools must be Read,Glob for a no-permissions step (safe fallback: --tools '' re-enables Bash)"
    );
    const allowedIdx = capturedArgs.indexOf("--allowedTools");
    assert.ok(allowedIdx !== -1, "no-permissions step must get --allowedTools");
    assert.equal(capturedArgs[allowedIdx + 1], "Read,Glob", "--allowedTools must be Read,Glob");
    assert.equal(capturedCwd, undefined, "must not set cwd when no workspace declared");
  });

  it('codex: contents "read" runs against a sanitized copy, never the real repo', async () => {
    // Spec 031 D2: the copy plus the composed permission profile replaced the
    // blanket refusal. Lifecycle and flag assertions live in adapters/codex.test.ts.
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

    // The sanitizer shells out to `git ls-files`, so this needs the real repo —
    // `repoRoot` above is its parent and is not a git work tree.
    const gitRoot = packageRoot();
    const result = await runLlmStep(entry, "analyze", {
      spawn,
      contentsAccess: "read",
      workspaceDir: gitRoot,
    });

    assert.equal(result, "answer");
    assert.ok(capturedCwd !== undefined, "the step must run in a grant directory");
    assert.notEqual(capturedCwd, gitRoot, "the step must never run in the real repo");
  });

  it("codex: a step with no workspace still runs confined, in a throwaway grant dir", async () => {
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

    // A text-only step must not be able to read the disk either, so it gets an
    // empty grant rather than the daemon's working directory.
    assert.ok(capturedCwd !== undefined, "must run in a grant directory");
    assert.notEqual(capturedCwd, process.cwd(), "must not run in the daemon's cwd");
    assert.notEqual(capturedCwd, repoRoot, "must not run in the repo");
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
    const { spawn } = makeFakeSpawn({ stdoutChunks: [makeStreamJsonStdout("irrelevant")] });

    await assert.rejects(
      runLlmStep(entry, "hi", {
        spawn,
        contentsAccess: "read",
        workspaceDir: "/definitely/does/not/exist/agent-flows-test-9482",
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

// ── skills declaration ────────────────────────────────────────────────────────

describe("runLlmStep — skills", () => {
  const entry: ModelEntry = {
    id: "haiku",
    transport: "cli",
    cli: { bin: "claude", model: "haiku" },
  };

  it("step with no skills emits exactly today's arg list (no --plugin-dir, Skill absent)", async () => {
    // Regression guard: without skills declared, the argument list must be identical
    // to what the code produced before the skills feature was added.
    const { child } = makeStreamJsonChild("answer");
    let capturedArgs: string[] = [];
    const spawn = ((_cmd: string, args: string[]) => {
      capturedArgs = args;
      return child;
    }) as unknown as SpawnFn;

    await runLlmStep(entry, "hello", { spawn });

    assert.ok(!capturedArgs.includes("--plugin-dir"), "must not add --plugin-dir without skills");
    assert.ok(
      !capturedArgs.some((a) => a.includes("Skill")),
      "Skill must not appear in args without skills"
    );
    // Hardening is unconditional: --restricted and --strict-mcp-config must be
    // present even when no skills or permissions are declared.
    assert.ok(
      capturedArgs.includes("--restricted"),
      "must add --restricted even without skills or permissions"
    );
  });

  it("step with skills adds Skill to --tools and --allowedTools and --plugin-dir, no Bash", async () => {
    const { child } = makeStreamJsonChild("ok");
    let capturedArgs: string[] = [];
    const spawn = ((_cmd: string, args: string[]) => {
      capturedArgs = args;
      return child;
    }) as unknown as SpawnFn;

    await runLlmStep(entry, "use git", {
      spawn,
      skills: ["git", "chrome-test"],
      env: { HOME: "/home/user" },
    });

    assert.ok(capturedArgs.includes("--restricted"), "must add --restricted for skills");
    assert.ok(
      capturedArgs.includes("--strict-mcp-config"),
      "must add --strict-mcp-config for skills"
    );
    assert.ok(capturedArgs.includes("--plugin-dir"), "must add --plugin-dir");
    const toolsIdx = capturedArgs.indexOf("--tools");
    const allowedIdx = capturedArgs.indexOf("--allowedTools");
    assert.ok(toolsIdx !== -1, "must include --tools");
    assert.ok(allowedIdx !== -1, "must include --allowedTools");
    assert.equal(capturedArgs[toolsIdx + 1], "Skill", "--tools must be Skill when no permissions");
    assert.equal(
      capturedArgs[allowedIdx + 1],
      "Skill",
      "--allowedTools must be Skill when no permissions"
    );
    const pluginDirIdx = capturedArgs.indexOf("--plugin-dir");
    assert.equal(
      capturedArgs[pluginDirIdx + 1],
      "/home/user/.claude",
      "--plugin-dir must be $HOME/.claude"
    );
    assert.ok(!capturedArgs.includes("Bash"), "Bash must never be granted");
  });

  it("step with skills and permissions: read appends Skill to Read,Glob,Grep", async () => {
    const { child } = makeStreamJsonChild("ok");
    let capturedArgs: string[] = [];
    const spawn = ((_cmd: string, args: string[]) => {
      capturedArgs = args;
      return child;
    }) as unknown as SpawnFn;

    await runLlmStep(entry, "read and use skill", {
      spawn,
      contentsAccess: "read",
      workspaceDir: repoRoot,
      skills: ["git"],
      env: { HOME: "/home/user" },
    });

    const toolsIdx = capturedArgs.indexOf("--tools");
    const allowedIdx = capturedArgs.indexOf("--allowedTools");
    assert.equal(
      capturedArgs[toolsIdx + 1],
      "Read,Glob,Grep,Skill",
      "--tools must be Read,Glob,Grep,Skill"
    );
    assert.equal(
      capturedArgs[allowedIdx + 1],
      "Read,Glob,Grep,Skill",
      "--allowedTools must be Read,Glob,Grep,Skill"
    );
    assert.ok(!capturedArgs.includes("Bash"), "Bash must never be granted");
  });

  it("step with skills and permissions: write appends Skill to Read,Glob,Grep,Edit,Write", async () => {
    const { child } = makeStreamJsonChild("ok");
    let capturedArgs: string[] = [];
    const spawn = ((_cmd: string, args: string[]) => {
      capturedArgs = args;
      return child;
    }) as unknown as SpawnFn;

    await runLlmStep(entry, "write and use skill", {
      spawn,
      contentsAccess: "write",
      workspaceDir: repoRoot,
      skills: ["git"],
      env: { HOME: "/home/user" },
    });

    const toolsIdx = capturedArgs.indexOf("--tools");
    const allowedIdx = capturedArgs.indexOf("--allowedTools");
    assert.equal(
      capturedArgs[toolsIdx + 1],
      "Read,Glob,Grep,Edit,Write,Skill",
      "--tools must be Read,Glob,Grep,Edit,Write,Skill"
    );
    assert.equal(
      capturedArgs[allowedIdx + 1],
      "Read,Glob,Grep,Edit,Write,Skill",
      "--allowedTools must be Read,Glob,Grep,Edit,Write,Skill"
    );
    assert.ok(!capturedArgs.includes("Bash"), "Bash must never be granted");
  });

  it("skills dir resolved from AGENT_FLOWS_SKILLS_DIR env var when set", async () => {
    const { child } = makeStreamJsonChild("ok");
    let capturedArgs: string[] = [];
    const spawn = ((_cmd: string, args: string[]) => {
      capturedArgs = args;
      return child;
    }) as unknown as SpawnFn;

    await runLlmStep(entry, "use skill", {
      spawn,
      skills: ["git"],
      env: { HOME: "/home/user", AGENT_FLOWS_SKILLS_DIR: "/opt/project/.claude" },
    });

    const pluginDirIdx = capturedArgs.indexOf("--plugin-dir");
    assert.ok(pluginDirIdx !== -1, "must include --plugin-dir");
    assert.equal(
      capturedArgs[pluginDirIdx + 1],
      "/opt/project/.claude",
      "AGENT_FLOWS_SKILLS_DIR must override default"
    );
  });
});

// ── credential deny list ──────────────────────────────────────────────────────

describe("runLlmStep — credential deny list", () => {
  const entry: ModelEntry = {
    id: "haiku",
    transport: "cli",
    cli: { bin: "claude", model: "haiku" },
  };

  it("read mode: --disallowedTools is present and covers Read and Edit for every deny pattern", async () => {
    // Edit rules cover all file-editing tools including Write; Write(pattern) is not
    // a valid file permission deny rule. Write must not appear in --disallowedTools.
    const { child } = makeStreamJsonChild("ok");
    let capturedArgs: string[] = [];
    const spawn = ((_cmd: string, args: string[]) => {
      capturedArgs = args;
      return child;
    }) as unknown as SpawnFn;

    await runLlmStep(entry, "analyze", {
      spawn,
      contentsAccess: "read",
      workspaceDir: repoRoot,
    });

    const disallowedIdx = capturedArgs.indexOf("--disallowedTools");
    assert.ok(disallowedIdx !== -1, "read mode must emit --disallowedTools");
    const disallowedValue = capturedArgs[disallowedIdx + 1];
    assert.ok(typeof disallowedValue === "string", "--disallowedTools must have a value");

    for (const pattern of CREDENTIAL_DENY_PATTERNS) {
      assert.ok(
        disallowedValue.includes(`Read(${pattern})`),
        `--disallowedTools must deny Read for pattern ${pattern}`
      );
      assert.ok(
        disallowedValue.includes(`Edit(${pattern})`),
        `--disallowedTools must deny Edit for pattern ${pattern}`
      );
    }
    assert.ok(
      !disallowedValue.includes("Write("),
      "--disallowedTools must not include Write() — Edit covers all file-editing tools"
    );
  });

  it("no-workspace step: --disallowedTools covers Read AND Grep for every credential pattern", async () => {
    // The no-workspace branch has its own deny-entry construction, and every
    // other test in this file declares contentsAccess + workspaceDir — so this
    // branch was unguarded: widening the no-permissions fallback to include Grep
    // would have leaked credential file contents with no test turning red.
    // A step that declares nothing still receives the hardened Read,Glob grant.
    const { child } = makeStreamJsonChild("ok");
    let capturedArgs: string[] = [];
    const spawn = ((_cmd: string, args: string[]) => {
      capturedArgs = args;
      return child;
    }) as unknown as SpawnFn;

    // env without HOME: operatorDenyRules() finds no user settings file, so this
    // asserts on agent-flows' own deny construction rather than on whatever
    // permissions.deny the machine running the suite happens to have configured.
    await runLlmStep(entry, "analyze", { spawn, env: {} });

    const disallowedIdx = capturedArgs.indexOf("--disallowedTools");
    assert.ok(disallowedIdx !== -1, "a step with no workspace must still emit --disallowedTools");
    const disallowedValue = capturedArgs[disallowedIdx + 1];
    assert.ok(typeof disallowedValue === "string", "--disallowedTools must have a value");

    for (const pattern of CREDENTIAL_DENY_PATTERNS) {
      assert.ok(
        disallowedValue.includes(`Read(${pattern})`),
        `no-workspace deny must include Read(${pattern}); got: ${disallowedValue.slice(0, 200)}`
      );
      assert.ok(
        disallowedValue.includes(`Grep(${pattern})`),
        `no-workspace deny must include Grep(${pattern}); got: ${disallowedValue.slice(0, 200)}`
      );
    }
    assert.ok(
      !disallowedValue.includes("Edit("),
      "no workspace means no Edit grant, so Edit denials are not emitted"
    );
  });

  it("write mode: --disallowedTools is present and covers Read and Edit for every deny pattern", async () => {
    const { child } = makeStreamJsonChild("ok");
    let capturedArgs: string[] = [];
    const spawn = ((_cmd: string, args: string[]) => {
      capturedArgs = args;
      return child;
    }) as unknown as SpawnFn;

    await runLlmStep(entry, "edit file", {
      spawn,
      contentsAccess: "write",
      workspaceDir: repoRoot,
    });

    const disallowedIdx = capturedArgs.indexOf("--disallowedTools");
    assert.ok(disallowedIdx !== -1, "write mode must emit --disallowedTools");
    const disallowedValue = capturedArgs[disallowedIdx + 1];
    assert.ok(typeof disallowedValue === "string", "--disallowedTools must have a value");

    for (const pattern of CREDENTIAL_DENY_PATTERNS) {
      assert.ok(
        disallowedValue.includes(`Read(${pattern})`),
        `--disallowedTools must deny Read for pattern ${pattern}`
      );
      assert.ok(
        disallowedValue.includes(`Edit(${pattern})`),
        `--disallowedTools must deny Edit for pattern ${pattern}`
      );
    }
    assert.ok(
      !disallowedValue.includes("Write("),
      "--disallowedTools must not include Write() — Edit covers all file-editing tools"
    );
  });

  it("--disallowedTools does not contain Glob()", async () => {
    // Glob is not in the deny list. Note: empirically, Read(pattern) in --disallowedTools
    // also suppresses Glob listing for that path — granular "deny Read but allow Glob"
    // is not achievable with the current CLI mechanism.
    const { child } = makeStreamJsonChild("ok");
    let capturedArgs: string[] = [];
    const spawn = ((_cmd: string, args: string[]) => {
      capturedArgs = args;
      return child;
    }) as unknown as SpawnFn;

    await runLlmStep(entry, "analyze", {
      spawn,
      contentsAccess: "read",
      workspaceDir: repoRoot,
    });

    const disallowedIdx = capturedArgs.indexOf("--disallowedTools");
    assert.ok(disallowedIdx !== -1, "must emit --disallowedTools");
    const disallowedValue = capturedArgs[disallowedIdx + 1];
    assert.ok(!disallowedValue.includes("Glob("), "--disallowedTools must not contain Glob()");
  });

  it("write mode: --disallowedTools denies Edit for every build-config pattern", async () => {
    // A write step must not be able to edit package.json, Makefile, CI workflows,
    // etc. — editing these would let an injected prompt rewrite the test script
    // or pipeline and have it executed inside the same run (the build-round loop
    // is the concrete threat model). Read must stay allowed.
    const { child } = makeStreamJsonChild("ok");
    let capturedArgs: string[] = [];
    const spawn = ((_cmd: string, args: string[]) => {
      capturedArgs = args;
      return child;
    }) as unknown as SpawnFn;

    await runLlmStep(entry, "edit file", {
      spawn,
      contentsAccess: "write",
      workspaceDir: repoRoot,
    });

    const disallowedIdx = capturedArgs.indexOf("--disallowedTools");
    assert.ok(disallowedIdx !== -1, "write mode must emit --disallowedTools");
    const disallowedValue = capturedArgs[disallowedIdx + 1];

    for (const pattern of BUILD_CONFIG_DENY_PATTERNS) {
      assert.ok(
        disallowedValue.includes(`Edit(${pattern})`),
        `--disallowedTools must deny Edit for build-config pattern ${pattern}`
      );
      assert.ok(
        !disallowedValue.includes(`Read(${pattern})`),
        `--disallowedTools must NOT deny Read for build-config pattern ${pattern} — steps must still be able to read these files`
      );
    }
  });

  it("read mode: --disallowedTools denies Edit for every build-config pattern (defence in depth)", async () => {
    const { child } = makeStreamJsonChild("ok");
    let capturedArgs: string[] = [];
    const spawn = ((_cmd: string, args: string[]) => {
      capturedArgs = args;
      return child;
    }) as unknown as SpawnFn;

    await runLlmStep(entry, "analyze", {
      spawn,
      contentsAccess: "read",
      workspaceDir: repoRoot,
    });

    const disallowedIdx = capturedArgs.indexOf("--disallowedTools");
    assert.ok(disallowedIdx !== -1, "read mode must emit --disallowedTools");
    const disallowedValue = capturedArgs[disallowedIdx + 1];

    for (const pattern of BUILD_CONFIG_DENY_PATTERNS) {
      assert.ok(
        disallowedValue.includes(`Edit(${pattern})`),
        `--disallowedTools must deny Edit for build-config pattern ${pattern}`
      );
      assert.ok(
        !disallowedValue.includes(`Read(${pattern})`),
        `--disallowedTools must NOT deny Read for build-config pattern ${pattern}`
      );
    }
  });

  it("write mode: --disallowedTools denies Edit for **/.agent-flows/** and does NOT deny Read for it", async () => {
    // FR-006: .agent-flows/** is in BUILD_CONFIG_DENY_PATTERNS. A write step
    // must not be able to edit config.json mid-run (closing the gate-rewrite attack).
    // Read must stay allowed: steps may legitimately inspect project config.
    const { child } = makeStreamJsonChild("ok");
    let capturedArgs: string[] = [];
    const spawn = ((_cmd: string, args: string[]) => {
      capturedArgs = args;
      return child;
    }) as unknown as SpawnFn;

    await runLlmStep(entry, "edit files", {
      spawn,
      contentsAccess: "write",
      workspaceDir: repoRoot,
    });

    const disallowedIdx = capturedArgs.indexOf("--disallowedTools");
    assert.ok(disallowedIdx !== -1, "write mode must emit --disallowedTools");
    const disallowedValue = capturedArgs[disallowedIdx + 1] ?? "";

    const agentFlowsPattern = "**/.agent-flows/**";
    assert.ok(
      disallowedValue.includes(`Edit(${agentFlowsPattern})`),
      `--disallowedTools must deny Edit for ${agentFlowsPattern}`
    );
    assert.ok(
      !disallowedValue.includes(`Read(${agentFlowsPattern})`),
      `--disallowedTools must NOT deny Read for ${agentFlowsPattern} — steps must be able to inspect project config`
    );
  });

  it("BUILD_CONFIG_DENY_PATTERNS contains both .agent-flows and .Agent-flows spellings in Edit, neither in Read", async () => {
    // macOS APFS is case-insensitive: .Agent-flows/config.json resolves to the
    // same file as .agent-flows/config.json. Both spellings must be in the Edit
    // deny list so a case-varied path cannot bypass the pattern match.
    const lower = "**/.agent-flows/**";
    const upper = "**/.Agent-flows/**";

    assert.ok(
      BUILD_CONFIG_DENY_PATTERNS.includes(lower),
      `BUILD_CONFIG_DENY_PATTERNS must contain ${lower}`
    );
    assert.ok(
      BUILD_CONFIG_DENY_PATTERNS.includes(upper),
      `BUILD_CONFIG_DENY_PATTERNS must contain ${upper}`
    );

    // Read must NOT be denied for either spelling.
    const { child } = makeStreamJsonChild("ok");
    let capturedArgs: string[] = [];
    const spawn = ((_cmd: string, args: string[]) => {
      capturedArgs = args;
      return child;
    }) as unknown as SpawnFn;

    await runLlmStep(entry, "edit files", {
      spawn,
      contentsAccess: "write",
      workspaceDir: repoRoot,
    });

    const disallowedIdx = capturedArgs.indexOf("--disallowedTools");
    const disallowedValue = capturedArgs[disallowedIdx + 1] ?? "";

    assert.ok(
      disallowedValue.includes(`Edit(${lower})`),
      `Edit deny must include lowercase spelling ${lower}`
    );
    assert.ok(
      disallowedValue.includes(`Edit(${upper})`),
      `Edit deny must include uppercase spelling ${upper}`
    );
    assert.ok(
      !disallowedValue.includes(`Read(${lower})`),
      `Read deny must NOT include lowercase spelling ${lower}`
    );
    assert.ok(
      !disallowedValue.includes(`Read(${upper})`),
      `Read deny must NOT include uppercase spelling ${upper}`
    );
  });

  it("step with no permissions emits --disallowedTools with credential Read-only denials", async () => {
    // A step without contentsAccess still gets --tools Read,Glob (the safe hardened
    // fallback). Without credential Read denials it could read .env, *.pem, id_rsa
    // from the daemon's working directory. The deny list is now emitted unconditionally
    // for the Read tool, and deliberately excludes Edit denials (no workspace declared).
    const { child } = makeStreamJsonChild("answer");
    let capturedArgs: string[] = [];
    const spawn = ((_cmd: string, args: string[]) => {
      capturedArgs = args;
      return child;
    }) as unknown as SpawnFn;

    // env without HOME so the operator's own settings deny rules (which may contain
    // Edit(...) entries) cannot influence the Edit-absence assertion below.
    await runLlmStep(entry, "hello", { spawn, env: {} });

    assert.ok(
      capturedArgs.includes("--disallowedTools"),
      "no-permissions step must emit --disallowedTools with credential Read denials"
    );
    const disallowedIdx = capturedArgs.indexOf("--disallowedTools");
    const disallowedValue = capturedArgs[disallowedIdx + 1] ?? "";
    // Credential Read denials must be present.
    assert.ok(
      disallowedValue.includes("Read(**/.env)"),
      "must deny Read(**/.env) for no-permissions step"
    );
    // Edit denials must NOT be present — no workspace was declared.
    assert.ok(
      !disallowedValue.includes("Edit("),
      "must not include Edit() denials when no workspace is declared"
    );
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

// ── runCheckStep — step log events (spec 036 FR-004/FR-015) ──────────────────

describe("runCheckStep — output events", () => {
  /** Concatenated text of one stream: a pipe may deliver two writes as one chunk. */
  function streamText(events: StepLogEventInput[], stream: "stdout" | "stderr"): string {
    return events
      .flatMap((e) => (e.kind === "check.output" && e.stream === stream ? [e.text] : []))
      .join("");
  }

  it("emits check.output for stdout and stderr chunks", async () => {
    const events: StepLogEventInput[] = [];
    await runCheckStep("printf out; printf err >&2", {
      onEvent: (event) => events.push(event),
    });

    assert.ok(events.length > 0, "a command that prints must produce events");
    assert.ok(
      events.every((e) => e.kind === "check.output"),
      "runCheckStep emits no other kind — the builder owns step.start and step.result"
    );
    assert.equal(streamText(events, "stdout"), "out");
    assert.equal(streamText(events, "stderr"), "err");
  });

  it("scrubs the value of a declared env variable out of the event and the result", async () => {
    const events: StepLogEventInput[] = [];
    const result = await runCheckStep('printf "secret is $PROBE_SECRET_VALUE"', {
      env: { PATH: process.env.PATH, PROBE_SECRET_VALUE: "hunter2xyz" },
      envAllowlist: ["PROBE_SECRET_VALUE"],
      onEvent: (event) => events.push(event),
    });

    assert.equal(streamText(events, "stdout"), "secret is [redacted:PROBE_SECRET_VALUE]");
    // CheckResult.output becomes the step's ctx value and the artifact's
    // outputExcerpt, so it must carry the placeholder, never the credential.
    assert.ok(
      result.output.includes("[redacted:PROBE_SECRET_VALUE]"),
      `the retained output must be scrubbed; got: ${result.output}`
    );
    assert.equal(
      result.output.includes("hunter2xyz"),
      false,
      "the retained output must never hold the credential value"
    );
  });

  it("scrubs a declared value split across two reads", async () => {
    const events: StepLogEventInput[] = [];
    // Two writes a sleep apart, so the value cannot arrive in one chunk: the
    // scrubber only catches it by carrying the tail of the first read over.
    const result = await runCheckStep("printf hunter2; sleep 0.05; printf xyz", {
      env: { PATH: process.env.PATH, PROBE_SECRET_VALUE: "hunter2xyz" },
      envAllowlist: ["PROBE_SECRET_VALUE"],
      onEvent: (event) => events.push(event),
    });

    assert.equal(streamText(events, "stdout"), "[redacted:PROBE_SECRET_VALUE]");
    assert.equal(
      events.some((e) => e.kind === "check.output" && e.text.includes("hunter2")),
      false,
      "no event may carry a half of the credential either"
    );
    assert.equal(
      result.output.includes("hunter2"),
      false,
      "the retained output must never hold the credential value"
    );
  });

  it("leaves output alone when the step declares no variables", async () => {
    const events: StepLogEventInput[] = [];
    await runCheckStep("printf plain", { onEvent: (event) => events.push(event) });
    assert.equal(streamText(events, "stdout"), "plain");
  });
});

// ── runCheckStep — environment allowlist ──────────────────────────────────────

describe("runCheckStep — environment allowlist", () => {
  // This MUST FAIL before the allowlist fix: scrubEnv() only removes SCRUBBED_KEYS,
  // so GH_TOKEN passes through untouched. After the fix, only CHECK_ENV_ALLOWLIST
  // vars (PATH, HOME, SHELL, TMPDIR, LANG, etc.) reach the child by default.
  it("strips env vars not in the base allowlist from the child environment", async () => {
    let capturedEnv: NodeJS.ProcessEnv | undefined;
    const spawn = ((_cmd: string, _args: string[], opts: { env?: NodeJS.ProcessEnv }) => {
      capturedEnv = opts.env;
      const { child } = makeFakeChild({ exitCode: 0 });
      return child;
    }) as unknown as SpawnFn;

    await runCheckStep("echo hi", {
      spawn,
      env: {
        PATH: "/usr/bin",
        HOME: "/home/user",
        TMPDIR: "/tmp",
        SHELL: "/bin/sh",
        LANG: "en_US.UTF-8",
        GH_TOKEN: "ghp_secret",
        LITELLM_MASTER_KEY: "sk-master",
        DATABASE_URL: "postgres://localhost/db",
      },
    });

    assert.ok(capturedEnv !== undefined, "spawn must have been called");
    assert.equal(capturedEnv.PATH, "/usr/bin", "PATH must be preserved (it is in the allowlist)");
    assert.equal(capturedEnv.HOME, "/home/user", "HOME must be preserved (it is in the allowlist)");
    assert.equal(
      capturedEnv.GH_TOKEN,
      undefined,
      "GH_TOKEN must be stripped — not in base allowlist and not declared in envAllowlist"
    );
    assert.equal(
      capturedEnv.LITELLM_MASTER_KEY,
      undefined,
      "LITELLM_MASTER_KEY must be stripped — not in base allowlist"
    );
    assert.equal(
      capturedEnv.DATABASE_URL,
      undefined,
      "DATABASE_URL must be stripped — not in base allowlist"
    );
  });

  it("passes declared envAllowlist vars to the child alongside base allowlist vars", async () => {
    let capturedEnv: NodeJS.ProcessEnv | undefined;
    const spawn = ((_cmd: string, _args: string[], opts: { env?: NodeJS.ProcessEnv }) => {
      capturedEnv = opts.env;
      const { child } = makeFakeChild({ exitCode: 0 });
      return child;
    }) as unknown as SpawnFn;

    await runCheckStep("echo hi", {
      spawn,
      env: {
        PATH: "/usr/bin",
        HOME: "/home/user",
        GH_TOKEN: "ghp_secret",
        OTHER_SECRET: "must-not-appear",
      },
      envAllowlist: ["GH_TOKEN"],
    });

    assert.ok(capturedEnv !== undefined, "spawn must have been called");
    assert.equal(capturedEnv.GH_TOKEN, "ghp_secret", "GH_TOKEN must be present when declared");
    assert.equal(
      capturedEnv.OTHER_SECRET,
      undefined,
      "OTHER_SECRET must be absent — not declared in envAllowlist"
    );
  });
});

// ── per-step deny patterns ────────────────────────────────────────────────────

describe("runLlmStep — per-step deny patterns", () => {
  const entry: ModelEntry = {
    id: "haiku",
    transport: "cli",
    cli: { bin: "claude", model: "haiku" },
  };

  // Captures the --disallowedTools value emitted for a read-mode step.
  async function captureDisallowed(extraDeps: Partial<StepRunnerDeps>): Promise<string> {
    const { child } = makeStreamJsonChild("ok");
    let disallowed = "";
    const spawn = ((_cmd: string, args: string[]) => {
      const idx = args.indexOf("--disallowedTools");
      if (idx !== -1) disallowed = args[idx + 1];
      return child;
    }) as unknown as SpawnFn;
    await runLlmStep(entry, "test", {
      spawn,
      contentsAccess: "read",
      workspaceDir: repoRoot,
      // An empty env keeps operatorDenyRules() out of the capture. Without it the
      // machine's own ~/.claude/settings.json contributes entries, and an operator
      // who denies `Read(**/*.pem)` makes the narrowing-only assertions below pass
      // no matter what the flag builder does.
      env: {},
      ...extraDeps,
    });
    return disallowed;
  }

  it("no step deny: emits exactly the default deny list (regression guard)", async () => {
    const disallowed = await captureDisallowed({});
    for (const pat of CREDENTIAL_DENY_PATTERNS) {
      assert.ok(
        disallowed.includes(`Read(${pat})`),
        `default deny must include Read(${pat}); got: ${disallowed.slice(0, 200)}`
      );
    }
    for (const pat of BUILD_CONFIG_DENY_PATTERNS) {
      assert.ok(
        disallowed.includes(`Edit(${pat})`),
        `default deny must include Edit(${pat}); got: ${disallowed.slice(0, 200)}`
      );
    }
  });

  // Grep is granted to read steps, so a Read-only deny list leaks: content search
  // returns matching lines from inside a file the step may not open. Every deny
  // pattern must therefore be emitted as a Grep entry too.
  it("read step denies Grep for every credential pattern, not just Read", async () => {
    const disallowed = await captureDisallowed({});
    for (const pat of CREDENTIAL_DENY_PATTERNS) {
      assert.ok(
        disallowed.includes(`Grep(${pat})`),
        `default deny must include Grep(${pat}); got: ${disallowed.slice(0, 200)}`
      );
    }
  });

  it("denyPatterns adds a step-only entry as both Read and Edit denial", async () => {
    const stepDenyPattern = "src/internal/**";
    const disallowed = await captureDisallowed({ denyPatterns: [stepDenyPattern] });

    // Step-only pattern appears for both Read and Edit.
    assert.ok(
      disallowed.includes(`Read(${stepDenyPattern})`),
      "step deny must appear as Read denial"
    );
    assert.ok(
      disallowed.includes(`Edit(${stepDenyPattern})`),
      "step deny must appear as Edit denial"
    );

    // Project defaults must still be present.
    assert.ok(disallowed.includes("Read(**/.env)"), "default Read(**/.env) must remain");
  });

  // D5/FR-009: deny is narrowing-only. Whatever a step declares, every project
  // default must still be emitted — there is no subtraction path left.
  it("a step deny naming a project default leaves the whole default list intact", async () => {
    const disallowed = await captureDisallowed({
      denyPatterns: ["**/*.pem", "**/package.json"],
    });

    for (const pat of CREDENTIAL_DENY_PATTERNS) {
      assert.ok(
        disallowed.includes(`Read(${pat})`),
        `Read(${pat}) must remain regardless of what the step declares`
      );
    }
    for (const pat of BUILD_CONFIG_DENY_PATTERNS) {
      assert.ok(
        disallowed.includes(`Edit(${pat})`),
        `Edit(${pat}) must remain regardless of what the step declares`
      );
    }
  });

  it("step deny cannot widen contentsAccess: a read step still gets only Read,Glob,Grep", async () => {
    const { child } = makeStreamJsonChild("ok");
    let capturedArgs: string[] = [];
    const spawn = ((_cmd: string, args: string[]) => {
      capturedArgs = args;
      return child;
    }) as unknown as SpawnFn;

    await runLlmStep(entry, "test", {
      spawn,
      contentsAccess: "read",
      workspaceDir: repoRoot,
      denyPatterns: ["**/*.pem"],
    });

    const toolsIdx = capturedArgs.indexOf("--tools");
    assert.equal(
      capturedArgs[toolsIdx + 1],
      "Read,Glob,Grep",
      "a step deny must not change --tools"
    );
    const allowedIdx = capturedArgs.indexOf("--allowedTools");
    assert.equal(
      capturedArgs[allowedIdx + 1],
      "Read,Glob,Grep",
      "a step deny must not change --allowedTools"
    );
  });
});

// ── Fix 2: pipeline definitions are Edit-denied ───────────────────────────────
//
// A contents: write step that can edit a pipeline can rewrite what a later run is
// permitted to do — its permissions, its model, its deny entries. Edit-only by
// design: steps must still be able to read pipeline definitions to reason about
// the system.
describe("runLlmStep — pipeline definitions are edit-denied", () => {
  const entry: ModelEntry = {
    id: "haiku",
    transport: "cli",
    cli: { bin: "claude", model: "haiku" },
  };

  it("write step denies Edit for **/pipelines/** and does NOT deny Read for it", async () => {
    const { child } = makeStreamJsonChild("ok");
    let capturedArgs: string[] = [];
    const spawn = ((_cmd: string, args: string[]) => {
      capturedArgs = args;
      return child;
    }) as unknown as SpawnFn;

    await runLlmStep(entry, "edit", {
      spawn,
      contentsAccess: "write",
      workspaceDir: repoRoot,
      env: {},
    });

    const disallowedIdx = capturedArgs.indexOf("--disallowedTools");
    const disallowed = capturedArgs[disallowedIdx + 1] ?? "";

    assert.ok(
      disallowed.includes("Edit(**/pipelines/**)"),
      "a write step must not be able to edit pipeline definitions"
    );
    assert.ok(
      disallowed.includes("Edit(**/Pipelines/**)"),
      "the case-varied spelling must be denied too (case-insensitive filesystems)"
    );
    assert.ok(
      !disallowed.includes("Read(**/pipelines/**)"),
      "Read must stay allowed — pipeline definitions are readable by design"
    );
  });
});

// ── Fix 3 regression: credential denials must reach no-permissions steps ────────
//
// Before the fix, CREDENTIAL_DENY_PATTERNS are only emitted inside the
// `if (resolvedWorkspaceDir !== undefined)` guard. A step with no permissions
// still gets --tools Read,Glob (the --tools "" empirical workaround), so it
// CAN read .env, *.pem, id_rsa with no deny list at all.
// After the fix, credential Read denials are emitted whenever Read is in the
// effective tool set — i.e., always for claude CLI steps.
//
// This test MUST FAIL before the runStep.ts no-workspace credential-deny fix.
describe("runLlmStep — credential Read denials emitted for no-permissions steps", () => {
  it("no-permissions step includes credential Read denials in --disallowedTools", async () => {
    const entry: ModelEntry = {
      id: "haiku",
      transport: "cli",
      cli: { bin: "claude", model: "haiku" },
    };
    const { child } = makeStreamJsonChild("answer");
    let capturedArgs: string[] = [];
    const spawn = ((_cmd: string, args: string[]) => {
      capturedArgs = args;
      return child;
    }) as unknown as SpawnFn;

    // env without HOME: the operator's own settings deny rules are appended to the
    // same list and would otherwise decide the Edit-absence assertions below.
    await runLlmStep(entry, "hello", { spawn, env: {} }); // no contentsAccess

    const disallowedIdx = capturedArgs.indexOf("--disallowedTools");
    assert.ok(
      disallowedIdx !== -1,
      "--disallowedTools must be present for a no-permissions step — " +
        "fails before fix because the deny list is only built inside the resolvedWorkspaceDir guard"
    );
    const disallowedValue = capturedArgs[disallowedIdx + 1];
    assert.ok(typeof disallowedValue === "string", "--disallowedTools must have a value");

    for (const pat of CREDENTIAL_DENY_PATTERNS) {
      assert.ok(
        disallowedValue.includes(`Read(${pat})`),
        `--disallowedTools must deny Read for credential pattern ${pat}`
      );
    }

    // Edit denials must NOT be present — no workspace access was declared.
    for (const pat of CREDENTIAL_DENY_PATTERNS) {
      assert.ok(
        !disallowedValue.includes(`Edit(${pat})`),
        `--disallowedTools must NOT include Edit(${pat}) for a no-permissions step (no workspace)`
      );
    }
    // Build-config Edit denials must NOT be present either.
    for (const pat of BUILD_CONFIG_DENY_PATTERNS) {
      assert.ok(
        !disallowedValue.includes(`Edit(${pat})`),
        `--disallowedTools must NOT include Edit build-config for a no-permissions step`
      );
    }
  });
});

// ── Deny-list content snapshot ────────────────────────────────────────────────
//
// These snapshot tests assert the EXACT membership of the deny-list constants.
// The loop tests above cover plumbing (that every element in the constant reaches
// the argv), but a loop that iterates over the constant itself cannot detect a
// missing entry — shrinking the constant just shrinks the loop.
//
// The duplication below IS the guard: do not replace the inline arrays with
// references to the constants.

describe("deny-list content snapshot", () => {
  it("CREDENTIAL_DENY_PATTERNS exactly equals the 92-entry snapshot", () => {
    const expected: readonly string[] = [
      // Environment files (13)
      "**/.env",
      "**/.env.ci",
      "**/.env.docker",
      "**/.env.production",
      "**/.env.prod",
      "**/.env.staging",
      "**/.env.stage",
      "**/.env.preview",
      "**/.env.local",
      "**/.env.development",
      "**/.env.dev",
      "**/.env.test",
      "**/.envrc",
      // Named credential, secret and token files (28)
      "**/aws.json",
      "**/credentials",
      "**/credentials.production",
      "**/credentials.staging",
      "**/credentials.json",
      "**/credentials.toml",
      "**/credentials.yaml",
      "**/credentials.yml",
      "**/credentials.ini",
      "**/secrets.json",
      "**/secrets.yaml",
      "**/secrets.yml",
      "**/secrets.toml",
      "**/secrets.ini",
      "**/secret.json",
      "**/secret.yaml",
      "**/token.json",
      "**/token.yaml",
      "**/token.yml",
      "**/tokens.json",
      "**/service-account*.json",
      "**/terraform.tfvars",
      "**/terraform.tfvars.json",
      "**/secrets.tfvars",
      "**/*.auto.tfvars",
      "**/*.auto.tfvars.json",
      "**/*.tfstate",
      "**/*.tfstate.backup",
      // Tool auth files (6)
      "**/.npmrc",
      "**/.netrc",
      "**/_netrc",
      "**/.pgpass",
      "**/.htpasswd",
      "**/htpasswd",
      // Cloud provider and cluster credentials (6)
      "**/.aws/**",
      "**/.azure/**",
      "**/.config/gcloud/**",
      "**/application_default_credentials.json",
      "**/.kube/config",
      "**/kubeconfig",
      // Key material by extension (15)
      "**/*.key",
      "**/*.pem",
      "**/*.der",
      "**/*.crt",
      "**/*.cer",
      "**/*.p8",
      "**/*.p12",
      "**/*.pfx",
      "**/*.jks",
      "**/*.keystore",
      "**/*.truststore",
      "**/*.ppk",
      "**/*.gpg",
      "**/*.asc",
      "**/*.pgp",
      // Key material by location (2)
      "**/.ssh/**",
      "**/.gnupg/**",
      // SSH private keys without extension (4)
      "**/id_rsa*",
      "**/id_ed25519*",
      "**/id_ecdsa*",
      "**/id_dsa*",
      // Case-varied duplicates (18)
      "**/*.KEY",
      "**/*.PEM",
      "**/*.DER",
      "**/*.CRT",
      "**/*.CER",
      "**/*.P8",
      "**/*.P12",
      "**/*.PFX",
      "**/*.JKS",
      "**/*.PPK",
      "**/*.GPG",
      "**/*.ASC",
      "**/*.PGP",
      "**/.Ssh/**",
      "**/.Gnupg/**",
      "**/.Aws/**",
      "**/.Azure/**",
      "**/.Kube/config",
    ];
    assert.deepEqual(
      [...CREDENTIAL_DENY_PATTERNS],
      expected,
      "CREDENTIAL_DENY_PATTERNS membership changed — update both the constant and this snapshot"
    );
  });

  it("BUILD_CONFIG_DENY_PATTERNS exactly equals the 10-entry snapshot", () => {
    const expected: readonly string[] = [
      "**/package.json",
      "**/Makefile",
      "**/.github/workflows/**",
      "**/.git/**",
      "**/.husky/**",
      "**/*.config.*",
      "**/.agent-flows/**",
      "**/.Agent-flows/**",
      "**/pipelines/**",
      "**/Pipelines/**",
    ];
    assert.deepEqual(
      [...BUILD_CONFIG_DENY_PATTERNS],
      expected,
      "BUILD_CONFIG_DENY_PATTERNS membership changed — update both the constant and this snapshot"
    );
  });

  it("write-mode argv entry count equals CREDENTIAL_DENY_PATTERNS.length * 3 + BUILD_CONFIG_DENY_PATTERNS.length", async () => {
    // Each credential pattern contributes Read(pat) + Grep(pat) + Edit(pat) = 3 entries.
    // Each build-config pattern contributes Edit(pat) = 1 entry.
    // Total expected with empty allow/deny overrides: 92*3 + 10 = 286.
    const entry: ModelEntry = {
      id: "haiku",
      transport: "cli",
      cli: { bin: "claude", model: "haiku" },
    };
    const { child } = makeStreamJsonChild("ok");
    let capturedArgs: string[] = [];
    const spawn = ((_cmd: string, args: string[]) => {
      capturedArgs = args;
      return child;
    }) as unknown as SpawnFn;

    // env without HOME: operator deny rules are appended to the same list and would
    // otherwise make this count depend on the machine's user settings.
    await runLlmStep(entry, "edit file", {
      spawn,
      contentsAccess: "write",
      workspaceDir: repoRoot,
      env: {},
    });

    const disallowedIdx = capturedArgs.indexOf("--disallowedTools");
    assert.ok(disallowedIdx !== -1, "write mode must emit --disallowedTools");
    const disallowedValue = capturedArgs[disallowedIdx + 1];
    assert.ok(typeof disallowedValue === "string", "--disallowedTools must have a value");

    const entryCount = disallowedValue.split(",").length;
    const expectedCount = CREDENTIAL_DENY_PATTERNS.length * 3 + BUILD_CONFIG_DENY_PATTERNS.length;
    assert.equal(
      entryCount,
      expectedCount,
      `--disallowedTools entry count must be ${expectedCount} (${CREDENTIAL_DENY_PATTERNS.length} credential patterns × 3 + ${BUILD_CONFIG_DENY_PATTERNS.length} build-config patterns × 1); got ${entryCount}`
    );
  });
});

// ── Credential deny-list coverage ─────────────────────────────────────────────
//
// The snapshot test above pins membership; this one pins REACH. It names a
// representative path for every form of secret the owner's rule covers ("no
// agent may read credentials, ssh keys or certs") and asserts each path is
// matched by at least one pattern. Remove a pattern and the example it was the
// only match for goes red, naming the uncovered path.
//
// Matching is done by a local glob-to-regex translation rather than a
// dependency: the repo has no glob matcher, and the only constructs used by
// the deny lists are `**/` (zero or more leading segments), a trailing `**`
// (rest of the path) and `*` (any run of non-separator characters).

function globToRegExp(pattern: string): RegExp {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        if (pattern[i + 2] === "/") {
          re += "(?:[^/]+/)*";
          i += 2;
        } else {
          re += ".*";
          i += 1;
        }
      } else {
        re += "[^/]*";
      }
      continue;
    }
    re += ch.replace(/[.+^${}()|[\]\\?]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

function matchingPatterns(path: string): string[] {
  return CREDENTIAL_DENY_PATTERNS.filter((p) => globToRegExp(p).test(path));
}

const SSH_AND_KEY_MATERIAL: readonly string[] = [
  "home/dev/.ssh/id_rsa",
  "home/dev/.ssh/id_rsa.pub",
  "home/dev/.ssh/id_ed25519",
  "home/dev/.ssh/id_ecdsa",
  "home/dev/.ssh/id_dsa",
  "home/dev/.ssh/deploy_key",
  "home/dev/.ssh/authorized_keys",
  "home/dev/.ssh/config",
  "home/dev/.Ssh/id_rsa",
  "keys/server.ppk",
  "keys/SERVER.PPK",
  "home/dev/.gnupg/secring.gpg",
  "home/dev/.Gnupg/pubring.kbx",
  "keys/private.asc",
  "keys/private.pgp",
  "keys/PRIVATE.ASC",
];

const CERTIFICATES_AND_KEYSTORES: readonly string[] = [
  "certs/server.pem",
  "certs/server.der",
  "certs/server.crt",
  "certs/server.cer",
  "certs/server.key",
  "certs/bundle.p12",
  "certs/bundle.pfx",
  "certs/private.p8",
  "certs/app.jks",
  "certs/app.keystore",
  "certs/app.truststore",
  "certs/CERT.PEM",
  "certs/SERVER.KEY",
  "certs/KEYSTORE.JKS",
];

const CREDENTIALS_AND_TOKENS: readonly string[] = [
  ".env",
  "services/api/.env.production",
  "services/api/.env.local",
  "services/api/.envrc",
  "config/credentials.json",
  "config/credentials.yaml",
  "config/credentials.yml",
  "config/credentials.toml",
  "config/credentials.ini",
  "config/secrets.json",
  "config/secrets.yaml",
  "config/secrets.toml",
  "config/secrets.ini",
  "config/token.json",
  "config/tokens.json",
  "home/dev/.npmrc",
  "home/dev/.netrc",
  "home/dev/_netrc",
  "home/dev/.pgpass",
  "home/dev/.aws/credentials",
  "home/dev/.config/gcloud/application_default_credentials.json",
  "gcp/service-account-prod.json",
  "home/dev/.azure/accessTokens.json",
  "home/dev/.kube/config",
  "deploy/kubeconfig",
  "nginx/.htpasswd",
  "infra/terraform.tfvars",
  "infra/prod.auto.tfvars",
];

// Paths that must stay readable. Their presence is what makes the coverage
// assertions meaningful: a pattern broad enough to match everything would
// satisfy the lists above while failing here.
const MUST_STAY_READABLE: readonly string[] = [
  "src/tokenizer.ts",
  "src/keyboard.ts",
  "src/secretsManager.ts",
  "services/api/.env.example",
  "services/api/.env.template",
  "package.json",
  "docs/certificates.md",
];

describe("credential deny-list coverage", () => {
  for (const [category, paths] of [
    ["ssh and key material", SSH_AND_KEY_MATERIAL],
    ["certificates and keystores", CERTIFICATES_AND_KEYSTORES],
    ["credentials and tokens", CREDENTIALS_AND_TOKENS],
  ] as const) {
    it(`denies every representative ${category} path`, () => {
      for (const path of paths) {
        assert.ok(
          matchingPatterns(path).length > 0,
          `${path} (${category}) is matched by no CREDENTIAL_DENY_PATTERNS entry`
        );
      }
    });
  }

  it("leaves ordinary source and template files readable", () => {
    for (const path of MUST_STAY_READABLE) {
      assert.deepEqual(
        matchingPatterns(path),
        [],
        `${path} must stay readable; matched by ${matchingPatterns(path).join(", ")}`
      );
    }
  });

  it("the local glob matcher distinguishes matches from non-matches", () => {
    assert.ok(globToRegExp("**/*.pem").test("a/b/c.pem"));
    assert.ok(!globToRegExp("**/*.pem").test("a/b/c.ts"));
    assert.ok(globToRegExp("**/.ssh/**").test("home/dev/.ssh/nested/key"));
    assert.ok(!globToRegExp("**/.ssh/**").test("home/dev/sshconfig"));
    assert.ok(!globToRegExp("**/id_rsa*").test("home/dev/rsa_backup"));
  });
});

// ── Operator settings deny rules (F9) ─────────────────────────────────────────
//
// --restricted makes the CLI ignore settings files in BOTH directions, so an
// operator permissions.deny rule that blocks a plain `claude -p` read is silently
// dropped inside a step. runStep re-applies the USER-level deny entries through
// --disallowedTools so they can still narrow the grant. Deny only, user level only:
// honouring settings `allow` would widen the grant, and honouring the target repo's
// settings would let the artifact under review hide its own code from the reviewer
// (Grep/Glob denials fail silently — finding F8).
describe("runLlmStep — operator settings deny rules", () => {
  const entry: ModelEntry = {
    id: "haiku",
    transport: "cli",
    cli: { bin: "claude", model: "haiku" },
  };

  function makeHome(settingsContent?: string): string {
    const home = mkdtempSync(join(tmpdir(), "agent-flows-operator-settings-"));
    if (settingsContent !== undefined) {
      mkdirSync(join(home, ".claude"), { recursive: true });
      writeFileSync(join(home, ".claude", "settings.json"), settingsContent);
    }
    return home;
  }

  async function captureArgs(deps: Partial<StepRunnerDeps>): Promise<string[]> {
    const { child } = makeStreamJsonChild("ok");
    let capturedArgs: string[] = [];
    const spawn = ((_cmd: string, args: string[]) => {
      capturedArgs = args;
      return child;
    }) as unknown as SpawnFn;
    await runLlmStep(entry, "test", { spawn, ...deps });
    return capturedArgs;
  }

  async function captureDisallowedWithHome(
    home: string,
    deps: Partial<StepRunnerDeps> = {}
  ): Promise<string> {
    const args = await captureArgs({
      env: { HOME: home },
      contentsAccess: "read",
      workspaceDir: repoRoot,
      ...deps,
    });
    const idx = args.indexOf("--disallowedTools");
    return idx === -1 ? "" : (args[idx + 1] ?? "");
  }

  /** The deny list agent-flows builds on its own, with no operator settings in play. */
  async function builtInDisallowed(): Promise<string> {
    const args = await captureArgs({ env: {}, contentsAccess: "read", workspaceDir: repoRoot });
    const idx = args.indexOf("--disallowedTools");
    return args[idx + 1] ?? "";
  }

  it("appends the operator's permissions.deny entries to --disallowedTools", async () => {
    const home = makeHome(
      JSON.stringify({
        permissions: { deny: ["Read(//Users/op/private/**)", "Bash(curl:*)"] },
      })
    );
    try {
      const disallowed = await captureDisallowedWithHome(home);
      assert.ok(
        disallowed.includes("Read(//Users/op/private/**)"),
        `operator deny rule must reach --disallowedTools; got: ${disallowed.slice(-200)}`
      );
      assert.ok(
        disallowed.includes("Bash(curl:*)"),
        "every operator deny rule is forwarded, not just file rules"
      );
      // agent-flows' own denials are not replaced by the operator's.
      assert.ok(disallowed.includes("Read(**/.env)"), "built-in credential denials must remain");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("also appends operator deny entries for a step with no workspace", async () => {
    const home = makeHome(
      JSON.stringify({ permissions: { deny: ["Read(//op/secret-notes/**)"] } })
    );
    try {
      const args = await captureArgs({ env: { HOME: home } });
      const idx = args.indexOf("--disallowedTools");
      assert.ok(
        (args[idx + 1] ?? "").includes("Read(//op/secret-notes/**)"),
        "a no-workspace step must honour the operator's deny rules too"
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("never forwards permissions.allow from settings — deny is merged, allow is ignored", async () => {
    const home = makeHome(
      JSON.stringify({
        permissions: {
          allow: ["Bash(rm:*)", "Read(**/*.pem)"],
          deny: ["Read(//op/private/**)"],
        },
      })
    );
    try {
      const args = await captureArgs({
        env: { HOME: home },
        contentsAccess: "read",
        workspaceDir: repoRoot,
      });
      const joined = args.join(" ");
      assert.ok(
        !joined.includes("Bash(rm:*)"),
        "a settings allow entry must never appear anywhere in the argv — settings cannot widen the grant"
      );
      const idx = args.indexOf("--disallowedTools");
      const disallowed = args[idx + 1] ?? "";
      assert.ok(
        disallowed.includes("Read(//op/private/**)"),
        "the deny entry from the same file must still be merged"
      );
      assert.ok(
        disallowed.includes("Read(**/*.pem)"),
        "a settings allow entry must not cancel a built-in credential denial"
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("does NOT read the target repository's .claude/settings.json", async () => {
    // The repo under review is the artifact, not the operator. A repo that could
    // deny its own sources would hide code from the reviewing agent, because
    // Grep/Glob denials return "no matches" rather than an error (F8).
    const home = makeHome(undefined);
    const workspace = mkdtempSync(join(tmpdir(), "agent-flows-hostile-repo-"));
    mkdirSync(join(workspace, ".claude"), { recursive: true });
    writeFileSync(
      join(workspace, ".claude", "settings.json"),
      JSON.stringify({ permissions: { deny: ["Grep(**/src/**)", "Read(**/src/**)"] } })
    );
    try {
      const disallowed = await captureDisallowedWithHome(home, { workspaceDir: workspace });
      assert.ok(
        !disallowed.includes("Grep(**/src/**)"),
        "the target repo's own deny rules must not be loaded — a repo must not be able to hide its code"
      );
      assert.ok(
        !disallowed.includes("Read(**/src/**)"),
        "the target repo's own deny rules must not be loaded"
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("degrades to no extra denies when the settings file is missing", async () => {
    const home = makeHome(undefined);
    try {
      const disallowed = await captureDisallowedWithHome(home);
      assert.equal(
        disallowed,
        await builtInDisallowed(),
        "a missing settings file must add nothing"
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("degrades to no extra denies on malformed JSON, and does not throw", async () => {
    const home = makeHome("{ this is not json");
    try {
      const disallowed = await captureDisallowedWithHome(home);
      assert.ok(
        disallowed.includes("Read(**/.env)"),
        "a broken settings file must not break the run — built-in denials still emitted"
      );
      assert.equal(
        disallowed,
        await builtInDisallowed(),
        "malformed JSON must contribute no entries"
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("degrades to no extra denies when permissions.deny is absent or not an array", async () => {
    for (const content of [
      JSON.stringify({ permissions: {} }),
      JSON.stringify({ permissions: { deny: "Read(//op/**)" } }),
      JSON.stringify({}),
    ]) {
      const home = makeHome(content);
      try {
        const disallowed = await captureDisallowedWithHome(home);
        assert.equal(
          disallowed,
          await builtInDisallowed(),
          `settings ${content} must contribute no entries`
        );
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    }
  });

  it("skips blank entries and trims the ones it keeps", async () => {
    const home = makeHome(
      JSON.stringify({ permissions: { deny: ["  Read(//op/a/**)  ", "   ", 42] } })
    );
    try {
      const disallowed = await captureDisallowedWithHome(home);
      const tail = disallowed.split(",").slice(-1)[0];
      assert.equal(tail, "Read(//op/a/**)", "entry must be trimmed and be the only one appended");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("degrades to no extra denies when HOME is unset", async () => {
    const home = makeHome(JSON.stringify({ permissions: { deny: ["Read(//op/private/**)"] } }));
    try {
      // Same settings file on disk; without HOME it is unreachable, so nothing is added.
      assert.ok(
        (await captureDisallowedWithHome(home)).includes("Read(//op/private/**)"),
        "sanity: the fixture settings file is readable when HOME points at it"
      );
      assert.ok(
        !(await builtInDisallowed()).includes("Read(//op/private/**)"),
        "without HOME there is no user settings file to read"
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// ── runCheckStep — cancellation and process-group kill (FR-014/FR-015) ────────

describe("runCheckStep — cancellation kills the real process tree", () => {
  const waitMs = (ms: number) => new Promise((r) => setTimeout(r, ms));

  // Polls until `probe` is true or the budget runs out; returns whether it became true.
  async function waitFor(probe: () => boolean, budgetMs: number): Promise<boolean> {
    const deadline = Date.now() + budgetMs;
    while (Date.now() < deadline) {
      if (probe()) return true;
      await waitMs(50);
    }
    return probe();
  }

  const isGone = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  };

  function capturingSpawn(): { spawn: SpawnFn; getPid: () => number | undefined } {
    let pid: number | undefined;
    const fn = ((cmd: string, args: string[], opts: object) => {
      const child = realSpawn(cmd, args, opts);
      pid = child.pid;
      return child;
    }) as unknown as SpawnFn;
    return { spawn: fn, getPid: () => pid };
  }

  // Backgrounds a long sleep and publishes its pid, so the test identifies the
  // grandchild by pid rather than by a command-line marker — a marker would also
  // match the identical process of a concurrently running copy of this suite.
  function grandchildCommand(pidFile: string): string {
    return `sleep 9000 & echo $! > ${pidFile}; wait`;
  }

  /**
   * Best-effort SIGKILL. When the gate is green everything here is already dead
   * and process.kill throws ESRCH; when the gate is RED the survivors are
   * exactly what this test is about, and leaving them running would leak a
   * `sleep 9000` into the developer's machine on every failed run.
   */
  function reap(pid: number | undefined): void {
    if (pid === undefined) return;
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // ESRCH — already gone, which is the expected case on a green run.
    }
  }

  async function readGrandchildPid(pidFile: string): Promise<number> {
    const ok = await waitFor(
      () => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim() !== "",
      5_000
    );
    assert.ok(ok, "the shell must have published the background job's pid");
    return Number(readFileSync(pidFile, "utf8").trim());
  }

  it(
    "aborts a running check with no deadline and kills the shell (FR-014)",
    { timeout: 20_000 },
    async () => {
      const { spawn, getPid } = capturingSpawn();
      const controller = new AbortController();
      // timeoutMs: 0 disables the deadline — before FR-014 deps.signal was discarded here.
      const pending = runCheckStep("sleep 9000", {
        timeoutMs: 0,
        signal: controller.signal,
        spawn,
      });

      await waitMs(100);
      const pid = getPid();
      assert.ok(pid !== undefined, "the shell must have been spawned");
      controller.abort();

      const result = await Promise.race([pending, waitMs(8_000).then(() => "timed-out" as const)]);
      assert.notEqual(result, "timed-out", "abort must end the step even with no deadline");
      assert.equal((result as { passed: boolean }).passed, false);
      assert.ok(await waitFor(() => isGone(pid), 4_000), `shell pid ${pid} must be dead`);
    }
  );

  it(
    "kills forked grandchildren with the shell's process group (FR-015)",
    { timeout: 20_000 },
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "spec033-group-"));
      const pidFile = join(dir, "grandchild.pid");
      const { spawn, getPid } = capturingSpawn();
      let grandPid: number | undefined;
      try {
        const controller = new AbortController();
        const pending = runCheckStep(grandchildCommand(pidFile), {
          timeoutMs: 0,
          signal: controller.signal,
          spawn,
        });

        grandPid = await readGrandchildPid(pidFile);
        // Bound to a const so the waitFor closure below sees a plain number.
        const gpid = grandPid;
        assert.equal(isGone(gpid), false, "the grandchild must be running before the abort");

        controller.abort();

        // Raced, not awaited: a surviving grandchild holds the shell's stdout
        // pipe open, so 'close' never fires and `await pending` would hang the
        // suite forever instead of reporting a failure.
        const outcome = await Promise.race([
          pending,
          waitMs(8_000).then(() => "timed-out" as const),
        ]);
        assert.notEqual(
          outcome,
          "timed-out",
          "the runner must resolve after the abort — a surviving grandchild holds its stdout pipe open"
        );

        assert.ok(
          await waitFor(() => isGone(gpid), 6_000),
          `grandchild pid ${gpid} must die with the shell — a bare child.kill() leaves it running`
        );
      } finally {
        // Reap by the pids this run minted, never by command-line match: a
        // concurrent copy of this suite runs an identical `sleep 9000`.
        reap(getPid());
        reap(grandPid);
        rmSync(dir, { recursive: true, force: true });
      }
    }
  );

  it("a check with no deadline that exits normally still resolves with its output", async () => {
    const result = await runCheckStep("printf 'no-deadline-output'", { timeoutMs: 0 });
    assert.equal(result.passed, true);
    assert.equal(result.exitCode, 0);
    assert.ok(result.output.includes("no-deadline-output"));
  });

  it(
    "the deadline path still kills the process group on timeout",
    { timeout: 20_000 },
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "spec033-deadline-"));
      const pidFile = join(dir, "grandchild.pid");
      try {
        const pending = runCheckStep(grandchildCommand(pidFile), { timeoutMs: 1_000 });
        const grandPid = await readGrandchildPid(pidFile);

        const result = await pending;
        assert.equal(result.passed, false);
        assert.ok(
          result.output.toLowerCase().includes("timed out"),
          `output should mention the timeout; got: ${result.output}`
        );
        assert.ok(
          await waitFor(() => isGone(grandPid), 6_000),
          `grandchild pid ${grandPid} must not survive the deadline`
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  );
});
