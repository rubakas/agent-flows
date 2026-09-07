// Cross-check: n8n node ROLE_TO_MODEL must equal the registry's role→model resolution.
//
// The n8n node package tests do not run in the root gate (scripts/test.sh only scans
// src/). This test lives in src/ so it runs in the gate, reads the node source as data,
// and asserts the maps match. If they diverge, this test fails.
//
// The node declares ROLE_TO_MODEL inline; we parse it from source rather than importing
// the node (which would require n8n-workflow in the root project's dependency tree).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { defaultRegistry, getProfile } from "./registry.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const NODE_SOURCE_PATH = join(
  __dirname,
  "../../integrations/n8n-nodes-agent-flows/src/nodes/AgentFlowsAgent/AgentFlowsAgent.node.ts"
);

const BLOCK_RE = /const ROLE_TO_MODEL[^=]*=\s*\{([^}]+)\}/;
const ENTRY_RE = /(\w+):\s*'([^']+)'/;

/**
 * Parse ROLE_TO_MODEL from the node's TypeScript source.
 * Matches the block: const ROLE_TO_MODEL: Record<Role, string> = { ... }
 */
function parseRoleToModel(source: string): Record<string, string> {
  const match = BLOCK_RE.exec(source);
  if (!match) throw new Error("Could not find ROLE_TO_MODEL block in node source");
  const body = match[1];
  const result: Record<string, string> = {};
  for (const line of body.split("\n")) {
    const m = ENTRY_RE.exec(line);
    if (m) result[m[1]] = m[2];
  }
  return result;
}

describe("n8n node ROLE_TO_MODEL sync with registry", () => {
  const nodeSrc = readFileSync(NODE_SOURCE_PATH, "utf8");
  const nodeMap = parseRoleToModel(nodeSrc);
  const reg = defaultRegistry({});
  const anthropic = getProfile("anthropic");

  it("node ROLE_TO_MODEL matches registry anthropic profile for all three roles", () => {
    for (const role of ["reasoner", "worker", "scout"] as const) {
      const registryEntry = reg.resolve(anthropic.roles[role]);
      const registryModel = registryEntry.cli?.model;
      const nodeModel = nodeMap[role];
      assert.equal(
        nodeModel,
        registryModel,
        `role "${role}": node maps to "${nodeModel}" but registry resolves to "${registryModel}". ` +
          `Update ROLE_TO_MODEL in AgentFlowsAgent.node.ts to match src/canon/registry.ts.`
      );
    }
  });
});
