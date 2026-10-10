// The capture core's own contract (the daemon's and the plugin's behaviour on hostile
// repositories is pinned in src/af-plugin/captureParity.test.ts and reviewMaterial.test.ts).

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { CREDENTIAL_DENY_PATTERNS } from "../canon/credentialPatterns.js";
import {
  CAPTURE_DENY_PATTERNS,
  GitTimeoutError,
  captureGit,
  git,
  resolveSpecRefs,
} from "./reviewCapture.js";

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

describe("CAPTURE_DENY_PATTERNS", () => {
  it("covers every pattern the model's own tools are denied, case-folded, with no case twins", () => {
    const ours = CAPTURE_DENY_PATTERNS.map((pattern) => pattern.toLowerCase());
    for (const pattern of CREDENTIAL_DENY_PATTERNS) {
      assert.ok(
        ours.includes(pattern.toLowerCase()),
        `${pattern} is missing from the capture list`
      );
    }
    // Every pathspec carries `icase`, so an upper-case twin is noise.
    assert.equal(new Set(ours).size, ours.length, "the list has case-variant duplicates");
    assert.deepEqual([...CAPTURE_DENY_PATTERNS], ours, "the list is not case-folded");
  });

  it("adds the dotenv globs, which the model's own list deliberately leaves out", () => {
    // `.env.*` also withholds `.env.example`, which a step may still Read: a pathspec
    // exclusion cannot carve an exception out of a wildcard. The trade is made here
    // once, for both callers of the capture.
    for (const glob of ["**/.env.*", "**/*.env"]) {
      assert.ok(CAPTURE_DENY_PATTERNS.includes(glob), `${glob} is not withheld`);
      assert.ok(!CREDENTIAL_DENY_PATTERNS.includes(glob), `${glob} reached the model's list`);
    }
  });
});
