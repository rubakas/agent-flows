import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CREDENTIAL_DENY_PATTERNS, operatorDenyRules } from "../denyPatterns.js";
import { matchesDenyPattern } from "./denyMatch.js";

/** Prefix of every sanitized-workspace directory, also the stale-sweep glob. */
const WORKSPACE_PREFIX = "agent-flows-ws-";

/** Spec 031 D2: each materialization sweeps copies older than 24h. */
const DEFAULT_STALE_MS = 24 * 60 * 60 * 1000;

/**
 * The read-deny set the Claude path applies, by reference rather than by copy:
 * the two paths must never drift, and comparing identity makes that testable.
 *
 * BUILD_CONFIG_DENY_PATTERNS is deliberately NOT included. Those files are
 * edit-denied but read-allowed on the Claude path ("Read stays allowed" in
 * denyPatterns.ts), and codex has no write path at all — excluding them would
 * blind a review step to package.json, tsconfig, every *.config.* and the
 * pipelines it was asked to review, for no gain in confinement.
 */
export const BASE_DENY_PATTERNS: readonly string[] = CREDENTIAL_DENY_PATTERNS;

/** `Read(<glob>)` / `Grep(<glob>)`; every other rule shape is ignored. */
const OPERATOR_READ_RULE = /^(?:Read|Grep)\((.+)\)$/;

/**
 * The operator's own USER-level `permissions.deny` entries, reduced to the path
 * globs that deny reading. The Claude path re-applies these through
 * `--disallowedTools`; the copy must honour the same entries, or a file the
 * operator hid from every claude step becomes readable simply by running that
 * step under codex. Rules naming other tools (`Bash(...)`, `WebFetch(...)`) do
 * not describe a readable path and are skipped; an absolute-path glob matches
 * nothing here, since entries are compared repo-relative.
 */
function operatorReadDenyGlobs(env: NodeJS.ProcessEnv): string[] {
  const globs: string[] = [];
  for (const rule of operatorDenyRules(env)) {
    const glob = OPERATOR_READ_RULE.exec(rule)?.[1].trim();
    if (glob !== undefined && glob !== "") globs.push(glob);
  }
  return globs;
}

export interface SanitizedWorkspace {
  /** Realpath-resolved root of the copy. */
  dir: string;
  /** Removes the copy. Idempotent. */
  cleanup(): void;
  /** Repo-relative paths deliberately left out, by reason. */
  skipped: { denied: string[]; symlinks: string[]; gitlinks: string[] };
}

export interface MaterializeOptions {
  /** Parent for the copy and the stale sweep. Defaults to `os.tmpdir()`. */
  tmpRoot?: string;
  /** Clock for the stale sweep, in ms. Defaults to `Date.now()`. */
  now?: number;
  /** Age above which a sibling copy is swept. Defaults to 24h. */
  staleMs?: number;
  /**
   * Environment the operator's claude settings are read from (HOME). Defaults to
   * `process.env`; injected in tests so the copy does not depend on the machine.
   */
  env?: NodeJS.ProcessEnv;
  /**
   * The step's own `permissions.deny` globs. The claude path composes these into
   * `--disallowedTools`; the copy must exclude the same paths, or a step's
   * declared deny list evaporates the moment the step runs under codex.
   */
  extraDenyGlobs?: readonly string[];
}

/**
 * Copy the readable surface of a git repo into a throwaway directory.
 *
 * The file set is `git ls-files -co --exclude-standard` (tracked plus
 * untracked-not-ignored). Excluded: every path matching the credential deny set
 * or one of the operator's own `Read`/`Grep` deny globs, every symlink (skipped
 * without being followed), every gitlink entry, and `.git`.
 *
 * TOCTOU between the `lstat` and the `copyFileSync` below is accepted for a
 * single-operator tool: the window is microseconds and the attacker would have
 * to already have write access to the repo being reviewed.
 */
export function materializeSanitizedWorkspace(
  repoDir: string,
  opts: MaterializeOptions = {}
): SanitizedWorkspace {
  const tmpRoot = opts.tmpRoot ?? os.tmpdir();
  const denyPatterns = [
    ...BASE_DENY_PATTERNS,
    ...operatorReadDenyGlobs(opts.env ?? process.env),
    ...(opts.extraDenyGlobs ?? []),
  ];
  const entries = listRepoEntries(repoDir);

  sweepStaleWorkspaces(tmpRoot, opts.now ?? Date.now(), opts.staleMs ?? DEFAULT_STALE_MS);

  fs.mkdirSync(tmpRoot, { recursive: true });
  const root = fs.mkdtempSync(path.join(tmpRoot, WORKSPACE_PREFIX));
  const skipped: SanitizedWorkspace["skipped"] = { denied: [], symlinks: [], gitlinks: [] };

  for (const rel of entries) {
    if (isGitInternal(rel)) continue;
    if (matchesDenyPattern(rel, denyPatterns)) {
      skipped.denied.push(rel);
      continue;
    }

    const source = path.join(repoDir, rel);
    const stat = fs.lstatSync(source, { throwIfNoEntry: false });
    if (!stat) continue;
    if (stat.isSymbolicLink()) {
      skipped.symlinks.push(rel);
      continue;
    }
    // `ls-files` reports a submodule as a single entry that lstats as a
    // directory; copying it would pull in the nested repo's own `.git`.
    if (stat.isDirectory()) {
      skipped.gitlinks.push(rel);
      continue;
    }
    if (!stat.isFile()) continue;

    const destination = path.join(root, rel);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
  }

  let removed = false;
  return {
    dir: fs.realpathSync(root),
    skipped,
    cleanup() {
      if (removed) return;
      removed = true;
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function listRepoEntries(repoDir: string): string[] {
  const result = spawnSync("git", ["-C", repoDir, "ls-files", "-co", "--exclude-standard", "-z"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) {
    throw new Error(`Cannot list files in ${repoDir}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `Cannot list files in ${repoDir}: not a git repository or git failed` +
        `${result.stderr.trim() ? ` (${result.stderr.trim()})` : ""}`
    );
  }
  return result.stdout.split("\0").filter((entry) => entry !== "");
}

function isGitInternal(rel: string): boolean {
  const normalized = rel.replace(/\\/g, "/");
  return normalized === ".git" || normalized.startsWith(".git/");
}

/**
 * Removes `agent-flows-ws-*` directories older than `staleMs` under `tmpRoot`.
 * Exported so every producer of such a directory — the copy here and the codex
 * adapter's empty grant — reclaims after a crash that skipped `cleanup()`.
 * Best-effort: a concurrent run may already have removed a candidate.
 */
export function sweepStaleWorkspaces(
  tmpRoot: string = os.tmpdir(),
  now: number = Date.now(),
  staleMs: number = DEFAULT_STALE_MS
): void {
  let siblings: fs.Dirent[];
  try {
    siblings = fs.readdirSync(tmpRoot, { withFileTypes: true });
  } catch {
    return;
  }
  for (const sibling of siblings) {
    if (!sibling.name.startsWith(WORKSPACE_PREFIX)) continue;
    const candidate = path.join(tmpRoot, sibling.name);
    try {
      const stat = fs.lstatSync(candidate);
      if (!stat.isDirectory()) continue;
      if (now - stat.mtimeMs <= staleMs) continue;
      fs.rmSync(candidate, { recursive: true, force: true });
    } catch {
      // A concurrent run may already have removed it; sweeping is best-effort.
    }
  }
}
