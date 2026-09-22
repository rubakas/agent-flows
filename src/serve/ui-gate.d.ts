// Types for ui-gate.js. The module ships as plain ESM so the browser can load it
// unbuilt from /ui-gate.js; this declaration lets the unit tests import it
// without turning on allowJs for the whole project.

export declare function structuralSummary(spec: unknown): string;
export declare function gateBox(gate: {
  gateMessage?: string;
  gateSummary?: string;
  spec?: unknown;
  gateStepId?: string;
}): string;
