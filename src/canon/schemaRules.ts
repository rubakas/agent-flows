import { canonSchemas } from "./schemas.js";

type SchemaKey = keyof typeof canonSchemas;
interface Rule {
  description: string;
  if: object;
  then: object;
}

// The cross-field rules a plain JSON schema cannot hold without if/then. They are written
// here once and generate the plugin's schemas (src/af-plugin/buildReviewEngine.ts); the
// TS checks in validateOutput.ts are the message-producing twin, kept agreeing by
// src/af-plugin/rules.test.ts.
const NOT_A_DECISION = "^\\s*[Nn][Oo][Tt] [Aa] [Dd][Ee][Cc][Ii][Ss][Ii][Oo][Nn]\\s*$";

export const SCHEMA_RULES = {
  codeReviewFindings: {
    items: [
      {
        description:
          "Rule: verdict CONFIRMED needs evidenceBasis file-content or absence-of-file (an observation of files); otherwise use PARTIAL, DECLINED or UNVERIFIABLE.",
        if: { required: ["verdict"], properties: { verdict: { const: "CONFIRMED" } } },
        then: {
          required: ["evidenceBasis"],
          properties: { evidenceBasis: { enum: ["file-content", "absence-of-file"] } },
        },
      },
      {
        description:
          "Rule: remedyScope all-sites-verified requires every sites[].remedySafe to be true; use sites-differ when any site is unsafe.",
        if: {
          required: ["remedyScope"],
          properties: { remedyScope: { const: "all-sites-verified" } },
        },
        then: {
          required: ["sites"],
          properties: {
            sites: {
              items: { required: ["remedySafe"], properties: { remedySafe: { const: true } } },
            },
          },
        },
      },
      {
        description:
          "Rule: remedyScope single-site allows at most one entry in sites; check the remedy at each location and use all-sites-verified or sites-differ.",
        if: { required: ["remedyScope"], properties: { remedyScope: { const: "single-site" } } },
        then: { required: ["sites"], properties: { sites: { maxItems: 1 } } },
      },
    ],
  },
  codeReviewDelivery: {
    items: [
      {
        description:
          "Rule: classification silently-decided needs decisionTaken naming the option the change took (not blank, not 'not a decision'); name it or classify the entry implemented.",
        if: {
          required: ["classification"],
          properties: { classification: { const: "silently-decided" } },
        },
        then: {
          required: ["decisionTaken"],
          properties: {
            decisionTaken: { type: "string", pattern: "\\S", not: { pattern: NOT_A_DECISION } },
          },
        },
      },
      {
        description:
          "Rule: classification silently-decided needs optionsForeclosed naming what the change ruled out (not blank, not 'not a decision'); name it or classify the entry implemented.",
        if: {
          required: ["classification"],
          properties: { classification: { const: "silently-decided" } },
        },
        then: {
          required: ["optionsForeclosed"],
          properties: {
            optionsForeclosed: { type: "string", pattern: "\\S", not: { pattern: NOT_A_DECISION } },
          },
        },
      },
      {
        description:
          "Rule: classification implemented or partial needs evidence naming a file: a path with a separator (app/models/lot.rb) or name:line (lot.rb:42); otherwise use not-implemented or replaced-by-prose.",
        if: {
          required: ["classification"],
          properties: { classification: { enum: ["implemented", "partial"] } },
        },
        then: {
          required: ["evidence"],
          properties: {
            evidence: {
              type: "string",
              pattern: "[\\w.-]+\\/[\\w.-]+|[\\w-]+\\.[A-Za-z]\\w*:\\d+",
            },
          },
        },
      },
      {
        description:
          "Rule: classification correctly-deferred needs requirement to quote the deferring spec line (not blank); otherwise use not-implemented.",
        if: {
          required: ["classification"],
          properties: { classification: { const: "correctly-deferred" } },
        },
        then: {
          required: ["requirement"],
          properties: { requirement: { type: "string", pattern: "\\S" } },
        },
      },
    ],
    root: [
      {
        description:
          "Rule: specSourcesProvided false means no requirement exists to classify, so codeReviewDelivery must be empty; report zero entries or set specSourcesProvided true.",
        if: {
          required: ["specSourcesProvided"],
          properties: { specSourcesProvided: { const: false } },
        },
        then: {
          required: ["codeReviewDelivery"],
          properties: { codeReviewDelivery: { maxItems: 0 } },
        },
      },
    ],
  },
} satisfies Partial<Record<SchemaKey, { items?: Rule[]; root?: Rule[] }>>;

type Node = Record<string, unknown>;

/** The canon schema for `key` plus its rules and a title: what the plugin ships. */
export function workflowSchema(key: keyof typeof SCHEMA_RULES): object {
  const schema = structuredClone(canonSchemas[key]) as Node;
  const rules: { items?: Rule[]; root?: Rule[] } = SCHEMA_RULES[key];
  const items = ((schema.properties as Node)[key] as Node | undefined)?.items as Node | undefined;
  if (items === undefined) throw new Error(`schema ${key} has no properties.${key}.items`);
  if (rules.items !== undefined) items.allOf = structuredClone(rules.items);
  schema.title = key;
  if (rules.root !== undefined) schema.allOf = structuredClone(rules.root);
  return schema;
}
