// Types for ui-markdown.js. The module ships as plain ESM so the browser can
// load it unbuilt from /ui-markdown.js; this declaration lets the unit test
// import it without turning on allowJs for the whole project.

/** Render a markdown subset as HTML built only from this module's own tags. */
export declare function renderMarkdown(text: string): string;
/** Whether text is worth rendering as markdown rather than as plain output. */
export declare function looksLikeMarkdown(text: string): boolean;
