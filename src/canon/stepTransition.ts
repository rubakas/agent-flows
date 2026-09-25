// The one translation from Mastra's workflow stream to this project's step
// lifecycle vocabulary.
//
// Leaf module by construction, like stepLogEvents: it imports nothing, so the
// run service can call it from both of its watch callbacks. It exists because
// the translation used to be written out twice — once in the record-level watch
// and once per SSE subscriber — and two copies of a mapping table are two
// answers to the same question as soon as one of them is edited.

/** What a step just did, as far as the workflow stream can say. */
export type StepTransition = "step-start" | "step-finish" | "step-suspended" | "step-failed";

/** Thrown when a step result carries a status this translation has no entry for. */
export class UnknownStepStatusError extends Error {
  constructor(readonly status: unknown) {
    super(
      `agent-flows: workflow-step-result carried status ${JSON.stringify(status)}, ` +
        `which no step transition maps. A run advanced without being reported.`
    );
    this.name = "UnknownStepStatusError";
  }
}

/** The stream fields this translation reads. Structural, so no Mastra type is imported. */
export interface StepStreamEvent {
  type: string;
  status?: unknown;
}

/**
 * The transition an event describes, or undefined when it is not about a step
 * at all (workflow start, finish, and everything else on the same stream).
 *
 * Throws for a step result whose status is unrecognised rather than returning
 * undefined: a silent fallthrough is how a renamed Mastra status would turn
 * into steps that never appear to finish, and that failure has cost this
 * project before. Callers on the run path catch it and report it; a caller that
 * wants the mapping itself — a test — sees the throw.
 */
export function stepTransitionOf(event: StepStreamEvent): StepTransition | undefined {
  if (event.type === "workflow-step-start") return "step-start";
  if (event.type === "workflow-step-suspended") return "step-suspended";
  if (event.type !== "workflow-step-result") return undefined;

  switch (event.status) {
    // "skipped" is a finish: the step will never run, so anything waiting for it
    // to end must be released now.
    case "success":
    case "skipped":
      return "step-finish";
    case "suspended":
      return "step-suspended";
    case "failed":
      return "step-failed";
    default:
      throw new UnknownStepStatusError(event.status);
  }
}
