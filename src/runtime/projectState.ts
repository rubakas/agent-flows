// Resolves where machine-local state for one project lives (spec 032).
//
// Versioned canon (pipelines/, prompts/, providers.yaml, config.json) stays in
// <projectDir>/.agent-flows/. Everything this machine produced — run artifacts,
// the tickets/drafts db, the mastra db — lives under
// ${AGENT_FLOWS_HOME ?? ~/.agent-flows}/projects/<key>/ (D1, D2).

import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** Environment slice the resolution reads. Injected so tests never touch the real home. */
export type StateEnv = Record<string, string | undefined>;

/** Resolved machine-local locations for one project (D2). */
export interface ProjectState {
  /** Project key — the directory name under <root>/projects/. */
  key: string;
  /** <root>/projects/<key> */
  dir: string;
  /** <dir>/runs — run artifacts and manifests. */
  runsDir: string;
  /**
   * <dir>/agent-flows.sqlite — tickets and drafts.
   *
   * The Mastra LibSQL path is deliberately NOT resolved here: the CLI derives it
   * with `mastraDbPath(dbPath)` from the *effective* db path, which `--db`
   * overrides. A field on ProjectState would be a second, silently divergent
   * derivation that ignores `--db`.
   */
  dbPath: string;
  /** <dir>/project.json — the marker written on first resolution. */
  projectJsonPath: string;
}

/** Max length of the escaped key before truncation + hash suffix kicks in (FR-001). */
const KEY_MAX_LENGTH = 200;

/** Length of the sha256 hex suffix appended to a truncated key (FR-001). */
const KEY_HASH_LENGTH = 8;

/** Age past which a migration lock is treated as abandoned by a dead process. */
const MIGRATION_LOCK_STALE_MS = 10 * 60 * 1000;

/** Every character outside [A-Za-z0-9_-] becomes "-", so a key is always one safe path segment. */
function escapeKey(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/gu, "-");
}

/**
 * Derive the project key from the project directory (FR-001, D3).
 *
 * AGENT_FLOWS_PROJECT_KEY overrides the derivation, but is escaped exactly as a
 * derived key is: the key is a single path segment under <root>/projects/, so an
 * override carrying "/" or ".." would otherwise redirect the whole state tree
 * out of that root. An override that escapes to nothing is ignored.
 *
 * Otherwise the absolute realpath is escaped — every character outside
 * [A-Za-z0-9_-] becomes "-" — and, when the escaped form exceeds 200 characters,
 * cut to 200 and joined by "-" to an 8-char sha256 of the *unescaped* realpath
 * (total 209).
 *
 * The realpath is resolved here independently of resolveProjectDir(), whose
 * return value stays raw so step execution cwd is unaffected.
 */
export function projectKey(projectDir: string, env: StateEnv = process.env): string {
  const override = env.AGENT_FLOWS_PROJECT_KEY;
  if (override !== undefined) {
    const clamped = escapeKey(override);
    if (clamped !== "") return clamped;
  }

  let real: string;
  try {
    real = realpathSync(projectDir);
  } catch {
    // Directory absent (or a broken link) — fall back to lexical resolution.
    real = resolve(projectDir);
  }

  const escaped = escapeKey(real);
  if (escaped.length <= KEY_MAX_LENGTH) return escaped;

  const hash = createHash("sha256").update(real).digest("hex").slice(0, KEY_HASH_LENGTH);
  return `${escaped.slice(0, KEY_MAX_LENGTH)}-${hash}`;
}

/**
 * Root of all agent-flows machine-local state: AGENT_FLOWS_HOME or ~/.agent-flows (FR-002).
 *
 * An exported-but-empty AGENT_FLOWS_HOME counts as unset: `??` is nullish-only,
 * so it would let "" through and put the whole state tree in a relative
 * `projects/<key>` under the daemon's cwd.
 */
export function stateRoot(env: StateEnv = process.env): string {
  const home = env.AGENT_FLOWS_HOME;
  if (home !== undefined && home !== "") return home;
  return join(homedir(), ".agent-flows");
}

/** Resolve every machine-local path for a project. Pure — creates nothing (FR-002). */
export function resolveProjectState(projectDir: string, env: StateEnv = process.env): ProjectState {
  const key = projectKey(projectDir, env);
  const dir = join(stateRoot(env), "projects", key);
  const dbPath = join(dir, "agent-flows.sqlite");
  return {
    key,
    dir,
    runsDir: join(dir, "runs"),
    dbPath,
    projectJsonPath: join(dir, "project.json"),
  };
}

/**
 * Resolve the state dir, create it, write project.json once (FR-003), and run
 * the one-time non-destructive legacy runs copy (FR-009).
 *
 * Call once at daemon start. Idempotent: a second call on the same key writes
 * nothing and copies nothing.
 */
export function ensureProjectState(
  projectDir: string,
  env: StateEnv = process.env,
  log: (msg: string) => void = console.error
): ProjectState {
  const state = resolveProjectState(projectDir, env);
  // 0700/0600 throughout: the tree is per-user project state: nothing in it has
  // any business being group- or world-readable.
  mkdirSync(state.dir, { recursive: true, mode: 0o700 });

  if (!existsSync(state.projectJsonPath)) {
    let real: string;
    try {
      real = realpathSync(projectDir);
    } catch {
      real = resolve(projectDir);
    }
    const marker = {
      projectDir: real,
      key: state.key,
      createdAt: new Date().toISOString(),
      schemaVersion: 1,
    };
    writeFileSync(state.projectJsonPath, JSON.stringify(marker, null, 2), {
      encoding: "utf8",
      mode: 0o600,
    });
  }

  migrateLegacyRuns(projectDir, state, log);
  return state;
}

/**
 * Take the exclusive migration marker for a state dir.
 *
 * `mkdir` without `recursive` fails with EEXIST when the directory is already
 * there, which makes it an atomic test-and-set across processes. A marker whose
 * mtime is older than MIGRATION_LOCK_STALE_MS was left by a process that died
 * mid-migration and is reclaimed.
 */
function acquireMigrationLock(lockPath: string): boolean {
  try {
    mkdirSync(lockPath, { mode: 0o700 });
    return true;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }

  let heldSince: number;
  try {
    heldSince = statSync(lockPath).mtimeMs;
  } catch {
    // The holder released it between the failed mkdir and the stat.
    heldSince = 0;
  }
  if (Date.now() - heldSince < MIGRATION_LOCK_STALE_MS) return false;

  rmSync(lockPath, { recursive: true, force: true });
  try {
    mkdirSync(lockPath, { mode: 0o700 });
    return true;
  } catch {
    // Another start reclaimed the stale marker first — let it do the work.
    return false;
  }
}

/**
 * Copy a legacy <projectDir>/.agent-flows/runs into the state dir once (D5, FR-009).
 *
 * The copy lands in <dir>/runs.partial and is renamed into place, so an
 * interrupted copy is never mistaken for a complete one — a leftover
 * runs.partial is discarded and the copy redone. The legacy directory is never
 * deleted or modified; the owner removes it by hand after reading the notice.
 *
 * The whole sequence is serialised by <dir>/migrate.lock: two daemons on one
 * project key (supported since spec 033) would otherwise interleave the rm, the
 * copy and the rename and leave a truncated runs/ permanently treated as
 * migrated.
 */
export function migrateLegacyRuns(
  projectDir: string,
  state: ProjectState,
  log: (msg: string) => void = console.error
): void {
  const legacyRuns = join(projectDir, ".agent-flows", "runs");
  if (!existsSync(legacyRuns)) return;

  const lockPath = join(state.dir, "migrate.lock");
  if (!acquireMigrationLock(lockPath)) {
    log(
      `[agent-flows] another start is copying ${legacyRuns} to ${state.runsDir}; ` +
        `skipping the copy this start.`
    );
    return;
  }

  try {
    const partial = join(state.dir, "runs.partial");
    if (existsSync(state.runsDir)) {
      // The copy already happened. Any runs.partial still on disk is debris from
      // an interrupted attempt that a later run superseded; leaving it behind
      // would grow without bound and look like work in progress forever.
      rmSync(partial, { recursive: true, force: true });
      return;
    }

    const skippedLinks: string[] = [];
    try {
      // A partial left by an interrupted copy is stale — start over.
      rmSync(partial, { recursive: true, force: true });
      cpSync(legacyRuns, partial, {
        recursive: true,
        // The legacy tree comes from the project and may hold symlinks pointing
        // outside it. Carrying them over would give the state dir — which every
        // artifact read treats as trusted — a read-through to arbitrary files.
        // (`dereference: true` is not enough: Node 22's cpSync ignores it for
        // entries inside a recursive copy.)
        filter: (src: string): boolean => {
          if (!lstatSync(src).isSymbolicLink()) return true;
          skippedLinks.push(src);
          return false;
        },
      });
      renameSync(partial, state.runsDir);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`[agent-flows] copying ${legacyRuns} to ${state.runsDir} failed: ${msg}`);
      return;
    }

    log(
      `[agent-flows] copied run artifacts from ${legacyRuns} to ${state.runsDir}; ` +
        `the old directory was left untouched and may be deleted by hand.`
    );
    if (skippedLinks.length > 0) {
      log(
        `[agent-flows] skipped ${skippedLinks.length} symlink(s) under ${legacyRuns}: ` +
          `symlinks are not copied into the state dir (${skippedLinks.join(", ")}).`
      );
    }
  } finally {
    rmSync(lockPath, { recursive: true, force: true });
  }
}
