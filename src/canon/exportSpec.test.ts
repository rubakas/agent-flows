import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { renderSpecKitSpec, slugifyTitle, writeSpecKitSpec } from "./exportSpec.js";
import type { HardenedSpec } from "./types.js";

const baseSpec: HardenedSpec = {
  title: "Auth Service",
  description: "An auth service feature.",
  requirements: ["validate email addresses", "persist user sessions"],
  acceptanceCriteria: ["AC 1 text", "AC 2 text"],
  weaknesses: [{ text: "Ambiguous requirement", severity: "medium", blocking: false }],
  securityFindings: [{ text: "No auth check", severity: "high", blocking: true }],
};

describe("renderSpecKitSpec — mandatory sections", () => {
  it("produces the mandatory h1 header with feature name", () => {
    const md = renderSpecKitSpec(baseSpec, { branch: "001-auth", created: "2026-01-01" });
    assert.ok(md.includes("# Feature Specification: Auth Service"), "missing h1 header");
  });

  it("includes Feature Branch, Created, Status, Input fields", () => {
    const md = renderSpecKitSpec(baseSpec, {
      branch: "001-auth-service",
      created: "2026-01-01",
      status: "Draft",
      input: "Build auth",
    });
    assert.ok(md.includes("**Feature Branch**: `001-auth-service`"), "missing feature branch");
    assert.ok(md.includes("**Created**: 2026-01-01"), "missing created date");
    assert.ok(md.includes("**Status**: Draft"), "missing status");
    assert.ok(md.includes('**Input**: User description: "Build auth"'), "missing input field");
  });

  it("includes User Scenarios & Testing section", () => {
    const md = renderSpecKitSpec(baseSpec);
    assert.ok(md.includes("## User Scenarios & Testing"), "missing user scenarios section");
  });

  it("includes Requirements section", () => {
    const md = renderSpecKitSpec(baseSpec);
    assert.ok(md.includes("## Requirements"), "missing requirements section");
  });

  it("includes Success Criteria section", () => {
    const md = renderSpecKitSpec(baseSpec);
    assert.ok(md.includes("## Success Criteria"), "missing success criteria section");
  });

  it("includes Assumptions section", () => {
    const md = renderSpecKitSpec(baseSpec);
    assert.ok(md.includes("## Assumptions"), "missing assumptions section");
  });
});

describe("renderSpecKitSpec — single user story, all ACs as numbered scenarios", () => {
  it("renders exactly one user story heading regardless of how many ACs are present", () => {
    const md = renderSpecKitSpec(baseSpec);
    assert.ok(md.includes("### User Story 1"), "must have user story 1");
    assert.ok(!md.includes("### User Story 2"), "must NOT have a user story 2 — one story only");
  });

  it("places every acceptance criterion as a separate numbered scenario", () => {
    const md = renderSpecKitSpec(baseSpec);
    assert.ok(md.includes("1. **Given**"), "first AC must appear as scenario 1");
    assert.ok(md.includes("2. **Given**"), "second AC must appear as scenario 2");
  });

  it("includes Given / When / Then keywords in acceptance scenarios", () => {
    const md = renderSpecKitSpec(baseSpec);
    assert.ok(md.includes("**Given**"), "missing Given keyword");
    assert.ok(md.includes("**When**"), "missing When keyword");
    assert.ok(md.includes("**Then**"), "missing Then keyword");
  });

  it("parses Given/When/Then from AC text when the pattern is present", () => {
    const spec: HardenedSpec = {
      ...baseSpec,
      acceptanceCriteria: [
        "Given a logged-in user, When they click logout, Then the session is cleared",
      ],
    };
    const md = renderSpecKitSpec(spec);
    assert.ok(md.includes("**Given** a logged-in user"), "Given not parsed from AC text");
    assert.ok(md.includes("**When** they click logout"), "When not parsed from AC text");
    assert.ok(md.includes("**Then** the session is cleared"), "Then not parsed from AC text");
  });

  it("wraps Given and When in NEEDS CLARIFICATION when AC has no GWT structure", () => {
    const spec: HardenedSpec = { ...baseSpec, acceptanceCriteria: ["plain text criterion"] };
    const md = renderSpecKitSpec(spec);
    const givenMatch = /\*\*Given\*\* (.+?),/.exec(md);
    assert.ok(givenMatch, "Given clause missing");
    assert.ok(
      givenMatch[1].includes("NEEDS CLARIFICATION"),
      "Given should carry NEEDS CLARIFICATION when no GWT structure in AC"
    );
  });

  it("user story narrative, priority, why, and independent test are NEEDS CLARIFICATION", () => {
    const md = renderSpecKitSpec(baseSpec);
    // The story heading itself should carry the marker for narrative and priority
    assert.ok(
      md.includes("[NEEDS CLARIFICATION: user story narrative not specified]"),
      "story heading must have NEEDS CLARIFICATION for narrative"
    );
    assert.ok(
      md.includes("[NEEDS CLARIFICATION: priority not assessed]"),
      "story heading must have NEEDS CLARIFICATION for priority"
    );
    assert.ok(
      md.includes("[NEEDS CLARIFICATION: priority rationale not available in input]"),
      "Why this priority must be NEEDS CLARIFICATION"
    );
    assert.ok(
      md.includes("[NEEDS CLARIFICATION: independent test not specified in input]"),
      "Independent Test must be NEEDS CLARIFICATION"
    );
  });

  it("emits an Edge Cases subsection", () => {
    const md = renderSpecKitSpec(baseSpec);
    assert.ok(md.includes("### Edge Cases"), "missing edge cases subsection");
  });

  it("puts non-blocking weaknesses in Edge Cases", () => {
    const md = renderSpecKitSpec(baseSpec);
    const edgeIdx = md.indexOf("### Edge Cases");
    assert.ok(edgeIdx !== -1, "edge cases section missing");
    const afterEdge = md.slice(edgeIdx);
    assert.ok(
      afterEdge.includes("Ambiguous requirement"),
      "non-blocking weakness should appear in Edge Cases"
    );
  });

  it("emits NEEDS CLARIFICATION in scenarios when acceptanceCriteria is empty", () => {
    const spec: HardenedSpec = { ...baseSpec, acceptanceCriteria: [] };
    const md = renderSpecKitSpec(spec);
    assert.ok(md.includes("## User Scenarios & Testing"), "section heading must be present");
    assert.ok(md.includes("### User Story 1"), "user story heading must still appear");
    assert.ok(md.includes("[NEEDS CLARIFICATION"), "should emit NEEDS CLARIFICATION when no ACs");
  });

  it("emits NEEDS CLARIFICATION in scenarios when acceptanceCriteria is undefined", () => {
    const spec: HardenedSpec = { ...baseSpec, acceptanceCriteria: undefined };
    const md = renderSpecKitSpec(spec);
    assert.ok(
      md.includes("[NEEDS CLARIFICATION"),
      "should emit NEEDS CLARIFICATION when ACs are undefined"
    );
  });
});

describe("renderSpecKitSpec — FR requirement text formatting", () => {
  it("prepends System MUST to a bare lowercase verb phrase", () => {
    const spec: HardenedSpec = {
      ...baseSpec,
      requirements: ["validate email addresses"],
      securityFindings: [],
    };
    const md = renderSpecKitSpec(spec);
    assert.ok(
      md.includes("System MUST validate email addresses"),
      "bare lowercase phrase must get System MUST prefix"
    );
  });

  it("prepends System MUST to a capitalised bare phrase and lowercases the first letter", () => {
    const spec: HardenedSpec = {
      ...baseSpec,
      requirements: ["Validate email addresses"],
      securityFindings: [],
    };
    const md = renderSpecKitSpec(spec);
    assert.ok(
      md.includes("System MUST validate email addresses"),
      "capitalised bare phrase must get prefix with first letter lowercased"
    );
    assert.ok(
      !md.includes("System MUST Validate"),
      "must not emit System MUST Validate with capital V"
    );
  });

  it("does not lowercase an all-caps acronym at the start of a bare phrase", () => {
    const spec: HardenedSpec = {
      ...baseSpec,
      requirements: ["API responses are paginated"],
      securityFindings: [],
    };
    const md = renderSpecKitSpec(spec);
    assert.ok(
      md.includes("System MUST API responses are paginated"),
      "all-caps acronym must survive untouched"
    );
    assert.ok(
      !md.includes("System MUST aPI"),
      "must not lowercase a letter that is part of an acronym"
    );
  });

  it("renders a full clause with its own subject verbatim, without System MUST prefix", () => {
    const spec: HardenedSpec = {
      ...baseSpec,
      requirements: ["every change starts from a committed spec"],
      securityFindings: [],
    };
    const md = renderSpecKitSpec(spec);
    assert.ok(
      md.includes("every change starts from a committed spec"),
      "full clause must appear verbatim"
    );
    assert.ok(
      !md.includes("System MUST every change"),
      "must not prepend System MUST to a clause that already has a subject"
    );
  });

  it("does not double-prefix a requirement already starting with System MUST", () => {
    const spec: HardenedSpec = {
      ...baseSpec,
      requirements: ["System MUST log all security events"],
      securityFindings: [],
    };
    const md = renderSpecKitSpec(spec);
    assert.ok(
      md.includes("System MUST log all security events"),
      "existing System MUST must be preserved"
    );
    assert.ok(!md.includes("System MUST System MUST"), "must not double-prefix");
  });

  it("renders verbatim a requirement that already contains a modal verb", () => {
    const spec: HardenedSpec = {
      ...baseSpec,
      requirements: ["users must be able to reset their password"],
      securityFindings: [],
    };
    const md = renderSpecKitSpec(spec);
    assert.ok(
      md.includes("users must be able to reset their password"),
      "requirement with modal must be rendered verbatim"
    );
    assert.ok(!md.includes("System MUST users"), "must not prepend when modal already present");
  });

  it("formats FR ids as FR-NNN sequential zero-padded, starting at FR-001", () => {
    const md = renderSpecKitSpec(baseSpec);
    assert.ok(md.includes("**FR-001**"), "missing FR-001");
    assert.ok(md.includes("**FR-002**"), "missing FR-002");
    assert.ok(!md.includes("**FR-000**"), "FR-000 must not exist");
    assert.match(md, /\*\*FR-\d{3}\*\*/, "FR ids must be three-digit zero-padded");
  });

  it("blocking security findings get their own FR after the requirements FRs", () => {
    const md = renderSpecKitSpec(baseSpec);
    // baseSpec: 2 requirements → FR-001, FR-002; 1 blocking finding → FR-003
    assert.ok(md.includes("**FR-003**"), "FR-003 expected for blocking security finding");
    const fr3Idx = md.indexOf("**FR-003**");
    assert.ok(
      md.slice(fr3Idx).includes("No auth check"),
      "blocking security finding text should appear in FR-003"
    );
  });

  it("blocking security findings appear in Requirements, non-blocking do not", () => {
    const md = renderSpecKitSpec(baseSpec);
    const reqIdx = md.indexOf("## Requirements");
    assert.ok(reqIdx !== -1, "Requirements section missing");
    const afterReq = md.slice(reqIdx);
    assert.ok(afterReq.includes("No auth check"), "blocking finding must appear in Requirements");
    // Non-blocking weakness must NOT appear in Requirements section
    const successIdx = md.indexOf("## Success Criteria");
    const reqSection = md.slice(reqIdx, successIdx);
    assert.ok(
      !reqSection.includes("Ambiguous requirement"),
      "non-blocking weakness must not appear in Requirements"
    );
  });
});

describe("renderSpecKitSpec — SC ids and NEEDS CLARIFICATION", () => {
  it("SC ids are correctly formatted with zero-padded three-digit numbers", () => {
    const md = renderSpecKitSpec(baseSpec);
    assert.match(md, /\*\*SC-\d{3}\*\*/, "SC ids must be three-digit zero-padded");
    assert.ok(!md.includes("**SC-000**"), "SC-000 must not exist");
  });

  it("emits NEEDS CLARIFICATION for SC-001 because HardenedSpec carries no success criteria", () => {
    const md = renderSpecKitSpec(baseSpec);
    assert.ok(/SC-001.*NEEDS CLARIFICATION/s.exec(md), "SC-001 must carry NEEDS CLARIFICATION");
  });

  it("emits NEEDS CLARIFICATION for branch when meta.branch is absent", () => {
    const md = renderSpecKitSpec(baseSpec, {});
    assert.ok(
      md.includes("[NEEDS CLARIFICATION: feature branch not specified]"),
      "missing branch NEEDS CLARIFICATION"
    );
  });

  it("uses provided branch without NEEDS CLARIFICATION", () => {
    const md = renderSpecKitSpec(baseSpec, { branch: "013-export-spec" });
    assert.ok(md.includes("`013-export-spec`"), "provided branch should appear verbatim");
    assert.ok(
      !md.includes("[NEEDS CLARIFICATION: feature branch not specified]"),
      "NEEDS CLARIFICATION should not appear when branch is provided"
    );
  });
});

// The Input line is the only slot in the rendered spec that can carry the spec's own
// prose. `meta.input` is the original request text and wins when present; when it is
// absent the spec's `description` — a required field of HardenedSpec — is the next best
// record of what was asked for. It was silently dropped before 2026-09-21: every caller
// that renders a HardenedSpec without meta (src/serve/artifactInputs.ts) produced a
// NEEDS CLARIFICATION where the description should have been.
describe("renderSpecKitSpec — Input falls back to the spec description", () => {
  it("renders spec.description as the Input when meta.input is absent", () => {
    const md = renderSpecKitSpec(baseSpec, {});
    assert.ok(
      md.includes('**Input**: User description: "An auth service feature."'),
      "the spec's own description must be rendered as the Input"
    );
    assert.ok(
      !md.includes("[NEEDS CLARIFICATION: original input not recorded]"),
      "NEEDS CLARIFICATION must not appear when the spec carries a description"
    );
  });

  it("meta.input still wins over spec.description when both are present", () => {
    const md = renderSpecKitSpec(baseSpec, { input: "Build auth" });
    assert.ok(
      md.includes('**Input**: User description: "Build auth"'),
      "meta.input must take precedence over the spec description"
    );
    assert.ok(
      !md.includes("An auth service feature."),
      "the description must not also appear when meta.input is given"
    );
  });

  it("emits NEEDS CLARIFICATION when neither meta.input nor a description is present", () => {
    const md = renderSpecKitSpec({ ...baseSpec, description: "" }, {});
    assert.ok(
      md.includes("[NEEDS CLARIFICATION: original input not recorded]"),
      "the placeholder path must survive for a spec that genuinely records no input"
    );
  });
});

describe("writeSpecKitSpec", () => {
  it("creates a title-named directory under the parent and writes spec.md into it", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "agent-flows-exportspec-"));
    try {
      const parentDir = join(tmp, "specs");
      const path = await writeSpecKitSpec(baseSpec, { branch: "001-test" }, parentDir);
      assert.equal(
        path,
        join(parentDir, "auth-service", "spec.md"),
        "returned path must be parentDir/<title-slug>/spec.md"
      );
      const contents = await readFile(path, "utf8");
      assert.ok(
        contents.includes("# Feature Specification: Auth Service"),
        "written file should contain rendered spec"
      );
    } finally {
      await rm(tmp, { recursive: true });
    }
  });

  it("creates nested directories that do not yet exist", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "agent-flows-exportspec-"));
    try {
      const parentDir = join(tmp, "nested", "deep", "dir");
      const path = await writeSpecKitSpec(baseSpec, {}, parentDir);
      assert.equal(path, join(parentDir, "auth-service", "spec.md"));
      const contents = await readFile(path, "utf8");
      assert.ok(contents.length > 0, "written file must not be empty");
    } finally {
      await rm(tmp, { recursive: true });
    }
  });

  // The data-loss regression: two specs exported into the same parent used to
  // land on the same fixed path, so the second silently destroyed the first.
  it("two different titles land in different directories and both survive", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "agent-flows-exportspec-"));
    try {
      const parentDir = join(tmp, "specs");
      const first = await writeSpecKitSpec({ ...baseSpec, title: "Auth Service" }, {}, parentDir);
      const second = await writeSpecKitSpec(
        { ...baseSpec, title: "Billing Export" },
        {},
        parentDir
      );

      assert.notEqual(first, second, "different titles must not share a path");
      assert.equal(first, join(parentDir, "auth-service", "spec.md"));
      assert.equal(second, join(parentDir, "billing-export", "spec.md"));
      assert.ok(
        (await readFile(first, "utf8")).includes("# Feature Specification: Auth Service"),
        "the first spec must still be on disk after the second export"
      );
      assert.ok(
        (await readFile(second, "utf8")).includes("# Feature Specification: Billing Export")
      );
    } finally {
      await rm(tmp, { recursive: true });
    }
  });

  it("a repeated title gets a numeric suffix and never clobbers the earlier spec", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "agent-flows-exportspec-"));
    try {
      const parentDir = join(tmp, "specs");
      const first = await writeSpecKitSpec(baseSpec, { input: "first run" }, parentDir);
      const second = await writeSpecKitSpec(baseSpec, { input: "second run" }, parentDir);
      const third = await writeSpecKitSpec(baseSpec, { input: "third run" }, parentDir);

      assert.equal(first, join(parentDir, "auth-service", "spec.md"));
      assert.equal(second, join(parentDir, "auth-service-2", "spec.md"));
      assert.equal(third, join(parentDir, "auth-service-3", "spec.md"));
      assert.ok(
        (await readFile(first, "utf8")).includes('"first run"'),
        "the first spec's content must be untouched by the later exports"
      );
      assert.ok((await readFile(second, "utf8")).includes('"second run"'));
    } finally {
      await rm(tmp, { recursive: true });
    }
  });

  it("an empty title falls back to a runId-derived directory that does not collide", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "agent-flows-exportspec-"));
    try {
      const parentDir = join(tmp, "specs");
      const untitled = { ...baseSpec, title: "" };
      const first = await writeSpecKitSpec(untitled, {}, parentDir, "run-AAA");
      const second = await writeSpecKitSpec(untitled, {}, parentDir, "run-BBB");

      assert.equal(first, join(parentDir, "spec-run-aaa", "spec.md"));
      assert.equal(second, join(parentDir, "spec-run-bbb", "spec.md"));
      assert.ok((await readFile(first, "utf8")).length > 0, "the first untitled spec must survive");
    } finally {
      await rm(tmp, { recursive: true });
    }
  });

  it("an untitled spec with no runId falls back to a content hash, not a shared path", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "agent-flows-exportspec-"));
    try {
      const parentDir = join(tmp, "specs");
      const first = await writeSpecKitSpec({ ...baseSpec, title: "" }, { input: "a" }, parentDir);
      const second = await writeSpecKitSpec({ ...baseSpec, title: "" }, { input: "b" }, parentDir);

      assert.notEqual(first, second, "two untitled specs must not share a directory");
      assert.match(dirname(first), /\/spec-[0-9a-f]{12}$/);
      assert.ok((await readFile(first, "utf8")).includes('"a"'));
      assert.ok((await readFile(second, "utf8")).includes('"b"'));
    } finally {
      await rm(tmp, { recursive: true });
    }
  });
});

describe("slugifyTitle", () => {
  it("lowercases and joins words with single hyphens", () => {
    assert.equal(slugifyTitle("Item Error Recovery"), "item-error-recovery");
  });

  it("collapses punctuation runs into one hyphen", () => {
    assert.equal(
      slugifyTitle("Feature Flags, Smart Defaults & More!!"),
      "feature-flags-smart-defaults-more"
    );
  });

  it("trims leading and trailing junk", () => {
    assert.equal(slugifyTitle("  ---Auth Service--- "), "auth-service");
  });

  it("drops non-latin characters rather than emitting them raw", () => {
    assert.equal(slugifyTitle("Спецификация v2"), "v2");
  });

  it("caps the length and never ends on a hyphen", () => {
    const slug = slugifyTitle("a ".repeat(80));
    assert.ok(slug.length <= 60, `slug must be capped; got ${slug.length}`);
    assert.doesNotMatch(slug, /-$/, "a truncated slug must not end on a hyphen");
  });

  it("returns an empty string for a title that has nothing sluggable", () => {
    assert.equal(slugifyTitle("— ✦ —"), "");
    assert.equal(slugifyTitle(""), "");
  });
});
