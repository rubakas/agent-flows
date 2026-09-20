import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { validateCanonOutput } from "./validateOutput.js";

/**
 * A declared `schema:` was prompt text and nothing else until this gate existed:
 * a verdict of "MAYBE", a severity of "moderate" or a missing `severityRationale`
 * all passed. These tests are what fails when the validation stops validating.
 */

function finding(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    claim: "MAX_PERSISTED_CHARS is pinned to its own constant",
    file: "src/evals/persistRun.ts",
    line: 16,
    quote: "const MAX_PERSISTED_CHARS = 2048;",
    verdict: "CONFIRMED",
    citationAccurate: true,
    scope: "introduced",
    kind: "defect",
    severity: "major",
    severityRationale: "kept at major: the test cannot fail under the neutering edit",
    probes: {
      guard: "none",
      reachability: "reached by every persisted run",
      remedy: "assert a literal 2048",
      callers: "persistRun only",
      scope: "introduced by this diff",
    },
    correctedWording: "The added test builds its expectation from the constant it pins.",
    ...overrides,
  };
}

describe("validateCanonOutput — codeReviewFindings", () => {
  it("accepts a fully schema-valid payload", () => {
    assert.equal(
      validateCanonOutput("codeReviewFindings", { codeReviewFindings: [finding()] }),
      undefined
    );
  });

  it("rejects a severity outside the enum and names the constraint", () => {
    const report = validateCanonOutput("codeReviewFindings", {
      codeReviewFindings: [finding({ severity: "moderate" })],
    });
    assert.ok(report !== undefined, 'severity "moderate" must be rejected');
    assert.match(report, /codeReviewFindings\.0\.severity/);
    assert.match(report, /must be one of blocking, major, minor/);
    assert.match(report, /"moderate"/);
  });

  it("rejects a finding with no severityRationale", () => {
    const { severityRationale: _dropped, ...withoutRationale } = finding();
    const report = validateCanonOutput("codeReviewFindings", {
      codeReviewFindings: [withoutRationale],
    });
    assert.ok(report !== undefined, "a missing severityRationale must be rejected");
    assert.match(report, /missing required field "severityRationale"/);
  });

  it("rejects a verdict outside the enum", () => {
    const report = validateCanonOutput("codeReviewFindings", {
      codeReviewFindings: [finding({ verdict: "MAYBE" })],
    });
    assert.ok(report !== undefined, 'verdict "MAYBE" must be rejected');
    assert.match(report, /must be one of CONFIRMED, PARTIAL, DECLINED/);
  });

  it("rejects an undeclared extra field (additionalProperties: false)", () => {
    const report = validateCanonOutput("codeReviewFindings", {
      codeReviewFindings: [finding({ confidence: 0.9 })],
    });
    assert.ok(report !== undefined, "an extra field must be rejected");
    assert.match(report, /unexpected field "confidence"/);
  });
});

describe("validateCanonOutput — weaknesses and securityFindings", () => {
  it("accepts the canonical shapes", () => {
    assert.equal(
      validateCanonOutput("weaknesses", {
        weaknesses: [{ text: "Ambiguous", severity: "medium", blocking: false }],
      }),
      undefined
    );
    assert.equal(
      validateCanonOutput("securityFindings", {
        securityFindings: [{ text: "No auth", severity: "high", blocking: true }],
      }),
      undefined
    );
  });

  it("rejects a severity the FINDING enum does not list", () => {
    const report = validateCanonOutput("weaknesses", {
      weaknesses: [{ text: "Ambiguous", severity: "moderate", blocking: false }],
    });
    assert.ok(report !== undefined, 'severity "moderate" must be rejected');
    assert.match(report, /must be one of low, medium, high, critical/);
  });
});

describe("validateCanonOutput — reporting limits", () => {
  it("passes through a schema key the canon does not declare", () => {
    assert.equal(validateCanonOutput("findings", { findings: [] }), undefined);
  });

  it("caps a pathological violation list", () => {
    const report = validateCanonOutput("codeReviewFindings", {
      codeReviewFindings: Array.from({ length: 50 }, () => ({})),
    });
    assert.ok(report !== undefined, "50 empty findings must be rejected");
    assert.ok(report.length <= 700, `report must stay bounded, got ${String(report.length)}`);
    assert.match(report, /\(\+\d+ more\)/);
  });
});
