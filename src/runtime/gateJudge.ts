// The gate judge (FR-004/FR-005): turning a suspended gate's material into an
// approve/reject verdict. Extracted from runService.ts, which keeps the run
// lifecycle around it (dispatch, the single-flight resume, degrade-to-manual)
// and calls in here for the judging itself.

import { getActiveProfile } from "../canon/registry.js";
import { runLlmStep } from "../canon/runStep.js";
import { buildGateMaterial } from "./gateMaterial.js";
import type { GatePayload } from "./gateMaterial.js";
import type { ModelRegistry, ProviderProfile } from "../canon/registry.js";
import type { StepRunnerDeps } from "../canon/runStep.js";

// ── Judge deps (injectable for testing) ───────────────────────────────────────

/**
 * Dependencies for the gate judge (FR-004). Injected at construction so tests
 * can stub the runner without spawning real LLM processes.
 */
export interface JudgeDeps {
  /**
   * LLM runner. Defaults to the canon's `runLlmStep` when not provided.
   * Tests inject a stub that returns a fixture verdict without calling a real model.
   */
  runner?: typeof runLlmStep;
  /** Registry for resolving the reasoner model. */
  registry: ModelRegistry;
  /** Active provider profile. Defaults to `getActiveProfile()` when absent. */
  profile?: ProviderProfile;
  /** Project root directory — used for workspace access and git status capture. */
  projectDir: string;
  /** Contents of the gate-judge.md prompt file, read once at startup. */
  judgePrompt: string;
}

/**
 * The judge's prompt: its instructions, then the shared gate material.
 *
 * The material is built by gateMaterial.ts so the summary shown to the human
 * and the verdict cast by the judge are formed from the same view of the run.
 */
function buildJudgePrompt(
  deps: JudgeDeps,
  pipelineId: string,
  gateStepId: string,
  payload: GatePayload | undefined
): string {
  return [
    deps.judgePrompt,
    "",
    buildGateMaterial(deps.projectDir, pipelineId, gateStepId, payload),
  ].join("\n");
}

/**
 * Parse a judge response into a structured verdict (FR-005).
 * Extracts the first JSON object from the response text.
 */
function parseVerdict(
  raw: string
):
  | { ok: true; verdict: { verdict: "approve" | "reject"; reason: string } }
  | { ok: false; error: string } {
  const trimmed = raw.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    return { ok: false, error: "No JSON object found in response" };
  }
  const jsonStr = trimmed.slice(start, end + 1);

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (err) {
    return {
      ok: false,
      error: `JSON parse error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (typeof parsed !== "object" || parsed === null) {
    return { ok: false, error: "Verdict is not an object" };
  }

  const obj = parsed as Record<string, unknown>;
  const verdict = obj.verdict;
  const reason = obj.reason;

  if (verdict !== "approve" && verdict !== "reject") {
    return {
      ok: false,
      error: `Unknown verdict "${String(verdict)}"; must be "approve" or "reject"`,
    };
  }

  if (typeof reason !== "string" || reason.trim() === "") {
    return { ok: false, error: "reason must be a non-empty string" };
  }

  return { ok: true, verdict: { verdict, reason } };
}

/** What the judge produced: a verdict with its provenance, or why it failed. */
export type JudgeResult =
  | {
      verdict: "approve" | "reject";
      reason: string;
      judgeModelId: string;
      workspaceAccess: boolean;
    }
  | { error: string };

/**
 * Core judge execution: builds the prompt, resolves the model, runs with one retry.
 * Returns verdict+metadata on success, or error string on failure.
 */
export async function runJudge(
  judgeDeps: JudgeDeps,
  pipelineId: string,
  gateStepId: string,
  payload: GatePayload | undefined,
  /**
   * The profile the RUN was started under. Preferred over the judge's own
   * default: a run pinned to one provider must not have its gates judged by
   * another, which is what happened while this argument did not exist.
   */
  runProfile?: ProviderProfile
): Promise<JudgeResult> {
  const judgePromptText = buildJudgePrompt(judgeDeps, pipelineId, gateStepId, payload);

  const { runner, registry, profile, projectDir } = judgeDeps;
  const activeProfile = runProfile ?? profile ?? getActiveProfile();
  const judgeModelId = activeProfile.roles.reasoner;
  const entry = registry.resolve(judgeModelId);
  const isApiTransport = entry.transport === "api";

  const deps: StepRunnerDeps = isApiTransport
    ? {} // api transport: no workspace access (FR-004, Context §7)
    : { contentsAccess: "read" as const, workspaceDir: projectDir };

  const actualRunner = runner ?? runLlmStep;

  let lastParseError: string | undefined;
  // One retry on parse failure; second malformed verdict → judge failure (FR-005).
  for (let attempt = 0; attempt < 2; attempt++) {
    const promptToUse =
      attempt === 0
        ? judgePromptText
        : judgePromptText +
          `\n\n[PARSE ERROR on attempt 1: ${String(lastParseError)}. Output only the JSON object on a single line.]`;

    let raw: string;
    try {
      raw = await actualRunner(entry, promptToUse, deps);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { error: `Judge transport error: ${msg}` };
    }

    const parsed = parseVerdict(raw);
    if (parsed.ok) {
      return {
        verdict: parsed.verdict.verdict,
        reason: parsed.verdict.reason,
        judgeModelId: entry.id,
        workspaceAccess: !isApiTransport,
      };
    }

    lastParseError = parsed.error;
  }

  return { error: `Judge produced malformed verdict: ${lastParseError ?? "unknown"}` };
}
