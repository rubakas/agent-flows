import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { renderSpecKitSpec, writeSpecKitSpec } from "./exportSpec.js";
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

describe("writeSpecKitSpec", () => {
  it("creates the directory and writes spec.md, returning the absolute path", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "yoke-exportspec-"));
    try {
      const outDir = join(tmp, "my-spec");
      const path = await writeSpecKitSpec(baseSpec, { branch: "001-test" }, outDir);
      assert.equal(path, join(outDir, "spec.md"), "returned path must be outDir/spec.md");
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
    const tmp = await mkdtemp(join(tmpdir(), "yoke-exportspec-"));
    try {
      const outDir = join(tmp, "nested", "deep", "dir");
      const path = await writeSpecKitSpec(baseSpec, {}, outDir);
      assert.equal(path, join(outDir, "spec.md"), "returned path must be outDir/spec.md");
      const contents = await readFile(path, "utf8");
      assert.ok(contents.length > 0, "written file must not be empty");
    } finally {
      await rm(tmp, { recursive: true });
    }
  });
});
