import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { CREDENTIAL_DENY_PATTERNS } from "../denyPatterns.js";
import { BASE_DENY_PATTERNS, materializeSanitizedWorkspace } from "./sanitize.js";

const ENV_FILE = ".env";
const ENV_FILE_UPPER = ".ENV";

/** Credential-named files planted in the fixture, all of which must be dropped. */
const PLANTED_CREDENTIALS = [
  ENV_FILE,
  "id_rsa",
  "x.pem",
  "secrets.yaml",
  "service-account.json",
  ".npmrc",
  "nested/deep/x.pem",
];

const cleanups: (() => void)[] = [];

after(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function git(cwd: string, ...args: string[]): void {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      // Keep a developer's global excludes/hooks out of the fixture.
      GIT_CONFIG_GLOBAL: os.devNull,
      GIT_CONFIG_SYSTEM: os.devNull,
      GIT_AUTHOR_NAME: "Fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    },
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
}

function write(root: string, rel: string, contents: string): void {
  const target = path.join(root, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
}

interface Fixture {
  root: string;
  repo: string;
  caseSensitive: boolean;
}

function buildFixtureRepo(): Fixture {
  const root = tempDir("agent-flows-fixture-");
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");

  write(repo, "src/index.ts", "export const ok = true;\n");
  // Build-config files: Edit-denied on the claude path, but readable there — and
  // codex has no write path at all, so the copy must keep them.
  write(repo, "package.json", '{ "name": "fixture" }\n');
  write(repo, "vite.config.ts", "export default {};\n");
  // Excluded only when the operator's own settings deny reading it.
  write(repo, "x.sql.bak", "OPERATOR-DENIED\n");
  write(repo, "docs/notes/readme.md", "# notes\n");
  write(repo, ".gitignore", "ignored.txt\n");
  write(repo, "ignored.txt", "IGNORED\n");

  for (const rel of PLANTED_CREDENTIALS) write(repo, rel, "PLANTED\n");

  // APFS is case-insensitive by default: `.ENV` would collapse onto `.env`.
  const caseSensitive = !fs.existsSync(path.join(repo, ENV_FILE_UPPER));
  if (caseSensitive) write(repo, ENV_FILE_UPPER, "PLANTED\n");

  write(root, "outside/target.txt", "OUTSIDE\n");
  fs.symlinkSync(path.join(root, "outside/target.txt"), path.join(repo, "link.txt"));

  const submodule = path.join(repo, "sub");
  fs.mkdirSync(submodule, { recursive: true });
  git(submodule, "init", "-q", "-b", "main");
  write(submodule, "inner.txt", "INNER\n");
  git(submodule, "add", "-A");
  git(submodule, "commit", "-qm", "inner");

  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "fixture");

  // Untracked but not ignored: created after the commit.
  write(repo, "src/untracked.ts", "export const untracked = true;\n");

  return { root, repo, caseSensitive };
}

describe("materializeSanitizedWorkspace", () => {
  it("copies the readable surface and records every exclusion", () => {
    const fixture = buildFixtureRepo();
    const tmpRoot = tempDir("agent-flows-tmproot-");
    const workspace = materializeSanitizedWorkspace(fixture.repo, { tmpRoot, env: {} });

    const present = (rel: string) => fs.existsSync(path.join(workspace.dir, rel));

    assert.equal(present("src/index.ts"), true, "tracked file must be copied");
    assert.equal(present("docs/notes/readme.md"), true, "nested tracked file must be copied");
    assert.equal(present("src/untracked.ts"), true, "untracked non-ignored file must be copied");
    assert.equal(present(".gitignore"), true);

    // Build-config files stay: a review step that cannot see package.json or a
    // *.config.* file is reviewing a repo it cannot describe.
    assert.equal(present("package.json"), true, "package.json must stay readable");
    assert.equal(present("vite.config.ts"), true, "*.config.* must stay readable");
    for (const rel of ["package.json", "vite.config.ts"]) {
      assert.equal(
        workspace.skipped.denied.includes(rel),
        false,
        `${rel} must not be recorded as denied`
      );
    }

    // No operator rules in this env, so the operator-denied fixture file is kept.
    assert.equal(present("x.sql.bak"), true, "kept when no operator rule denies it");

    assert.equal(present("ignored.txt"), false, "ignored file must be absent");
    assert.equal(present(".git"), false, "`.git` must never be copied");

    const expectedDenied = fixture.caseSensitive
      ? [...PLANTED_CREDENTIALS, ENV_FILE_UPPER]
      : PLANTED_CREDENTIALS;
    for (const rel of expectedDenied) {
      assert.equal(present(rel), false, `${rel} must be absent from the copy`);
      assert.ok(workspace.skipped.denied.includes(rel), `${rel} must be recorded as denied`);
    }

    assert.equal(present("link.txt"), false, "symlink must not be copied");
    assert.deepEqual(workspace.skipped.symlinks, ["link.txt"]);

    assert.equal(present("sub"), false, "gitlink must not be copied");
    assert.deepEqual(workspace.skipped.gitlinks, ["sub"]);

    assert.equal(workspace.dir, fs.realpathSync(workspace.dir), "dir must be realpath-resolved");

    workspace.cleanup();
    assert.equal(fs.existsSync(workspace.dir), false, "cleanup must remove the copy");
    workspace.cleanup();
  });

  it("sweeps stale sibling copies and leaves fresh ones", () => {
    const fixture = buildFixtureRepo();
    const tmpRoot = tempDir("agent-flows-tmproot-");
    const now = Date.UTC(2026, 8, 13, 12, 0, 0);
    const staleMs = 60_000;

    const stale = path.join(tmpRoot, "agent-flows-ws-old");
    const fresh = path.join(tmpRoot, "agent-flows-ws-new");
    const unrelated = path.join(tmpRoot, "someone-elses-dir");
    for (const dir of [stale, fresh, unrelated]) fs.mkdirSync(dir, { recursive: true });
    fs.utimesSync(stale, (now - staleMs * 10) / 1000, (now - staleMs * 10) / 1000);
    fs.utimesSync(fresh, now / 1000, now / 1000);
    fs.utimesSync(unrelated, (now - staleMs * 10) / 1000, (now - staleMs * 10) / 1000);

    const workspace = materializeSanitizedWorkspace(fixture.repo, {
      tmpRoot,
      now,
      staleMs,
      env: {},
    });

    assert.equal(fs.existsSync(stale), false, "stale sibling must be swept");
    assert.equal(fs.existsSync(fresh), true, "fresh sibling must survive");
    assert.equal(fs.existsSync(unrelated), true, "unrelated directory must be left alone");
    assert.equal(fs.existsSync(workspace.dir), true, "the new copy must survive its own sweep");

    workspace.cleanup();
  });

  // The two paths must deny the same credential files. Comparing identity, not
  // contents, so this fails the moment the sanitizer stops importing the array
  // the claude flag builder uses and grows a private copy.
  it("denies the very array the claude flag builder imports", () => {
    assert.equal(
      BASE_DENY_PATTERNS,
      CREDENTIAL_DENY_PATTERNS,
      "the sanitizer must use the claude credential deny array itself, not a copy"
    );
  });

  it("honours the operator's own Read/Grep deny rules", () => {
    const fixture = buildFixtureRepo();
    const tmpRoot = tempDir("agent-flows-tmproot-");

    // A USER-level settings file denying one extra glob, plus rule shapes that
    // describe no readable path and must be ignored.
    const home = tempDir("agent-flows-home-");
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    fs.writeFileSync(
      path.join(home, ".claude", "settings.json"),
      JSON.stringify({
        permissions: { deny: ["Read(**/*.sql.bak)", "Bash(rm:*)", "WebFetch(domain:*)"] },
      })
    );

    const workspace = materializeSanitizedWorkspace(fixture.repo, { tmpRoot, env: { HOME: home } });

    assert.equal(
      fs.existsSync(path.join(workspace.dir, "x.sql.bak")),
      false,
      "a file the operator denies reading must not reach the copy"
    );
    assert.ok(
      workspace.skipped.denied.includes("x.sql.bak"),
      `x.sql.bak must be recorded as denied; got: ${workspace.skipped.denied.join(", ")}`
    );
    // The non-path rules must not have removed anything else.
    assert.equal(fs.existsSync(path.join(workspace.dir, "src/index.ts")), true);

    workspace.cleanup();
  });

  it("throws a clear error when the directory is not a git repository", () => {
    const plain = tempDir("agent-flows-plain-");
    assert.throws(
      () => materializeSanitizedWorkspace(plain, { tmpRoot: plain }),
      /not a git repository/
    );
  });
});
