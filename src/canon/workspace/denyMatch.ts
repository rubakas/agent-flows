import { matchesGlob } from "node:path";

/**
 * Case-insensitive glob match of a repo-relative path against a deny list.
 *
 * `path.matchesGlob` is used rather than a hand-rolled converter: probed on
 * Node 22.17.1 under `node --test`, it emits no experimental warning and
 * already implements every shape present in `CREDENTIAL_DENY_PATTERNS` and
 * `BUILD_CONFIG_DENY_PATTERNS` (`**` spanning zero directories, `*`, `?`).
 * It is case-sensitive, so both sides are lowercased — the deny arrays carry
 * case-varied duplicates for APFS, and lowercasing subsumes them.
 */
export function matchesDenyPattern(relPath: string, patterns: readonly string[]): boolean {
  const target = normalize(relPath);
  if (target === "") return false;
  return patterns.some((pattern) => matchesGlob(target, pattern.toLowerCase()));
}

function normalize(relPath: string): string {
  return relPath.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "").toLowerCase();
}
