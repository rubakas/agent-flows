// Resolves where machine-local state for one project lives (spec 032).
//
// Versioned canon (pipelines/, prompts/, providers.yaml, config.json) stays in
// <projectDir>/.agent-flows/. Everything this machine produced — run artifacts,
// the tickets/drafts db, the mastra db, the project n8n id map — lives under
// ${AGENT_FLOWS_HOME ?? ~/.agent-flows}/projects/<key>/ (D1, D2).

import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { mastraDbPath } from "../bindings/mastra/paths.js";

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
  /** <dir>/agent-flows.sqlite — tickets and drafts. */
  dbPath: string;
  /** <dir>/agent-flows-mastra.db — Mastra LibSQL store, derived per FR-006. */
  mastraDbPath: string;
  /** <dir>/n8n.json — project n8n workflow id map. */
  n8nMapPath: string;
  /** <dir>/project.json — the marker written on first resolution. */
  projectJsonPath: string;
}

/** Max length of the escaped key before truncation + hash suffix kicks in (FR-001). */
const KEY_MAX_LENGTH = 200;

/** Length of the sha256 hex suffix appended to a truncated key (FR-001). */
const KEY_HASH_LENGTH = 8;

/**
 * Derive the project key from the project directory (FR-001, D3).
 *
 * AGENT_FLOWS_PROJECT_KEY overrides the derivation entirely. Otherwise the
 * absolute realpath is escaped — every character outside [A-Za-z0-9_-] becomes
 * "-" — and, when the escaped form exceeds 200 characters, cut to 200 and
 * joined by "-" to an 8-char sha256 of the *unescaped* realpath (total 209).
 *
 * The realpath is resolved here independently of resolveProjectDir(), whose
 * return value stays raw so step execution cwd is unaffected.
 */
export function projectKey(projectDir: string, env: StateEnv = process.env): string {
  const override = env.AGENT_FLOWS_PROJECT_KEY;
  if (override !== undefined && override !== "") return override;

  let real: string;
  try {
    real = realpathSync(projectDir);
  } catch {
    // Directory absent (or a broken link) — fall back to lexical resolution.
    real = resolve(projectDir);
  }

  const escaped = real.replace(/[^A-Za-z0-9_-]/gu, "-");
  if (escaped.length <= KEY_MAX_LENGTH) return escaped;

  const hash = createHash("sha256").update(real).digest("hex").slice(0, KEY_HASH_LENGTH);
  return `${escaped.slice(0, KEY_MAX_LENGTH)}-${hash}`;
}

/** Root of all agent-flows machine-local state: AGENT_FLOWS_HOME or ~/.agent-flows (FR-002). */
export function stateRoot(env: StateEnv = process.env): string {
  return env.AGENT_FLOWS_HOME ?? join(homedir(), ".agent-flows");
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
    mastraDbPath: mastraDbPath(dbPath),
    n8nMapPath: join(dir, "n8n.json"),
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
  mkdirSync(state.dir, { recursive: true });

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
    writeFileSync(state.projectJsonPath, JSON.stringify(marker, null, 2), "utf8");
  }

  migrateLegacyRuns(projectDir, state, log);
  return state;
}

/**
 * Copy a legacy <projectDir>/.agent-flows/runs into the state dir once (D5, FR-009).
 *
 * The copy lands in <dir>/runs.partial and is renamed into place, so an
 * interrupted copy is never mistaken for a complete one — a leftover
 * runs.partial is discarded and the copy redone. The legacy directory is never
 * deleted or modified; the owner removes it by hand after reading the notice.
 */
export function migrateLegacyRuns(
  projectDir: string,
  state: ProjectState,
  log: (msg: string) => void = console.error
): void {
  const legacyRuns = join(projectDir, ".agent-flows", "runs");
  if (!existsSync(legacyRuns)) return;
  if (existsSync(state.runsDir)) return;

  const partial = join(state.dir, "runs.partial");
  try {
    // A partial left by an interrupted copy is stale — start over.
    rmSync(partial, { recursive: true, force: true });
    cpSync(legacyRuns, partial, { recursive: true });
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
}
