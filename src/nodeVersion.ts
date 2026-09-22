// The one place that says which Node this project runs on.
//
// `better-sqlite3` is compiled for a single Node ABI, so the version is not a
// floor: Node 20 and Node 24 both fail to load the addon this package installs,
// and they fail deep inside the first database call with an unreadable dlopen
// error. Stating it as ">=22" was the bug — it admits Node 24, which is
// installed on this machine and broken.
//
// `package.json` `engines.node` is the source, because it is the only file that
// is always present: `.nvmrc` is not in the published `files` list, so an
// installed package has none. `.nvmrc` mirrors this and a test holds the two
// together.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { packageRoot } from "./packageRoot.js";

/**
 * The single major version, parsed from an `engines.node` range.
 *
 * Accepts the pinned forms this project uses — "22.x", "22", "22.17.1" — and
 * refuses a range, because a range cannot answer "which Node" and reintroduces
 * exactly the ambiguity this module exists to remove.
 *
 * @param range The `engines.node` value.
 * @returns The major version it pins.
 */
export function parseNodeMajor(range: string): number {
  const match = /^(\d+)(?:\.(?:x|\d+(?:\.(?:x|\d+))?))?$/u.exec(String(range ?? "").trim());
  if (match === null) {
    throw new Error(
      `engines.node must pin one major version (e.g. "22.x"), not a range — got "${range}"`
    );
  }
  return Number(match[1]);
}

/** The Node major this installed package is built for. */
export function requiredNodeMajor(root: string = packageRoot()): number {
  const pkg: unknown = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const range = (pkg as { engines?: { node?: string } }).engines?.node;
  if (range === undefined) throw new Error(`package.json at ${root} declares no engines.node`);
  return parseNodeMajor(range);
}
