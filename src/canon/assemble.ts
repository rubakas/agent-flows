import { ASSEMBLE_JS } from "./assembleSource.js";
import type { Finding, HardenedSpec } from "./types.js";

interface AssembleInput {
  request?: string;
  intake: string;
  enrich: string;
  critic: { weaknesses: Finding[] };
  security: { securityFindings: Finding[] };
}

// ASSEMBLE_JS is JS-compatible and runs identically in the TS runtime and
// in generated Claude Code workflow scripts (single source of truth).
// eslint-disable-next-line @typescript-eslint/no-implied-eval
const _assembleFunc = new Function("input", ASSEMBLE_JS) as (input: AssembleInput) => HardenedSpec;

export function assembleSpec(input: AssembleInput): HardenedSpec {
  return _assembleFunc(input);
}
