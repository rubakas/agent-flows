import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { buildCodexEnv, codexExecArgs } from "../adapters/codex.js";
import { defaultRegistry } from "../registry.js";
import { CODEX_PROFILE_NAME, codexConfinementArgs } from "./codexProfile.js";
import { materializeSanitizedWorkspace } from "./sanitize.js";

const INSIDE_MARKER = "INSIDE-MARKER-4c1e";
const OUTSIDE_MARKER = "OUTSIDE-MARKER-9b7d";
const CALL_TIMEOUT_MS = 60_000;

const codexPath = which("codex");

function which(binary: string): string | undefined {
  const result = spawnSync("command", ["-v", binary], { encoding: "utf8", shell: true });
  const found = result.stdout.trim().split("\n")[0];
  return result.status === 0 && found !== "" ? found : undefined;
}

const fixtureRoot = codexPath
  ? fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agent-flows-codex-")))
  : "";

after(() => {
  if (fixtureRoot !== "") fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

interface CodexRun {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runCodex(flags: string[], cwd: string, command: string[]): CodexRun {
  const result = spawnSync(
    "codex",
    ["sandbox", "-P", CODEX_PROFILE_NAME, ...flags, "-C", cwd, "--", ...command],
    { encoding: "utf8", timeout: CALL_TIMEOUT_MS, killSignal: "SIGKILL" }
  );
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe("codex confinement (V3a)", () => {
  if (!codexPath) {
    it("SKIP: codex is not on PATH, so the sandbox assertions cannot run", () => {
      console.log("SKIP codex confinement (V3a): `codex` not found on PATH");
    });
    return;
  }

  const inside = path.join(fixtureRoot, "inside");
  const outside = path.join(fixtureRoot, "outside");
  fs.mkdirSync(inside, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(inside, "README.md"), `${INSIDE_MARKER}\n`);
  const outsideMarkerFile = path.join(outside, "outside-marker.txt");
  fs.writeFileSync(outsideMarkerFile, `${OUTSIDE_MARKER}\n`);

  const insideReadme = path.join(inside, "README.md");
  const confined = codexConfinementArgs(inside);
  // Control profile: the same named profile without the filesystem deny map.
  const unconfined = confined.slice(0, 4);

  it("reads a file inside the granted directory", () => {
    const run = runCodex(confined, inside, ["cat", insideReadme]);
    assert.equal(run.status, 0, `expected exit 0, stderr: ${run.stderr}`);
    assert.ok(run.stdout.includes(INSIDE_MARKER), `stdout was ${JSON.stringify(run.stdout)}`);
  });

  it("cannot read a file outside the granted directory", () => {
    const run = runCodex(confined, inside, ["cat", outsideMarkerFile]);
    assert.equal(run.status, 1, `expected exit 1, stderr: ${run.stderr}`);
    assert.ok(
      run.stderr.includes("Operation not permitted"),
      `stderr was ${JSON.stringify(run.stderr)}`
    );
    assert.equal(run.stdout.includes(OUTSIDE_MARKER), false, "the outside marker must not leak");
  });

  it("cannot write inside the granted directory", () => {
    const run = runCodex(confined, inside, ["sh", "-c", `echo x > ${path.join(inside, "w")}`]);
    assert.notEqual(run.status, 0, "a write must fail");
    assert.ok(
      run.stderr.includes("Operation not permitted"),
      `stderr was ${JSON.stringify(run.stderr)}`
    );
    assert.equal(fs.existsSync(path.join(inside, "w")), false);
  });

  it("cannot list /Library", () => {
    const run = runCodex(confined, inside, ["ls", "/Library"]);
    assert.notEqual(run.status, 0, `expected a non-zero exit, stdout: ${run.stdout}`);
    assert.ok(
      run.stderr.includes("Operation not permitted"),
      `stderr was ${JSON.stringify(run.stderr)}`
    );
  });

  it("cannot list the homebrew config directory", () => {
    if (!fs.existsSync("/opt/homebrew/etc")) {
      console.log("SKIP /opt/homebrew/etc assertion: directory absent on this machine");
      return;
    }
    const run = runCodex(confined, inside, ["ls", "/opt/homebrew/etc"]);
    assert.notEqual(run.status, 0, `expected a non-zero exit, stdout: ${run.stdout}`);
    assert.ok(
      run.stderr.includes("Operation not permitted"),
      `stderr was ${JSON.stringify(run.stderr)}`
    );
  });

  // The deny above must be the `etc` subtree only: denying `/opt` outright makes
  // every homebrew binary unexecutable (`execvp … Operation not permitted`), so a
  // step loses the tools it legitimately runs.
  it("still executes a tool installed under /opt/homebrew/bin", () => {
    const rgPath = "/opt/homebrew/bin/rg";
    if (!fs.existsSync(rgPath)) {
      console.log("SKIP /opt/homebrew/bin/rg assertion: binary absent on this machine");
      return;
    }
    const run = runCodex(confined, inside, [rgPath, "--version"]);
    assert.equal(run.status, 0, `expected exit 0, stderr: ${run.stderr}`);
  });

  it("CONTROL: without the filesystem deny map the outside marker leaks", () => {
    const run = runCodex(unconfined, inside, ["cat", outsideMarkerFile]);
    assert.equal(run.status, 0, `expected the control to succeed, stderr: ${run.stderr}`);
    assert.ok(
      run.stdout.includes(OUTSIDE_MARKER),
      "the control must leak — otherwise the deny map is not what closes the gate"
    );
  });
});

// ─── Live preflight: the real argv must actually start ────────────────────────
//
// V6 under AGENT_FLOWS_PROVIDER=openai died on the first step with "Not inside a
// trusted directory and --skip-git-repo-check was not specified" — the sanitized
// copy omits `.git` by design, so the grant is never a repo. Unit tests assert
// the flag is in the argv; only a real spawn proves the argv starts.
describe("codex live preflight (V6 regression)", () => {
  const live = process.env.AGENT_FLOWS_LIVE_TESTS === "1";

  if (!live || !codexPath) {
    it("SKIP: live preflight needs AGENT_FLOWS_LIVE_TESTS=1 and codex on PATH", () => {
      const reason = !codexPath ? "`codex` not found on PATH" : "AGENT_FLOWS_LIVE_TESTS is not 1";
      console.log(`SKIP codex live preflight: ${reason} (makes a real model call)`);
    });
    return;
  }

  it("starts against a sanitized copy without the trusted-directory refusal", () => {
    const repo = path.join(fixtureRoot, "preflight-repo");
    fs.mkdirSync(repo, { recursive: true });
    const gitEnv = {
      ...process.env,
      GIT_CONFIG_GLOBAL: os.devNull,
      GIT_CONFIG_SYSTEM: os.devNull,
      GIT_AUTHOR_NAME: "Fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    };
    for (const args of [
      ["init", "-q", "-b", "main"],
      ["add", "-A"],
      ["commit", "-qm", "fixture"],
    ]) {
      if (args[0] === "add") fs.writeFileSync(path.join(repo, "README.md"), `${INSIDE_MARKER}\n`);
      const r = spawnSync("git", args, { cwd: repo, encoding: "utf8", env: gitEnv });
      if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
    }

    const workspace = materializeSanitizedWorkspace(repo, { env: {} });
    try {
      const model = defaultRegistry({
        ...process.env,
        AGENT_FLOWS_CODEX_MODEL: "gpt-5.6-luna",
      }).resolve("codex").cli?.model;

      const run = spawnSync("codex", codexExecArgs(workspace.dir, model), {
        encoding: "utf8",
        env: buildCodexEnv(process.env),
        cwd: workspace.dir,
        input: "reply with the single word OK",
        timeout: CALL_TIMEOUT_MS * 3,
        killSignal: "SIGKILL",
      });
      if (run.error) throw run.error;

      assert.equal(
        run.stderr.includes("Not inside a trusted directory"),
        false,
        `the trusted-directory refusal came back: ${run.stderr.slice(-400)}`
      );
      assert.equal(run.status, 0, `expected exit 0, stderr: ${run.stderr.slice(-400)}`);
    } finally {
      workspace.cleanup();
    }
  });
});
