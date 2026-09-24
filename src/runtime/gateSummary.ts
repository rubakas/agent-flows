// The gate summary (spec 043): one paragraph telling the human what the two
// buttons in front of them would decide.
//
// Deliberately NOT part of gateJudge.ts. They read the same material
// (gateMaterial.ts) at the same moment, and that is where the resemblance ends:
// the judge casts a verdict and can resolve the gate; this only describes, runs
// at the cheapest tier, and can fail without consequence. Folding them together
// would put a text nobody's decision depends on into the path of one that
// resolves the run.

import { getActiveProfile } from "../canon/registry.js";
import { runLlmStep } from "../canon/runStep.js";
import { buildGateMaterial } from "./gateMaterial.js";
import type { ModelRegistry, ProviderProfile } from "../canon/registry.js";
import type { StepRunnerDeps } from "../canon/runStep.js";
import type { GatePayload } from "./gateMaterial.js";

/**
 * What the summary needs. Separate from JudgeDeps because the daemon has one
 * and not the other: `new RunService(mastra, undefined, …)` ships with no judge
 * configured, and the summary must work there — that is the only mode a human
 * ever sees a gate in.
 */
export interface GateSummaryDeps {
  /** LLM runner. Defaults to the canon's `runLlmStep`; tests inject a stub. */
  runner?: typeof runLlmStep;
  /** Registry for resolving the scout model. */
  registry: ModelRegistry;
  /** Provider profile, when the run does not name its own. */
  profile?: ProviderProfile;
  /** Working tree the run is against — read-only, for the status capture. */
  projectDir: string;
  /** Contents of prompts/gate-summary.md, read once at startup. */
  summaryPrompt: string;
}

/**
 * Hard cap on what reaches the gate box.
 *
 * The prompt asks for at most 80 words; this is what happens when it is not
 * obeyed. A summary long enough to scroll competes with the material it exists
 * to introduce, and the operator ends up reading neither.
 */
export const SUMMARY_CHAR_CAP = 700;

export type GateSummaryResult = { summary: string } | { error: string };

/**
 * Strip the wrappers a model adds to prose it was asked not to wrap.
 *
 * Fences and a leading "Summary:" are the two the prompt forbids and the two
 * that keep arriving. Removing them here is cheaper than a retry and cannot
 * make the text wrong — nothing about the sentence changes.
 */
function tidy(raw: string): string {
  return raw
    .replace(/^\s*```[a-z]*\s*\n?/iu, "")
    .replace(/\n?```\s*$/u, "")
    .replace(/^\s*(?:summary|tl;?dr)\s*[:—-]\s*/iu, "")
    .trim();
}

/**
 * What the box says when it had to drop part of the paragraph.
 *
 * A bare "…" claims a continuation the reader can go and find. There is none:
 * the rest of the summary is discarded here and persisted nowhere, so the note
 * says that instead. The material itself is untouched and still below.
 */
export const SUMMARY_SHORTENED_NOTE =
  "[Shortened to fit this box — the rest of the model's paragraph is not shown. The material below is complete.]";

/** Index just past the last sentence that ends at or before `end`, or -1. */
function lastSentenceEnd(text: string, end: number): number {
  let found = -1;
  for (const m of text.slice(0, end).matchAll(/[.!?]["'”’)\]]*(?=\s|$)/gu)) {
    found = m.index + m[0].length;
  }
  return found;
}

/**
 * Shorten an over-long summary at a boundary a reader recognises.
 *
 * Preference order: the last complete sentence, then the last word. Cutting
 * mid-word is what produced "including an unguarded caller-s…" on a screen
 * whose entire job is to tell a human what they are approving.
 */
function shorten(text: string): string {
  if (text.length <= SUMMARY_CHAR_CAP) return text;
  const sentence = lastSentenceEnd(text, SUMMARY_CHAR_CAP);
  let cut = sentence;
  if (cut <= 0) {
    // No sentence ended in time — fall back to the last whitespace, and only
    // if even that is missing (one unbroken token) cut at the cap.
    const space = text.slice(0, SUMMARY_CHAR_CAP).search(/\s+\S*$/u);
    cut = space > 0 ? space : SUMMARY_CHAR_CAP;
  }
  return `${text.slice(0, cut).trimEnd()}\n\n${SUMMARY_SHORTENED_NOTE}`;
}

/**
 * Describe what a suspended gate is asking about.
 *
 * Returns an `error` rather than throwing, for every failure: no model, a
 * transport error, an empty answer. A gate whose summary failed is a gate with
 * no summary — never a gate that cannot be approved (spec 043 D3, FR-003).
 *
 * @param deps Injected dependencies.
 * @param pipelineId The pipeline that suspended.
 * @param gateStepId The gate step's dotted id.
 * @param payload The suspend payload, if the gate carried one.
 * @param runProfile The profile the RUN was started under, which wins over the
 *   daemon's default: a run pinned to one provider must not have its gate
 *   described by another.
 */
export async function runGateSummary(
  deps: GateSummaryDeps,
  pipelineId: string,
  gateStepId: string,
  payload: GatePayload | undefined,
  runProfile?: ProviderProfile
): Promise<GateSummaryResult> {
  const profile = runProfile ?? deps.profile ?? getActiveProfile();
  const modelId = profile.roles.scout;
  if (modelId === undefined || modelId === "") {
    return { error: "No scout model in the active profile" };
  }

  let entry;
  try {
    entry = deps.registry.resolve(modelId);
  } catch (err: unknown) {
    return { error: `Cannot resolve scout model "${modelId}": ${String(err)}` };
  }

  // Read-only workspace access for a cli transport, so the model can open a
  // file the material only names. An api transport gets none, exactly as the
  // judge does.
  const runnerDeps: StepRunnerDeps =
    entry.transport === "api" ? {} : { contentsAccess: "read", workspaceDir: deps.projectDir };

  const prompt = [
    deps.summaryPrompt,
    "",
    buildGateMaterial(deps.projectDir, pipelineId, gateStepId, payload),
  ].join("\n");

  let raw: string;
  try {
    raw = await (deps.runner ?? runLlmStep)(entry, prompt, runnerDeps);
  } catch (err: unknown) {
    return {
      error: `Summary transport error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const text = tidy(String(raw ?? ""));
  if (text === "") return { error: "Summary was empty" };
  return { summary: shorten(text) };
}
