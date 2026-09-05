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
        "workspace:write is not yet wired into runStep — nested write-access steps are blocked",
      // The investigation must call out the workspace:write gap explicitly.
      keywords: ["workspace", "write"],
    },
  ],

  // All paths here must exist on disk today.  The test suite asserts this.
  expectedPaths: ["src/canon/nest.ts", "src/canon/types.ts"],
};

export default fixture;
