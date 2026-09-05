/**
 * Fixture: feature request that collides with something already built.
 *
 * Request: "Add nested pipeline support — let one pipeline call another as a step."
 *
 * This collides with `expandNested` in src/canon/nest.ts, which already splices
 * `kind:"pipeline"` steps at load time, and with `StepKind` in src/canon/types.ts
 * which already includes "pipeline".  A correct investigation must surface both
 * and cite the real files rather than proposing to build the feature fresh.
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
  seedPrompt:
    "Add nested pipeline support — let one pipeline call another as a step so we can compose workflows.",

  expectedExisting: [
    {
      phrase: "expandNested in src/canon/nest.ts already handles pipeline nesting at load time",
      // A correct survey must name the function AND the file; naming just one is insufficient.
      keywords: ["expandNested", "nest"],
    },
    {
      phrase: 'StepKind includes "pipeline" in src/canon/types.ts',
      // Both the type union member and the source file must be cited.
      keywords: ["pipeline", "types"],
    },
  ],

  expectedGaps: [
    {
      phrase:
        "Binding A (claudeCode.ts) does not execute loop steps — generateWorkflowScript emits a stub comment instead of running the body",
      // The investigation must cite Binding A (claudeCode.ts) AND the loop step gap.
      // These keywords require the specific claim, not just two common words.
      keywords: ["Binding A", "loop"],
    },
  ],

  // All paths here must exist on disk today.  The test suite asserts this.
  expectedPaths: ["src/canon/nest.ts", "src/canon/types.ts"],
};

export default fixture;
