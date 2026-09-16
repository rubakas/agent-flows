// Resolves the installed package's own root directory (spec 038 D5, FR-004).
//
// Every bundled asset — pipelines/ and prompts/ — lives next to package.json,
// one directory above src/ in a checkout and one above dist/ in an installed
// package. Fixed "../.." hops from a module's own location encode the wrong
// assumption under `pnpm link`, `npm i -g`, and the pnpm store layout, and they
// differ between a tsx run from src/ and a compiled run from dist/. Walking up
// to the nearest package.json is correct in all of those.
//
// This module deliberately imports nothing from our own tree so canon, the
// bindings, the installer, and the tests can all use it without a cycle.

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The nearest directory above `startDir` holding a package.json, asserted to
 * also hold both `pipelines/` and `prompts/`.
 *
 * The assertion is the point: a package.json appearing inside `dist/` some day
 * would otherwise resolve silently to a root one level too deep, and every
 * bundled pipeline would simply be missing. Failing loudly at startup names the
 * directory that was resolved and what it lacked.
 *
 * Exported for tests; production callers use `packageRoot()`.
 */
export function resolvePackageRootFrom(startDir: string): string {
  let dir = startDir;
  let found: string | undefined;
  for (;;) {
    if (existsSync(join(dir, "package.json"))) {
      found = dir;
      break;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  if (found === undefined) {
    throw new Error(
      `agent-flows: no package.json found above "${startDir}" — the package root cannot be resolved.`
    );
  }
  const root = found;
  const missing = ["pipelines", "prompts"].filter((name) => !isDir(join(root, name)));
  if (missing.length > 0) {
    throw new Error(
      `agent-flows: resolved package root "${root}" is missing ${missing.join(" and ")}/ — ` +
        `this is not an agent-flows package root.`
    );
  }
  return root;
}

let cached: string | undefined;

/** The root of this installed package: the directory holding package.json. */
export function packageRoot(): string {
  cached ??= resolvePackageRootFrom(dirname(fileURLToPath(import.meta.url)));
  return cached;
}

/** The bundled pipeline YAMLs shipped with the package. */
export function bundledPipelinesDir(): string {
  return join(packageRoot(), "pipelines");
}

let cachedVersion: string | undefined;

/**
 * The `version` field of the package's own package.json.
 *
 * The daemon identity handshake (spec 038 D8) compares this value, so it is read
 * from the resolved package root rather than from any caller-supplied path: two
 * processes must agree on what "this version" means or the handshake is
 * meaningless.
 */
export function packageVersion(): string {
  if (cachedVersion !== undefined) return cachedVersion;
  const manifestPath = join(packageRoot(), "package.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`agent-flows: cannot read the package version from ${manifestPath}: ${msg}`, {
      cause: err,
    });
  }
  const version = (parsed as { version?: unknown }).version;
  if (typeof version !== "string" || version === "") {
    throw new Error(`agent-flows: ${manifestPath} has no usable "version" field.`);
  }
  cachedVersion = version;
  return cachedVersion;
}
