// Spec 038 FR-007/D12: `agent-flows generate claude` writes into the project and
// does no filesystem work before its arguments are parsed.
//
// The module used to mkdirSync(<package>/.claude/workflows) at import time and
// read the provider profile from the package's own directory. Under a global
// install with a root-owned prefix that is an EACCES on every invocation,
// `--help` included, and the generated workflows landed in the tool instead of
// the user's repository.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { packageRoot } from "../packageRoot.js";

const ROOT = packageRoot();
const WRITE_CLI = join(ROOT, "src", "bindings", "write-cli.ts");

function runGenerate(
  projectDir: string,
  args: string[] = []
): { status: number | null; output: string } {
  // cwd stays in the package so the tsx loader resolves; AGENT_FLOWS_PROJECT_DIR
  // is what must decide where the output lands.
  const result = spawnSync(process.execPath, ["--import", "tsx/esm", WRITE_CLI, ...args], {
    cwd: ROOT,
    env: { ...process.env, AGENT_FLOWS_PROJECT_DIR: projectDir },
    encoding: "utf8",
    timeout: 60_000,
  });
  return { status: result.status, output: (result.stdout ?? "") + (result.stderr ?? "") };
}

describe("FR-007: generate claude targets the project", () => {
  let projectDir: string;

  before(() => {
    projectDir = realpathSync(mkdtempSync(join(tmpdir(), "af-generate-")));
  });
  after(() => rmSync(projectDir, { recursive: true, force: true }));

  it("writes the workflow scripts into <project>/.claude/workflows", () => {
    const { status, output } = runGenerate(projectDir);
    assert.equal(status, 0, `generate must succeed:\n${output}`);
    const outDir = join(projectDir, ".claude", "workflows");
    const written = readdirSync(outDir);
    assert.ok(
      written.includes("audit.js"),
      `expected audit.js in ${outDir}, got ${written.join()}`
    );
    assert.ok(
      output.includes(`Written: ${join(outDir, "audit.js")}`),
      `the reported path must be inside the project:\n${output}`
    );
  });

  it("reads its pipelines from the package root", () => {
    // Every bundled pipeline the generator supports comes from <package>/pipelines,
    // not from the (empty) project — so the project gets more than nothing.
    const written = readdirSync(join(projectDir, ".claude", "workflows"));
    assert.ok(written.length >= 3, `expected the bundled set, got ${written.join()}`);
  });
});

describe("FR-007: no filesystem work before the arguments are parsed", () => {
  it("--help succeeds even when the project directory does not exist", () => {
    // resolveProjectDir() throws for a missing directory and mkdirSync would
    // fail on it — neither may run before the arguments are read. The old
    // top-level mkdirSync made this exit non-zero.
    const missing = join(tmpdir(), "af-generate-does-not-exist-________");
    assert.equal(existsSync(missing), false);
    const result = spawnSync(process.execPath, ["--import", "tsx/esm", WRITE_CLI, "--help"], {
      env: { ...process.env, AGENT_FLOWS_PROJECT_DIR: missing },
      encoding: "utf8",
      timeout: 60_000,
    });
    const output = (result.stdout ?? "") + (result.stderr ?? "");
    assert.equal(result.status, 0, `--help must not touch the filesystem:\n${output}`);
    assert.match(output, /Usage: agent-flows generate claude/u);
  });

  it("--help writes nothing into the package's own directory", () => {
    const packageOut = join(ROOT, ".claude", "workflows");
    const before = existsSync(packageOut) ? readdirSync(packageOut).sort() : null;
    const projectDir = realpathSync(mkdtempSync(join(tmpdir(), "af-generate-nowrite-")));
    try {
      runGenerate(projectDir);
      const after = existsSync(packageOut) ? readdirSync(packageOut).sort() : null;
      assert.deepEqual(after, before, "generate must never write into the package directory");
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
