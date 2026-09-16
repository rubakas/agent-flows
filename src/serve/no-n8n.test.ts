// Spec 037 V1 / FR-001 — the n8n retirement gate (ADR-0017).
//
// n8n was removed from the tool on 2026-09-14. This test is what keeps it
// removed: any reintroduced identifier in the shipped roots fails the suite.
// `docs/` and `specs/` are deliberately outside the roots — the ADR, the
// withdrawn spec 035, spec 027 and the research notes keep the history.
//
// This file is the one src file the scan skips: it has to name what it forbids.

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { packageRoot } from "../packageRoot.js";

const REPO_ROOT = packageRoot();
// This file names the retired identifier itself and is excluded from its own scan.
const SELF = fileURLToPath(import.meta.url);

/** Exactly the roots named by spec 037 V1. */
const ROOTS = ["src", "scripts", "package.json", "README.md", ".gitignore"];

/** The directory whose absence is itself part of the gate (the node package). */
const FORBIDDEN_DIR = "integrations";

const RETIRED = /n8n/iu;

function filesUnder(abs: string): string[] {
  const st = statSync(abs, { throwIfNoEntry: false });
  if (st === undefined) return [];
  if (st.isFile()) return abs === SELF ? [] : [abs];
  if (!st.isDirectory()) return [];
  return readdirSync(abs)
    .filter((entry) => entry !== "node_modules")
    .flatMap((entry) => filesUnder(join(abs, entry)));
}

describe("no n8n identifier survives in the shipped roots (spec 037 FR-001/V1)", () => {
  it("no line under src, scripts, package.json, README.md or .gitignore matches /n8n/i", () => {
    const hits: string[] = [];
    for (const root of ROOTS) {
      for (const file of filesUnder(join(REPO_ROOT, root))) {
        readFileSync(file, "utf8")
          .split("\n")
          .forEach((line, i) => {
            if (RETIRED.test(line))
              hits.push(`${relative(REPO_ROOT, file)}:${i + 1}: ${line.trim()}`);
          });
      }
    }
    assert.deepEqual(
      hits,
      [],
      `the hybrid was retired by ADR-0017; these lines bring it back:\n${hits.join("\n")}`
    );
  });

  it("the integrations/ directory (the retired community node package) does not exist", () => {
    assert.equal(
      statSync(join(REPO_ROOT, FORBIDDEN_DIR), { throwIfNoEntry: false }),
      undefined,
      `${FORBIDDEN_DIR}/ held the retired community node and must stay deleted (ADR-0017)`
    );
  });
});
