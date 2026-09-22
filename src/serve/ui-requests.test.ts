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
// not go through a routing helper.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { packageRoot } from "../packageRoot.js";

const UI = readFileSync(join(packageRoot(), "src", "serve", "ui.html"), "utf8");
const LINES = UI.split("\n");

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

/** Whether a routing helper appears close enough to own this line's path. */
function routed(index: number): boolean {
  const window = LINES.slice(Math.max(0, index - 3), index + 1).join("\n");
  return ROUTERS.some((r) => window.includes(r));
}

describe("every /api/ request names its project (spec 042 D13)", () => {
  it("routes every path literal through a project-routing helper", () => {
    const unrouted: string[] = [];
    LINES.forEach((line, i) => {
      if (!/["'`]\/api\//u.test(line)) return;
      if (EXEMPT.some((e) => line.includes(e.match))) return;
      if (!routed(i)) unrouted.push(`ui.html:${i + 1}: ${line.trim()}`);
    });
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
    LINES.forEach((line, i) => {
      if (!/\b(fetch|new EventSource)\(/u.test(line)) return;
      if (line.includes("fetch(url, opts)")) return;
      const window = LINES.slice(i, i + 4).join("\n");
      if (!ROUTERS.some((r) => window.includes(r))) bare.push(`ui.html:${i + 1}: ${line.trim()}`);
    });
    assert.deepEqual(bare, [], `unrouted request:\n${bare.join("\n")}`);
  });
});
