// The review plugin's git-capture script (plugin/skills/review/scripts/capture.mjs).
//
// It is a trimmed port of src/runtime/reviewMaterial.ts, run by a chat session with
// no daemon in between, so what it must never do is the thing under test: hand a
// credential-shaped file's content to a model, accept a baseline git would read as
// an option, or report a clean tree that has changed. Each negative case below
// builds a real git repository and asserts on the files the CLI wrote.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  ftruncateSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, isAbsolute } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { CREDENTIAL_DENY_PATTERNS as AF_DENY_PATTERNS } from "../canon/denyPatterns.js";

const SCRIPT = fileURLToPath(
  new URL("../../plugin/skills/review/scripts/capture.mjs", import.meta.url)
);

interface GhOutcome {
  ok: boolean;
  stdout: string;
  reason: string;
}

interface SpecSourceResolution {
  literal: boolean;
  text: string;
  full: string;
  notes: string[];
}

// The script is plain ESM outside tsconfig's program, so its surface is declared
// here and the module is loaded by a computed specifier rather than a static import.
interface CaptureModule {
  CREDENTIAL_DENY_PATTERNS: readonly string[];
  REVIEW_MATERIAL_CAP: number;
  rejectBaseline(baseline: unknown): string | undefined;
  parseSpecRef(
    token: string,
    fallback?: { owner: string; repo: string }
  ): string | { owner: string; repo: string; number: string; kind: string; label: string };
  isSafeGithubSegment(segment: string): boolean;
  fetchSpecRef(
    gh: (args: readonly string[]) => GhOutcome & { timedOut?: boolean },
    ref: { owner: string; repo: string; number: string; kind: string; label: string }
  ): unknown;
  snapshotTree(root: string): Record<string, string> | undefined;
  resolveSpecSource(
    projectDir: string,
    value: string,
    gh: (args: readonly string[]) => GhOutcome,
    budget?: { used: number }
  ): SpecSourceResolution;
}

const capture = (await import(pathToFileURL(SCRIPT).href)) as CaptureModule;

// ── Fixtures ─────────────────────────────────────────────────────────────────

const roots: string[] = [];

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

// No global or system git config: a developer's own signing, hooks or default
// branch would otherwise decide whether these tests pass.
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
};

function sh(cwd: string, args: string[], input?: string): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", env: GIT_ENV, input });
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout;
}

function scratch(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `af-capture-${label}-`));
  roots.push(dir);
  return realpathSync(dir);
}

function makeRepo(): string {
  const dir = scratch("repo");
  sh(dir, ["init", "-q", "-b", "main"]);
  sh(dir, ["config", "user.name", "Test"]);
  sh(dir, ["config", "user.email", "test@example.invalid"]);
  sh(dir, ["config", "commit.gpgsign", "false"]);
  return dir;
}

function write(repo: string, path: string, body: string): void {
  const full = join(repo, path);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, body);
}

function commit(repo: string, message: string): string {
  sh(repo, ["add", "-A"]);
  sh(repo, ["commit", "-q", "-m", message]);
  return sh(repo, ["rev-parse", "HEAD"]).trim();
}

/** A repo with a base commit and a second commit that modifies `a.txt`. */
function twoCommitRepo(): { repo: string; base: string; head: string } {
  const repo = makeRepo();
  write(repo, "a.txt", "one\ntwo\nthree\n");
  write(repo, "b.txt", "stable\n");
  const base = commit(repo, "base");
  write(repo, "a.txt", "one\nTWO CHANGED\nthree\n");
  const head = commit(repo, "change a");
  return { repo, base, head };
}

interface CliResult {
  status: number | null;
  stdout: string;
  json: Record<string, unknown>;
}

function cli(
  repo: string,
  args: string[],
  options: { env?: Record<string, string | undefined> } = {}
): CliResult {
  // A timeout so a capture that blocks (a FIFO, a hung git) fails the test
  // instead of hanging the suite.
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: repo,
    encoding: "utf8",
    env: { ...GIT_ENV, ...options.env },
    timeout: 60_000,
  });
  const lines = result.stdout.split("\n").filter((line) => line !== "");
  assert.equal(
    lines.length,
    1,
    `expected ONE line of stdout, got: ${JSON.stringify(result.stdout)}`
  );
  return {
    status: result.status,
    stdout: result.stdout,
    json: JSON.parse(lines[0]) as Record<string, unknown>,
  };
}

function captureOk(
  repo: string,
  args: string[]
): { meta: Record<string, unknown>; runDir: string } {
  const result = cli(repo, args);
  assert.equal(result.status, 0, result.stdout);
  return { meta: result.json, runDir: result.json.runDir as string };
}

const read = (runDir: string, file: string): string => readFileSync(join(runDir, file), "utf8");

// ── Tests ────────────────────────────────────────────────────────────────────

describe("capture.mjs: happy path", () => {
  it("captures base..HEAD, writes the run directory and leaves git status clean", () => {
    const { repo, base, head } = twoCommitRepo();
    const { meta, runDir } = captureOk(repo, ["--base", base]);

    assert.match(meta.runId as string, /^\d{8}-\d{6}-[0-9a-f]{7}-[0-9a-f]{4}$/u);
    assert.ok((meta.runId as string).includes(`-${head.slice(0, 7)}-`));
    assert.ok(isAbsolute(runDir));
    assert.equal(runDir, join(repo, ".af-review", meta.runId as string));
    assert.equal(meta.baseline, base);
    assert.equal(meta.baselineRule, "caller");
    assert.equal(meta.head, head);
    assert.equal(meta.hasSpecs, false);
    assert.equal("specSourcesProvided" in meta, false);
    assert.deepEqual(meta.truncated, {
      diff: false,
      commits: false,
      changedFiles: false,
      history: false,
    });
    assert.deepEqual(meta.withheld, []);
    assert.deepEqual(JSON.parse(read(runDir, "meta.json")), meta);

    const material = read(runDir, "material.md");
    assert.ok(material.includes(`## baseline\n${base}\nsupplied by the caller`));
    assert.ok(material.includes(`## diff (full: ${join(runDir, "diff.patch")})`));
    assert.ok(material.includes("+TWO CHANGED"));
    assert.ok(material.includes("change a"));
    assert.ok(material.includes("## changed files"));
    assert.ok(material.includes("## history probes"));

    assert.ok(read(runDir, "diff.patch").includes("+TWO CHANGED"));
    assert.ok(read(runDir, "commits.txt").includes("change a"));
    assert.equal(read(runDir, "changed-files.txt"), "a.txt\n");
    assert.ok(existsSync(join(runDir, "history.txt")));
    assert.deepEqual(JSON.parse(read(runDir, "tree-before.json")), {});

    assert.equal(read(join(repo, ".af-review"), ".gitignore").trim(), "*");
    assert.equal(sh(repo, ["status", "--porcelain"]), "");
  });

  it("prints exactly the meta.json it wrote, on one line", () => {
    const { repo, base } = twoCommitRepo();
    const result = cli(repo, ["--base", base]);
    assert.equal(result.stdout.trim().split("\n").length, 1);
    assert.deepEqual(result.json, JSON.parse(read(result.json.runDir as string, "meta.json")));
  });
});

describe("capture.mjs: credential policy", () => {
  it("withholds a .env added in the range: path only, content nowhere", () => {
    const { repo, base } = twoCommitRepo();
    write(repo, ".env", "API_KEY=hunter2-env-payload\n");
    write(repo, "config/.env.production", "DB_PASSWORD=hunter2-nested-payload\n");
    write(repo, "a.txt", "one\nTWO CHANGED AGAIN\nthree\n");
    commit(repo, "add env files");

    const { meta, runDir } = captureOk(repo, ["--base", base]);
    assert.deepEqual([...(meta.withheld as string[])].sort(), [".env", "config/.env.production"]);

    for (const file of [
      "diff.patch",
      "material.md",
      "changed-files.txt",
      "history.txt",
      "commits.txt",
    ]) {
      const body = read(runDir, file);
      assert.ok(!body.includes("hunter2"), `${file} carries credential content`);
    }
    const material = read(runDir, "material.md");
    assert.ok(material.includes("## withheld by credential policy (2 path(s))"));
    assert.ok(material.includes("+TWO CHANGED AGAIN"));
  });

  it("withholds a file renamed to secrets.json: neither half's content appears", () => {
    const repo = makeRepo();
    write(repo, "a.txt", "one\n");
    write(repo, "plain.txt", "rename-payload-9f3a line one\nrename-payload-9f3a line two\n");
    const base = commit(repo, "base");
    sh(repo, ["mv", "plain.txt", "secrets.json"]);
    write(repo, "a.txt", "one\nmore\n");
    commit(repo, "rename into a denied name");

    const { meta, runDir } = captureOk(repo, ["--base", base]);
    assert.deepEqual([...(meta.withheld as string[])].sort(), ["plain.txt", "secrets.json"]);
    for (const file of ["diff.patch", "material.md", "changed-files.txt", "history.txt"]) {
      assert.ok(!read(runDir, file).includes("rename-payload-9f3a"), `${file} leaked the content`);
    }
    assert.ok(read(runDir, "diff.patch").includes("+more"));
  });

  it("withholds the new name when a denied file is renamed OUT of its name", () => {
    const repo = makeRepo();
    write(repo, "a.txt", "one\n");
    write(repo, ".env", "OUT-payload-77c1 first\nOUT-payload-77c1 second\n");
    const base = commit(repo, "base");
    sh(repo, ["mv", ".env", "innocent.txt"]);
    write(repo, "a.txt", "one\nmore\n");
    commit(repo, "rename out of a denied name");

    const { meta, runDir } = captureOk(repo, ["--base", base]);
    assert.deepEqual([...(meta.withheld as string[])].sort(), [".env", "innocent.txt"]);
    for (const file of ["diff.patch", "material.md", "changed-files.txt", "history.txt"]) {
      assert.ok(!read(runDir, file).includes("OUT-payload-77c1"), `${file} leaked the content`);
    }
  });

  it("refuses an empty diff and names the withheld paths as the reason", () => {
    const repo = makeRepo();
    write(repo, "a.txt", "one\n");
    const base = commit(repo, "base");
    write(repo, ".env", "ONLY=secret\n");
    commit(repo, "only a credential file");

    const result = cli(repo, ["--base", base]);
    assert.equal(result.status, 2);
    assert.equal(result.json.ok, false);
    assert.match(result.json.reason as string, /withheld/u);
  });
});

describe("capture.mjs: baseline validation", () => {
  for (const baseline of ["--upload-pack=x", "-x"]) {
    it(`rejects ${baseline} before git sees it`, () => {
      const { repo } = twoCommitRepo();
      const result = cli(repo, ["--base", baseline]);
      assert.equal(result.status, 2);
      assert.equal(result.json.ok, false);
      assert.match(result.json.reason as string, /starts with "-"/u);
      assert.equal(existsSync(join(repo, ".af-review")), false);
    });
  }

  it("rejects a nonexistent ref", () => {
    const { repo } = twoCommitRepo();
    const result = cli(repo, ["--base", "no-such-branch"]);
    assert.equal(result.status, 2);
    assert.equal(result.json.ok, false);
    assert.match(result.json.reason as string, /does not resolve to a commit/u);
  });

  it("rejects characters outside the revision alphabet and over-long names", () => {
    assert.match(capture.rejectBaseline("a b") ?? "", /not a valid revision name/u);
    assert.match(capture.rejectBaseline("x=y") ?? "", /not a valid revision name/u);
    assert.match(capture.rejectBaseline("a".repeat(257)) ?? "", /longer than 256/u);
    assert.equal(capture.rejectBaseline("origin/main~2^"), undefined);
  });

  it("refuses outside a git work tree", () => {
    const result = cli(scratch("nogit"), []);
    assert.equal(result.status, 2);
    assert.equal(result.json.ok, false);
    assert.match(result.json.reason as string, /git work tree/u);
  });

  it("refuses an empty diff", () => {
    const repo = makeRepo();
    write(repo, "a.txt", "one\n");
    const first = commit(repo, "base");
    sh(repo, ["commit", "-q", "--allow-empty", "-m", "empty"]);
    const result = cli(repo, ["--base", first]);
    assert.equal(result.status, 2);
    assert.match(result.json.reason as string, /empty/u);
  });
});

describe("capture.mjs: derived baseline", () => {
  it("uses the merge-base with the origin default branch when there is one", () => {
    const origin = scratch("origin");
    sh(origin, ["init", "-q", "--bare", "-b", "main"]);

    const repo = makeRepo();
    write(repo, "a.txt", "one\n");
    const trunk = commit(repo, "trunk");
    sh(repo, ["remote", "add", "origin", origin]);
    sh(repo, ["push", "-q", "origin", "main"]);
    sh(repo, ["remote", "set-head", "origin", "main"]);
    sh(repo, ["checkout", "-q", "-b", "feature"]);
    write(repo, "a.txt", "one\ntwo\n");
    commit(repo, "feature 1");
    write(repo, "a.txt", "one\ntwo\nthree\n");
    commit(repo, "feature 2");

    const { meta, runDir } = captureOk(repo, []);
    assert.equal(meta.baselineRule, "merge-base");
    assert.equal(meta.baseline, trunk);
    assert.ok(read(runDir, "material.md").includes("merge-base of HEAD"));
    assert.ok(read(runDir, "commits.txt").includes("feature 1"));
  });

  it("falls back to HEAD~1 without an origin", () => {
    const { repo, base } = twoCommitRepo();
    const { meta, runDir } = captureOk(repo, []);
    assert.equal(meta.baselineRule, "previous-commit");
    assert.equal(meta.baseline, base);
    assert.ok(read(runDir, "material.md").includes("so HEAD~1 was used"));
  });

  it("explains itself when there is nothing to derive from", () => {
    const repo = makeRepo();
    write(repo, "a.txt", "one\n");
    commit(repo, "only commit");
    const result = cli(repo, []);
    assert.equal(result.status, 2);
    assert.match(result.json.reason as string, /none could be derived/u);
  });
});

describe("capture.mjs: capping", () => {
  it("caps a >64 KB diff in material.md and keeps it whole in diff.patch", () => {
    const { repo, base } = twoCommitRepo();
    const lines = Array.from({ length: 3000 }, (_, i) => `line ${String(i)} ${"x".repeat(40)}`);
    write(repo, "big.txt", lines.join("\n") + "\n");
    commit(repo, "big file");

    const { meta, runDir } = captureOk(repo, ["--base", base]);
    assert.equal((meta.truncated as Record<string, boolean>).diff, true);
    assert.equal((meta.truncated as Record<string, boolean>).commits, false);

    const diffPath = join(runDir, "diff.patch");
    // Only material.md is capped: diff.patch is byte-for-byte what git printed.
    assert.equal(read(runDir, "diff.patch"), sh(repo, ["diff", `${base}...HEAD`]));
    assert.ok(read(runDir, "diff.patch").length > capture.REVIEW_MATERIAL_CAP);
    const material = read(runDir, "material.md");
    assert.ok(material.includes(`## diff (truncated — full: ${diffPath})`));
    assert.ok(material.includes("[TRUNCATED]"));
    assert.ok(!material.includes("line 2999"));
    assert.ok(read(runDir, "diff.patch").includes("line 2999"));
  });
});

describe("capture.mjs: run directory and layout", () => {
  it("gives back-to-back captures different run directories", () => {
    const { repo, base } = twoCommitRepo();
    const runDirs = new Set<string>();
    for (let i = 0; i < 4; i += 1) runDirs.add(captureOk(repo, ["--base", base]).runDir);
    assert.equal(runDirs.size, 4);
    for (const runDir of runDirs) assert.ok(existsSync(join(runDir, "meta.json")));
  });

  it("writes .af-review at the toplevel when run from a subdirectory", () => {
    const { repo, base } = twoCommitRepo();
    const sub = join(repo, "nested", "deeper");
    mkdirSync(sub, { recursive: true });

    const { runDir } = captureOk(sub, ["--base", base]);
    assert.ok(runDir.startsWith(join(repo, ".af-review") + "/"), runDir);
    assert.equal(existsSync(join(sub, ".af-review")), false);
    assert.equal(existsSync(join(repo, "nested", ".af-review")), false);

    write(repo, "a.txt", "one\nedited\nthree\n");
    assert.deepEqual(cli(sub, ["check-tree", runDir]).json, { changed: ["a.txt"] });
  });

  it("orders material.md as af's renderReviewMaterial does, withheld last", () => {
    const { repo, base } = twoCommitRepo();
    write(repo, ".env", "K=v\n");
    commit(repo, "env");
    const spec = join(scratch("order"), "spec.txt");
    writeFileSync(spec, "the spec\n");

    const { runDir } = captureOk(repo, ["--base", base, "--spec-file", spec]);
    const headings = [...read(runDir, "material.md").matchAll(/^## ([a-z ]+?)(?: \(.*)?$/gmu)].map(
      (match) => match[1]
    );
    assert.deepEqual(headings, [
      "baseline",
      "spec sources",
      "diff",
      "commits",
      "changed files",
      "history probes",
      "withheld by credential policy",
    ]);
  });

  it("runs no diff.external or textconv command and still shows the real patch", () => {
    const { repo, base } = twoCommitRepo();
    const marker = join(scratch("marker"), "ran");
    const driver = join(scratch("driver"), "driver.sh");
    writeFileSync(driver, `#!/bin/sh\ntouch '${marker}'\necho FAKE-EXTERNAL-DIFF\n`, {
      mode: 0o755,
    });
    sh(repo, ["config", "diff.external", driver]);
    write(repo, ".gitattributes", "*.txt diff=sneaky\n");
    sh(repo, ["config", "diff.sneaky.textconv", driver]);
    write(repo, "a.txt", "one\nTWO CHANGED\nthree\nfour\n");
    commit(repo, "touch a again");

    const { runDir } = captureOk(repo, ["--base", base]);
    assert.equal(existsSync(marker), false, "a configured diff driver ran");
    const diff = read(runDir, "diff.patch");
    assert.ok(diff.includes("+four"));
    assert.ok(!diff.includes("FAKE-EXTERNAL-DIFF"));
  });
});

describe("capture.mjs: spec sources and plan", () => {
  it("takes literal spec text from --spec-file, verbatim, and copies the plan file", () => {
    const { repo, base } = twoCommitRepo();
    const dir = scratch("plan");
    const plan = join(dir, "plan.md");
    const specA = join(dir, "a.txt");
    const specB = join(dir, "b.txt");
    writeFileSync(plan, "# the plan\n");
    // `#12` inside a file is text, not a reference: no gh call may follow from it.
    writeFileSync(specA, "Add a retry to the fetch; see #12 $(touch pwned) `x`\n");
    writeFileSync(specB, "second source\n");

    const { meta, runDir } = captureOk(repo, [
      "--base",
      base,
      "--spec-file",
      specA,
      "--spec-file",
      specB,
      "--plan-file",
      plan,
    ]);
    assert.equal(meta.hasSpecs, true);
    assert.equal(
      read(runDir, "specs/1.md"),
      "Add a retry to the fetch; see #12 $(touch pwned) `x`\n"
    );
    assert.equal(read(runDir, "specs/2.md"), "second source\n");
    assert.equal(read(runDir, "plan.md"), "# the plan\n");
    const material = read(runDir, "material.md");
    assert.ok(material.includes("## spec sources (literal text — full:"));
    assert.ok(material.includes("Add a retry to the fetch"));
    assert.ok(material.indexOf("## spec sources") < material.indexOf("## diff"));
  });

  it("rejects a --spec value that is not a GitHub ref, before anything is written", () => {
    const { repo, base } = twoCommitRepo();
    for (const text of ["none", "Add a retry to the fetch", "o/r#1 please", ""]) {
      const result = cli(repo, ["--base", base, "--spec", text]);
      assert.equal(result.status, 2, text);
      assert.deepEqual(result.json, {
        ok: false,
        reason: "--spec takes a GitHub ref; pass literal text with --spec-file",
      });
    }
    assert.equal(existsSync(join(repo, ".af-review")), false);
  });

  it("hasSpecs is false when the only source is an empty file", () => {
    const { repo, base } = twoCommitRepo();
    const empty = join(scratch("spec"), "empty.txt");
    writeFileSync(empty, "  \n");
    const { meta, runDir } = captureOk(repo, ["--base", base, "--spec-file", empty]);
    assert.equal(meta.hasSpecs, false);
    assert.equal(existsSync(join(runDir, "specs", "1.md")), false);
    assert.ok(!read(runDir, "material.md").includes("## spec sources"));
  });

  it("refuses an unreadable spec file", () => {
    const { repo, base } = twoCommitRepo();
    const result = cli(repo, ["--base", base, "--spec-file", join(repo, "missing.txt")]);
    assert.equal(result.status, 2);
    assert.match(result.json.reason as string, /spec file unreadable/u);
  });

  it("refuses an unreadable plan file", () => {
    const { repo, base } = twoCommitRepo();
    const result = cli(repo, ["--base", base, "--plan-file", join(repo, "missing.md")]);
    assert.equal(result.status, 2);
    assert.match(result.json.reason as string, /plan file unreadable/u);
  });

  it("refuses an unknown flag and a flag with no value", () => {
    const { repo } = twoCommitRepo();
    assert.equal(cli(repo, ["--nope", "x"]).status, 2);
    assert.equal(cli(repo, ["--base"]).status, 2);
  });

  it("parseSpecRef accepts github.com refs and refuses everything else by name", () => {
    assert.deepEqual(capture.parseSpecRef("https://github.com/o/r/pull/12"), {
      owner: "o",
      repo: "r",
      number: "12",
      kind: "pull",
      label: "o/r#12",
    });
    assert.equal(
      (capture.parseSpecRef("o/r#5") as { kind: string }).kind,
      "unknown",
      "a short ref does not say whether it is a PR or an issue"
    );
    for (const hostile of [
      "https://evil.example/o/r/pull/1",
      "https://github.com.evil.example/o/r/pull/1",
      "https://github.com/-o/r/pull/1",
      "https://github.com/o/r/pull/12345678901",
      "http://github.com/o/r/pull/1",
      "-o/r#1",
      "o/../x#1",
      "o/r#1x",
    ]) {
      assert.equal(typeof capture.parseSpecRef(hostile), "string", `${hostile} was accepted`);
    }
    assert.match(capture.parseSpecRef("#7") as string, /no github.com origin remote/u);
    assert.deepEqual(capture.parseSpecRef("#7", { owner: "o", repo: "r" }), {
      owner: "o",
      repo: "r",
      number: "7",
      kind: "unknown",
      label: "o/r#7",
    });
    assert.equal(capture.isSafeGithubSegment("-x"), false);
    assert.equal(capture.isSafeGithubSegment(".."), false);
  });

  it("resolveSpecSource refuses a non-ref token by name, never reaching gh, and caps the fetches", () => {
    const calls: string[][] = [];
    const gh = (args: readonly string[]): GhOutcome => {
      calls.push([...args]);
      return { ok: false, stdout: "", reason: "offline" };
    };

    const refused = capture.resolveSpecSource(process.cwd(), "implement the thing", gh);
    assert.equal(refused.full, "");
    assert.ok(refused.notes.some((note) => note.includes("not a GitHub reference")));
    assert.deepEqual(calls, []);

    const refs = Array.from({ length: 12 }, (_, i) => `o/r#${String(i + 1)}`).join(" ");
    const resolved = capture.resolveSpecSource(process.cwd(), refs, gh, { used: 0 });
    assert.equal(resolved.literal, false);
    // pr view then issue view per ref, until the 10-fetch budget is spent.
    assert.equal(calls.length, 20);
    assert.deepEqual(calls[0], ["pr", "view", "1", "--repo", "o/r", "--json", "title,body,url"]);
    assert.deepEqual(calls[1], ["issue", "view", "1", "--repo", "o/r", "--json", "title,body,url"]);
    assert.ok(resolved.notes.some((note) => note.startsWith("stopped at the cap of 10")));
  });
});

describe("capture.mjs check-tree", () => {
  it("lists changed, added and deleted paths, never .af-review, and [] when nothing moved", () => {
    const { repo, base } = twoCommitRepo();
    const { runDir } = captureOk(repo, ["--base", base]);

    assert.deepEqual(cli(repo, ["check-tree", runDir]).json, { changed: [] });

    // The directory's own .gitignore already hides it from git; remove it so the
    // snapshot's own exclusion is what keeps these writes out of the answer.
    rmSync(join(repo, ".af-review", ".gitignore"));
    write(repo, ".af-review/scratch.txt", "written by the review itself\n");
    assert.ok(sh(repo, ["status", "--porcelain", "-uall"]).includes(".af-review/scratch.txt"));
    assert.deepEqual(cli(repo, ["check-tree", runDir]).json, { changed: [] });

    write(repo, "a.txt", "one\nedited after the capture\nthree\n");
    write(repo, "brand-new.txt", "untracked\n");
    rmSync(join(repo, "b.txt"));
    const after = cli(repo, ["check-tree", runDir]);
    assert.equal(after.status, 0);
    assert.deepEqual(after.json, { changed: ["a.txt", "b.txt", "brand-new.txt"] });
  });

  it("ignores a path that was already dirty at capture time until it changes again", () => {
    const { repo, base } = twoCommitRepo();
    write(repo, "a.txt", "dirty before the capture\n");
    const { runDir } = captureOk(repo, ["--base", base]);
    assert.ok("a.txt" in (JSON.parse(read(runDir, "tree-before.json")) as object));
    assert.deepEqual(cli(repo, ["check-tree", runDir]).json, { changed: [] });

    write(repo, "a.txt", "dirty again, differently\n");
    assert.deepEqual(cli(repo, ["check-tree", runDir]).json, { changed: ["a.txt"] });
  });

  it("refuses a run directory with no snapshot", () => {
    const { repo } = twoCommitRepo();
    const result = cli(repo, ["check-tree", join(repo, "nowhere")]);
    assert.equal(result.status, 2);
    assert.equal(result.json.ok, false);
  });
});

describe("capture.mjs: deny-list pin", () => {
  it("covers every pattern of src/canon/denyPatterns.ts, case-folded, and adds no case duplicates", () => {
    const ours = capture.CREDENTIAL_DENY_PATTERNS.map((pattern) => pattern.toLowerCase());
    for (const pattern of AF_DENY_PATTERNS) {
      assert.ok(ours.includes(pattern.toLowerCase()), `${pattern} is missing from the plugin list`);
    }
    // Matching is case-insensitive (icase), so a hand-written UPPERCASE twin is noise.
    assert.equal(new Set(ours).size, ours.length, "the list has case-variant duplicates");
  });
});

// ── Security audit regressions ───────────────────────────────────────────────

/** Adds blobs under exact names without touching the filesystem (so case variants coexist). */
function commitBlobs(repo: string, names: string[]): Map<string, string> {
  const markers = new Map<string, string>();
  names.forEach((name, index) => {
    const marker = `LEAKMARK${String(index)}`;
    const oid = sh(repo, ["hash-object", "-w", "--stdin"], `${marker}\n`).trim();
    sh(repo, ["update-index", "--add", "--cacheinfo", `100644,${oid},${name}`]);
    markers.set(name, marker);
  });
  sh(repo, ["commit", "-q", "-m", "add blobs"]);
  return markers;
}

function assertWithheldAndAbsent(repo: string, base: string, markers: Map<string, string>): void {
  const { meta, runDir } = captureOk(repo, ["--base", base]);
  for (const [name, marker] of markers) {
    assert.ok((meta.withheld as string[]).includes(name), `${name} was not withheld`);
    for (const file of ["diff.patch", "material.md", "changed-files.txt", "history.txt"]) {
      assert.ok(!read(runDir, file).includes(marker), `${file} leaked the content of ${name}`);
    }
  }
}

describe("capture.mjs: audit H1 planted symlinks", () => {
  it("refuses a committed .af-review symlink and writes nothing through it", () => {
    const { repo, base } = twoCommitRepo();
    const target = scratch("link-target");
    symlinkSync(target, join(repo, ".af-review"));
    commit(repo, "plant the link");

    const result = cli(repo, ["--base", base]);
    assert.equal(result.status, 2);
    assert.match(result.json.reason as string, /\.af-review/u);
    assert.deepEqual(readdirSync(target), []);
  });

  it("refuses an untracked .af-review symlink and writes nothing through it", () => {
    const { repo, base } = twoCommitRepo();
    const target = scratch("link-target");
    symlinkSync(target, join(repo, ".af-review"));

    const result = cli(repo, ["--base", base]);
    assert.equal(result.status, 2);
    assert.match(result.json.reason as string, /\.af-review/u);
    assert.deepEqual(readdirSync(target), []);
  });

  it("refuses a tracked .af-review/.gitignore symlink and leaves the victim untouched", () => {
    const { repo, base } = twoCommitRepo();
    const victim = join(scratch("victim"), "important.txt");
    writeFileSync(victim, "do not overwrite\n");
    mkdirSync(join(repo, ".af-review"));
    symlinkSync(victim, join(repo, ".af-review", ".gitignore"));
    sh(repo, ["add", "-f", ".af-review/.gitignore"]);
    sh(repo, ["commit", "-q", "-m", "plant the gitignore link"]);

    const result = cli(repo, ["--base", base]);
    assert.equal(result.status, 2);
    assert.equal(readFileSync(victim, "utf8"), "do not overwrite\n");
  });

  it("refuses an untracked .af-review/.gitignore symlink and leaves the victim untouched", () => {
    const { repo, base } = twoCommitRepo();
    const victim = join(scratch("victim"), "important.txt");
    writeFileSync(victim, "do not overwrite\n");
    mkdirSync(join(repo, ".af-review"));
    symlinkSync(victim, join(repo, ".af-review", ".gitignore"));

    const result = cli(repo, ["--base", base]);
    assert.equal(result.status, 2);
    assert.match(result.json.reason as string, /\.gitignore/u);
    assert.equal(readFileSync(victim, "utf8"), "do not overwrite\n");
  });
});

describe("capture.mjs: audit H2 rename limit", () => {
  it("fails closed when rename detection is skipped and a denied path is in the range", () => {
    const repo = makeRepo();
    const denied = capture.CREDENTIAL_DENY_PATTERNS[0].replace(/^\*\*\//u, "");
    const body = Array.from(
      { length: 40 },
      (_, i) => `RENAMELEAK${String(i)} padding ${String(i)}`
    );
    write(repo, denied, body.join("\n") + "\n");
    for (let i = 0; i < 1100; i += 1)
      write(repo, `f/old${String(i)}.txt`, `old ${String(i)} `.repeat(20));
    const base = commit(repo, "base");

    sh(repo, ["mv", denied, "notes.txt"]);
    write(repo, "notes.txt", body.join("\n").replace("RENAMELEAK3 ", "RENAMELEAK3-edited ") + "\n");
    for (let i = 0; i < 1100; i += 1) {
      rmSync(join(repo, `f/old${String(i)}.txt`));
      write(repo, `f/new${String(i)}.txt`, `new different ${String(i)} `.repeat(20));
    }
    commit(repo, "rename with one line changed, among many other changes");

    const result = cli(repo, ["--base", base]);
    assert.equal(result.status, 2);
    assert.match(result.json.reason as string, /rename detection/u);
    assert.equal(existsSync(join(repo, ".af-review")), false);
  });
});

describe("capture.mjs: audit M3 case variants", () => {
  it("withholds case variants of denied names", () => {
    const { repo, base } = twoCommitRepo();
    const markers = commitBlobs(repo, [
      ".ENV",
      "Credentials.json",
      "SECRETS.JSON",
      "ID_RSA",
      "config/.SSH/known",
      "Server.Pem",
      "Terraform.TFVARS",
    ]);
    assertWithheldAndAbsent(repo, base, markers);
  });
});

describe("capture.mjs: audit M4 diff attributes", () => {
  for (const attributes of ["* -diff\n", "* binary\n"]) {
    it(`still shows the source change under ${JSON.stringify(attributes)}`, () => {
      const { repo, base } = twoCommitRepo();
      write(repo, ".gitattributes", attributes);
      write(repo, "a.txt", "one\nTWO CHANGED AGAIN\nthree\n");
      commit(repo, "hide the diff with attributes");

      const { runDir } = captureOk(repo, ["--base", base]);
      assert.ok(read(runDir, "diff.patch").includes("+TWO CHANGED AGAIN"));
    });
  }
});

describe("capture.mjs: audit M5 input files", () => {
  const rejected = (repo: string, base: string, flag: string, file: string) => {
    const result = cli(repo, ["--base", base, flag, file]);
    assert.equal(result.status, 2, `${file} was accepted`);
    assert.equal(result.json.ok, false);
    assert.equal(existsSync(join(repo, ".af-review")), false);
    return result.json.reason as string;
  };

  for (const flag of ["--spec-file", "--plan-file"]) {
    it(`${flag} rejects a readable file outside the repository and the temp directory`, () => {
      const { repo, base } = twoCommitRepo();
      assert.match(rejected(repo, base, flag, "/etc/hosts"), /outside/u);
    });

    it(`${flag} rejects a deny-list-named file even in the temp directory`, () => {
      const { repo, base } = twoCommitRepo();
      const deniedName = capture.CREDENTIAL_DENY_PATTERNS[0].replace(/^\*\*\//u, "");
      const file = join(scratch("denied"), deniedName);
      writeFileSync(file, "TOKEN=abc\n");
      assert.match(rejected(repo, base, flag, file), /credential/u);

      const dir = scratch("denied-dir");
      mkdirSync(join(dir, ".ssh"));
      writeFileSync(join(dir, ".ssh", "notes.txt"), "innocent name, denied directory\n");
      assert.match(rejected(repo, base, flag, join(dir, ".ssh", "notes.txt")), /credential/u);
    });

    it(`${flag} rejects a symlink that resolves to a denied or outside file`, () => {
      const { repo, base } = twoCommitRepo();
      const dir = scratch("sym");
      symlinkSync("/etc/hosts", join(dir, "innocent.txt"));
      assert.match(rejected(repo, base, flag, join(dir, "innocent.txt")), /outside/u);
    });

    it(`${flag} rejects a FIFO without hanging`, () => {
      const { repo, base } = twoCommitRepo();
      const fifo = join(scratch("fifo"), "pipe");
      const made = spawnSync("mkfifo", [fifo]);
      assert.equal(made.status, 0);
      assert.match(rejected(repo, base, flag, fifo), /regular file/u);
    });

    it(`${flag} rejects a file over 1 MB`, () => {
      const { repo, base } = twoCommitRepo();
      const big = join(scratch("big"), "big.txt");
      writeFileSync(big, "x".repeat(1024 * 1024 + 1));
      assert.match(rejected(repo, base, flag, big), /larger than/u);
    });
  }
});

describe("capture.mjs: audit M6 deny-list gaps", () => {
  it("withholds dotenv variants, cloud-tool auth files and registry credentials", () => {
    const { repo, base } = twoCommitRepo();
    const markers = commitBlobs(repo, [
      ".env.production.local",
      ".env.qa",
      "app.env",
      ".git-credentials",
      ".pypirc",
      ".docker/config.json",
      ".dockercfg",
    ]);
    assertWithheldAndAbsent(repo, base, markers);
  });
});

describe("capture.mjs: audit L7 git hardening", () => {
  it("never runs a repo-local core.fsmonitor command", () => {
    const { repo, base } = twoCommitRepo();
    const marker = join(scratch("fsmonitor"), "ran");
    const hook = join(scratch("fsmonitor-hook"), "hook.sh");
    writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
    sh(repo, ["config", "core.fsmonitor", hook]);
    write(repo, "untracked.txt", "x\n");

    const { runDir } = captureOk(repo, ["--base", base]);
    cli(repo, ["check-tree", runDir]);
    assert.equal(existsSync(marker), false, "core.fsmonitor ran");
  });
});

describe("capture.mjs: audit L8/L9 snapshot", () => {
  it("records a file over 64 MB by size and mtime instead of reading it", () => {
    const { repo } = twoCommitRepo();
    const fd = openSync(join(repo, "huge.bin"), "w");
    ftruncateSync(fd, 65 * 1024 * 1024);
    closeSync(fd);
    const snapshot = capture.snapshotTree(repo);
    assert.ok(snapshot !== undefined);
    assert.match(snapshot["huge.bin"], /^size:\d+:mtime:\d+$/u);
  });

  it("tracks a file literally named __proto__", () => {
    const { repo, base } = twoCommitRepo();
    write(repo, "__proto__", "first\n");
    const { runDir } = captureOk(repo, ["--base", base]);
    assert.ok(Object.hasOwn(JSON.parse(read(runDir, "tree-before.json")) as object, "__proto__"));
    assert.deepEqual(cli(repo, ["check-tree", runDir]).json, { changed: [] });

    write(repo, "__proto__", "second\n");
    assert.deepEqual(cli(repo, ["check-tree", runDir]).json, { changed: ["__proto__"] });
  });
});

describe("capture.mjs: audit L11 control characters", () => {
  it("renders a path with an embedded newline and a fake heading on one line", () => {
    const { repo, base } = twoCommitRepo();
    write(repo, "x\n## injected heading.txt", "body\n");
    commit(repo, "add odd name");

    const { runDir } = captureOk(repo, ["--base", base]);
    for (const file of ["material.md", "changed-files.txt", "history.txt"]) {
      assert.ok(!/^## injected/mu.test(read(runDir, file)), `${file} carries a forged heading`);
    }
    assert.ok(read(runDir, "changed-files.txt").includes("x\\u000a## injected heading.txt"));
    assert.ok(read(runDir, "material.md").includes("x\\u000a## injected heading.txt"));
  });

  it("escapes control characters in a commit subject", () => {
    const { repo, base } = twoCommitRepo();
    write(repo, "c.txt", "c\n");
    commit(repo, "red \u001b[31mALERT\u001b[0m subject");

    const { runDir } = captureOk(repo, ["--base", base]);
    for (const file of ["material.md", "commits.txt", "history.txt"]) {
      const body = read(runDir, file);
      assert.ok(!body.includes("\u001b"), `${file} carries a raw escape character`);
    }
    assert.ok(read(runDir, "commits.txt").includes("\\u001b[31mALERT"));
  });
});

describe("capture.mjs: audit L12 timeout", () => {
  it("exits 2 with a reason when git does not answer in time", () => {
    const { repo } = twoCommitRepo();
    const realGit = spawnSync("which", ["git"], { encoding: "utf8" }).stdout.trim();
    const bin = scratch("fakebin");
    writeFileSync(
      join(bin, "git"),
      `#!/bin/sh\ncase "$*" in *show-toplevel*) exec sleep 5;; esac\nexec '${realGit}' "$@"\n`,
      { mode: 0o755 }
    );
    const result = cli(repo, [], {
      env: { PATH: `${bin}:${process.env.PATH ?? ""}`, AF_REVIEW_GIT_TIMEOUT_MS: "500" },
    });
    assert.equal(result.status, 2);
    assert.match(result.json.reason as string, /timed out/u);
  });
});

// ── Security re-audit follow-ups ─────────────────────────────────────────────

describe("capture.mjs: re-audit N1 localized git output", () => {
  it("treats ANY stderr from the rename pass as incomplete when a denied path changed", () => {
    const { repo, base } = twoCommitRepo();
    write(repo, ".env", "K=v\n");
    commit(repo, "env");
    const realGit = spawnSync("which", ["git"], { encoding: "utf8" }).stdout.trim();
    const bin = scratch("fakebin-l10n");
    // A translated warning: no English "rename detection was skipped" in it.
    writeFileSync(
      join(bin, "git"),
      `#!/bin/sh\n'${realGit}' "$@"\nstatus=$?\ncase "$*" in *"--name-status -M"*) echo "avertissement : la detection des renommages a ete ignoree" >&2;; esac\nexit $status\n`,
      { mode: 0o755 }
    );
    const result = cli(repo, ["--base", base], {
      env: { PATH: `${bin}:${process.env.PATH ?? ""}` },
    });
    assert.equal(result.status, 2);
    assert.match(result.json.reason as string, /rename detection/u);
  });
});

describe("capture.mjs: re-audit N2 .git inside input paths", () => {
  for (const flag of ["--spec-file", "--plan-file"]) {
    it(`${flag} rejects a path with a .git segment`, () => {
      const { repo, base } = twoCommitRepo();
      const result = cli(repo, ["--base", base, flag, ".git/config"]);
      assert.equal(result.status, 2);
      assert.match(result.json.reason as string, /\.git/u);
      assert.equal(existsSync(join(repo, ".af-review")), false);
    });
  }
});

describe("capture.mjs: re-audit N3 .gitignore is never rewritten", () => {
  it("leaves an existing regular .af-review/.gitignore exactly as it is", () => {
    const { repo, base } = twoCommitRepo();
    mkdirSync(join(repo, ".af-review"));
    writeFileSync(join(repo, ".af-review", ".gitignore"), "custom\n");
    const { runDir } = captureOk(repo, ["--base", base]);
    assert.ok(existsSync(runDir));
    assert.equal(readFileSync(join(repo, ".af-review", ".gitignore"), "utf8"), "custom\n");
  });
});

describe("capture.mjs: re-audit gh timeout", () => {
  it("does not try `gh issue view` after `gh pr view` timed out", () => {
    const calls: string[][] = [];
    const gh = (args: readonly string[]) => {
      calls.push([...args]);
      return { ok: false, stdout: "", reason: "gh timed out", timedOut: true };
    };
    const outcome = capture.fetchSpecRef(gh, {
      owner: "o",
      repo: "r",
      number: "5",
      kind: "unknown",
      label: "o/r#5",
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], "pr");
    assert.equal(typeof outcome, "string");
    assert.match(outcome as string, /timed out/u);
  });
});
