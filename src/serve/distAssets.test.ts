// Spec 038 FR-001: `pnpm build` copies the page assets tsc never emits into
// dist/serve/, byte for byte.
//
// tsconfig sets no allowJs, so ui.html and the hand-written browser modules
// are invisible to the compiler. server.ts reads the page as join(__dirname,
// "ui.html") and each module as a sibling of it, so a dist/ without them answers
// 503 on every page route. The copy must also be verbatim: the browser and the
// unit tests have to load identical bytes whichever tree they come from.

import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { PAGE_ASSETS, copyPageAssets } from "../../scripts/copy-dist-assets.mjs";
import { packageRoot } from "../packageRoot.js";

const ROOT = packageRoot();
const SRC_DIR = join(ROOT, "src", "serve");

// Run the real build step, but into a throwaway root: asserting a copy this
// file just made into the repository's own dist/ would both prove less and
// leave build output behind as a side effect of running the tests.
const TMP_ROOT = realpathSync(mkdtempSync(join(tmpdir(), "af-dist-assets-")));
cpSync(SRC_DIR, join(TMP_ROOT, "src", "serve"), { recursive: true });
const DIST_DIR = copyPageAssets(TMP_ROOT);

after(() => {
  rmSync(TMP_ROOT, { recursive: true, force: true });
});

describe("FR-001: the build copies every page asset into dist/serve", () => {
  for (const name of PAGE_ASSETS) {
    it(`dist/serve/${name} is byte-identical to src/serve/${name}`, () => {
      const source = readFileSync(join(SRC_DIR, name));
      const copied = readFileSync(join(DIST_DIR, name));
      assert.deepEqual(
        copied,
        source,
        `dist/serve/${name} must be a verbatim copy of src/serve/${name}`
      );
    });
  }

  it("copies the page and every module named in the server's static map", () => {
    const serverSource = readFileSync(join(SRC_DIR, "server.ts"), "utf8");
    const served = [...serverSource.matchAll(/\["\/(ui-[a-z]+\.js)", "(ui-[a-z]+\.js)"\]/gu)].map(
      (m) => m[2]
    );
    assert.ok(served.length > 0, "the STATIC_MODULES map must be readable from server.ts");
    for (const name of served) {
      assert.ok(
        PAGE_ASSETS.includes(name),
        `server.ts serves ${name}, so the build must copy it into dist/serve/`
      );
    }
  });
});
