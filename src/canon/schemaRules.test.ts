// The plugin's cross-field rules are owned here (spec 047 FR-13). Their JSON files are
// generated from this module and pinned fresh by src/af-plugin/workflow.test.ts; the
// three-way parity with validateOutput.ts is src/af-plugin/rules.test.ts.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { SCHEMA_RULES, workflowSchema } from "./schemaRules.js";

describe("schema rules", () => {
  it("every rule names itself, and there are eight", () => {
    const rules = Object.values(SCHEMA_RULES).flatMap((r) => [
      ...(r.items ?? []),
      ...("root" in r ? r.root : []),
    ]);
    assert.equal(rules.length, 8);
    for (const rule of rules) assert.match(rule.description, /^Rule: /);
  });

  it("puts the item rules on the items and the root rules on the root", () => {
    const delivery = workflowSchema("codeReviewDelivery") as Record<string, any>;
    assert.equal(delivery.properties.codeReviewDelivery.items.allOf.length, 4);
    assert.equal(delivery.allOf.length, 1);
    const findings = workflowSchema("codeReviewFindings") as Record<string, any>;
    assert.equal(findings.properties.codeReviewFindings.items.allOf.length, 3);
    assert.equal(findings.allOf, undefined);
  });
});
