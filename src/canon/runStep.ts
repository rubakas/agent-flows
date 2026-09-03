// Provider-agnostic step executor for Binding B.

import { spawn as defaultSpawn } from "node:child_process";
import { runClaudeCli } from "./runClaudeCli.js";
import type { ModelEntry } from "./registry.js";
import type { SpawnFn } from "./runClaudeCli.js";

export type { SpawnFn } from "./runClaudeCli.js";

export interface StepRunnerDeps {
  spawn?: SpawnFn;
  fetchFn?: typeof fetch;
  env?: NodeJS.ProcessEnv;
}

// ── codex exec JSON event shape ───────────────────────────────────────────────

interface CodexItemCompleted {
  type: "item.completed";
  item: { type: string; text?: string };
}

function isItemCompleted(line: string): CodexItemCompleted | null {
  try {
    const obj = JSON.parse(line) as { type?: string; item?: { type?: string; text?: string } };
    if (obj.type === "item.completed" && obj.item?.type === "agent_message") {
      return obj as CodexItemCompleted;
    }
  } catch {
    // non-JSON line (header noise) — skip
  }
  return null;
}

function extractCodexAnswer(stdout: string): string {
  let last: string | undefined;
  for (const line of stdout.split("\n")) {
    const ev = isItemCompleted(line.trim());
    if (ev?.item.text !== undefined) last = ev.item.text;
  }
  if (last === undefined) {
    throw new Error(
      `codex exec: no agent_message found in output.\nRaw stdout (last 500 chars):\n${stdout.slice(-500)}`
    );
  }
  return last;
}

// ── API transport (OpenAI chat-completions compatible) ────────────────────────

interface ChatCompletion {
  choices: { message: { content: string | null } }[];
}

async function runApiStep(
  entry: ModelEntry,
  prompt: string,
  deps: StepRunnerDeps
): Promise<string> {
  const endpoint = entry.api!.endpoint;
  const model = entry.api!.model;
  const keyEnv = entry.api!.keyEnv;
  const env = deps.env ?? process.env;
  const fetchFn = deps.fetchFn ?? fetch;

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (keyEnv) {
    const key = env[keyEnv];
    if (key) headers.Authorization = `Bearer ${key}`;
  }

  const body = JSON.stringify({
    model,
    messages: [{ role: "user", content: prompt }],
  });

  let res: Response;
  try {
    res = await fetchFn(endpoint, { method: "POST", headers, body });
  } catch (err) {
    throw new Error(`api step: fetch failed for ${endpoint}: ${String(err)}`, { cause: err });
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "(unreadable)");
    throw new Error(`api step: ${endpoint} returned ${res.status}: ${text.slice(0, 300)}`);
  }

  let json: ChatCompletion;
  try {
    json = (await res.json()) as ChatCompletion;
  } catch {
    throw new Error(`api step: response from ${endpoint} is not valid JSON`);
  }

  const content = json.choices?.[0]?.message?.content;
  if (typeof content !== "string") {
    throw new Error(`api step: missing choices[0].message.content in response from ${endpoint}`);
  }
  return content;
}

// ── codex CLI transport ───────────────────────────────────────────────────────

function runCodexCli(
  prompt: string,
  model: string | undefined,
  deps: StepRunnerDeps
): Promise<string> {
  const spawnFn = deps.spawn ?? defaultSpawn;
  const env = deps.env ?? process.env;

  const args = [
    "exec",
    "--ephemeral",
    "--json",
    "-s",
    "read-only",
    ...(model ? ["-m", model] : []),
  ];

  return new Promise((resolve, reject) => {
    const child = spawnFn("codex", args, { env });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.stdin.write(prompt);
    child.stdin.end();

    child.on("error", (err) => {
      reject(new Error(`codex exec: spawn error: ${err.message}`));
    });

    child.on("close", (code) => {
      // codex exits non-zero on auth/model errors but also emits JSON events; try parse first.
      try {
        resolve(extractCodexAnswer(stdout));
      } catch {
        const tail = stderr.slice(-400);
        reject(
          new Error(
            `codex exec: exit ${code ?? -1}; no agent_message found.\nstderr: ${tail}\nstdout: ${stdout.slice(-400)}`
          )
        );
      }
    });
  });
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function runLlmStep(
  entry: ModelEntry,
  prompt: string,
  deps: StepRunnerDeps = {}
): Promise<string> {
  if (entry.transport === "cli") {
    const bin = entry.cli?.bin ?? "claude";

    if (bin === "claude") {
      const result = await runClaudeCli(prompt, { model: entry.cli?.model }, deps);
      return result.stdout.trim();
    }

    if (bin === "codex") {
      return runCodexCli(prompt, entry.cli?.model, deps);
    }

    throw new Error(`runLlmStep: unknown cli bin "${String(bin)}"`);
  }

  if (entry.transport === "api") {
    return runApiStep(entry, prompt, deps);
  }

  throw new Error(`runLlmStep: unknown transport "${String(entry.transport)}"`);
}
