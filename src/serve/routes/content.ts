// Unified GET /api/skills/:name and GET /api/agents/:name handler.
// A per-resource module: only ever invoked from server.ts's handleRequest,
// after the Host/content-type/Origin preamble has already run.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Replaces a former server.ts-local copy that hardcoded "/" as the separator.
// This shared version uses path.sep, so containment now works on Windows too —
// a correctness gain, not a behaviour regression (spec 023 acceptance criterion 6).
import { isContained } from "../../install/paths.js";
import { isSafeName, json } from "../route-helpers.js";
import type { ServerResponse } from "node:http";

/** Maximum bytes returned by the skill/agent content endpoint. */
export const CONTENT_CAP = 65_536;

export type ContentKind = "skill" | "agent";

/** Path shape differs by kind: skills/<name>/SKILL.md vs agents/<name>.md. */
function resolveContentPath(
  skillsBase: string,
  kind: ContentKind,
  name: string
): { subdir: string; filePath: string } {
  if (kind === "skill") {
    const subdir = join(skillsBase, "skills");
    return { subdir, filePath: join(subdir, name, "SKILL.md") };
  }
  const subdir = join(skillsBase, "agents");
  return { subdir, filePath: join(subdir, `${name}.md`) };
}

/**
 * Serves both GET /api/skills/:name and GET /api/agents/:name — the two
 * routes were byte-identical apart from path shape, the resource noun in
 * error messages, and the `kind` field in the response body.
 */
export function handleNamedContent(
  res: ServerResponse,
  skillsBase: string,
  kind: ContentKind,
  rawName: string
): void {
  const noun = kind === "skill" ? "Skill" : "Agent";
  if (!isSafeName(rawName)) {
    json(res, 400, { error: `${noun} name contains invalid characters` });
    return;
  }
  const { subdir, filePath } = resolveContentPath(skillsBase, kind, rawName);
  if (!isContained(subdir, filePath)) {
    json(res, 400, { error: `${noun} name contains invalid characters` });
    return;
  }
  if (!existsSync(filePath)) {
    json(res, 404, { error: `${noun} "${rawName}" not found` });
    return;
  }
  const raw = readFileSync(filePath, "utf8");
  const truncated = raw.length > CONTENT_CAP;
  json(res, 200, {
    kind,
    name: rawName,
    filePath,
    content: truncated ? raw.slice(0, CONTENT_CAP) : raw,
    truncated,
  });
}
