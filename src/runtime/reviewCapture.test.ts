// The capture core's own contract (the daemon's and the plugin's behaviour on hostile
// repositories is pinned in src/af-plugin/captureParity.test.ts and reviewMaterial.test.ts).

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { GitTimeoutError, captureGit, git, resolveSpecRefs } from "./reviewCapture.js";

const cleanups: (() => void)[] = [];
after(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function sh(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_AUTHOR_NAME: "Fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function twoCommitRepo(): { repo: string; base: string } {
  const repo = mkdtempSync(join(tmpdir(), "af-capture-core-"));
  cleanups.push(() => rmSync(repo, { recursive: true, force: true }));
  sh(repo, ["init", "-q", "-b", "main"]);
  writeFileSync(join(repo, "a.txt"), "one\n");
  sh(repo, ["add", "-A"]);
  sh(repo, ["commit", "-q", "-m", "base"]);
  const base = sh(repo, ["rev-parse", "HEAD"]).trim();
  writeFileSync(join(repo, "a.txt"), "one\ntwo\n");
  sh(repo, ["add", "-A"]);
  sh(repo, ["commit", "-q", "-m", "change"]);
  return { repo, base };
}

describe("captureGit", () => {
  it("returns the resolved baseline name beside the one it was given", () => {
    const { repo, base } = twoCommitRepo();
    const capture = captureGit({ projectDir: repo, baseline: base.slice(0, 10) });
    assert.equal(capture.available, true);
    if (!capture.available) return;
    assert.equal(capture.baseline, base.slice(0, 10));
    assert.equal(capture.baselineOid, base);
    assert.match(capture.bodies.diff, /\+two/u);
  });

  it("reports a git timeout as an unavailable capture instead of throwing", () => {
    const { repo, base } = twoCommitRepo();
    const previous = process.env.AF_REVIEW_GIT_TIMEOUT_MS;
    process.env.AF_REVIEW_GIT_TIMEOUT_MS = "1";
    try {
      const capture = captureGit({ projectDir: repo, baseline: base });
      assert.equal(capture.available, false);
      if (capture.available) return;
      assert.equal(capture.timedOut, true);
      assert.match(capture.reason, /timed out/u);
    } finally {
      if (previous === undefined) delete process.env.AF_REVIEW_GIT_TIMEOUT_MS;
      else process.env.AF_REVIEW_GIT_TIMEOUT_MS = previous;
    }
  });
});

describe("GitTimeoutError", () => {
  it("is raised by git() itself, and by the spec-source resolver that reads the origin remote", () => {
    const { repo } = twoCommitRepo();
    const previous = process.env.AF_REVIEW_GIT_TIMEOUT_MS;
    process.env.AF_REVIEW_GIT_TIMEOUT_MS = "1";
    try {
      assert.throws(() => git(repo, ["rev-parse", "HEAD"]), GitTimeoutError);
      // A bare `#7` needs the origin remote, which is a git call.
      assert.throws(
        () => resolveSpecRefs(repo, "#7", () => ({ ok: false, stdout: "", reason: "unused" })),
        GitTimeoutError
      );
    } finally {
      if (previous === undefined) delete process.env.AF_REVIEW_GIT_TIMEOUT_MS;
      else process.env.AF_REVIEW_GIT_TIMEOUT_MS = previous;
    }
  });
});
