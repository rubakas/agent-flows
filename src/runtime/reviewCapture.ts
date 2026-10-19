// The repository material a review is judged on, captured without a shell.
//
// One implementation, two callers: the daemon's review step (reviewMaterial.ts) and
// the review plugin's capture script, which receives this file transpiled by
// scripts/build-af-review-capture.mjs. The plugin ships with no node_modules and no
// copy of the rest of the repository, so this module imports only `node:*` and the
// dependency-free credential-pattern leaf, and the generator refuses anything else.
//
// A review step holds `contents: read` — Read, Glob and Grep, never Bash (see
// StepDef.permissions in canon/types.ts). That is deliberate: a reviewer must
// not be able to run commands in the tree it is judging. But a review that
// cannot see the diff, the commits or the history of the files it is reviewing
// has to guess at provenance, and a guess is what the review is supposed to
// replace. This module is the other half of that trade: the caller — not the
// model — runs the git commands, and hands the result in as data.
//
// A `check` step is not an option here. Check commands are deliberately NOT
// placeholder-rendered (see pipelines/ship.yaml and the loader's placeholder
// rule) because interpolating anything run-scoped into a shell string is
// command injection, and `baseline` is caller-supplied. Every git call below
// uses an argv array through spawnSync; no `/bin/sh` is involved anywhere.
//
// The same trade covers spec sources. A reviewer holding `contents: read` has
// no network either, so a caller who names a pull request or an issue URL is
// naming something the model cannot open. So the caller fetches those too — with
// `gh`, argv arrays, never a shell and never `curl`. That is this module's ONLY
// outbound network call, and it is reached only by a value that passed the
// anchored patterns below: `github.com` and no other host, an owner and repo of
// `[A-Za-z0-9._-]` that may not begin with `-`, and a number of at most ten digits.
//
// Timeouts. A git call that does not answer in time throws GitTimeoutError — it is
// raised, never returned, because a plain failure would read as "git said no" and
// several callers carry on with a fallback, i.e. partial material presented as a
// complete one. These can throw it: `git`, `resolveCommit`, `deriveBaseline`,
// `originNameWithOwner`, `resolveSpecRefs` (which reads the origin remote), and any
// caller's own `git` calls. `captureGit` never throws on a git failure: it turns the
// timeout into an unavailable capture.
//
// Plugin runtime: the plugin promises Node >= 18, so nothing here may use an API
// newer than that.

import { spawnSync } from "node:child_process";

import { CREDENTIAL_DENY_PATTERNS } from "../canon/credentialPatterns.js";
import type { SpawnSyncReturns } from "node:child_process";

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
 * The files a review may never be handed.
 *
 * CREDENTIAL_DENY_PATTERNS is enforced elsewhere as `--disallowedTools` entries
 * on a provider CLI — that constrains the MODEL'S tools and cannot constrain the
 * git processes this module spawns. Everything captured here is written to disk
 * and rendered into reviewer prompts, i.e. transmitted to a model provider, so
 * the same list has to be enforced on this path too.
 *
 * Imported, never re-spelled: a hand-copied second list drifts from the first.
 *
 * The capture withholds more than the model's own tools are denied: the dotenv
 * globs below. `.env.*` also withholds `.env.example`, which
 * CREDENTIAL_DENY_PATTERNS deliberately leaves readable (a template holds
 * placeholders, and a step needs it to understand configuration). A pathspec
 * exclusion cannot carve an exception out of a wildcard, and a variant nobody
 * listed (`.env.qa`, `app.env`) holding a real secret reaching a prompt costs
 * far more than a placeholder file missing from a diff, so here the wildcard wins.
 * The trade is made once, in this list, for both callers of the capture.
 *
 * Case-folded and de-duplicated: every pathspec carries `icase`, so the upper-case
 * twins CREDENTIAL_DENY_PATTERNS keeps for the model's case-sensitive matcher are
 * noise here.
 */
const CAPTURE_ONLY_DENY_PATTERNS: readonly string[] = ["**/.env.*", "**/*.env"];

export const CAPTURE_DENY_PATTERNS: readonly string[] = [
  ...new Set(
    [...CREDENTIAL_DENY_PATTERNS, ...CAPTURE_ONLY_DENY_PATTERNS].map((pattern) =>
      pattern.toLowerCase()
    )
  ),
];

/**
 * The deny list, expressed as git pathspecs.
 *
 * It is enforced as a pathspec rather than by filtering the captured text: a
 * post-filter runs on a string that already holds the secret. With `:(exclude)`
 * the content never enters this process's memory at all.
 *
 * `icase` so `.ENV` and `Credentials.json` are matched as the names they are,
 * whatever the repository's `core.ignorecase` says.
 *
 * Magic: `top` anchors each pattern at the repository root rather than at the
 * working directory the capture runs from, and `glob` gives `**` its
 * gitignore-style meaning ("at any depth, including the root"), which is how the
 * deny list is written. The leading `:/` is the positive pathspec "the whole
 * tree" — without it the capture would be scoped to the current directory.
 */
const CREDENTIAL_EXCLUDE_PATHSPECS: readonly string[] = CAPTURE_DENY_PATTERNS.map(
  (pattern) => `:(top,exclude,glob,icase)${pattern}`
);

/** The exclusions plus "the whole tree", for a query that names no path of its own. */
const SAFE_PATHSPECS: readonly string[] = [":/", ...CREDENTIAL_EXCLUDE_PATHSPECS];

/** The same list inverted: matches ONLY the credential-shaped paths. */
const CREDENTIAL_PATHSPECS: readonly string[] = CAPTURE_DENY_PATTERNS.map(
  (pattern) => `:(top,glob,icase)${pattern}`
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
export function nulFields(stdout: string): string[] {
  return stdout.split("\0").filter((field) => field.length > 0);
}

// A file name or commit subject is attacker-chosen text that lands in a document a
// model reads as structure: an embedded newline plus `## ...` would forge a heading.
// Every control character except TAB is written out as \uXXXX (newline included).
// eslint-disable-next-line no-control-regex
const RE_CONTROL = /[\x00-\x08\x0a-\x1f\x7f]/gu;

/** One name or line with its control characters written out. */
function escapeControl(text: string): string {
  return text.replace(RE_CONTROL, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/** `escapeControl` for a multi-line body: the line breaks themselves stay. */
function escapeLines(text: string): string {
  return text.split("\n").map(escapeControl).join("\n");
}

/** The artefacts captured for a review. */
export type ReviewArtefact = "diff" | "commits" | "changedFiles" | "history";

/**
 * Max `gh` invocations per capture, counted across the references the caller
 * named AND the issues those references link to. The refs arrive through an
 * unauthenticated localhost daemon or a chat session, and each one is a process
 * and a network round trip, so the budget is on the total, not per source.
 */
const MAX_SPEC_SOURCE_FETCHES = 10;

/**
 * Deadline for one `gh` call. spawnSync blocks the caller's event loop, so a
 * hung network call is a hung process — this is the only thing bounding it.
 * `AF_REVIEW_GH_TIMEOUT_MS` is a test-only override so a test can exercise the timeout
 * (see `gitTimeoutMs`, which has the same shape for git).
 */
function ghTimeoutMs(): number {
  const override = Number(process.env.AF_REVIEW_GH_TIMEOUT_MS);
  return Number.isInteger(override) && override > 0 ? override : 20_000;
}

/**
 * One path segment of a GitHub reference: an owner or a repository name.
 * Anchored, and checked against the whole segment — this is what keeps a
 * crafted value out of `gh`'s own option parser and off any host but
 * github.com. A leading `-` is refused separately, for the reason
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

/** One `gh` invocation, in the same never-throwing shape as `git` below. */
export interface GhOutcome {
  ok: boolean;
  stdout: string;
  reason: string;
  /** True when the call was killed at its deadline rather than failing by itself. */
  timedOut?: boolean;
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

/** What a caller's spec source resolved to. */
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
export function isSafeGithubSegment(segment: string): boolean {
  if (!RE_GITHUB_SEGMENT.test(segment)) return false;
  if (segment.startsWith("-")) return false;
  return segment !== "." && segment !== "..";
}

/**
 * One `gh` invocation as an argv array. Never throws and never uses a shell,
 * the same defensive shape as `git` below. `gh` — not `curl` — is what fixes
 * the host: a crafted value cannot redirect the request to another server,
 * because the server is not something this argv names.
 */
export function ghRunnerFor(projectDir: string): GhRunner {
  return (args) => {
    try {
      const result = spawnSync("gh", [...args], {
        cwd: projectDir,
        encoding: "utf8",
        maxBuffer: GIT_MAX_BUFFER,
        timeout: ghTimeoutMs(),
        killSignal: "SIGKILL",
      });
      if (result.error !== null && result.error !== undefined) {
        const timedOut = (result.error as NodeJS.ErrnoException).code === "ETIMEDOUT";
        return {
          ok: false,
          stdout: "",
          reason: result.error.message,
          ...(timedOut ? { timedOut } : {}),
        };
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

/** True when EVERY whitespace- or comma-separated token in `value` is trying to be a reference. */
export function isGithubRefList(value: string): boolean {
  const tokens = value.split(/[\s,]+/u).filter((token) => token.length > 0);
  return tokens.length > 0 && tokens.every(looksLikeRef);
}

/**
 * Turns one ref-shaped token into a validated `SpecRef`, or into the reason it
 * was refused. Every refusal is returned as a string and reported to the
 * reviewer: a reference silently dropped is a requirement silently dropped.
 */
export function parseSpecRef(
  token: string,
  fallback?: { owner: string; repo: string }
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

/** The owner/repo a bare `#123` means: this repository's github.com origin. May throw GitTimeoutError. */
export function originNameWithOwner(
  projectDir: string,
  env?: GitEnvExtras
): { owner: string; repo: string } | undefined {
  const remote = git(projectDir, ["remote", "get-url", "origin"], env);
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
export function fetchSpecRef(gh: GhRunner, ref: SpecRef): FetchedRef | string {
  const repoArg = `${ref.owner}/${ref.repo}`;
  const tools = ref.kind === "pull" ? ["pr"] : ref.kind === "issues" ? ["issue"] : ["pr", "issue"];
  let reason = "no attempt was made";
  for (const tool of tools) {
    const outcome = gh([tool, "view", ref.number, "--repo", repoArg, "--json", "title,body,url"]);
    if (!outcome.ok) {
      // A hung network does not get better by asking the same service a second
      // question: record the timeout and stop. This bounds one reference at one
      // deadline, not the capture: N references can still wait N deadlines
      // (MAX_SPEC_SOURCE_FETCHES of them), each blocking the caller's event loop.
      if (outcome.timedOut === true) {
        reason = `gh ${tool} view timed out`;
        break;
      }
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
 * Resolves a whitespace- or comma-separated list of GitHub references into the
 * text the delivery reviewer is judged against. A token that is not a reference
 * is refused here by name and never reaches `gh`; deciding whether a value is a
 * reference list at all (`isGithubRefList`) belongs to the caller, because what
 * happens to a value that is not one — literal text, or a refusal — differs.
 *
 * `budget.used` is shared across calls so the fetch cap holds for a whole capture.
 *
 * Everything fetched is UNTRUSTED text: the titles and URLs are written out through
 * `escapeControl` so they cannot forge a heading, but a body is passed on as it is, and a
 * reviewer must read it as a requirement to judge the change against, never as instruction.
 *
 * Never throws on `gh`: missing, unauthenticated or failing is recorded as a
 * reason and leaves that reference's text empty, because a review that cannot
 * read one ticket is still worth more than no review. May throw GitTimeoutError
 * (the origin remote is read through `git`).
 */
export function resolveSpecRefs(
  projectDir: string,
  value: string,
  gh: GhRunner,
  budget: { used: number } = { used: 0 },
  env?: GitEnvExtras
): SpecSourceResolution {
  const tokens = value.split(/[\s,]+/u).filter((token) => token.length > 0);

  // Resolved lazily and at most once: a value made only of `owner/repo#n` refs
  // never needs the origin remote, and a run in a non-git directory must not be
  // charged a process for it.
  let fallback: { owner: string; repo: string } | undefined;
  let fallbackResolved = false;
  const originFallback = (): { owner: string; repo: string } | undefined => {
    if (!fallbackResolved) {
      fallback = originNameWithOwner(projectDir, env);
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
  let attempted = 0;
  let capReported = false;

  while (queue.length > 0) {
    const ref = queue.shift()!;
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
    const url = escapeControl(fetched.url);
    notes.push(`${ref.label}: fetched ${fetched.isPullRequest ? "pull request" : "issue"} ${url}`);
    const heading = `### ${ref.label} — ${escapeControl(fetched.title)}\n${url}\n`;
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
export const BASELINE_RULE_REASONS: Record<BaselineRule, string> = {
  caller: "supplied by the caller",
  "merge-base":
    "derived: no baseline was supplied, so the merge-base of HEAD and this repository's default branch (origin/HEAD) was used",
  "previous-commit":
    "derived: no baseline was supplied and no default branch gave a merge-base other than HEAD itself, so HEAD~1 was used — this reviews the last commit only",
};

export interface GitOutcome {
  ok: boolean;
  stdout: string;
  stderr: string;
  reason: string;
}

/** A git call that did not answer in time. Raised, never returned: see `git()`. */
export class GitTimeoutError extends Error {}

/**
 * Deadline for one git call. `AF_REVIEW_GIT_TIMEOUT_MS` is a test-only override so a test
 * can exercise the timeout; `AF_REVIEW_GH_TIMEOUT_MS` is its counterpart for `gh`.
 */
function gitTimeoutMs(): number {
  const override = Number(process.env.AF_REVIEW_GIT_TIMEOUT_MS);
  return Number.isInteger(override) && override > 0 ? override : 120_000;
}

/**
 * Variables a caller adds to git's environment on top of the caller's own. The
 * plugin drops the system git config, the pager and the locale this way; the
 * daemon adds nothing, because the system config often carries `safe.directory`
 * and dropping it can make a daemon capture fail as "dubious ownership".
 */
export type GitEnvExtras = Readonly<Record<string, string>>;

/**
 * Git's environment: the caller's own, with messages pinned so they do not
 * depend on the user's locale, no optional locks (a read-only capture must not
 * contend with the user's own git) and no prompts. Built per call so a caller
 * that pins HOME or GIT_* after import is honoured.
 */
function gitEnv(extra: GitEnvExtras | undefined): NodeJS.ProcessEnv {
  return {
    ...process.env,
    // The caller's additions go UNDER the pins below: an extra can add a variable,
    // never unpin one of ours.
    ...extra,
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    // A partial clone would otherwise fetch a missing object over the network,
    // and that runs the repository's own `core.sshCommand`.
    GIT_NO_LAZY_FETCH: "1",
    // GIT_NO_LAZY_FETCH is honoured only by git >= 2.44. An older git would still
    // lazy-fetch, so ssh is pinned to a command that fails: the environment variable
    // beats `core.sshCommand`, and the fetch fails closed instead of running whatever
    // the repository configured. A capture never fetches, so nothing legitimate needs it.
    GIT_SSH_COMMAND: "false",
    LC_ALL: "C",
  };
}

/**
 * `-c` overrides beat the repository's own config: a repo-local `core.fsmonitor`
 * is a command git would run on every index refresh, `color.ui=always` would put
 * escape codes into the artefacts, and `log.showSignature` hands any commit that
 * carries a signature header to the repository's own `gpg.program`.
 */
const GIT_CONFIG_OVERRIDES: readonly string[] = [
  "-c",
  "core.fsmonitor=false",
  "-c",
  "color.ui=false",
  "-c",
  "log.showSignature=false",
];

/**
 * Passed to every diff/show/log: a repo-local `diff.external` or textconv driver
 * could otherwise run a command, or change what the reviewer is shown.
 */
export const NO_DRIVERS: readonly string[] = ["--no-ext-diff", "--no-textconv", "--no-color"];

/**
 * One git invocation as an argv array. Never uses a shell: a spawn error, a
 * non-zero exit and a thrown exception all come back as `ok: false` with a
 * one-line reason.
 *
 * The one exception is a timeout, which throws GitTimeoutError: `captureGit`
 * turns it into an unavailable capture. Returned as a plain failure it would
 * read as "git said no" and several callers carry on with a fallback (a
 * different baseline, an "unavailable" history section), i.e. a partial
 * material presented as a complete one.
 */
export function git(projectDir: string, args: readonly string[], env?: GitEnvExtras): GitOutcome {
  const timeout = gitTimeoutMs();
  let result: SpawnSyncReturns<string>;
  try {
    result = spawnSync("git", [...GIT_CONFIG_OVERRIDES, ...args], {
      cwd: projectDir,
      encoding: "utf8",
      maxBuffer: GIT_MAX_BUFFER,
      timeout,
      // spawnSync waits for the child to exit after the timeout's signal, and the default
      // SIGTERM can be ignored; SIGKILL cannot, so the deadline is a deadline.
      killSignal: "SIGKILL",
      env: gitEnv(env),
    });
  } catch (err) {
    return {
      ok: false,
      stdout: "",
      stderr: "",
      reason: err instanceof Error ? err.message : String(err),
    };
  }
  const stderr = result.stderr ?? "";
  if (result.error !== null && result.error !== undefined) {
    if ((result.error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
      throw new GitTimeoutError(`git ${String(args[0])} timed out after ${String(timeout)} ms`);
    }
    return { ok: false, stdout: "", stderr, reason: result.error.message };
  }
  if (result.status !== 0) {
    const firstLine = stderr.trim().split("\n")[0] ?? "";
    return {
      ok: false,
      stdout: "",
      stderr,
      reason: firstLine === "" ? `git exited ${String(result.status)}` : firstLine,
    };
  }
  return { ok: true, stdout: result.stdout ?? "", stderr, reason: "" };
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
function defaultBranchRef(projectDir: string, env?: GitEnvExtras): string | undefined {
  const ref = git(projectDir, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"], env);
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
export function deriveBaseline(
  projectDir: string,
  env?: GitEnvExtras
): { rev: string; rule: BaselineRule } | string {
  const head = resolveCommit(projectDir, "HEAD", env);
  const branch = defaultBranchRef(projectDir, env);
  if (branch !== undefined) {
    const mergeBase = git(projectDir, ["merge-base", "HEAD", branch], env);
    const oid = mergeBase.ok ? mergeBase.stdout.trim() : "";
    if (RE_OID.test(oid) && oid !== head) return { rev: oid, rule: "merge-base" };
  }
  const previous = resolveCommit(projectDir, "HEAD~1", env);
  if (previous !== undefined) return { rev: previous, rule: "previous-commit" };
  return (
    "no baseline was supplied and none could be derived: this repository has no " +
    "origin/HEAD default branch to take a merge-base against, and HEAD has no parent commit"
  );
}

/** Caps `text` and reports whether it was capped. */
export function cap(text: string): { text: string; truncated: boolean } {
  if (text.length <= REVIEW_MATERIAL_CAP) return { text, truncated: false };
  return { text: text.slice(0, REVIEW_MATERIAL_CAP) + "\n[TRUNCATED]", truncated: true };
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
export function resolveCommit(
  projectDir: string,
  rev: string,
  env?: GitEnvExtras
): string | undefined {
  const parsed = git(projectDir, ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`], env);
  if (!parsed.ok) return undefined;
  const oid = parsed.stdout.trim();
  return RE_OID.test(oid) ? oid : undefined;
}

/** The object names to probe, caller-supplied ones validated, git's own trusted. */
function probeCommits(
  projectDir: string,
  commitLog: string,
  extraCommits: readonly string[] | undefined,
  env: GitEnvExtras | undefined
): string[] {
  const shas: string[] = [];
  for (const line of commitLog.split("\n")) {
    const sha = line.trim().split(" ")[0] ?? "";
    if (RE_SHA.test(sha)) shas.push(sha);
  }
  for (const candidate of extraCommits ?? []) {
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
    const resolved = resolveCommit(projectDir, sha, env);
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
  denied: ReadonlySet<string>,
  env: GitEnvExtras | undefined
): { paths: string[]; incomplete: boolean } {
  const pairs = git(
    projectDir,
    ["diff", ...NO_DRIVERS, "--name-status", "-M", "-z", `${oid}...HEAD`, "--", ":/"],
    env
  );
  // Past diff.renameLimit git prints a warning and SKIPS inexact rename detection,
  // so a denied file renamed with one line changed arrives as a plain add. A pass
  // that failed or was skipped cannot vouch for the pairs it did not find. ANY
  // stderr counts, not just git's English wording: the caller only runs this
  // pass when a denied path changed, and a warning worded differently by a newer
  // git must not read as "all clear".
  if (!pairs.ok || pairs.stderr.trim() !== "") return { paths: [], incomplete: true };

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
  return { paths: [...new Set(counterparts)], incomplete: false };
}

/** What a caller asks `captureGit` for. */
export interface CaptureRequest {
  /** Working tree to capture from. */
  projectDir: string;
  /** Untrusted caller input: the revision the change is measured against. */
  baseline?: unknown;
  /**
   * Untrusted caller-supplied object names to probe as well. Only the daemon's
   * entry point carries them; the plugin's capture script cannot reach this.
   */
  extraCommits?: readonly string[];
  /** Variables added to the environment of every git call of the capture. */
  env?: GitEnvExtras;
}

/** The git half of a review capture. */
export type GitCapture =
  | {
      available: false;
      reason: string;
      /** True when the capture ended because a git call timed out. */
      timedOut?: true;
    }
  | {
      available: true;
      /** The validated baseline the capture ran against, as named or derived. */
      baseline: string;
      /** The baseline resolved to a 40-hex commit name; every command was given this. */
      baselineOid: string;
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
      /** The full text of each artefact, uncapped. */
      bodies: Record<ReviewArtefact, string>;
    };

/**
 * Captures the material a review needs: the diff, the commits that produced it,
 * the files it touches, and the history of those files so a reviewer can answer
 * provenance questions ("was this deleted before?") without running anything.
 *
 * Credential-shaped paths are excluded from every capturing command by pathspec,
 * so their contents never reach the artefacts, the digest or a prompt. The paths
 * themselves come back in `withheld`: a reviewer told the diff is complete when
 * it is not reviews a fiction.
 *
 * Never throws on a git failure: a timeout is returned as an unavailable capture.
 */
export function captureGit(request: CaptureRequest): GitCapture {
  try {
    return captureGitUnguarded(request);
  } catch (err) {
    if (!(err instanceof GitTimeoutError)) throw err;
    return { available: false, reason: err.message, timedOut: true };
  }
}

function captureGitUnguarded(request: CaptureRequest): GitCapture {
  const { projectDir, baseline, extraCommits, env } = request;
  const run = (args: readonly string[]): GitOutcome => git(projectDir, args, env);

  // A caller who named a baseline gets that baseline, validated exactly as
  // before; a caller who named none gets one derived here rather than a refusal.
  // "Nothing is mandatory" is the point of this entry path, and a review that
  // will not start because an optional input is missing is the opposite of it.
  let rev: string;
  let baselineRule: BaselineRule;
  if (baselineOmitted(baseline)) {
    const derived = deriveBaseline(projectDir, env);
    if (typeof derived === "string") return { available: false, reason: derived };
    rev = derived.rev;
    baselineRule = derived.rule;
  } else {
    const rejection = rejectBaseline(baseline);
    if (rejection !== undefined) return { available: false, reason: rejection };
    rev = baseline as string;
    baselineRule = "caller";
  }

  // The pattern says the value is shaped like a revision; only git can say it
  // names one. Both checks run before any capturing command is issued. Every
  // command below is given the RESOLVED name, never `rev` itself.
  const oid = resolveCommit(projectDir, rev, env);
  if (oid === undefined) {
    return {
      available: false,
      reason: `baseline ${JSON.stringify(rev)} does not resolve to a commit in this repository`,
    };
  }

  // The deny list as the POSITIVE pathspec: the names of the changed paths the
  // capture is withholding. Names only — no content is read. This runs first
  // because the rename pass below needs to know which paths are denied.
  const excluded = run([
    "diff",
    ...NO_DRIVERS,
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
  const pairs =
    denied.length === 0
      ? { paths: [], incomplete: false }
      : renameCounterparts(projectDir, oid, deniedSet, env);
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
  const diff = run(["diff", ...NO_DRIVERS, "--text", `${oid}...HEAD`, "--", ...safePathspecs]);
  if (!diff.ok) return { available: false, reason: `git diff failed: ${diff.reason}` };

  const commits = run(["log", ...NO_DRIVERS, "--format=%H %s", `${oid}..HEAD`, "--"]);
  if (!commits.ok) return { available: false, reason: `git log failed: ${commits.reason}` };

  const changed = run([
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

  // `-z` so a path arrives exactly as it is on disk. Without it git C-quotes a
  // non-ASCII name (`"caf\303\251.txt"`), and these paths are fed back to git as
  // pathspecs below, where the quoted spelling matches nothing at all.
  const allChangedPaths = nulFields(changed.stdout);
  const changedPaths = allChangedPaths.slice(0, MAX_HISTORY_PATHS);
  const changedList =
    allChangedPaths.length === 0 ? "" : allChangedPaths.map(escapeControl).join("\n") + "\n";

  // Provenance probes. `--` separates the pathspecs from the revision arguments
  // so a file literally named like an option is still read as a path.
  const historyParts: string[] = [];
  if (changedPaths.length > 0) {
    const fileHistory = run([
      "log",
      ...NO_DRIVERS,
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
        ? `# add/delete history of the changed files\n${escapeLines(fileHistory.stdout)}`
        : `# add/delete history unavailable: ${fileHistory.reason}`
    );
  }
  for (const sha of probeCommits(projectDir, commits.stdout, extraCommits, env)) {
    const stat = run([
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

  // The withholding is disclosed on the artefact a reviewer reads as the scope
  // of the change, so it travels with the omission it explains rather than only
  // in a field beside it. Absent when nothing was withheld: a notice on every
  // capture is noise a reader learns to skip.
  const disclosure =
    withheld.length === 0
      ? ""
      : `\n# ${String(withheld.length)} changed path(s) withheld by credential policy` +
        ` — excluded from the diff, this list and the history probes:\n` +
        withheld.map((p) => `# ${escapeControl(p)}`).join("\n") +
        "\n";

  return {
    available: true,
    baseline: rev,
    baselineOid: oid,
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

/**
 * Caps each artefact for the prompt and reports which were capped. The full
 * text is the caller's to write to disk: a real diff exceeds any prompt, and the
 * review steps hold `contents: read`, so they can open the artefact file and
 * read the rest.
 */
export function digestBodies(bodies: Record<ReviewArtefact, string>): {
  digest: Record<ReviewArtefact, string>;
  truncated: Partial<Record<ReviewArtefact, boolean>>;
} {
  const digest = {} as Record<ReviewArtefact, string>;
  const truncated: Partial<Record<ReviewArtefact, boolean>> = {};
  for (const name of Object.keys(bodies) as ReviewArtefact[]) {
    const capped = cap(bodies[name]);
    digest[name] = capped.text;
    if (capped.truncated) truncated[name] = true;
  }
  return { digest, truncated };
}

/**
 * One `## spec sources` section, or undefined when the caller supplied nothing.
 *
 * The notes are part of the section rather than a field beside it for the same
 * reason `withheld` is disclosed on the artefact: a reviewer told it has the
 * ticket bodies when one of them failed to fetch judges the change against a
 * requirement list it does not have, and reports the gap as delivered.
 *
 * Nothing supplied at all means no section rather than an empty one. "(none could
 * be read)" under a heading would report a failure where there was no attempt,
 * which is the same conflation this section exists to prevent.
 *
 * @param label What the caller says about where the text came from.
 */
export function renderSpecSection(
  resolution: SpecSourceResolution,
  label: string
): string | undefined {
  if (resolution.literal && resolution.full.trim() === "") return undefined;
  const notes = resolution.notes.map((note) => `- ${note}`).join("\n");
  const body = resolution.text.replace(/\s+$/u, "");
  return `## spec sources (${label})\n${notes}\n\n${body === "" ? "(none could be read)" : body}`;
}

/** The heading each artefact is rendered under, in the order a reviewer reads them. */
const ARTEFACT_LABELS: Record<ReviewArtefact, string> = {
  diff: "diff",
  commits: "commits",
  changedFiles: "changed files",
  history: "history probes",
};

/** What `renderMaterial` needs of a capture. */
export interface MaterialView {
  baseline: string;
  baselineRule: BaselineRule;
  withheld: readonly string[];
  /** Each artefact, already capped (see digestBodies). */
  digest: Record<ReviewArtefact, string>;
  truncated: Partial<Record<ReviewArtefact, boolean>>;
  /** Absolute path of each artefact written to disk. */
  paths: Partial<Record<ReviewArtefact, string>>;
}

/**
 * The capture as the plain text a prompt renders it into: baseline, spec
 * sources, diff, commits, changed files, history probes, withheld paths — each
 * named, each saying whether it was capped and where its full text lives.
 *
 * The step's ctx value must be a STRING. `ctxVars` (bindings/mastra/buildSteps.ts)
 * JSON-stringifies any non-string ctx value, so returning the structured object
 * put the diff into a prompt as one line with every newline written `\n` and
 * every quote backslash-escaped — the least readable form available, on a
 * pipeline whose stated problem is cost. Spec 044 D4/FR-003 ask for "one ctx
 * string keyed to the step id"; this is that string.
 *
 * @param specSections Each from `renderSpecSection`, in the order they are read.
 */
export function renderMaterial(view: MaterialView, specSections: readonly string[]): string {
  const sections: string[] = [
    `## baseline\n${view.baseline}\n${BASELINE_RULE_REASONS[view.baselineRule]}`,
    ...specSections,
  ];

  for (const name of Object.keys(ARTEFACT_LABELS) as ReviewArtefact[]) {
    const path = view.paths[name];
    const notes: string[] = [];
    if (view.truncated[name] === true) notes.push("truncated");
    notes.push(path === undefined ? "not written to disk" : `full: ${path}`);
    const body = view.digest[name].replace(/\s+$/u, "");
    sections.push(
      `## ${ARTEFACT_LABELS[name]} (${notes.join(" — ")})\n${body === "" ? "(empty)" : body}`
    );
  }

  // Disclosed as its own section as well as inside the changed-file artefact: a
  // reviewer who reads only the headings still sees that the diff is incomplete.
  if (view.withheld.length > 0) {
    sections.push(
      `## withheld by credential policy (${String(view.withheld.length)} path(s))\n` +
        "Excluded from every section above — the diff you were given is not complete:\n" +
        view.withheld.map(escapeControl).join("\n")
    );
  }

  return sections.join("\n\n");
}
