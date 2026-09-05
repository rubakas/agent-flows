// FR-002: Spawn the local claude CLI for subscription-authenticated LLM calls.

import { spawn as defaultSpawn } from "node:child_process";

export type SpawnFn = typeof defaultSpawn;

export interface RunCliOptions {
  model?: string;
  cwd?: string;
  signal?: AbortSignal;
  extraArgs?: string[];
}

export interface RunCliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
}

export const SCRUBBED_KEYS = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "LITELLM_VIRTUAL_KEY"];

export function runClaudeCli(
  prompt: string,
  opts: RunCliOptions = {},
  deps: { spawn?: SpawnFn; env?: NodeJS.ProcessEnv } = {}
): Promise<RunCliResult> {
  const { model, cwd, signal, extraArgs = [] } = opts;
  const spawnFn = deps.spawn ?? defaultSpawn;

  // Layer-0: scrub provider keys before passing env to child
  const rawEnv = deps.env ?? process.env;
  const env: NodeJS.ProcessEnv = { ...rawEnv };
  for (const key of SCRUBBED_KEYS) delete env[key];

  // Prompt is written to child stdin; passing it as argv would expose it in process listings.
  const args = [
    "-p",
    "--output-format",
    "text",
    ...(model ? ["--model", model] : []),
    ...extraArgs,
  ];

  const start = Date.now();

  return new Promise((resolve, reject) => {
    const child = spawnFn("claude", args, { env, cwd });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    // Deliver prompt via stdin so it never appears in process argv listings.
    child.stdin.write(prompt);
    child.stdin.end();

    const onAbort = () => {
      child.kill("SIGTERM");
    };

    // Attach error and close handlers unconditionally BEFORE any early return so the child
    // process always has handlers (prevents ERR_UNHANDLED_ERROR if claude is missing from PATH).
    child.on("error", (err) => {
      if (signal) signal.removeEventListener("abort", onAbort);
      reject(err);
    });

    child.on("close", (code) => {
      if (signal) signal.removeEventListener("abort", onAbort);

      const durationMs = Date.now() - start;

      if (signal?.aborted) {
        reject(new DOMException("Claude CLI aborted", "AbortError"));
        return;
      }

      const exitCode = code ?? -1;
      if (exitCode !== 0) {
        const tail = stderr.slice(-500);
        reject(new Error(`claude exited with code ${exitCode}\nstderr: ${tail}`));
        return;
      }

      // claude exits 0 even for unrecognized models, embedding the error in stdout.
      if (stdout.includes("[claude-code:unrecognized_model]")) {
        reject(
          new Error(
            `claude CLI rejected model ${JSON.stringify(model ?? "(default)")}: ${stdout.trim().slice(0, 300)}`
          )
        );
        return;
      }

      resolve({ stdout, stderr, exitCode, durationMs });
    });

    if (signal) {
      if (signal.aborted) {
        child.kill("SIGTERM");
        reject(new DOMException("Claude CLI aborted before start", "AbortError"));
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}
