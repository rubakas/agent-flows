#!/usr/bin/env tsx
// `agent-flows uninstall` (spec 038 D10, FR-031).
//
// Removes exactly the harness registrations `agent-flows install` wrote, then
// offers to delete the personal workflow library and the per-project state,
// keeping both unless the answer is an explicit yes. It removes no workflow
// from any repository and no package. Takes no arguments.
//
// Run it BEFORE removing the package, or every harness session keeps reporting
// a failed MCP server forever.

import { createInterface } from "node:readline/promises";

import { resolveSetupEnv } from "./harnesses.js";
import { runUninstall } from "./uninstall.js";

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log("Usage: agent-flows uninstall");
  console.log("");
  console.log("  Unregister the agent-flows MCP server from every harness, then ask whether to");
  console.log("  delete the personal workflow library and the per-project state. Takes no flags.");
  process.exit(0);
}
if (args.length > 0) {
  console.error(`agent-flows uninstall: takes no arguments, got "${args[0]}"`);
  process.exit(1);
}

// No terminal means no questions and no deletions, so the reader is only wired
// up when there is someone to answer it.
const interactive = process.stdin.isTTY === true;
const rl = interactive
  ? createInterface({ input: process.stdin, output: process.stdout })
  : undefined;

/**
 * Ask, and treat a terminal that goes away as the empty answer.
 *
 * `rl.question()` never settles once the interface closes, so a Ctrl-D at the
 * prompt would otherwise end the process at the question with no report and no
 * exit code of our choosing. The empty answer is the one that keeps the data.
 */
function ask(question: string): Promise<string> {
  if (rl === undefined) return Promise.resolve("");
  return new Promise<string>((resolve) => {
    const closed = (): void => resolve("");
    rl.once("close", closed);
    void rl.question(question).then(
      (answer) => {
        rl.off("close", closed);
        resolve(answer);
      },
      () => resolve("")
    );
  });
}

const code = await runUninstall({
  setupEnv: resolveSetupEnv(),
  state: process.env,
  io: {
    write: (line) => console.log(line),
    ask: rl === undefined ? undefined : ask,
  },
});

rl?.close();
process.exit(code);
