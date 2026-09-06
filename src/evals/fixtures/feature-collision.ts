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

  // A planted gap must FOLLOW from the seed prompt. An earlier version of this
  // fixture asked the investigation to report that Binding A does not execute
  // loop steps — true, but unrelated to a request about nesting, so a correct
  // investigation had no reason to find it and the eval failed on the fixture's
  // fault rather than the workflow's.
  expectedGaps: [
    {
      phrase:
        "the standard workflow library is incomplete — ADR-0015 specifies verify-plan and correct-plan, neither of which exists in pipelines/",
      // Composing workflows means knowing which ones exist. Both names are
      // required: either alone could appear in unrelated prose.
      keywords: ["verify-plan", "correct-plan"],
    },
  ],

  // All paths here must exist on disk today.  The test suite asserts this.
  expectedPaths: ["src/canon/nest.ts", "src/canon/types.ts"],
};

export default fixture;
