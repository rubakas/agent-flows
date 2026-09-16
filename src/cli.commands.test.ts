// The fork, list and enable/disable verbs end to end (spec 038 FR-020–FR-026).
//
// Everything runs through src/cli.ts, the way an operator reaches these verbs,
// because the router, the argument parsing and the output are each half of what
// the requirements promise. AGENT_FLOWS_HOME and AGENT_FLOWS_PROJECT_DIR are
// pinned to temp directories in every case: the user library layer and the state
// directory that holds the visibility file both live under the home, so an
// unpinned run here would fork into — and hide workflows on — the owner's own
// machine.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { packageRoot } from "./packageRoot.js";

const ROOT = packageRoot();

/** A workflow every install ships, so forking it needs no fixture. */
const BUNDLED_ID = "cycle";

const tempDirs: string[] = [];

after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), prefix)));
  tempDirs.push(dir);
  return dir;
}

interface Project {
  dir: string;
  home: string;
  run: (...args: string[]) => { code: number; output: string };
}

function makeProject(prefix: string): Project {
  const dir = tempDir(`${prefix}-project-`);
  const home = tempDir(`${prefix}-home-`);
  return {
    dir,
    home,
    run: (...args: string[]) => {
      const result = spawnSync(
        process.execPath,
        ["--import", "tsx/esm", join(ROOT, "src", "cli.ts"), ...args],
        {
          // Run from the repository so the tsx loader resolves; the project the
          // verbs act on is the temp one named by AGENT_FLOWS_PROJECT_DIR.
          cwd: ROOT,
          env: {
            ...process.env,
            AGENT_FLOWS_PROJECT_DIR: dir,
            AGENT_FLOWS_HOME: home,
          },
          encoding: "utf8",
          timeout: 60_000,
        }
      );
      return { code: result.status ?? 1, output: (result.stdout ?? "") + (result.stderr ?? "") };
    },
  };
}

/** The `list` row for one id, without the padding. */
function row(output: string, id: string): string {
  const line = output.split("\n").find((l) => l.trimStart().startsWith(`${id} `));
  assert.ok(line !== undefined, `no row for "${id}" in:\n${output}`);
  return line.replace(/\s+/gu, " ").trim();
}

describe("agent-flows fork: argument handling (FR-021)", () => {
  it("refuses a --to value that is not a layer name and writes nothing", () => {
    const project = makeProject("af-cli-fork-bad-to");
    const { code, output } = project.run("fork", BUNDLED_ID, "--to", "bogus");
    assert.equal(code, 1, `expected a non-zero exit:\n${output}`);
    assert.match(output, /--to must be "user" or "repo"/u);
    assert.ok(
      !existsSync(join(project.dir, ".agent-flows")),
      "a rejected --to must not create a layer"
    );
    assert.ok(!existsSync(join(project.home, "workflows")), "nor the user library");
  });

  it("refuses to overwrite an existing copy until --overwrite is passed", () => {
    const project = makeProject("af-cli-fork-overwrite");
    const forked = join(project.dir, ".agent-flows", "pipelines", `${BUNDLED_ID}.yaml`);

    const first = project.run("fork", BUNDLED_ID, "--to", "repo");
    assert.equal(first.code, 0, first.output);
    assert.match(first.output, new RegExp(`Forked "${BUNDLED_ID}" from the bundled layer`, "u"));
    assert.ok(existsSync(forked), `the fork must write ${forked}:\n${first.output}`);

    // An edit the operator would make, to prove --overwrite really replaces it.
    const pristine = readFileSync(forked, "utf8");
    const edited = pristine.replace(/^description: .*$/mu, "description: edited by hand");
    assert.notEqual(edited, pristine, "the fixture edit must change the file");
    writeFileSync(forked, edited, "utf8");

    const second = project.run("fork", BUNDLED_ID, "--to", "repo");
    assert.equal(second.code, 1, `a second fork must refuse:\n${second.output}`);
    assert.match(second.output, /already exists in the repo layer/u);
    assert.equal(readFileSync(forked, "utf8"), edited, "the refusal must change nothing");

    const third = project.run("fork", BUNDLED_ID, "--to", "repo", "--overwrite");
    assert.equal(third.code, 0, third.output);
    assert.equal(
      readFileSync(forked, "utf8"),
      pristine,
      "--overwrite must restore the copy from the layer below"
    );
  });
});

describe("agent-flows list: the markers on a row (FR-020, FR-024)", () => {
  it("names the owning layer, the layers a row shadows, and the hidden rows", () => {
    const project = makeProject("af-cli-list");

    const bundled = project.run("list");
    assert.equal(bundled.code, 0, bundled.output);
    assert.equal(
      row(bundled.output, BUNDLED_ID),
      `${BUNDLED_ID} [bundled]`,
      "an unforked workflow is owned by the bundled layer and shadows nothing"
    );

    assert.equal(project.run("fork", BUNDLED_ID, "--to", "repo").code, 0);
    assert.equal(
      row(project.run("list").output, BUNDLED_ID),
      `${BUNDLED_ID} [repo] (shadows bundled)`,
      "the fork owns the id now and says what it shadows"
    );

    const disabled = project.run("disable", BUNDLED_ID);
    assert.equal(disabled.code, 0, disabled.output);
    assert.match(disabled.output, new RegExp(`Hidden: ${BUNDLED_ID}`, "u"));
    assert.equal(
      row(project.run("list").output, BUNDLED_ID),
      `${BUNDLED_ID} [repo] (shadows bundled) [hidden]`,
      "a hidden workflow is still listed here, marked — it is unlisted on the two chat surfaces"
    );

    const enabled = project.run("enable", BUNDLED_ID);
    assert.equal(enabled.code, 0, enabled.output);
    assert.equal(
      row(project.run("list").output, BUNDLED_ID),
      `${BUNDLED_ID} [repo] (shadows bundled)`,
      "enable removes the mark again"
    );
  });
});
