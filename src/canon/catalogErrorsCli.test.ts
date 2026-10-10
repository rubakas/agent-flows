// The CLIs that read the bundled catalogue fail on a catalogue error (spec 047
// FR-12). `validate` printed the error but a pipeline that did not load used to
// stop `generate claude` with a raw stack trace halfway through writing; both now
// treat any error the catalogue reports as fatal, and `generate` writes nothing.
//
// The CLIs read the package's own pipelines/, so the broken pipeline needs a
// broken package: a copy of the source tree beside a symlinked node_modules.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { packageRoot } from "../packageRoot.js";

const ROOT = packageRoot();

describe("CLIs treat a catalogue error as fatal", () => {
  let pkg: string;
  let project: string;

  function run(cli: string): { status: number | null; output: string } {
    const result = spawnSync(process.execPath, ["--import", "tsx/esm", join(pkg, cli)], {
      cwd: pkg,
      env: { ...process.env, AGENT_FLOWS_PROJECT_DIR: project },
      encoding: "utf8",
      timeout: 60_000,
    });
    return { status: result.status, output: (result.stdout ?? "") + (result.stderr ?? "") };
  }

  before(() => {
    pkg = realpathSync(mkdtempSync(join(tmpdir(), "af-cli-errors-pkg-")));
    project = realpathSync(mkdtempSync(join(tmpdir(), "af-cli-errors-project-")));
    for (const entry of ["src", "pipelines", "prompts", "package.json", "tsconfig.json"]) {
      cpSync(join(ROOT, entry), join(pkg, entry), { recursive: true });
    }
    symlinkSync(join(ROOT, "node_modules"), join(pkg, "node_modules"));
  });
  after(() => {
    rmSync(pkg, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  });

  it("the clean copy validates and generates (so the failures below are the broken file's)", () => {
    assert.equal(run("src/canon/validate-cli.ts").status, 0);
    assert.equal(run("src/bindings/write-cli.ts").status, 0);
    rmSync(join(project, ".claude"), { recursive: true, force: true });
  });

  it("validate exits non-zero on a pipeline that does not load, and still lists the others", () => {
    writeFileSync(
      join(pkg, "pipelines", "zz-broken.yaml"),
      "id: zz-broken\nversion: 1\ndescription: x\ninputs: []\nsteps:\n  - id: a\n    kind: llm\n    role: worker\n"
    );

    const { status, output } = run("src/canon/validate-cli.ts");

    assert.equal(status, 1, output);
    assert.match(output, /ERROR: .*zz-broken\.yaml: .*llm step requires prompt/u);
    assert.match(output, /build OK \(\d+ steps\)/u);
  });

  it("validate exits non-zero on two files declaring one id", () => {
    rmSync(join(pkg, "pipelines", "zz-broken.yaml"));
    cpSync(join(pkg, "pipelines", "test.yaml"), join(pkg, "pipelines", "zz-twin.yaml"));

    const { status, output } = run("src/canon/validate-cli.ts");

    assert.equal(status, 1, output);
    assert.match(output, /pipeline id "test" is also declared by/u);
  });

  it("generate claude exits non-zero and writes nothing on a catalogue error", () => {
    const { status, output } = run("src/bindings/write-cli.ts");

    assert.equal(status, 1, output);
    assert.match(output, /ERROR: /u);
    assert.equal(
      existsSync(join(project, ".claude", "workflows")),
      false,
      "no script may be written from a partly unloadable catalogue"
    );
  });
});
