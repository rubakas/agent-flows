#!/usr/bin/env tsx
// `agent-flows install` (spec 038 D10, FR-030).
//
// Registers the agent-flows MCP server with every harness installed on this
// machine, and nothing else: it installs no workflow and no package. Takes no
// arguments; `agent-flows uninstall` reverses it.

import { formatHarnessResult, resolveSetupEnv, runSetup, type HarnessResult } from "./harnesses.js";

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log("Usage: agent-flows install");
  console.log("");
  console.log("  Register the agent-flows MCP server with every harness installed on this");
  console.log("  machine. Takes no flags; `agent-flows uninstall` reverses it.");
  process.exit(0);
}
if (args.length > 0) {
  console.error(`agent-flows install: takes no arguments, got "${args[0]}"`);
  process.exit(1);
}

const env = resolveSetupEnv();
const results: HarnessResult[] = runSetup(env);

console.log(`agent-flows install: registering ${env.command.join(" ")}`);
for (const result of results) console.log(formatHarnessResult(result));

if (results.some((r) => r.status === "failed" || r.status === "refused")) process.exit(1);
