// Test for spec 032 FR-013: scripts/install.sh must capture the launch
// directory before it cd's into the tool checkout, so `list`/`install` resolve
// the owner's project rather than agent-flows' own repository.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const repoRoot = join(dirname(__filename), "..", "..");

const tmpProject = realpathSync(mkdtempSync(join(tmpdir(), "af-install-sh-")));

after(() => {
  rmSync(tmpProject, { recursive: true, force: true });
});

describe("FR-013: scripts/install.sh resolves the launch directory", () => {
  it("`list` reports the caller's directory as the project, not the tool checkout", () => {
    const result = spawnSync("bash", [join(repoRoot, "scripts", "install.sh"), "list"], {
      cwd: tmpProject,
      // Drop any inherited override so the script's own default is what is tested.
      env: { ...process.env, AGENT_FLOWS_PROJECT_DIR: undefined },
      encoding: "utf8",
    });

    assert.equal(result.status, 0, `install.sh list must succeed; stderr: ${result.stderr}`);
    const projectLine = result.stdout.split("\n").find((l) => l.startsWith("Project:"));
    assert.ok(projectLine, `output must contain a Project: line; got: ${result.stdout}`);
    assert.equal(projectLine.trim(), `Project: ${tmpProject}`);
    assert.notEqual(projectLine.trim(), `Project: ${repoRoot}`);
  });
});
