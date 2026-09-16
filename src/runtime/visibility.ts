// Per-project workflow visibility (spec 038 D15, FR-024–FR-026).
//
// One file, `<stateDir>/visibility.json`, holding `{"hidden": ["<id>", ...]}`.
// Absent means nothing is hidden. An id that no longer exists in the merged view
// is ignored rather than an error, because a workflow disappears whenever a
// layer changes underneath the file.
//
// Hiding is decluttering the chat surface, not access control — no code path may
// later treat a hidden id as refused, only as unlisted. It filters exactly two
// surfaces (the MCP `list_pipelines` tool and the page's workflow list); a
// hidden workflow still runs when named explicitly by id, and a hidden workflow
// mounted as a nested `pipeline`/`loop` step by an enabled parent still
// executes.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** `<stateDir>/visibility.json` — the file this module owns. */
export function visibilityPath(stateDir: string): string {
  return join(stateDir, "visibility.json");
}

/**
 * The hidden ids recorded for a project.
 *
 * A missing file means nothing is hidden. A malformed or wrongly-typed file is
 * also read as "nothing is hidden": visibility is a listing preference, and
 * failing a listing over an unparseable preference file would be a worse
 * outcome than showing one workflow too many.
 */
export function readHidden(stateDir: string): Set<string> {
  const path = visibilityPath(stateDir);
  if (!existsSync(path)) return new Set();
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return new Set();
  }
  const hidden = (parsed as { hidden?: unknown } | null)?.hidden;
  if (!Array.isArray(hidden)) return new Set();
  return new Set(hidden.filter((id): id is string => typeof id === "string" && id !== ""));
}

/**
 * Record `id` as hidden or visible, creating the file on first write (0600).
 *
 * Returns the sorted hidden list as it now stands. The state directory is
 * created when absent so `disable` works before the daemon has ever run in this
 * project.
 */
export function setHidden(stateDir: string, id: string, hidden: boolean): string[] {
  const current = readHidden(stateDir);
  if (hidden) current.add(id);
  else current.delete(id);
  const list = [...current].sort();
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  writeFileSync(visibilityPath(stateDir), `${JSON.stringify({ hidden: list }, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return list;
}

/** Drop every row whose id is hidden. The only filtering this module performs. */
export function filterVisible<T>(
  rows: readonly T[],
  hidden: ReadonlySet<string>,
  idOf: (row: T) => string
): T[] {
  return rows.filter((row) => !hidden.has(idOf(row)));
}
