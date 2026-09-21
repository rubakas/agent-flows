// The skills/agents content route group: GET /api/skills/:name and
// GET /api/agents/:name.
//
// A per-group module: only ever invoked from server.ts's handleRequest, after
// the Host/content-type/Origin preamble has already run, and in the same
// position in the if-chain the routes previously occupied.
//
// The skills/agents *listing* is not here — it lives inside GET /api/environment
// alongside projectDir, state paths and the provider profile, and splitting that
// response was out of scope for this extraction.

import { handleNamedContent } from "./content.js";
import type { IncomingMessage, ServerResponse } from "node:http";

const RE_SKILL_CONTENT = /^\/api\/skills\/([^/]+)$/u;
const RE_AGENT_CONTENT = /^\/api\/agents\/([^/]+)$/u;

/**
 * Everything this route group needs from the request context — one of the
 * sixteen HandlerCtx fields. Declared here rather than imported so the module's
 * real interface is visible at its own boundary.
 */
export interface SkillRoutesDeps {
  /** Root holding the `skills/` and `agents/` subdirectories. */
  skillsBase: string;
}

/**
 * Serves the skill/agent content routes. Returns true when the request was
 * handled (a response has been written) and false when no route in the group
 * matched, leaving the caller's if-chain to continue.
 */
export function handleSkillRoutes(
  _req: IncomingMessage,
  res: ServerResponse,
  deps: SkillRoutesDeps,
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
