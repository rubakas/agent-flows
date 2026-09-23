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
//
// The same trade covers `specSources`. A reviewer holding `contents: read` has
// no network either, so a caller who names a pull request or an issue URL is
// naming something the model cannot open: it answered in prose that it had no
// spec sources, and the step's schema then refused the prose. So the daemon
// fetches those too — with `gh`, argv arrays, never a shell and never `curl`.
// That is this module's ONLY outbound network call, and it is reached only by a
// value that passed the anchored patterns below: `github.com` and no other host,
// an owner and repo of `[A-Za-z0-9._-]` that may not begin with `-`, and a
// number of at most ten digits. Anything else is literal text and is passed
// through untouched, which is what `none` and a pasted ticket body rely on.

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

/** The resolved spec sources, written in full beside the git artefacts. */
const SPEC_SOURCES_FILE = "spec-sources.txt";

/**
 * Max `gh` invocations per capture, counted across the references the caller
 * named AND the issues those references link to. The refs arrive through an
 * unauthenticated localhost daemon and each one is a process and a network
 * round trip, so the budget is on the total, not per source.
 */
const MAX_SPEC_SOURCE_FETCHES = 10;

/**
 * Deadline for one `gh` call. spawnSync blocks the daemon's event loop, so a
 * hung network call is a hung daemon — this is the only thing bounding it.
 */
const GH_TIMEOUT_MS = 20_000;

/**
 * One path segment of a GitHub reference: an owner or a repository name.
 * Anchored, and checked against the whole segment — this is what keeps a
 * crafted `specSources` value out of `gh`'s own option parser and off any host
 * but github.com. A leading `-` is refused separately, for the reason
 * `rejectBaseline` refuses it: an argv array keeps a value out of a shell, it
 * does not keep it out of the tool's flag parsing.
 */
const RE_GITHUB_SEGMENT = /^[A-Za-z0-9._-]+$/u;

/** An issue or pull-request number. Ten digits is far past any real one. */
const RE_ISSUE_NUMBER = /^[0-9]{1,10}$/u;

/**
 * A https URL, split far enough to REPORT why it was refused. The host is
 * captured rather than baked in so a non-GitHub host is rejected by name
 * instead of silently falling through to "not a reference".
 */
const RE_URL_REF = /^https:\/\/([^/\s]+)\/([^/\s]+)\/([^/\s]+)\/(pull|issues)\/([^/?#\s]+)\/?$/u;

/** Anything shaped like a URL, whatever host or scheme it names. */
const RE_URL_LIKE = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//u;

/** `owner/repo#123` or a bare `#123`. */
const RE_SHORT_REF = /^([^\s#]*)#([^\s#]*)$/u;

/** `#123` inside a pull-request body: the issues the change says it closes. */
const RE_LINKED_ISSUE = /(?:^|[^\w/#-])#([0-9]{1,10})(?![\w-])/gu;

/** The origin remote of the repository the run is in, for a bare `#123`. */
const RE_ORIGIN_NWO =
  /^(?:https?:\/\/|ssh:\/\/)?(?:[^@\s]+@)?github\.com[/:]([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/u;

/** The only host this module will fetch from. */
const GITHUB_HOST = "github.com";

/** One `gh` invocation, in the same never-throwing shape as `git` above. */
export interface GhOutcome {
  ok: boolean;
  stdout: string;
  reason: string;
}

/**
 * Runs `gh` with an argv array. A seam: the tests substitute one so the gate on
 * WHICH argv is built — and on which values never reach it at all — is asserted
 * without a network call.
 */
export type GhRunner = (args: readonly string[]) => GhOutcome;

/** A validated reference. Nothing reaches `gh` that is not one of these. */
interface SpecRef {
  owner: string;
  repo: string;
  number: string;
  /** `unknown` when a short ref did not say which it is; then `pr` is tried, then `issue`. */
  kind: "pull" | "issues" | "unknown";
  /** How the reference is named back to the reader. */
  label: string;
}

/** What the caller's `specSources` resolved to. */
export interface SpecSourceResolution {
  /**
   * True when the value named no GitHub reference and was passed through
   * unchanged. The overwhelmingly common case — a pasted ticket body, or the
   * word `none` — and the one that must never be broken by this feature.
   */
  literal: boolean;
  /** The text a reviewer reads: fetched bodies, or the literal input. Capped. */
  text: string;
  /** The same text uncapped, as it is written to disk. */
  full: string;
  /** One line per reference: what was fetched, and what was refused or failed. */
  notes: string[];
  /** Absolute path of the uncapped text on disk, when it could be written. */
  path?: string;
}

/** Rejects a segment that is not a plausible GitHub owner or repository name. */
function isSafeGithubSegment(segment: string): boolean {
  if (!RE_GITHUB_SEGMENT.test(segment)) return false;
  if (segment.startsWith("-")) return false;
  return segment !== "." && segment !== "..";
}

/**
 * One `gh` invocation as an argv array. Never throws and never uses a shell,
 * the same defensive shape as `git` above. `gh` — not `curl` — is what fixes
 * the host: a crafted value cannot redirect the request to another server,
 * because the server is not something this argv names.
 */
function ghRunnerFor(projectDir: string): GhRunner {
  return (args) => {
    try {
      const result = spawnSync("gh", [...args], {
        cwd: projectDir,
        encoding: "utf8",
        maxBuffer: GIT_MAX_BUFFER,
        timeout: GH_TIMEOUT_MS,
      });
      if (result.error !== null && result.error !== undefined) {
        return { ok: false, stdout: "", reason: result.error.message };
      }
      if (result.status !== 0) {
        const stderr = (result.stderr ?? "").trim().split("\n")[0] ?? "";
        return {
          ok: false,
          stdout: "",
          reason: stderr === "" ? `gh exited ${String(result.status)}` : stderr,
        };
      }
      return { ok: true, stdout: result.stdout ?? "", reason: "" };
    } catch (err) {
      return { ok: false, stdout: "", reason: err instanceof Error ? err.message : String(err) };
    }
  };
}

/** True for a token that is TRYING to name a reference, valid or not. */
function looksLikeRef(token: string): boolean {
  return RE_URL_LIKE.test(token) || RE_SHORT_REF.test(token);
}

/**
 * Turns one ref-shaped token into a validated `SpecRef`, or into the reason it
 * was refused. Every refusal is returned as a string and reported to the
 * reviewer: a reference silently dropped is a requirement silently dropped.
 */
function parseSpecRef(
  token: string,
  fallback: { owner: string; repo: string } | undefined
): SpecRef | string {
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
function originNameWithOwner(projectDir: string): { owner: string; repo: string } | undefined {
  const remote = git(projectDir, ["remote", "get-url", "origin"]);
  if (!remote.ok) return undefined;
  const match = RE_ORIGIN_NWO.exec(remote.stdout.trim());
  if (match === null) return undefined;
  const [, owner, repo] = match;
  return isSafeGithubSegment(owner) && isSafeGithubSegment(repo) ? { owner, repo } : undefined;
}

interface FetchedRef {
  title: string;
  body: string;
  url: string;
  /** True when it was `gh pr view` that answered — only then are links followed. */
  isPullRequest: boolean;
}

/**
 * Fetches one validated reference. A short ref does not say whether it names a
 * pull request or an issue, so `pr view` is tried first and `issue view` after:
 * on GitHub both live in one number space, and the wrong one simply 404s.
 */
function fetchSpecRef(gh: GhRunner, ref: SpecRef): FetchedRef | string {
  const repoArg = `${ref.owner}/${ref.repo}`;
  const tools = ref.kind === "pull" ? ["pr"] : ref.kind === "issues" ? ["issue"] : ["pr", "issue"];
  let reason = "no attempt was made";
  for (const tool of tools) {
    const outcome = gh([tool, "view", ref.number, "--repo", repoArg, "--json", "title,body,url"]);
    if (!outcome.ok) {
      reason = outcome.reason;
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(outcome.stdout);
    } catch {
      reason = `gh ${tool} view returned output that is not JSON`;
      continue;
    }
    const fields = parsed as { title?: unknown; body?: unknown; url?: unknown };
    return {
      title: typeof fields.title === "string" ? fields.title : "",
      body: typeof fields.body === "string" ? fields.body : "",
      url: typeof fields.url === "string" ? fields.url : ref.label,
      isPullRequest: tool === "pr",
    };
  }
  return reason;
}

/** The issues a pull-request body says it closes, in the order it names them. */
function linkedIssues(body: string, ref: SpecRef): SpecRef[] {
  const found: SpecRef[] = [];
  for (const match of body.matchAll(RE_LINKED_ISSUE)) {
    const number = match[1];
    found.push({
      owner: ref.owner,
      repo: ref.repo,
      number,
      kind: "issues",
      label: `${ref.owner}/${ref.repo}#${number}`,
    });
  }
  return found;
}

/**
 * Resolves the caller's `specSources` into the text the delivery reviewer is
 * judged against.
 *
 * A value is a reference list only when EVERY whitespace- or comma-separated
 * token in it is trying to be a reference. One ordinary word and the whole
 * value is literal text, passed through byte for byte — that is what keeps a
 * pasted ticket body, and the word `none`, working exactly as before.
 *
 * Never throws: `gh` missing, unauthenticated or failing is recorded as a
 * reason and leaves that reference's text empty, because a review that cannot
 * read one ticket is still worth more than no review.
 */
export function resolveSpecSources(
  projectDir: string,
  specSources: unknown,
  gh: GhRunner
): SpecSourceResolution {
  if (typeof specSources !== "string" || specSources.trim() === "") {
    return { literal: true, text: "", full: "", notes: [] };
  }

  const tokens = specSources.split(/[\s,]+/u).filter((token) => token.length > 0);
  if (tokens.length === 0 || !tokens.every(looksLikeRef)) {
    return {
      literal: true,
      text: cap(specSources).text,
      full: specSources,
      notes: ["passed through unchanged: it names no GitHub pull request or issue"],
    };
  }

  // Resolved lazily and at most once: a value made only of `owner/repo#n` refs
  // never needs the origin remote, and a run in a non-git directory must not be
  // charged a process for it.
  let fallback: { owner: string; repo: string } | undefined;
  let fallbackResolved = false;
  const originFallback = (): { owner: string; repo: string } | undefined => {
    if (!fallbackResolved) {
      fallback = originNameWithOwner(projectDir);
      fallbackResolved = true;
    }
    return fallback;
  };

  const notes: string[] = [];
  const queue: SpecRef[] = [];
  for (const token of tokens) {
    const parsed = parseSpecRef(token, originFallback());
    if (typeof parsed === "string") notes.push(parsed);
    else queue.push(parsed);
  }

  const seen = new Set<string>();
  const renderParts: string[] = [];
  const fullParts: string[] = [];
  let fetches = 0;
  let capReported = false;

  while (queue.length > 0) {
    const ref = queue.shift()!;
    if (seen.has(ref.label)) continue;
    if (fetches >= MAX_SPEC_SOURCE_FETCHES) {
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
    fetches += 1;

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
    `${String(renderParts.length)} of ${String(fetches)} attempted reference(s) fetched`
  );

  return {
    literal: false,
    text: renderParts.join("\n\n"),
    full: fullParts.join("\n\n"),
    notes,
  };
}

/**
 * How the capture arrived at the revision it diffed against.
 *
 * A review whose baseline was guessed and a review whose baseline was stated
 * are different reviews, and the reader cannot tell them apart from the oid.
 * So the rule travels with the value, into the rendered material as well as the
 * structured result.
 */
export type BaselineRule = "caller" | "merge-base" | "previous-commit";

/** What each rule says to the reader of the rendered material. */
const BASELINE_RULE_REASONS: Record<BaselineRule, string> = {
  caller: "supplied by the caller",
  "merge-base":
    "derived: no baseline was supplied, so the merge-base of HEAD and this repository's default branch (origin/HEAD) was used",
  "previous-commit":
    "derived: no baseline was supplied and no default branch gave a merge-base other than HEAD itself, so HEAD~1 was used — this reviews the last commit only",
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
  /** Which rule produced it: the caller's own value always wins. */
  baselineRule: BaselineRule;
  /**
   * Changed paths excluded from every artefact by the credential deny list.
   *
   * The PATHS, never the contents — a path is not a secret, and a review handed
   * a diff it believes is complete while files are silently missing reviews a
   * fiction. Empty when nothing was withheld.
   */
  withheld: string[];
  /**
   * The caller's `specSources`, resolved. Present on BOTH branches of the
   * union, and deliberately: a tree where git fails still has ticket bodies
   * worth reading, and the delivery reviewer reads them from here.
   */
  specSources?: SpecSourceResolution;
  /**
   * True when everything the caller named as a spec source is in the material:
   * a pasted body, or every reference fetched. False when one was refused,
   * failed to fetch, or when the caller named none at all.
   *
   * Flat rather than only inside `specSources` because it is what a caller
   * reading the structured result asks — "did the delivery axis get what it
   * needed" — and a field it has to reconstruct from notes is a field it will
   * reconstruct wrongly.
   */
  specSourcesResolved: boolean;
  /** Why `specSourcesResolved` is false; empty when it is true. */
  specSourcesReason: string;
}

export interface ReviewMaterialUnavailable {
  available: false;
  reason: string;
  specSources?: SpecSourceResolution;
  specSourcesResolved: boolean;
  specSourcesReason: string;
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

/**
 * True when the caller named no baseline at all — the case the derivation below
 * exists for. A non-string that is not `undefined` or `null` is NOT this case:
 * it is a caller sending something wrong, and it goes to `rejectBaseline` to be
 * refused by name rather than being quietly replaced with a guess.
 */
function baselineOmitted(baseline: unknown): boolean {
  if (baseline === undefined || baseline === null) return true;
  return typeof baseline === "string" && baseline.trim() === "";
}

/**
 * The repository's default branch as a remote-tracking ref, e.g.
 * `refs/remotes/origin/main`. Held to the same revision shape a caller-supplied
 * baseline is: git prints this, but it is fed straight back to git as an
 * argument, and a ref name is not obliged to be harmless.
 */
function defaultBranchRef(projectDir: string): string | undefined {
  const ref = git(projectDir, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]);
  if (!ref.ok) return undefined;
  const name = ref.stdout.trim();
  if (name === "" || name.startsWith("-") || !RE_REVISION.test(name)) return undefined;
  return name;
}

/**
 * The baseline for a caller who named none: what this change added on top of
 * the default branch, or failing that the last commit.
 *
 * `origin/HEAD` -> `merge-base` first, because that is the question a review
 * actually asks — "what does this branch add?" — and it is stable while the
 * branch grows. HEAD~1 is the fallback and is deliberately narrower: on a repo
 * with no origin, or on the default branch itself (where the merge-base IS
 * HEAD and the diff would be empty), reviewing the last commit is the only
 * honest thing left. Which one ran is reported, never assumed.
 *
 * Returns the reason instead when neither rule produces a commit.
 */
function deriveBaseline(projectDir: string): { rev: string; rule: BaselineRule } | string {
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

/**
 * Whether the delivery axis got what the caller pointed it at, and why not.
 * Derived from the resolution rather than stored twice: one computation, so the
 * flat field and the rendered notes cannot disagree.
 */
function specSourceStatus(spec: SpecSourceResolution): { resolved: boolean; reason: string } {
  if (spec.full === "") {
    return {
      resolved: false,
      reason: spec.literal
        ? "no spec sources were supplied"
        : `nothing the caller named could be read: ${spec.notes.join("; ")}`,
    };
  }
  if (spec.literal) return { resolved: true, reason: "" };
  const failed = spec.notes.filter(
    (note) =>
      note.includes(": not fetched") ||
      note.includes(": refused") ||
      note.startsWith("stopped at the cap")
  );
  if (failed.length === 0) return { resolved: true, reason: "" };
  return {
    resolved: false,
    reason: `part of what the caller named was not read: ${failed.join("; ")}`,
  };
}

/** Caps `text` and reports whether it was capped. */
function cap(text: string): { text: string; truncated: boolean } {
  if (text.length <= REVIEW_MATERIAL_CAP) return { text, truncated: false };
  return { text: text.slice(0, REVIEW_MATERIAL_CAP) + "\n[TRUNCATED]", truncated: true };
}

/** Writes one artefact in full. Returns its absolute path, or undefined on failure. */
function writeArtefact(outDir: string, file: string, body: string): string | undefined {
  const path = join(outDir, file);
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
 * @param options Untrusted `specSources`, and the `gh` seam the tests substitute.
 */
export function buildReviewMaterial(
  projectDir: string,
  baseline: unknown,
  introducedCommits: readonly string[] | undefined,
  outDir: string,
  options: { specSources?: unknown; gh?: GhRunner } = {}
): ReviewMaterial {
  // Resolved before the baseline is judged, and attached to every return below:
  // a capture that cannot run is exactly when the delivery reviewer most needs
  // the ticket bodies, because nothing else tells it what the change was for.
  const specSources = resolveSpecSources(
    projectDir,
    options.specSources,
    options.gh ?? ghRunnerFor(projectDir)
  );
  if (specSources.full !== "") {
    const written = writeArtefact(outDir, SPEC_SOURCES_FILE, specSources.full);
    if (written !== undefined) specSources.path = written;
  }
  const status = specSourceStatus(specSources);
  const specFields = {
    specSources,
    specSourcesResolved: status.resolved,
    specSourcesReason: status.reason,
  };

  // A caller who named a baseline gets that baseline, validated exactly as
  // before; a caller who named none gets one derived here rather than a refusal.
  // "Nothing is mandatory" is the point of this entry path, and a review that
  // will not start because an optional input is missing is the opposite of it.
  let rev: string;
  let baselineRule: BaselineRule;
  if (baselineOmitted(baseline)) {
    const derived = deriveBaseline(projectDir);
    if (typeof derived === "string") return { available: false, reason: derived, ...specFields };
    rev = derived.rev;
    baselineRule = derived.rule;
  } else {
    const rejection = rejectBaseline(baseline);
    if (rejection !== undefined) return { available: false, reason: rejection, ...specFields };
    rev = baseline as string;
    baselineRule = "caller";
  }

  // The pattern says the value is shaped like a revision; only git can say it
  // names one. Both checks run before any capturing command is issued. Every
  // command below is given the RESOLVED name, never `rev` itself.
  const oid = resolveCommit(projectDir, rev);
  if (oid === undefined) {
    return {
      available: false,
      reason: `baseline ${JSON.stringify(rev)} does not resolve to a commit in this repository`,
      ...specFields,
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
      ...specFields,
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
  if (!diff.ok)
    return { available: false, reason: `git diff failed: ${diff.reason}`, ...specFields };

  const commits = git(projectDir, ["log", "--format=%H %s", `${oid}..HEAD`, "--"]);
  if (!commits.ok)
    return { available: false, reason: `git log failed: ${commits.reason}`, ...specFields };

  const changed = git(projectDir, [
    "diff",
    "--name-only",
    "-z",
    `${oid}...HEAD`,
    "--",
    ...safePathspecs,
  ]);
  if (!changed.ok)
    return {
      available: false,
      reason: `git diff --name-only failed: ${changed.reason}`,
      ...specFields,
    };

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
    const written = writeArtefact(outDir, ARTEFACT_FILES[name], body);
    if (written !== undefined) paths[name] = written;
    const capped = cap(body);
    digest[name] = capped.text;
    if (capped.truncated) truncated[name] = true;
  }

  return {
    available: true,
    paths,
    digest,
    truncated,
    baseline: rev,
    baselineRule,
    withheld,
    ...specFields,
  };
}

/**
 * The `## spec sources` section, or nothing when the caller named none.
 *
 * Returned as an array so the caller can splice it into either branch of
 * `renderReviewMaterial` without a conditional at each site. The notes are part
 * of the section rather than a field beside it for the same reason `withheld`
 * is disclosed on the artefact: a reviewer told it has the ticket bodies when
 * one of them failed to fetch judges the change against a requirement list it
 * does not have, and reports the gap as delivered.
 */
function specSourcesSections(spec: SpecSourceResolution | undefined): string[] {
  // Nothing was supplied at all: no section rather than an empty one. "(none
  // could be read)" under a heading would report a failure where there was no
  // attempt, which is the same conflation this section exists to prevent.
  if (spec === undefined || (spec.literal && spec.full === "")) return [];

  const notes = spec.notes.map((note) => `- ${note}`).join("\n");
  const label = spec.literal
    ? "literal text — no GitHub reference named"
    : `fetched by the daemon${spec.path === undefined ? "" : ` — full: ${spec.path}`}`;
  const body = spec.text.replace(/\s+$/u, "");
  return [`## spec sources (${label})\n${notes}\n\n${body === "" ? "(none could be read)" : body}`];
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
    return [
      `## review material unavailable\n${material.reason}\n\n` +
        "No diff, commit list, changed-file list or history probe was captured. " +
        "Derive the scope of the change from the change text instead, and say in your output that you did.",
      ...specSourcesSections(material.specSources),
    ].join("\n\n");
  }

  const sections: string[] = [
    `## baseline\n${material.baseline}\n${BASELINE_RULE_REASONS[material.baselineRule]}`,
    ...specSourcesSections(material.specSources),
  ];

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
