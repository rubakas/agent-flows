import { join, resolve, sep } from "node:path";

/** Returns true iff the resolved filePath is strictly inside dir. */
export function isContained(dir: string, filePath: string): boolean {
  const base = resolve(dir);
  const target = resolve(filePath);
  return target === base || target.startsWith(base + sep);
}

/**
 * Validates that entryPath cannot escape root when joined to it.
 *
 * Rejects paths that:
 * - are empty or contain null bytes
 * - start with "/" or "\" (absolute paths — path.join strips the leading slash,
 *   so "/etc/passwd" would otherwise appear to be inside root after joining)
 * - resolve to a location outside root after join+resolve (catches "../" traversal)
 */
export function assertSafePath(root: string, entryPath: string): void {
  if (!entryPath || entryPath.includes("\0")) {
    throw new Error(`Contains invalid path: ${JSON.stringify(entryPath)}`);
  }
  // Absolute paths must be rejected before calling path.join, because join()
  // strips the leading slash from non-first arguments, making "/etc/passwd"
  // appear to resolve inside root.
  if (entryPath.startsWith("/") || entryPath.startsWith("\\")) {
    throw new Error(`Path ${JSON.stringify(entryPath)} escapes the root directory — rejected`);
  }
  const resolved = resolve(join(root, entryPath));
  if (!isContained(root, resolved)) {
    throw new Error(`Path ${JSON.stringify(entryPath)} escapes the root directory — rejected`);
  }
}
