import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { HardenedSpec } from "./types.js";

export interface SpecMeta {
  branch?: string;
  created?: string;
  status?: string;
  input?: string;
}

function NC(reason: string): string {
  return `[NEEDS CLARIFICATION: ${reason}]`;
}

// Lowercase the first character of a requirement only when it is a plain Title Case
// word (second char is lowercase). All-caps tokens ("API", "RFC") and lone capital
// initials are left untouched so prepending "System MUST" stays grammatical.
function lowercaseFirst(r: string): string {
  if (r.length >= 2 && /^[A-Z][a-z]/.test(r)) return r[0].toLowerCase() + r.slice(1);
  return r;
}

// Format a requirement string for FR rendering.
// Prepend "System MUST" for bare capability phrases; render verbatim when the text
// already carries its own obligation signal or subject noun phrase. Capitalisation
// alone is not a reliable signal — an LLM step capitalising the first word of a
// capability phrase is as likely as it writing a subject clause — so it is ignored.
function formatRequirement(r: string): string {
  // Already begins with "System MUST" → keep as-is to avoid double-prefix
  if (/^[Ss]ystem\s+[Mm][Uu][Ss][Tt]/i.test(r)) return r;
  // Contains a modal verb → already structured as an obligation → verbatim
  if (/\b(must|should|shall|may|will|can)\b/i.test(r)) return r;
  // Starts with a determiner → subject noun phrase present → verbatim
  if (
    /^(?:every|all|some|any|each|the|an?|this|that|these|those|no|its|their|our|my|your|his|her)\s+/i.test(
      r
    )
  )
    return r;
  // Everything else is a bare capability phrase → prepend, lowercasing the first
  // character when it is a plain Title Case word (not an acronym or all-caps token).
  return `System MUST ${lowercaseFirst(r)}`;
}

function parseGivenWhenThen(text: string): { given: string; when: string; then: string } | null {
  const m = /given\s+(.+?),?\s+when\s+(.+?),?\s+then\s+(.+)/i.exec(text);
  if (!m) return null;
  return { given: m[1].trim(), when: m[2].trim(), then: m[3].trim() };
}

function renderUserStories(spec: HardenedSpec): string {
  const acs = spec.acceptanceCriteria ?? [];
  const parts: string[] = [];

  parts.push("## User Scenarios & Testing *(mandatory)*");
  parts.push("");
  // One user story whose narrative, priority, rationale and independent test are all
  // NEEDS CLARIFICATION — the hardened spec carries none of them. All acceptance
  // criteria are listed as numbered Given/When/Then scenarios beneath it.
  parts.push(
    `### User Story 1 - ${NC("user story narrative not specified")} (Priority: ${NC("priority not assessed")})`
  );
  parts.push("");
  parts.push(NC("describe the user journey this feature enables"));
  parts.push("");
  parts.push(`**Why this priority**: ${NC("priority rationale not available in input")}`);
  parts.push("");
  parts.push(`**Independent Test**: ${NC("independent test not specified in input")}`);
  parts.push("");
  parts.push("**Acceptance Scenarios**:");
  parts.push("");

  if (acs.length === 0) {
    parts.push(
      `1. **Given** ${NC("initial state not specified")}, **When** ${NC("triggering action not specified")}, **Then** ${NC("expected outcome not specified")}`
    );
  } else {
    acs.forEach((ac, i) => {
      const gwt = parseGivenWhenThen(ac);
      if (gwt) {
        parts.push(`${i + 1}. **Given** ${gwt.given}, **When** ${gwt.when}, **Then** ${gwt.then}`);
      } else {
        parts.push(
          `${i + 1}. **Given** ${NC("initial state not specified")}, **When** ${NC("triggering action not specified")}, **Then** ${ac}`
        );
      }
    });
  }

  parts.push("");
  parts.push("### Edge Cases");
  parts.push("");

  const edgeCases = [
    ...(spec.weaknesses ?? []),
    ...(spec.securityFindings ?? []).filter((f) => !f.blocking),
  ];

  if (edgeCases.length === 0) {
    parts.push(`- ${NC("no edge cases or weaknesses identified in input")}`);
  } else {
    for (const f of edgeCases) {
      const sev = f.severity ? ` (${f.severity})` : "";
      parts.push(`- ${f.text}${sev}`);
    }
  }

  return parts.join("\n");
}

function renderRequirements(spec: HardenedSpec): string {
  const parts: string[] = [];
  parts.push("## Requirements *(mandatory)*");
  parts.push("");
  parts.push("### Functional Requirements");
  parts.push("");

  const reqs = spec.requirements ?? [];
  const blockingFindings = (spec.securityFindings ?? []).filter((f) => f.blocking);

  let frIdx = 1;
  const nextId = (): string => `FR-${String(frIdx++).padStart(3, "0")}`;

  if (reqs.length === 0 && blockingFindings.length === 0) {
    parts.push(`- **${nextId()}**: System MUST ${NC("no functional requirements specified")}`);
  } else {
    for (const r of reqs) {
      parts.push(`- **${nextId()}**: ${formatRequirement(r)}`);
    }
    for (const f of blockingFindings) {
      const sev = f.severity ? ` [severity: ${f.severity}]` : "";
      parts.push(
        `- **${nextId()}**: System MUST address blocking security finding: ${f.text}${sev}`
      );
    }
  }

  return parts.join("\n");
}

function renderSuccessCriteria(): string {
  const parts: string[] = [];
  parts.push("## Success Criteria *(mandatory)*");
  parts.push("");
  parts.push("### Measurable Outcomes");
  parts.push("");
  parts.push(
    `- **SC-001**: ${NC("no measurable success criteria provided — define specific, technology-agnostic outcomes")}`
  );
  return parts.join("\n");
}

function renderAssumptions(): string {
  const parts: string[] = [];
  parts.push("## Assumptions");
  parts.push("");
  parts.push(
    `- ${NC("no assumptions recorded — review input and add any baseline conditions, scope boundaries, or environmental dependencies")}`
  );
  return parts.join("\n");
}

export function renderSpecKitSpec(spec: HardenedSpec, meta: SpecMeta = {}): string {
  const branchLine = meta.branch
    ? `**Feature Branch**: \`${meta.branch}\``
    : `**Feature Branch**: ${NC("feature branch not specified")}`;
  const created = meta.created ?? new Date().toISOString().slice(0, 10);
  const status = meta.status ?? "Draft";
  // meta.input is the original request text and wins when the caller has it. When it does
  // not — every caller that renders a bare HardenedSpec — the spec's own description is the
  // next best record of what was asked for; only a spec with neither gets the placeholder.
  const input = meta.input ?? (spec.description || NC("original input not recorded"));

  const header = [
    `# Feature Specification: ${spec.title}`,
    "",
    branchLine,
    "",
    `**Created**: ${created}`,
    "",
    `**Status**: ${status}`,
    "",
    `**Input**: User description: "${input}"`,
  ].join("\n");

  return [
    header,
    "",
    renderUserStories(spec),
    "",
    renderRequirements(spec),
    "",
    renderSuccessCriteria(),
    "",
    renderAssumptions(),
    "",
  ].join("\n");
}

// A directory name long enough to stay readable, short enough to survive path
// limits when nested under a deep project path.
const MAX_SLUG_LENGTH = 60;

// Turn a spec title into a directory name: lowercase, every run of
// non-alphanumerics collapsed to a single "-", no leading/trailing "-".
// Unicode letters are not transliterated — they are non-[a-z0-9] and become
// separators, so a fully non-latin title slugs to "" and the caller falls back.
export function slugifyTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/g, "");
}

// A spec whose title is missing or slugs to nothing still needs its own
// directory: a shared constant here would reintroduce the overwrite bug for
// every untitled spec. The runId is unique per run; without one, the rendered
// body is hashed so the name is at least deterministic for identical content.
function fallbackSlug(body: string, runId: string | undefined): string {
  if (runId) return `spec-${slugifyTitle(runId)}`;
  return `spec-${createHash("sha256").update(body).digest("hex").slice(0, 12)}`;
}

// Bounded so a broken caller cannot spin creating directories forever.
const MAX_DIR_SUFFIX = 100;

/**
 * Write the Spec Kit `spec.md` into its own directory under `parentDir`, named
 * after the spec title.
 *
 * Never overwrites: the file is opened with "wx", and an existing `spec.md`
 * pushes the write to `<slug>-2`, `<slug>-3`, … We cannot tell "the same spec,
 * re-run" from "a different spec that happens to share a title", and a loud
 * failure here would discard work the human has already approved at the gate —
 * so the non-destructive suffix wins and the human reconciles the duplicates.
 */
export async function writeSpecKitSpec(
  spec: HardenedSpec,
  meta: SpecMeta,
  parentDir: string,
  runId?: string
): Promise<string> {
  const body = renderSpecKitSpec(spec, meta);
  const slug = slugifyTitle(spec.title ?? "") || fallbackSlug(body, runId);

  for (let n = 1; n <= MAX_DIR_SUFFIX; n++) {
    const outDir = join(parentDir, n === 1 ? slug : `${slug}-${n}`);
    await mkdir(outDir, { recursive: true });
    const outPath = join(outDir, "spec.md");
    try {
      await writeFile(outPath, body, { encoding: "utf8", flag: "wx" });
      return outPath;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }

  throw new Error(
    `Cannot export spec "${spec.title}": ${MAX_DIR_SUFFIX} directories named "${slug}[-N]" already exist under ${parentDir}`
  );
}
