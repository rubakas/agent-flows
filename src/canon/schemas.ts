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

export const CODE_REVIEW_FINDING = {
  type: "object",
  properties: {
    claim: { type: "string" },
    file: { type: "string" },
    line: { type: ["string", "number"] },
    quote: { type: "string" },
    verdict: { type: "string", enum: ["CONFIRMED", "PARTIAL", "DECLINED"] },
    citationAccurate: { type: "boolean" },
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

export const canonSchemas = {
  weaknesses: WEAK_SCHEMA,
  securityFindings: SEC_SCHEMA,
  codeReviewFindings: CODE_REVIEW_SCHEMA,
};
