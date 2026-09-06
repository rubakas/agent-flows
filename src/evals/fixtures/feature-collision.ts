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

  // Deliberately empty. This fixture tests ONE thing: does the investigation
  // notice that the requested feature already exists? It does — twice, at 100%.
  // Two attempts to plant a gap here failed, and both failed the same way: the
  // gap did not follow from the request, so a correct investigation had no
  // reason to report it and the eval measured the fixture instead of the system.
  // A request whose right answer is "this is already built" has no natural gap.
  // Gap detection is exercised by the bug-missing-detail fixture, where the
  // omissions are genuinely in the prompt.
  expectedGaps: [],

  // All paths here must exist on disk today.  The test suite asserts this.
  expectedPaths: ["src/canon/nest.ts", "src/canon/types.ts"],
};

export default fixture;
