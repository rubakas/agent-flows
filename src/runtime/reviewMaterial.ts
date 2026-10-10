// The repository material a review pipeline is given, captured by the daemon.
//
// A review step holds `contents: read` — Read, Glob and Grep, never Bash (see
// StepDef.permissions in canon/types.ts). That is deliberate: a reviewer must
// not be able to run commands in the tree it is judging. The capture itself —
// every git argv, the credential policy, the spec-source fetching — lives in
// reviewCapture.ts, which the review plugin also runs. This module is the
// daemon's side of it: where the artefacts are written, how a spec source that
// is not a GitHub reference is passed through, and the structured result the
// review step carries.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  GitTimeoutError,
  REVIEW_MATERIAL_CAP,
  cap,
  captureGit,
  digestBodies,
  ghRunnerFor,
  isGithubRefList,
  rejectBaseline,
  renderMaterial,
  renderSpecSection,
  resolveSpecRefs,
} from "./reviewCapture.js";
import type {
  BaselineRule,
  GhOutcome,
  GhRunner,
  ReviewArtefact,
  SpecSourceResolution,
} from "./reviewCapture.js";

export { REVIEW_MATERIAL_CAP, rejectBaseline };
export type { BaselineRule, GhOutcome, GhRunner, ReviewArtefact, SpecSourceResolution };

const ARTEFACT_FILES: Record<ReviewArtefact, string> = {
  diff: "diff.txt",
  commits: "commits.txt",
  changedFiles: "changed-files.txt",
  history: "history.txt",
};

/** The resolved spec sources, written in full beside the git artefacts. */
const SPEC_SOURCES_FILE = "spec-sources.txt";

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

/**
 * Resolves the caller's `specSources` into the text the delivery reviewer is
 * judged against.
 *
 * A value is a reference list only when EVERY whitespace- or comma-separated
 * token in it is trying to be a reference. One ordinary word and the whole
 * value is literal text, passed through byte for byte — that is what keeps a
 * pasted ticket body, and the word `none`, working exactly as before.
 *
 * Never throws on `gh`: missing, unauthenticated or failing is recorded as a
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

  if (!isGithubRefList(specSources)) {
    return {
      literal: true,
      text: cap(specSources).text,
      full: specSources,
      notes: ["passed through unchanged: it names no GitHub pull request or issue"],
    };
  }

  return resolveSpecRefs(projectDir, specSources, gh, { used: 0 });
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

/** What a git timeout leaves: nothing was resolved, and the reason says why. */
function timedOutMaterial(reason: string): ReviewMaterialUnavailable {
  return {
    available: false,
    reason,
    specSourcesResolved: false,
    specSourcesReason: "git timed out before the spec sources were resolved",
  };
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
 * Never throws: a git timeout anywhere, spec resolution included, is converted
 * here into an unavailable capture.
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
  try {
    return captureReviewMaterial(projectDir, baseline, introducedCommits, outDir, options);
  } catch (err) {
    if (!(err instanceof GitTimeoutError)) throw err;
    return timedOutMaterial(err.message);
  }
}

function captureReviewMaterial(
  projectDir: string,
  baseline: unknown,
  introducedCommits: readonly string[] | undefined,
  outDir: string,
  options: { specSources?: unknown; gh?: GhRunner }
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

  const capture = captureGit({ projectDir, baseline, extraCommits: introducedCommits });
  if (!capture.available) {
    if (capture.timedOut === true) return timedOutMaterial(capture.reason);
    return { available: false, reason: capture.reason, ...specFields };
  }

  const paths: Partial<Record<ReviewArtefact, string>> = {};
  for (const name of Object.keys(capture.bodies) as ReviewArtefact[]) {
    const written = writeArtefact(outDir, ARTEFACT_FILES[name], capture.bodies[name]);
    if (written !== undefined) paths[name] = written;
  }
  const { digest, truncated } = digestBodies(capture.bodies);

  return {
    available: true,
    paths,
    digest,
    truncated,
    baseline: capture.baseline,
    baselineRule: capture.baselineRule,
    withheld: capture.withheld,
    ...specFields,
  };
}

/**
 * The `## spec sources` section, or nothing when the caller named none.
 *
 * Returned as an array so the caller can splice it into either branch of
 * `renderReviewMaterial` without a conditional at each site.
 */
function specSourcesSections(spec: SpecSourceResolution | undefined): string[] {
  if (spec === undefined) return [];
  const label = spec.literal
    ? "literal text — no GitHub reference named"
    : `fetched by the daemon${spec.path === undefined ? "" : ` — full: ${spec.path}`}`;
  const section = renderSpecSection(spec, label);
  return section === undefined ? [] : [section];
}

/**
 * The capture as the plain text a prompt renders it into (see renderMaterial for
 * why it must be a string).
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
  return renderMaterial(material, specSourcesSections(material.specSources));
}
