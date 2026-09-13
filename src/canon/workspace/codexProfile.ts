import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Name of the composed profile; `-P` must be given the same value. */
export const CODEX_PROFILE_NAME = "agent_flows";

/**
 * Roots denied on every run. Probe 2026-09-13 (codex-cli 0.152.1): these are
 * the roots a step can otherwise read through; `/` is deliberately absent —
 * denying it aborts the sandboxed process with SIGABRT 134 in dyld.
 *
 * Two roots are deliberately NOT denied wholesale, only their config subtrees:
 * denying `/opt` makes `/opt/homebrew/bin/rg` unexecutable (`execvp … Operation
 * not permitted`), and `/usr/local` has the same shape on Intel machines. The
 * secrets under them live in `etc`, so that is what is denied.
 *
 * `/private/var` is denied as a whole even though `/private/var/folders` is
 * listed too: codex resolves the most specific path first, so the single `read`
 * grant on a copy under `/private/var/folders/...` still wins over both.
 */
const DENY_ROOTS: readonly string[] = [
  "/Users",
  "/Volumes",
  "/tmp",
  "/private/tmp",
  "/etc",
  "/private/etc",
  "/var/folders",
  "/private/var/folders",
  // macOS system and per-machine configuration: keychains, LaunchDaemons,
  // application support directories holding tokens.
  "/Library",
  "/Applications",
  // Package-manager configuration only — never the whole prefix, or the tools
  // the step legitimately runs stop being executable.
  "/opt/homebrew/etc",
  "/usr/local/etc",
  // Everything else under /var: mail spools, logs, per-user caches.
  "/private/var",
  // Linux/NixOS shapes, harmless no-ops on a machine without them.
  "/nix",
  "/srv",
  "/root",
];

export interface CodexConfinementOptions {
  homedir?: string;
  tmpdir?: string;
  /** Defaults to `fs.realpathSync`; falls back to the literal path if absent. */
  realpath?: (p: string) => string;
}

/**
 * Build the `-c` flag array that composes the `agent_flows` permission profile.
 *
 * `-s read-only` is never emitted: probe 2026-09-13 showed it constrains writes
 * and network only, leaving every readable path readable. The profile denies
 * the broad roots and grants a single `read` on the sanitized copy; codex
 * resolves the most specific path first, so the grant wins inside the copy.
 */
export function codexConfinementArgs(
  grantDir: string,
  opts: CodexConfinementOptions = {}
): string[] {
  const realpath = opts.realpath ?? ((p: string) => fs.realpathSync(p));
  const resolve = (p: string): string => {
    try {
      return realpath(p);
    } catch {
      return p;
    }
  };

  const denies: string[] = [];
  const deny = (candidate: string): void => {
    const resolved = resolve(candidate);
    // Never `/`: a deny on the filesystem root aborts the sandboxed process.
    if (resolved === "" || resolved === "/") return;
    if (denies.includes(resolved)) return;
    denies.push(resolved);
  };

  for (const root of DENY_ROOTS) deny(root);
  deny(opts.homedir ?? os.homedir());

  const tmpParent = path.dirname(resolve(opts.tmpdir ?? os.tmpdir()));
  if (!isCovered(tmpParent, denies)) deny(tmpParent);

  const entries = [
    ...denies.map((d) => `${tomlString(d)}="deny"`),
    `${tomlString(resolve(grantDir))}="read"`,
  ];

  return [
    "-c",
    `default_permissions="${CODEX_PROFILE_NAME}"`,
    "-c",
    `permissions.${CODEX_PROFILE_NAME}.extends=":read-only"`,
    "-c",
    `permissions.${CODEX_PROFILE_NAME}.filesystem={${entries.join(",")}}`,
  ];
}

function isCovered(candidate: string, roots: readonly string[]): boolean {
  return roots.some((root) => candidate === root || candidate.startsWith(`${root}/`));
}

function tomlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
