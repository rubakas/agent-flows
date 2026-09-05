// Safety guard for the eval runner: refuses pipelines that could write to the repo
// or execute arbitrary shell commands.
//
// Checks top-level steps AND loop bodies recursively, because bodies live in
// LoadedPipeline.bodies rather than in def.steps.

import type { LoadedPipeline } from "../canon/types.js";

/**
 * Throws if `loaded` or any of its loop bodies contains a step that declares
 * permissions.contents:write or kind:check. Checks bodies recursively (bodies can nest).
 *
 * Only llm steps with permissions.contents:read are safe for the eval runner.
 */
export function assertReadOnly(loaded: LoadedPipeline): void {
  for (const step of loaded.def.steps) {
    if (step.permissions?.contents === "write") {
      throw new Error(
        `SAFETY: step "${step.id}" declares permissions.contents:write — ` +
          `refusing to run (this pipeline may modify repo files)`
      );
    }
    if (step.kind === "check") {
      throw new Error(
        `SAFETY: step "${step.id}" has kind:check — ` +
          `refusing to run (check steps execute arbitrary shell commands)`
      );
    }
  }
  for (const body of Object.values(loaded.bodies ?? {})) {
    assertReadOnly(body);
  }
}
