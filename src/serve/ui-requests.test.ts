// Spec 042 D13 — every request the page makes must carry the project it is for.
//
// One page now reads many projects: a request for this daemon's own project goes
// straight out, and a request for another project is forwarded through
// `/api/projects/<key>/…`. The helpers `api`, `apiLocal`, `apiFor`, `apiPath`
// and `pathFor` are the only things that know which of those a call is.
//
// A `fetch` that skips them silently works — against the WRONG project. It hits
// this daemon, which has no such run, and answers 404. That is what happened to
// the step-output fetch: it was written before D13 and kept working for local
// runs, so nothing failed until a run belonging to another project was opened.
// This gate reads the shipped page as text and fails on any request that does
// not go through a routing helper. The run session (ui-runview.js) makes the
// page's run requests, so it is read the same way.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { packageRoot } from "../packageRoot.js";

/** The files that make requests, as [name, lines]. */
const SOURCES: readonly (readonly [string, string[]])[] = ["ui.html", "ui-runview.js"].map(
  (name) =>
    [name, readFileSync(join(packageRoot(), "src", "serve", name), "utf8").split("\n")] as const
);

/** The helpers that decide which project a path is addressed to. */
const ROUTERS = ["api(", "apiLocal(", "apiFor(", "apiPath(", "pathFor("];

/**
 * Lines whose `/api/` literal is deliberately unrouted, with the reason. Adding
 * to this list is a decision; forgetting a helper is not.
 */
const EXEMPT: readonly { match: string; why: string }[] = [
  { match: "return !key ? path :", why: "pathFor's own definition — it builds the prefix" },
  { match: "window.location.href = `/api/export/", why: "a download of this project's own bundle" },
  { match: 'const path = kind === "skills"', why: "a path fragment, routed by the caller" },
];

/**
 * Lines that hand the browser's own transport to the run session. They carry no
 * path: the session builds every URL itself, through pathFor.
 */
const TRANSPORT: readonly { match: string; why: string }[] = [
  {
    match: "window.fetch(u, i)",
    why: "wires the browser's fetch into the session, which routes the URL",
  },
  {
    match: "new EventSource(u)",
    why: "wires the browser's EventSource into the session, which routes the URL",
  },
];

/** Whether a routing helper appears close enough to own this line's path. */
function routed(lines: string[], index: number): boolean {
  const window = lines.slice(Math.max(0, index - 3), index + 1).join("\n");
  return ROUTERS.some((r) => window.includes(r));
}

describe("every /api/ request names its project (spec 042 D13)", () => {
  it("routes every path literal through a project-routing helper", () => {
    const unrouted: string[] = [];
    for (const [name, lines] of SOURCES) {
      lines.forEach((line, i) => {
        if (!/["'`]\/api\//u.test(line)) return;
        if (EXEMPT.some((e) => line.includes(e.match))) return;
        if (!routed(lines, i)) unrouted.push(`${name}:${i + 1}: ${line.trim()}`);
      });
    }
    assert.deepEqual(
      unrouted,
      [],
      `these reach this daemon whatever project the page is showing:\n${unrouted.join("\n")}`
    );
  });

  it("makes no bare fetch or EventSource", () => {
    // `request()` is the one place a fully-built url is passed to fetch; every
    // other call site must show a helper within three lines of the opening.
    const bare: string[] = [];
    for (const [name, lines] of SOURCES) {
      lines.forEach((line, i) => {
        if (!/\b(fetch|new EventSource)\(/u.test(line)) return;
        if (line.includes("fetch(url, opts)")) return;
        if (TRANSPORT.some((t) => line.includes(t.match))) return;
        const window = lines.slice(i, i + 4).join("\n");
        if (!ROUTERS.some((r) => window.includes(r))) bare.push(`${name}:${i + 1}: ${line.trim()}`);
      });
    }
    assert.deepEqual(bare, [], `unrouted request:\n${bare.join("\n")}`);
  });
});
