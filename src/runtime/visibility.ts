// Per-project workflow visibility (spec 038 D15, FR-024–FR-026).
//
// Hiding is decluttering the chat surface, not access control — no code path may
// later treat a hidden id as refused, only as unlisted. It filters exactly two
// surfaces (the MCP `list_pipelines` tool and the page's workflow list); a
// hidden workflow still runs when named explicitly by id, and a hidden workflow
// mounted as a nested `pipeline`/`loop` step by an enabled parent still
// executes.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { writeStateFile } from "./stateFile.js";

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
 * Record `id` as hidden or visible, returning the sorted hidden list as it now
 * stands.
 */
export function setHidden(stateDir: string, id: string, hidden: boolean): string[] {
  const current = readHidden(stateDir);
  if (hidden) current.add(id);
  else current.delete(id);
  const list = [...current].sort();
  writeStateFile(
    stateDir,
    visibilityPath(stateDir),
    `${JSON.stringify({ hidden: list }, null, 2)}\n`
  );
  return list;
}
