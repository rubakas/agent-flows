// Types for ui-esc.js. The module ships as plain ESM so the browser can load it
// unbuilt from /ui-esc.js; this declaration lets the unit tests import it
// without turning on allowJs for the whole project.

/** Escape HTML entities — the page's single escape rule. */
export declare function esc(s: unknown): string;
