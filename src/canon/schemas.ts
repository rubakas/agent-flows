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

export const canonSchemas = {
  weaknesses: WEAK_SCHEMA,
  securityFindings: SEC_SCHEMA,
};
