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
  formatRunProgress,
  getRunState,
  pollRunUntilTerminal,
  runPipeline,
  startRun,
} from "./daemonTools.js";
import type { DaemonRunState } from "./daemonTools.js";

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
      progress: string;
      steps: Record<string, unknown>[];
      cancelled?: { at: string; reason?: string };
    };
    assert.equal(out.status, "cancelled");
    assert.equal(
      out.progress,
      "develop · cancelled · 2 steps · 5s",
      "get_run must carry the one-line progress summary beside the steps array"
    );
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

  it("forwards outputTruncated so a cut excerpt is never read as the whole output", async () => {
    handler = (_req, res) => {
      respondJson(res, 200, {
        runId: "run-3b",
        pipelineId: "develop",
        status: "succeeded",
        steps: {
          "develop.big": {
            status: "succeeded",
            outputExcerpt: "x".repeat(16),
            outputTruncated: true,
          },
          "develop.small": { status: "succeeded", outputExcerpt: '{"ok":true}' },
        },
      });
    };

    const out = (await getRunState("run-3b")) as { steps: Record<string, unknown>[] };
    const big = out.steps.find((s) => s.id === "develop.big");
    const small = out.steps.find((s) => s.id === "develop.small");
    assert.equal(
      big?.outputTruncated,
      true,
      "get_run must tell the caller the excerpt is a prefix of a longer output"
    );
    assert.equal(
      "outputTruncated" in (small ?? {}),
      false,
      "an untruncated excerpt must carry no truncation flag at all"
    );
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

describe("start_run — starts the run without blocking on it", () => {
  it("returns the runId and status 'running' after one POST, with no poll GET", async () => {
    // Counted separately so a reintroduced poll is observable: the fake daemon
    // answers a GET, so the only thing keeping the count at zero is start_run
    // not asking for the run's state.
    let posts = 0;
    let gets = 0;
    let seenBody = "";
    handler = (req, res) => {
      if (req.method === "GET") {
        gets += 1;
        respondJson(res, 200, { runId: "run-10", pipelineId: "develop", status: "succeeded" });
        return;
      }
      posts += 1;
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        seenBody = Buffer.concat(chunks).toString("utf8");
        respondJson(res, 200, { runId: "run-10" });
      });
    };

    const out = await startRun({
      pipeline: "develop",
      inputs: { plan: "ship it" },
      gateMode: "auto",
      artifact_path: "/tmp/spec.json",
    });

    assert.deepEqual(out, { runId: "run-10", status: "running" });
    assert.equal(posts, 1, "start_run must start the run exactly once");
    assert.equal(gets, 0, "start_run must not poll — the caller drives progress with get_run");
    assert.deepEqual(JSON.parse(seenBody), {
      pipeline: "develop",
      inputs: { plan: "ship it" },
      gateMode: "auto",
      artifactPath: "/tmp/spec.json",
    });
  });

  it("surfaces the daemon's error when the POST is refused", async () => {
    handler = (_req, res) => {
      respondJson(res, 400, { error: "unknown pipeline 'nope'" });
    };

    const out = (await startRun({ pipeline: "nope" })) as { error: string };
    assert.deepEqual(out, { error: "unknown pipeline 'nope'" });
  });
});

describe("run_pipeline — still blocks until the run is terminal", () => {
  it("polls after the POST and returns the terminal state", async () => {
    let gets = 0;
    handler = (req, res) => {
      if (req.method === "GET") {
        gets += 1;
        respondJson(res, 200, {
          runId: "run-11",
          pipelineId: "develop",
          status: gets === 1 ? "running" : "succeeded",
          result: { ok: true },
        });
        return;
      }
      req.resume();
      req.on("end", () => respondJson(res, 200, { runId: "run-11" }));
    };

    const out = await runPipeline({ pipeline: "develop", inputs: { plan: "ship it" } });
    assert.deepEqual(out, { runId: "run-11", status: "succeeded", result: { ok: true } });
    assert.equal(gets, 2, "run_pipeline must poll through 'running' and stop at 'succeeded'");
  });

  it("surfaces the daemon's error without polling when the POST is refused", async () => {
    let gets = 0;
    handler = (req, res) => {
      if (req.method === "GET") {
        gets += 1;
        respondJson(res, 200, { runId: "run-12", pipelineId: "develop", status: "succeeded" });
        return;
      }
      respondJson(res, 500, {});
    };

    const out = (await runPipeline({ pipeline: "develop" })) as { error: string };
    assert.match(out.error, /HTTP 500/);
    assert.equal(gets, 0, "a run that never started has nothing to poll");
  });
});

// ── The one-line progress summary get_run hands a chat client ────────────────

describe("formatRunProgress — the glanceable line", () => {
  /** 2026-09-21T10:00:00Z, so every case below reads as a literal offset from it. */
  const T0 = Date.parse("2026-09-21T10:00:00.000Z");
  const at = (offsetMs: number): string => new Date(T0 + offsetMs).toISOString();

  const midRun: DaemonRunState = {
    runId: "r1",
    pipelineId: "code-review",
    status: "running",
    invocation: { startedAt: at(0) },
    steps: {
      scope: { status: "succeeded", startedAt: at(0), finishedAt: at(30_000) },
      read: { status: "succeeded", startedAt: at(30_000), finishedAt: at(70_000) },
      judge: { status: "succeeded", startedAt: at(70_000), finishedAt: at(120_000) },
      verify: { status: "running", startedAt: at(120_000) },
      report: { status: "pending" },
      finish: { status: "pending" },
    },
  };

  it("names the running step and its position, and counts elapsed to now", () => {
    assert.equal(formatRunProgress(midRun, T0 + 192_000), "code-review · verify (4 of 6) · 3m12s");
  });

  it("excludes synthetic __merge_level_* entries from the position and the count", () => {
    const withMerges: DaemonRunState = {
      ...midRun,
      steps: {
        scope: { status: "succeeded", startedAt: at(0), finishedAt: at(30_000) },
        __merge_level_1: { status: "succeeded", startedAt: at(30_000), finishedAt: at(30_001) },
        read: { status: "succeeded", startedAt: at(30_000), finishedAt: at(70_000) },
        judge: { status: "succeeded", startedAt: at(70_000), finishedAt: at(120_000) },
        __merge_level_4: { status: "succeeded", startedAt: at(120_000), finishedAt: at(120_001) },
        verify: { status: "running", startedAt: at(120_000) },
        report: { status: "pending" },
        finish: { status: "pending" },
      },
    };
    assert.equal(
      formatRunProgress(withMerges, T0 + 192_000),
      "code-review · verify (4 of 6) · 3m12s",
      "the two synthetic ids must change neither N nor M"
    );
  });

  it("falls back to the last finished step while a run is between steps", () => {
    const between: DaemonRunState = {
      ...midRun,
      steps: {
        scope: { status: "succeeded", startedAt: at(0), finishedAt: at(30_000) },
        read: { status: "succeeded", startedAt: at(30_000), finishedAt: at(70_000) },
        judge: { status: "pending" },
      },
    };
    assert.equal(formatRunProgress(between, T0 + 71_000), "code-review · read (2 of 3) · 1m11s");
  });

  it("states the outcome and the step count once the run has stopped", () => {
    const done: DaemonRunState = {
      runId: "r1",
      pipelineId: "code-review",
      status: "succeeded",
      invocation: { startedAt: at(0) },
      steps: {
        scope: { status: "succeeded", startedAt: at(0), finishedAt: at(30_000) },
        read: { status: "succeeded", startedAt: at(30_000), finishedAt: at(70_000) },
        judge: { status: "succeeded", startedAt: at(70_000), finishedAt: at(120_000) },
        verify: { status: "succeeded", startedAt: at(120_000), finishedAt: at(180_000) },
        report: { status: "succeeded", startedAt: at(180_000), finishedAt: at(220_000) },
        finish: { status: "succeeded", startedAt: at(220_000), finishedAt: at(241_000) },
      },
    };
    assert.equal(
      formatRunProgress(done, T0 + 9_999_999),
      "code-review · succeeded · 6 steps · 4m01s",
      "a stopped run's elapsed time freezes at its last finishedAt, not at now"
    );
  });

  it("says '1 step' for a single-step run", () => {
    const solo: DaemonRunState = {
      runId: "r2",
      pipelineId: "investigate",
      status: "succeeded",
      invocation: { startedAt: at(0) },
      steps: { look: { status: "succeeded", startedAt: at(0), finishedAt: at(8_000) } },
    };
    assert.equal(formatRunProgress(solo, T0 + 60_000), "investigate · succeeded · 1 step · 8s");
  });

  it("renders no cost segment, because the run state carries no cost", () => {
    for (const line of [
      formatRunProgress(midRun, T0 + 192_000),
      formatRunProgress({ ...midRun, status: "failed" }, T0 + 192_000),
    ]) {
      assert.ok(!line.includes("$"), `no cost is available, so none may be shown: ${line}`);
    }
  });

  it("uses the hour form past an hour and says 'starting' before any step reports", () => {
    assert.equal(
      formatRunProgress(midRun, T0 + 3_840_000),
      "code-review · verify (4 of 6) · 1h04m"
    );
    assert.equal(
      formatRunProgress(
        { runId: "r3", pipelineId: "ship", status: "running", invocation: { startedAt: at(0) } },
        T0 + 5_000
      ),
      "ship · starting · 5s"
    );
  });
});
