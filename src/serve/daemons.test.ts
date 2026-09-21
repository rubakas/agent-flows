// Spec 042 V1 — a recorded daemon is only "live" once the probe agrees.
//
// The refusal branches here are the same three `stopProjectDaemon` enforces, and
// for the same reason: a pid the operating system has since handed to another
// process must never be reported as an agent-flows daemon, because the page
// puts a Stop button next to everything it calls live.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { writeDaemonRecord, type DaemonIdentity } from "../runtime/daemonRecord.js";
import { resolveProjectState } from "../runtime/projectState.js";

import { listDaemons } from "./daemons.js";

const cleanups: (() => void)[] = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

interface Home {
  stateHome: string;
  /** Record a daemon for a project directory under this throwaway state home. */
  record: (name: string, over?: { pid?: number; port?: number }) => string;
  /** The absolute project directory a recorded name resolves to. */
  projectDir: (name: string) => string;
}

function makeHome(): Home {
  const tmp = mkdtempSync(join(realpathSync(tmpdir()), "af-daemons-"));
  cleanups.push(() => rmSync(tmp, { recursive: true, force: true }));
  const stateHome = join(tmp, "home");
  const projectDir = (name: string): string => join(tmp, name);
  return {
    stateHome,
    projectDir,
    record: (name, over = {}) => {
      const dir = projectDir(name);
      mkdirSync(dir, { recursive: true });
      const stateDir = resolveProjectState(dir, { AGENT_FLOWS_HOME: stateHome }).dir;
      mkdirSync(stateDir, { recursive: true });
      writeDaemonRecord(stateDir, {
        projectDir: dir,
        version: "0.1.0",
        pid: over.pid ?? 4242,
        startedAt: "2026-09-21T10:00:00.000Z",
        port: over.port ?? 51111,
      });
      return stateDir;
    },
  };
}

function identity(over: Partial<DaemonIdentity>): DaemonIdentity {
  return {
    projectDir: "/nowhere",
    version: "0.1.0",
    pid: 4242,
    startedAt: "2026-09-21T10:00:00.000Z",
    ...over,
  };
}

describe("GET /api/daemons enumeration (spec 042 FR-001, D3)", () => {
  it("reports a record whose port answers with the recorded pid and project as live", async () => {
    const home = makeHome();
    home.record("alpha");
    const [entry] = await listDaemons(home.stateHome, {
      probe: async () => identity({ pid: 4242, projectDir: home.projectDir("alpha") }),
    });
    assert.equal(entry.live, true);
    assert.equal(entry.pid, 4242);
    assert.equal(entry.port, 51111);
    assert.equal(entry.staleReason, undefined);
  });

  it("a record whose port answers with a DIFFERENT pid is not live (V1)", async () => {
    const home = makeHome();
    home.record("alpha", { pid: 4242 });
    const [entry] = await listDaemons(home.stateHome, {
      // The OS recycled 4242; port 51111 now belongs to pid 9999.
      probe: async () => identity({ pid: 9999, projectDir: home.projectDir("alpha") }),
    });
    assert.equal(
      entry.live,
      false,
      "a recycled pid must never be reported live — the page would offer a Stop wired to a stranger"
    );
    assert.match(entry.staleReason ?? "", /held by pid 9999, not the recorded 4242/u);
  });

  it("a record whose port answers for a DIFFERENT project is not live (V1)", async () => {
    const home = makeHome();
    home.record("alpha");
    const [entry] = await listDaemons(home.stateHome, {
      probe: async () => identity({ pid: 4242, projectDir: home.projectDir("beta") }),
    });
    assert.equal(
      entry.live,
      false,
      "a port serving another project is another project's daemon, not this record's"
    );
    assert.match(entry.staleReason ?? "", /serves .*beta, not .*alpha/u);
  });

  it("a record whose port answers nothing is reported stale, never omitted (V1)", async () => {
    const home = makeHome();
    home.record("alpha");
    const entries = await listDaemons(home.stateHome, { probe: async () => undefined });
    assert.equal(entries.length, 1, "a stale record is the thing the operator most needs to see");
    assert.equal(entries[0].live, false);
    assert.match(entries[0].staleReason ?? "", /nothing answered on port 51111/u);
  });

  it("lists every project on the machine, not just one (FR-001, D2)", async () => {
    const home = makeHome();
    home.record("alpha", { port: 51111, pid: 111 });
    home.record("beta", { port: 52222, pid: 222 });
    const entries = await listDaemons(home.stateHome, {
      probe: async (port) =>
        port === 51111
          ? identity({ pid: 111, projectDir: home.projectDir("alpha") })
          : identity({ pid: 222, projectDir: home.projectDir("beta") }),
    });
    assert.deepEqual(
      entries.map((e) => e.projectDir).sort(),
      [home.projectDir("alpha"), home.projectDir("beta")].sort()
    );
    assert.deepEqual(
      entries.map((e) => e.live),
      [true, true]
    );
  });

  it("marks the caller's own record self, and no other (D9)", async () => {
    const home = makeHome();
    home.record("alpha", { port: 51111, pid: 111 });
    home.record("beta", { port: 52222, pid: 222 });
    const entries = await listDaemons(home.stateHome, {
      probe: async () => undefined,
      self: { pid: 111, projectDir: home.projectDir("alpha") },
    });
    const selves = entries.filter((e) => e.self).map((e) => e.pid);
    assert.deepEqual(selves, [111]);
  });

  it("a project with no readable daemon.json contributes no row", async () => {
    const home = makeHome();
    const stateDir = home.record("alpha");
    writeFileSync(join(stateDir, "daemon.json"), "{ not json");
    assert.deepEqual(await listDaemons(home.stateHome, { probe: async () => undefined }), []);
  });

  it("an absent state home yields no daemons rather than an error", async () => {
    assert.deepEqual(await listDaemons("/nonexistent/agent-flows-home"), []);
  });
});
