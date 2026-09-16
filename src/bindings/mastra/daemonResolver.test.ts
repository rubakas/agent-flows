// Tests for daemon resolution and auto-start (spec 038 FR-013/FR-014/FR-015).
//
// Fake daemons are real loopback HTTP servers answering GET /api/daemon, so the
// identity handshake runs over the wire exactly as it does in production. No
// test here spawns the real daemon; the spawn seam is injected and asserted on.

import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  daemonRecordPath,
  writeDaemonRecord,
  type DaemonIdentity,
} from "../../runtime/daemonRecord.js";
import { resolveProjectState } from "../../runtime/projectState.js";

import {
  DaemonVersionMismatchError,
  START_LOCK_FILE,
  acquireStartLock,
  daemonChildEnv,
  findOurDaemon,
  resolveDaemonPort,
} from "./daemonResolver.js";

const VERSION = "9.9.9-test";

interface Fixture {
  projectDir: string;
  stateDir: string;
  env: NodeJS.ProcessEnv;
  tmp: string;
}

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

function makeFixture(): Fixture {
  const tmp = mkdtempSync(join(realpathSync(tmpdir()), "af-resolver-"));
  const projectDir = join(tmp, "project");
  mkdirSync(projectDir);
  const env: NodeJS.ProcessEnv = { AGENT_FLOWS_HOME: join(tmp, "home") };
  const stateDir = resolveProjectState(projectDir, env).dir;
  cleanups.push(() => rmSync(tmp, { recursive: true, force: true }));
  return { projectDir, stateDir, env, tmp };
}

/** A loopback server answering GET /api/daemon with `identity`. */
async function startFakeDaemon(identity: Omit<DaemonIdentity, "pid">): Promise<{
  port: number;
  server: Server;
  identity: DaemonIdentity;
}> {
  const full: DaemonIdentity = { ...identity, pid: process.pid };
  const server = createServer((req, res) => {
    if (req.url === "/api/daemon") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(full));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });
  return { port, server, identity: full };
}

describe("findOurDaemon — the identity handshake decides (FR-013)", () => {
  it("finds a daemon on an ephemeral port through daemon.json, not a fixed port", async () => {
    const fx = makeFixture();
    const daemon = await startFakeDaemon({
      projectDir: fx.projectDir,
      version: VERSION,
      startedAt: new Date().toISOString(),
    });
    assert.notEqual(daemon.port, 7411, "the fixture must not be on the conventional port");
    writeDaemonRecord(fx.stateDir, { ...daemon.identity, port: daemon.port });

    const found = await findOurDaemon({
      projectDir: fx.projectDir,
      env: fx.env,
      version: VERSION,
    });
    assert.equal(found, daemon.port);
  });

  it("refuses a daemon serving a different project", async () => {
    const fx = makeFixture();
    const otherProject = join(fx.tmp, "other-project");
    mkdirSync(otherProject);
    const daemon = await startFakeDaemon({
      projectDir: otherProject,
      version: VERSION,
      startedAt: new Date().toISOString(),
    });
    writeDaemonRecord(fx.stateDir, { ...daemon.identity, port: daemon.port });

    const found = await findOurDaemon({
      projectDir: fx.projectDir,
      env: fx.env,
      version: VERSION,
    });
    assert.equal(found, undefined, "another project's daemon must never be reused");
  });

  it("reports a version mismatch by name instead of reusing or killing it", async () => {
    const fx = makeFixture();
    const daemon = await startFakeDaemon({
      projectDir: fx.projectDir,
      version: "0.0.1-old",
      startedAt: new Date().toISOString(),
    });
    writeDaemonRecord(fx.stateDir, { ...daemon.identity, port: daemon.port });

    await assert.rejects(
      () => findOurDaemon({ projectDir: fx.projectDir, env: fx.env, version: VERSION }),
      (err: unknown) => {
        assert.ok(err instanceof DaemonVersionMismatchError);
        assert.match(err.message, /0\.0\.1-old/u, "names the running version");
        assert.match(err.message, /9\.9\.9-test/u, "names the expected version");
        assert.match(err.message, /agent-flows stop/u, "tells the user how to resolve it");
        return true;
      }
    );
    assert.ok(daemon.server.listening, "the mismatched daemon must be left running");
  });

  it("ignores an unreadable record and an unanswered port", async () => {
    const fx = makeFixture();
    mkdirSync(fx.stateDir, { recursive: true });
    writeFileSync(daemonRecordPath(fx.stateDir), "{ not json");
    assert.equal(
      await findOurDaemon({ projectDir: fx.projectDir, env: fx.env, version: VERSION }),
      undefined
    );
  });
});

describe("resolveDaemonPort — auto-start (FR-014)", () => {
  it("starts a daemon when there is none and returns its port", async () => {
    const fx = makeFixture();
    let spawned = 0;
    const port = await resolveDaemonPort({
      projectDir: fx.projectDir,
      env: fx.env,
      version: VERSION,
      pollMs: 20,
      timeoutMs: 5_000,
      spawnDaemon: (projectDir) => {
        spawned += 1;
        void (async () => {
          const daemon = await startFakeDaemon({
            projectDir,
            version: VERSION,
            startedAt: new Date().toISOString(),
          });
          writeDaemonRecord(fx.stateDir, { ...daemon.identity, port: daemon.port });
        })();
      },
    });
    assert.equal(spawned, 1);
    assert.ok(port > 0);
  });

  it("the start lock lets exactly one of two racing resolvers spawn (FR-014)", async () => {
    const fx = makeFixture();
    let spawned = 0;
    const spawnDaemon = (projectDir: string): void => {
      spawned += 1;
      void (async () => {
        const daemon = await startFakeDaemon({
          projectDir,
          version: VERSION,
          startedAt: new Date().toISOString(),
        });
        writeDaemonRecord(fx.stateDir, { ...daemon.identity, port: daemon.port });
      })();
    };
    const opts = {
      projectDir: fx.projectDir,
      env: fx.env,
      version: VERSION,
      pollMs: 20,
      timeoutMs: 5_000,
      spawnDaemon,
    };

    const [a, b] = await Promise.all([resolveDaemonPort(opts), resolveDaemonPort(opts)]);
    assert.equal(spawned, 1, "two harnesses starting at once must not race two daemons up");
    assert.equal(a, b, "both resolvers must land on the same daemon");
    assert.equal(
      existsSync(join(fx.stateDir, START_LOCK_FILE)),
      false,
      "the lock must be released once the start finishes"
    );
  });

  it("leaves a foreign listener on the target port alone and still answering (FR-015)", async () => {
    const fx = makeFixture();
    // Something else — not a daemon — already owns the port we would probe.
    const foreign = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("not a daemon");
    });
    await new Promise<void>((r) => foreign.listen(0, "127.0.0.1", () => r()));
    const foreignPort = (foreign.address() as { port: number }).port;
    cleanups.push(async () => {
      foreign.closeAllConnections();
      await new Promise<void>((r) => foreign.close(() => r()));
    });

    const env = { ...fx.env, AGENT_FLOWS_PORT: String(foreignPort) };
    const port = await resolveDaemonPort({
      projectDir: fx.projectDir,
      env,
      version: VERSION,
      pollMs: 20,
      timeoutMs: 5_000,
      spawnDaemon: (projectDir, spawnEnv) => {
        assert.equal(
          spawnEnv.AGENT_FLOWS_PORT,
          String(foreignPort),
          "the spawn seam is handed the resolver's own environment; the strip happens inside it"
        );
        void (async () => {
          const daemon = await startFakeDaemon({
            projectDir,
            version: VERSION,
            startedAt: new Date().toISOString(),
          });
          writeDaemonRecord(fx.stateDir, { ...daemon.identity, port: daemon.port });
        })();
      },
    });

    assert.ok(port > 0);
    assert.ok(foreign.listening, "the foreign listener must still be listening, untouched");
    const stillForeign = await fetch(`http://127.0.0.1:${foreignPort}/`);
    assert.equal(await stillForeign.text(), "not a daemon");
  });

  it("fails with a message naming the project and what was tried", async () => {
    const fx = makeFixture();
    await assert.rejects(
      () =>
        resolveDaemonPort({
          projectDir: fx.projectDir,
          env: fx.env,
          version: VERSION,
          pollMs: 10,
          timeoutMs: 50,
          spawnDaemon: () => undefined,
        }),
      (err: unknown) => {
        const message = (err as Error).message;
        assert.match(message, new RegExp(fx.projectDir.replace(/[/\\]/gu, "\\$&"), "u"));
        assert.match(message, /daemon\.json/u);
        assert.match(message, /agent-flows serve/u);
        return true;
      }
    );
  });
});

describe("daemonChildEnv — what an auto-started daemon inherits (FR-012)", () => {
  it("drops AGENT_FLOWS_PORT so the daemon takes an ephemeral port", () => {
    const child = daemonChildEnv("/tmp/project", {
      AGENT_FLOWS_PORT: "7411",
      PATH: "/usr/bin",
    });
    assert.equal(
      child.AGENT_FLOWS_PORT,
      undefined,
      "a pinned port must not reach the auto-started daemon — it would collide with its holder"
    );
    assert.equal(child.AGENT_FLOWS_PROJECT_DIR, "/tmp/project");
    assert.equal(child.AGENT_FLOWS_AUTOSTART, "1");
    assert.equal(child.PATH, "/usr/bin", "the rest of the environment is passed through");
  });
});

describe("acquireStartLock — O_EXCL, with staleness (FR-014)", () => {
  it("the second caller loses while the lock is fresh", () => {
    const fx = makeFixture();
    mkdirSync(fx.stateDir, { recursive: true });
    const lockPath = join(fx.stateDir, START_LOCK_FILE);
    assert.equal(acquireStartLock(lockPath, 60_000), true);
    assert.equal(acquireStartLock(lockPath, 60_000), false);
    rmSync(lockPath, { force: true });
    assert.equal(acquireStartLock(lockPath, 60_000), true);
  });

  it("a lock left by a crashed starter is reclaimed once it is stale", () => {
    const fx = makeFixture();
    mkdirSync(fx.stateDir, { recursive: true });
    const lockPath = join(fx.stateDir, START_LOCK_FILE);
    assert.equal(acquireStartLock(lockPath, 60_000), true);
    assert.equal(acquireStartLock(lockPath, 60_000), false, "still fresh");
    // Age the lock past the staleness window, as a crashed starter's would be.
    const twoMinutesAgo = new Date(Date.now() - 120_000);
    utimesSync(lockPath, twoMinutesAgo, twoMinutesAgo);
    assert.equal(acquireStartLock(lockPath, 60_000), true);
  });
});
