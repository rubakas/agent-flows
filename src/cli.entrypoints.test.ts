// Spec 038 FR-006/D4: the CLI spawns each verb's module as its own process and
// must keep doing so.
//
// Every verb module only acts when it IS the process entry point — or, in the
// MCP server's case, acts unconditionally at import time. Switching runModule()
// to a direct import would therefore make `serve` and `doctor` exit 0 having
// done nothing, and would let `mcp` hijack the router's stdio. These tests pin
// the two halves of that: an import does nothing, and the MCP server really does
// start its transport at the top level.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { packageRoot } from "./packageRoot.js";

const ROOT = packageRoot();

/**
 * Imports a module in a fresh process and returns what happened. A module that
 * started a listener would hold the event loop open and the run would time out
 * instead of exiting — that timeout is the failure this test is looking for.
 */
function importInChildProcess(modulePath: string): {
  status: number | null;
  timedOut: boolean;
  output: string;
} {
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx/esm",
      "-e",
      `await import(${JSON.stringify(modulePath)}); console.log("IMPORT-RETURNED");`,
    ],
    {
      cwd: ROOT,
      env: { ...process.env, AGENT_FLOWS_PROJECT_DIR: ROOT },
      encoding: "utf8",
      timeout: 60_000,
    }
  );
  return {
    status: result.status,
    timedOut: result.signal !== null,
    output: (result.stdout ?? "") + (result.stderr ?? ""),
  };
}

describe("FR-006: importing a verb module does nothing", () => {
  it("importing src/serve/server.ts starts no listener and exits", () => {
    const { status, timedOut, output } = importInChildProcess(join(ROOT, "src/serve/server.ts"));
    assert.equal(timedOut, false, `the import never returned — a listener is open:\n${output}`);
    assert.equal(status, 0, `expected a clean exit, got ${String(status)}:\n${output}`);
    assert.match(output, /IMPORT-RETURNED/u);
    assert.doesNotMatch(
      output,
      /agent-flows serve:/u,
      `the daemon's startup banner must not appear on import:\n${output}`
    );
  });

  it("importing src/doctor.ts runs no checks and exits", () => {
    const { status, timedOut, output } = importInChildProcess(join(ROOT, "src/doctor.ts"));
    assert.equal(timedOut, false, `the import never returned:\n${output}`);
    assert.equal(status, 0, `expected a clean exit, got ${String(status)}:\n${output}`);
    assert.match(output, /IMPORT-RETURNED/u);
    assert.doesNotMatch(
      output,
      /Node\.js/u,
      `doctor must print no report when merely imported:\n${output}`
    );
  });

  // src/bindings/mastra/server.ts is deliberately NOT imported here: it calls
  // startStdio() at the top level, which would take over this process's stdio.
  // That is exactly why runModule() spawns instead of importing, so the fact is
  // asserted against the source text instead.
  it("src/bindings/mastra/server.ts starts its stdio transport at the top level", () => {
    const source = readFileSync(join(ROOT, "src/bindings/mastra/server.ts"), "utf8");
    assert.match(
      source,
      /^await server\.startStdio\(\);/mu,
      "an unguarded top-level startStdio() is the reason the MCP verb must be spawned"
    );
  });

  it("runModule spawns the verb module instead of importing it", () => {
    const source = readFileSync(join(ROOT, "src/cli.ts"), "utf8");
    assert.match(source, /spawn\(process\.execPath/u, "the router must spawn a child process");
    assert.doesNotMatch(
      source,
      /await import\(/u,
      "cli.ts must not import a verb module in process (spec 038 D4)"
    );
    // tsx is a devDependency, so the compiled build must not ask for its loader.
    assert.match(source, /_ext === "\.ts" \? \["--import", "tsx\/esm"\] : \[\]/u);
  });
});
