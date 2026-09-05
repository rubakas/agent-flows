/**
 * Deterministic scorers for the `investigate` workflow.
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

import { existsSync } from "node:fs";
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
    if (existsSync(join(repoRoot, p))) {
      found.push(p);
    } else {
      invented.push(p);
    }
  }

  const total = candidates.length;
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
