// The skills/agents content route group: GET /api/skills/:name and
// GET /api/agents/:name, plus the unified handler that backs both.
//
// A per-group module: only ever invoked from server.ts's handleRequest, after
// the Host/content-type/Origin preamble has already run, and in the same
// position in the if-chain the routes previously occupied.
//
// The skills/agents *listing* is not here — it lives inside GET /api/environment
// alongside projectDir, state paths and the provider profile, and splitting that
// response was out of scope for this extraction.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Replaces a former server.ts-local copy that hardcoded "/" as the separator.
// This shared version uses path.sep, so containment now works on Windows too —
// a correctness gain, not a behaviour regression (spec 023 acceptance criterion 6).
import { isContained } from "../../bundle/paths.js";
import { isSafeName, json } from "../route-helpers.js";
import type { IncomingMessage, ServerResponse } from "node:http";

const RE_SKILL_CONTENT = /^\/api\/skills\/([^/]+)$/u;
const RE_AGENT_CONTENT = /^\/api\/agents\/([^/]+)$/u;

/** Maximum bytes returned by the skill/agent content endpoint. */
export const CONTENT_CAP = 65_536;

/**
 * Everything this route group needs from the request context — one of the
 * sixteen HandlerCtx fields. Declared here rather than imported so the module's
 * real interface is visible at its own boundary.
 */
export interface ContentRoutesDeps {
  /** Root holding the `skills/` and `agents/` subdirectories. */
  skillsBase: string;
}

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

/**
 * Serves the skill/agent content routes. Returns true when the request was
 * handled (a response has been written) and false when no route in the group
 * matched, leaving the caller's if-chain to continue.
 */
export function handleContentRoutes(
  _req: IncomingMessage,
  res: ServerResponse,
  deps: ContentRoutesDeps,
  method: string,
  pathname: string
): boolean {
  // GET /api/skills/:name — return the content of one skill's SKILL.md
  const skillMatch = RE_SKILL_CONTENT.exec(pathname);
  if (method === "GET" && skillMatch) {
    handleNamedContent(res, deps.skillsBase, "skill", decodeURIComponent(skillMatch[1]));
    return true;
  }

  // GET /api/agents/:name — return the content of one agent's .md file
  const agentMatch = RE_AGENT_CONTENT.exec(pathname);
  if (method === "GET" && agentMatch) {
    handleNamedContent(res, deps.skillsBase, "agent", decodeURIComponent(agentMatch[1]));
    return true;
  }

  return false;
}
