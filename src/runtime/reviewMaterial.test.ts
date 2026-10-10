import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import {
  REVIEW_MATERIAL_CAP,
  buildReviewMaterial,
  renderReviewMaterial,
} from "./reviewMaterial.js";
import type { GhRunner, ReviewMaterial } from "./reviewMaterial.js";

const cleanups: (() => void)[] = [];

after(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function git(cwd: string, ...args: string[]): string {
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
  return result.stdout;
}

function write(root: string, rel: string, contents: string): void {
  const target = path.join(root, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
}

/**
 * A repo with a baseline commit, then a commit that adds one file, changes
 * another and deletes a third — so every artefact has something to report.
 */
function fixtureRepo(): { repo: string; baseline: string } {
  const repo = tempDir("af-review-material-");
  git(repo, "init", "-q", "-b", "main");
  write(repo, "kept.txt", "one\n");
  write(repo, "doomed.txt", "goes away\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "baseline commit");
  const baseline = git(repo, "rev-parse", "HEAD").trim();

  write(repo, "kept.txt", "one\ntwo\n");
  write(repo, "added.txt", "brand new\n");
  fs.rmSync(path.join(repo, "doomed.txt"));
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "the change under review");

  return { repo, baseline };
}

/**
 * An obviously synthetic stand-in for a secret. Nothing in this file may contain
 * anything resembling a real credential; the assertions only need a string that
 * would be unmistakable if it ever reached an artefact.
 */
const CANARY = "CANARY_NOT_A_SECRET=xxx";

/**
 * A repo where a file holding a canary was added and deleted BEFORE the
 * baseline, so the change under review neither adds nor removes it. Its blob is
 * reachable only by object name — the shape of the arbitrary-read probe.
 */
function repoWithBuriedBlob(): {
  repo: string;
  baseline: string;
  blob: string;
  buriedCommit: string;
} {
  const repo = tempDir("af-review-blob-");
  git(repo, "init", "-q", "-b", "main");
  write(repo, "kept.txt", "one\n");
  write(repo, "leaked.txt", `${CANARY}\n`);
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "the commit that once held the file");
  const buriedCommit = git(repo, "rev-parse", "HEAD").trim();
  const blob = git(repo, "rev-parse", "HEAD:leaked.txt").trim();

  git(repo, "rm", "-q", "leaked.txt");
  git(repo, "commit", "-qm", "delete it again");
  const baseline = git(repo, "rev-parse", "HEAD").trim();

  write(repo, "kept.txt", "one\ntwo\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "the change under review");

  return { repo, baseline, blob, buriedCommit };
}

/** A repo where a tracked credential-shaped file changed between baseline and HEAD. */
function repoWithCredentialChange(): { repo: string; baseline: string } {
  const repo = tempDir("af-review-credential-");
  git(repo, "init", "-q", "-b", "main");
  write(repo, "kept.txt", "one\n");
  write(repo, ".env", `${CANARY}\n`);
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "baseline commit");
  const baseline = git(repo, "rev-parse", "HEAD").trim();

  write(repo, "kept.txt", "one\ntwo\n");
  write(repo, ".env", "CANARY_NOT_A_SECRET=yyy\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "change a source file and a credential file");

  return { repo, baseline };
}

/**
 * A repo where the change under review RENAMES a file across the deny list —
 * in whichever direction the caller asks for. The canary content is written
 * before the baseline and never touched again, so the rename is the only thing
 * that could carry it into an artefact.
 */
function repoWithCredentialRename(direction: "into" | "outOf"): {
  repo: string;
  baseline: string;
  from: string;
  to: string;
} {
  const repo = tempDir(`af-review-rename-${direction}-`);
  git(repo, "init", "-q", "-b", "main");
  // Local config beats a developer's global one, so the fixture behaves the
  // same on every machine: rename detection is ON, which is what makes the
  // pathspec-before-rename-detection hole reachable.
  git(repo, "config", "diff.renames", "true");
  const from = direction === "into" ? "notes.txt" : ".env";
  const to = direction === "into" ? ".env" : "notes.txt";

  write(repo, "kept.txt", "one\n");
  write(repo, from, `${CANARY}\nsecond line\nthird line\n`);
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "baseline commit");
  const baseline = git(repo, "rev-parse", "HEAD").trim();

  git(repo, "mv", from, to);
  write(repo, "kept.txt", "one\ntwo\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "rename the file across the deny list");

  return { repo, baseline, from, to };
}

/** Every place a capture can surface text: the digests and the files on disk. */
function allCapturedText(material: {
  digest: Record<string, string>;
  paths: Partial<Record<string, string>>;
}): string {
  const parts = [JSON.stringify(material)];
  for (const p of Object.values(material.paths)) {
    if (p !== undefined) parts.push(fs.readFileSync(p, "utf8"));
  }
  return parts.join("\n");
}

describe("buildReviewMaterial", () => {
  it("captures diff, commit list and changed files for a valid baseline", () => {
    const { repo, baseline } = fixtureRepo();
    const out = tempDir("af-review-out-");

    const material = buildReviewMaterial(repo, baseline, undefined, out);

    assert.equal(material.available, true);
    if (!material.available) return;

    assert.match(material.digest.diff, /\+two/u);
    assert.match(material.digest.diff, /added\.txt/u);
    assert.match(material.digest.commits, /the change under review/u);
    assert.equal(material.digest.commits.trim().split("\n").length, 1);
    const changed = material.digest.changedFiles.trim().split("\n").sort();
    assert.deepEqual(changed, ["added.txt", "doomed.txt", "kept.txt"]);

    // Provenance probes: the delete of doomed.txt and the stat of the commit.
    assert.match(material.digest.history, /doomed\.txt/u);
    assert.match(material.digest.history, /files? changed/u);

    // Full artefacts on disk, addressed absolutely so a `contents: read` step
    // can open what the digest could not carry.
    for (const name of ["diff", "commits", "changedFiles", "history"] as const) {
      const p = material.paths[name];
      assert.ok(p !== undefined, `${name} artefact was not written`);
      assert.ok(path.isAbsolute(p), `${name} path is not absolute: ${p}`);
      assert.ok(fs.existsSync(p), `${name} artefact missing on disk: ${p}`);
    }
  });

  it("rejects an option-shaped baseline before any git call", () => {
    const { repo } = fixtureRepo();
    const out = tempDir("af-review-out-");

    const material = buildReviewMaterial(repo, "--upload-pack=/bin/echo", undefined, out);

    assert.equal(material.available, false);
    if (material.available) return;
    assert.match(material.reason, /--upload-pack=\/bin\/echo/u);
    assert.match(material.reason, /option/u);
    // Nothing ran, so nothing was captured.
    assert.equal(fs.readdirSync(out).length, 0);
  });

  it("rejects a well-formed baseline that is not a commit in the repo", () => {
    const { repo } = fixtureRepo();
    const out = tempDir("af-review-out-");

    const material = buildReviewMaterial(repo, "no-such-ref", undefined, out);

    assert.equal(material.available, false);
    if (material.available) return;
    assert.match(material.reason, /does not resolve to a commit/u);
    assert.equal(fs.readdirSync(out).length, 0);
  });

  it("truncates an artefact larger than the cap and flags it", () => {
    const { repo, baseline } = fixtureRepo();
    const out = tempDir("af-review-out-");
    const huge = Array.from({ length: 4000 }, (_, i) => `line ${String(i)} of a very large file`);
    write(repo, "huge.txt", huge.join("\n") + "\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "add a file bigger than the cap");

    const material = buildReviewMaterial(repo, baseline, undefined, out);

    assert.equal(material.available, true);
    if (!material.available) return;
    assert.equal(material.truncated.diff, true);
    assert.ok(material.digest.diff.length <= REVIEW_MATERIAL_CAP + "\n[TRUNCATED]".length);
    assert.match(material.digest.diff, /\[TRUNCATED\]$/u);
    // The digest is capped; the artefact on disk is not.
    const onDisk = fs.readFileSync(material.paths.diff!, "utf8");
    assert.ok(onDisk.length > REVIEW_MATERIAL_CAP);
    assert.equal(material.truncated.commits, undefined);
  });

  it("returns unavailable rather than throwing outside a git repository", () => {
    const notARepo = tempDir("af-review-not-git-");
    const out = tempDir("af-review-out-");

    const material = buildReviewMaterial(notARepo, "main", undefined, out);

    assert.equal(material.available, false);
    if (material.available) return;
    assert.match(material.reason, /does not resolve to a commit/u);
  });

  it("skips a caller-supplied object name that does not peel to a commit", () => {
    const { repo, baseline, blob } = repoWithBuriedBlob();
    const out = tempDir("af-review-out-");

    // `--stat` is silently a no-op for a blob, so without the peel this argument
    // makes `git show` print the blob's whole contents into the history artefact.
    const material = buildReviewMaterial(repo, baseline, [blob], out);

    assert.equal(material.available, true);
    if (!material.available) return;

    assert.ok(
      !allCapturedText(material).includes("CANARY_NOT_A_SECRET"),
      "blob contents reached a review artefact"
    );
    assert.ok(
      !material.digest.history.includes(blob),
      `the blob object name was probed anyway: ${blob}`
    );
  });

  it("still probes a commit sha supplied by the caller", () => {
    const { repo, baseline, buriedCommit } = repoWithBuriedBlob();
    const out = tempDir("af-review-out-");

    const material = buildReviewMaterial(repo, baseline, [buriedCommit], out);

    assert.equal(material.available, true);
    if (!material.available) return;
    assert.ok(
      material.digest.history.includes(`# git show --stat ${buriedCommit}`),
      "a valid commit was not probed — the peel refused more than it should"
    );
    // The stat names the paths that commit touched; it never opens them.
    assert.match(material.digest.history, /leaked\.txt/u);
    assert.ok(!allCapturedText(material).includes("CANARY_NOT_A_SECRET"));
  });

  it("excludes a credential-shaped path from every artefact", () => {
    const { repo, baseline } = repoWithCredentialChange();
    const out = tempDir("af-review-out-");

    const material = buildReviewMaterial(repo, baseline, undefined, out);

    assert.equal(material.available, true);
    if (!material.available) return;

    assert.ok(
      !allCapturedText(material).includes("CANARY_NOT_A_SECRET"),
      "credential file contents reached a review artefact"
    );
    assert.ok(!material.digest.diff.includes(".env"), "the credential path is named in the diff");
    assert.ok(
      !material.digest.history.includes(".env"),
      "the credential path is named in the history probe"
    );
    assert.ok(!fs.readFileSync(material.paths.diff!, "utf8").includes(".env"));

    // The changed-file list carries the surviving paths and nothing withheld;
    // the disclosure trailer is comment-shaped, so it is not one of them.
    const listed = material.digest.changedFiles
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("#"));
    assert.deepEqual(listed, ["kept.txt"]);
  });

  it("discloses what it withheld and still carries every other change", () => {
    const { repo, baseline } = repoWithCredentialChange();
    const out = tempDir("af-review-out-");

    const material = buildReviewMaterial(repo, baseline, undefined, out);

    assert.equal(material.available, true);
    if (!material.available) return;

    assert.deepEqual(material.withheld, [".env"]);
    // The disclosure travels on the artefact a reviewer reads as the scope, so a
    // reviewer cannot read the omission as "unchanged".
    assert.match(material.digest.changedFiles, /withheld by credential policy/u);
    assert.match(material.digest.changedFiles, /# \.env$/mu);

    // Everything that is not credential-shaped is still there in full.
    assert.match(material.digest.diff, /kept\.txt/u);
    assert.match(material.digest.diff, /\+two/u);
    assert.match(material.digest.commits, /change a source file and a credential file/u);
  });

  for (const direction of ["into", "outOf"] as const) {
    it(`withholds both halves when a file is renamed ${direction} a denied name`, () => {
      const { repo, baseline, from, to } = repoWithCredentialRename(direction);
      const out = tempDir("af-review-out-");

      const material = buildReviewMaterial(repo, baseline, undefined, out);

      assert.equal(material.available, true);
      if (!material.available) return;

      // Excluding the denied half removes it from the diff queue before rename
      // detection runs, so without the counterpart pass the OTHER half is
      // emitted as a whole-file add or delete, canary and all.
      assert.ok(
        !allCapturedText(material).includes("CANARY_NOT_A_SECRET"),
        `renaming ${direction} a denied name carried the content into an artefact`
      );
      assert.ok(
        !material.digest.diff.includes(to) && !material.digest.diff.includes(from),
        "a half of the credential rename is still named in the diff"
      );

      // Both halves disclosed: a reviewer must not read the missing file as
      // "unchanged", under either name.
      assert.deepEqual([...material.withheld].sort(), [from, to].sort());
      assert.match(material.digest.changedFiles, /withheld by credential policy/u);

      // The rest of the change is untouched by the withholding.
      const listed = material.digest.changedFiles
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0 && !l.startsWith("#"));
      assert.deepEqual(listed, ["kept.txt"]);
      assert.match(material.digest.diff, /\+two/u);
    });
  }

  it("still reports an ordinary rename, with its content", () => {
    const repo = tempDir("af-review-plain-rename-");
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "diff.renames", "true");
    write(repo, "before.txt", "alpha\nbravo\ncharlie\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "baseline commit");
    const baseline = git(repo, "rev-parse", "HEAD").trim();

    git(repo, "mv", "before.txt", "after.txt");
    write(repo, "after.txt", "alpha\nbravo\ncharlie\ndelta\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "rename and extend");
    const out = tempDir("af-review-out-");

    const material = buildReviewMaterial(repo, baseline, undefined, out);

    assert.equal(material.available, true);
    if (!material.available) return;

    // The counterpart pass must withhold nothing when no denied path is
    // involved — a fix that blinds the reviewer to ordinary renames is no fix.
    assert.deepEqual(material.withheld, []);
    assert.match(material.digest.diff, /rename from before\.txt/u);
    assert.match(material.digest.diff, /rename to after\.txt/u);
    assert.match(material.digest.diff, /\+delta/u);
    // `--name-only` names a detected rename by its destination alone.
    assert.deepEqual(material.digest.changedFiles.trim().split("\n"), ["after.txt"]);
  });

  it("does not let a path named like pathspec magic blank the history probe", () => {
    const repo = tempDir("af-review-magic-path-");
    git(repo, "init", "-q", "-b", "main");
    write(repo, "kept.txt", "one\n");
    write(repo, ":(exclude)**", "magic name\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "baseline commit");
    const baseline = git(repo, "rev-parse", "HEAD").trim();

    write(repo, ":(exclude)**", "magic name, edited\n");
    write(repo, "added.txt", "brand new\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "the change under review");
    const out = tempDir("af-review-out-");

    const material = buildReviewMaterial(repo, baseline, undefined, out);

    assert.equal(material.available, true);
    if (!material.available) return;

    // Only the add/delete probe is under test: the `git show --stat` sections
    // name added.txt too, and asserting on the whole digest would pass even
    // with the probe blanked.
    const marker = "# add/delete history of the changed files\n";
    const start = material.digest.history.indexOf(marker);
    assert.notEqual(start, -1, "the add/delete history probe was not run at all");
    const end = material.digest.history.indexOf("\n# git show --stat", start);
    const probe = material.digest.history.slice(
      start + marker.length,
      end === -1 ? undefined : end
    );

    // Fed back as a bare pathspec, this filename reads as "exclude everything"
    // and silently empties the probe it was meant to widen.
    assert.match(probe, /added\.txt/u);
  });

  it("lists a non-ASCII path unquoted, so it survives being fed back to git", () => {
    const repo = tempDir("af-review-non-ascii-");
    git(repo, "init", "-q", "-b", "main");
    write(repo, "kept.txt", "one\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "baseline commit");
    const baseline = git(repo, "rev-parse", "HEAD").trim();

    write(repo, "café.txt", "accented\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "add a non-ASCII path");
    const out = tempDir("af-review-out-");

    const material = buildReviewMaterial(repo, baseline, undefined, out);

    assert.equal(material.available, true);
    if (!material.available) return;

    // Without `-z`, git prints `"caf\303\251.txt"`; fed back as a pathspec that
    // spelling matches nothing, and the file drops out of the probe silently.
    const listed = material.digest.changedFiles
      .split("\n")
      .filter((l) => l.length > 0 && !l.startsWith("#"));
    assert.equal(listed.length, 1);
    for (const line of listed) {
      assert.ok(!line.startsWith('"'), `path came back C-quoted: ${line}`);
      assert.ok(!line.includes("\\"), `path came back escaped: ${line}`);
    }
  });

  it("probes the resolved object name, not the caller's abbreviation", () => {
    const { repo, baseline, buriedCommit } = repoWithBuriedBlob();
    const out = tempDir("af-review-out-");
    const short = git(repo, "rev-parse", "--short=7", buriedCommit).trim();
    const shortBaseline = git(repo, "rev-parse", "--short=7", baseline).trim();

    const material = buildReviewMaterial(repo, shortBaseline, [short], out);

    assert.equal(material.available, true);
    if (!material.available) return;

    // What reaches `git show` is the 40-hex oid rev-parse printed. A bare
    // abbreviation is re-resolved by each command that receives it, and
    // `core.disambiguate` decides what it resolves TO.
    assert.ok(
      material.digest.history.includes(`# git show --stat ${buriedCommit}`),
      `the abbreviation was passed through instead of the resolved oid: ${material.digest.history}`
    );
    assert.ok(!allCapturedText(material).includes("CANARY_NOT_A_SECRET"));
  });
});

describe("the deny-list query is checked before anything is captured", () => {
  // `excluded.ok` used to be unread. `denied` then came back `[]` from a query
  // that never ran, `withheld` came back `[]`, and the capture went on to state
  // positively that nothing had been withheld — the "artefact vouches for a
  // redaction" failure the renameCounterparts comment exists to prevent, applied
  // to the deny list itself.
  //
  // Honest about what this pins: git offers no way to fail THAT query alone while
  // the diff and the log succeed, so what is asserted here is precedence — the
  // deny-list query is consulted first and its failure is what ends the capture.
  // With the guard removed the same fixture still reports unavailable, but blames
  // `git diff`, which is the later command that happened to fail too.
  it("reports the deny-list query as the reason, not a later command that also failed", () => {
    const { repo, baseline } = fixtureRepo();
    const out = tempDir("af-review-out-");
    // HEAD now names an unborn branch, so every revision range against it fails
    // while the baseline oid still peels to a commit.
    git(repo, "checkout", "-q", "--orphan", "unborn");

    const material = buildReviewMaterial(repo, baseline, undefined, out);

    assert.equal(material.available, false, JSON.stringify(material));
    if (material.available) return;
    assert.match(
      material.reason,
      /deny-list query failed/u,
      `the capture must stop on the deny-list query, not proceed past it: ${material.reason}`
    );
    assert.doesNotMatch(
      material.reason,
      /^git diff failed/u,
      `blaming the later command means the deny-list result was accepted unchecked: ${material.reason}`
    );
  });
});

// ─── spec sources: the daemon's only outbound network call ────────────────────

/**
 * A stand-in for `gh` that records every argv it was handed and answers from a
 * table keyed `<tool> <owner>/<repo>#<number>`.
 *
 * No test in this file may make a network call, and the recorded argv is the
 * point as much as the answer: the security gates here are about which values
 * reach `gh` at all, so "never called" has to be observable.
 */
function fakeGh(table: Record<string, { title?: string; body?: string; url?: string }>): {
  gh: GhRunner;
  calls: string[][];
} {
  const calls: string[][] = [];
  const gh: GhRunner = (args) => {
    calls.push([...args]);
    const [tool, , number, , repo] = args;
    const entry = table[`${tool} ${repo}#${number}`];
    if (entry === undefined) {
      return { ok: false, stdout: "", reason: `no ${tool} found for ${repo}#${number}` };
    }
    return {
      ok: true,
      stdout: JSON.stringify({
        title: entry.title ?? "",
        body: entry.body ?? "",
        url: entry.url ?? `https://github.com/${repo}/issues/${number}`,
      }),
      reason: "",
    };
  };
  return { gh, calls };
}

/** The `## spec sources` section of a rendered capture, or "" when absent. */
function specSourcesSection(material: ReviewMaterial): string {
  const rendered = renderReviewMaterial(material);
  const start = rendered.indexOf("## spec sources");
  if (start === -1) return "";
  const rest = rendered.slice(start);
  const next = rest.indexOf("\n\n## ");
  return next === -1 ? rest : rest.slice(0, next);
}

describe("spec sources — a GitHub reference is fetched by the daemon, not by the model", () => {
  it("a pull-request URL is fetched with an argv array and rendered as a section", () => {
    const { repo, baseline } = fixtureRepo();
    const out = tempDir("af-review-out-");
    const { gh, calls } = fakeGh({
      "pr domcap/ascent-portal#1365": {
        title: "Harden the importer",
        body: "The importer must reject an empty payload.",
        url: "https://github.com/domcap/ascent-portal/pull/1365",
      },
    });

    const material = buildReviewMaterial(repo, baseline, undefined, out, {
      specSources: "https://github.com/domcap/ascent-portal/pull/1365",
      gh,
    });

    assert.deepEqual(calls, [
      ["pr", "view", "1365", "--repo", "domcap/ascent-portal", "--json", "title,body,url"],
    ]);
    const section = specSourcesSection(material);
    assert.match(section, /Harden the importer/u);
    assert.match(section, /The importer must reject an empty payload\./u);
    assert.match(section, /domcap\/ascent-portal#1365: fetched pull request/u);

    const artefact = path.join(out, "spec-sources.txt");
    assert.ok(
      fs.existsSync(artefact),
      "the resolved text must be written beside the git artefacts"
    );
    assert.match(fs.readFileSync(artefact, "utf8"), /The importer must reject an empty payload\./u);
  });

  it("a bare #n resolves against the repository's own github.com origin", () => {
    const { repo, baseline } = fixtureRepo();
    git(repo, "remote", "add", "origin", "git@github.com:acme/widgets.git");
    const out = tempDir("af-review-out-");
    const { gh, calls } = fakeGh({
      "pr acme/widgets#7": { title: "Seven", body: "body seven" },
    });

    const material = buildReviewMaterial(repo, baseline, undefined, out, {
      specSources: "#7",
      gh,
    });

    assert.deepEqual(calls[0], [
      "pr",
      "view",
      "7",
      "--repo",
      "acme/widgets",
      "--json",
      "title,body,url",
    ]);
    assert.match(specSourcesSection(material), /body seven/u);
  });

  it("a short ref that is not a pull request falls back to the issue view", () => {
    const { repo, baseline } = fixtureRepo();
    const out = tempDir("af-review-out-");
    const { gh, calls } = fakeGh({
      "issue acme/widgets#9": { title: "Nine", body: "body nine" },
    });

    const material = buildReviewMaterial(repo, baseline, undefined, out, {
      specSources: "acme/widgets#9",
      gh,
    });

    assert.deepEqual(
      calls.map((c) => c[0]),
      ["pr", "issue"],
      "a short ref does not say which it is, so both views are tried, pr first"
    );
    assert.deepEqual(calls[1], [
      "issue",
      "view",
      "9",
      "--repo",
      "acme/widgets",
      "--json",
      "title,body,url",
    ]);
    assert.match(specSourcesSection(material), /body nine/u);
  });
});

describe("spec sources — hostile values never reach gh", () => {
  // Each case is (value, what must appear in the section). The assertion that
  // matters in every one of them is the same: `gh` was not invoked at all.
  const refused: [string, RegExp][] = [
    [
      "https://evil.example.com/domcap/ascent-portal/pull/1365",
      /host "evil\.example\.com" is not github\.com/u,
    ],
    ["http://github.com/domcap/ascent-portal/pull/1365", /refused/u],
    ["https://github.com/-evil/ascent-portal/pull/1365", /not a valid GitHub owner\/repo/u],
    ["https://github.com/domcap/ascent-portal/pull/--version", /not an issue or pull-request/u],
    ["--repo/ascent-portal#1365", /not a valid GitHub owner\/repo/u],
    ["#99999999999", /not an issue or pull-request/u],
  ];

  for (const [value, expected] of refused) {
    it(`refuses ${value} before any gh call`, () => {
      const { repo, baseline } = fixtureRepo();
      const out = tempDir("af-review-out-");
      const { gh, calls } = fakeGh({});

      const material = buildReviewMaterial(repo, baseline, undefined, out, {
        specSources: value,
        gh,
      });

      assert.deepEqual(calls, [], `gh must not be invoked for ${value}`);
      assert.match(specSourcesSection(material), expected);
    });
  }

  it("an option-shaped value is literal text and reaches nothing", () => {
    const { repo, baseline } = fixtureRepo();
    const out = tempDir("af-review-out-");
    const { gh, calls } = fakeGh({});

    const material = buildReviewMaterial(repo, baseline, undefined, out, {
      specSources: "--json",
      gh,
    });

    assert.deepEqual(calls, []);
    const section = specSourcesSection(material);
    assert.match(section, /literal text/u);
    assert.match(section, /--json/u);
  });
});

describe("spec sources — literal text is passed through unchanged", () => {
  it('the value "none" is carried through and fetches nothing', () => {
    const { repo, baseline } = fixtureRepo();
    const out = tempDir("af-review-out-");
    const { gh, calls } = fakeGh({});

    const material = buildReviewMaterial(repo, baseline, undefined, out, {
      specSources: "none",
      gh,
    });

    assert.deepEqual(calls, []);
    const section = specSourcesSection(material);
    assert.match(section, /literal text — no GitHub reference named/u);
    assert.match(section, /^none$/mu);
  });

  it("a pasted ticket body survives byte for byte, including the issue numbers in it", () => {
    const { repo, baseline } = fixtureRepo();
    const out = tempDir("af-review-out-");
    const { gh, calls } = fakeGh({});
    const body = "FR-001: the importer must reject an empty payload.\nSee #1365 for context.";

    const material = buildReviewMaterial(repo, baseline, undefined, out, {
      specSources: body,
      gh,
    });

    assert.deepEqual(calls, [], "prose that merely mentions #1365 is not a reference list");
    assert.ok(
      specSourcesSection(material).includes(body),
      `the literal value must survive unchanged: ${specSourcesSection(material)}`
    );
  });
});

describe("spec sources — a failing gh degrades instead of throwing", () => {
  it("records the reason, keeps the capture available, and fetches nothing else", () => {
    const { repo, baseline } = fixtureRepo();
    const out = tempDir("af-review-out-");
    const calls: string[][] = [];
    const gh: GhRunner = (args) => {
      calls.push([...args]);
      // What a missing binary looks like coming out of spawnSync.
      return { ok: false, stdout: "", reason: "spawnSync gh ENOENT" };
    };

    const material = buildReviewMaterial(repo, baseline, undefined, out, {
      specSources: "https://github.com/domcap/ascent-portal/pull/1365",
      gh,
    });

    assert.equal(material.available, true, JSON.stringify(material));
    const section = specSourcesSection(material);
    assert.match(section, /domcap\/ascent-portal#1365: not fetched \(spawnSync gh ENOENT\)/u);
    assert.match(section, /0 of 1 attempted reference\(s\) fetched/u);
    assert.equal(calls.length, 1, "a pull-request URL says which view it needs; no fallback");
  });
});

describe("spec sources — linked issues are followed within one total cap", () => {
  it("follows the issues a pull-request body closes and stops at ten fetches", () => {
    const { repo, baseline } = fixtureRepo();
    const out = tempDir("af-review-out-");
    const linked = Array.from({ length: 20 }, (_, i) => `Closes #${String(i + 1)}`).join("\n");
    const table: Record<string, { title?: string; body?: string }> = {
      "pr acme/widgets#100": { title: "The change", body: linked },
    };
    for (let n = 1; n <= 20; n += 1) {
      table[`issue acme/widgets#${String(n)}`] = {
        title: `Issue ${String(n)}`,
        body: `body ${String(n)}`,
      };
    }
    const { gh, calls } = fakeGh(table);

    const material = buildReviewMaterial(repo, baseline, undefined, out, {
      specSources: "https://github.com/acme/widgets/pull/100",
      gh,
    });

    assert.equal(
      calls.length,
      10,
      `the cap is on total fetches, refs and the issues they link alike; got ${String(calls.length)}`
    );
    const section = specSourcesSection(material);
    assert.match(section, /body 1$/mu, "the first linked issue must actually be followed");
    assert.match(section, /stopped at the cap of 10 fetches/u);
    assert.ok(!section.includes("body 20"), "nothing past the cap may be fetched");
  });
});

// ─── baseline: a caller who names none still gets a review ────────────────────

/**
 * A repo whose default branch is behind the checked-out one: `origin/main` is
 * at the first commit, HEAD is two commits ahead on `feature`. That is the
 * shape the merge-base rule exists for — the derived baseline must be the
 * fork point, not HEAD~1, or the review sees only the last commit of a branch.
 */
function repoWithDefaultBranch(): { repo: string; forkPoint: string; second: string } {
  const repo = tempDir("af-review-baseline-");
  git(repo, "init", "-q", "-b", "main");
  write(repo, "kept.txt", "one\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "the fork point");
  const forkPoint = git(repo, "rev-parse", "HEAD").trim();

  git(repo, "checkout", "-q", "-b", "feature");
  write(repo, "first.txt", "first change\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "first commit of the branch");
  const second = git(repo, "rev-parse", "HEAD").trim();
  write(repo, "second.txt", "second change\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "second commit of the branch");

  // The remote-tracking state a clone would have, without a network: origin/main
  // at the fork point, and origin/HEAD naming it as the default branch.
  git(repo, "remote", "add", "origin", "git@github.com:acme/widgets.git");
  git(repo, "update-ref", "refs/remotes/origin/main", forkPoint);
  git(repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  return { repo, forkPoint, second };
}

describe("baseline — derived when the caller names none", () => {
  it("takes the merge-base with the default branch and says so", () => {
    const { repo, forkPoint } = repoWithDefaultBranch();
    const out = tempDir("af-review-out-");

    const material = buildReviewMaterial(repo, "", undefined, out);

    assert.equal(material.available, true, JSON.stringify(material));
    if (!material.available) return;
    assert.equal(material.baseline, forkPoint);
    assert.equal(material.baselineRule, "merge-base");
    // Both commits of the branch are in scope — the point of the merge-base rule.
    assert.match(material.digest.commits, /first commit of the branch/u);
    assert.match(material.digest.commits, /second commit of the branch/u);
    // The rule reaches the reviewer, not only the structured result.
    const rendered = renderReviewMaterial(material);
    assert.match(rendered, /## baseline\n[0-9a-f]{40}\nderived: no baseline was supplied/u);
    assert.match(rendered, /merge-base of HEAD and this repository's default branch/u);
  });

  it("a caller-supplied baseline still wins over the derivation", () => {
    const { repo, second } = repoWithDefaultBranch();
    const out = tempDir("af-review-out-");

    const material = buildReviewMaterial(repo, second, undefined, out);

    assert.equal(material.available, true, JSON.stringify(material));
    if (!material.available) return;
    assert.equal(material.baseline, second);
    assert.equal(material.baselineRule, "caller");
    assert.match(renderReviewMaterial(material), /## baseline\n.*\nsupplied by the caller/u);
    assert.doesNotMatch(material.digest.commits, /first commit of the branch/u);
  });

  it("falls back to HEAD~1 when there is no default branch to fork from", () => {
    const { repo } = fixtureRepo(); // no origin, no remote-tracking refs at all
    const out = tempDir("af-review-out-");
    const previous = git(repo, "rev-parse", "HEAD~1").trim();

    const material = buildReviewMaterial(repo, undefined, undefined, out);

    assert.equal(material.available, true, JSON.stringify(material));
    if (!material.available) return;
    assert.equal(material.baseline, previous);
    assert.equal(material.baselineRule, "previous-commit");
    assert.match(renderReviewMaterial(material), /HEAD~1 was used/u);
  });

  it("an omitted baseline is derived; a malformed one is still refused by name", () => {
    const { repo } = fixtureRepo();
    const out = tempDir("af-review-out-");

    const derived = buildReviewMaterial(repo, "   ", undefined, out);
    assert.equal(derived.available, true, "whitespace is an omission, not a value");

    const refused = buildReviewMaterial(repo, "--upload-pack=/bin/echo", undefined, out);
    assert.equal(refused.available, false, "a hostile value must never be replaced by a guess");
    if (refused.available) return;
    assert.match(refused.reason, /option/u);
  });

  it("reports specSourcesResolved for what the caller pointed the delivery axis at", () => {
    const { repo, baseline } = fixtureRepo();
    const out = tempDir("af-review-out-");
    const { gh } = fakeGh({ "pr acme/widgets#4": { title: "Four", body: "body four" } });

    const none = buildReviewMaterial(repo, baseline, undefined, out);
    assert.equal(none.specSourcesResolved, false);
    assert.match(none.specSourcesReason, /no spec sources were supplied/u);

    const fetched = buildReviewMaterial(repo, baseline, undefined, out, {
      specSources: "acme/widgets#4",
      gh,
    });
    assert.equal(fetched.specSourcesResolved, true, fetched.specSourcesReason);
    assert.equal(fetched.specSourcesReason, "");

    const failed = buildReviewMaterial(repo, baseline, undefined, out, {
      specSources: "https://evil.example.com/acme/widgets/pull/4",
      gh,
    });
    assert.equal(failed.specSourcesResolved, false);
    assert.match(failed.specSourcesReason, /nothing the caller named could be read/u);
  });
});
