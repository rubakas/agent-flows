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
  const input = meta.input ?? NC("original input not recorded");

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

export async function writeSpecKitSpec(
  spec: HardenedSpec,
  meta: SpecMeta,
  outDir: string
): Promise<string> {
  await mkdir(outDir, { recursive: true });
  const outPath = join(outDir, "spec.md");
  await writeFile(outPath, renderSpecKitSpec(spec, meta), "utf8");
  return outPath;
}
