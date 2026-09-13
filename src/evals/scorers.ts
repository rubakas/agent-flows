/**
 * Deterministic scorers for the read-only eval pipelines: `investigate`,
 * `audit`, and `code-review`.
 *
 * All functions are pure and synchronous (citedPathsExist uses existsSync).
 * No Mastra dependency — every scorer here is directly unit-testable.
 *
 * PATH EXTRACTION RULE
 * --------------------
 * A token is treated as a repo-relative file path when it satisfies EITHER:
 *
 * Pass 1 — backtick-quoted paths:
 *   The token appears inside backticks (`...`), contains at least one "/",
 *   does NOT contain "://" (eliminates URLs), and matches the shape
 *   /^[\w][\w.-]*(\/[\w.-]+)+$/ (clean path, no surrounding punctuation).
 *
 * Pass 2 — prose paths with known repo prefixes:
 *   The token is an unquoted word matching the same shape regex AND starts with
 *   one of the known repo root directories: src/, docs/, pipelines/, prompts/,
 *   scripts/, specs/.  The prefix filter prevents ordinary English phrases that
 *   happen to contain "/" (e.g. "and/or") from being treated as paths.
 *
 * Deliberately ignored: URLs (contain "://"), OS-absolute paths (start with "/"),
 * relative upward paths ("../"), prose words with dots but no slash ("example.com").
 *
 * GAP MATCHING RULE
 * -----------------
 * Each expected gap/existing item is { phrase, keywords }.
 * A match requires ALL keywords to appear as case-insensitive substrings anywhere
 * in the output text.  Keywords should be specific technical terms (e.g. a function
 * name plus a file stem) so that random prose is unlikely to contain all of them.
 * The phrase is used only for human-readable reporting; matching is on keywords.
 */

import { statSync } from "node:fs";
import { join } from "node:path";

// ── Shared types ──────────────────────────────────────────────────────────────

/** A gap or existing-feature entry in an eval fixture answer key. */
export interface KeyedItem {
  /** Human-readable label shown in pass/fail reports. */
  phrase: string;
  /**
   * ALL of these strings must appear as case-insensitive substrings in the
   * output for this item to be considered "surfaced".
   */
  keywords: string[];
}

// ── citedPathsExist ───────────────────────────────────────────────────────────

export interface PathCheckResult {
  /** Fraction of cited paths that exist on disk. 1.0 when nothing is cited. */
  score: number;
  /** Paths that were cited AND exist. */
  found: string[];
  /** Paths that were cited but do NOT exist (fabricated). */
  invented: string[];
  /** Total candidates extracted from the output. */
  total: number;
}

const KNOWN_REPO_PREFIXES = ["src/", "docs/", "pipelines/", "prompts/", "scripts/", "specs/"];
const PATH_SHAPE = /^[\w][\w.-]*(\/[\w.-]+)+$/;

/** Sentence punctuation clings to a citation; no real filename ends with it. */
function trimTrailingPunctuation(raw: string): string {
  return raw.replace(/[.,;:]+$/, "");
}

function extractPaths(output: string): string[] {
  const found = new Set<string>();

  // Pass 1: backtick-quoted tokens.
  for (const m of output.matchAll(/`([^`\n]+)`/g)) {
    const token = trimTrailingPunctuation(m[1].trim());
    if (token.includes("/") && !token.includes("://") && PATH_SHAPE.test(token)) {
      found.add(token);
    }
  }

  // Pass 2: prose tokens with known repo prefixes.
  for (const m of output.matchAll(/\b([\w][\w.-]*(?:\/[\w.-]+)+)/g)) {
    const token = trimTrailingPunctuation(m[1]);
    if (token.includes("://")) continue;
    if (!PATH_SHAPE.test(token)) continue;
    if (KNOWN_REPO_PREFIXES.some((p) => token.startsWith(p))) {
      found.add(token);
    }
  }

  return [...found];
}

/**
 * Extract every repo-relative path cited in `output` and report which exist
 * on disk under `repoRoot` and which were invented.
 */
export function citedPathsExist(output: string, repoRoot: string): PathCheckResult {
  const candidates = extractPaths(output);
  const found: string[] = [];
  const invented: string[] = [];

  for (const p of candidates) {
    const st = statSync(join(repoRoot, p), { throwIfNoEntry: false });
    if (st?.isFile() === true) {
      found.push(p);
    } else if (st?.isDirectory() === true) {
      // A real directory is neither evidence of reading a file nor a
      // fabrication. Crediting it would let "src/" score a hit; penalising it
      // would mark "the n8n binding lives in src/bindings/n8n" as a
      // hallucination. It scores nothing either way.
      continue;
    } else {
      invented.push(p);
    }
  }

  const total = found.length + invented.length;
  const score = total === 0 ? 1 : found.length / total;
  return { score, found, invented, total };
}

// ── plantedGapsFound ──────────────────────────────────────────────────────────

export interface GapCheckResult {
  /** Fraction of expected gaps that the output surfaced. */
  score: number;
  /** Phrases of gaps the output mentioned. */
  surfaced: string[];
  /** Phrases of gaps the output missed. */
  missed: string[];
}

/**
 * Check how many of the planted gaps (known-in-advance things a correct
 * investigation must surface) appear in `output`.
 */
export function plantedGapsFound(output: string, expectedGaps: KeyedItem[]): GapCheckResult {
  const lower = output.toLowerCase();
  const surfaced: string[] = [];
  const missed: string[] = [];

  for (const gap of expectedGaps) {
    const hit = gap.keywords.every((kw) => lower.includes(kw.toLowerCase()));
    if (hit) {
      surfaced.push(gap.phrase);
    } else {
      missed.push(gap.phrase);
    }
  }

  const total = expectedGaps.length;
  const score = total === 0 ? 1 : surfaced.length / total;
  return { score, surfaced, missed };
}

// ── auditDefectsFound ─────────────────────────────────────────────────────────

export interface AuditCheckResult {
  /** Fraction of planted defects the audit found (0–1). 1.0 when nothing is planted. */
  recall: number;
  /** Phrases of planted defects the audit named. */
  found: string[];
  /** Phrases of planted defects the audit missed. */
  missed: string[];
  /**
   * Phrases of decoys the audit incorrectly flagged as real defects.
   * A decoy is code that looks suspicious but is actually fine; any finding
   * whose keywords all appear in the output counts as a false positive.
   */
  falsePositives: string[];
}

/**
 * Score an adversarial audit against a known set of planted defects and decoys.
 *
 * Recall: fraction of planted defects whose keywords all appear in `output`.
 * False positives: decoys whose keywords all appear in `output` — the auditor
 * flagged something that is actually fine.
 *
 * Both sides reuse the same KeyedItem keyword-matching convention as the other
 * scorers: all keywords must appear as case-insensitive substrings anywhere in
 * the output.  This symmetric treatment keeps the vocabulary consistent.
 */
export function auditDefectsFound(
  output: string,
  plantedDefects: KeyedItem[],
  decoys: KeyedItem[]
): AuditCheckResult {
  const lower = output.toLowerCase();
  const found: string[] = [];
  const missed: string[] = [];

  for (const defect of plantedDefects) {
    const hit = defect.keywords.every((kw) => lower.includes(kw.toLowerCase()));
    if (hit) {
      found.push(defect.phrase);
    } else {
      missed.push(defect.phrase);
    }
  }

  const total = plantedDefects.length;
  const recall = total === 0 ? 1 : found.length / total;

  const falsePositives: string[] = [];
  for (const decoy of decoys) {
    const hit = decoy.keywords.every((kw) => lower.includes(kw.toLowerCase()));
    if (hit) {
      falsePositives.push(decoy.phrase);
    }
  }

  return { recall, found, missed, falsePositives };
}

// ── existingFunctionalityNamed ────────────────────────────────────────────────

export interface ExistingCheckResult {
  /** Fraction of expected existing items that the output identified. */
  score: number;
  /** Phrases of items the output correctly identified as already existing. */
  identified: string[];
  /** Phrases of items the output missed or proposed to build fresh. */
  missed: string[];
}

/**
 * Check whether the output names the already-existing implementation it should
 * have found — rather than proposing to build it from scratch.
 */
export function existingFunctionalityNamed(
  output: string,
  expectedExisting: KeyedItem[]
): ExistingCheckResult {
  const lower = output.toLowerCase();
  const identified: string[] = [];
  const missed: string[] = [];

  for (const item of expectedExisting) {
    const hit = item.keywords.every((kw) => lower.includes(kw.toLowerCase()));
    if (hit) {
      identified.push(item.phrase);
    } else {
      missed.push(item.phrase);
    }
  }

  const total = expectedExisting.length;
  const score = total === 0 ? 1 : identified.length / total;
  return { score, identified, missed };
}

// ── reviewVerdicts ────────────────────────────────────────────────────────────

/** Verdict a verifier may reach on a finding raised by another agent. */
export type ReviewVerdict = "CONFIRMED" | "PARTIAL" | "DECLINED";

/** Classification of a reviewed item (spec 030 FR-004). */
export type ReviewKind = "defect" | "business-decision" | "external-confirmation";

/**
 * One expected verdict in a code-review fixture answer key.
 *
 * Matching reuses the KeyedItem convention: ALL `keywords` must appear
 * (case-insensitively) in the finding, so the answer key identifies a finding
 * without depending on the verifier's exact wording.
 */
export interface VerdictExpectation extends KeyedItem {
  /** The verdict the verifier must reach for this finding. */
  expectedVerdict: ReviewVerdict;
  /** Optional: the classification the verifier must assign. */
  expectedKind?: ReviewKind;
}

export interface VerdictCheckResult {
  /** Phrases whose verdict (and kind, when expected) came out as required. */
  correct: string[];
  /** Findings that were located but judged differently than required. */
  wrong: { phrase: string; expected: string; actual: string }[];
  /** Phrases the output never accounted for at all. */
  missing: string[];
  /** correct.length / expectations.length. 1 when nothing is expected. */
  accuracy: number;
  /**
   * Findings of kind `defect` whose severity is `blocking` and whose verdict is
   * not `DECLINED`.
   * `business-decision` and `external-confirmation` items are never counted,
   * however severe they read: they are excluded from the blocking count by
   * spec 030 FR-004, and this number is what proves it. A `DECLINED` finding is
   * excluded for the same reason: synthesis drops it, so counting it would put
   * this number permanently out of step with the verdict line it validates.
   */
  blockingCount: number;
}

const VERDICT_TOKENS: ReviewVerdict[] = ["CONFIRMED", "PARTIAL", "DECLINED"];

function verdictLabel(verdict: string, kind?: string): string {
  return kind === undefined ? verdict : `${verdict} (kind: ${kind})`;
}

export interface ParsedFinding {
  /** Lowercased text of the whole finding, used for keyword matching. */
  haystack: string;
  verdict: string;
  kind?: string;
  blocking: boolean;
}

/**
 * The JSON schema travels as a prompt suffix, not as a transport-level
 * constraint, so a model that wraps its object in a ```json fence is emitting
 * the right answer in the wrong envelope. Unwrap it rather than grading it as
 * prose.
 */
function stripCodeFences(output: string): string {
  const trimmed = output.trim();
  const fenced = /^```[\w-]*\s*\n([\s\S]*?)\n?```$/.exec(trimmed);
  return fenced === null ? trimmed : fenced[1];
}

/**
 * The text an answer key is matched against: what the finding ASSERTS, never how
 * it was investigated.
 *
 * `probes` are excluded deliberately. They quote guards, callers and remedies the
 * verifier looked at, so a finding about one subject routinely names the
 * identifiers of another — matching the whole object let an answer key latch onto
 * a finding that never made its claim, and graded the wrong item's verdict.
 *
 * This scoping is a JSON-path guarantee only: prose output has no fields, so the
 * prose parser matches the whole block, probe text included.
 */
function matchText(f: Record<string, unknown>): string {
  return [f.claim, f.file, f.quote, f.correctedWording]
    .filter((v): v is string => typeof v === "string" && v.length > 0)
    .join(" ")
    .toLowerCase();
}

/**
 * Findings already attributed to an answer key.
 *
 * One finding answers at most one key. Without this, a single finding that
 * satisfies two keys is graded twice under two different contracts — the NaN
 * bait, which names the refund window it claims to bypass, also satisfies the
 * policy key, and the same finding then counts as correctly declined bait AND as
 * a policy call misclassified as a defect. Pass one set through every scorer
 * reading the same output to make attribution exclusive.
 *
 * Keys carry the finding's position as well as its text, so two findings that
 * assert the very same thing remain two claims.
 */
export type ClaimedFindings = Set<string>;

function claimKey(index: number, f: ParsedFinding): string {
  return `${index.toString()}\u0000${f.haystack}`;
}

/**
 * EVERY unclaimed finding whose asserted text contains every keyword, in output
 * order; claims them all. Order of calls IS priority: earlier keys take the
 * findings they match.
 *
 * All, not the first: two workers reviewing the same diff raise the same bait
 * twice, and a key that claimed only one left the duplicate loose for the next
 * key to mistake for its own item. A bait raised by two workers is still one
 * bait, and both copies belong to it.
 */
function matchAll(
  findings: ParsedFinding[],
  keywords: string[],
  claimed?: ClaimedFindings
): ParsedFinding[] {
  const hits: ParsedFinding[] = [];
  for (const [index, f] of findings.entries()) {
    const key = claimKey(index, f);
    if (claimed?.has(key) === true) continue;
    if (!keywords.every((kw) => f.haystack.includes(kw.toLowerCase()))) continue;
    claimed?.add(key);
    hits.push(f);
  }
  return hits;
}

/** JSON path: the verify step is schema-gated, so fields can be read directly. */
function parseJsonFindings(output: string): ParsedFinding[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripCodeFences(output));
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const list = (parsed as Record<string, unknown>).codeReviewFindings;
  // Valid JSON that simply lacks the key is a schema failure, not prose. Falling
  // through to the prose parser would fold the whole blob into one block — a
  // single-line JSON object has no blank line to split on — and grade every
  // expectation against that one block's verdict. Account for nothing instead.
  if (!Array.isArray(list)) return [];

  return list.map((raw): ParsedFinding => {
    const f = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
    const verdict = typeof f.verdict === "string" ? f.verdict.toUpperCase() : "";
    return {
      haystack: matchText(f),
      verdict,
      kind: typeof f.kind === "string" ? f.kind : undefined,
      blocking: verdict !== "DECLINED" && f.kind === "defect" && f.severity === "blocking",
    };
  });
}

const ANCHORED_VERDICT = /verdict:\s*(CONFIRMED|PARTIAL|DECLINED)/i;

/**
 * The verdict a prose block reaches.
 *
 * An anchored `verdict: X` label wins outright. Otherwise the EARLIEST token in
 * the block wins, not the first member of VERDICT_TOKENS that happens to appear
 * anywhere: the verify prompt deliberately produces blocks naming two tokens
 * ("CONFIRMED as a defect while its details are DECLINED"), so array order would
 * grade "DECLINED — this would be CONFIRMED only if…" as CONFIRMED.
 */
function blockVerdict(block: string): string {
  const anchored = ANCHORED_VERDICT.exec(block);
  if (anchored !== null) return anchored[1].toUpperCase();

  const upper = block.toUpperCase();
  let earliest = "";
  let earliestIdx = Number.POSITIVE_INFINITY;
  for (const token of VERDICT_TOKENS) {
    const idx = upper.indexOf(token);
    if (idx !== -1 && idx < earliestIdx) {
      earliestIdx = idx;
      earliest = token;
    }
  }
  return earliest;
}

/**
 * Prose fallback: the same substring discipline as auditDefectsFound, but
 * windowed. A verdict token somewhere in a long report says nothing about which
 * finding it belongs to, so the keywords and the verdict must co-occur inside
 * one block (blank-line separated). Output with no blank line is one block.
 */
function parseProseFindings(output: string): ParsedFinding[] {
  const blocks = output
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter((b) => b.length > 0);

  return blocks.map((block): ParsedFinding => {
    const lower = block.toLowerCase();
    const verdict = blockVerdict(block);
    const kind = lower.includes("external-confirmation")
      ? "external-confirmation"
      : lower.includes("business-decision")
        ? "business-decision"
        : /\bdefect\b/.test(lower)
          ? "defect"
          : undefined;
    return {
      haystack: lower,
      verdict,
      kind,
      blocking: verdict !== "DECLINED" && kind === "defect" && /\bblocking\b/.test(lower),
    };
  });
}

/**
 * Score a verifier's per-finding verdicts against a known answer key.
 *
 * Pure and offline: no model call, no file read. The output may be JSON (the
 * verify step declares `schema: codeReviewFindings`) or prose (a model that
 * answered in text anyway); both are handled — JSON precisely, prose by
 * windowed substring matching.
 */
export function reviewVerdicts(
  output: string,
  expectations: VerdictExpectation[],
  claimed?: ClaimedFindings
): VerdictCheckResult {
  const findings = parseJsonFindings(output) ?? parseProseFindings(output);

  const correct: string[] = [];
  const wrong: { phrase: string; expected: string; actual: string }[] = [];
  const missing: string[] = [];

  for (const exp of expectations) {
    // Graded on the first hit: an expectation states one thing that must be
    // found, and the copies it also claims exist to keep them off later keys.
    const hit = matchAll(findings, exp.keywords, claimed)[0];
    if (!hit) {
      missing.push(exp.phrase);
      continue;
    }
    const verdictOk = hit.verdict === exp.expectedVerdict;
    const kindOk = exp.expectedKind === undefined || hit.kind === exp.expectedKind;
    if (verdictOk && kindOk) {
      correct.push(exp.phrase);
    } else {
      wrong.push({
        phrase: exp.phrase,
        expected: verdictLabel(exp.expectedVerdict, exp.expectedKind),
        actual: verdictLabel(
          hit.verdict === "" ? "NONE" : hit.verdict,
          exp.expectedKind === undefined ? undefined : (hit.kind ?? "unclassified")
        ),
      });
    }
  }

  const total = expectations.length;
  const accuracy = total === 0 ? 1 : correct.length / total;
  const blockingCount = findings.filter((f) => f.blocking).length;

  return { correct, wrong, missing, accuracy, blockingCount };
}

// ── reviewConditional ─────────────────────────────────────────────────────────

/** A verdict/kind pattern; an unset field is not compared. */
export interface ConditionalMatch {
  verdict?: ReviewVerdict;
  kind?: string;
}

/**
 * An answer-key item graded only if some producer raised it.
 *
 * Two patterns, because a bait key sweeps its neighbours. `want` is what a
 * correct adjudication of this item looks like; `forbid` is the adjudication that
 * fails the eval. Anything a key claims that is neither is ignored — a finding
 * about the same code from a different angle, correctly narrowed, is not this
 * item's business and must not fail it.
 */
export interface ConditionalItem extends KeyedItem {
  want: ConditionalMatch;
  forbid?: ConditionalMatch;
}

export interface ConditionalCheckResult {
  /** At least one claimed hit matched `want`, and none matched `forbid`. */
  routed: { phrase: string; hit: ParsedFinding }[];
  /**
   * A claimed hit matched `forbid`, one entry per offending hit. This is the
   * failure — bait a reachable guard closes, confirmed as a defect and passed on
   * to the author.
   */
  misrouted: { phrase: string; expected: string; got: string }[];
  /**
   * Raised, nothing forbidden, but nothing matching `want` either: the keys took
   * neighbouring findings and the item itself was never adjudicated. Reported,
   * never gating — it is the same kind of evidence as `notRaised`.
   */
  inconclusive: { phrase: string; got: string[] }[];
  /**
   * Items nobody raised. INCONCLUSIVE, never a failure: a reviewer cannot be
   * compelled to take bait or to surface a policy question, and an item never
   * raised says nothing either way about how the verifier would have judged it.
   */
  notRaised: string[];
}

function describeMatch(pattern: ConditionalMatch): string {
  return [
    pattern.verdict === undefined ? undefined : `verdict ${pattern.verdict}`,
    pattern.kind === undefined ? undefined : `kind ${pattern.kind}`,
  ]
    .filter(Boolean)
    .join(", ");
}

function describeFinding(hit: ParsedFinding, pattern: ConditionalMatch): string {
  return [
    pattern.verdict === undefined
      ? undefined
      : `verdict ${hit.verdict === "" ? "NONE" : hit.verdict}`,
    pattern.kind === undefined ? undefined : `kind ${hit.kind ?? "unclassified"}`,
  ]
    .filter(Boolean)
    .join(", ");
}

function matchesPattern(hit: ParsedFinding, pattern: ConditionalMatch): boolean {
  if (pattern.verdict !== undefined && hit.verdict !== pattern.verdict) return false;
  if (pattern.kind !== undefined && hit.kind !== pattern.kind) return false;
  return true;
}

/**
 * Score the items that are graded only when they are raised: bait a reachable
 * guard closes, and findings no producer can originate as themselves.
 *
 * Four states, because "absent", "adjudicated as required", "rubber-stamped" and
 * "swept up by a neighbour" are different facts and only two of them are
 * evidence. Folding them together is how a verifier that never runs scores the
 * same as one that works — or how a correct run fails on a neighbour's PARTIAL.
 *
 * Deliberately a companion to `reviewVerdicts` rather than a branch inside it.
 * `reviewVerdicts` grades expectations, where a finding that is missing is a
 * failure and a verdict is required; conditionals invert the first — absence is
 * tolerated. Sharing one function would mean one return shape carrying two
 * opposite contracts. They share the parser, which is the part worth sharing.
 *
 * Matching is `reviewVerdicts`'s: ALL keywords must appear in one finding's
 * asserted text, on whichever of the JSON and prose paths the output uses. Pass
 * the `claimed` set the expectations were scored with, and call this second:
 * expectations outrank conditionals for a finding both could match.
 *
 * A raised item carrying no readable verdict cannot match a `want` that demands
 * one, so it lands in `inconclusive` unless it is positively forbidden.
 */
export function reviewConditional(
  output: string,
  conditional: ConditionalItem[],
  claimed?: ClaimedFindings
): ConditionalCheckResult {
  const findings = parseJsonFindings(output) ?? parseProseFindings(output);

  const routed: { phrase: string; hit: ParsedFinding }[] = [];
  const misrouted: { phrase: string; expected: string; got: string }[] = [];
  const inconclusive: { phrase: string; got: string[] }[] = [];
  const notRaised: string[] = [];

  for (const item of conditional) {
    const hits = matchAll(findings, item.keywords, claimed);
    if (hits.length === 0) {
      notRaised.push(item.phrase);
      continue;
    }

    // Forbidden first: one worker declining the bait does not excuse another one
    // confirming it, because the author still receives the rubber stamp.
    const forbid = item.forbid;
    const offenders = forbid === undefined ? [] : hits.filter((h) => matchesPattern(h, forbid));
    if (forbid !== undefined && offenders.length > 0) {
      for (const hit of offenders) {
        misrouted.push({
          phrase: item.phrase,
          expected: `not ${describeMatch(forbid)}`,
          got: describeFinding(hit, forbid),
        });
      }
      continue;
    }

    const wanted = hits.find((h) => matchesPattern(h, item.want));
    if (wanted) {
      routed.push({ phrase: item.phrase, hit: wanted });
      continue;
    }

    inconclusive.push({
      phrase: item.phrase,
      got: hits.map((h) =>
        describeFinding(h, { verdict: h.verdict as ReviewVerdict, kind: h.kind })
      ),
    });
  }

  return { routed, misrouted, inconclusive, notRaised };
}
