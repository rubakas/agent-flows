// Tests for `agent-flows stop` / `stop --all` (spec 038 D9, FR-016).
//
// The kill seam is injected everywhere: a test that really signalled a pid it
// resolved from a fixture would be one bad path away from killing the test
// runner.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  daemonRecordPath,
  readDaemonRecord,
  writeDaemonRecord,
  type DaemonIdentity,
} from "../runtime/daemonRecord.js";
import { resolveProjectState } from "../runtime/projectState.js";

import {
  formatStopReport,
  listProjectStateDirs,
  stopAllDaemons,
  stopProjectDaemon,
} from "./stop.js";

const cleanups: (() => void)[] = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

interface Fixture {
  tmp: string;
  projectDir: string;
  stateDir: string;
  env: NodeJS.ProcessEnv;
}

function makeFixture(name = "project"): Fixture {
  const tmp = mkdtempSync(join(realpathSync(tmpdir()), "af-stop-"));
  const projectDir = join(tmp, name);
  mkdirSync(projectDir);
  const env: NodeJS.ProcessEnv = { AGENT_FLOWS_HOME: join(tmp, "home") };
  const stateDir = resolveProjectState(projectDir, env).dir;
  mkdirSync(stateDir, { recursive: true });
  cleanups.push(() => rmSync(tmp, { recursive: true, force: true }));
  return { tmp, projectDir, stateDir, env };
}

function identity(fx: Fixture, overrides: Partial<DaemonIdentity> = {}): DaemonIdentity {
  return {
    projectDir: fx.projectDir,
    version: "0.1.0",
    pid: 4242,
    startedAt: "2026-09-16T10:00:00.000Z",
    ...overrides,
  };
}

/** A kill spy that also makes the daemon "disappear" from the next probe. */
function killSpy(): {
  calls: [number, NodeJS.Signals][];
  kill: (p: number, s: NodeJS.Signals) => void;
} {
  const calls: [number, NodeJS.Signals][] = [];
  return { calls, kill: (p, s) => calls.push([p, s]) };
}

describe("stop — nothing recorded (FR-016)", () => {
  it("reports that no daemon was recorded", async () => {
    const fx = makeFixture();
    const spy = killSpy();
    const report = await stopProjectDaemon(fx.stateDir, {
      kill: spy.kill,
      probe: async () => undefined,
    });
    assert.equal(report.stopped, false);
    assert.match(report.reason, /no daemon\.json/u);
    assert.deepEqual(spy.calls, []);
  });
});

describe("stop — the identity handshake gates the kill (FR-016)", () => {
  it("never signals a recorded pid when nothing answers the port", async () => {
    const fx = makeFixture();
    writeDaemonRecord(fx.stateDir, { ...identity(fx), port: 51234 });
    const spy = killSpy();

    const report = await stopProjectDaemon(fx.stateDir, {
      kill: spy.kill,
      probe: async () => undefined,
    });

    assert.equal(report.stopped, false);
    assert.match(report.reason, /NOT signalled/u);
    assert.deepEqual(spy.calls, [], "a pid may have been recycled — it must not be killed");
    assert.ok(existsSync(daemonRecordPath(fx.stateDir)));
  });

  it("never signals when the port is held by a different pid", async () => {
    const fx = makeFixture();
    writeDaemonRecord(fx.stateDir, { ...identity(fx, { pid: 4242 }), port: 51234 });
    const spy = killSpy();

    const report = await stopProjectDaemon(fx.stateDir, {
      kill: spy.kill,
      probe: async () => identity(fx, { pid: 9999 }),
    });

    assert.equal(report.stopped, false);
    assert.match(report.reason, /9999/u);
    assert.deepEqual(spy.calls, []);
  });

  it("never signals when the daemon at that port serves another project", async () => {
    const fx = makeFixture();
    writeDaemonRecord(fx.stateDir, { ...identity(fx), port: 51234 });
    const spy = killSpy();

    const report = await stopProjectDaemon(fx.stateDir, {
      kill: spy.kill,
      probe: async () => identity(fx, { projectDir: join(fx.tmp, "somewhere-else") }),
    });

    assert.equal(report.stopped, false);
    assert.match(report.reason, /somewhere-else/u);
    assert.deepEqual(spy.calls, []);
  });
});

describe("stop — a verified daemon is terminated and forgotten (FR-016)", () => {
  it("sends SIGTERM, waits for it to go, and removes the record", async () => {
    const fx = makeFixture();
    writeDaemonRecord(fx.stateDir, { ...identity(fx), port: 51234 });
    const spy = killSpy();
    let alive = true;

    const report = await stopProjectDaemon(fx.stateDir, {
      kill: (pid, signal) => {
        spy.kill(pid, signal);
        alive = false;
      },
      probe: async () => (alive ? identity(fx) : undefined),
      pollMs: 5,
      waitMs: 500,
    });

    assert.equal(report.stopped, true, report.reason);
    assert.deepEqual(spy.calls, [[4242, "SIGTERM"]]);
    assert.equal(readDaemonRecord(fx.stateDir), undefined);
  });

  it("reports a daemon that ignored SIGTERM instead of claiming success", async () => {
    const fx = makeFixture();
    writeDaemonRecord(fx.stateDir, { ...identity(fx), port: 51234 });

    const report = await stopProjectDaemon(fx.stateDir, {
      kill: () => undefined,
      probe: async () => identity(fx),
      pollMs: 5,
      waitMs: 30,
    });

    assert.equal(report.stopped, false);
    assert.match(report.reason, /still answering/u);
  });
});

describe("stop --all — every project state directory (FR-016)", () => {
  it("visits each project and reports per project", async () => {
    const tmp = mkdtempSync(join(realpathSync(tmpdir()), "af-stop-all-"));
    cleanups.push(() => rmSync(tmp, { recursive: true, force: true }));
    const env: NodeJS.ProcessEnv = { AGENT_FLOWS_HOME: join(tmp, "home") };

    const alpha = join(tmp, "alpha");
    const beta = join(tmp, "beta");
    mkdirSync(alpha);
    mkdirSync(beta);
    const alphaState = resolveProjectState(alpha, env).dir;
    const betaState = resolveProjectState(beta, env).dir;
    mkdirSync(alphaState, { recursive: true });
    mkdirSync(betaState, { recursive: true });
    writeDaemonRecord(alphaState, {
      projectDir: alpha,
      version: "0.1.0",
      pid: 111,
      startedAt: "2026-09-16T10:00:00.000Z",
      port: 51111,
    });
    // beta has no record at all.

    const killed: number[] = [];
    const reports = await stopAllDaemons(env, {
      kill: (pid) => killed.push(pid),
      probe: async (port) =>
        port === 51111
          ? {
              projectDir: alpha,
              version: "0.1.0",
              pid: 111,
              startedAt: "2026-09-16T10:00:00.000Z",
            }
          : undefined,
      pollMs: 5,
      waitMs: 30,
    });

    assert.equal(reports.length, 2, "both project state dirs must be visited");
    assert.deepEqual(killed, [111], "only the project whose identity matched may be signalled");
    const stopped = reports.filter((r) => r.stopped);
    assert.equal(
      stopped.length,
      0,
      "alpha ignored SIGTERM in this fixture, so it is not 'stopped'"
    );
    assert.deepEqual(new Set(listProjectStateDirs(env)), new Set([alphaState, betaState]));
  });

  it("an absent state root yields no projects rather than an error", () => {
    assert.deepEqual(
      listProjectStateDirs({ AGENT_FLOWS_HOME: "/nonexistent/agent-flows-home" }),
      []
    );
  });
});

describe("formatStopReport", () => {
  it("says stopped or skipped, with the reason", () => {
    assert.equal(
      formatStopReport({ stateDir: "/s", stopped: true, reason: "stopped pid 5" }),
      "agent-flows stop: stopped /s: stopped pid 5"
    );
    assert.equal(
      formatStopReport({ stateDir: "/s", stopped: false, reason: "no daemon.json" }),
      "agent-flows stop: skipped /s: no daemon.json"
    );
  });
});
