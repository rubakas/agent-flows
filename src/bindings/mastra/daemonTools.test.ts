// Tests for the MCP run tools' daemon proxies (spec 033 FR-007/FR-010, V3).
//
// A real loopback HTTP server stands in for the daemon so the proxies exercise
// their actual fetch/status handling rather than a stubbed transport.

import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { packageVersion } from "../../packageRoot.js";
import { clearDaemonBaseCache } from "./daemonResolver.js";
import {
  TERMINAL_RUN_STATUSES,
  cancelRun,
  getRunState,
  pollRunUntilTerminal,
} from "./daemonTools.js";

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

let server: Server;
let handler: Handler;
let previousPort: string | undefined;
let previousHome: string | undefined;
let tmpHome: string;

before(async () => {
  server = createServer((req, res) => {
    // The fake daemon must pass the spec 038 FR-013 identity handshake, or the
    // proxies' resolver would (correctly) treat it as someone else's daemon and
    // try to auto-start a real one.
    if (req.url === "/api/daemon") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          projectDir: process.cwd(),
          version: packageVersion(),
          pid: process.pid,
          startedAt: new Date().toISOString(),
        })
      );
      return;
    }
    handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as { port: number };
  previousPort = process.env.AGENT_FLOWS_PORT;
  process.env.AGENT_FLOWS_PORT = String(port);
  // Keep the resolver's state-dir reads off the owner's real ~/.agent-flows.
  previousHome = process.env.AGENT_FLOWS_HOME;
  tmpHome = mkdtempSync(join(realpathSync(tmpdir()), "af-daemon-tools-"));
  process.env.AGENT_FLOWS_HOME = tmpHome;
  clearDaemonBaseCache();
});

after(async () => {
  if (previousPort === undefined) delete process.env.AGENT_FLOWS_PORT;
  else process.env.AGENT_FLOWS_PORT = previousPort;
  if (previousHome === undefined) delete process.env.AGENT_FLOWS_HOME;
  else process.env.AGENT_FLOWS_HOME = previousHome;
  clearDaemonBaseCache();
  rmSync(tmpHome, { recursive: true, force: true });
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function respondJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

describe("cancel_run — proxies POST /api/runs/:id/cancel (FR-007)", () => {
  it("returns status 'cancelled' on 204 and forwards the reason", async () => {
    let seenPath = "";
    let seenBody = "";
    handler = (req, res) => {
      seenPath = req.url ?? "";
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        seenBody = Buffer.concat(chunks).toString("utf8");
        res.writeHead(204).end();
      });
    };

    const out = await cancelRun("run-1", "operator stopped it");
    assert.deepEqual(out, { runId: "run-1", status: "cancelled" });
    assert.equal(seenPath, "/api/runs/run-1/cancel");
    assert.deepEqual(JSON.parse(seenBody), { reason: "operator stopped it" });
  });

  it("surfaces a 409 as an error naming the run's current status", async () => {
    handler = (_req, res) => {
      respondJson(res, 409, {
        error: "Run run-2 cannot be cancelled (status: succeeded)",
        status: "succeeded",
      });
    };

    const out = (await cancelRun("run-2")) as { error: string };
    assert.ok(out.error, "a refused cancel must be reported as an error");
    assert.match(out.error, /succeeded/, "the error must name the blocking status");
  });
});

describe("get_run — forwards per-step progress (D3/V3)", () => {
  it("returns the daemon's steps as an array with timestamps and errors", async () => {
    handler = (_req, res) => {
      respondJson(res, 200, {
        runId: "run-3",
        pipelineId: "develop",
        status: "cancelled",
        steps: {
          "develop.code": {
            status: "cancelled",
            startedAt: "2026-09-13T10:00:00.000Z",
            finishedAt: "2026-09-13T10:00:05.000Z",
            outputExcerpt: '{"ok":true}',
          },
          "develop.test": { status: "failed", error: "exit 1" },
        },
        cancelled: { at: "2026-09-13T10:00:05.000Z", reason: "stopped" },
      });
    };

    const out = (await getRunState("run-3")) as {
      status: string;
      steps: Record<string, unknown>[];
      cancelled?: { at: string; reason?: string };
    };
    assert.equal(out.status, "cancelled");
    assert.deepEqual(out.cancelled, { at: "2026-09-13T10:00:05.000Z", reason: "stopped" });
    assert.deepEqual(out.steps, [
      {
        id: "develop.code",
        status: "cancelled",
        startedAt: "2026-09-13T10:00:00.000Z",
        finishedAt: "2026-09-13T10:00:05.000Z",
        outputExcerpt: '{"ok":true}',
      },
      { id: "develop.test", status: "failed", error: "exit 1" },
    ]);
  });

  it("returns an empty steps array when the daemon reports no steps yet", async () => {
    handler = (_req, res) => {
      respondJson(res, 200, { runId: "run-4", pipelineId: "develop", status: "running" });
    };
    const out = (await getRunState("run-4")) as { steps: unknown[] };
    assert.deepEqual(out.steps, []);
  });

  it("carries the invocation and per-step model/command, but never the prompt (D6)", async () => {
    handler = (_req, res) => {
      respondJson(res, 200, {
        runId: "run-5",
        pipelineId: "develop",
        status: "succeeded",
        invocation: {
          pipeline: "develop",
          inputs: { plan: "ship it" },
          gateMode: "manual",
          startedAt: "2026-09-13T10:00:00.000Z",
          source: "http",
        },
        steps: {
          "develop.code": {
            status: "succeeded",
            model: "sonnet (cli:claude)",
            prompt: "a very long rendered prompt",
          },
          "develop.check": { status: "succeeded", command: "echo hello" },
        },
      });
    };

    const out = (await getRunState("run-5")) as {
      invocation?: Record<string, unknown>;
      steps: Record<string, unknown>[];
    };
    assert.equal(out.invocation?.pipeline, "develop");
    assert.deepEqual(out.invocation?.inputs, { plan: "ship it" });
    assert.deepEqual(out.steps, [
      { id: "develop.code", status: "succeeded", model: "sonnet (cli:claude)" },
      { id: "develop.check", status: "succeeded", command: "echo hello" },
    ]);
    assert.ok(
      !JSON.stringify(out).includes("rendered prompt"),
      "get_run must never forward prompt text to chat — D6"
    );
  });

  it("exposes no log, events, output or prompt key at any level (spec 036 FR-012)", async () => {
    handler = (_req, res) => {
      respondJson(res, 200, {
        runId: "run-6",
        pipelineId: "develop",
        status: "succeeded",
        steps: {
          "develop.code": {
            status: "succeeded",
            prompt: "a very long rendered prompt",
            outputExcerpt: '{"ok":true}',
          },
        },
      });
    };

    const forbidden = ["log", "events", "output", "prompt"];
    const out = (await getRunState("run-6")) as Record<string, unknown> & {
      steps: Record<string, unknown>[];
    };
    for (const key of forbidden) {
      assert.equal(key in out, false, `get_run must not expose "${key}" at the top level`);
      for (const step of out.steps) {
        assert.equal(key in step, false, `get_run must not expose "${key}" on a step`);
      }
    }
  });
});

describe("run_pipeline polling — 'cancelled' is terminal (FR-010)", () => {
  it("includes cancelled in the terminal set", () => {
    assert.equal(
      TERMINAL_RUN_STATUSES.has("cancelled"),
      true,
      "a cancelled run never resumes — leaving it out makes run_pipeline poll forever"
    );
  });

  it("stops polling when the daemon reports 'cancelled'", async () => {
    let calls = 0;
    handler = (_req, res) => {
      calls += 1;
      respondJson(res, 200, {
        runId: "run-5",
        pipelineId: "develop",
        status: calls === 1 ? "running" : "cancelled",
        cancelled: { at: "2026-09-13T10:00:05.000Z", reason: "stopped" },
      });
    };

    const out = await pollRunUntilTerminal("run-5", 1);
    assert.equal(calls, 2, "the poll must continue through 'running' and stop at 'cancelled'");
    assert.deepEqual(out, {
      runId: "run-5",
      status: "cancelled",
      cancelled: { at: "2026-09-13T10:00:05.000Z", reason: "stopped" },
    });
  });
});

describe("pollRunUntilTerminal — bounded wall clock (spec 033 review follow-up)", () => {
  it("gives up and throws naming the runId once the ceiling is passed", async () => {
    // A daemon that never advances the run. The assertion is raced against a
    // short timer so an unbounded poll fails the test in two seconds instead of
    // hanging the suite — the failure mode has to be visible, not silent.
    handler = (_req, res) => {
      respondJson(res, 200, { runId: "run-6", pipelineId: "develop", status: "running" });
    };

    const poll = pollRunUntilTerminal("run-6", 5, 30).then(
      () => ({ settled: true as const }),
      (err: Error) => ({ settled: false as const, err })
    );
    const outcome = await Promise.race([
      poll,
      new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 2_000)),
    ]);

    // Release a still-running poll so the process can exit either way.
    handler = (_req, res) => {
      respondJson(res, 200, { runId: "run-6", pipelineId: "develop", status: "failed" });
    };
    await poll;

    assert.notEqual(outcome, "hung", "an unbounded poll would hang the chat client forever");
    assert.ok(
      typeof outcome === "object" && !outcome.settled,
      "the poll must reject at the ceiling, not resolve"
    );
    assert.match(outcome.err.message, /run-6/, "the error must name the run");
    assert.match(outcome.err.message, /terminal status within 30ms/);
  });

  it("does not fire while the run is still advancing within the ceiling", async () => {
    let calls = 0;
    handler = (_req, res) => {
      calls += 1;
      respondJson(res, 200, {
        runId: "run-7",
        pipelineId: "develop",
        status: calls === 1 ? "running" : "succeeded",
        result: { ok: true },
      });
    };

    const out = await pollRunUntilTerminal("run-7", 1, 10_000);
    assert.deepEqual(out, { runId: "run-7", status: "succeeded", result: { ok: true } });
  });
});
