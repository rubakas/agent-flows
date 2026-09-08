// Lazy-rebuilding Mastra adapter for hot-reload of installed pipelines (spec 028 FR-004).
//
// The Mastra instance is constructed once at daemon startup from the pipeline
// set known at that moment. Workflows installed or edited while the daemon is
// running are invisible to the original instance, causing "Workflow not found"
// errors.  This wrapper catches that failure, rescans the current canon, rebuilds
// all workflow objects, and swaps the internal Mastra instance.  The Mastra storage
// object is reused across rebuilds so LibSQL run snapshots remain consistent.

import { listPipelines, loadPipeline } from "../../canon/load.js";
import { resolveCanonDir } from "./pipelineLoader.js";
import type { MastraLike } from "../../runtime/runService.js";

export interface DynamicMastraOpts {
  /**
   * The Mastra class constructor.  Typed as `new (...args: any[]) => any` to
   * avoid pulling in the full Mastra generic signature — a static import of
   * @mastra/core crashes the eslint import-x cycle resolver for files outside
   * src/bindings/mastra/**.  The real Mastra class satisfies this type and
   * its instances structurally implement MastraLike.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  MastraClass: new (...args: any[]) => any;
  /** The LibSQL storage object shared across all rebuilt Mastra instances. */
  mastraStorage: unknown;
  /**
   * The buildPipelineWorkflow function from src/bindings/mastra/build.ts.
   * Typed with `any` params to avoid a static import of that module from this file
   * (a static import would pull in @mastra/core and crash the cycle resolver for
   * files outside src/bindings/mastra/**).
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  buildFn: (loaded: any, deps: any) => unknown;
  /** Dependencies forwarded to buildFn unchanged. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  buildDeps: any;
  /** Project root — used to resolve the current canon directory. */
  projectDir: string;
}

/**
 * Wraps a Mastra instance so that pipelines installed or edited while the
 * daemon is running become executable without a restart (spec 028 FR-004).
 *
 * On every getWorkflow() call, the wrapper first tries the cached Mastra
 * instance.  If that throws (the workflow was not registered at construction
 * time), it rescans the current canon directory, rebuilds ALL workflow objects
 * from disk, and replaces the internal instance.  A second getWorkflow() call
 * on the rebuilt instance then either succeeds or propagates — meaning the
 * pipeline genuinely does not exist in the current canon.
 *
 * The rebuild path is only hit when a workflow is missing; requests for
 * pipelines that were present at startup are served by the cached instance.
 */
export function createDynamicMastra(initial: MastraLike, opts: DynamicMastraOpts): MastraLike {
  let current: MastraLike = initial;

  function rebuild(): void {
    const { pipelinesDir } = resolveCanonDir(opts.projectDir);
    const files = listPipelines(pipelinesDir);
    const workflows: Record<string, unknown> = {};
    for (const f of files) {
      const loaded = loadPipeline(f);
      workflows[loaded.def.id] = opts.buildFn(loaded, opts.buildDeps);
    }
    current = new opts.MastraClass({
      storage: opts.mastraStorage,
      workflows,
    }) as unknown as MastraLike;
  }

  return {
    getWorkflow(id: string) {
      try {
        return current.getWorkflow(id);
      } catch {
        // Workflow not registered in the cached instance: rescan the canon dir
        // so that newly installed (or edited) pipelines are picked up, then retry.
        rebuild();
        return current.getWorkflow(id);
      }
    },
  };
}
