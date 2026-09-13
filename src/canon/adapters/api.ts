// API transport adapter (OpenAI chat-completions compatible), spec 031 D1.
// Moved verbatim from runStep.ts's api branch.

import { DEFAULT_STEP_TIMEOUT_MS, withDeadline } from "../stepRuntime.js";
import type { ModelEntry } from "../registry.js";
import type { StepRunnerDeps } from "../stepRuntime.js";
import type { AdapterCapabilities, ProviderAdapter } from "./types.js";

interface ChatCompletion {
  choices: { message: { content: string | null } }[];
}

async function runApiStep(
  entry: ModelEntry,
  prompt: string,
  deps: StepRunnerDeps,
  signal: AbortSignal | undefined
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
    res = await fetchFn(endpoint, { method: "POST", headers, body, signal });
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

async function runApiTransportStep(
  prompt: string,
  entry: ModelEntry,
  deps: StepRunnerDeps
): Promise<string> {
  // Checked before any deadline is created: a configuration error must fail fast.
  if (deps.contentsAccess === "read" || deps.contentsAccess === "write") {
    throw new Error(
      `runLlmStep: permissions.contents "${deps.contentsAccess}" is not supported for api transport — ` +
        `sandbox enforcement requires a CLI subprocess; api transport has no equivalent`
    );
  }

  return withDeadline(deps, DEFAULT_STEP_TIMEOUT_MS, async (effectiveSignal) => {
    // FR-007: maxBudgetUsd is a claude-CLI flag; api transport has no equivalent
    if (deps.maxBudgetUsd !== undefined) {
      throw new Error(
        `runLlmStep: maxBudgetUsd is not supported for api transport — ` +
          `only claude-transport llm steps support --max-budget-usd`
      );
    }
    return await runApiStep(entry, prompt, deps, effectiveSignal);
  });
}

export const apiAdapter: ProviderAdapter = {
  id: "api",
  capabilities(): AdapterCapabilities {
    // No subprocess, no sandbox, no cost cap: the transport enforces nothing.
    return { workspaceRead: false, workspaceWrite: false, budgetCap: false };
  },
  run: runApiTransportStep,
};
