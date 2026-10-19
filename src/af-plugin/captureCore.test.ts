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
  builtins: string[];
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

// Node 18 lacks these (Node 20 adds the array copies and `with`, `isWellFormed`, the regex
// `v` flag and `URL.canParse`; 21 and 22 add the rest). A textual gate: the generated core
// is plain ES2022 and these are the library and syntax additions it could reach for.
const NEWER_THAN_NODE_18 = new RegExp(
  [
    String.raw`\.(?:toSorted|toReversed|toSpliced|with|findLastIndex|union|intersection|difference|isWellFormed)\(`,
    String.raw`\b(?:Object|Map)\.groupBy\b`,
    String.raw`\bPromise\.withResolvers\b`,
    String.raw`\bArray\.fromAsync\b`,
    String.raw`\bAbortSignal\.any\b`,
    String.raw`\bURL\.canParse\b`,
    // a regular expression literal, or a RegExp call, carrying the `v` flag
    String.raw`(?:^|[=(,:;!&|?{}\[]\s*)\/(?:[^/\\\n]|\\.)+\/[dgimsuy]*v[dgimsuy]*(?![\w$])`,
    String.raw`RegExp\([^)]*,\s*["'\x60][a-z]*v[a-z]*["'\x60]\s*\)`,
  ].join("|"),
  "mu"
);

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

  it("still kills a timed-out git with SIGKILL and pins GIT_OPTIONAL_LOCKS=0 in its git environment", () => {
    const core = committed("reviewCapture.mjs");
    // One for git, one for gh.
    assert.equal(core.match(/killSignal: "SIGKILL"/gu)?.length, 2);
    assert.match(core, /GIT_OPTIONAL_LOCKS: "0"/u);
  });

  it("holds no file the generator does not make", () => {
    assert.deepEqual(readdirSync(OUT_DIR).sort(), Object.keys(buildCapture()).sort());
  });

  it("is deterministic", () => {
    assert.deepEqual(buildCapture(), buildCapture());
  });

  for (const { out, builtins } of MODULES) {
    it(`${out} imports only the node: builtins it names and its generated siblings`, () => {
      const siblings = new Set(MODULES.map((module) => `./${module.out}`));
      const specifiers = [...committed(out).matchAll(/(?:from|import)\s*["']([^"']+)["']/gu)].map(
        (match) => match[1]
      );
      for (const specifier of specifiers) {
        assert.ok(
          builtins.includes(specifier) || siblings.has(specifier),
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
      assert.doesNotMatch(committed(out), NEWER_THAN_NODE_18, out);
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

  function moduleFrom(
    body: string,
    rewrites: Record<string, string> = {},
    builtins: string[] = []
  ): CaptureModule {
    const dir = mkdtempSync(join(tmpdir(), "af-capture-gen-"));
    dirs.push(dir);
    const source = join(dir, "probe.ts");
    writeFileSync(source, body);
    return { source, out: "probe.mjs", rewrites, builtins };
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
    [
      "a builtin it did not name (node:sqlite)",
      'import { DatabaseSync } from "node:sqlite";\nexport const b = DatabaseSync;\n',
    ],
    [
      "a builtin it did not name (node:fs)",
      'import { readFileSync } from "node:fs";\nexport const b = readFileSync;\n',
    ],
    [
      "a dynamic import of a builtin it did not name",
      'export const load = () => import("node:net");\n',
    ],
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

  it("accepts the builtins it names, type-only imports and nothing else", () => {
    const text = buildModule(
      moduleFrom(
        'import { spawnSync } from "node:child_process";\nimport type { SpawnSyncReturns } from "node:child_process";\nexport const run = spawnSync;\nexport type R = SpawnSyncReturns<string>;\n',
        {},
        ["node:child_process"]
      )
    );
    assert.match(text, /from "node:child_process"/u);
    assert.doesNotMatch(text, /SpawnSyncReturns/u);
  });
});

describe("the capture script", () => {
  const script = readFileSync(
    join(root, "plugin", "skills", "review", "scripts", "capture.mjs"),
    "utf8"
  );

  it("takes its git, its deny list and its rendering from the generated core", () => {
    assert.match(script, /from "\.\/lib\/reviewCapture\.mjs"/u);
    // Each of these is an argv, a pattern or a spawn the core owns. A copy of any of
    // them here is a second implementation that nothing keeps level with the first.
    for (const own of [
      /\bspawnSync\b/u,
      /--no-ext-diff/u,
      /--name-status/u,
      /\bRE_REVISION\b/u,
      /log\.showSignature/u,
      /"\*\*\/\.env"/u,
      /\bescapeControl\b/u,
      /refused — only an https/u,
    ]) {
      assert.doesNotMatch(script, own, `capture.mjs still carries its own ${String(own)}`);
    }
  });

  it("ships as a plugin version that a cache holding the script without lib/ cannot be", () => {
    const manifest = JSON.parse(
      readFileSync(join(root, "plugin", ".claude-plugin", "plugin.json"), "utf8")
    ) as { version: string };
    const [major, minor] = manifest.version.split(".").map(Number);
    // 0.1.0 shipped a self-contained capture.mjs. Caches are keyed by version, so the
    // first version that needs ./lib/ must be a different one.
    assert.ok(major > 0 || minor >= 2, `plugin version ${manifest.version} was already published`);
  });
});

describe("the Node 18 denylist", () => {
  const cases: [string, string][] = [
    ["Array.prototype.with", "const a = list.with(0, 1);"],
    ["toSorted", "const a = list.toSorted();"],
    ["AbortSignal.any", "const s = AbortSignal.any([a, b]);"],
    ["URL.canParse", "const ok = URL.canParse(value);"],
    ["a regex literal with the v flag", "const re = /[\\p{L}--[a-z]]/v;"],
    ["a RegExp call with the v flag", 'const re = new RegExp("[a-z]", "v");'],
    ["Object.groupBy", "const g = Object.groupBy(items, key);"],
  ];
  for (const [name, code] of cases) {
    it(`flags ${name}`, () => {
      assert.match(code, NEWER_THAN_NODE_18);
    });
  }

  it("leaves what the core really uses alone", () => {
    for (const code of [
      "const re = /^[0-9a-f]{40}$/u;",
      "const re = /[\\x00-\\x08]/gu;",
      "const parts = text.split('/'); const url = 'https://github.com/o/r';",
      "const s = new Set(list); const t = [...s].sort();",
      "return text.replace(RE, (c) => c);",
    ]) {
      assert.doesNotMatch(code, NEWER_THAN_NODE_18, code);
    }
  });
});
