// Tests for `agent-flows uninstall`'s two questions (spec 038 D10, FR-031).
//
// AGENT_FLOWS_HOME and the harness home are pinned to a fresh temp directory in
// every case, and both the prompt layer and the stop path are injected: a test
// that reached for the real ones would offer to delete the developer's own
// workflow library and run history, and would block on the first question.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { writeDaemonRecord } from "../runtime/daemonRecord.js";
import { resolveProjectState } from "../runtime/projectState.js";
import { stopAllDaemons } from "../serve/stop.js";
import { claudeConfigPath, SERVER_NAME } from "./harnesses.js";
import { runUninstall } from "./uninstall.js";
import type { RunResult, SetupEnv } from "./harnesses.js";
import type { DaemonIdentity } from "../runtime/daemonRecord.js";
import type { StateEnv } from "../runtime/projectState.js";

const cleanups: (() => void)[] = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

const COMMAND = ["/opt/agent-flows/bin/agent-flows", "mcp"];

interface Fixture {
  tmp: string;
  /** The harness home — never the real one. */
  home: string;
  /** AGENT_FLOWS_HOME — the state root, never the real one. */
  stateHome: string;
  libraryRoot: string;
  projectsDir: string;
  state: StateEnv;
  setupEnv: SetupEnv;
  /** Every harness CLI invocation the fake recorded. */
  calls: { bin: string; args: string[] }[];
}

/**
 * A machine with Claude Code registered, two personal workflows and two
 * projects' state — all inside one temp directory.
 */
function makeFixture(): Fixture {
  const tmp = mkdtempSync(join(realpathSync(tmpdir()), "af-uninstall-"));
  cleanups.push(() => rmSync(tmp, { recursive: true, force: true }));
  const home = join(tmp, "home");
  const stateHome = join(tmp, "state");
  mkdirSync(home, { recursive: true });

  writeFileSync(
    claudeConfigPath(home),
    JSON.stringify({
      numStartups: 3,
      mcpServers: { [SERVER_NAME]: { command: COMMAND[0], args: COMMAND.slice(1) } },
    })
  );

  const libraryRoot = join(stateHome, "workflows");
  mkdirSync(join(libraryRoot, "pipelines"), { recursive: true });
  writeFileSync(join(libraryRoot, "pipelines", "mine.yaml"), "id: mine\n");
  writeFileSync(join(libraryRoot, "pipelines", "other.yaml"), "id: other\n");

  const projectsDir = join(stateHome, "projects");
  mkdirSync(join(projectsDir, "project-a"), { recursive: true });
  writeFileSync(join(projectsDir, "project-a", "agent-flows.sqlite"), "db");
  mkdirSync(join(projectsDir, "project-b"), { recursive: true });

  const calls: { bin: string; args: string[] }[] = [];
  const setupEnv: SetupEnv = {
    home,
    command: COMMAND,
    which: (bin) => (bin === "claude" ? "/usr/local/bin/claude" : undefined),
    run: (bin, args): RunResult => {
      calls.push({ bin, args });
      return { code: 0, stdout: "", stderr: "" };
    },
  };

  return {
    tmp,
    home,
    stateHome,
    libraryRoot,
    projectsDir,
    state: { AGENT_FLOWS_HOME: stateHome },
    setupEnv,
    calls,
  };
}

interface Recorder {
  lines: string[];
  questions: string[];
  text: () => string;
}

/** A prompt layer that answers from a queue. `answers: undefined` = no terminal. */
function recorder(answers?: string[]): {
  io: { write: (line: string) => void; ask?: (q: string) => Promise<string> };
  log: Recorder;
} {
  const lines: string[] = [];
  const questions: string[] = [];
  const queue = [...(answers ?? [])];
  const log: Recorder = { lines, questions, text: () => lines.join("\n") };
  return {
    io: {
      write: (line) => lines.push(line),
      ask:
        answers === undefined
          ? undefined
          : (question: string) => {
              questions.push(question);
              return Promise.resolve(queue.shift() ?? "");
            },
    },
    log,
  };
}

describe("uninstall: the two questions (D10)", () => {
  it("a yes to both deletes the library and the per-project state", async () => {
    const fx = makeFixture();
    const { io, log } = recorder(["y", "yes"]);

    const code = await runUninstall({ setupEnv: fx.setupEnv, state: fx.state, io });

    assert.equal(code, 0);
    assert.equal(existsSync(fx.libraryRoot), false, "the library should be gone");
    assert.equal(existsSync(fx.projectsDir), false, "the per-project state should be gone");
    assert.equal(log.questions.length, 2, "exactly two questions");
    assert.match(log.text(), /unregistered from Claude Code/u);
    assert.match(log.text(), /personal workflow library deleted/u);
    assert.match(log.text(), /per-project state deleted/u);
  });

  it("a no to both keeps both, and the harnesses are unregistered anyway", async () => {
    const fx = makeFixture();
    const { io, log } = recorder(["n", "no"]);

    await runUninstall({ setupEnv: fx.setupEnv, state: fx.state, io });

    assert.ok(existsSync(fx.libraryRoot), "the library must survive a no");
    assert.ok(existsSync(fx.projectsDir), "the per-project state must survive a no");
    assert.deepEqual(
      fx.calls.map((c) => c.bin),
      ["claude"],
      "unregistering is what the verb means and is never asked about"
    );
    assert.match(log.text(), /unregistered from Claude Code/u);
    assert.match(log.text(), /personal workflow library kept at/u);
    assert.match(log.text(), /per-project state kept at/u);
  });

  it("an empty answer keeps both — deleting history takes an explicit yes", async () => {
    const fx = makeFixture();
    const { io, log } = recorder(["", ""]);

    await runUninstall({ setupEnv: fx.setupEnv, state: fx.state, io });

    assert.ok(existsSync(fx.libraryRoot), "a bare newline must not delete the library");
    assert.ok(existsSync(fx.projectsDir), "a bare newline must not delete the run history");
    assert.match(log.text(), /personal workflow library kept at/u);
    assert.match(log.text(), /per-project state kept at/u);
  });

  it("names the path and the count, and promises repository workflows are untouched", async () => {
    const fx = makeFixture();
    const { io, log } = recorder(["", ""]);

    await runUninstall({ setupEnv: fx.setupEnv, state: fx.state, io });

    assert.match(log.text(), new RegExp(`${fx.libraryRoot}.*2 workflows`, "u"));
    assert.match(log.text(), new RegExp(`${fx.projectsDir}.*2 projects`, "u"));
    assert.match(log.text(), /committed inside a repository/u);
    assert.match(log.text(), /cannot be undone/u);
    assert.match(log.text(), /npm rm -g --prefix ~\/\.local @rubakas\/agent-flows/u);
  });
});

describe("uninstall: no terminal (D10)", () => {
  it("asks nothing, deletes nothing, and prints what was left with its paths", async () => {
    const fx = makeFixture();
    const { io, log } = recorder(undefined);

    await runUninstall({ setupEnv: fx.setupEnv, state: fx.state, io });

    assert.deepEqual(log.questions, []);
    assert.ok(existsSync(fx.libraryRoot), "a piped run must delete nothing");
    assert.ok(existsSync(fx.projectsDir), "a piped run must delete nothing");
    assert.match(log.text(), /not a terminal/u);
    assert.ok(log.text().includes(fx.libraryRoot), "the library path must be printed");
    assert.ok(log.text().includes(fx.projectsDir), "the state path must be printed");
    assert.deepEqual(
      fx.calls.map((c) => c.bin),
      ["claude"],
      "unregistering still happens without a terminal"
    );
  });
});

// ── A daemon holds an open database handle (D10) ──────────────────────────────

function identity(projectDir: string, pid: number): DaemonIdentity {
  return { projectDir, version: "0.1.0", pid, startedAt: "2026-09-17T10:00:00.000Z" };
}

describe("uninstall: running daemons (D10)", () => {
  it("stops a running daemon before deleting its project's state", async () => {
    const fx = makeFixture();
    const projectDir = join(fx.tmp, "live-project");
    mkdirSync(projectDir);
    const stateDir = resolveProjectState(projectDir, fx.state).dir;
    mkdirSync(stateDir, { recursive: true });
    writeDaemonRecord(stateDir, { ...identity(projectDir, 4242), port: 51234 });

    const killed: number[] = [];
    const stopAll = (env: StateEnv): ReturnType<typeof stopAllDaemons> =>
      stopAllDaemons(env, {
        kill: (pid) => killed.push(pid),
        probe: () => Promise.resolve(killed.length === 0 ? identity(projectDir, 4242) : undefined),
        waitMs: 200,
        pollMs: 1,
      });

    const { io, log } = recorder(["n", "y"]);
    await runUninstall({ setupEnv: fx.setupEnv, state: fx.state, io, stopAll });

    assert.deepEqual(killed, [4242], "the daemon holding the database must be stopped first");
    assert.equal(existsSync(stateDir), false, "its state is removed once it is stopped");
    assert.equal(existsSync(fx.projectsDir), false);
    assert.match(log.text(), /stopped a daemon/u);
  });

  it("keeps the state of a project whose daemon cannot be stopped, and says why", async () => {
    const fx = makeFixture();
    const projectDir = join(fx.tmp, "stubborn-project");
    mkdirSync(projectDir);
    const stateDir = resolveProjectState(projectDir, fx.state).dir;
    mkdirSync(stateDir, { recursive: true });
    writeDaemonRecord(stateDir, { ...identity(projectDir, 4242), port: 51234 });

    // Signalled, but still answering: the handle is still open.
    const stopAll = (env: StateEnv): ReturnType<typeof stopAllDaemons> =>
      stopAllDaemons(env, {
        kill: () => undefined,
        probe: () => Promise.resolve(identity(projectDir, 4242)),
        waitMs: 20,
        pollMs: 1,
      });

    const { io, log } = recorder(["n", "y"]);
    await runUninstall({ setupEnv: fx.setupEnv, state: fx.state, io, stopAll });

    assert.ok(existsSync(stateDir), "never delete a database out from under a live process");
    assert.ok(existsSync(fx.projectsDir), "the projects directory survives with it");
    assert.equal(existsSync(join(fx.projectsDir, "project-a")), false, "the rest still goes");
    assert.match(log.text(), /still answering/u);
    assert.match(log.text(), /per-project state partly deleted/u);
  });
});
