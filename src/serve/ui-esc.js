// The page's single escape rule.
//
// Every module that emits markup imports `esc` from here, so there is one place
// to be right about escaping rather than six copies that can drift apart. Plain
// ESM with no dependencies and no DOM access, served by the daemon at
// /ui-esc.js and imported by ui.html and by every ui-*.js helper.

/**
 * Escape HTML entities. All untrusted data reaching the DOM goes through this
 * or is written via textContent.
 *
 * @param {unknown} s
 * @returns {string}
 */
export function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
