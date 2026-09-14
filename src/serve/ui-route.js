// Hash router for the served page (spec 034 D1/D7).
//
// Plain ESM with no dependencies and no DOM access, served by the daemon at
// /ui-route.js and imported by ui.html. It lives in its own file precisely so
// the route table can be unit-tested without a browser (V2) — the page itself
// has no test harness beyond string assertions.

/** The view shown when the hash names no known route (FR-001). */
export const DEFAULT_VIEW = "runs";

/** Every top-level view the page can show. "run" is reached only via #/runs/<id>. */
export const VIEWS = ["runs", "run", "workflows", "templates", "settings"];

/**
 * Map a location hash onto a view.
 *
 * Returns `{ view }` for the four tab routes and `{ view: "run", runId }` for
 * `#/runs/<id>`. Anything unrecognised — empty, "#", a stale link, a route from
 * a future version — falls back to the default view rather than rendering a
 * blank page.
 *
 * @param {string} hash Raw `location.hash`, with or without the leading "#".
 * @returns {{ view: string, runId?: string }}
 */
export function parseHash(hash) {
  const raw = String(hash ?? "");
  const path = raw.replace(/^#/u, "").replace(/^\//u, "");
  const [head, ...rest] = path.split("/");

  if (head === "runs") {
    // A run id is URL-encoded in the hash; decoding can throw on a malformed
    // escape, which must fall back to the list rather than break the router.
    const tail = rest.join("/");
    if (tail === "") return { view: "runs" };
    try {
      return { view: "run", runId: decodeURIComponent(tail) };
    } catch {
      return { view: "runs" };
    }
  }
  // A tab route with anything trailing is not one of the five valid routes;
  // "#/settings/extra" is a stale or hand-edited link, not the settings view.
  if (rest.length === 0 && (head === "workflows" || head === "templates" || head === "settings")) {
    return { view: head };
  }
  return { view: DEFAULT_VIEW };
}

/**
 * Which background pollers a view is allowed to run (spec 037 D9/FR-010).
 *
 * The runs list is the only screen a poll can change, so every other view
 * leaves the page idle — a browser extension has to be able to capture
 * #/workflows, and a 4 s interval that never stops makes it never idle.
 *
 * @param {string} view A view name from parseHash.
 * @returns {string[]}
 */
export function pollersFor(view) {
  return view === "runs" ? ["runs"] : [];
}

/** The hash a view (and optional run id) is reached by. Inverse of parseHash. */
export function hashFor(view, runId) {
  if (view === "run" && runId !== undefined) return `#/runs/${encodeURIComponent(runId)}`;
  if (view === "run") return "#/runs";
  return `#/${view}`;
}
