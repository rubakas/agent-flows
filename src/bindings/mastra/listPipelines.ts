// The payload behind the MCP `list_pipelines` tool (spec 038 FR-026).
//
// Its own module rather than a closure inside server.ts, which no test can
// import because it calls MCPServer.startStdio() at module load — and the
// visibility filter is exactly the kind of thing that must be provable.
//
// This is one of the two surfaces visibility filters. A hidden workflow is
// unlisted here and still runs when `run_pipeline` names it by id, and a hidden
// workflow mounted as a nested step by an enabled parent still executes: hiding
// declutters the chat surface, it is not access control.

import { loadCatalogPipelines, resolveCatalog } from "../../canon/layers.js";
import { resolveProjectState } from "../../runtime/projectState.js";
import { readHidden } from "../../runtime/visibility.js";
import type { StateEnv } from "../../runtime/projectState.js";

export interface ListedPipeline {
  id: string;
  description: string;
  inputs: string[];
  layer: string;
  shadows: string[];
}

export interface ListPipelinesPayload {
  pipelines: ListedPipeline[];
  errors: { file: string; error: string }[];
}

/**
 * The merged view for `projectDir`, minus this project's hidden ids.
 *
 * Resolved per call so a workflow added — or hidden — after the MCP server
 * started is reflected on the very next call, with no restart (spec 029 FR-010).
 */
export function listPipelinesPayload(
  projectDir: string,
  env: StateEnv = process.env
): ListPipelinesPayload {
  const catalog = loadCatalogPipelines(resolveCatalog(projectDir, env));
  const hidden = readHidden(resolveProjectState(projectDir, env).dir);
  return {
    pipelines: catalog.loaded
      .filter(({ loaded }) => !hidden.has(loaded.def.id))
      .map(({ entry, loaded }) => ({
        id: loaded.def.id,
        description: loaded.def.description,
        inputs: [...(loaded.def.inputs ?? [])],
        layer: entry.layer.source,
        shadows: [...entry.shadows],
      })),
    errors: catalog.errors.map((e) => ({ file: e.file, error: e.error })),
  };
}
