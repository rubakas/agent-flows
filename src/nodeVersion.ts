// The one place that says which Node this project runs on.
//
// `better-sqlite3` is compiled for a single Node ABI, so the major is a pin and
// not a floor: Node 20 and Node 24 both fail to load the addon this package
// installs, and they fail deep inside the first database call with an
// unreadable dlopen error. Stating it as ">=22" was the bug — it admits Node 24,
// which is installed on this machine and broken.
//
// Inside that one major there is also a floor, a security one (spec 048): a
// release line keeps shipping fixes, and the ABI does not change between them,
// so "any 22.x" admitted releases with known High CVEs. The requirement is one
// major AND a minimum (minor, patch) inside it, written `^MAJOR.MINOR.PATCH`.
//
// `package.json` `engines.node` is the source, because it is the only file that
// is always present: `.nvmrc` is not in the published `files` list, so an
// installed package has none. `.nvmrc` mirrors the floor and a test holds the
// two together.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { packageRoot } from "./packageRoot.js";

export interface NodePin {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  /** "MAJOR.MINOR.PATCH" — the oldest Node release accepted. */
  readonly floor: string;
}

/**
 * The pin parsed from an `engines.node` value.
 *
 * Accepts exactly `^MAJOR.MINOR.PATCH`, without leading zeros as npm does, and
 * refuses everything else — a bare major, a range, an alternation — because anything looser cannot answer
 * "which Node" and reintroduces the ambiguity this module exists to remove.
 * `bin/agent-flows` carries the same expression and the same error text.
 *
 * @param range The `engines.node` value.
 */
export function parseNodePin(range: string): NodePin {
  const match = /^\^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.exec(String(range ?? ""));
  if (match === null) {
    throw new Error(
      `engines.node must be "^MAJOR.MINOR.PATCH" — one major with a security floor inside it (e.g. "^22.23.4") — got "${range}"`
    );
  }
  const [major, minor, patch] = [Number(match[1]), Number(match[2]), Number(match[3])];
  return { major, minor, patch, floor: `${String(major)}.${String(minor)}.${String(patch)}` };
}

/** The Node requirement this installed package is built for. */
export function requiredNodePin(root: string = packageRoot()): NodePin {
  const pkg: unknown = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const range = (pkg as { engines?: { node?: string } }).engines?.node;
  if (range === undefined) throw new Error(`package.json at ${root} declares no engines.node`);
  return parseNodePin(range);
}

/**
 * Whether a Node version is the pinned major and at or above the floor.
 *
 * Only a plain release satisfies: anything after the patch number — "-rc.1", a
 * nightly tag — does not, because a pre-release of the floor release is not the
 * release that carries the fix.
 *
 * @param version A version such as "22.23.4" or "v22.23.4".
 */
export function nodeSatisfies(version: string, pin: NodePin): boolean {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/u.exec(String(version ?? ""));
  if (match === null) return false;
  const [major, minor, patch] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (major !== pin.major) return false;
  return minor > pin.minor || (minor === pin.minor && patch >= pin.patch);
}

/** "Node 22 at or above 22.23.4" — what a failing check says is required. */
export function nodeRequirement(pin: NodePin): string {
  return `Node ${String(pin.major)} at or above ${pin.floor}`;
}

/** The command that installs a Node of the pinned major. */
export function nodeInstallRemedy(pin: NodePin): string {
  return `nvm install ${String(pin.major)}`;
}

/**
 * What a refusing entry point prints when the running Node does not satisfy the pin.
 * `bin/agent-flows` carries a copy of this wording; it cannot import this module.
 */
export function nodeRefusal(running: string, pin: NodePin): string {
  return (
    `${nodeRequirement(pin)} is required (${pin.floor} is the security floor), but this is ${running}.\n` +
    `Install a safe one: ${nodeInstallRemedy(pin)} \u2014 then run the command again.`
  );
}
