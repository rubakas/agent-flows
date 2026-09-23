import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { REVIEW_MATERIAL_CAP, buildReviewMaterial } from "./reviewMaterial.js";

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
