// Tests for the MCP run tools' daemon proxies (spec 033 FR-007/FR-010, V3).
//
// A real loopback HTTP server stands in for the daemon so the proxies exercise
// their actual fetch/status handling rather than a stubbed transport.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { packageVersion } from "../../packageRoot.js";
import { resolveProjectState } from "../../runtime/projectState.js";
import { clearDaemonBaseCache } from "./daemonResolver.js";
import {
  LIFECYCLE_KINDS,
  TERMINAL_RUN_STATUSES,
  approveRun,
  cancelRun,
  formatRunProgress,
  getRunEvents,
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

/** The fake daemon's own base, for the push handles the tools derive from it. */
function daemonBase(): string {
  return `http://127.0.0.1:${process.env.AGENT_FLOWS_PORT}`;
}

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

describe("get_run verbose:true — forwards per-step progress (D3/V3)", () => {
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

    const out = (await getRunState("run-3", true)) as {
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

    const out = (await getRunState("run-3b", true)) as { steps: Record<string, unknown>[] };
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
    const out = (await getRunState("run-4", true)) as { steps: unknown[] };
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

    const out = (await getRunState("run-5", true)) as {
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
    const out = (await getRunState("run-6", true)) as Record<string, unknown> & {
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

describe("get_run — compact by default, full only on verbose:true", () => {
  // Sized from a real run: invocation.inputs of 1191 + 2109 chars, an
  // outputExcerpt at OUTPUT_EXCERPT_LIMIT (2048) on every step, and a gate spec
  // of 28k chars — the three things that made polling cost thousands of tokens.
  const realisticRun = {
    runId: "run-compact",
    pipelineId: "code-review",
    status: "awaiting_approval",
    gateMessage: "Approve the review?",
    spec: "S".repeat(28_000),
    artifactPath: "/tmp/af/runs/run-compact/artifact.md",
    eventsPath: "/tmp/af/runs/run-compact/code-review.events.jsonl",
    result: { verdict: "R".repeat(4_000) },
    invocation: {
      pipeline: "code-review",
      startedAt: "2026-09-24T10:00:00.000Z",
      gateMode: "manual",
      inputs: { brief: "b".repeat(1_191), baseline: "c".repeat(2_109) },
    },
    steps: Object.fromEntries(
      ["gather", "read", "analyse", "verify", "write", "grade"].map((id, i) => [
        `code-review.${id}`,
        {
          status: i === 5 ? "failed" : "succeeded",
          startedAt: "2026-09-24T10:00:00.000Z",
          finishedAt: "2026-09-24T10:01:00.000Z",
          outputExcerpt: "x".repeat(2_048),
          outputTruncated: true,
          prompt: "p".repeat(9_000),
          ...(i === 5 ? { error: "exit 1" } : {}),
        },
      ])
    ),
  };

  it("omits excerpts and invocation inputs, and is an order of magnitude smaller", async () => {
    handler = (_req, res) => respondJson(res, 200, realisticRun);

    const compact = await getRunState("run-compact");
    const verbose = await getRunState("run-compact", true);
    const compactSize = JSON.stringify(compact).length;
    const verboseSize = JSON.stringify(verbose).length;

    assert.ok(
      !JSON.stringify(compact).includes("x".repeat(64)),
      "the compact payload must not carry step output excerpts"
    );
    assert.ok(
      !JSON.stringify(compact).includes("b".repeat(64)),
      "the compact payload must not carry the full invocation inputs"
    );
    assert.ok(
      verboseSize > 40_000,
      `the verbose payload is the old cost of one poll; got ${verboseSize} chars`
    );
    assert.ok(
      compactSize * 10 < verboseSize,
      `the compact payload must be an order of magnitude smaller; got ${compactSize} vs ${verboseSize} chars`
    );
  });

  it("keeps per-step id/status/error and the artifact path", async () => {
    handler = (_req, res) => respondJson(res, 200, realisticRun);

    const out = (await getRunState("run-compact")) as {
      status: string;
      progress: string;
      artifactPath?: string;
      steps: Record<string, unknown>[];
    };
    assert.equal(out.status, "awaiting_approval");
    assert.equal(out.artifactPath, "/tmp/af/runs/run-compact/artifact.md");
    assert.equal(out.steps.length, 6);
    assert.deepEqual(out.steps[5], { id: "code-review.grade", status: "failed", error: "exit 1" });
    assert.deepEqual(
      out.steps[0],
      { id: "code-review.gather", status: "succeeded" },
      "a compact step carries only id, status and error"
    );
    assert.ok(out.progress.startsWith("code-review · "), `got progress: ${out.progress}`);
  });

  it("names where every omitted field can be fetched", async () => {
    handler = (_req, res) => respondJson(res, 200, realisticRun);

    const out = (await getRunState("run-compact")) as { omitted: Record<string, string> };
    assert.ok(out.omitted, "a compact payload must say what it left out");
    assert.match(
      out.omitted.mode ?? "",
      /verbose/u,
      "the compact payload must name the argument that returns the full one"
    );
    assert.match(
      out.omitted.stepOutput ?? "",
      /GET \/api\/runs\/run-compact\/steps\/<stepId>\/output/u,
      `step outputs must name the route that serves them; got: ${out.omitted.stepOutput}`
    );
    assert.match(out.omitted.invocationInputs ?? "", /verbose/u);
    assert.match(out.omitted.spec ?? "", /verbose/u);
    assert.match(out.omitted.result ?? "", /verbose/u);
  });

  it("does not inline the gate spec at a gate, but keeps the gate message", async () => {
    handler = (_req, res) => respondJson(res, 200, realisticRun);

    const out = (await getRunState("run-compact")) as { gateMessage?: string };
    assert.equal(out.gateMessage, "Approve the review?");
    assert.ok(
      !JSON.stringify(out).includes("S".repeat(64)),
      "a run at a gate must not inline its spec in compact mode"
    );
    assert.equal("spec" in out, false, "compact mode must not carry a spec field at all");
  });

  it("names nothing omitted that the run does not have", async () => {
    handler = (_req, res) =>
      respondJson(res, 200, { runId: "run-bare", pipelineId: "develop", status: "running" });

    const out = (await getRunState("run-bare")) as { omitted: Record<string, string> };
    assert.deepEqual(
      Object.keys(out.omitted),
      ["mode"],
      "a run with no steps, inputs, spec or result must not advertise fetching them"
    );
  });

  it("never forwards prompts in either mode", async () => {
    handler = (_req, res) => respondJson(res, 200, realisticRun);

    for (const verbose of [false, true]) {
      const out = await getRunState("run-compact", verbose);
      assert.ok(
        !JSON.stringify(out).includes("p".repeat(64)),
        `get_run must never forward prompt text to chat (verbose=${verbose}) — D6`
      );
    }
  });

  // The verbose payload is pinned field by field against the shape callers got
  // before compact mode existed. The deliberate differences are `artifactPath`
  // and the two push handles: verbose must be a superset of compact, and adding
  // a key breaks no caller, while removing or changing one would.
  it("returns the pre-compact payload unchanged, plus artifactPath", async () => {
    handler = (_req, res) => respondJson(res, 200, realisticRun);

    const step = (id: string, status: string, error?: string) => ({
      id: `code-review.${id}`,
      status,
      startedAt: "2026-09-24T10:00:00.000Z",
      finishedAt: "2026-09-24T10:01:00.000Z",
      outputExcerpt: "x".repeat(2_048),
      outputTruncated: true,
      ...(error !== undefined ? { error } : {}),
    });

    const out = await getRunState("run-compact", true);
    assert.deepEqual(out, {
      runId: "run-compact",
      pipelineId: "code-review",
      status: "awaiting_approval",
      result: { verdict: "R".repeat(4_000) },
      gateMessage: "Approve the review?",
      spec: "S".repeat(28_000),
      invocation: {
        pipeline: "code-review",
        startedAt: "2026-09-24T10:00:00.000Z",
        gateMode: "manual",
        inputs: { brief: "b".repeat(1_191), baseline: "c".repeat(2_109) },
      },
      steps: [
        step("gather", "succeeded"),
        step("read", "succeeded"),
        step("analyse", "succeeded"),
        step("verify", "succeeded"),
        step("write", "succeeded"),
        step("grade", "failed", "exit 1"),
      ],
      progress: "code-review · awaiting_approval · 6 steps · 1m00s",
      artifactPath: "/tmp/af/runs/run-compact/artifact.md",
      eventsPath: "/tmp/af/runs/run-compact/code-review.events.jsonl",
      eventsUrl: `${daemonBase()}/api/runs/run-compact/events`,
    });
  });

  it("verbose carries every key compact does, so dropping to it never loses a field", async () => {
    handler = (_req, res) => respondJson(res, 200, realisticRun);

    const compact = (await getRunState("run-compact")) as Record<string, unknown>;
    const verbose = (await getRunState("run-compact", true)) as Record<string, unknown>;
    // `omitted` is compact-only by design: it exists to point at what verbose
    // already returns inline, so it would be noise in the full payload.
    const missing = Object.keys(compact).filter((k) => k !== "omitted" && !(k in verbose));
    assert.deepEqual(
      missing,
      [],
      `verbose must be a superset of compact; these keys exist only in compact: ${missing.join(", ")}`
    );
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

    assert.deepEqual(out, {
      runId: "run-10",
      status: "running",
      eventsUrl: `${daemonBase()}/api/runs/run-10/events`,
    });
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

// ── get_run_events: the cheap progress call, and the run dir behind it ───────

describe("get_run_events — lifecycle lines, nothing else", () => {
  const LINES = [
    { seq: 1, at: "2026-09-25T10:00:00.000Z", stepId: "gather", kind: "step.start" },
    {
      seq: 2,
      at: "2026-09-25T10:00:30.000Z",
      stepId: "gather",
      kind: "step.result",
      status: "succeeded",
    },
    { seq: 3, at: "2026-09-25T10:00:31.000Z", stepId: "approve", kind: "step.suspended" },
  ];

  /**
   * The fake daemon's log route. `maxSeq` is the run's own highest seq, which a
   * real run carries far beyond the lifecycle lines the filter returns.
   */
  function serveLog(seen: { url?: string }, maxSeq = 3) {
    return (req: IncomingMessage, res: ServerResponse) => {
      seen.url = req.url;
      const after = Number(new URL(req.url ?? "", "http://x").searchParams.get("after") ?? 0);
      res.writeHead(200, {
        "content-type": "application/x-ndjson",
        "x-run-status": "awaiting_approval",
        "x-run-pipeline-id": "code-review",
        "x-run-max-seq": String(maxSeq),
        "x-run-events-path": encodeURIComponent("/tmp/af/runs/run-e/code-review.events.jsonl"),
      });
      res.end(
        LINES.filter((line) => line.seq > after)
          .map((line) => JSON.stringify(line))
          .join("\n") + "\n"
      );
    };
  }

  it("returns the run's transitions, its identity and a cursor", async () => {
    const seen: { url?: string } = {};
    handler = serveLog(seen);

    const out = await getRunEvents("run-e");
    assert.equal(out.runId, "run-e");
    assert.equal(out.pipelineId, "code-review");
    assert.equal(out.status, "awaiting_approval");
    assert.equal(out.eventsPath, "/tmp/af/runs/run-e/code-review.events.jsonl");
    assert.equal(out.nextSeq, 4, "the cursor must be one past the run's highest seq");
    assert.ok(typeof out.daemonReachableAt === "string");
    assert.deepEqual(out.events, LINES);

    // The default asks the daemon to drop the transcript, not the caller.
    assert.ok(
      seen.url?.includes(`kinds=${encodeURIComponent(LIFECYCLE_KINDS.join(","))}`),
      `the request must carry the lifecycle allowlist; got ${String(seen.url)}`
    );
  });

  it("excludes events the caller has already seen", async () => {
    const seen: { url?: string } = {};
    handler = serveLog(seen);

    const out = await getRunEvents("run-e", 2);
    assert.ok(seen.url?.includes("after=2"));
    assert.deepEqual(
      (out.events as { seq: number }[]).map((event) => event.seq),
      [3],
      "a cursor poll must never re-deliver a line"
    );
    assert.equal(out.nextSeq, 4);
  });

  it("advances the cursor past the lines the filter dropped", async () => {
    // A chatty run: 900 lines on disk, three of them lifecycle. A cursor that
    // only advanced past what came back would re-scan the other 897 forever.
    handler = serveLog({}, 900);
    const out = await getRunEvents("run-e");
    assert.deepEqual(
      (out.events as { seq: number }[]).map((event) => event.seq),
      [1, 2, 3]
    );
    assert.equal(out.nextSeq, 901, "the cursor must clear every line already considered");
  });

  it("never advances the cursor past lines that do not exist yet", async () => {
    handler = serveLog({}, 3);
    const out = await getRunEvents("run-e", 5);
    assert.deepEqual(out.events, []);
    assert.equal(out.nextSeq, 5, "a stale max seq must not move a cursor backwards or forwards");
  });

  it("carries none of the run's content — that is the whole point", async () => {
    handler = serveLog({});
    const out = await getRunEvents("run-e");
    for (const key of ["invocation", "spec", "plan", "result", "steps", "gateMessage", "prompt"]) {
      assert.equal(key in out, false, `get_run_events must not expose "${key}"`);
    }
    for (const event of out.events as Record<string, unknown>[]) {
      assert.deepEqual(
        Object.keys(event).filter((k) => !["seq", "at", "stepId", "kind", "status"].includes(k)),
        [],
        "an event line carries only its identity and its transition"
      );
    }
  });

  it("returns an error, not a fallback, for a run the daemon does not know", async () => {
    handler = (_req, res) => respondJson(res, 404, { error: "No run found" });
    const out = await getRunEvents("run-missing");
    assert.match(String(out.error), /No run found for runId "run-missing"/u);
  });
});

describe("daemon down — reads degrade, writes do not", () => {
  const RUN_ID = "run-orphan";
  let fallbackHome: string;
  let previousFallbackHome: string | undefined;
  let runsDir: string;
  let runDir: string;

  // Its own temp home: this suite writes and deletes run directories, and
  // ~/.agent-flows/projects/*/runs holds irreplaceable run evidence that a
  // run-id collision would destroy.
  before(() => {
    previousFallbackHome = process.env.AGENT_FLOWS_HOME;
    fallbackHome = mkdtempSync(join(realpathSync(tmpdir()), "af-daemon-down-"));
    process.env.AGENT_FLOWS_HOME = fallbackHome;
    runsDir = resolveProjectState(process.cwd()).runsDir;
    runDir = join(runsDir, RUN_ID);
  });

  after(() => {
    if (previousFallbackHome === undefined) delete process.env.AGENT_FLOWS_HOME;
    else process.env.AGENT_FLOWS_HOME = previousFallbackHome;
    rmSync(fallbackHome, { recursive: true, force: true });
  });

  /** A run directory as a daemon that died would have left it. */
  function writeRunDir(status: string, withEvents = true): void {
    rmSync(runDir, { recursive: true, force: true });
    mkdirSync(runDir, { recursive: true });
    if (withEvents) {
      const line = (extra: Record<string, unknown>) =>
        JSON.stringify({
          runId: RUN_ID,
          pipelineId: "code-review",
          stepId: "gather",
          at: "2026-09-25T10:00:00.000Z",
          ...extra,
        });
      writeFileSync(
        join(runDir, "code-review.events.jsonl"),
        [
          line({ seq: 1, kind: "step.start" }),
          line({ seq: 2, kind: "message", role: "assistant", text: "chatter" }),
          line({ seq: 3, kind: "step.result", status: "succeeded", durationMs: 2000 }),
        ].join("\n") + "\n"
      );
      writeFileSync(
        join(runDir, "code-review.json"),
        JSON.stringify({ runId: RUN_ID, pipelineId: "code-review", status })
      );
    }
  }

  /** Kill the connection: the transport failure a retired daemon produces. */
  function daemonGone(): void {
    handler = (_req, res) => res.destroy();
  }

  it("never reports a persisted 'running' as the current status", async () => {
    writeRunDir("running");
    daemonGone();

    const out = await getRunState(RUN_ID);
    assert.equal(out.status, "unknown", "no daemon means no current status — saying one is a lie");
    assert.equal(
      out.lastPersistedStatus,
      "orphaned",
      "'running' on disk with no daemon to advance it would make a poller wait forever"
    );
    assert.ok(typeof out.lastPersistedAt === "string");
    assert.ok(typeof out.staleSeconds === "number");
    assert.ok(typeof out.daemonUnreachableAt === "string");
    assert.match(String(out.note), /retires after about 15 minutes/u);
    assert.equal(out.pipelineId, "code-review");
    assert.equal(out.eventsPath, join(runDir, "code-review.events.jsonl"));
  });

  it("treats a persisted 'awaiting_approval' as orphaned too", async () => {
    writeRunDir("awaiting_approval");
    daemonGone();

    const out = await getRunState(RUN_ID);
    // Suspended runs live in the daemon's memory only, so this one cannot be
    // approved. Reporting the status verbatim sends the caller to a throw.
    assert.equal(out.lastPersistedStatus, "orphaned");
  });

  it("reports a settled run's own status under lastPersistedStatus", async () => {
    writeRunDir("succeeded");
    daemonGone();

    const out = await getRunState(RUN_ID);
    assert.equal(out.status, "unknown");
    assert.equal(out.lastPersistedStatus, "succeeded");
  });

  it("serves the run's lifecycle from its own directory", async () => {
    writeRunDir("succeeded");
    daemonGone();

    const out = await getRunEvents(RUN_ID);
    assert.equal(out.status, "unknown");
    assert.equal(out.lastPersistedStatus, "succeeded");
    assert.deepEqual(
      (out.events as { kind: string }[]).map((event) => event.kind),
      ["step.start", "step.result"],
      "the transcript line must be filtered out on the disk path too"
    );
    assert.equal(out.nextSeq, 4, "the cursor clears the chatter line the filter dropped");
    assert.equal(out.eventsPath, join(runDir, "code-review.events.jsonl"));
  });

  it("names no file to tail when the directory names no pipeline", async () => {
    writeRunDir("succeeded", false);
    daemonGone();

    const out = await getRunEvents(RUN_ID);
    assert.equal("eventsPath" in out, false, "a path that does not exist is worse than none");
    assert.equal("pipelineId" in out, false);
    assert.equal(out.lastPersistedStatus, "orphaned");
  });

  it("refuses a run id that is a path rather than a run id", async () => {
    daemonGone();
    // The fallback fires whenever the daemon is retired — routinely — so an
    // unguarded join here is a directory-existence, filename, mtime and
    // JSON-status oracle for any path on the machine.
    for (const evil of ["../../../../etc", "..", "a/b", ".hidden", "x\u0000y"]) {
      await assert.rejects(
        () => getRunEvents(evil),
        /is not a run id/u,
        `traversal-shaped run id ${JSON.stringify(evil)} must be refused before the join`
      );
      await assert.rejects(() => getRunState(evil), /is not a run id/u);
    }
  });

  it("throws, specifically, for a run id with no directory either", async () => {
    daemonGone();
    await assert.rejects(() => getRunEvents("no-such-run-at-all"), /has no directory under/u);
  });

  it("still fails loudly for every mutating tool", async () => {
    writeRunDir("running");
    daemonGone();

    // A write that quietly reports success is a far worse lie than a read that
    // says "unknown", so the fallback must never spread to these.
    await assert.rejects(() => cancelRun(RUN_ID, "stop"), /cannot reach the daemon/u);
    await assert.rejects(() => approveRun(RUN_ID, true), /cannot reach the daemon/u);
    await assert.rejects(
      () => startRun({ pipeline: "develop", inputs: {} }),
      /cannot reach the daemon/u
    );
    await assert.rejects(
      () => runPipeline({ pipeline: "develop", inputs: {} }),
      /cannot reach the daemon/u
    );
  });

  it("does not call the retirement a crash", async () => {
    daemonGone();
    await assert.rejects(
      () => cancelRun(RUN_ID),
      (err: Error) => {
        assert.doesNotMatch(err.message, /crash/u, "an idle retirement is by design, not a fault");
        assert.match(err.message, /the next call starts a new one/u);
        return true;
      }
    );
  });
});
