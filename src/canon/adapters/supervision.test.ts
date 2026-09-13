// FR-002a: a hung child is aborted by the adapter's own supervision, not by the
// test harness. Each adapter gets a child (or fetch) that never completes on its
// own and a tiny deadline; the adapter must reject and kill what it spawned.

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";
import { StepTimeoutError, StepWatchdogError } from "../stepRuntime.js";
import { apiAdapter } from "./api.js";
import { claudeAdapter } from "./claude.js";
import { codexAdapter } from "./codex.js";
import type { ModelEntry } from "../registry.js";
import type { SpawnFn } from "../runClaudeCli.js";

/** A deadline short enough to keep the suite fast, long enough to not race the spawn. */
const TINY_DEADLINE_MS = 40;

/**
 * Harness backstop, 50x the adapter's own deadline. It never aborts a working
 * adapter — supervision fires in TINY_DEADLINE_MS — but without it a regression
 * that removes supervision leaves the child hanging with no timer alive, so node
 * exits with the test *cancelled* rather than failed. A gate that reports a
 * missing supervisor as "not run" is not a gate.
 */
const HARNESS_TIMEOUT = { timeout: 2_000 };

/**
 * A child that emits nothing and never exits on its own. It closes only when the
 * adapter kills it — exactly how a real wedged CLI behaves under SIGTERM — so the
 * test can prove the abort came from the adapter.
 */
function makeHungChildSpawn(): { spawn: SpawnFn; killSignals: () => string[] } {
  const killSignals: string[] = [];
  const spawn = (() => {
    const emitter = new EventEmitter();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdin = new PassThrough();
    return Object.assign(emitter, {
      stdout,
      stderr,
      stdin,
      kill(signal?: string) {
        killSignals.push(signal ?? "SIGTERM");
        setImmediate(() => {
          if (!stdout.destroyed) stdout.push(null);
          if (!stderr.destroyed) stderr.push(null);
          emitter.emit("close", null);
        });
      },
    });
  }) as unknown as SpawnFn;
  return { spawn, killSignals: () => killSignals };
}

const claudeEntry: ModelEntry = { id: "sonnet", transport: "cli", cli: { bin: "claude" } };
const codexEntry: ModelEntry = { id: "codex", transport: "cli", cli: { bin: "codex" } };
const apiEntry: ModelEntry = {
  id: "ollama-qwen",
  transport: "api",
  api: { endpoint: "http://localhost:11434/v1/chat/completions" },
};

describe("adapter supervision — a hung child is always aborted (FR-002a)", () => {
  it(
    "claude: the declared deadline kills the child and raises StepTimeoutError",
    HARNESS_TIMEOUT,
    async () => {
      const { spawn, killSignals } = makeHungChildSpawn();
      await assert.rejects(
        claudeAdapter.run("hi", claudeEntry, { spawn, timeoutMs: TINY_DEADLINE_MS }),
        StepTimeoutError
      );
      assert.deepEqual(killSignals(), ["SIGTERM"], "the adapter must terminate the hung child");
    }
  );

  it(
    "claude: with no deadline at all the progress watchdog still stops the step",
    HARNESS_TIMEOUT,
    async () => {
      const { spawn, killSignals } = makeHungChildSpawn();
      // No timeoutMs, no defaultTimeoutMs: claude's built-in fallback is 0, so the
      // stall detector is the only supervisor left. It must still end the step.
      await assert.rejects(
        claudeAdapter.run("hi", claudeEntry, { spawn, _stallSilenceMs: TINY_DEADLINE_MS }),
        StepWatchdogError
      );
      assert.ok(killSignals().length > 0, "the watchdog must terminate the hung child");
    }
  );

  it(
    "codex: the deadline kills the child and raises StepTimeoutError",
    HARNESS_TIMEOUT,
    async () => {
      const { spawn, killSignals } = makeHungChildSpawn();
      await assert.rejects(
        codexAdapter.run("hi", codexEntry, { spawn, timeoutMs: TINY_DEADLINE_MS }),
        StepTimeoutError
      );
      assert.deepEqual(killSignals(), ["SIGTERM"], "the adapter must terminate the hung child");
    }
  );

  it(
    "api: the deadline aborts the in-flight request and raises StepTimeoutError",
    HARNESS_TIMEOUT,
    async () => {
      let sawAbort = false;
      const fetchFn = ((_url: string, init: { signal?: AbortSignal }) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init.signal;
          if (!signal) return; // hangs forever — the test would time out, which is the failure
          signal.addEventListener(
            "abort",
            () => {
              sawAbort = true;
              reject(new DOMException("The operation was aborted.", "AbortError"));
            },
            { once: true }
          );
        })) as unknown as typeof fetch;

      await assert.rejects(
        apiAdapter.run("hi", apiEntry, { fetchFn, timeoutMs: TINY_DEADLINE_MS }),
        StepTimeoutError
      );
      assert.ok(sawAbort, "the adapter must abort the in-flight request");
    }
  );
});

// A non-positive deadline was an escape hatch that removed the ONLY supervisor a
// codex or api step has: the child ran forever and the codex adapter's `finally`
// — which deletes the sanitized copy of the repo — never fired. The loader now
// refuses such a value, and withDeadline clamps it back to the transport's own
// fallback; these are the second layer.
describe("adapter supervision — timeoutMs: 0 cannot disable it (FR-002)", () => {
  it(
    "codex: a zero deadline falls back to the transport's built-in one",
    HARNESS_TIMEOUT,
    async () => {
      const { spawn, killSignals } = makeHungChildSpawn();
      await assert.rejects(
        codexAdapter.run("hi", codexEntry, {
          spawn,
          timeoutMs: 0,
          _builtInTimeoutMs: TINY_DEADLINE_MS,
        }),
        StepTimeoutError
      );
      assert.deepEqual(killSignals(), ["SIGTERM"], "the hung child must still be terminated");
    }
  );

  it(
    "api: a zero deadline falls back to the transport's built-in one",
    HARNESS_TIMEOUT,
    async () => {
      let sawAbort = false;
      const fetchFn = ((_url: string, init: { signal?: AbortSignal }) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener(
            "abort",
            () => {
              sawAbort = true;
              reject(new DOMException("The operation was aborted.", "AbortError"));
            },
            { once: true }
          );
        })) as unknown as typeof fetch;

      await assert.rejects(
        apiAdapter.run("hi", apiEntry, {
          fetchFn,
          timeoutMs: 0,
          _builtInTimeoutMs: TINY_DEADLINE_MS,
        }),
        StepTimeoutError
      );
      assert.ok(sawAbort, "the in-flight request must still be aborted");
    }
  );

  it(
    "claude: a zero deadline stays an escape hatch, because the watchdog supervises",
    HARNESS_TIMEOUT,
    async () => {
      const { spawn, killSignals } = makeHungChildSpawn();
      // No deadline is created at all here — the stall detector is what ends the step.
      await assert.rejects(
        claudeAdapter.run("hi", claudeEntry, {
          spawn,
          timeoutMs: 0,
          _stallSilenceMs: TINY_DEADLINE_MS,
        }),
        StepWatchdogError
      );
      assert.ok(killSignals().length > 0, "the watchdog must still terminate the hung child");
    }
  );
});
