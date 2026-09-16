#!/usr/bin/env tsx
// `agent-flows setup [--remove]` (spec 038 D10, FR-030/FR-031).
//
// Registers the MCP server with every installed harness, and nothing else: per
// D17 no skill, agent, rule or settings file is ever written — those belong to
// `agent-notes`. Run `setup --remove` BEFORE uninstalling the package, or every
// harness session keeps reporting a failed MCP server forever.

import {
  formatHarnessResult,
  resolveSetupEnv,
  runRemove,
  runSetup,
  type HarnessResult,
} from "./harnesses.js";

const args = process.argv.slice(2);

function usage(): void {
  console.log("Usage: agent-flows setup [--remove]");
  console.log("");
  console.log("  (no flags)  register the agent-flows MCP server with every installed harness");
  console.log("  --remove    remove those registrations again");
}

if (args.includes("--help") || args.includes("-h")) {
  usage();
  process.exit(0);
}

const remove = args.includes("--remove");
const unknown = args.filter((arg) => arg !== "--remove");
if (unknown.length > 0) {
  console.error(`agent-flows setup: unknown argument "${unknown[0]}"`);
  usage();
  process.exit(1);
}

const env = resolveSetupEnv();
const results: HarnessResult[] = remove ? runRemove(env) : runSetup(env);

console.log(
  remove ? "agent-flows setup --remove:" : `agent-flows setup: registering ${env.command.join(" ")}`
);
for (const result of results) console.log(formatHarnessResult(result));

if (results.some((r) => r.status === "failed" || r.status === "refused")) process.exit(1);
