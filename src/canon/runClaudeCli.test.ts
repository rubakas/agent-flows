import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";
import { runClaudeCli } from "./runClaudeCli.js";
import { makeFakeChild, makeFakeSpawn } from "./testing/fakeSpawn.js";
import type { SpawnFn } from "./runClaudeCli.js";

describe("runClaudeCli", () => {
  it("passes correct args to spawn (prompt via stdin, not argv)", async () => {
    const { spawn, capturedArgs } = makeFakeSpawn({ stdoutChunks: ["PONG"] });
    await runClaudeCli("say PONG", { model: "opus", extraArgs: ["--foo"] }, { spawn });
    assert.deepEqual(capturedArgs[0], [
      "-p",
      "--output-format",
      "text",
      "--model",
      "opus",
      "--foo",
    ]);
    assert.ok(!capturedArgs[0].includes("say PONG"), "prompt must not appear in argv");
  });

  it("omits --model when not specified", async () => {
    const { spawn, capturedArgs } = makeFakeSpawn({ stdoutChunks: ["ok"] });
    await runClaudeCli("hi", {}, { spawn });
    assert.ok(!capturedArgs[0].includes("--model"));
  });

  it("scrubs OPENAI_API_KEY and ANTHROPIC_API_KEY from env passed to child", async () => {
    let capturedEnv: NodeJS.ProcessEnv | undefined;
    const { child } = makeFakeChild({ stdoutChunks: ["ok"] });
    const spawn = ((_cmd: string, _args: string[], spawnOpts: { env?: NodeJS.ProcessEnv }) => {
      capturedEnv = spawnOpts.env;
      return child;
    }) as unknown as SpawnFn;

    await runClaudeCli(
      "hi",
      {},
      {
        spawn,
        env: {
          HOME: "/home/test",
          OPENAI_API_KEY: "sk-abc",
          ANTHROPIC_API_KEY: "sk-ant",
          LITELLM_VIRTUAL_KEY: "vk-123",
        },
      }
    );

    assert.equal(capturedEnv?.OPENAI_API_KEY, undefined);
    assert.equal(capturedEnv?.ANTHROPIC_API_KEY, undefined);
    assert.equal(capturedEnv?.LITELLM_VIRTUAL_KEY, undefined);
    assert.equal(capturedEnv?.HOME, "/home/test");
  });

  it("captures stdout", async () => {
    const { spawn } = makeFakeSpawn({ stdoutChunks: ["hello ", "world"] });
    const result = await runClaudeCli("hi", {}, { spawn });
    assert.equal(result.stdout, "hello world");
    assert.equal(result.exitCode, 0);
  });

  it("rejects with Error on non-zero exit code", async () => {
    const { spawn } = makeFakeSpawn({
      stderrChunks: ["something went wrong"],
      exitCode: 1,
    });
    await assert.rejects(runClaudeCli("hi", {}, { spawn }), (err: Error) => {
      assert.ok(err.message.includes("code 1"));
      assert.ok(err.message.includes("something went wrong"));
      return true;
    });
  });

  it("rejects with model error when stdout contains [claude-code:unrecognized_model]", async () => {
    const { spawn } = makeFakeSpawn({
      stdoutChunks: ["[claude-code:unrecognized_model]\nThere's an issue with the selected model"],
      exitCode: 0,
    });
    await assert.rejects(
      runClaudeCli("hi", { model: "bad-model-name" }, { spawn }),
      (err: Error) => {
        assert.ok(
          err.message.includes("bad-model-name"),
          `expected model in message: ${err.message}`
        );
        assert.ok(
          err.message.includes("unrecognized_model"),
          `expected marker in message: ${err.message}`
        );
        return true;
      }
    );
  });

  it("kills child and rejects with AbortError when signal aborts", async () => {
    const killCalls: string[] = [];
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
        // After kill, emit close to settle the promise
        setImmediate(() => emitter.emit("close", 0));
      },
    });

    const spawn = (() => child) as unknown as SpawnFn;

    const controller = new AbortController();

    // Abort after a tick, before close fires
    setImmediate(() => {
      controller.abort();
      stdout.push(null);
      stderr.push(null);
    });

    await assert.rejects(runClaudeCli("hi", { signal: controller.signal }, { spawn }), {
      name: "AbortError",
    });

    assert.ok(killCalls.length > 0, "kill should have been called");
  });

  it("pre-aborted signal + child error (ENOENT) rejects cleanly without unhandled error", async () => {
    const emitter = new EventEmitter();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdin = new PassThrough();
    const killCalls: string[] = [];

    const child = Object.assign(emitter, {
      stdout,
      stderr,
      stdin,
      kill(sig?: string) {
        killCalls.push(sig ?? "SIGTERM");
        // Simulate spawn failure: error fires, then close
        setImmediate(() => {
          emitter.emit(
            "error",
            Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" })
          );
          emitter.emit("close", null);
        });
      },
    });

    const controller = new AbortController();
    controller.abort(); // already aborted before call

    const spawn = (() => child) as unknown as SpawnFn;

    // Must reject (with either AbortError or ENOENT), must not throw unhandled error
    await assert.rejects(runClaudeCli("hi", { signal: controller.signal }, { spawn }));
    assert.ok(killCalls.length > 0, "kill should have been called");
  });
});
