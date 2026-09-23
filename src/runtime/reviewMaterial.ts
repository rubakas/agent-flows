// The repository material a review pipeline is given, captured without a shell.
//
// A review step holds `contents: read` — Read, Glob and Grep, never Bash (see
// StepDef.permissions in canon/types.ts). That is deliberate: a reviewer must
// not be able to run commands in the tree it is judging. But a review that
// cannot see the diff, the commits or the history of the files it is reviewing
// has to guess at provenance, and a guess is what the review is supposed to
// replace. This module is the other half of that trade: the daemon — not the
// model — runs the git commands, and hands the result in as data.
//
// A `check` step is not an option here. Check commands are deliberately NOT
// placeholder-rendered (see pipelines/ship.yaml and the loader's placeholder
// rule) because interpolating anything run-scoped into a shell string is
// command injection, and `baseline` is caller-supplied. Every git call below
// uses an argv array through spawnSync; no `/bin/sh` is involved anywhere.

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { CREDENTIAL_DENY_PATTERNS } from "../canon/denyPatterns.js";

/**
 * Max characters of any single artefact carried in the digest. Mirrors
 * CHECK_OUTPUT_CAP (canon/runStep.ts): the same 64 KB budget a check step's
 * output gets, for the same reason — the value travels into a prompt and into
 * API responses, and command output is unbounded.
 */
export const REVIEW_MATERIAL_CAP = 65_536;

/** Max commits probed with `git show --stat`; each probe is a process. */
const MAX_COMMIT_PROBES = 50;

/** Max changed paths passed as pathspecs to the history probe. */
const MAX_HISTORY_PATHS = 200;

/** spawnSync buffer for a capture: a real diff is far larger than the 1 MB default. */
const GIT_MAX_BUFFER = 32 * 1024 * 1024;

/**
 * A conservative revision name: alphanumerics and the punctuation git's own
 * revision syntax needs (`.` `_` `-` `/` `~` `^`). Anything else — `=`, spaces,
 * `..` of a different shape, quotes — never reaches git. Combined with the
 * leading-dash rejection below this is what stops `--upload-pack=/bin/echo`
 * and its family: an argv array keeps a value out of a shell, but it does NOT
 * keep it out of git's own option parser.
 */
const RE_REVISION = /^[A-Za-z0-9._\-/~^]+$/u;

/** Longest accepted baseline. A revision name is short; a payload is not. */
const MAX_BASELINE_LENGTH = 256;

/** An object name, as git prints it and as a caller may supply it. */
const RE_SHA = /^[0-9a-f]{7,40}$/u;

/** A fully resolved object name, as `rev-parse` prints it. */
const RE_OID = /^[0-9a-f]{40}$/u;

/**
 * The credential deny list, expressed as git pathspecs.
 *
 * CREDENTIAL_DENY_PATTERNS is enforced elsewhere as `--disallowedTools` entries
 * on a provider CLI — that constrains the MODEL'S tools and cannot constrain the
 * git processes this module spawns in the daemon. Everything captured here is
 * written to disk and rendered into four reviewer prompts, i.e. transmitted to a
 * model provider, so the same list has to be enforced on this path too.
 *
 * It is enforced as a pathspec rather than by filtering the captured text: a
 * post-filter runs on a string that already holds the secret. With `:(exclude)`
 * the content never enters this process's memory at all.
 *
 * Magic: `top` anchors each pattern at the repository root rather than at the
 * working directory the capture runs from, and `glob` gives `**` its
 * gitignore-style meaning ("at any depth, including the root"), which is how the
 * deny list is written. The leading `:/` is the positive pathspec "the whole
 * tree" — without it the capture would be scoped to the current directory.
 *
 * Imported, never re-spelled: a hand-copied second list drifts from the first.
 */
const CREDENTIAL_EXCLUDE_PATHSPECS: readonly string[] = CREDENTIAL_DENY_PATTERNS.map(
  (pattern) => `:(top,exclude,glob)${pattern}`
);

/** The exclusions plus "the whole tree", for a query that names no path of its own. */
const SAFE_PATHSPECS: readonly string[] = [":/", ...CREDENTIAL_EXCLUDE_PATHSPECS];

/** The same list inverted: matches ONLY the credential-shaped paths. */
const CREDENTIAL_PATHSPECS: readonly string[] = CREDENTIAL_DENY_PATTERNS.map(
  (pattern) => `:(top,glob)${pattern}`
);

/**
 * One path git printed, re-expressed as a pathspec that can only ever mean that
 * path. `literal` turns off pathspec magic, so a tracked file actually named
 * `:(exclude)**` is matched as a name instead of being re-read as a pattern
 * that silently blanks the query it was fed to; `top` anchors it at the
 * repository root, which is what git's own `-z` output is relative to.
 */
function asLiteralPathspec(path: string): string {
  return `:(top,literal)${path}`;
}

/** The same, as an exclusion. */
function asLiteralExclusion(path: string): string {
  return `:(top,exclude,literal)${path}`;
}

/** Splits git's `-z` output into its NUL-separated fields. */
function nulFields(stdout: string): string[] {
  return stdout.split("\0").filter((field) => field.length > 0);
}

/** The artefacts captured for a review. */
export type ReviewArtefact = "diff" | "commits" | "changedFiles" | "history";

const ARTEFACT_FILES: Record<ReviewArtefact, string> = {
  diff: "diff.txt",
  commits: "commits.txt",
  changedFiles: "changed-files.txt",
  history: "history.txt",
};

export interface ReviewMaterialAvailable {
  available: true;
  /** Absolute path of each artefact written to disk, keyed by artefact name. */
  paths: Partial<Record<ReviewArtefact, string>>;
  /** Bounded text of each artefact, capped at REVIEW_MATERIAL_CAP. */
  digest: Record<ReviewArtefact, string>;
  /** True for each artefact whose digest text was capped. */
  truncated: Partial<Record<ReviewArtefact, boolean>>;
  /** The validated baseline the capture ran against. */
  baseline: string;
  /**
   * Changed paths excluded from every artefact by the credential deny list.
   *
   * The PATHS, never the contents — a path is not a secret, and a review handed
   * a diff it believes is complete while files are silently missing reviews a
   * fiction. Empty when nothing was withheld.
   */
  withheld: string[];
}

export interface ReviewMaterialUnavailable {
  available: false;
  reason: string;
}

export type ReviewMaterial = ReviewMaterialAvailable | ReviewMaterialUnavailable;

interface GitOutcome {
  ok: boolean;
  stdout: string;
  reason: string;
}

/**
 * One git invocation as an argv array. Never throws and never uses a shell:
 * a spawn error, a non-zero exit and a thrown exception all come back as
 * `ok: false` with a one-line reason, the same defensive shape
 * `captureGitStatus` in gateMaterial.ts uses.
 */
function git(projectDir: string, args: readonly string[]): GitOutcome {
  try {
    const result = spawnSync("git", [...args], {
      cwd: projectDir,
      encoding: "utf8",
      maxBuffer: GIT_MAX_BUFFER,
    });
    if (result.error !== null && result.error !== undefined) {
      return { ok: false, stdout: "", reason: result.error.message };
    }
    if (result.status !== 0) {
      const stderr = (result.stderr ?? "").trim().split("\n")[0] ?? "";
      return {
        ok: false,
        stdout: "",
        reason: stderr === "" ? `git exited ${String(result.status)}` : stderr,
      };
    }
    return { ok: true, stdout: result.stdout ?? "", reason: "" };
  } catch (err) {
    return { ok: false, stdout: "", reason: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Rejects a baseline that is not a plausible revision name. Returns the reason
 * the value was refused, or undefined when it is acceptable to pass to git.
 */
export function rejectBaseline(baseline: unknown): string | undefined {
  if (typeof baseline !== "string" || baseline.trim() === "") {
    return "baseline is empty — nothing to diff against";
  }
  if (baseline.length > MAX_BASELINE_LENGTH) {
    return `baseline is longer than ${String(MAX_BASELINE_LENGTH)} characters — not a revision name`;
  }
  if (baseline.startsWith("-")) {
    return `baseline ${JSON.stringify(baseline)} starts with "-" — it would be read by git as an option, not a revision`;
  }
  if (!RE_REVISION.test(baseline)) {
    return `baseline ${JSON.stringify(baseline)} is not a valid revision name — allowed: letters, digits, and . _ - / ~ ^`;
  }
  return undefined;
}

/** Caps `text` and reports whether it was capped. */
function cap(text: string): { text: string; truncated: boolean } {
  if (text.length <= REVIEW_MATERIAL_CAP) return { text, truncated: false };
  return { text: text.slice(0, REVIEW_MATERIAL_CAP) + "\n[TRUNCATED]", truncated: true };
}

/** Writes one artefact in full. Returns its absolute path, or undefined on failure. */
function writeArtefact(outDir: string, name: ReviewArtefact, body: string): string | undefined {
  const path = join(outDir, ARTEFACT_FILES[name]);
  try {
    mkdirSync(outDir, { recursive: true, mode: 0o700 });
    writeFileSync(path, body, { encoding: "utf8", mode: 0o600 });
    return path;
  } catch {
    // A disk problem must not fail the capture: the digest is still usable.
    return undefined;
  }
}

/**
 * Peels `rev` to a commit and returns the RESOLVED 40-hex object name, or
 * undefined when it does not name a commit.
 *
 * The resolved name — never the caller's string — is what every later command
 * gets. Verifying `${rev}^{commit}` and then passing `rev` on bare is a
 * validate-then-use-the-original hole: `^{commit}` forces committish
 * disambiguation, a bare short sha does not. In a repository with
 * `core.disambiguate=blob`, a 7-hex prefix that is ambiguous between a commit
 * and a blob peels fine while `git show --stat <prefix>` resolves to the blob
 * and prints its whole body — and pathspecs are inert for `git show <blob>`.
 * A 40-hex oid cannot be re-resolved to anything else.
 *
 * Known and accepted: an object reachable through
 * `.git/objects/info/alternates` peels like any other, so `git show --stat`
 * can print a foreign repository's commit subject and changed-file NAMES. That
 * is metadata only — no file content — and requires an alternates file to be
 * present already.
 */
function resolveCommit(projectDir: string, rev: string): string | undefined {
  const parsed = git(projectDir, ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`]);
  if (!parsed.ok) return undefined;
  const oid = parsed.stdout.trim();
  return RE_OID.test(oid) ? oid : undefined;
}

/** The object names to probe, caller-supplied ones validated, git's own trusted. */
function probeCommits(
  projectDir: string,
  commitLog: string,
  introducedCommits: readonly string[] | undefined
): string[] {
  const shas: string[] = [];
  for (const line of commitLog.split("\n")) {
    const sha = line.trim().split(" ")[0] ?? "";
    if (RE_SHA.test(sha)) shas.push(sha);
  }
  for (const candidate of introducedCommits ?? []) {
    // Caller-supplied and therefore untrusted: held to the object-name shape,
    // not merely to the revision shape the baseline passes.
    const sha = typeof candidate === "string" ? candidate.trim() : "";
    if (!RE_SHA.test(sha)) continue;
    // RE_SHA describes an object name's SHAPE, not its TYPE, and `--stat` is
    // silently a no-op for a blob: `git show --stat <blob>` prints the blob's
    // whole contents and exits 0. Since the list arrives through an
    // unauthenticated localhost daemon, accepting shape alone is an arbitrary
    // read of any object in the ODB — a credential file committed once and
    // later deleted is still reachable by its blob name. Peel to a commit and
    // skip anything that will not peel, the same check the baseline passes.
    // What gets probed is the RESOLVED name, not `sha` — see resolveCommit.
    const resolved = resolveCommit(projectDir, sha);
    if (resolved === undefined) continue;
    shas.push(resolved);
  }
  return [...new Set(shas)].slice(0, MAX_COMMIT_PROBES);
}

/**
 * The paths a rename pairs with a credential-shaped path, which must be
 * withheld too.
 *
 * Git applies pathspec filtering to the diff queue BEFORE rename detection.
 * Excluding a denied path therefore removes one half of the pair, the rename is
 * never detected, and the surviving half is emitted as a pure `new file` or
 * `deleted file` — with every line of the denied file's content in it, under a
 * name the deny list says nothing about. Worse, `withheld` still names the
 * denied path correctly, so the artefact vouches for a redaction while the
 * bytes sit above it under another name.
 *
 * So the detection pass runs with NO exclusions — excluding is precisely what
 * destroys the pair it has to see. That is safe because it emits no content:
 * `--name-status` prints status letters and names, never a hunk. `-p` must
 * never be added here.
 *
 * Scope, deliberately: a plain copy (`cp <denied> backup.txt`) is NOT covered
 * and is not meant to be. The deny list is path-shaped, and after such a copy
 * the copy is an ordinary readable file a `contents: read` step could simply
 * open. Renaming INTO or OUT OF a denied name is the different case — there the
 * content only exists under a name the deny list would otherwise hide.
 *
 * @param denied Changed paths already matched by the deny list.
 */
function renameCounterparts(
  projectDir: string,
  oid: string,
  denied: ReadonlySet<string>
): string[] {
  const pairs = git(projectDir, ["diff", "--name-status", "-M", "-z", `${oid}...HEAD`, "--", ":/"]);
  if (!pairs.ok) return [];

  const counterparts: string[] = [];
  const fields = nulFields(pairs.stdout);
  for (let i = 0; i < fields.length;) {
    const status = fields[i] ?? "";
    // A rename record is three fields — status, source, destination — and
    // every other record is two. Both shapes have to be parsed correctly or
    // the walk falls out of step with git's output.
    if (status.startsWith("R")) {
      const from = fields[i + 1];
      const to = fields[i + 2];
      i += 3;
      if (from === undefined || to === undefined) break;
      if (denied.has(from) && !denied.has(to)) counterparts.push(to);
      else if (denied.has(to) && !denied.has(from)) counterparts.push(from);
      continue;
    }
    i += 2;
  }
  return [...new Set(counterparts)];
}

/**
 * Captures the material a review needs: the diff, the commits that produced it,
 * the files it touches, and the history of those files so a reviewer can answer
 * provenance questions ("was this deleted before?") without running anything.
 *
 * Each artefact is written to disk in full and carried in the digest only up to
 * REVIEW_MATERIAL_CAP. A real diff exceeds any prompt; the review steps hold
 * `contents: read`, so they can open the artefact file and read the rest. That
 * is why the digest carries ABSOLUTE paths.
 *
 * Credential-shaped paths are excluded from every capturing command by pathspec,
 * so their contents never reach the artefacts, the digest or a prompt. The paths
 * themselves come back in `withheld`: a reviewer told the diff is complete when
 * it is not reviews a fiction.
 *
 * Never throws.
 *
 * @param projectDir Working tree to capture from.
 * @param baseline Untrusted caller input: the revision the change is measured against.
 * @param introducedCommits Untrusted caller-supplied object names to probe as well.
 * @param outDir Directory the full artefacts are written into (the run's own directory).
 */
export function buildReviewMaterial(
  projectDir: string,
  baseline: unknown,
  introducedCommits: readonly string[] | undefined,
  outDir: string
): ReviewMaterial {
  const rejection = rejectBaseline(baseline);
  if (rejection !== undefined) return { available: false, reason: rejection };
  const rev = baseline as string;

  // The pattern says the value is shaped like a revision; only git can say it
  // names one. Both checks run before any capturing command is issued. Every
  // command below is given the RESOLVED name, never `rev` itself.
  const oid = resolveCommit(projectDir, rev);
  if (oid === undefined) {
    return {
      available: false,
      reason: `baseline ${JSON.stringify(rev)} does not resolve to a commit in this repository`,
    };
  }

  // The deny list as the POSITIVE pathspec: the names of the changed paths the
  // capture is withholding. Names only — no content is read. This runs first
  // because the rename pass below needs to know which paths are denied.
  const excluded = git(projectDir, [
    "diff",
    "--name-only",
    "-z",
    `${oid}...HEAD`,
    "--",
    ...CREDENTIAL_PATHSPECS,
  ]);
  // A failed query is not an empty result. Without this branch `denied` is `[]`,
  // `withheld` is `[]`, and the capture goes on to state positively that nothing
  // was withheld — on the strength of a query that never ran. That is the same
  // "the artefact vouches for a redaction" failure renameCounterparts exists to
  // prevent, and it is worse here because it covers the deny list itself.
  if (!excluded.ok) {
    return {
      available: false,
      reason: `the credential deny-list query failed (${excluded.reason}) — refusing to capture material whose withholding cannot be reported`,
    };
  }
  const denied = nulFields(excluded.stdout);
  const deniedSet = new Set(denied);

  // A repo-wide rename pass costs a process and there is nothing for it to pair
  // when the deny list matched no changed path.
  const counterparts = denied.length === 0 ? [] : renameCounterparts(projectDir, oid, deniedSet);
  const extraExclusions = counterparts.map(asLiteralExclusion);
  const safePathspecs = [...SAFE_PATHSPECS, ...extraExclusions];
  const withheld = [...denied, ...counterparts];

  const diff = git(projectDir, ["diff", `${oid}...HEAD`, "--", ...safePathspecs]);
  if (!diff.ok) return { available: false, reason: `git diff failed: ${diff.reason}` };

  const commits = git(projectDir, ["log", "--format=%H %s", `${oid}..HEAD`, "--"]);
  if (!commits.ok) return { available: false, reason: `git log failed: ${commits.reason}` };

  const changed = git(projectDir, [
    "diff",
    "--name-only",
    "-z",
    `${oid}...HEAD`,
    "--",
    ...safePathspecs,
  ]);
  if (!changed.ok)
    return { available: false, reason: `git diff --name-only failed: ${changed.reason}` };

  // `-z` so a path arrives exactly as it is on disk. Without it git C-quotes a
  // non-ASCII name (`"caf\303\251.txt"`), and these paths are fed back to git as
  // pathspecs below, where the quoted spelling matches nothing at all.
  const allChangedPaths = nulFields(changed.stdout);
  const changedPaths = allChangedPaths.slice(0, MAX_HISTORY_PATHS);
  const changedList = allChangedPaths.length === 0 ? "" : allChangedPaths.join("\n") + "\n";

  // Provenance probes. `--` separates the pathspecs from the revision arguments
  // so a file literally named like an option is still read as a path.
  const historyParts: string[] = [];
  if (changedPaths.length > 0) {
    const fileHistory = git(projectDir, [
      "log",
      "--all",
      "--diff-filter=AD",
      "--name-status",
      "--format=%H %s",
      "--",
      ...changedPaths.map(asLiteralPathspec),
      // changedPaths is already free of credential-shaped paths; the exclusions
      // are repeated so the probe is safe by its own argv, not by its caller's.
      ...CREDENTIAL_EXCLUDE_PATHSPECS,
      ...extraExclusions,
    ]);
    historyParts.push(
      fileHistory.ok
        ? `# add/delete history of the changed files\n${fileHistory.stdout}`
        : `# add/delete history unavailable: ${fileHistory.reason}`
    );
  }
  for (const sha of probeCommits(projectDir, commits.stdout, introducedCommits)) {
    const stat = git(projectDir, ["show", "--stat", "--format=%H %s", sha, "--", ...safePathspecs]);
    historyParts.push(
      stat.ok ? `# git show --stat ${sha}\n${stat.stdout}` : `# ${sha} unavailable: ${stat.reason}`
    );
  }

  // The withholding is disclosed on the artefact a reviewer reads as the scope
  // of the change, so it travels with the omission it explains rather than only
  // in a field beside it. Absent when nothing was withheld: a notice on every
  // capture is noise a reader learns to skip.
  const disclosure =
    withheld.length === 0
      ? ""
      : `\n# ${String(withheld.length)} changed path(s) withheld by credential policy` +
        ` — excluded from the diff, this list and the history probes:\n` +
        withheld.map((p) => `# ${p}`).join("\n") +
        "\n";

  const bodies: Record<ReviewArtefact, string> = {
    diff: diff.stdout,
    commits: commits.stdout,
    changedFiles: changedList + disclosure,
    history: historyParts.join("\n"),
  };

  const paths: Partial<Record<ReviewArtefact, string>> = {};
  const digest = {} as Record<ReviewArtefact, string>;
  const truncated: Partial<Record<ReviewArtefact, boolean>> = {};

  for (const name of Object.keys(bodies) as ReviewArtefact[]) {
    const body = bodies[name];
    const written = writeArtefact(outDir, name, body);
    if (written !== undefined) paths[name] = written;
    const capped = cap(body);
    digest[name] = capped.text;
    if (capped.truncated) truncated[name] = true;
  }

  return { available: true, paths, digest, truncated, baseline: rev, withheld };
}

/** The heading each artefact is rendered under, in the order a reviewer reads them. */
const ARTEFACT_LABELS: Record<ReviewArtefact, string> = {
  diff: "diff",
  commits: "commits",
  changedFiles: "changed files",
  history: "history probes",
};

/**
 * The capture as the plain text a prompt renders it into.
 *
 * The step's ctx value must be a STRING. `ctxVars` (bindings/mastra/buildSteps.ts)
 * JSON-stringifies any non-string ctx value, so returning the structured object
 * put the diff into a prompt as one line with every newline written `\n` and
 * every quote backslash-escaped — the least readable form available, on a
 * pipeline whose stated problem is cost. Spec 044 D4/FR-003 ask for "one ctx
 * string keyed to the step id"; this is that string.
 *
 * Each section names its artefact, whether the text was capped, and the absolute
 * path of the full artefact, which every review step can open with `contents: read`.
 */
export function renderReviewMaterial(material: ReviewMaterial): string {
  if (!material.available) {
    return (
      `## review material unavailable\n${material.reason}\n\n` +
      "No diff, commit list, changed-file list or history probe was captured. " +
      "Derive the scope of the change from the change text instead, and say in your output that you did."
    );
  }

  const sections: string[] = [`## baseline\n${material.baseline}`];

  for (const name of Object.keys(ARTEFACT_LABELS) as ReviewArtefact[]) {
    const path = material.paths[name];
    const notes: string[] = [];
    if (material.truncated[name] === true) notes.push("truncated");
    notes.push(path === undefined ? "not written to disk" : `full: ${path}`);
    const body = material.digest[name].replace(/\s+$/u, "");
    sections.push(
      `## ${ARTEFACT_LABELS[name]} (${notes.join(" — ")})\n${body === "" ? "(empty)" : body}`
    );
  }

  // Disclosed as its own section as well as inside the changed-file artefact: a
  // reviewer who reads only the headings still sees that the diff is incomplete.
  if (material.withheld.length > 0) {
    sections.push(
      `## withheld by credential policy (${String(material.withheld.length)} path(s))\n` +
        "Excluded from every section above — the diff you were given is not complete:\n" +
        material.withheld.join("\n")
    );
  }

  return sections.join("\n\n");
}
