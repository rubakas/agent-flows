// The daemon's review capture (src/runtime/reviewMaterial.ts) and the plugin's
// (plugin/skills/review/scripts/capture.mjs) implement the same capture, and for a
// long time nothing pinned one to the other: the audit's fixes were tested on the
// plugin copy alone. This file runs the same hostile repositories through BOTH and
// compares what each one withheld and what each one captured.
//
// Everything must match except the differences listed in INTENDED, each with its
// reason. The list is asserted exactly, in both directions: a difference that is
// not declared fails, and a declared difference that has stopped differing fails
// too, so closing one is a visible edit to this file rather than a silent drift.

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

import {
  buildReviewMaterial,
  renderReviewMaterial,
  resolveSpecSources,
} from "../runtime/reviewMaterial.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

type Artefact = "diff" | "commits" | "changedFiles" | "history";

interface PluginCapture {
  available: boolean;
  reason?: string;
  baseline?: string;
  baselineRule?: string;
  withheld?: string[];
  bodies?: Record<Artefact, string>;
}

interface GhOutcome {
  ok: boolean;
  stdout: string;
  reason: string;
  timedOut?: boolean;
}
type Gh = (args: readonly string[]) => GhOutcome;

interface PluginModule {
  captureGitMaterial(projectDir: string, baseline?: string): PluginCapture;
  renderReviewMaterial(
    material: PluginCapture,
    paths: Record<string, string>,
    specs?: unknown[]
  ): string;
  resolveSpecSource(
    projectDir: string,
    value: string,
    gh: Gh,
    budget?: { used: number }
  ): { literal: boolean; text: string; full: string; notes: string[] };
  snapshotTree(root: string): unknown;
}

const plugin = (await import(
  pathToFileURL(join(root, "plugin", "skills", "review", "scripts", "capture.mjs")).href
)) as PluginModule;

// ── Fixtures ─────────────────────────────────────────────────────────────────

const cleanups: (() => void)[] = [];
const saved: Record<string, string | undefined> = {};

// One git config for both captures: neither may be decided by a developer's own
// global or system config (the plugin sets GIT_CONFIG_NOSYSTEM, the daemon does not).
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
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `af-parity-${label}-`)));
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

interface Built {
  repo: string;
  baseline?: string;
  /** Strings that must reach neither capture's output. */
  secrets?: string[];
  /** Environment for the duration of both captures. */
  env?: Record<string, string>;
  /** Files that must not exist after both captures ran. */
  markers?: string[];
}

// ── Running both captures ────────────────────────────────────────────────────

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

function pluginView(built: Built): View {
  let capture: PluginCapture;
  try {
    capture = withEnv(built.env, () => plugin.captureGitMaterial(built.repo, built.baseline));
  } catch (err) {
    // The plugin's CLI turns a timeout into exit 2; as a function it throws.
    return { available: false, reason: (err as Error).message };
  }
  if (!capture.available) return { available: false, reason: capture.reason };
  assert.ok(capture.bodies !== undefined);
  return {
    available: true,
    baseline: capture.baseline,
    baselineRule: capture.baselineRule,
    withheld: capture.withheld,
    ...capture.bodies,
    rendered: plugin.renderReviewMaterial(capture, PATH_NAMES),
  };
}

function differingFields(daemon: View, pluginSide: View): Field[] {
  return FIELDS.filter(
    (field) => JSON.stringify(daemon[field]) !== JSON.stringify(pluginSide[field])
  );
}

// ── The intended differences ─────────────────────────────────────────────────

/**
 * Every difference between the two captures that is known and deliberate or
 * known and not yet closed. `closedBy` names the commit of spec 047 FR-14 that
 * removes it; the entry and its uses are deleted in that commit.
 */
const INTENDED: Record<string, { reason: string; closedBy?: string }> = {
  "deny-list-gap": {
    reason:
      "the plugin withholds the dotenv globs and four more credential files " +
      "(.git-credentials, .pypirc, .docker/config.json, .dockercfg) that the daemon's list lacks",
    closedBy: "fix(runtime): withhold the dotenv globs in the daemon capture",
  },
  "control-char-escaping": {
    reason:
      "the plugin writes control characters of paths and commit subjects as \\uXXXX; " +
      "the daemon writes them raw into the prompt",
    closedBy: "fix(runtime): escape control characters in the daemon capture",
  },
  "whitespace-baseline": {
    reason:
      "the daemon reads a whitespace-only baseline as omitted and derives one; " +
      "the plugin refuses it as empty. Stays: the CLI refuses before the core runs",
  },
  "empty-diff": {
    reason:
      "the plugin refuses a capture whose diff is empty; the daemon returns it as available " +
      "with an empty diff. Stays: the CLI owns the refusal",
  },
  "head-check": {
    reason:
      "the plugin requires HEAD to resolve before it looks at the baseline; the daemon does not. " +
      "Stays: the CLI owns the check",
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
    build: () => ({ ...plainRepo() }),
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
      return { repo, baseline, secrets: ["CANARY_NOT_A_SECRET"] };
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
      return { repo, baseline, secrets: ["CANARY_NOT_A_SECRET"] };
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
      return { repo, baseline };
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
      return { repo, baseline, secrets: ["RENAMELEAK"] };
    },
    intended: [],
  },
  {
    name: "audit M3: case variants of denied names",
    build: () => {
      const { repo, baseline } = plainRepo();
      git(repo, ["config", "core.ignorecase", "false"]);
      const secrets = commitBlobs(repo, [
        ".ENV",
        "Credentials.json",
        "SECRETS.JSON",
        "ID_RSA",
        "config/.SSH/known",
        "Server.Pem",
        "Terraform.TFVARS",
      ]);
      return { repo, baseline, secrets };
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
      return { repo, baseline };
    },
    intended: [],
  })),
  {
    name: "audit M6: dotenv variants, cloud-tool auth files and registry credentials",
    build: () => {
      const { repo, baseline } = plainRepo();
      const secrets = commitBlobs(repo, [
        ".env.production.local",
        ".env.qa",
        "app.env",
        ".git-credentials",
        ".pypirc",
        ".docker/config.json",
        ".dockercfg",
      ]);
      return { repo, baseline, secrets };
    },
    intended: [
      { id: "deny-list-gap", fields: ["withheld", "diff", "changedFiles", "history", "rendered"] },
    ],
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
      return { repo, baseline, markers: [marker] };
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
      return { repo, baseline, markers: [marker] };
    },
    intended: [],
  },
  {
    name: "audit L11: a path with a newline and a forged heading",
    build: () => {
      const { repo, baseline } = plainRepo();
      write(repo, "x\n## injected heading.txt", "body\n");
      commit(repo, "add odd name");
      return { repo, baseline };
    },
    intended: [{ id: "control-char-escaping", fields: ["changedFiles", "rendered"] }],
  },
  {
    name: "audit L11: a commit subject with terminal escape characters",
    build: () => {
      const { repo, baseline } = plainRepo();
      write(repo, "c.txt", "c\n");
      commit(repo, "red \u001b[31mALERT\u001b[0m subject");
      return { repo, baseline };
    },
    intended: [{ id: "control-char-escaping", fields: ["commits", "history", "rendered"] }],
  },
  {
    name: "re-audit N1: a translated warning on the rename pass",
    build: () => {
      const { repo, baseline } = plainRepo();
      write(repo, ".env", "K=v\n");
      commit(repo, "env");
      const realGit = spawnSync("which", ["git"], { encoding: "utf8" }).stdout.trim();
      const bin = scratch("fakebin");
      executable(
        bin,
        "git",
        `#!/bin/sh\n'${realGit}' "$@"\nstatus=$?\ncase "$*" in *"--name-status -M"*) echo "avertissement : la detection des renommages a ete ignoree" >&2;; esac\nexit $status\n`
      );
      return { repo, baseline, env: { PATH: `${bin}:${process.env.PATH ?? ""}` } };
    },
    intended: [],
  },
  {
    name: "audit L12: git does not answer in time",
    build: () => {
      const { repo, baseline } = plainRepo();
      return { repo, baseline, env: { AF_REVIEW_GIT_TIMEOUT_MS: "1" } };
    },
    intended: [],
  },
  {
    name: "a baseline that is an option",
    build: () => ({ ...plainRepo(), baseline: "--upload-pack=/bin/echo" }),
    intended: [],
  },
  {
    name: "a baseline that is not a commit",
    build: () => ({ ...plainRepo(), baseline: "no-such-ref" }),
    intended: [],
  },
  {
    name: "a whitespace-only baseline",
    build: () => ({ ...plainRepo(), baseline: "   " }),
    intended: [
      {
        id: "whitespace-baseline",
        fields: [
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
        ],
      },
    ],
  },
  {
    name: "no baseline and no origin: HEAD~1",
    build: () => {
      const { repo } = plainRepo();
      return { repo };
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
      return { repo };
    },
    intended: [],
  },
  {
    name: "no baseline and nothing to derive from",
    build: () => {
      const repo = makeRepo();
      write(repo, "a.txt", "one\n");
      commit(repo, "only commit");
      return { repo };
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
      return { repo, baseline };
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
      return { repo, baseline, secrets: ["ONLY=secret"] };
    },
    intended: [{ id: "empty-diff", fields: ALL_FIELDS }],
  },
  {
    name: "a directory that is not a git repository",
    build: () => ({ repo: scratch("nogit"), baseline: "main" }),
    intended: [{ id: "head-check", fields: ["reason"] }],
  },
];

describe("daemon and plugin capture, on the same hostile repositories", () => {
  for (const fixture of fixtures) {
    it(fixture.name, () => {
      const built = fixture.build();
      const daemon = daemonView(built);
      const pluginSide = pluginView(built);

      for (const { id } of fixture.intended) assert.ok(id in INTENDED, `${id} is not declared`);
      const declared = new Set(fixture.intended.flatMap(({ fields }) => fields));
      const actual = differingFields(daemon, pluginSide);
      for (const field of FIELDS) {
        const differs = actual.includes(field);
        assert.equal(
          differs,
          declared.has(field),
          differs
            ? `${field} differs and is not a declared difference:\n daemon: ${JSON.stringify(daemon[field])}\n plugin: ${JSON.stringify(pluginSide[field])}`
            : `${field} is declared as a difference but the two captures now agree`
        );
      }

      for (const marker of built.markers ?? []) {
        assert.equal(existsSync(marker), false, `a repository-configured command ran: ${marker}`);
      }
      const leaksOnDaemon = fixture.intended.some(({ id }) => id === "deny-list-gap");
      for (const secret of built.secrets ?? []) {
        assert.ok(
          !JSON.stringify(pluginSide).includes(secret),
          `the plugin capture carries ${secret}`
        );
        assert.equal(
          JSON.stringify(daemon).includes(secret),
          leaksOnDaemon,
          leaksOnDaemon
            ? `the deny-list gap is declared but the daemon no longer carries ${secret}`
            : `the daemon capture carries ${secret}`
        );
      }
    });
  }

  it("the plugin's snapshot never runs a repo-local core.fsmonitor command", () => {
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

describe("daemon and plugin spec-source resolution, on the same references", () => {
  interface Case {
    name: string;
    value: string;
    gh: (calls: string[][]) => Gh;
    /** Differences that are declared; none means the two agree on everything. */
    differs?: { reason: string; fields: string[] };
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
    },
    {
      name: "a short ref that is only an issue",
      value: "acme/widgets#9",
      gh: answer({ "issue acme/widgets#9": { title: "Nine", body: "body nine" } }),
    },
    {
      name: "hostile references",
      value:
        "https://evil.example.com/o/r/pull/1 http://github.com/o/r/pull/1 https://github.com/-o/r/pull/1 --repo/r#1 #99999999999",
      gh: answer({}),
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
    },
    {
      name: "gh missing",
      value: "https://github.com/acme/widgets/pull/1",
      gh: (calls) => (args) => {
        calls.push([...args]);
        return { ok: false, stdout: "", reason: "spawnSync gh ENOENT" };
      },
    },
    {
      name: "gh timing out on a short ref",
      value: "acme/widgets#5",
      gh: (calls) => (args) => {
        calls.push([...args]);
        return { ok: false, stdout: "", reason: "gh timed out", timedOut: true };
      },
      differs: {
        reason:
          "the plugin stops after `gh pr view` times out; the daemon then asks `gh issue view` too",
        fields: ["calls", "notes"],
      },
    },
  ];

  for (const spec of cases) {
    it(spec.name, () => {
      const dir = scratch("spec");
      const daemonCalls: string[][] = [];
      const pluginCalls: string[][] = [];
      const daemon = resolveSpecSources(dir, spec.value, spec.gh(daemonCalls));
      const pluginSide = plugin.resolveSpecSource(dir, spec.value, spec.gh(pluginCalls));

      const left: Record<string, unknown> = { ...daemon, calls: daemonCalls };
      const right: Record<string, unknown> = { ...pluginSide, calls: pluginCalls };
      const actual = ["calls", "literal", "full", "notes", "text"].filter(
        (field) => JSON.stringify(left[field]) !== JSON.stringify(right[field])
      );
      assert.deepEqual(actual, spec.differs?.fields ?? []);
    });
  }
});
