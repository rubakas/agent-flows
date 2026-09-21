// Types for ui-graph.js. The diagram ships as plain ESM so the browser can load
// it unbuilt from /ui-graph.js; this declaration lets the unit test import it
// without turning on allowJs for the whole project.

export interface GraphStepDef {
  id: string;
  kind?: string;
  role?: string;
  pipeline?: string;
}

export declare const BOX_W: number;
export declare const BOX_H: number;
export declare const COL_GAP: number;
export declare const ROW_GAP: number;

/** The right-angle path one edge takes between two boxes (spec 042 D16). */
export declare function edgePath(
  from: { x: number; y: number },
  to: { x: number; y: number },
  lane?: number
): string;

export declare function renderLevelsSvg(
  levels: readonly (readonly string[])[],
  graph: { nodes?: { id: string }[]; edges?: { from: string; to: string }[] } | null | undefined,
  opts?: { steps?: readonly GraphStepDef[] }
): string;
