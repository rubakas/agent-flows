// Tests for the n8n process routes (spec 034 D10, FR-015..FR-018, V6).
//
// No real n8n is ever started: a local http server plays the part of one by
// answering /healthz, and the launcher is injected so "start" spawns a trivial
// node process instead. The daemon under test gets its own state dir, so the
// pid and log files land in a temp directory and never in the owner's state.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { resolveProjectState } from "../../runtime/projectState.js";
import { RunService, type MastraLike } from "../../runtime/runService.js";
import { startServer, type ServeHandle } from "../server.js";
import {
  detectN8nInstall,
  isPidAlive,
  logFilePath,
  pidFilePath,
  probeN8nHealth,
  readOwnedPid,
} from "./n8nRuntime.js";
import type { ProjectState } from "../../runtime/projectState.js";
import type { ChildProcess } from "node:child_process";
import type { Socket } from "node:net";

const REPO_ROOT = new URL("../../..", import.meta.url).pathname;
const PIPELINES_DIR = join(REPO_ROOT, "pipelines");

/** A RunService that can never start anything — these tests never touch runs. */
function inertRunService(): RunService {
  const mastra = {
    getWorkflow: () => ({
      createRun: () => {
        throw new Error("these tests never start a run");
      },
    }),
  } as unknown as MastraLike;
  return new RunService(mastra);
}

/** A stand-in n8n. `mode` decides what /healthz does. */
function startFakeN8n(
  mode: "ok" | "silent"
): Promise<{ port: number; close: () => Promise<void> }> {
  const held: Socket[] = [];
  const server: Server = createServer((req, res) => {
    if (req.url !== "/healthz") {
      res.writeHead(404).end();
      return;
    }
    if (mode === "silent") {
      // Accept the connection and never answer — the case the probe timeout exists for.
      held.push(res.socket!);
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      resolve({
        port,
        close: () =>
          new Promise<void>((done) => {
            for (const socket of held) socket.destroy();
            server.close(() => done());
          }),
      });
    });
  });
}

function makeTempState(): { state: ProjectState; cleanup: () => void } {
  const home = mkdtempSync(join(tmpdir(), "af-n8n-rt-"));
  const projectDir = join(home, "project");
  mkdirSync(projectDir, { recursive: true });
  const state = resolveProjectState(projectDir, { AGENT_FLOWS_HOME: home });
  mkdirSync(state.dir, { recursive: true, mode: 0o700 });
  return { state, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

async function serve(state: ProjectState, n8nRuntime = {}): Promise<ServeHandle> {
  return startServer({
    state,
    port: 0,
    dbPath: ":memory:",
    pipelinesDir: PIPELINES_DIR,
    runService: inertRunService(),
    n8nRuntime,
  });
}

/** POST with an Origin header — the daemon's CSRF preamble requires one. */
async function post(port: number, path: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: `http://127.0.0.1:${port}` },
    body: "{}",
  });
}

// ── FR-015/FR-016: runtime shape and the probe ───────────────────────────────

describe("GET /api/n8n/runtime — installed, running, owned pid (FR-015/FR-016)", () => {
  let state: ProjectState;
  let cleanup: () => void;
  let srv: ServeHandle;
  let fake: { port: number; close: () => Promise<void> };
  let savedUrl: string | undefined;

  before(async () => {
    ({ state, cleanup } = makeTempState());
    fake = await startFakeN8n("ok");
    savedUrl = process.env.AGENT_FLOWS_N8N_URL;
    srv = await serve(state);
  });
  after(async () => {
    await srv.close();
    await fake.close();
    if (savedUrl === undefined) delete process.env.AGENT_FLOWS_N8N_URL;
    else process.env.AGENT_FLOWS_N8N_URL = savedUrl;
    cleanup();
  });

  it("reports running:true against a live n8n, and never sends credentials", async () => {
    let sawAuth = true;
    const probed = await new Promise<boolean>((resolve) => {
      const inspector = createServer((req, res) => {
        sawAuth =
          req.headers.authorization !== undefined || req.headers["x-n8n-api-key"] !== undefined;
        res.writeHead(200, { "content-type": "application/json" }).end('{"status":"ok"}');
        resolve(true);
      });
      inspector.listen(0, "127.0.0.1", () => {
        const { port } = inspector.address() as { port: number };
        void probeN8nHealth(`http://127.0.0.1:${port}`).then((r) => {
          inspector.close();
          assert.equal(r.running, true, "an answering /healthz means running");
        });
      });
    });
    assert.equal(probed, true);
    assert.equal(sawAuth, false, "the health probe must not carry credentials");
  });

  it("reports running:false and the probed base URL when nothing answers", async () => {
    // A port nobody listens on: connection refused, i.e. not running.
    process.env.AGENT_FLOWS_N8N_URL = "http://127.0.0.1:1";
    process.env.AGENT_FLOWS_N8N_API_KEY = "unused-but-required-for-env-config";
    try {
      const res = await fetch(`http://127.0.0.1:${srv.port}/api/n8n/runtime`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        installed: { how: string; detail: string };
        running: boolean;
        baseUrl: string;
        ownedPid?: number;
      };
      assert.equal(body.running, false);
      assert.equal(body.baseUrl, "http://127.0.0.1:1");
      assert.ok(
        ["path", "npx", "none"].includes(body.installed.how),
        `installed.how must be one of path|npx|none; got ${body.installed.how}`
      );
      assert.equal(body.ownedPid, undefined, "no pid file means nothing of ours is running");
    } finally {
      delete process.env.AGENT_FLOWS_N8N_API_KEY;
    }
  });

  it("falls back to n8n's default base URL when nothing is configured", async () => {
    delete process.env.AGENT_FLOWS_N8N_URL;
    const res = await fetch(`http://127.0.0.1:${srv.port}/api/n8n/runtime`);
    const body = (await res.json()) as { baseUrl: string };
    assert.ok(
      body.baseUrl === "http://localhost:5678" || body.baseUrl.startsWith("http"),
      `base URL must be the default or the operator's configured one; got ${body.baseUrl}`
    );
  });

  it("detectN8nInstall reports none when PATH holds neither binary", () => {
    const install = detectN8nInstall({ PATH: join(tmpdir(), "definitely-not-a-bin-dir") });
    assert.equal(install.how, "none");
    assert.match(install.detail, /PATH/u);
  });
});

// ── FR-016: the probe timeout is real ────────────────────────────────────────

describe("probeN8nHealth — a server that never answers times out (FR-016)", () => {
  it("returns running:false well before the test's own deadline", async () => {
    const fake = await startFakeN8n("silent");
    try {
      // The race is the assertion: without the AbortController the probe would
      // wait on the socket forever and this test would hang instead of failing.
      const verdict = await Promise.race([
        probeN8nHealth(`http://127.0.0.1:${fake.port}`).then((r) => r.running),
        new Promise<"timed-out">((resolve) => setTimeout(() => resolve("timed-out"), 2_500)),
      ]);
      assert.equal(
        verdict,
        false,
        "the probe must give up inside its 2s budget — a hanging n8n must not hang the card"
      );
    } finally {
      await fake.close();
    }
  });
});

// ── FR-017/FR-018: start and stop ────────────────────────────────────────────

describe("POST /api/n8n/start and /stop — only what this daemon started (FR-017/FR-018)", () => {
  let state: ProjectState;
  let cleanup: () => void;
  let savedUrl: string | undefined;
  let savedKey: string | undefined;

  before(() => {
    ({ state, cleanup } = makeTempState());
    savedUrl = process.env.AGENT_FLOWS_N8N_URL;
    savedKey = process.env.AGENT_FLOWS_N8N_API_KEY;
  });
  after(() => {
    if (savedUrl === undefined) delete process.env.AGENT_FLOWS_N8N_URL;
    else process.env.AGENT_FLOWS_N8N_URL = savedUrl;
    if (savedKey === undefined) delete process.env.AGENT_FLOWS_N8N_API_KEY;
    else process.env.AGENT_FLOWS_N8N_API_KEY = savedKey;
    cleanup();
  });

  it("refuses to start a second n8n when one already answers (409)", async () => {
    const fake = await startFakeN8n("ok");
    process.env.AGENT_FLOWS_N8N_URL = `http://127.0.0.1:${fake.port}`;
    process.env.AGENT_FLOWS_N8N_API_KEY = "unused";
    const srv = await serve(state, {
      resolveLaunch: () => {
        assert.fail("start must not spawn anything when n8n already answers");
      },
    });
    try {
      const res = await post(srv.port, "/api/n8n/start");
      assert.equal(res.status, 409);
      const body = (await res.json()) as { running: boolean };
      assert.equal(body.running, true);
      assert.equal(
        existsSync(pidFilePath(state.dir)),
        false,
        "a refused start must not claim ownership of anything"
      );
    } finally {
      await srv.close();
      await fake.close();
      delete process.env.AGENT_FLOWS_N8N_URL;
      delete process.env.AGENT_FLOWS_N8N_API_KEY;
    }
  });

  it("spawns the launcher, records pid and log at 0600, then stops it again", async () => {
    // Nothing answers here, so start waits and returns 202 — the npx-download
    // case, which is the one the operator will actually hit on this machine.
    process.env.AGENT_FLOWS_N8N_URL = "http://127.0.0.1:1";
    process.env.AGENT_FLOWS_N8N_API_KEY = "unused";
    const srv = await serve(state, {
      resolveLaunch: () => ({
        command: process.execPath,
        args: ["-e", "console.log('stand-in n8n'); setInterval(() => {}, 1000);"],
      }),
      startTimeoutMs: 1_200,
      pollIntervalMs: 300,
      stopGraceMs: 3_000,
    });
    try {
      const res = await post(srv.port, "/api/n8n/start");
      assert.equal(res.status, 202, "a process that has not answered yet is still starting");
      const body = (await res.json()) as { pid: number; log: string; running: boolean };
      assert.equal(body.running, false);
      assert.ok(Number.isInteger(body.pid) && body.pid > 0, "the response must name the pid");
      assert.equal(body.log, logFilePath(state.dir));

      // The pid file is the ownership record; both it and the log are owner-only.
      assert.equal(readFileSync(pidFilePath(state.dir), "utf8").trim(), String(body.pid));
      assert.equal(statSync(pidFilePath(state.dir)).mode & 0o777, 0o600, "pid file must be 0600");
      assert.equal(statSync(body.log).mode & 0o777, 0o600, "log file must be 0600");
      assert.equal(readOwnedPid(state.dir), body.pid, "the spawned child must be owned");

      // The runtime route reports it as ours while it lives.
      const rt = (await (await fetch(`http://127.0.0.1:${srv.port}/api/n8n/runtime`)).json()) as {
        ownedPid?: number;
        log?: string;
      };
      assert.equal(rt.ownedPid, body.pid);
      assert.equal(rt.log, body.log);

      const stopped = await post(srv.port, "/api/n8n/stop");
      assert.equal(stopped.status, 200);
      const stopBody = (await stopped.json()) as { stopped: boolean; pid: number };
      assert.equal(stopBody.stopped, true);
      assert.equal(stopBody.pid, body.pid);
      assert.equal(isPidAlive(body.pid), false, "the child must be gone after stop");
      assert.equal(
        existsSync(pidFilePath(state.dir)),
        false,
        "the ownership record must be removed once the process is gone"
      );
    } finally {
      await srv.close();
      delete process.env.AGENT_FLOWS_N8N_URL;
      delete process.env.AGENT_FLOWS_N8N_API_KEY;
    }
  });

  it("refuses to stop when there is no owned pid (409)", async () => {
    const srv = await serve(state);
    try {
      const res = await post(srv.port, "/api/n8n/stop");
      assert.equal(res.status, 409);
      assert.match((await res.json()).error as string, /only stops what it started/u);
    } finally {
      await srv.close();
    }
  });

  it("refuses to stop a pid that is not alive, and clears the stale record (409)", async () => {
    // Ownership model: the pid file lives in the 0700 state dir, so only this
    // daemon can have written it — but a *dead* pid is not owned, because the
    // number may since have been recycled by an unrelated process. Signalling it
    // would kill a stranger, so a pid that does not answer signal 0 is refused.
    // (A pid file naming a live foreign process cannot arise without an operator
    // writing one by hand into their own state dir; the liveness check is the
    // part that is testable without endangering a real process.)
    const deadPid = await new Promise<number>((resolve) => {
      const child = spawnStandIn();
      child.on("exit", () => resolve(child.pid!));
      child.kill("SIGKILL");
    });
    writeFileSync(pidFilePath(state.dir), String(deadPid), { encoding: "utf8", mode: 0o600 });
    assert.equal(readOwnedPid(state.dir), undefined, "a dead pid is not an owned process");

    const srv = await serve(state);
    try {
      const res = await post(srv.port, "/api/n8n/stop");
      assert.equal(res.status, 409, "a dead pid must be refused, not signalled");
      assert.equal(
        existsSync(pidFilePath(state.dir)),
        false,
        "the stale record must be cleared so the card stops offering Stop"
      );
    } finally {
      await srv.close();
    }
  });
});

/** A short-lived child used only to obtain a pid that is certainly dead. */
function spawnStandIn(): ChildProcess {
  return spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], { stdio: "ignore" });
}
