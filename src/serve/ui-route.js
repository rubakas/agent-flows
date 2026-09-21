// Hash router for the served page (spec 034 D1/D7).
//
// Plain ESM with no dependencies and no DOM access, served by the daemon at
// /ui-route.js and imported by ui.html. It lives in its own file precisely so
// the route table can be unit-tested without a browser (V2) — the page itself
// has no test harness beyond string assertions.

/** The view shown when the hash names no known route (FR-001). */
export const DEFAULT_VIEW = "runs";

/**
 * Every view the page can show. "run", "workflow" and "workflow-edit" are
 * detail views, reached only through a route carrying an id.
 */
export const VIEWS = ["runs", "run", "workflows", "workflow", "workflow-edit", "settings"];

/**
 * Map a location hash onto a view.
 *
 * Returns `{ view }` for the three tab routes, `{ view: "run", runId }` for
 * `#/runs/<id>`, and `{ view, id }` for the workflow and workflow-edit detail
 * routes. Anything unrecognised — empty, "#", a stale link, a route from a
 * future version — falls back to the default view rather than rendering a
 * blank page.
 *
 * @param {string} hash Raw `location.hash`, with or without the leading "#".
 * @returns {{ view: string, runId?: string, id?: string }}
 */
export function parseHash(hash) {
  const raw = String(hash ?? "");
  const path = raw.replace(/^#/u, "").replace(/^\//u, "");
  const [head, ...rest] = path.split("/");

  // An id is URL-encoded in the hash; decoding can throw on a malformed escape,
  // which must fall back to a list rather than break the router.
  const decode = (segment) => {
    try {
      return decodeURIComponent(segment);
    } catch {
      return null;
    }
  };

  if (head === "runs") {
    const tail = rest.join("/");
    if (tail === "") return { view: "runs" };
    const runId = decode(tail);
    return runId === null ? { view: "runs" } : { view: "run", runId };
  }

  if (head === "workflows" && rest.length > 0 && rest[0] !== "") {
    // Only "edit" is a valid third segment; anything else is a stale or
    // hand-edited link (spec 037 D2/FR-006).
    if (rest.length > 2 || (rest.length === 2 && rest[1] !== "edit")) {
      return { view: DEFAULT_VIEW };
    }
    const id = decode(rest[0]);
    if (id === null) return { view: "workflows" };
    return { view: rest.length === 2 ? "workflow-edit" : "workflow", id };
  }

  // A tab route with anything trailing is not one of the valid routes;
  // "#/settings/extra" is a stale or hand-edited link, not the settings view.
  if (rest.length === 0 && (head === "workflows" || head === "settings")) {
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

/** The hash a view (and optional id) is reached by. Inverse of parseHash. */
export function hashFor(view, id) {
  if (view === "run") return id === undefined ? "#/runs" : `#/runs/${encodeURIComponent(id)}`;
  if (view === "workflow") {
    return id === undefined ? "#/workflows" : `#/workflows/${encodeURIComponent(id)}`;
  }
  if (view === "workflow-edit") {
    return id === undefined ? "#/workflows" : `#/workflows/${encodeURIComponent(id)}/edit`;
  }
  return `#/${view}`;
}
