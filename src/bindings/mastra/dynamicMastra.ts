// Fingerprint-checked, lazily rebuilding Mastra adapter (spec 028 FR-004, spec 047 FR-8).
//
// The Mastra instance is constructed once at daemon startup from the pipeline
// set known at that moment, and a built workflow closes over its step list,
// step config and the prompt TEXT. Left alone it would (a) not know about
// workflows installed later ("Workflow not found") and (b) keep executing the
// OLD build after a pipeline YAML or prompt file is edited, while the route
// validates and records provenance from the NEW definition.
//
// On every getWorkflow() this wrapper loads ONLY the requested pipeline from the
// injected catalogue and compares a content fingerprint with the one its current
// build was made from. A new or changed pipeline triggers a rebuild of all
// workflows (replacing the internal Mastra instance); an unchanged one is served
// from the cached instance. Edits made outside the daemon (an editor, git
// checkout) are caught too.
//
// The requested id fails CLOSED: a pipeline that is gone from the catalogue, fails
// to load, or fails to build throws a named error — it never runs from the cache,
// because the route swallows load errors and would otherwise start a stale run
// with empty provenance. Other pipelines that fail to load or build are carried
// forward from the old instance so one broken file cannot take them down.
//
// What this does NOT cover: only pipeline YAML, prompt files and nested children
// are re-read. providers.yaml (registry / providerProfiles), the env profile and
// checkCommand are baked into `buildDeps` and stay fixed until daemon restart.
//
// The Mastra storage object is reused across rebuilds so LibSQL run snapshots
// remain consistent.

import { hashContent } from "../../canon/hash.js";
import { loadCatalogPipelines, loadFromCatalog, type MergedCatalog } from "../../canon/layers.js";
import type { LoadedPipeline } from "../../canon/types.js";
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
  /**
   * The catalogue to read on every lookup. It must be the same resolution the
   * HTTP route uses (resolveCatalog(projectDir) in production, a single pinned
   * layer when a pipelines dir is pinned) so the route validates and the
   * executor runs the same file.
   */
  resolveCatalog: () => MergedCatalog;
  /**
   * The pipelines the initial Mastra instance was built from. Their fingerprints
   * are recorded at wrapper creation so an unchanged pipeline is served by the
   * initial instance; without them the first lookup of every id rebuilds once.
   */
  initialPipelines?: LoadedPipeline[];
  /**
   * Pipelines whose build threw at startup and so are absent from the initial
   * instance. getWorkflow throws their build error (named) until they change.
   */
  initialFailures?: { loaded: LoadedPipeline; message: string }[];
}

/**
 * Content hash of everything the build consumes from a loaded pipeline: the
 * definition (nested children and loop bodies are already expanded into it or
 * into `bodies` at load time) and the prompt text.
 *
 * JSON.stringify is stable here because the object comes from the same parser
 * for the same file content, so key order is deterministic for equal content.
 */
function fingerprint(loaded: LoadedPipeline): string {
  return hashContent(JSON.stringify(loaded));
}

/**
 * Wraps a Mastra instance so that pipelines installed or edited while the
 * daemon is running become executable, and run as edited, without a restart
 * (spec 028 FR-004, spec 047 FR-8).
 *
 * getWorkflow(id) loads `id` from the catalogue and:
 *  - not in the catalogue, or fails to load: throws (the real load error);
 *  - fingerprint equal to the one its current build was made from: returns the
 *    cached workflow (the same object every time, no rebuild);
 *  - fingerprint different or unknown: rebuilds every pipeline from the full
 *    catalogue and returns the new workflow;
 *  - build threw: throws an error naming the id and the build error. The failure
 *    is remembered per fingerprint, so it is not retried until the file changes.
 */
export function createDynamicMastra(initial: MastraLike, opts: DynamicMastraOpts): MastraLike {
  // In-flight runs keep their own Run objects (RunService holds record.run) and
  // resume through them, so replacing `current` never disturbs a running workflow.
  let current: MastraLike = initial;
  const builtFingerprints = new Map<string, string>();
  let failedBuilds = new Map<string, { fingerprint: string; message: string }>();

  for (const loaded of opts.initialPipelines ?? []) {
    builtFingerprints.set(loaded.def.id, fingerprint(loaded));
  }
  for (const { loaded, message } of opts.initialFailures ?? []) {
    failedBuilds.set(loaded.def.id, { fingerprint: fingerprint(loaded), message });
  }

  function buildFailure(id: string, message: string): Error {
    return new Error(`Pipeline "${id}" failed to build: ${message}`);
  }

  function rebuild(catalog: MergedCatalog): void {
    const old = current;
    const oldFingerprints = new Map(builtFingerprints);
    const workflows: Record<string, unknown> = {};
    const failures = new Map<string, { fingerprint: string; message: string }>();
    builtFingerprints.clear();

    for (const { loaded } of loadCatalogPipelines(catalog).loaded) {
      const id = loaded.def.id;
      try {
        workflows[id] = opts.buildFn(loaded, opts.buildDeps);
        builtFingerprints.set(id, fingerprint(loaded));
      } catch (err) {
        failures.set(id, {
          fingerprint: fingerprint(loaded),
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Carry forward: a pipeline that is still in the catalogue but could not be
    // loaded or built this time keeps its previous workflow and fingerprint, so
    // one broken file does not take its neighbours down. A pipeline gone from the
    // catalogue is dropped. The requested id is not hidden by this: a recorded
    // build failure or a load error is thrown before the cache is consulted.
    for (const [id, previousPrint] of oldFingerprints) {
      if (id in workflows || !catalog.entries.has(id)) continue;
      try {
        workflows[id] = old.getWorkflow(id);
        builtFingerprints.set(id, previousPrint);
      } catch {
        // not registered in the old instance: nothing to carry
      }
    }

    failedBuilds = failures;
    current = new opts.MastraClass({
      storage: opts.mastraStorage,
      workflows,
    }) as unknown as MastraLike;

    // @mastra/core's constructor registers a process-global onScorerRun hook that
    // keeps every instance it ever created alive. __unregisterHooks is an
    // internal API, so it is optional-called. shutdown() is deliberately NOT
    // called: it would tear down state that in-flight runs still use.
    (old as { __unregisterHooks?: () => void }).__unregisterHooks?.();
  }

  return {
    getWorkflow(id: string) {
      // Spec 038 D13: the merged three-layer view, so a workflow added in any
      // layer becomes executable and a repository fork wins over the bundled copy.
      const catalog = opts.resolveCatalog();
      // loadFromCatalog throws the real load error for a broken file; both that
      // and a missing id fail closed rather than serving the cached workflow.
      const requested = loadFromCatalog(catalog, id);
      if (requested === undefined) throw new Error(`Pipeline "${id}" not found`);

      const print = fingerprint(requested.loaded);
      const known = failedBuilds.get(id);
      if (known?.fingerprint === print) throw buildFailure(id, known.message);
      if (builtFingerprints.get(id) !== print) {
        rebuild(catalog);
        const failed = failedBuilds.get(id);
        if (failed !== undefined) throw buildFailure(id, failed.message);
      }
      return current.getWorkflow(id);
    },
  };
}
