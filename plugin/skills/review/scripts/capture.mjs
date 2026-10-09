#!/usr/bin/env node
// Git capture for the review skill: the repository material a review is judged on,
// gathered without a shell and without a daemon.
//
// A trimmed port of src/runtime/reviewMaterial.ts. Every git argv below encodes a
// security decision made there and is kept as it was: the baseline is validated
// and peeled to a 40-hex commit oid before any command sees it, credential-shaped
// paths are excluded by pathspec (so their content never enters this process),
// rename detection runs in a separate unexcluded `--name-status` pass, and `--`
// separates revisions from pathspecs. git and gh are only ever spawned with argv
// arrays — no shell, no exec.
//
//   node capture.mjs [--base <rev>] [--spec <github-ref>]... [--spec-file <path>]...
//                    [--plan-file <path>]
//   node capture.mjs check-tree <runDir>
//
// --spec takes a GitHub ref only (URL, owner/repo#N, #N). Literal spec text goes in
// a file passed with --spec-file, so free text never travels on a command line.

import { spawnSync } from "node:child_process";
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

/**
 * Files a review may never be handed. A superset of CREDENTIAL_DENY_PATTERNS in
 * src/canon/denyPatterns.ts, matched case-insensitively; capture.test.ts pins the
 * two together.
 */
export const CREDENTIAL_DENY_PATTERNS = [
  "**/.env",
  "**/.env.ci",
  "**/.env.docker",
  "**/.env.production",
  "**/.env.prod",
  "**/.env.staging",
  "**/.env.stage",
  "**/.env.preview",
  "**/.env.local",
  "**/.env.development",
  "**/.env.dev",
  "**/.env.test",
  "**/.envrc",

  "**/aws.json",
  "**/credentials",
  "**/credentials.production",
  "**/credentials.staging",
  "**/credentials.json",
  "**/credentials.toml",
  "**/credentials.yaml",
  "**/credentials.yml",
  "**/credentials.ini",
  "**/secrets.json",
  "**/secrets.yaml",
  "**/secrets.yml",
  "**/secrets.toml",
  "**/secrets.ini",
  "**/secret.json",
  "**/secret.yaml",
  "**/token.json",
  "**/token.yaml",
  "**/token.yml",
  "**/tokens.json",
  "**/service-account*.json",
  "**/terraform.tfvars",
  "**/terraform.tfvars.json",
  "**/secrets.tfvars",
  "**/*.auto.tfvars",
  "**/*.auto.tfvars.json",
  "**/*.tfstate",
  "**/*.tfstate.backup",

  "**/.npmrc",
  "**/.netrc",
  "**/_netrc",
  "**/.pgpass",
  "**/.htpasswd",
  "**/htpasswd",

  "**/.aws/**",
  "**/.azure/**",
  "**/.config/gcloud/**",
  "**/application_default_credentials.json",
  "**/.kube/config",
  "**/kubeconfig",

  "**/*.key",
  "**/*.pem",
  "**/*.der",
  "**/*.crt",
  "**/*.cer",
  "**/*.p8",
  "**/*.p12",
  "**/*.pfx",
  "**/*.jks",
  "**/*.keystore",
  "**/*.truststore",
  "**/*.ppk",
  "**/*.gpg",
  "**/*.asc",
  "**/*.pgp",

  "**/.ssh/**",
  "**/.gnupg/**",

  "**/id_rsa*",
  "**/id_ed25519*",
  "**/id_ecdsa*",
  "**/id_dsa*",

  // Beyond af's list. The wildcards trade a little readability for coverage:
  // `.env.*` also withholds `.env.example`, which af deliberately leaves readable,
  // because a pathspec exclusion cannot carve an exception out of a wildcard.
  "**/.env.*",
  "**/*.env",
  "**/.git-credentials",
  "**/.pypirc",
  "**/.docker/config.json",
  "**/.dockercfg",
];

// Case variants (`.ENV`, `ID_RSA`, `.SSH/x`) need no entries of their own: every
// pathspec built from the list carries `icase`, and APFS is case-insensitive anyway.

/** Max characters of any one artefact carried in material.md (af's REVIEW_MATERIAL_CAP). */
export const REVIEW_MATERIAL_CAP = 65_536;

/** Max commits probed with `git show --stat`; each probe is a process. */
const MAX_COMMIT_PROBES = 50;

/** Max changed paths passed as pathspecs to the history probe. */
const MAX_HISTORY_PATHS = 200;

/** spawnSync buffer: a real diff is far larger than the 1 MB default. */
const GIT_MAX_BUFFER = 32 * 1024 * 1024;

/** Max `gh` invocations per capture, across all --spec values and the issues they link to. */
const MAX_SPEC_SOURCE_FETCHES = 10;

/** Deadline for one `gh` call; spawnSync blocks, so this is the only bound on a hung network. */
const GH_TIMEOUT_MS = 20_000;

/** The directory (under the repo root) every capture is written into. */
export const CAPTURE_DIR = ".af-review";

/** Attempts at drawing an unused run id before the capture gives up. */
const MAX_RUN_DIR_ATTEMPTS = 5;

/**
 * A conservative revision name. Together with the leading-dash rejection this is
 * what keeps `--upload-pack=...` out of git's own option parser: an argv array
 * keeps a value out of a shell, not out of the tool's flag handling.
 */
const RE_REVISION = /^[A-Za-z0-9._\-/~^]+$/u;

/** Longest accepted baseline. */
const MAX_BASELINE_LENGTH = 256;

/** A fully resolved object name, as `rev-parse` prints it. */
const RE_OID = /^[0-9a-f]{40}$/u;

/** One path segment of a GitHub reference: an owner or a repository name. */
const RE_GITHUB_SEGMENT = /^[A-Za-z0-9._-]+$/u;

/** An issue or pull-request number. Ten digits is far past any real one. */
const RE_ISSUE_NUMBER = /^[0-9]{1,10}$/u;

/** A https URL, split far enough to REPORT why it was refused. */
const RE_URL_REF = /^https:\/\/([^/\s]+)\/([^/\s]+)\/([^/\s]+)\/(pull|issues)\/([^/?#\s]+)\/?$/u;

/** Anything shaped like a URL, whatever host or scheme it names. */
const RE_URL_LIKE = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//u;

/** `owner/repo#123` or a bare `#123`. */
const RE_SHORT_REF = /^([^\s#]*)#([^\s#]*)$/u;

/** `#123` inside a pull-request body: the issues the change says it closes. */
const RE_LINKED_ISSUE = /(?:^|[^\w/#-])#([0-9]{1,10})(?![\w-])/gu;

/** The origin remote of the repository, for a bare `#123`. */
const RE_ORIGIN_NWO =
  /^(?:https?:\/\/|ssh:\/\/)?(?:[^@\s]+@)?github\.com[/:]([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/u;

/** The only host this script will fetch from. */
const GITHUB_HOST = "github.com";

// ── Pathspecs ────────────────────────────────────────────────────────────────

// `top` anchors at the repository root, `glob` gives `**` its gitignore meaning,
// and the leading `:/` is the positive "whole tree" (else the query is scoped to
// the working directory). Excluding by pathspec means a secret's content is never
// read here at all, which a post-filter on captured text cannot promise.
// `icase` so `.ENV` and `Credentials.json` are matched as the names they are.
const CREDENTIAL_EXCLUDE_PATHSPECS = CREDENTIAL_DENY_PATTERNS.map(
  (pattern) => `:(top,exclude,glob,icase)${pattern}`
);
const SAFE_PATHSPECS = [":/", ...CREDENTIAL_EXCLUDE_PATHSPECS];

/** The same list inverted: matches ONLY the credential-shaped paths. */
const CREDENTIAL_PATHSPECS = CREDENTIAL_DENY_PATTERNS.map(
  (pattern) => `:(top,glob,icase)${pattern}`
);

// `literal` turns off pathspec magic, so a tracked file actually named
// `:(exclude)**` is matched as a name instead of re-read as a pattern.
const asLiteralPathspec = (path) => `:(top,literal)${path}`;
const asLiteralExclusion = (path) => `:(top,exclude,literal)${path}`;

/** Splits git's `-z` output into its NUL-separated fields. */
const nulFields = (stdout) => stdout.split("\0").filter((field) => field.length > 0);

// A file name or commit subject is attacker-chosen text that lands in a document a
// model reads as structure: an embedded newline plus `## ...` would forge a heading.
// Every control character except TAB is written out as \uXXXX (newline included).
// eslint-disable-next-line no-control-regex
const RE_CONTROL = /[\x00-\x08\x0a-\x1f\x7f]/gu;
const escapeControl = (text) =>
  text.replace(RE_CONTROL, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
/** `escapeControl` for a multi-line body: the line breaks themselves stay. */
const escapeLines = (text) => text.split("\n").map(escapeControl).join("\n");

// ── Process helpers ──────────────────────────────────────────────────────────

/** Runs `bin` with an argv array. Never throws, never uses a shell. */
function run(bin, cwd, args, timeout, env) {
  try {
    const result = spawnSync(bin, [...args], {
      cwd,
      encoding: "utf8",
      maxBuffer: GIT_MAX_BUFFER,
      ...(timeout === undefined ? {} : { timeout }),
      ...(env === undefined ? {} : { env }),
    });
    const stderr = result.stderr ?? "";
    if (result.error !== null && result.error !== undefined) {
      return {
        ok: false,
        stdout: "",
        stderr,
        reason: result.error.message,
        timedOut: result.error.code === "ETIMEDOUT",
      };
    }
    if (result.status !== 0) {
      const firstLine = stderr.trim().split("\n")[0] ?? "";
      return {
        ok: false,
        stdout: "",
        stderr,
        reason: firstLine === "" ? `${bin} exited ${String(result.status)}` : firstLine,
        timedOut: false,
      };
    }
    return { ok: true, stdout: result.stdout ?? "", stderr, reason: "", timedOut: false };
  } catch (err) {
    return {
      ok: false,
      stdout: "",
      stderr: "",
      reason: err instanceof Error ? err.message : String(err),
      timedOut: false,
    };
  }
}

/** A git call that did not answer in time; the CLI turns it into exit 2. */
class GitTimeoutError extends Error {}

/** Deadline for one git call. The env override exists so a test can exercise the timeout. */
function gitTimeoutMs() {
  const override = Number(process.env.AF_REVIEW_GIT_TIMEOUT_MS);
  return Number.isInteger(override) && override > 0 ? override : 120_000;
}

/**
 * Environment for every git spawn: no optional locks (a read-only capture must not
 * contend with the user's own git), no system config, no pager, no prompts.
 * Built per call so a caller that pins HOME or GIT_* after import is honoured.
 */
function gitEnv() {
  return {
    ...process.env,
    GIT_OPTIONAL_LOCKS: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_PAGER: "cat",
    GIT_TERMINAL_PROMPT: "0",
    // A partial clone would otherwise fetch a missing object over the network,
    // and that runs the repository's own `core.sshCommand`.
    GIT_NO_LAZY_FETCH: "1",
    // Messages are matched on, so they must not depend on the user's locale.
    LC_ALL: "C",
    LANGUAGE: "C",
  };
}

/**
 * `-c` overrides beat the repository's own config: a repo-local `core.fsmonitor`
 * is a command git would run on every index refresh, and `log.showSignature`
 * hands any commit carrying a signature header to the repo's `gpg.program`.
 */
const GIT_CONFIG_OVERRIDES = [
  "-c",
  "core.fsmonitor=false",
  "-c",
  "color.ui=false",
  "-c",
  "log.showSignature=false",
];

function git(projectDir, args) {
  const outcome = run(
    "git",
    projectDir,
    [...GIT_CONFIG_OVERRIDES, ...args],
    gitTimeoutMs(),
    gitEnv()
  );
  if (outcome.timedOut) {
    throw new GitTimeoutError(
      `git ${String(args[0])} timed out after ${String(gitTimeoutMs())} ms`
    );
  }
  return outcome;
}

/**
 * Passed to every diff/show/log: a local `diff.external` or textconv setting could
 * otherwise run a command, or change what the reviewer is shown, and colour codes
 * would corrupt the artefacts. Hardening beyond af.
 */
const NO_DRIVERS = ["--no-ext-diff", "--no-textconv", "--no-color"];

/** The default `gh` runner; a seam so a test can substitute one. */
const ghRunnerFor = (projectDir) => (args) => run("gh", projectDir, args, GH_TIMEOUT_MS);

// ── Baseline ─────────────────────────────────────────────────────────────────

/** Why a baseline was refused, or undefined when it is acceptable to pass to git. */
export function rejectBaseline(baseline) {
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

/** What each baseline rule says to the reader of the rendered material. */
export const BASELINE_RULE_REASONS = {
  caller: "supplied by the caller",
  "merge-base":
    "derived: no baseline was supplied, so the merge-base of HEAD and this repository's default branch (origin/HEAD) was used",
  "previous-commit":
    "derived: no baseline was supplied and no default branch gave a merge-base other than HEAD itself, so HEAD~1 was used — this reviews the last commit only",
};

/**
 * Peels `rev` to a commit and returns the RESOLVED 40-hex object name, or
 * undefined. The resolved name — never the caller's string — is what every later
 * command gets: validating `${rev}^{commit}` and then passing `rev` on bare lets a
 * short sha that is ambiguous with a blob resolve to the blob in `git show`.
 */
export function resolveCommit(projectDir, rev) {
  const parsed = git(projectDir, ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`]);
  if (!parsed.ok) return undefined;
  const oid = parsed.stdout.trim();
  return RE_OID.test(oid) ? oid : undefined;
}

/** The default branch as a remote-tracking ref, held to the same shape a baseline is. */
function defaultBranchRef(projectDir) {
  const ref = git(projectDir, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]);
  if (!ref.ok) return undefined;
  const name = ref.stdout.trim();
  if (name === "" || name.startsWith("-") || !RE_REVISION.test(name)) return undefined;
  return name;
}

/**
 * The baseline for a caller who named none: the merge-base with the origin
 * default branch, else the last commit. Returns the reason string when neither
 * rule produces a commit.
 */
export function deriveBaseline(projectDir) {
  const head = resolveCommit(projectDir, "HEAD");
  const branch = defaultBranchRef(projectDir);
  if (branch !== undefined) {
    const mergeBase = git(projectDir, ["merge-base", "HEAD", branch]);
    const oid = mergeBase.ok ? mergeBase.stdout.trim() : "";
    if (RE_OID.test(oid) && oid !== head) return { rev: oid, rule: "merge-base" };
  }
  const previous = resolveCommit(projectDir, "HEAD~1");
  if (previous !== undefined) return { rev: previous, rule: "previous-commit" };
  return (
    "no baseline was supplied and none could be derived: this repository has no " +
    "origin/HEAD default branch to take a merge-base against, and HEAD has no parent commit"
  );
}

/** Caps `text` and reports whether it was capped. */
export function cap(text) {
  if (text.length <= REVIEW_MATERIAL_CAP) return { text, truncated: false };
  return { text: text.slice(0, REVIEW_MATERIAL_CAP) + "\n[TRUNCATED]", truncated: true };
}

// ── Credential rename pairs ──────────────────────────────────────────────────

/**
 * The paths a rename pairs with a credential-shaped path, which must be withheld
 * too. Git filters by pathspec BEFORE rename detection, so excluding a denied
 * path removes one half of the pair and the surviving half is emitted as a pure
 * add/delete carrying the denied file's whole content under an innocent name.
 * This pass therefore runs with NO exclusions — safe because `--name-status`
 * prints names, never a hunk. `-p` must never be added here.
 *
 * A plain copy is deliberately not covered: the copy is an ordinary readable file.
 */
export function renameCounterparts(projectDir, oid, denied) {
  const pairs = git(projectDir, [
    "diff",
    ...NO_DRIVERS,
    "--name-status",
    "-M",
    "-z",
    `${oid}...HEAD`,
    "--",
    ":/",
  ]);
  // Past diff.renameLimit git prints a warning and SKIPS inexact rename detection,
  // so a denied file renamed with one line changed arrives as a plain add. A pass
  // that failed or was skipped cannot vouch for the pairs it did not find.
  // ANY stderr counts, not just git's English wording: the caller only runs this
  // pass when a denied path changed, and a warning in another language (or one
  // worded differently by a newer git) must not read as "all clear".
  if (!pairs.ok || pairs.stderr.trim() !== "") return { paths: [], incomplete: true };

  const counterparts = [];
  const fields = nulFields(pairs.stdout);
  for (let i = 0; i < fields.length;) {
    const status = fields[i] ?? "";
    // A rename record is three fields (status, source, destination); every other
    // record is two. Both shapes must be walked or the parse falls out of step.
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
  return { paths: [...new Set(counterparts)], incomplete: false };
}

// ── Spec sources ─────────────────────────────────────────────────────────────

/** Rejects a segment that is not a plausible GitHub owner or repository name. */
export function isSafeGithubSegment(segment) {
  if (!RE_GITHUB_SEGMENT.test(segment)) return false;
  if (segment.startsWith("-")) return false;
  return segment !== "." && segment !== "..";
}

/** True for a token that is TRYING to name a reference, valid or not. */
const looksLikeRef = (token) => RE_URL_LIKE.test(token) || RE_SHORT_REF.test(token);

/** True when EVERY whitespace- or comma-separated token in `value` is trying to be a reference. */
export function isGithubRefList(value) {
  const tokens = value.split(/[\s,]+/u).filter((token) => token.length > 0);
  return tokens.length > 0 && tokens.every(looksLikeRef);
}

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

/**
 * Turns one ref-shaped token into a validated reference, or into the reason it
 * was refused. Every refusal is reported: a reference silently dropped is a
 * requirement silently dropped.
 */
export function parseSpecRef(token, fallback) {
  if (RE_URL_LIKE.test(token)) {
    const match = RE_URL_REF.exec(token);
    if (match === null) {
      return `${token}: refused — only an https://${GITHUB_HOST}/<owner>/<repo>/pull|issues/<number> URL is fetched`;
    }
    const [, host, owner, repo, kind, number] = match;
    if (host.toLowerCase() !== GITHUB_HOST) {
      return `${token}: refused — host ${JSON.stringify(host)} is not ${GITHUB_HOST}`;
    }
    if (!isSafeGithubSegment(owner) || !isSafeGithubSegment(repo)) {
      return `${token}: refused — ${JSON.stringify(`${owner}/${repo}`)} is not a valid GitHub owner/repo`;
    }
    if (!RE_ISSUE_NUMBER.test(number)) {
      return `${token}: refused — ${JSON.stringify(number)} is not an issue or pull-request number`;
    }
    return {
      owner,
      repo,
      number,
      kind: kind === "pull" ? "pull" : "issues",
      label: `${owner}/${repo}#${number}`,
    };
  }

  const match = RE_SHORT_REF.exec(token);
  if (match === null) return `${token}: refused — not a GitHub reference`;
  const [, nameWithOwner, number] = match;
  if (!RE_ISSUE_NUMBER.test(number)) {
    return `${token}: refused — ${JSON.stringify(number)} is not an issue or pull-request number`;
  }
  if (nameWithOwner === "") {
    if (fallback === undefined) {
      return `${token}: refused — no github.com origin remote in this repository to resolve a bare "#n" against`;
    }
    return {
      ...fallback,
      number,
      kind: "unknown",
      label: `${fallback.owner}/${fallback.repo}#${number}`,
    };
  }
  const parts = nameWithOwner.split("/");
  if (parts.length !== 2 || !isSafeGithubSegment(parts[0]) || !isSafeGithubSegment(parts[1])) {
    return `${token}: refused — ${JSON.stringify(nameWithOwner)} is not a valid GitHub owner/repo`;
  }
  return {
    owner: parts[0],
    repo: parts[1],
    number,
    kind: "unknown",
    label: `${parts[0]}/${parts[1]}#${number}`,
  };
}

/** The owner/repo a bare `#123` means: this repository's github.com origin. */
export function originNameWithOwner(projectDir) {
  const remote = git(projectDir, ["remote", "get-url", "origin"]);
  if (!remote.ok) return undefined;
  const match = RE_ORIGIN_NWO.exec(remote.stdout.trim());
  if (match === null) return undefined;
  const [, owner, repo] = match;
  return isSafeGithubSegment(owner) && isSafeGithubSegment(repo) ? { owner, repo } : undefined;
}

/**
 * Fetches one validated reference. A short ref does not say whether it names a
 * pull request or an issue, so `pr view` is tried first and `issue view` after.
 */
export function fetchSpecRef(gh, ref) {
  const repoArg = `${ref.owner}/${ref.repo}`;
  const tools = ref.kind === "pull" ? ["pr"] : ref.kind === "issues" ? ["issue"] : ["pr", "issue"];
  let reason = "no attempt was made";
  for (const tool of tools) {
    const outcome = gh([tool, "view", ref.number, "--repo", repoArg, "--json", "title,body,url"]);
    if (!outcome.ok) {
      // A hung network does not get better by asking the same service a second
      // question: record the timeout and stop.
      if (outcome.timedOut) {
        reason = `gh ${tool} view timed out`;
        break;
      }
      reason = outcome.reason;
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(outcome.stdout);
    } catch {
      reason = `gh ${tool} view returned output that is not JSON`;
      continue;
    }
    return {
      title: typeof parsed?.title === "string" ? parsed.title : "",
      body: typeof parsed?.body === "string" ? parsed.body : "",
      url: typeof parsed?.url === "string" ? parsed.url : ref.label,
      isPullRequest: tool === "pr",
    };
  }
  return reason;
}

/** The issues a pull-request body says it closes, in the order it names them. */
export function linkedIssues(body, ref) {
  const found = [];
  for (const match of body.matchAll(RE_LINKED_ISSUE)) {
    found.push({
      owner: ref.owner,
      repo: ref.repo,
      number: match[1],
      kind: "issues",
      label: `${ref.owner}/${ref.repo}#${match[1]}`,
    });
  }
  return found;
}

/**
 * Resolves one `--spec` value: a whitespace- or comma-separated list of GitHub
 * references. The CLI refuses anything else before this runs; a token that is not
 * a reference is still refused here by name and never reaches gh. Literal spec
 * text is not handled here — it arrives through `--spec-file` (literalSpecSource).
 * `budget.used` is shared across values so the fetch cap holds for the capture.
 * Never throws: a `gh` that is missing or failing is recorded as a reason.
 */
export function resolveSpecSource(projectDir, value, gh, budget = { used: 0 }) {
  const tokens = value.split(/[\s,]+/u).filter((token) => token.length > 0);

  // Resolved lazily and at most once: `owner/repo#n` refs never need the remote.
  let fallback;
  let fallbackResolved = false;
  const originFallback = () => {
    if (!fallbackResolved) {
      fallback = originNameWithOwner(projectDir);
      fallbackResolved = true;
    }
    return fallback;
  };

  const notes = [];
  const queue = [];
  for (const token of tokens) {
    const parsed = parseSpecRef(token, originFallback());
    if (typeof parsed === "string") notes.push(parsed);
    else queue.push(parsed);
  }

  const seen = new Set();
  const renderParts = [];
  const fullParts = [];
  let attempted = 0;
  let capReported = false;

  while (queue.length > 0) {
    const ref = queue.shift();
    if (seen.has(ref.label)) continue;
    if (budget.used >= MAX_SPEC_SOURCE_FETCHES) {
      if (!capReported) {
        notes.push(
          `stopped at the cap of ${String(MAX_SPEC_SOURCE_FETCHES)} fetches per review; ` +
            `${ref.label} and anything after it was not fetched`
        );
        capReported = true;
      }
      continue;
    }
    seen.add(ref.label);
    budget.used += 1;
    attempted += 1;

    const fetched = fetchSpecRef(gh, ref);
    if (typeof fetched === "string") {
      notes.push(`${ref.label}: not fetched (${fetched})`);
      continue;
    }
    notes.push(
      `${ref.label}: fetched ${fetched.isPullRequest ? "pull request" : "issue"} ${fetched.url}`
    );
    const heading = `### ${ref.label} — ${fetched.title}\n${fetched.url}\n`;
    fullParts.push(`${heading}\n${fetched.body}`);
    renderParts.push(`${heading}\n${cap(fetched.body).text}`);

    if (fetched.isPullRequest) {
      for (const linked of linkedIssues(fetched.body, ref)) {
        if (!seen.has(linked.label)) queue.push(linked);
      }
    }
  }

  notes.unshift(
    `${String(renderParts.length)} of ${String(attempted)} attempted reference(s) fetched`
  );

  return {
    literal: false,
    text: renderParts.join("\n\n"),
    full: fullParts.join("\n\n"),
    notes,
  };
}

// ── Capture ──────────────────────────────────────────────────────────────────

/**
 * Captures the diff, commits, changed files and history probes for `baseline..HEAD`.
 * Returns `{available:false, reason}` or `{available:true, ...}`; never throws.
 * Credential-shaped paths are excluded from every capturing command by pathspec;
 * their PATHS (never contents) come back in `withheld`.
 */
export function captureGitMaterial(projectDir, baseline) {
  const head = resolveCommit(projectDir, "HEAD");
  if (head === undefined) {
    return { available: false, reason: "HEAD does not resolve to a commit — nothing to review" };
  }

  let rev;
  let baselineRule;
  if (baseline === undefined || baseline === null || baseline === "") {
    const derived = deriveBaseline(projectDir);
    if (typeof derived === "string") return { available: false, reason: derived };
    rev = derived.rev;
    baselineRule = derived.rule;
  } else {
    const rejection = rejectBaseline(baseline);
    if (rejection !== undefined) return { available: false, reason: rejection };
    rev = baseline;
    baselineRule = "caller";
  }

  // The pattern says the value is shaped like a revision; only git can say it
  // names one. Every command below gets the RESOLVED name, never `rev`.
  const oid = resolveCommit(projectDir, rev);
  if (oid === undefined) {
    return {
      available: false,
      reason: `baseline ${JSON.stringify(rev)} does not resolve to a commit in this repository`,
    };
  }

  // The deny list as the POSITIVE pathspec: the changed paths being withheld.
  // Names only. A failed query is not an empty result — refuse rather than state
  // that nothing was withheld on the strength of a query that never ran.
  const excluded = git(projectDir, [
    "diff",
    ...NO_DRIVERS,
    "--name-only",
    "-z",
    `${oid}...HEAD`,
    "--",
    ...CREDENTIAL_PATHSPECS,
  ]);
  if (!excluded.ok) {
    return {
      available: false,
      reason: `the credential deny-list query failed (${excluded.reason}) — refusing to capture material whose withholding cannot be reported`,
    };
  }
  const denied = nulFields(excluded.stdout);
  const pairs =
    denied.length === 0
      ? { paths: [], incomplete: false }
      : renameCounterparts(projectDir, oid, new Set(denied));
  if (pairs.incomplete) {
    return {
      available: false,
      reason:
        `${String(denied.length)} credential-shaped path(s) changed in this range, but git's rename detection ` +
        "was skipped or failed (too many changed files for diff.renameLimit), so a rename of one of them " +
        "cannot be ruled out — refusing to capture. Review a smaller range, or raise diff.renameLimit.",
    };
  }
  const counterparts = pairs.paths;
  const extraExclusions = counterparts.map(asLiteralExclusion);
  const safePathspecs = [...SAFE_PATHSPECS, ...extraExclusions];
  const withheld = [...denied, ...counterparts];

  // `--text` so a `* -diff` or `* binary` in .gitattributes cannot blank the patch
  // the reviewer is shown; the exclusions above are what keep secrets out of it.
  const diff = git(projectDir, [
    "diff",
    ...NO_DRIVERS,
    "--text",
    `${oid}...HEAD`,
    "--",
    ...safePathspecs,
  ]);
  if (!diff.ok) return { available: false, reason: `git diff failed: ${diff.reason}` };
  if (diff.stdout === "") {
    return {
      available: false,
      reason:
        withheld.length === 0
          ? `the diff ${oid.slice(0, 7)}...HEAD is empty — nothing to review`
          : `the diff ${oid.slice(0, 7)}...HEAD is empty once ${String(withheld.length)} credential-shaped path(s) are withheld — nothing to review`,
    };
  }

  const commits = git(projectDir, ["log", ...NO_DRIVERS, "--format=%H %s", `${oid}..HEAD`, "--"]);
  if (!commits.ok) return { available: false, reason: `git log failed: ${commits.reason}` };

  const changed = git(projectDir, [
    "diff",
    ...NO_DRIVERS,
    "--name-only",
    "-z",
    `${oid}...HEAD`,
    "--",
    ...safePathspecs,
  ]);
  if (!changed.ok) {
    return { available: false, reason: `git diff --name-only failed: ${changed.reason}` };
  }

  // `-z` so a path arrives as it is on disk: git C-quotes non-ASCII names
  // otherwise, and the quoted spelling matches nothing when fed back as a pathspec.
  const allChangedPaths = nulFields(changed.stdout);
  const changedPaths = allChangedPaths.slice(0, MAX_HISTORY_PATHS);
  const changedList =
    allChangedPaths.length === 0 ? "" : allChangedPaths.map(escapeControl).join("\n") + "\n";

  const historyParts = [];
  if (changedPaths.length > 0) {
    const fileHistory = git(projectDir, [
      "log",
      ...NO_DRIVERS,
      "--all",
      "--diff-filter=AD",
      "--name-status",
      "--format=%H %s",
      "--",
      ...changedPaths.map(asLiteralPathspec),
      // Repeated so the probe is safe by its own argv, not by its caller's.
      ...CREDENTIAL_EXCLUDE_PATHSPECS,
      ...extraExclusions,
    ]);
    historyParts.push(
      fileHistory.ok
        ? `# add/delete history of the changed files\n${escapeLines(fileHistory.stdout)}`
        : `# add/delete history unavailable: ${fileHistory.reason}`
    );
  }
  const shas = [];
  for (const line of commits.stdout.split("\n")) {
    const sha = line.trim().split(" ")[0] ?? "";
    if (RE_OID.test(sha)) shas.push(sha);
  }
  for (const sha of [...new Set(shas)].slice(0, MAX_COMMIT_PROBES)) {
    const stat = git(projectDir, [
      "show",
      ...NO_DRIVERS,
      "--stat",
      "--format=%H %s",
      sha,
      "--",
      ...safePathspecs,
    ]);
    historyParts.push(
      stat.ok
        ? `# git show --stat ${sha}\n${escapeLines(stat.stdout)}`
        : `# ${sha} unavailable: ${stat.reason}`
    );
  }

  // The withholding travels with the omission it explains, on the artefact a
  // reviewer reads as the scope of the change. Absent when nothing was withheld.
  const disclosure =
    withheld.length === 0
      ? ""
      : `\n# ${String(withheld.length)} changed path(s) withheld by credential policy` +
        ` — excluded from the diff, this list and the history probes:\n` +
        withheld.map((p) => `# ${escapeControl(p)}`).join("\n") +
        "\n";

  return {
    available: true,
    head,
    baseline: rev,
    baselineRule,
    withheld,
    bodies: {
      diff: diff.stdout,
      commits: escapeLines(commits.stdout),
      changedFiles: changedList + disclosure,
      history: historyParts.join("\n"),
    },
  };
}

// ── Rendering ────────────────────────────────────────────────────────────────

/** The heading and file of each artefact, in the order a reviewer reads them. */
const ARTEFACTS = [
  { key: "diff", label: "diff", file: "diff.patch" },
  { key: "commits", label: "commits", file: "commits.txt" },
  { key: "changedFiles", label: "changed files", file: "changed-files.txt" },
  { key: "history", label: "history probes", file: "history.txt" },
];

/** One `## spec sources` section per spec source; none for literal text that was empty. */
function specSourcesSections(specs) {
  const sections = [];
  for (const { resolution, path } of specs) {
    if (resolution.literal && resolution.full.trim() === "") continue;
    const notes = resolution.notes.map((note) => `- ${note}`).join("\n");
    const where = path === undefined ? "" : ` — full: ${path}`;
    const label = resolution.literal ? `literal text${where}` : `fetched with gh${where}`;
    const body = resolution.text.replace(/\s+$/u, "");
    sections.push(
      `## spec sources (${label})\n${notes}\n\n${body === "" ? "(none could be read)" : body}`
    );
  }
  return sections;
}

/**
 * The capture as the text a reviewer reads: baseline, spec sources, diff, commits,
 * changed files, history probes, withheld paths — each capped, each naming the
 * absolute path of its full artefact. Same order as af's renderReviewMaterial.
 *
 * @param material result of captureGitMaterial (available)
 * @param paths absolute path of each artefact file, keyed by artefact key
 * @param specs `{resolution, path}` per spec source
 */
export function renderReviewMaterial(material, paths, specs = []) {
  const sections = [
    `## baseline\n${material.baseline}\n${BASELINE_RULE_REASONS[material.baselineRule]}`,
    ...specSourcesSections(specs),
  ];

  for (const { key, label } of ARTEFACTS) {
    sections.push(renderArtefact(label, material.bodies[key], paths[key]));
  }

  // Its own section as well as a line inside the changed-file artefact: a
  // reviewer who reads only the headings still sees that the diff is incomplete.
  if (material.withheld.length > 0) {
    sections.push(
      `## withheld by credential policy (${String(material.withheld.length)} path(s))\n` +
        "Excluded from every section above — the diff you were given is not complete:\n" +
        material.withheld.map(escapeControl).join("\n")
    );
  }

  return sections.join("\n\n");
}

function renderArtefact(label, body, path) {
  const capped = cap(body);
  const notes = [];
  if (capped.truncated) notes.push("truncated");
  notes.push(path === undefined ? "not written to disk" : `full: ${path}`);
  const text = capped.text.replace(/\s+$/u, "");
  return `## ${label} (${notes.join(" — ")})\n${text === "" ? "(empty)" : text}`;
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
  const tracked = git(root, [
    "diff",
    ...NO_DRIVERS,
    "HEAD",
    "--name-only",
    "--no-renames",
    "-z",
    "--",
  ]);
  const untracked = git(root, ["ls-files", "--others", "--exclude-standard", "-z"]);
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
  const top = git(cwd, ["rev-parse", "--show-toplevel"]);
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

const DENY_REGEXPS = CREDENTIAL_DENY_PATTERNS.map(globToRegExp);

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
  const tracked = git(root, ["ls-files", "--", CAPTURE_DIR]);
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
  for (const { key, file } of ARTEFACTS) {
    paths[key] = join(runDir, file);
    writePrivate(paths[key], material.bodies[key]);
    truncated[key] = cap(material.bodies[key]).truncated;
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
