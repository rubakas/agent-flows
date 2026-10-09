import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, afterEach, describe, it } from "node:test";
import { captureGitStatus } from "./gateMaterial.js";
import { projectGitStatus } from "./projectGitStatus.js";

const cleanups: (() => void)[] = [];

after(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

afterEach(() => {
  delete process.env.AF_REVIEW_GIT_TIMEOUT_MS;
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
      GIT_CONFIG_GLOBAL: os.devNull,
      GIT_CONFIG_SYSTEM: os.devNull,
    },
  });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
}

/** A repo with one untracked file, so `status --porcelain` has something to say. */
function dirtyRepo(): string {
  const repo = tempDir("af-project-git-status-");
  git(repo, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(repo, "untracked.txt"), "x\n");
  return repo;
}

/** Points the repo's own `core.fsmonitor` at a script that records that it ran. */
function armFsmonitor(repo: string): string {
  const marker = path.join(tempDir("af-fsmonitor-marker-"), "ran");
  const script = path.join(tempDir("af-fsmonitor-script-"), "hook.sh");
  fs.writeFileSync(script, `#!/bin/sh\necho ran >> "${marker}"\n`, { mode: 0o755 });
  git(repo, "config", "core.fsmonitor", script);
  return marker;
}

describe("projectGitStatus", () => {
  it("returns the porcelain status of the project", () => {
    const result = projectGitStatus(dirtyRepo());
    assert.equal(result.status, 0);
    assert.match(result.stdout, /\?\? untracked\.txt/);
  });

  it("does not run a repository-configured core.fsmonitor command", () => {
    const repo = dirtyRepo();
    const marker = armFsmonitor(repo);
    const result = projectGitStatus(repo);
    assert.equal(result.status, 0);
    assert.equal(fs.existsSync(marker), false, "fsmonitor hook must not run");
  });

  it("still answers while .git/index.lock is held (no optional locks)", () => {
    const repo = dirtyRepo();
    git(repo, "add", "untracked.txt");
    fs.writeFileSync(path.join(repo, ".git", "index.lock"), "");
    const result = projectGitStatus(repo);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /A {2}untracked\.txt/);
    assert.equal(fs.existsSync(path.join(repo, ".git", "index.lock")), true);
  });

  it("does not rewrite the index when its stat data is stale (GIT_OPTIONAL_LOCKS=0)", () => {
    const repo = tempDir("af-project-git-status-");
    git(repo, "init", "-q", "-b", "main");
    const file = path.join(repo, "tracked.txt");
    fs.writeFileSync(file, "x\n");
    git(repo, "add", "tracked.txt");
    // Same content, newer mtime: a stock `git status` refreshes and rewrites the index.
    const later = new Date(Date.now() + 5_000);
    fs.utimesSync(file, later, later);
    const before = fs.readFileSync(path.join(repo, ".git", "index"));
    const result = projectGitStatus(repo);
    assert.equal(result.status, 0);
    assert.ok(before.equals(fs.readFileSync(path.join(repo, ".git", "index"))));
  });

  it("reports a timeout as a spawn error, like any other git failure", () => {
    const repo = dirtyRepo();
    git(repo, "config", "core.fsmonitor", "false");
    // Make git slow without relying on machine speed: a 1 ms deadline.
    process.env.AF_REVIEW_GIT_TIMEOUT_MS = "1";
    const result = projectGitStatus(repo);
    assert.ok(result.error, "expected a spawn error");
    assert.equal((result.error as NodeJS.ErrnoException).code, "ETIMEDOUT");
  });
});

describe("captureGitStatus through the helper", () => {
  it("does not run a repository-configured core.fsmonitor command", () => {
    const repo = dirtyRepo();
    const marker = armFsmonitor(repo);
    assert.match(captureGitStatus(repo), /untracked\.txt/);
    assert.equal(fs.existsSync(marker), false, "fsmonitor hook must not run");
  });

  it("keeps the unavailable text when git times out", () => {
    process.env.AF_REVIEW_GIT_TIMEOUT_MS = "1";
    assert.equal(captureGitStatus(dirtyRepo()), "(git status unavailable)");
  });
});
