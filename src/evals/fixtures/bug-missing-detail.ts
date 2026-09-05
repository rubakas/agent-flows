/**
 * Fixture: bug report with deliberately omitted details.
 *
 * Request: "Bug: the loop in my pipeline never terminates."
 *
 * This request is intentionally vague — no pipeline name, no `until` condition,
 * no `maxIterations` value, no reproduction steps.  A correct investigation must:
 * 1. Find the existing loop implementation (src/canon/types.ts, src/bindings/mastra/build.ts).
 * 2. Surface the missing details as open questions / gaps before any fix attempt.
 *
 * The gaps are objectively checkable: they are structural absences in the request,
 * not subjective quality judgements.
 */

import type { KeyedItem } from "../scorers.js";

export interface EvalFixture {
  seedPrompt: string;
  expectedExisting: KeyedItem[];
  expectedGaps: KeyedItem[];
  /** Every path listed here must exist in the repo (anti-rot assertion). */
  expectedPaths: string[];
}

const fixture: EvalFixture = {
  seedPrompt: "Bug: the loop in my pipeline never terminates.",

  expectedExisting: [
    {
      phrase: "loop step kind with maxIterations and until fields defined in src/canon/types.ts",
      // Both the field name and file must appear so the scorer confirms the model
      // found the real definition rather than guessing.
      keywords: ["maxIterations", "until"],
    },
    {
      phrase: "buildLoopStep compiled to Mastra dountil in src/bindings/mastra/build.ts",
      // dountil is the Mastra primitive the loop compiles to — a correct survey names it.
      keywords: ["dountil", "build"],
    },
  ],

  expectedGaps: [
    {
      phrase: "no pipeline name given — cannot locate the offending loop step",
      // A correct findings brief must ask WHICH pipeline; "pipeline" alone is not enough.
      keywords: ["pipeline", "which"],
    },
    {
      phrase: "until condition not specified — unclear what termination signal is expected",
      keywords: ["until"],
    },
    {
      phrase: "maxIterations budget not stated — exhaustion vs. non-termination are different bugs",
      keywords: ["maxIterations"],
    },
  ],

  // All paths here must exist on disk today.  The test suite asserts this.
  expectedPaths: ["src/canon/types.ts", "src/bindings/mastra/build.ts"],
};

export default fixture;
