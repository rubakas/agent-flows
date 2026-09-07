// Shared fake spawn helpers for tests.

import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { SpawnFn } from "../runClaudeCli.js";

export interface FakeChildOptions {
  stdoutChunks?: string[];
  stderrChunks?: string[];
  exitCode?: number;
}

export function makeFakeChild(opts: FakeChildOptions = {}) {
  const { stdoutChunks = [], stderrChunks = [], exitCode = 0 } = opts;

  const emitter = new EventEmitter();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = new PassThrough();

  const killCalls: string[] = [];

  const child = Object.assign(emitter, {
    stdout,
    stderr,
    stdin,
    kill(signal?: string) {
      killCalls.push(signal ?? "SIGTERM");
    },
  });

  setImmediate(() => {
    for (const chunk of stdoutChunks) stdout.push(chunk);
    stdout.push(null);
    for (const chunk of stderrChunks) stderr.push(chunk);
    stderr.push(null);
    emitter.emit("close", exitCode);
  });

  return { child, killCalls };
}

export function makeFakeSpawn(opts: FakeChildOptions = {}): {
  spawn: SpawnFn;
  capturedArgs: string[][];
} {
  const capturedArgs: string[][] = [];
  const { child } = makeFakeChild(opts);
  const spawn = ((_cmd: string, args: string[]) => {
    capturedArgs.push(args);
    return child;
  }) as unknown as SpawnFn;
  return { spawn, capturedArgs };
}

/**
 * Returns a different canned stdout per call, in order.
 * After responses are exhausted, returns an empty string.
 */
export function makeMultiFakeSpawn(responses: string[]): {
  spawn: SpawnFn;
  getCallCount: () => number;
} {
  let callIndex = 0;
  const spawn = ((_cmd: string, _args: string[]) => {
    const response = responses[callIndex] ?? "";
    callIndex++;
    const { child } = makeFakeChild({ stdoutChunks: [response] });
    return child;
  }) as unknown as SpawnFn;
  return { spawn, getCallCount: () => callIndex };
}

/**
 * Formats a plain text result into stream-json stdout that runClaudeCli can parse.
 * Wraps the text in a minimal result event preceded by a system/init event.
 */
export function makeStreamJsonStdout(
  resultText: string,
  opts: { isError?: boolean; subtype?: string; totalCostUsd?: number } = {}
): string {
  const initLine = JSON.stringify({ type: "system", subtype: "init", tools: [], mcp_servers: [] });
  const resultLine = JSON.stringify({
    type: "result",
    subtype: opts.subtype ?? (opts.isError ? "error_during_execution" : "success"),
    is_error: opts.isError ?? false,
    result: resultText,
    total_cost_usd: opts.totalCostUsd ?? 0,
    num_turns: 1,
  });
  return `${initLine}\n${resultLine}\n`;
}

/**
 * Convenience: creates a fake child that emits stream-json formatted stdout.
 * Drop-in replacement for makeFakeChild({ stdoutChunks: ["text"] }) on claude transport tests.
 */
export function makeStreamJsonChild(
  resultText: string,
  opts: Parameters<typeof makeStreamJsonStdout>[1] & {
    exitCode?: number;
    stderrChunks?: string[];
  } = {}
) {
  return makeFakeChild({
    stdoutChunks: [makeStreamJsonStdout(resultText, opts)],
    stderrChunks: opts.stderrChunks,
    exitCode: opts.exitCode,
  });
}

/**
 * Creates a fake spawn that returns different stream-json responses per call.
 * Captures stdin written to each child so callers can inspect the prompt.
 */
export function makeMultiFakeStreamJsonSpawn(
  responses: (string | { text: string; subtype?: string; isError?: boolean })[]
): {
  spawn: SpawnFn;
  getCallCount: () => number;
  getStdin: (callIdx: number) => Promise<string>;
} {
  let callIndex = 0;
  const stdinPromises: Promise<string>[] = [];

  const spawn = ((_cmd: string, _args: string[]) => {
    const resp = responses[callIndex] ?? "";
    const text = typeof resp === "string" ? resp : resp.text;
    const subtype = typeof resp === "object" ? resp.subtype : undefined;
    const isError = typeof resp === "object" ? resp.isError : false;
    callIndex++;

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
        // Simulate the child responding to SIGTERM by closing
        setImmediate(() => {
          if (!stdout.destroyed) stdout.push(null);
          if (!stderr.destroyed) stderr.push(null);
          emitter.emit("close", null);
        });
      },
    });

    // Capture stdin content
    const stdinPromise = new Promise<string>((resolve) => {
      let buf = "";
      stdin.on("data", (d: Buffer) => (buf += d.toString()));
      stdin.on("end", () => resolve(buf));
    });
    stdinPromises.push(stdinPromise);

    setImmediate(() => {
      stdout.push(makeStreamJsonStdout(text, { subtype, isError }));
      stdout.push(null);
      stderr.push(null);
      emitter.emit("close", 0);
    });

    return child;
  }) as unknown as SpawnFn;

  return {
    spawn,
    getCallCount: () => callIndex,
    getStdin: (idx: number) => stdinPromises[idx] ?? Promise.resolve(""),
  };
}
