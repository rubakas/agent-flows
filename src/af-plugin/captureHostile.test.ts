// One hostile-repository table for the review capture (spec 047 FR-14).
//
// The capture is one module, src/runtime/reviewCapture.ts, and it reaches a reviewer
// four ways: as TypeScript (the core itself), as the plugin's transpiled copy (the
// generated lib/reviewCapture.mjs), through the daemon's adapter (reviewMaterial.ts)
// and through the plugin's CLI (capture.mjs). Every fixture below is run through all
// four and is held to two things:
//
//   1. its own expectations, on every driver: what was withheld, what the patch shows,
//      that no repository-configured command ran, that no secret reached any output;
//   2. agreement. The core, its transpiled copy and the daemon's adapter must agree on
//      every field. The CLI must agree with them except where INTENDED says it does not,
//      each with its reason. The list is asserted exactly, in both directions: a
//      difference that is not declared fails, and a declared difference that has stopped
//      differing fails too, so closing one is a visible edit rather than a silent drift.
//
// The audit's fixes (H2, M3, M4, M6, L7, L11, N1, L12) used to be tested on the plugin
// copy or on the daemon alone; here a fix is pinned on every path that ships it.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import * as tsCore from "../runtime/reviewCapture.js";
import {
  buildReviewMaterial,
  renderReviewMaterial,
  resolveSpecSources,
} from "../runtime/reviewMaterial.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = join(root, "plugin", "skills", "review", "scripts", "capture.mjs");

// The plugin's copies are plain .mjs outside tsconfig's program. The transpiled core
// has the shape of the source it was transpiled from, so it is typed as that.
const mjsCore = (await import(
  pathToFileURL(join(root, "plugin", "skills", "review", "scripts", "lib", "reviewCapture.mjs"))
    .href
)) as typeof tsCore;

interface GhOutcome {
  ok: boolean;
  stdout: string;
  reason: string;
  timedOut?: boolean;
}
type Gh = (args: readonly string[]) => GhOutcome;

interface PluginScript {
  resolveSpecSource(
    projectDir: string,
    value: string,
    gh: Gh,
    budget?: { used: number }
  ): { literal: boolean; text: string; full: string; notes: string[] };
  snapshotTree(root: string): unknown;
}
const plugin = (await import(pathToFileURL(SCRIPT).href)) as PluginScript;

type Artefact = "diff" | "commits" | "changedFiles" | "history";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const cleanups: (() => void)[] = [];
const saved: Record<string, string | undefined> = {};

// One git config for every driver: none may be decided by a developer's own global or
// system config (the plugin sets GIT_CONFIG_NOSYSTEM, the daemon and the core do not).
before(() => {
  for (const key of ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM"]) {
    saved[key] = process.env[key];
    process.env[key] = "/dev/null";
  }
});
after(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function scratch(label: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `af-hostile-${label}-`)));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function git(cwd: string, args: string[], input?: string): string {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    input,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    },
  });
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout;
}

function write(repo: string, path: string, body: string): void {
  const full = join(repo, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, body);
}

function commit(repo: string, message: string): string {
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", message]);
  return git(repo, ["rev-parse", "HEAD"]).trim();
}

function makeRepo(): string {
  const repo = scratch("repo");
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["config", "commit.gpgsign", "false"]);
  return repo;
}

/** A baseline commit, then a change that adds, edits and deletes a file. */
function plainRepo(): { repo: string; baseline: string } {
  const repo = makeRepo();
  write(repo, "kept.txt", "one\n");
  write(repo, "doomed.txt", "goes away\n");
  const baseline = commit(repo, "baseline commit");
  write(repo, "kept.txt", "one\ntwo\n");
  write(repo, "added.txt", "brand new\n");
  rmSync(join(repo, "doomed.txt"));
  commit(repo, "the change under review");
  return { repo, baseline };
}

/** Adds blobs under exact names without touching the filesystem (so case variants coexist). */
function commitBlobs(repo: string, names: string[]): string[] {
  const markers: string[] = [];
  names.forEach((name, index) => {
    const marker = `LEAKMARK${String(index)}`;
    const oid = git(repo, ["hash-object", "-w", "--stdin"], `${marker}\n`).trim();
    git(repo, ["update-index", "--add", "--cacheinfo", `100644,${oid},${name}`]);
    markers.push(marker);
  });
  git(repo, ["commit", "-q", "-m", "add blobs"]);
  return markers;
}

function executable(dir: string, name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, body, { mode: 0o755 });
  return path;
}

// ── The drivers ──────────────────────────────────────────────────────────────

const FIELDS = [
  "available",
  "reason",
  "baseline",
  "baselineRule",
  "withheld",
  "diff",
  "commits",
  "changedFiles",
  "history",
  "rendered",
] as const;
type Field = (typeof FIELDS)[number];
type View = Partial<Record<Field, unknown>>;

const DRIVERS = ["core-ts", "core-mjs", "daemon", "cli"] as const;
type Driver = (typeof DRIVERS)[number];

interface Built {
  repo: string;
  baseline?: string;
  /** Strings that must reach no driver's output. */
  secrets?: string[];
  /** Environment for the duration of every capture. */
  env?: Record<string, string>;
  /** Files that must not exist after every driver ran. */
  markers?: string[];
  /** The fixture's own expectations, on one driver's view. */
  check: (view: View, driver: Driver) => void;
}

function withEnv<T>(env: Record<string, string> | undefined, fn: () => T): T {
  const previous: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env ?? {})) {
    previous[key] = process.env[key];
    process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const PATH_NAMES: Record<Artefact, string> = {
  diff: "<path:diff>",
  commits: "<path:commits>",
  changedFiles: "<path:changedFiles>",
  history: "<path:history>",
};

function coreView(core: typeof tsCore, built: Built): View {
  const capture = withEnv(built.env, () =>
    core.captureGit({ projectDir: built.repo, baseline: built.baseline })
  );
  if (!capture.available) return { available: false, reason: capture.reason };
  const { digest, truncated } = core.digestBodies(capture.bodies);
  const { baseline, baselineRule, withheld, bodies } = capture;
  return {
    available: true,
    baseline,
    baselineRule,
    withheld,
    ...bodies,
    rendered: core.renderMaterial(
      { baseline, baselineRule, withheld, digest, truncated, paths: PATH_NAMES },
      []
    ),
  };
}

function daemonView(built: Built): View {
  const out = scratch("out");
  const material = withEnv(built.env, () =>
    buildReviewMaterial(built.repo, built.baseline, undefined, out)
  );
  if (!material.available) return { available: false, reason: material.reason };
  const bodies = {} as Record<Artefact, string>;
  let rendered = renderReviewMaterial(material);
  for (const name of Object.keys(PATH_NAMES) as Artefact[]) {
    const path = material.paths[name];
    assert.ok(path !== undefined, `${name} was not written`);
    bodies[name] = readFileSync(path, "utf8");
    rendered = rendered.split(path).join(PATH_NAMES[name]);
  }
  return {
    available: true,
    baseline: material.baseline,
    baselineRule: material.baselineRule,
    withheld: material.withheld,
    ...bodies,
    rendered,
  };
}

const CLI_FILES: Record<Artefact, string> = {
  diff: "diff.patch",
  commits: "commits.txt",
  changedFiles: "changed-files.txt",
  history: "history.txt",
};

function cliView(built: Built): View {
  const args = built.baseline === undefined ? [] : ["--base", built.baseline];
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: built.repo,
    encoding: "utf8",
    env: { ...process.env, ...built.env },
    timeout: 60_000,
  });
  const lines = result.stdout.split("\n").filter((line) => line !== "");
  assert.equal(
    lines.length,
    1,
    `expected ONE line of stdout, got: ${JSON.stringify(result.stdout)}`
  );
  const json = JSON.parse(lines[0]) as Record<string, unknown>;

  if (result.status !== 0) {
    assert.equal(result.status, 2, result.stdout);
    assert.equal(json.ok, false);
    assert.equal(
      existsSync(join(built.repo, ".af-review")),
      false,
      "a refused capture left a run directory behind"
    );
    return { available: false, reason: json.reason };
  }

  const runDir = json.runDir as string;
  const bodies = {} as Record<Artefact, string>;
  let rendered = readFileSync(join(runDir, "material.md"), "utf8").replace(/\n$/u, "");
  for (const name of Object.keys(CLI_FILES) as Artefact[]) {
    bodies[name] = readFileSync(join(runDir, CLI_FILES[name]), "utf8");
    rendered = rendered.split(join(runDir, CLI_FILES[name])).join(PATH_NAMES[name]);
  }
  return {
    available: true,
    baseline: json.baseline,
    baselineRule: json.baselineRule,
    withheld: json.withheld,
    ...bodies,
    rendered,
  };
}

function runDriver(driver: Driver, built: Built): View {
  switch (driver) {
    case "core-ts":
      return coreView(tsCore, built);
    case "core-mjs":
      return coreView(mjsCore, built);
    case "daemon":
      return daemonView(built);
    case "cli":
      return cliView(built);
  }
}

function differingFields(a: View, b: View): Field[] {
  return FIELDS.filter((field) => JSON.stringify(a[field]) !== JSON.stringify(b[field]));
}

// ── Expectations ─────────────────────────────────────────────────────────────

function str(view: View, field: Field, driver: Driver): string {
  assert.equal(view.available, true, `${driver}: not available: ${String(view.reason)}`);
  const value = view[field];
  assert.equal(typeof value, "string", `${driver}: ${field} is not text`);
  return value as string;
}

function withheldOf(view: View, driver: Driver): string[] {
  assert.equal(view.available, true, `${driver}: not available: ${String(view.reason)}`);
  return view.withheld as string[];
}

function refused(view: View, driver: Driver, reason: RegExp): void {
  assert.equal(view.available, false, `${driver}: expected a refusal, got a capture`);
  assert.match(String(view.reason), reason, driver);
}

/** The changed-file list without the withheld-by-policy trailer. */
function listed(view: View, driver: Driver): string[] {
  return str(view, "changedFiles", driver)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

// ── The intended differences ─────────────────────────────────────────────────

/**
 * What the plugin's CLI does differently from the core, the transpiled core and the
 * daemon's adapter, and why. All three belong to the CLI: it is the one caller that
 * turns a capture into a refusal.
 */
const INTENDED: Record<string, { reason: string }> = {
  "whitespace-baseline": {
    reason:
      "the core and the daemon read a whitespace-only baseline as omitted and derive one; " +
      "the CLI refuses it as empty before the core runs",
  },
  "empty-diff": {
    reason:
      "the core and the daemon return a capture whose diff is empty; " +
      "the CLI refuses it, because there is nothing to review",
  },
  "head-check": {
    reason:
      "the CLI refuses outside a work tree, and when HEAD does not resolve, before it looks " +
      "at the baseline; the core and the daemon do neither",
  },
};

interface Fixture {
  name: string;
  build: () => Built;
  intended: { id: keyof typeof INTENDED; fields: Field[] }[];
}

const ALL_FIELDS: Field[] = [...FIELDS];

const fixtures: Fixture[] = [
  {
    name: "a plain add, edit and delete",
    build: () => ({
      ...plainRepo(),
      check: (view, driver) => {
        assert.match(str(view, "diff", driver), /\+two/u);
        assert.match(str(view, "diff", driver), /added\.txt/u);
        assert.match(str(view, "commits", driver), /the change under review/u);
        assert.equal(str(view, "commits", driver).trim().split("\n").length, 1);
        assert.deepEqual(listed(view, driver).sort(), ["added.txt", "doomed.txt", "kept.txt"]);
        // The provenance probes: the delete of doomed.txt, and the stat of the commit.
        assert.match(str(view, "history", driver), /doomed\.txt/u);
        assert.match(str(view, "history", driver), /files? changed/u);
        assert.deepEqual(withheldOf(view, driver), []);
        assert.equal(view.baselineRule, "caller");
        const rendered = str(view, "rendered", driver);
        assert.ok(
          rendered.startsWith(`## baseline\n${String(view.baseline)}\nsupplied by the caller`)
        );
        assert.deepEqual(
          [...rendered.matchAll(/^## ([a-z ]+?)(?: \(.*)?$/gmu)].map((match) => match[1]),
          ["baseline", "diff", "commits", "changed files", "history probes"]
        );
      },
    }),
    intended: [],
  },
  {
    name: "credential files changed next to a source file",
    build: () => {
      const repo = makeRepo();
      write(repo, "kept.txt", "one\n");
      write(repo, ".env", "CANARY_NOT_A_SECRET=xxx\n");
      const baseline = commit(repo, "baseline commit");
      write(repo, "kept.txt", "one\ntwo\n");
      write(repo, ".env", "CANARY_NOT_A_SECRET=yyy\n");
      write(repo, "config/.env.production", "CANARY_NOT_A_SECRET=zzz\n");
      commit(repo, "change a source file and credential files");
      return {
        repo,
        baseline,
        secrets: ["CANARY_NOT_A_SECRET"],
        check: (view, driver) => {
          assert.deepEqual([...withheldOf(view, driver)].sort(), [
            ".env",
            "config/.env.production",
          ]);
          assert.deepEqual(listed(view, driver), ["kept.txt"]);
          assert.match(str(view, "changedFiles", driver), /withheld by credential policy/u);
          assert.match(str(view, "changedFiles", driver), /# \.env$/mu);
          assert.match(str(view, "diff", driver), /\+two/u);
          assert.ok(
            !str(view, "diff", driver).includes(".env"),
            "a credential path is in the diff"
          );
          assert.ok(
            !str(view, "history", driver).includes(".env"),
            "a credential path is in the history"
          );
          assert.match(str(view, "commits", driver), /change a source file and credential files/u);
          assert.ok(
            str(view, "rendered", driver).includes("## withheld by credential policy (2 path(s))")
          );
        },
      };
    },
    intended: [],
  },
  ...(["into", "outOf"] as const).map((direction): Fixture => ({
    name: `a file renamed ${direction} a denied name`,
    build: () => {
      const repo = makeRepo();
      git(repo, ["config", "diff.renames", "true"]);
      const from = direction === "into" ? "notes.txt" : ".env";
      const to = direction === "into" ? ".env" : "notes.txt";
      write(repo, "kept.txt", "one\n");
      write(repo, from, "CANARY_NOT_A_SECRET\nsecond line\nthird line\n");
      const baseline = commit(repo, "baseline commit");
      git(repo, ["mv", from, to]);
      write(repo, "kept.txt", "one\ntwo\n");
      commit(repo, "rename the file across the deny list");
      return {
        repo,
        baseline,
        secrets: ["CANARY_NOT_A_SECRET"],
        check: (view, driver) => {
          // Excluding the denied half removes it from the diff queue before rename
          // detection runs, so without the counterpart pass the OTHER half arrives as
          // a whole-file add or delete, canary and all.
          assert.deepEqual([...withheldOf(view, driver)].sort(), [from, to].sort());
          const diff = str(view, "diff", driver);
          assert.ok(
            !diff.includes(to) && !diff.includes(from),
            "a half of the rename is in the diff"
          );
          assert.deepEqual(listed(view, driver), ["kept.txt"]);
          assert.match(diff, /\+two/u);
        },
      };
    },
    intended: [],
  })),
  {
    name: "an ordinary rename, with its content",
    build: () => {
      const repo = makeRepo();
      git(repo, ["config", "diff.renames", "true"]);
      write(repo, "before.txt", "alpha\nbravo\ncharlie\n");
      const baseline = commit(repo, "baseline commit");
      git(repo, ["mv", "before.txt", "after.txt"]);
      write(repo, "after.txt", "alpha\nbravo\ncharlie\ndelta\n");
      commit(repo, "rename and extend");
      return {
        repo,
        baseline,
        check: (view, driver) => {
          // The counterpart pass must withhold nothing when no denied path is involved.
          assert.deepEqual(withheldOf(view, driver), []);
          const diff = str(view, "diff", driver);
          assert.match(diff, /rename from before\.txt/u);
          assert.match(diff, /rename to after\.txt/u);
          assert.match(diff, /\+delta/u);
          assert.equal(str(view, "changedFiles", driver).trim(), "after.txt");
        },
      };
    },
    intended: [],
  },
  {
    name: "a path named like pathspec magic does not blank the history probe",
    build: () => {
      const repo = makeRepo();
      write(repo, "kept.txt", "one\n");
      write(repo, ":(exclude)**", "magic name\n");
      const baseline = commit(repo, "baseline commit");
      write(repo, ":(exclude)**", "magic name, edited\n");
      write(repo, "added.txt", "brand new\n");
      commit(repo, "the change under review");
      return {
        repo,
        baseline,
        check: (view, driver) => {
          // Only the add/delete probe is under test: the `git show --stat` sections
          // name added.txt too, and asserting on the whole text would pass with the
          // probe blanked.
          const history = str(view, "history", driver);
          const marker = "# add/delete history of the changed files\n";
          const start = history.indexOf(marker);
          assert.notEqual(start, -1, "the add/delete history probe was not run at all");
          const end = history.indexOf("\n# git show --stat", start);
          const probe = history.slice(start + marker.length, end === -1 ? undefined : end);
          // Fed back as a bare pathspec, this filename reads as "exclude everything".
          assert.match(probe, /added\.txt/u);
        },
      };
    },
    intended: [],
  },
  {
    name: "a non-ASCII path is listed unquoted, so it survives being fed back to git",
    build: () => {
      const { repo, baseline } = plainRepo();
      write(repo, "café.txt", "accented\n");
      commit(repo, "add a non-ASCII path");
      return {
        repo,
        baseline,
        check: (view, driver) => {
          // Without `-z`, git prints `"caf\303\251.txt"`; fed back as a pathspec that
          // spelling matches nothing, and the file drops out of the probe silently.
          const names = listed(view, driver);
          assert.ok(names.includes("café.txt"), `café.txt is not listed as it is: ${names.join()}`);
          for (const line of names) {
            assert.ok(!line.startsWith('"'), `path came back C-quoted: ${line}`);
            assert.ok(!line.includes("\\"), `path came back escaped: ${line}`);
          }
        },
      };
    },
    intended: [],
  },
  {
    name: "audit H2: rename detection skipped (1100 changed files) with a denied path changed",
    build: () => {
      const repo = makeRepo();
      const body = Array.from(
        { length: 40 },
        (_, i) => `RENAMELEAK${String(i)} padding ${String(i)}`
      );
      write(repo, ".env", body.join("\n") + "\n");
      for (let i = 0; i < 1100; i += 1) {
        write(repo, `f/old${String(i)}.txt`, `old ${String(i)} `.repeat(20));
      }
      const baseline = commit(repo, "base");
      git(repo, ["mv", ".env", "notes.txt"]);
      write(
        repo,
        "notes.txt",
        body.join("\n").replace("RENAMELEAK3 ", "RENAMELEAK3-edited ") + "\n"
      );
      for (let i = 0; i < 1100; i += 1) {
        rmSync(join(repo, `f/old${String(i)}.txt`));
        write(repo, `f/new${String(i)}.txt`, `new different ${String(i)} `.repeat(20));
      }
      commit(repo, "rename with one line changed, among many other changes");
      return {
        repo,
        baseline,
        secrets: ["RENAMELEAK"],
        check: (view, driver) => refused(view, driver, /rename detection/u),
      };
    },
    intended: [],
  },
  {
    name: "audit H2: rename detection skipped (diff.renameLimit) with a denied path changed",
    build: () => {
      const body = Array.from({ length: 30 }, (_, i) => `RENAMELEAK${String(i)} padding`).join(
        "\n"
      );
      const repo = makeRepo();
      git(repo, ["config", "diff.renameLimit", "1"]);
      write(repo, ".env", `${body}\n`);
      write(repo, "other-old-a.txt", "first old file\n".repeat(20));
      write(repo, "other-old-b.txt", "second old file\n".repeat(20));
      const baseline = commit(repo, "baseline commit");
      git(repo, ["mv", ".env", "notes.txt"]);
      write(repo, "notes.txt", `${body.replace("RENAMELEAK3 ", "RENAMELEAK3-edited ")}\n`);
      git(repo, ["rm", "-q", "other-old-a.txt", "other-old-b.txt"]);
      write(repo, "other-new-a.txt", "brand new a\n".repeat(20));
      write(repo, "other-new-b.txt", "brand new b\n".repeat(20));
      commit(repo, "rename with an edit, among other changes");
      return {
        repo,
        baseline,
        secrets: ["RENAMELEAK"],
        check: (view, driver) => refused(view, driver, /rename detection/u),
      };
    },
    intended: [],
  },
  {
    name: "audit M3: case variants of denied names",
    build: () => {
      const { repo, baseline } = plainRepo();
      // Pinned off so the pathspec is the only thing that can match: on a
      // case-insensitive filesystem git would otherwise init with it on.
      git(repo, ["config", "core.ignorecase", "false"]);
      const names = [
        ".ENV",
        "Credentials.json",
        "SECRETS.JSON",
        "ID_RSA",
        "config/.SSH/known",
        "Server.Pem",
        "Terraform.TFVARS",
      ];
      const secrets = commitBlobs(repo, names);
      return {
        repo,
        baseline,
        secrets,
        check: (view, driver) => {
          for (const name of names) {
            assert.ok(
              withheldOf(view, driver).includes(name),
              `${driver}: ${name} was not withheld`
            );
          }
          assert.match(str(view, "changedFiles", driver), /# \.ENV/u);
          assert.match(str(view, "diff", driver), /\+two/u);
        },
      };
    },
    intended: [],
  },
  ...["* -diff\n", "* binary\n"].map((attributes): Fixture => ({
    name: `audit M4: ${JSON.stringify(attributes)} does not blank the patch`,
    build: () => {
      const { repo, baseline } = plainRepo();
      write(repo, ".gitattributes", attributes);
      write(repo, "kept.txt", "one\ntwo\nTWO CHANGED AGAIN\n");
      commit(repo, "hide the diff with attributes");
      return {
        repo,
        baseline,
        check: (view, driver) => {
          assert.ok(str(view, "diff", driver).includes("+TWO CHANGED AGAIN"));
          assert.ok(!str(view, "diff", driver).includes("Binary files"));
        },
      };
    },
    intended: [],
  })),
  {
    name: "audit M6: dotenv variants, cloud-tool auth files and registry credentials",
    build: () => {
      const { repo, baseline } = plainRepo();
      const names = [
        ".env.production.local",
        ".env.qa",
        "app.env",
        ".git-credentials",
        ".pypirc",
        ".docker/config.json",
        ".dockercfg",
      ];
      const secrets = commitBlobs(repo, names);
      return {
        repo,
        baseline,
        secrets,
        check: (view, driver) => {
          for (const name of names) {
            assert.ok(
              withheldOf(view, driver).includes(name),
              `${driver}: ${name} was not withheld`
            );
          }
        },
      };
    },
    intended: [],
  },
  {
    name: "a textconv driver and diff.external in the repository's own config",
    build: () => {
      const { repo, baseline } = plainRepo();
      const dir = scratch("driver");
      const marker = join(dir, "ran");
      const driver = executable(
        dir,
        "driver.sh",
        `#!/bin/sh\ntouch '${marker}'\ntr a-z A-Z < "$1"\n`
      );
      git(repo, ["config", "diff.external", driver]);
      git(repo, ["config", "diff.upper.textconv", driver]);
      write(repo, ".gitattributes", "*.txt diff=upper\n");
      write(repo, "kept.txt", "one\ntwo\nbeta-added-line\n");
      commit(repo, "touch kept again");
      return {
        repo,
        baseline,
        markers: [marker],
        check: (view, name) => {
          assert.ok(
            str(view, "diff", name).includes("+beta-added-line"),
            "the real patch is missing"
          );
          assert.ok(
            !str(view, "diff", name).includes("BETA-ADDED-LINE"),
            "textconv output replaced the patch"
          );
        },
      };
    },
    intended: [],
  },
  {
    name: "audit L7: a repo-local gpg.program for a forged signature header",
    build: () => {
      const { repo, baseline } = plainRepo();
      const dir = scratch("gpg");
      const marker = join(dir, "ran");
      const program = executable(dir, "gpg.sh", `#!/bin/sh\ntouch '${marker}'\nexit 1\n`);
      // A commit object nobody signed, carrying a signature header: with
      // log.showSignature on, git hands it to gpg.program to verify.
      const tree = git(repo, ["rev-parse", "HEAD^{tree}"]).trim();
      const parent = git(repo, ["rev-parse", "HEAD"]).trim();
      const forged = join(dir, "commit.txt");
      writeFileSync(
        forged,
        [
          `tree ${tree}`,
          `parent ${parent}`,
          "author A <a@example.invalid> 0 +0000",
          "committer A <a@example.invalid> 0 +0000",
          "gpgsig -----BEGIN PGP SIGNATURE-----",
          " x",
          " -----END PGP SIGNATURE-----",
          "",
          "forged",
          "",
        ].join("\n")
      );
      const forgedOid = git(repo, ["hash-object", "-t", "commit", "-w", forged]).trim();
      git(repo, ["reset", "-q", "--hard", forgedOid]);
      git(repo, ["config", "log.showSignature", "true"]);
      git(repo, ["config", "gpg.program", program]);
      return {
        repo,
        baseline,
        markers: [marker],
        check: (view, driver) => {
          assert.equal(view.available, true, `${driver}: ${String(view.reason)}`);
          assert.match(str(view, "commits", driver), /forged/u);
        },
      };
    },
    intended: [],
  },
  {
    name: "audit L11: a path with a newline and a forged heading",
    build: () => {
      const { repo, baseline } = plainRepo();
      write(repo, "x\n## injected heading.txt", "body\n");
      commit(repo, "add odd name");
      return {
        repo,
        baseline,
        check: (view, driver) => {
          for (const field of ["rendered", "changedFiles", "history"] as const) {
            assert.doesNotMatch(str(view, field, driver), /^## injected/mu, `${driver}: ${field}`);
          }
          assert.ok(str(view, "changedFiles", driver).includes("x\\u000a## injected heading.txt"));
          assert.ok(str(view, "rendered", driver).includes("x\\u000a## injected heading.txt"));
        },
      };
    },
    intended: [],
  },
  {
    name: "audit L11: a withheld path with a newline and a forged heading",
    build: () => {
      const { repo, baseline } = plainRepo();
      write(repo, "x\n## forged heading.pem", "FORGEDMARK\n");
      commit(repo, "add a denied name with a newline");
      return {
        repo,
        baseline,
        secrets: ["FORGEDMARK"],
        check: (view, driver) => {
          // The structured value stays exactly what git printed: it is data, not prompt text.
          assert.deepEqual(withheldOf(view, driver), ["x\n## forged heading.pem"]);
          assert.ok(str(view, "changedFiles", driver).includes("# x\\u000a## forged heading.pem"));
          assert.doesNotMatch(str(view, "rendered", driver), /^## forged/mu);
          assert.ok(str(view, "rendered", driver).includes("x\\u000a## forged heading.pem"));
        },
      };
    },
    intended: [],
  },
  {
    name: "audit L11: a commit subject with terminal escape characters",
    build: () => {
      const { repo, baseline } = plainRepo();
      write(repo, "c.txt", "c\n");
      commit(repo, "red \u001b[31mALERT\u001b[0m subject");
      return {
        repo,
        baseline,
        check: (view, driver) => {
          for (const field of ["rendered", "commits", "history"] as const) {
            assert.ok(
              !str(view, field, driver).includes("\u001b"),
              `${driver}: ${field} has a raw ESC`
            );
          }
          assert.ok(str(view, "commits", driver).includes("\\u001b[31mALERT"));
        },
      };
    },
    intended: [],
  },
  {
    name: "re-audit N1: a translated warning on the rename pass",
    build: () => {
      const { repo, baseline } = plainRepo();
      write(repo, ".env", "K=v\n");
      commit(repo, "env");
      const realGit = spawnSync("which", ["git"], { encoding: "utf8" }).stdout.trim();
      const bin = scratch("fakebin");
      // A translated warning: no English "rename detection was skipped" in it.
      executable(
        bin,
        "git",
        `#!/bin/sh\n'${realGit}' "$@"\nstatus=$?\ncase "$*" in *"--name-status -M"*) echo "avertissement : la detection des renommages a ete ignoree" >&2;; esac\nexit $status\n`
      );
      return {
        repo,
        baseline,
        env: { PATH: `${bin}:${process.env.PATH ?? ""}` },
        check: (view, driver) => refused(view, driver, /rename detection/u),
      };
    },
    intended: [],
  },
  {
    name: "audit L12: git does not answer in time",
    build: () => {
      const { repo, baseline } = plainRepo();
      return {
        repo,
        baseline,
        env: { AF_REVIEW_GIT_TIMEOUT_MS: "1" },
        check: (view, driver) => refused(view, driver, /timed out/u),
      };
    },
    intended: [],
  },
  {
    name: "a baseline that is an option",
    build: () => ({
      ...plainRepo(),
      baseline: "--upload-pack=/bin/echo",
      check: (view, driver) => refused(view, driver, /starts with "-"/u),
    }),
    intended: [],
  },
  {
    name: "a baseline that is not a commit",
    build: () => ({
      ...plainRepo(),
      baseline: "no-such-ref",
      check: (view, driver) => refused(view, driver, /does not resolve to a commit/u),
    }),
    intended: [],
  },
  {
    name: "a whitespace-only baseline",
    build: () => ({
      ...plainRepo(),
      baseline: "   ",
      check: (view, driver) => {
        if (driver === "cli") return refused(view, driver, /baseline is empty/u);
        assert.equal(view.baselineRule, "previous-commit", `${driver}: ${String(view.reason)}`);
      },
    }),
    intended: [{ id: "whitespace-baseline", fields: ALL_FIELDS }],
  },
  {
    name: "no baseline and no origin: HEAD~1",
    build: () => {
      const { repo, baseline } = plainRepo();
      return {
        repo,
        check: (view, driver) => {
          assert.equal(view.baselineRule, "previous-commit");
          assert.equal(view.baseline, baseline, driver);
          assert.match(str(view, "rendered", driver), /so HEAD~1 was used/u);
        },
      };
    },
    intended: [],
  },
  {
    name: "no baseline with an origin default branch: the merge-base",
    build: () => {
      const repo = makeRepo();
      write(repo, "kept.txt", "one\n");
      const fork = commit(repo, "the fork point");
      git(repo, ["checkout", "-q", "-b", "feature"]);
      write(repo, "first.txt", "first change\n");
      commit(repo, "first commit of the branch");
      write(repo, "second.txt", "second change\n");
      commit(repo, "second commit of the branch");
      git(repo, ["remote", "add", "origin", "git@github.com:acme/widgets.git"]);
      git(repo, ["update-ref", "refs/remotes/origin/main", fork]);
      git(repo, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
      return {
        repo,
        check: (view, driver) => {
          assert.equal(view.baselineRule, "merge-base");
          assert.equal(view.baseline, fork, driver);
          // Both commits of the branch are in scope: the point of the merge-base rule.
          assert.match(str(view, "commits", driver), /first commit of the branch/u);
          assert.match(str(view, "commits", driver), /second commit of the branch/u);
          assert.match(str(view, "rendered", driver), /merge-base of HEAD/u);
        },
      };
    },
    intended: [],
  },
  {
    name: "no baseline and nothing to derive from",
    build: () => {
      const repo = makeRepo();
      write(repo, "a.txt", "one\n");
      commit(repo, "only commit");
      return { repo, check: (view, driver) => refused(view, driver, /none could be derived/u) };
    },
    intended: [],
  },
  {
    name: "an empty range",
    build: () => {
      const repo = makeRepo();
      write(repo, "a.txt", "one\n");
      const baseline = commit(repo, "base");
      git(repo, ["commit", "-q", "--allow-empty", "-m", "empty"]);
      return {
        repo,
        baseline,
        check: (view, driver) => {
          if (driver === "cli") return refused(view, driver, /is empty/u);
          assert.equal(str(view, "diff", driver), "");
        },
      };
    },
    intended: [{ id: "empty-diff", fields: ALL_FIELDS }],
  },
  {
    name: "a range that is empty once the credential files are withheld",
    build: () => {
      const repo = makeRepo();
      write(repo, "a.txt", "one\n");
      const baseline = commit(repo, "base");
      write(repo, ".env", "ONLY=secret\n");
      commit(repo, "only a credential file");
      return {
        repo,
        baseline,
        secrets: ["ONLY=secret"],
        check: (view, driver) => {
          if (driver === "cli") return refused(view, driver, /withheld/u);
          assert.equal(str(view, "diff", driver), "");
          assert.deepEqual(withheldOf(view, driver), [".env"]);
        },
      };
    },
    intended: [{ id: "empty-diff", fields: ALL_FIELDS }],
  },
  {
    name: "a directory that is not a git repository",
    build: () => ({
      repo: scratch("nogit"),
      baseline: "main",
      check: (view, driver) =>
        refused(
          view,
          driver,
          driver === "cli" ? /not inside a git work tree/u : /does not resolve to a commit/u
        ),
    }),
    intended: [{ id: "head-check", fields: ["reason"] }],
  },
];

describe("one hostile-repository table, run through the core, its transpiled copy, the daemon and the CLI", () => {
  for (const fixture of fixtures) {
    it(fixture.name, () => {
      const built = fixture.build();
      const views = {} as Record<Driver, View>;
      for (const driver of DRIVERS) views[driver] = runDriver(driver, built);

      // 1. The fixture's own expectations, on every driver.
      for (const driver of DRIVERS) built.check(views[driver], driver);

      // 2. The core, its transpiled copy and the daemon's adapter agree on everything.
      for (const driver of ["core-mjs", "daemon"] as const) {
        const apart = differingFields(views["core-ts"], views[driver]);
        assert.deepEqual(
          apart,
          [],
          `${driver} differs from core-ts in ${apart.join()}:\n core-ts: ${JSON.stringify(views["core-ts"])}\n ${driver}: ${JSON.stringify(views[driver])}`
        );
      }

      // 3. The CLI agrees except where it is declared not to.
      for (const { id } of fixture.intended) assert.ok(id in INTENDED, `${id} is not declared`);
      const declared = new Set(fixture.intended.flatMap(({ fields }) => fields));
      const actual = differingFields(views["core-ts"], views.cli);
      for (const field of FIELDS) {
        const differs = actual.includes(field);
        assert.equal(
          differs,
          declared.has(field),
          differs
            ? `${field} differs and is not a declared difference:\n core: ${JSON.stringify(views["core-ts"][field])}\n cli: ${JSON.stringify(views.cli[field])}`
            : `${field} is declared as a difference but the CLI now agrees`
        );
      }

      // 4. No repository-configured command ran, and no secret reached any output.
      for (const marker of built.markers ?? []) {
        assert.equal(existsSync(marker), false, `a repository-configured command ran: ${marker}`);
      }
      for (const secret of built.secrets ?? []) {
        for (const driver of DRIVERS) {
          assert.ok(
            !JSON.stringify(views[driver]).includes(secret),
            `${driver}: the capture carries ${secret}`
          );
        }
      }
    });
  }
});

describe("the plugin's snapshot", () => {
  it("never runs a repo-local core.fsmonitor command", () => {
    const { repo } = plainRepo();
    const dir = scratch("fsmonitor");
    const marker = join(dir, "ran");
    git(repo, [
      "config",
      "core.fsmonitor",
      executable(dir, "hook.sh", `#!/bin/sh\ntouch '${marker}'\n`),
    ]);
    write(repo, "untracked.txt", "x\n");
    plugin.snapshotTree(repo);
    assert.equal(existsSync(marker), false, "core.fsmonitor ran");
  });
});

// ── Spec-source resolution ───────────────────────────────────────────────────

describe("spec-source resolution, through the core, its transpiled copy, the daemon and the CLI", () => {
  interface Case {
    name: string;
    value: string;
    gh: (calls: string[][]) => Gh;
    /** How many times gh must have been asked. */
    calls: number;
  }

  const answer =
    (table: Record<string, { title: string; body: string }>) =>
    (calls: string[][]): Gh =>
    (args) => {
      calls.push([...args]);
      const [tool, , number, , repo] = args;
      const entry = table[`${tool} ${repo}#${number}`];
      if (entry === undefined) return { ok: false, stdout: "", reason: "no such item" };
      return {
        ok: true,
        stdout: JSON.stringify({ ...entry, url: `https://github.com/${repo}/issues/${number}` }),
        reason: "",
      };
    };

  const cases: Case[] = [
    {
      name: "a pull request fetched by URL",
      value: "https://github.com/acme/widgets/pull/1",
      gh: answer({ "pr acme/widgets#1": { title: "One", body: "body one" } }),
      calls: 1,
    },
    {
      name: "a short ref that is only an issue",
      value: "acme/widgets#9",
      gh: answer({ "issue acme/widgets#9": { title: "Nine", body: "body nine" } }),
      calls: 2,
    },
    {
      name: "hostile references never reach gh",
      value:
        "https://evil.example.com/o/r/pull/1 http://github.com/o/r/pull/1 https://github.com/-o/r/pull/1 --repo/r#1 #99999999999",
      gh: answer({}),
      calls: 0,
    },
    {
      name: "a pull request that links issues, within one cap of ten fetches",
      value: "https://github.com/acme/widgets/pull/100",
      gh: answer({
        "pr acme/widgets#100": {
          title: "The change",
          body: Array.from({ length: 20 }, (_, i) => `Closes #${String(i + 1)}`).join("\n"),
        },
        ...Object.fromEntries(
          Array.from({ length: 20 }, (_, i) => [
            `issue acme/widgets#${String(i + 1)}`,
            { title: `Issue ${String(i + 1)}`, body: `body ${String(i + 1)}` },
          ])
        ),
      }),
      calls: 10,
    },
    {
      name: "gh missing",
      value: "https://github.com/acme/widgets/pull/1",
      gh: (calls) => (args) => {
        calls.push([...args]);
        return { ok: false, stdout: "", reason: "spawnSync gh ENOENT" };
      },
      calls: 1,
    },
    {
      name: "gh timing out on a short ref: `gh issue view` is not asked after `gh pr view`",
      value: "acme/widgets#5",
      gh: (calls) => (args) => {
        calls.push([...args]);
        return { ok: false, stdout: "", reason: "gh timed out", timedOut: true };
      },
      calls: 1,
    },
  ];

  const resolvers: Record<
    string,
    (
      dir: string,
      value: string,
      gh: Gh
    ) => { literal: boolean; text: string; full: string; notes: string[] }
  > = {
    "core-ts": (dir, value, gh) => tsCore.resolveSpecRefs(dir, value, gh),
    "core-mjs": (dir, value, gh) => mjsCore.resolveSpecRefs(dir, value, gh),
    daemon: (dir, value, gh) => resolveSpecSources(dir, value, gh),
    cli: (dir, value, gh) => plugin.resolveSpecSource(dir, value, gh),
  };

  for (const spec of cases) {
    it(spec.name, () => {
      const dir = scratch("spec");
      const results: Record<string, unknown> = {};
      for (const [driver, resolve] of Object.entries(resolvers)) {
        const calls: string[][] = [];
        const resolution = resolve(dir, spec.value, spec.gh(calls));
        assert.equal(
          calls.length,
          spec.calls,
          `${driver} asked gh ${String(calls.length)} time(s)`
        );
        results[driver] = { ...resolution, calls };
      }
      for (const driver of Object.keys(resolvers)) {
        assert.deepEqual(results[driver], results["core-ts"], `${driver} differs from core-ts`);
      }
    });
  }
});
