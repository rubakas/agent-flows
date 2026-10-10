#!/usr/bin/env node
// Capture CLI for the review skill: the repository material a review is judged on,
// gathered without a shell and without a daemon.
//
// The capture itself is src/runtime/reviewCapture.ts, shared with af's daemon and
// shipped here transpiled as ./lib/reviewCapture.mjs (scripts/build-af-review-capture.mjs).
// Every git argv, the credential policy and the spec-source fetching live there. This
// file is the plugin's side of it: the arguments, the input files, the run directory
// under .af-review/, the working-tree snapshot and the exit codes.
//
//   node capture.mjs [--base <rev>] [--spec <github-ref>]... [--spec-file <path>]...
//                    [--plan-file <path>]
//   node capture.mjs check-tree <runDir>
//
// --spec takes a GitHub ref only (URL, owner/repo#N, #N). Literal spec text goes in
// a file passed with --spec-file, so free text never travels on a command line.

import { createHash, randomBytes } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import {
  CAPTURE_DENY_PATTERNS,
  GitTimeoutError,
  NO_DRIVERS,
  REVIEW_MATERIAL_CAP,
  cap,
  captureGit,
  digestBodies,
  fetchSpecRef,
  ghRunnerFor,
  git,
  isGithubRefList,
  isSafeGithubSegment,
  nulFields,
  parseSpecRef,
  rejectBaseline,
  renderMaterial,
  renderSpecSection,
  resolveCommit,
  resolveSpecRefs,
} from "./lib/reviewCapture.mjs";

// What tests, and nothing else, reach into this script for.
export {
  CAPTURE_DENY_PATTERNS,
  REVIEW_MATERIAL_CAP,
  fetchSpecRef,
  isSafeGithubSegment,
  parseSpecRef,
  rejectBaseline,
};

/** The directory (under the repo root) every capture is written into. */
export const CAPTURE_DIR = ".af-review";

/** Attempts at drawing an unused run id before the capture gives up. */
const MAX_RUN_DIR_ATTEMPTS = 5;

// ── Git ──────────────────────────────────────────────────────────────────────

// The plugin runs in the user's own checkout under their own account, where nothing
// of the system's git configuration is needed and messages must not depend on the
// locale. (The daemon adds none of these: dropping the system config there can make a
// capture fail as "dubious ownership".)
const PLUGIN_GIT_ENV = { GIT_CONFIG_NOSYSTEM: "1", GIT_PAGER: "cat", LANGUAGE: "C" };

/** git with the plugin's environment. May throw GitTimeoutError, which `main` turns into exit 2. */
const gitHere = (dir, args) => git(dir, args, PLUGIN_GIT_ENV);

/**
 * Resolves one `--spec` value: a whitespace- or comma-separated list of GitHub
 * references. The CLI refuses anything else before this runs; a token that is not a
 * reference is still refused by name and never reaches gh. Literal spec text is not
 * handled here (see literalSpecSource). `budget.used` is shared across values so the
 * fetch cap holds for the whole capture.
 */
export const resolveSpecSource = (projectDir, value, gh, budget = { used: 0 }) =>
  resolveSpecRefs(projectDir, value, gh, budget, PLUGIN_GIT_ENV);

/**
 * A spec source whose text is taken as it is: what `--spec-file` reads. It is
 * never parsed for references, so a `#12` inside it cannot trigger a fetch.
 */
export function literalSpecSource(content, origin) {
  return {
    literal: true,
    text: cap(content).text,
    full: content,
    notes: [`literal text read from ${origin}`],
  };
}

// ── Capture ──────────────────────────────────────────────────────────────────

/**
 * Captures the diff, commits, changed files and history probes for `baseline..HEAD`.
 * Returns `{available:false, reason}` or `{available:true, ...}`; never throws.
 *
 * What the CLI adds to the shared capture: HEAD must resolve, a whitespace-only
 * baseline is refused as empty (the daemon reads it as omitted and derives one), and an
 * empty diff is refused, because there is nothing to review.
 */
export function captureGitMaterial(projectDir, baseline) {
  try {
    return captureOrRefuse(projectDir, baseline);
  } catch (err) {
    if (!(err instanceof GitTimeoutError)) throw err;
    return { available: false, reason: err.message };
  }
}

function captureOrRefuse(projectDir, baseline) {
  const head = resolveCommit(projectDir, "HEAD", PLUGIN_GIT_ENV);
  if (head === undefined) {
    return { available: false, reason: "HEAD does not resolve to a commit — nothing to review" };
  }
  if (typeof baseline === "string" && baseline !== "" && baseline.trim() === "") {
    return { available: false, reason: rejectBaseline(baseline) };
  }

  const capture = captureGit({
    projectDir,
    baseline: baseline === "" ? undefined : baseline,
    env: PLUGIN_GIT_ENV,
  });
  if (!capture.available) return { available: false, reason: capture.reason };

  if (capture.bodies.diff === "") {
    const short = capture.baselineOid.slice(0, 7);
    return {
      available: false,
      reason:
        capture.withheld.length === 0
          ? `the diff ${short}...HEAD is empty — nothing to review`
          : `the diff ${short}...HEAD is empty once ${String(capture.withheld.length)} credential-shaped path(s) are withheld — nothing to review`,
    };
  }
  return {
    available: true,
    head,
    baseline: capture.baseline,
    baselineRule: capture.baselineRule,
    withheld: capture.withheld,
    bodies: capture.bodies,
  };
}

// ── Rendering ────────────────────────────────────────────────────────────────

/** The file of each artefact, in the order a reviewer reads them. */
const ARTEFACTS = [
  { key: "diff", file: "diff.patch" },
  { key: "commits", file: "commits.txt" },
  { key: "changedFiles", file: "changed-files.txt" },
  { key: "history", file: "history.txt" },
];

/** One `## spec sources` section per spec source; none for literal text that was empty. */
function specSourcesSections(specs) {
  const sections = [];
  for (const { resolution, path } of specs) {
    const where = path === undefined ? "" : ` — full: ${path}`;
    const label = resolution.literal ? `literal text${where}` : `fetched with gh${where}`;
    const section = renderSpecSection(resolution, label);
    if (section !== undefined) sections.push(section);
  }
  return sections;
}

/**
 * The capture as the text a reviewer reads: baseline, spec sources, diff, commits,
 * changed files, history probes, withheld paths — each capped, each naming the
 * absolute path of its full artefact.
 *
 * @param material result of captureGitMaterial (available)
 * @param paths absolute path of each artefact file, keyed by artefact key
 * @param specs `{resolution, path}` per spec source
 */
export function renderReviewMaterial(material, paths, specs = []) {
  const { digest, truncated } = digestBodies(material.bodies);
  return renderMaterial(
    {
      baseline: material.baseline,
      baselineRule: material.baselineRule,
      withheld: material.withheld,
      digest,
      truncated,
      paths,
    },
    specSourcesSections(specs)
  );
}

// ── Working-tree snapshot ────────────────────────────────────────────────────

const sha256 = (data) => createHash("sha256").update(data).digest("hex");

/** Files above this are fingerprinted by size and mtime instead of being read into memory. */
const MAX_HASH_BYTES = 64 * 1024 * 1024;

/** Content hash of one working-tree path, or a marker when it is not a regular file. */
function hashPath(root, path) {
  const full = join(root, path);
  try {
    const stat = lstatSync(full);
    if (stat.isSymbolicLink()) return sha256(`symlink:${readlinkSync(full)}`);
    if (stat.isDirectory()) return "directory";
    // Opening a FIFO for reading blocks until a writer appears.
    if (!stat.isFile()) return "special";
    if (stat.size > MAX_HASH_BYTES) {
      return `size:${String(stat.size)}:mtime:${String(Math.trunc(stat.mtimeMs))}`;
    }
    return sha256(readFileSync(full));
  } catch (err) {
    return err?.code === "ENOENT" || err?.code === "ENOTDIR" ? "deleted" : "unreadable";
  }
}

/**
 * Map of path -> sha256 for every path that differs from HEAD or is untracked,
 * excluding the capture directory itself. `--no-renames` so both halves of a
 * rename are listed. Returns undefined when git cannot answer.
 */
export function snapshotTree(root) {
  const tracked = gitHere(root, [
    "diff",
    ...NO_DRIVERS,
    "HEAD",
    "--name-only",
    "--no-renames",
    "-z",
    "--",
  ]);
  const untracked = gitHere(root, ["ls-files", "--others", "--exclude-standard", "-z"]);
  if (!tracked.ok || !untracked.ok) return undefined;

  // No prototype: a file literally named `__proto__` must be a key like any other.
  const snapshot = Object.create(null);
  const paths = new Set([...nulFields(tracked.stdout), ...nulFields(untracked.stdout)]);
  for (const path of [...paths].sort()) {
    if (path === CAPTURE_DIR || path.startsWith(`${CAPTURE_DIR}/`)) continue;
    snapshot[path] = hashPath(root, path);
  }
  return snapshot;
}

/** Sorted paths whose hash differs between two snapshots, or that appear/disappear. */
export function diffSnapshots(before, after) {
  const valueOf = (snapshot, path) => (Object.hasOwn(snapshot, path) ? snapshot[path] : undefined);
  const changed = [];
  for (const path of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (valueOf(before, path) !== valueOf(after, path)) changed.push(path);
  }
  return changed.sort();
}

// ── CLI ──────────────────────────────────────────────────────────────────────

/** `yyyymmdd-hhmmss` in UTC. */
function utcStamp(date) {
  return date.toISOString().slice(0, 19).replace(/[-:]/gu, "").replace("T", "-");
}

function parseArgs(argv) {
  const options = { base: undefined, specs: [], planFile: undefined };
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (!["--base", "--spec", "--spec-file", "--plan-file"].includes(flag)) {
      return { error: `unknown argument ${JSON.stringify(flag)}` };
    }
    // The value is taken verbatim even when it starts with "-": rejecting a
    // dash-leading baseline is rejectBaseline's job, and it must see it to do so.
    if (value === undefined) return { error: `${flag} needs a value` };
    if (flag === "--base") options.base = value;
    else if (flag === "--plan-file") options.planFile = value;
    else if (flag === "--spec-file") options.specs.push({ kind: "file", value });
    else {
      // Free text never travels on the command line: the caller is a chat model
      // and a shell would parse whatever a user typed. Literal text goes in a file.
      if (!isGithubRefList(value)) {
        return { error: "--spec takes a GitHub ref; pass literal text with --spec-file" };
      }
      options.specs.push({ kind: "ref", value });
    }
  }
  return { options };
}

/** The repository root, or undefined outside a git work tree. */
function repoRoot(cwd) {
  const top = gitHere(cwd, ["rev-parse", "--show-toplevel"]);
  return top.ok && top.stdout.trim() !== "" ? top.stdout.trim() : undefined;
}

const refuse = (reason) => ({ code: 2, out: { ok: false, reason } });

// ── Input files ──────────────────────────────────────────────────────────────

/** Largest `--spec-file` / `--plan-file` accepted. */
const MAX_INPUT_BYTES = 1024 * 1024;

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/**
 * The deny list's glob shapes as a regular expression over a `/`-separated
 * relative path: a `**` + `/` prefix (any depth, or none), a `/` + `**` suffix
 * (everything below) and `*` inside a name (anything but a slash).
 */
function globToRegExp(pattern) {
  let rest = pattern;
  let prefix = "";
  let suffix = "";
  if (rest.startsWith("**/")) {
    prefix = "(?:.*/)?";
    rest = rest.slice(3);
  }
  if (rest.endsWith("/**")) {
    suffix = "/.*";
    rest = rest.slice(0, -3);
  }
  const body = rest.split("*").map(escapeRegExp).join("[^/]*");
  return new RegExp(`^${prefix}${body}${suffix}$`, "iu");
}

const DENY_REGEXPS = CAPTURE_DENY_PATTERNS.map(globToRegExp);

/** True when the path, or any directory above it, is a credential-shaped name. */
function matchesDenyList(relativePath) {
  const segments = relativePath.split("/");
  for (let end = 1; end <= segments.length; end += 1) {
    const prefix = segments.slice(0, end).join("/");
    if (DENY_REGEXPS.some((regexp) => regexp.test(prefix))) return true;
  }
  return false;
}

/**
 * Reads a file the caller named for the review. What it names is copied into the
 * material a model reads, so it is held to the same rules as the diff: it must
 * live inside the repository or the temp directory (after symlinks are resolved),
 * must not be credential-shaped, and must be a regular file of bounded size —
 * never a FIFO, which would block the read forever.
 */
function readInputFile(cwd, root, file, label) {
  let real;
  try {
    real = realpathSync(resolve(cwd, file));
  } catch (err) {
    return { error: `${label} unreadable: ${err instanceof Error ? err.message : String(err)}` };
  }
  const roots = [realpathSync(root), realpathSync(tmpdir())]
    .filter((dir) => real.startsWith(dir + sep))
    .sort((a, b) => b.length - a.length);
  if (roots.length === 0) {
    return {
      error: `${label} ${JSON.stringify(file)} is outside the repository and the temp directory`,
    };
  }
  const relativePath = relative(roots[0], real).split(sep).join("/");
  if (relativePath.split("/").some((segment) => segment.toLowerCase() === ".git")) {
    return { error: `${label} ${JSON.stringify(file)} is inside a .git directory` };
  }
  if (matchesDenyList(relativePath)) {
    return { error: `${label} ${JSON.stringify(file)} matches the credential deny list` };
  }
  try {
    const stat = statSync(real);
    if (!stat.isFile()) return { error: `${label} ${JSON.stringify(file)} is not a regular file` };
    if (stat.size > MAX_INPUT_BYTES) {
      return { error: `${label} ${JSON.stringify(file)} is larger than 1 MB` };
    }
    return { text: readFileSync(real, "utf8") };
  } catch (err) {
    return { error: `${label} unreadable: ${err instanceof Error ? err.message : String(err)}` };
  }
}

// ── Capture directory ────────────────────────────────────────────────────────

const lstatOrUndefined = (path) => {
  try {
    return lstatSync(path);
  } catch (err) {
    if (err?.code === "ENOENT") return undefined;
    throw err;
  }
};

/**
 * Makes sure `.af-review/` exists as a real directory of ours. A repository is
 * untrusted input: one that commits `.af-review` as a symlink, or tracks
 * `.af-review/.gitignore` as a link to a user file, would make a plain mkdir or
 * write land somewhere else. Returns `{error}` instead of writing through any of it.
 */
function prepareCaptureDir(root) {
  const tracked = gitHere(root, ["ls-files", "--", CAPTURE_DIR]);
  if (!tracked.ok) {
    return { error: `could not check whether ${CAPTURE_DIR} is tracked: ${tracked.reason}` };
  }
  if (tracked.stdout.trim() !== "") {
    return {
      error: `${CAPTURE_DIR} is tracked by git here — refusing to write capture output into it`,
    };
  }

  const dir = join(root, CAPTURE_DIR);
  const stat = lstatOrUndefined(dir);
  if (stat === undefined) mkdirSync(dir, { mode: 0o700 });
  else if (!stat.isDirectory()) {
    return {
      error: `${CAPTURE_DIR} exists and is not a real directory (a symlink?) — refusing to write through it`,
    };
  }

  const ignore = join(dir, ".gitignore");
  const ignoreStat = lstatOrUndefined(ignore);
  if (ignoreStat === undefined) writeFileSync(ignore, "*\n", { flag: "wx" });
  else if (!ignoreStat.isFile()) {
    return {
      error: `${CAPTURE_DIR}/.gitignore is not a regular file — refusing to write through it`,
    };
  }
  // An existing regular file is left alone: `wx` (O_EXCL) is the only write here,
  // and it can never follow a symlink planted between the lstat and the open.
  return { dir };
}

/** Writes a file readable only by the owner, as af does for its artefacts. */
function writePrivate(path, body) {
  writeFileSync(path, body, { encoding: "utf8", mode: 0o600 });
}

/** CLI A. Returns `{code, out}`; never throws. */
export function runCapture(argv, cwd, gh) {
  const parsed = parseArgs(argv);
  if (parsed.error !== undefined) return refuse(parsed.error);
  const { base, specs, planFile } = parsed.options;

  const root = repoRoot(cwd);
  if (root === undefined) return refuse("not inside a git work tree");

  let planBody;
  if (planFile !== undefined) {
    const plan = readInputFile(cwd, root, planFile, "plan file");
    if (plan.error !== undefined) return refuse(plan.error);
    planBody = plan.text;
  }

  const fileTexts = new Map();
  for (const spec of specs) {
    if (spec.kind !== "file") continue;
    const file = readInputFile(cwd, root, spec.value, "spec file");
    if (file.error !== undefined) return refuse(file.error);
    fileTexts.set(spec, file.text);
  }

  const material = captureGitMaterial(root, base);
  if (!material.available) return refuse(material.reason);

  const prepared = prepareCaptureDir(root);
  if (prepared.error !== undefined) return refuse(prepared.error);
  const captureDir = prepared.dir;

  // The leaf is created NON-recursively so two captures can never share a
  // directory: EEXIST means someone else holds this id, and a new suffix is drawn.
  let runId;
  let runDir;
  for (let attempt = 0; runDir === undefined; attempt += 1) {
    if (attempt === MAX_RUN_DIR_ATTEMPTS) return refuse("could not create a unique run directory");
    const candidate = `${utcStamp(new Date())}-${material.head.slice(0, 7)}-${randomBytes(2).toString("hex")}`;
    try {
      mkdirSync(join(captureDir, candidate), { mode: 0o700 });
      runId = candidate;
      runDir = join(captureDir, candidate);
    } catch (err) {
      if (err?.code !== "EEXIST") throw err;
    }
  }
  // Belt and braces after the lstat checks: whatever the layout, nothing may be
  // written outside the repository.
  if (!realpathSync(runDir).startsWith(realpathSync(root) + sep)) {
    rmdirSync(runDir);
    return refuse(`${CAPTURE_DIR} resolves outside the repository — refusing to write there`);
  }
  mkdirSync(join(runDir, "specs"), { mode: 0o700 });

  // Resolved only now that the cheap local checks have passed: `gh` is the one
  // network call this script makes.
  const runner = gh ?? ghRunnerFor(root);
  const budget = { used: 0 };
  const resolvedSpecs = specs.map((spec, index) => {
    const resolution =
      spec.kind === "file"
        ? literalSpecSource(fileTexts.get(spec), spec.value)
        : resolveSpecSource(root, spec.value, runner, budget);
    if (resolution.full.trim() === "") return { resolution, path: undefined };
    const path = join(runDir, "specs", `${String(index + 1)}.md`);
    writePrivate(path, resolution.full);
    return { resolution, path };
  });

  const paths = {};
  const truncated = {};
  const capped = digestBodies(material.bodies);
  for (const { key, file } of ARTEFACTS) {
    paths[key] = join(runDir, file);
    writePrivate(paths[key], material.bodies[key]);
    truncated[key] = capped.truncated[key] === true;
  }
  if (planBody !== undefined) writePrivate(join(runDir, "plan.md"), planBody);
  writePrivate(
    join(runDir, "material.md"),
    renderReviewMaterial(material, paths, resolvedSpecs) + "\n"
  );

  const tree = snapshotTree(root);
  if (tree === undefined) return refuse("could not snapshot the working tree");
  writePrivate(join(runDir, "tree-before.json"), JSON.stringify(tree));

  const meta = {
    runId,
    runDir,
    baseline: material.baseline,
    baselineRule: material.baselineRule,
    head: material.head,
    hasSpecs: resolvedSpecs.some(({ path }) => path !== undefined),
    truncated,
    withheld: material.withheld,
  };
  writePrivate(join(runDir, "meta.json"), JSON.stringify(meta, null, 2) + "\n");
  return { code: 0, out: meta };
}

/** CLI B. Returns `{code, out}`; never throws. */
export function runCheckTree(runDirArg, cwd) {
  if (runDirArg === undefined) return refuse("check-tree needs a run directory");
  const root = repoRoot(cwd);
  if (root === undefined) return refuse("not inside a git work tree");

  let before;
  try {
    // Into a prototype-less object so a recorded `__proto__` key stays a plain key.
    before = Object.assign(
      Object.create(null),
      JSON.parse(readFileSync(join(resolve(cwd, runDirArg), "tree-before.json"), "utf8"))
    );
  } catch (err) {
    return refuse(
      `tree-before.json unreadable: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  const after = snapshotTree(root);
  if (after === undefined) return refuse("could not snapshot the working tree");
  return { code: 0, out: { changed: diffSnapshots(before, after) } };
}

function main(argv) {
  let result;
  try {
    result =
      argv[0] === "check-tree"
        ? runCheckTree(argv[1], process.cwd())
        : runCapture(argv, process.cwd());
  } catch (err) {
    result =
      err instanceof GitTimeoutError
        ? refuse(err.message)
        : refuse(`unexpected error: ${err instanceof Error ? err.message : String(err)}`);
  }
  process.stdout.write(JSON.stringify(result.out) + "\n");
  process.exitCode = result.code;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2));
}
