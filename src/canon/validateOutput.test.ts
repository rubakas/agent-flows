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
    evidenceBasis: "file-content",
    remedyScope: "single-site",
    sites: [],
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
    assert.match(report, /must be one of CONFIRMED, PARTIAL, DECLINED, UNVERIFIABLE/);
  });

  it("accepts an UNVERIFIABLE finding resting on nothing readable", () => {
    assert.equal(
      validateCanonOutput("codeReviewFindings", {
        codeReviewFindings: [
          finding({
            verdict: "UNVERIFIABLE",
            evidenceBasis: "none",
            severityRationale:
              "the worker proposed major; the deciding file is outside the workspace",
            correctedWording: "",
          }),
        ],
      }),
      undefined
    );
  });

  for (const field of ["evidenceBasis", "remedyScope", "sites"]) {
    it(`rejects a finding with no ${field}`, () => {
      const withoutField = finding();
      delete withoutField[field];
      const report = validateCanonOutput("codeReviewFindings", {
        codeReviewFindings: [withoutField],
      });
      assert.ok(report !== undefined, `a missing ${field} must be rejected`);
      assert.match(report, new RegExp(`missing required field "${field}"`));
    });
  }

  it("rejects a site entry missing remedySafe", () => {
    const report = validateCanonOutput("codeReviewFindings", {
      codeReviewFindings: [
        finding({
          remedyScope: "sites-differ",
          sites: [{ file: "src/a.ts", line: 3, remedyNote: "guard present" }],
        }),
      ],
    });
    assert.ok(report !== undefined, "an incomplete site entry must be rejected");
    assert.match(report, /missing required field "remedySafe"/);
  });

  it("rejects CONFIRMED resting on a commit message rather than the files", () => {
    const report = validateCanonOutput("codeReviewFindings", {
      codeReviewFindings: [finding({ verdict: "CONFIRMED", evidenceBasis: "commit-message" })],
    });
    assert.ok(report !== undefined, "CONFIRMED on a commit message must be rejected");
    assert.match(report, /"CONFIRMED"/);
    assert.match(report, /"commit-message"/);
  });

  it("accepts a non-file evidenceBasis under a verdict other than CONFIRMED", () => {
    assert.equal(
      validateCanonOutput("codeReviewFindings", {
        codeReviewFindings: [finding({ verdict: "PARTIAL", evidenceBasis: "identifier-name" })],
      }),
      undefined
    );
  });

  it("rejects all-sites-verified when one site is marked remedySafe: false", () => {
    const report = validateCanonOutput("codeReviewFindings", {
      codeReviewFindings: [
        finding({
          remedyScope: "all-sites-verified",
          sites: [
            { file: "src/a.ts", line: 3, remedySafe: true, remedyNote: "same guard holds" },
            { file: "src/b.ts", line: 9, remedySafe: false, remedyNote: "no guard on this path" },
          ],
        }),
      ],
    });
    assert.ok(report !== undefined, "all-sites-verified with an unsafe site must be rejected");
    assert.match(report, /"all-sites-verified"/);
    assert.match(report, /src\/b\.ts/);
  });

  it("accepts two verified sites when every entry is remedySafe", () => {
    assert.equal(
      validateCanonOutput("codeReviewFindings", {
        codeReviewFindings: [
          finding({
            remedyScope: "all-sites-verified",
            sites: [
              { file: "src/a.ts", line: 3, remedySafe: true, remedyNote: "same guard holds" },
              { file: "src/b.ts", line: 9, remedySafe: true, remedyNote: "same guard holds" },
            ],
          }),
        ],
      }),
      undefined
    );
  });

  it("rejects single-site while sites names more than one location", () => {
    const report = validateCanonOutput("codeReviewFindings", {
      codeReviewFindings: [
        finding({
          remedyScope: "single-site",
          sites: [
            { file: "src/a.ts", line: 3, remedySafe: true, remedyNote: "same guard holds" },
            { file: "src/b.ts", line: 9, remedySafe: true, remedyNote: "same guard holds" },
          ],
        }),
      ],
    });
    assert.ok(report !== undefined, "single-site across two sites must be rejected");
    assert.match(report, /"single-site"/);
    assert.match(report, /2 locations/);
    assert.match(report, /src\/a\.ts, src\/b\.ts/);
  });

  it("accepts single-site when exactly one site is named", () => {
    assert.equal(
      validateCanonOutput("codeReviewFindings", {
        codeReviewFindings: [
          finding({
            remedyScope: "single-site",
            sites: [{ file: "src/a.ts", line: 3, remedySafe: true, remedyNote: "the only site" }],
          }),
        ],
      }),
      undefined
    );
  });

  it("rejects an undeclared extra field (additionalProperties: false)", () => {
    const report = validateCanonOutput("codeReviewFindings", {
      codeReviewFindings: [finding({ confidence: 0.9 })],
    });
    assert.ok(report !== undefined, "an extra field must be rejected");
    assert.match(report, /unexpected field "confidence"/);
  });
});

function deliveryEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    requirement: "Commit a fixture, commit a manifest, or make the skip loud.",
    source: "TICKET-411",
    classification: "implemented",
    evidence: "spec/fixtures/attachments.yml:1 — the fixture the ticket named",
    ...overrides,
  };
}

function delivery(
  entries: Record<string, unknown>[],
  specSourcesProvided = true
): string | undefined {
  return validateCanonOutput("codeReviewDelivery", {
    specSourcesProvided,
    codeReviewDelivery: entries,
  });
}

describe("validateCanonOutput — codeReviewDelivery", () => {
  it("accepts a fully schema-valid payload", () => {
    assert.equal(delivery([deliveryEntry()]), undefined);
  });

  it("accepts an empty report from a run given no spec sources", () => {
    assert.equal(delivery([], false), undefined);
  });

  it("rejects a classification the enum does not list", () => {
    const report = delivery([deliveryEntry({ classification: "mostly-done" })]);
    assert.ok(report !== undefined, 'classification "mostly-done" must be rejected');
    assert.match(report, /codeReviewDelivery\.0\.classification/);
    assert.match(report, /implemented, partial, not-implemented/);
  });

  for (const field of ["requirement", "source", "classification", "evidence"] as const) {
    it(`rejects a payload missing ${field}`, () => {
      const { [field]: _omitted, ...withoutField } = deliveryEntry();
      const report = delivery([withoutField]);
      assert.ok(report !== undefined, `a payload missing ${field} must be rejected`);
      assert.match(report, new RegExp(`missing required field "${field}"`));
    });
  }

  it("rejects an undeclared extra field (additionalProperties: false)", () => {
    const report = delivery([deliveryEntry({ confidence: 0.9 })]);
    assert.ok(report !== undefined, "an extra field must be rejected");
    assert.match(report, /unexpected field "confidence"/);
  });

  it("accepts an implemented entry carrying neither decision field", () => {
    const { decisionTaken: _d, optionsForeclosed: _o, ...entry } = deliveryEntry();
    assert.equal(
      delivery([entry]),
      undefined,
      "the two decision fields mean nothing outside silently-decided and must not be required"
    );
  });

  it("rejects silently-decided with both decision fields absent", () => {
    const report = delivery([deliveryEntry({ classification: "silently-decided" })]);
    assert.ok(report !== undefined, "a silent decision naming no decision must be rejected");
    assert.match(report, /decisionTaken is ""/, "an absent decisionTaken must be reported");
    assert.match(report, /optionsForeclosed is ""/, "an absent optionsForeclosed must be reported");
  });

  it("rejects silently-decided with no decision named", () => {
    const report = delivery([
      deliveryEntry({ classification: "silently-decided", decisionTaken: "" }),
    ]);
    assert.ok(report !== undefined, "a silent decision with no decision named must be rejected");
    assert.match(report, /"silently-decided"/, "the report must name the offending classification");
    assert.match(report, /decisionTaken is ""/, "the report must name the offending value");
  });

  it("rejects silently-decided that answers the decision fields with words meaning no decision", () => {
    const report = delivery([
      deliveryEntry({
        classification: "silently-decided",
        decisionTaken: "not a decision",
        optionsForeclosed: "not a decision",
      }),
    ]);
    assert.ok(report !== undefined, '"not a decision" is not a decision named');
    assert.match(report, /optionsForeclosed is "not a decision"/);
  });

  it("accepts silently-decided once both the decision and what it foreclosed are named", () => {
    assert.equal(
      delivery([
        deliveryEntry({
          classification: "silently-decided",
          decisionTaken: "stored the basis as a fee rather than price x shares",
          optionsForeclosed: "storing it as price x shares, the reading the ticket also allowed",
        }),
      ]),
      undefined
    );
  });

  it("rejects implemented whose evidence names no file", () => {
    const report = delivery([
      deliveryEntry({ evidence: "the importer already handles this case" }),
    ]);
    assert.ok(report !== undefined, "an implemented claim with no path must be rejected");
    assert.match(report, /"implemented"/, "the report must name the offending classification");
    assert.match(report, /the importer already handles this case/);
  });

  it("rejects partial whose evidence names no file", () => {
    const report = delivery([
      deliveryEntry({ classification: "partial", evidence: "half of it is done" }),
    ]);
    assert.ok(report !== undefined, "a partial claim with no path must be rejected");
    assert.match(report, /"partial"/);
  });

  it("accepts not-implemented whose evidence names no file — absence has no path to cite", () => {
    assert.equal(
      delivery([
        deliveryEntry({
          classification: "not-implemented",
          evidence: "no code satisfies this — a repository-wide search returned nothing",
        }),
      ]),
      undefined
    );
  });

  it("rejects prose evidence whose only file-like token is an abbreviation", () => {
    const report = delivery([deliveryEntry({ evidence: "e.g. the value is derived correctly" })]);
    assert.ok(report !== undefined, '"e.g." names no file and must not satisfy the check');
    assert.match(report, /"implemented"/, "the report must name the offending classification");
    assert.match(report, /e\.g\. the value is derived correctly/);
  });

  it("accepts evidence naming a real path and line", () => {
    assert.equal(delivery([deliveryEntry({ evidence: "app/models/lot.rb:42" })]), undefined);
  });

  it("rejects correctly-deferred with no spec line quoted", () => {
    const report = delivery([
      deliveryEntry({ classification: "correctly-deferred", requirement: "   " }),
    ]);
    assert.ok(report !== undefined, "a deferral traceable to no spec line must be rejected");
    assert.match(report, /"correctly-deferred"/);
    assert.match(report, /requirement is " {3}"/);
  });

  it("rejects entries reported against no spec sources", () => {
    const report = delivery([deliveryEntry()], false);
    assert.ok(report !== undefined, "requirements with no spec source must be rejected");
    assert.match(report, /specSourcesProvided "false"/);
    assert.match(report, /1 entries/);
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
