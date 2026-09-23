import type { StepDef } from "./types.js";

export const FINDING = {
  type: "object",
  properties: {
    text: { type: "string" },
    severity: { type: "string", enum: ["low", "medium", "high", "critical"] },
    blocking: { type: "boolean" },
  },
  required: ["text", "severity", "blocking"],
  additionalProperties: false,
};

export const WEAK_SCHEMA = {
  type: "object",
  properties: { weaknesses: { type: "array", items: FINDING } },
  required: ["weaknesses"],
  additionalProperties: false,
};

export const SEC_SCHEMA = {
  type: "object",
  properties: { securityFindings: { type: "array", items: FINDING } },
  required: ["securityFindings"],
  additionalProperties: false,
};

/**
 * `evidenceBasis`, `remedyScope` and `sites` exist because prompt wording alone
 * did not change what the verify step produced: spec 040 measured the
 * prompt-only fixes and they failed. A required slot the model cannot leave
 * empty is the only instruction it has to answer.
 *
 * `evidenceBasis` exists so a finding has to admit what it rests on — a commit
 * subject or a well-chosen identifier reads like evidence and is not one.
 * `remedyScope` and `sites` exist because a remedy proven at one location was
 * being recommended for every location that looked like it; naming the sites
 * forces the difference between "checked here" and "checked everywhere" to be
 * written down rather than assumed.
 */
export const CODE_REVIEW_FINDING = {
  type: "object",
  properties: {
    claim: { type: "string" },
    file: { type: "string" },
    line: { type: ["string", "number"] },
    quote: { type: "string" },
    verdict: { type: "string", enum: ["CONFIRMED", "PARTIAL", "DECLINED", "UNVERIFIABLE"] },
    citationAccurate: { type: "boolean" },
    evidenceBasis: {
      type: "string",
      enum: [
        "file-content",
        "absence-of-file",
        "commit-message",
        "identifier-name",
        "comment",
        "none",
      ],
    },
    remedyScope: {
      type: "string",
      enum: ["single-site", "all-sites-verified", "sites-differ"],
    },
    sites: {
      type: "array",
      items: {
        type: "object",
        properties: {
          file: { type: "string" },
          line: { type: ["string", "number"] },
          remedySafe: { type: "boolean" },
          remedyNote: { type: "string" },
        },
        required: ["file", "line", "remedySafe", "remedyNote"],
        additionalProperties: false,
      },
    },
    scope: { type: "string", enum: ["introduced", "pre-existing", "undetermined"] },
    kind: { type: "string", enum: ["defect", "business-decision", "external-confirmation"] },
    severity: { type: "string", enum: ["blocking", "major", "minor"] },
    severityRationale: { type: "string" },
    probes: {
      type: "object",
      properties: {
        guard: { type: "string" },
        reachability: { type: "string" },
        remedy: { type: "string" },
        callers: { type: "string" },
        scope: { type: "string" },
      },
      required: ["guard", "reachability", "remedy", "callers", "scope"],
      additionalProperties: false,
    },
    correctedWording: { type: "string" },
  },
  required: [
    "claim",
    "file",
    "line",
    "quote",
    "verdict",
    "citationAccurate",
    "evidenceBasis",
    "remedyScope",
    "sites",
    "scope",
    "kind",
    "severity",
    "severityRationale",
    "probes",
    "correctedWording",
  ],
  additionalProperties: false,
};

export const CODE_REVIEW_SCHEMA = {
  type: "object",
  properties: { codeReviewFindings: { type: "array", items: CODE_REVIEW_FINDING } },
  required: ["codeReviewFindings"],
  additionalProperties: false,
};

/**
 * The convention for `decisionTaken` and `optionsForeclosed` on a classification
 * that took no decision. They are required on every entry — a model that may
 * omit a field omits it — so a classification with no decision behind it needs
 * a value that says so rather than an empty string that reads as an oversight.
 * `prompts/code-review-delivery.md` states the same convention to the model.
 */
export const NOT_A_DECISION = "not a decision";

/**
 * One requirement from the spec sources and what the change did with it.
 *
 * `classification` is the vocabulary `prompts/code-review-delivery.md` defines.
 * It is a schema slot rather than prose in that prompt for the reason D1 of spec
 * 044 gives: spec 040 measured two prompt-only fixes on this same pipeline and
 * neither moved the metric. As prose, `silently-decided` was indistinguishable
 * from `implemented` — both were a sentence inside a free-text claim.
 *
 * `decisionTaken` and `optionsForeclosed` are required because `silently-decided`
 * is the class this dimension exists for and it says nothing without naming which
 * decision was made and what it ruled out. Entries that took no decision carry
 * `NOT_A_DECISION` in both; `validateOutput.ts` refuses that pair on a
 * `silently-decided` entry, which is where the vocabulary becomes load-bearing.
 */
export const CODE_REVIEW_DELIVERY_ENTRY = {
  type: "object",
  properties: {
    requirement: { type: "string" },
    source: { type: "string" },
    classification: {
      type: "string",
      enum: [
        "implemented",
        "partial",
        "not-implemented",
        "replaced-by-prose",
        "silently-decided",
        "correctly-deferred",
      ],
    },
    evidence: { type: "string" },
    decisionTaken: { type: "string" },
    optionsForeclosed: { type: "string" },
  },
  required: [
    "requirement",
    "source",
    "classification",
    "evidence",
    "decisionTaken",
    "optionsForeclosed",
  ],
  additionalProperties: false,
};

/**
 * `specSourcesProvided` exists so a run given no ticket bodies is distinguishable
 * from a run that read them and found nothing: both produce an empty array, and
 * only the first means the dimension never had anything to run against. Without
 * it, "no spec sources supplied" and "every requirement delivered" are the same
 * payload — and `prompts/code-review-verify.md` must not read the first as a pass.
 */
export const CODE_REVIEW_DELIVERY_SCHEMA = {
  type: "object",
  properties: {
    specSourcesProvided: { type: "boolean" },
    codeReviewDelivery: { type: "array", items: CODE_REVIEW_DELIVERY_ENTRY },
  },
  required: ["specSourcesProvided", "codeReviewDelivery"],
  additionalProperties: false,
};

/**
 * `satisfies` is the gate, not decoration: both consumers reach this map through
 * a cast (`validateOutput.ts`, `buildSteps.ts`), so a `StepDef["schema"]` union
 * member added without an entry here would compile — and then
 * `validateCanonOutput` returns undefined for it, which the caller reads as
 * "valid", while the prompt loses its JSON-schema appendix. A silently
 * unvalidated schema key is the failure this line makes a typecheck error.
 */
export const canonSchemas = {
  weaknesses: WEAK_SCHEMA,
  securityFindings: SEC_SCHEMA,
  codeReviewFindings: CODE_REVIEW_SCHEMA,
  codeReviewDelivery: CODE_REVIEW_DELIVERY_SCHEMA,
} satisfies Record<NonNullable<StepDef["schema"]>, object>;
