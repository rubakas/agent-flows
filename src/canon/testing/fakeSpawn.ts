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
