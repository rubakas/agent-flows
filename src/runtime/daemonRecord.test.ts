// Tests for the daemon identity record and its probe (spec 038 FR-011/FR-013/FR-015).

import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { createServer as createNetServer, type Server as NetServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import {
  classifyIdentity,
  daemonRecordPath,
  probeDaemon,
  readDaemonRecord,
  removeDaemonRecordIfOwned,
  writeDaemonRecord,
  type DaemonIdentity,
} from "./daemonRecord.js";

function tmpStateDir(): string {
  return mkdtempSync(join(realpathSync(tmpdir()), "af-daemon-record-"));
}

const IDENTITY: DaemonIdentity = {
  projectDir: "/projects/alpha",
  version: "0.1.0",
  pid: 4242,
  startedAt: "2026-09-16T10:00:00.000Z",
};

describe("daemon.json — written at listen time, mode 0600 (FR-011)", () => {
  it("round-trips the identity plus the port", () => {
    const dir = join(tmpStateDir(), "nested");
    try {
      writeDaemonRecord(dir, { ...IDENTITY, port: 51234 });
      assert.deepEqual(readDaemonRecord(dir), { ...IDENTITY, port: 51234 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is not readable by group or other", () => {
    const dir = tmpStateDir();
    try {
      writeDaemonRecord(dir, { ...IDENTITY, port: 51234 });
      assert.equal(statSync(daemonRecordPath(dir)).mode & 0o777, 0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads as absent when missing, malformed, or the wrong shape", () => {
    const dir = tmpStateDir();
    try {
      assert.equal(readDaemonRecord(dir), undefined);
      writeFileSync(daemonRecordPath(dir), "{not json");
      assert.equal(readDaemonRecord(dir), undefined);
      writeFileSync(daemonRecordPath(dir), JSON.stringify({ projectDir: "/x", port: "7411" }));
      assert.equal(readDaemonRecord(dir), undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("record removal is pid-checked (FR-011)", () => {
  it("a process that does not own the record leaves it in place", () => {
    const dir = tmpStateDir();
    try {
      writeDaemonRecord(dir, { ...IDENTITY, pid: 111, port: 51234 });
      assert.equal(removeDaemonRecordIfOwned(dir, 222), false);
      assert.deepEqual(readDaemonRecord(dir)?.pid, 111, "a foreign pid must not delete the record");
      assert.equal(removeDaemonRecordIfOwned(dir, 111), true);
      assert.equal(readDaemonRecord(dir), undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a stale record replaced by a newer daemon survives the old daemon's exit path", () => {
    const dir = tmpStateDir();
    try {
      // The crashed daemon's record, then the live daemon's record over it.
      writeDaemonRecord(dir, { ...IDENTITY, pid: 111, port: 51234 });
      writeDaemonRecord(dir, { ...IDENTITY, pid: 222, port: 51999 });
      // The old daemon's exit handler finally runs.
      assert.equal(removeDaemonRecordIfOwned(dir, 111), false);
      assert.deepEqual(readDaemonRecord(dir), { ...IDENTITY, pid: 222, port: 51999 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("classifyIdentity — project and version are both required to match (FR-013)", () => {
  it("matches on an equal realpath and version", () => {
    const dir = tmpStateDir();
    try {
      assert.equal(
        classifyIdentity({ ...IDENTITY, projectDir: dir }, { projectDir: dir, version: "0.1.0" }),
        "match"
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a different project", () => {
    assert.equal(
      classifyIdentity(IDENTITY, { projectDir: "/projects/beta", version: "0.1.0" }),
      "other-project"
    );
  });

  it("rejects a different version", () => {
    assert.equal(
      classifyIdentity(IDENTITY, { projectDir: "/projects/alpha", version: "0.2.0" }),
      "other-version"
    );
  });

  it("two spellings of the same directory are the same project", () => {
    const base = tmpStateDir();
    try {
      const real = join(base, "project");
      const link = join(base, "link-to-project");
      mkdirSync(real);
      symlinkSync(real, link);
      assert.equal(
        classifyIdentity({ ...IDENTITY, projectDir: link }, { projectDir: real, version: "0.1.0" }),
        "match",
        "a symlinked spelling of the project must not read as a different project"
      );
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("probeDaemon — only our shape counts (FR-015)", () => {
  let ours: Server;
  let foreign: Server;
  let silent: NetServer;
  let oursPort = 0;
  let foreignPort = 0;
  let silentPort = 0;
  const sockets: Socket[] = [];

  before(async () => {
    ours = createServer((req, res) => {
      if (req.url === "/api/daemon") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(IDENTITY));
        return;
      }
      res.writeHead(404).end();
    });
    foreign = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ hello: "some other web app" }));
    });
    silent = createNetServer();
    // A probe against a socket that never answers leaves the connection open;
    // net.Server.close() waits for those, so they are tracked and destroyed.
    silent.on("connection", (socket) => sockets.push(socket));
    await new Promise<void>((r) => ours.listen(0, "127.0.0.1", () => r()));
    await new Promise<void>((r) => foreign.listen(0, "127.0.0.1", () => r()));
    await new Promise<void>((r) => silent.listen(0, "127.0.0.1", () => r()));
    oursPort = (ours.address() as { port: number }).port;
    foreignPort = (foreign.address() as { port: number }).port;
    silentPort = (silent.address() as { port: number }).port;
  });

  after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((r) => ours.close(() => r()));
    await new Promise<void>((r) => foreign.close(() => r()));
    await new Promise<void>((r) => silent.close(() => r()));
  });

  it("returns the identity from a daemon that answers our shape", async () => {
    assert.deepEqual(await probeDaemon(oursPort), IDENTITY);
  });

  it("returns undefined for a listener that is not a daemon", async () => {
    assert.equal(await probeDaemon(foreignPort), undefined);
  });

  it("returns undefined for a socket that never answers, within the timeout", async () => {
    assert.equal(await probeDaemon(silentPort, 300), undefined);
  });

  it("returns undefined when nothing is listening", async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((r) => silent.close(() => r()));
    assert.equal(await probeDaemon(silentPort, 300), undefined);
    silent = createNetServer();
    silent.on("connection", (socket) => sockets.push(socket));
    await new Promise<void>((r) => silent.listen(silentPort, "127.0.0.1", () => r()));
  });
});
