// Types for ui-route.js. The router ships as plain ESM so the browser can load
// it unbuilt from /ui-route.js; this declaration lets the unit test import it
// without turning on allowJs for the whole project.

export declare const DEFAULT_VIEW: string;
export declare const VIEWS: string[];
export declare function parseHash(hash: string): { view: string; runId?: string };
export declare function hashFor(view: string, runId?: string): string;
export declare function pollersFor(view: string): string[];
