// The review capture core inside the plugin (spec 047 FR-14). The plugin ships no
// node_modules and no copy of src/, so plugin/skills/review/scripts/lib/ holds
// src/runtime/reviewCapture.ts and its one dependency, transpiled. This file pins the
// committed copies to the generator, and the generator to the plugin's constraints:
// nothing to import but node:* and its own siblings, and no API newer than the Node
// the plugin promises.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// Plain .mjs outside tsconfig's program: loaded by a computed specifier, typed locally.
interface CaptureModule {
  source: string;
  out: string;
  rewrites: Record<string, string>;
}
interface Generator {
  OUT_DIR: string;
  MODULES: CaptureModule[];
  buildCapture: () => Record<string, string>;
  buildModule: (module: CaptureModule) => string;
}
const generator = (await import(
  pathToFileURL(join(root, "scripts", "build-af-review-capture.mjs")).href
)) as Generator;
const { OUT_DIR, MODULES, buildCapture, buildModule } = generator;

const committed = (name: string): string => readFileSync(join(OUT_DIR, name), "utf8");

describe("the plugin's copy of the capture core", () => {
  for (const { out, source } of MODULES) {
    it(`${out} is exactly what the generator makes of ${source}`, () => {
      assert.equal(
        committed(out),
        buildCapture()[out],
        `${out} is stale: run node scripts/build-af-review-capture.mjs`
      );
    });
  }

  it("holds no file the generator does not make", () => {
    assert.deepEqual(readdirSync(OUT_DIR).sort(), Object.keys(buildCapture()).sort());
  });

  it("is deterministic", () => {
    assert.deepEqual(buildCapture(), buildCapture());
  });

  for (const { out } of MODULES) {
    it(`${out} imports only node:* and its generated siblings`, () => {
      const siblings = new Set(MODULES.map((module) => `./${module.out}`));
      const specifiers = [...committed(out).matchAll(/(?:from|import)\s*["']([^"']+)["']/gu)].map(
        (match) => match[1]
      );
      for (const specifier of specifiers) {
        assert.ok(
          specifier.startsWith("node:") || siblings.has(specifier),
          `${out} imports ${specifier}, which the plugin cannot resolve`
        );
      }
    });

    it(`${out} parses as an ES module`, () => {
      const result = spawnSync(process.execPath, ["--check", join(OUT_DIR, out)], {
        encoding: "utf8",
      });
      assert.equal(result.status, 0, result.stderr);
    });

    it(`${out} uses no API the plugin's Node (18) lacks`, () => {
      const newer =
        /\.(?:toSorted|toReversed|toSpliced|findLastIndex|union|intersection|difference|isWellFormed)\(|\bObject\.groupBy\b|\bMap\.groupBy\b|\bPromise\.withResolvers\b|\bArray\.fromAsync\b/u;
      assert.doesNotMatch(committed(out), newer);
    });
  }

  it("loads on its own and exports what the capture script needs", async () => {
    const core = (await import(pathToFileURL(join(OUT_DIR, "reviewCapture.mjs")).href)) as Record<
      string,
      unknown
    >;
    for (const name of [
      "captureGit",
      "git",
      "GitTimeoutError",
      "rejectBaseline",
      "resolveCommit",
      "resolveSpecRefs",
      "renderMaterial",
      "digestBodies",
      "CAPTURE_DENY_PATTERNS",
    ]) {
      assert.ok(name in core, `${name} is not exported`);
    }
  });
});

describe("the generator", () => {
  const dirs: string[] = [];
  after(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  function moduleFrom(body: string, rewrites: Record<string, string> = {}): CaptureModule {
    const dir = mkdtempSync(join(tmpdir(), "af-capture-gen-"));
    dirs.push(dir);
    const source = join(dir, "probe.ts");
    writeFileSync(source, body);
    return { source, out: "probe.mjs", rewrites };
  }

  it("rewrites the one relative import it was told about", () => {
    const text = buildModule(
      moduleFrom('import { a } from "../canon/x.js";\nexport const b = a;\n', {
        "../canon/x.js": "./x.mjs",
      })
    );
    assert.match(text, /from "\.\/x\.mjs"/u);
    assert.doesNotMatch(text, /canon/u);
  });

  const refused: [string, string][] = [
    ["a package", 'import leftPad from "left-pad";\nexport const b = leftPad;\n'],
    [
      "a relative import it was not told about",
      'import { a } from "./other.js";\nexport const b = a;\n',
    ],
    ["a re-export", 'export { a } from "../elsewhere.js";\n'],
    ["a dynamic import", 'export const load = () => import("some-package");\n'],
    ["a computed dynamic import", "export const load = (n: string) => import(n);\n"],
    [
      "a require",
      'declare const require: (n: string) => unknown;\nexport const a = require("x");\n',
    ],
  ];
  for (const [name, body] of refused) {
    it(`refuses ${name}`, () => {
      assert.throws(() => buildModule(moduleFrom(body)));
    });
  }

  it("refuses a rewrite whose import is not in the source", () => {
    assert.throws(
      () => buildModule(moduleFrom("export const b = 1;\n", { "../canon/x.js": "./x.mjs" })),
      /exactly once/u
    );
  });

  it("accepts node: imports, type-only imports and nothing else", () => {
    const text = buildModule(
      moduleFrom(
        'import { spawnSync } from "node:child_process";\nimport type { SpawnSyncReturns } from "node:child_process";\nexport const run = spawnSync;\nexport type R = SpawnSyncReturns<string>;\n'
      )
    );
    assert.match(text, /from "node:child_process"/u);
    assert.doesNotMatch(text, /SpawnSyncReturns/u);
  });
});
