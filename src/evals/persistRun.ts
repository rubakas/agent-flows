// Durable record of an eval run: every step's raw output, and the failure when
// there is one.
//
// The scorers reduce a run to a handful of numbers, and a wrong number cannot be
// diagnosed from the number. A run that failed is the case that needs the record
// most — the partial outputs and the error are the only evidence of where it
// stopped — so persistence is deliberately separate from scoring and runs on
// both paths.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** What is recorded about a run that threw or did not reach success. */
export interface PersistedError {
  name: string;
  message: string;
  stack?: string;
}

function describeError(error: unknown): PersistedError {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack };
  }
  if (typeof error === "string") return { name: "RunFailure", message: error };
  return { name: "non-error", message: JSON.stringify(error) };
}

/**
 * Write `result`'s step outputs into `runDir` — strings as `.md`, everything else
 * as pretty JSON — plus `error.json` when the run did not succeed.
 *
 * Partial results are expected, not exceptional: a run that failed at step three
 * still has two steps' worth of evidence, and dropping it because the run as a
 * whole failed is how a failure becomes undiagnosable.
 */
export function persistRun(
  runDir: string,
  result?: Record<string, unknown>,
  error?: unknown
): void {
  mkdirSync(runDir, { recursive: true });

  for (const [stepId, value] of Object.entries(result ?? {})) {
    if (typeof value === "string") {
      writeFileSync(join(runDir, `${stepId}.md`), value);
    } else {
      writeFileSync(join(runDir, `${stepId}.json`), `${JSON.stringify(value, null, 2)}\n`);
    }
  }

  if (error === undefined) return;
  writeFileSync(join(runDir, "error.json"), `${JSON.stringify(describeError(error), null, 2)}\n`);
}
