#!/usr/bin/env node
// Generates plugin/skills/review/scripts/lib/{credentialPatterns,reviewCapture}.mjs
// (spec 047 FR-14).
//
// The review capture is one module, src/runtime/reviewCapture.ts, run by the daemon
// and by the review plugin. The plugin ships with no node_modules and no copy of the
// rest of the repository, so it receives that module transpiled, one file per source
// file, with its single relative import pointed at the generated neighbour. Nothing is
// bundled and nothing is rewritten beyond that one specifier: what runs in the plugin is
// what the type checker saw, minus the types.
//
// The output is deterministic (TypeScript's emitter, LF newlines, no source maps). A
// test compares the committed files with buildCapture(), so editing a generated file by
// hand, or bumping typescript without regenerating, fails the build.
//
//   node scripts/build-af-review-capture.mjs

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
export const OUT_DIR = join(root, "plugin", "skills", "review", "scripts", "lib");

/**
 * The modules that travel into the plugin, in dependency order. `rewrites` lists the
 * exact import specifiers a module may contain besides `node:*`, each with what it
 * becomes. Anything else is an error: the plugin has no other module to import.
 */
export const MODULES = [
  { source: "src/canon/credentialPatterns.ts", out: "credentialPatterns.mjs", rewrites: {} },
  {
    source: "src/runtime/reviewCapture.ts",
    out: "reviewCapture.mjs",
    rewrites: { "../canon/credentialPatterns.js": "./credentialPatterns.mjs" },
  },
];

const COMPILER_OPTIONS = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  newLine: ts.NewLineKind.LineFeed,
  sourceMap: false,
  inlineSourceMap: false,
  declaration: false,
};

/** Every module specifier in transpiled ESM: static, re-export and dynamic imports. */
function specifiersIn(code) {
  const found = [];
  for (const match of code.matchAll(/\b(?:import|export)\b[^"'`;]*?\bfrom\s*["']([^"']+)["']/gu)) {
    found.push(match[1]);
  }
  for (const match of code.matchAll(/^\s*import\s*["']([^"']+)["']/gmu)) found.push(match[1]);
  for (const match of code.matchAll(/\bimport\s*\(\s*(["'`])([^"'`]+)\1/gu)) found.push(match[2]);
  for (const match of code.matchAll(/\brequire\s*\(\s*(["'`])([^"'`]+)\1/gu)) found.push(match[2]);
  if (/\bimport\s*\(\s*[^"'`\s]/u.test(code) || /\brequire\s*\(\s*[^"'`\s]/u.test(code)) {
    throw new Error("a computed import or require cannot be checked against the plugin's surface");
  }
  return found;
}

function header(source) {
  return (
    "// GENERATED FILE - DO NOT EDIT.\n" +
    `// Source: ${source} (transpiled by scripts/build-af-review-capture.mjs)\n` +
    "// Regenerate with: node scripts/build-af-review-capture.mjs\n"
  );
}

/** One module's generated text. Throws on any import the plugin could not satisfy. */
export function buildModule(module) {
  const input = readFileSync(resolve(root, module.source), "utf8");
  const output = ts.transpileModule(input, {
    compilerOptions: COMPILER_OPTIONS,
    fileName: module.source,
    reportDiagnostics: false,
  }).outputText;

  let code = output;
  for (const [from, to] of Object.entries(module.rewrites)) {
    const quoted = `"${from}"`;
    const count = code.split(quoted).length - 1;
    if (count !== 1) {
      throw new Error(
        `${module.source}: expected the import ${quoted} exactly once in the transpiled output, found ${String(count)}`
      );
    }
    code = code.replace(quoted, `"${to}"`);
  }

  const allowed = new Set(Object.values(module.rewrites));
  for (const specifier of specifiersIn(code)) {
    if (specifier.startsWith("node:") || allowed.has(specifier)) continue;
    throw new Error(
      `${module.source} imports ${JSON.stringify(specifier)}, which the plugin cannot resolve: ` +
        "the capture core may import only node:* and the generated modules"
    );
  }
  return header(module.source) + "\n" + code;
}

/** @returns {Record<string, string>} generated text by file name under OUT_DIR */
export function buildCapture() {
  return Object.fromEntries(MODULES.map((module) => [module.out, buildModule(module)]));
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  mkdirSync(OUT_DIR, { recursive: true });
  for (const [name, text] of Object.entries(buildCapture())) {
    writeFileSync(join(OUT_DIR, name), text);
    process.stdout.write(`wrote ${join(OUT_DIR, name)}\n`);
  }
}
