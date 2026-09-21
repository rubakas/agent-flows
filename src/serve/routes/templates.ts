// The /api/templates* route group (FR-002): list, detail, delete and install
// against the global template store.
//
// A per-group module: only ever invoked from server.ts's handleRequest, after
// the Host/content-type/Origin preamble has already run, and in the same
// position in the if-chain the routes previously occupied.

import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join, normalize } from "node:path";

import { parse } from "yaml";

import { importBundle, parseBundle, type WorkflowBundle } from "../../bundle/bundle.js";
import { assertSafePath } from "../../bundle/paths.js";
import { repoCanonRoot } from "../../canon/layers.js";
import {
  BODY_LIMIT_DEFAULT,
  json,
  parseJsonBody,
  readAndDiscardBody,
  readBody,
  requireSafeId,
  safePath,
} from "../route-helpers.js";
import type { IncomingMessage, ServerResponse } from "node:http";

const RE_TEMPLATE_DETAIL = /^\/api\/templates\/([^/]+)$/u;
const RE_TEMPLATE_INSTALL = /^\/api\/templates\/([^/]+)\/install$/u;

/**
 * Everything this route group needs from the request context — three of the
 * sixteen HandlerCtx fields. Declared here rather than imported so the module's
 * real interface is visible at its own boundary.
 */
export interface TemplateRoutesDeps {
  /** Global template store directory (FR-001). */
  templatesBase: string;
  /** Install target: the bundle is written into this project's canon. */
  projectDir: string;
  /** Path-redaction root for error messages leaving the process. */
  root: string;
}

/**
 * The literal command of every `check` step a bundle would install (spec 037
 * D4). The template preview shows these before Install, so accepting a bundle
 * from elsewhere is never a blind trust decision.
 *
 * Best-effort by design: a pipeline entry that does not parse contributes no
 * commands rather than failing the preview — `importBundle` is the check that
 * refuses it at write time.
 */
function bundleCheckCommands(
  bundle: WorkflowBundle
): { pipeline: string; stepId: string; command: string }[] {
  const checks: { pipeline: string; stepId: string; command: string }[] = [];
  for (const file of bundle.files) {
    // Normalised before the prefix test: "prompts/../pipelines/x.yaml" installs as
    // a pipeline, so a preview reading the raw path would hide its check commands.
    if (!normalize(file.path).startsWith("pipelines/")) continue;
    let raw: unknown;
    try {
      raw = parse(file.content);
    } catch {
      continue;
    }
    const doc = raw as { id?: unknown; steps?: unknown };
    if (!Array.isArray(doc?.steps)) continue;
    for (const step of doc.steps as { id?: unknown; kind?: unknown; command?: unknown }[]) {
      if (step?.kind !== "check" || typeof step.command !== "string") continue;
      checks.push({
        pipeline: typeof doc.id === "string" ? doc.id : file.path,
        stepId: typeof step.id === "string" ? step.id : "",
        command: step.command,
      });
    }
  }
  return checks;
}

/**
 * Validates a template id and maps it to its file under deps.templatesBase.
 * Writes the 400 response and returns undefined when the id is unsafe or
 * would escape the templates directory. Does not check existence.
 */
function resolveTemplatePath(
  deps: TemplateRoutesDeps,
  tId: string,
  res: ServerResponse
): string | undefined {
  if (!requireSafeId(tId, "Template", res)) return undefined;
  try {
    assertSafePath(deps.templatesBase, `${tId}.yaml`);
  } catch {
    json(res, 400, { error: `Template id "${tId}" would escape the templates directory` });
    return undefined;
  }
  return join(deps.templatesBase, `${tId}.yaml`);
}

/**
 * resolveTemplatePath plus the existence check, for routes that read the
 * template file straight away. Writes 400 or 404 and returns undefined.
 */
function resolveTemplateFile(
  deps: TemplateRoutesDeps,
  tId: string,
  res: ServerResponse
): string | undefined {
  const templatePath = resolveTemplatePath(deps, tId, res);
  if (templatePath === undefined) return undefined;
  if (!existsSync(templatePath)) {
    json(res, 404, { error: `Template "${tId}" not found` });
    return undefined;
  }
  return templatePath;
}

/**
 * Serves the /api/templates* group. Returns true when the request was handled
 * (a response has been written) and false when no route in the group matched,
 * leaving the caller's if-chain to continue.
 */
export async function handleTemplateRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  deps: TemplateRoutesDeps,
  method: string,
  pathname: string
): Promise<boolean> {
  // GET /api/templates — list all templates in the global store
  if (method === "GET" && pathname === "/api/templates") {
    const templates: { templateId: string; sourcePipeline: string; exportedAt: string }[] = [];
    const errors: string[] = [];
    if (existsSync(deps.templatesBase)) {
      for (const f of readdirSync(deps.templatesBase).sort()) {
        if (!f.endsWith(".yaml") && !f.endsWith(".yml")) continue;
        const templateId = f.replace(/\.ya?ml$/u, "");
        const filePath = join(deps.templatesBase, f);
        try {
          const bundle = parseBundle(readFileSync(filePath, "utf8"));
          templates.push({
            templateId,
            sourcePipeline: bundle.sourcePipeline,
            exportedAt: bundle.exportedAt,
          });
        } catch (err) {
          errors.push(`${f}: ${(err as Error).message}`);
        }
      }
    }
    json(res, 200, { templates, ...(errors.length > 0 ? { errors } : {}) });
    return true;
  }

  // GET /api/templates/:id — get template details
  const templateDetailMatch = RE_TEMPLATE_DETAIL.exec(pathname);
  if (method === "GET" && templateDetailMatch) {
    const tId = decodeURIComponent(templateDetailMatch[1]);
    const templatePath = resolveTemplateFile(deps, tId, res);
    if (templatePath === undefined) return true;
    try {
      const bundle = parseBundle(readFileSync(templatePath, "utf8"));
      json(res, 200, {
        templateId: tId,
        sourcePipeline: bundle.sourcePipeline,
        exportedAt: bundle.exportedAt,
        files: bundle.files.map((f) => f.path),
        checks: bundleCheckCommands(bundle),
      });
    } catch (err) {
      json(res, 422, { error: `Template "${tId}" is invalid: ${(err as Error).message}` });
    }
    return true;
  }

  // DELETE /api/templates/:id
  if (method === "DELETE" && templateDetailMatch) {
    const tId = decodeURIComponent(templateDetailMatch[1]);
    const templatePath = resolveTemplatePath(deps, tId, res);
    if (templatePath === undefined) return true;
    await readAndDiscardBody(req, BODY_LIMIT_DEFAULT); // consume body
    if (!existsSync(templatePath)) {
      json(res, 404, { error: `Template "${tId}" not found` });
      return true;
    }
    rmSync(templatePath);
    json(res, 200, { ok: true, id: tId });
    return true;
  }

  // POST /api/templates/:id/install — install a template into the project (FR-002)
  const templateInstallMatch = RE_TEMPLATE_INSTALL.exec(pathname);
  if (method === "POST" && templateInstallMatch) {
    const tId = decodeURIComponent(templateInstallMatch[1]);
    const templatePath = resolveTemplateFile(deps, tId, res);
    if (templatePath === undefined) return true;
    // Deliberately lenient: an unparseable body falls back to overwrite:false
    // rather than 400 — this route only ever reads one optional boolean field,
    // so readJsonBody's stricter "malformed body" rejection is not used here.
    const bodyRaw = await readBody(req, BODY_LIMIT_DEFAULT);
    const bodyParsed = parseJsonBody(bodyRaw);
    const doOverwrite = bodyParsed.ok && bodyParsed.value.overwrite === true;
    try {
      const bundle = parseBundle(readFileSync(templatePath, "utf8"));
      const report = importBundle(bundle, repoCanonRoot(deps.projectDir), doOverwrite);
      json(res, 200, report);
    } catch (err) {
      json(res, 422, { error: safePath((err as Error).message, deps.root) });
    }
    return true;
  }

  return false;
}
