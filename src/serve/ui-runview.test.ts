// The run session (ui-runview.js) is the page's only way to talk to a run, so the
// rules that used to be scattered `_activeRunId !== runId` checks in ui.html are
// tested here against a fake fetch and a fake stream, no browser needed.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createOutputCache,
  createRunSession,
  outputKey,
  SETTLED_STEP_STATUSES,
  type FetchResponse,
  type LogBatch,
  type OutputCache,
  type RunSession,
} from "./ui-runview.js";

/** Let every promise continuation that is already runnable run. */
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Whether a promise settles within a short window — false means it stays pending. */
async function settles(p: Promise<unknown>, ms = 25): Promise<boolean> {
  return Promise.race([
    p.then(
      () => true,
      () => true
    ),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms)),
  ]);
}

interface Reply {
  status?: number;
  json?: unknown;
  text?: string;
}

interface Call {
  url: string;
  reply(r: Reply): void;
  fail(e: Error): void;
}

function response(r: Reply): FetchResponse {
  const status = r.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(r.json ?? {}),
    text: () => Promise.resolve(r.text ?? ""),
  };
}

/** A fetch whose every response is answered by the test, in any order. */
function fakeFetch(order: string[]) {
  const calls: Call[] = [];
  const fn = (url: string): Promise<FetchResponse> =>
    new Promise((resolve, reject) => {
      order.push(`GET ${url}`);
      calls.push({ url, reply: (r) => resolve(response(r)), fail: reject });
    });
  return {
    fn,
    calls,
    /** The calls whose url ends with `suffix`. */
    to: (suffix: string) => calls.filter((c) => c.url.endsWith(suffix)),
  };
}

class FakeStream {
  listeners = new Map<string, ((ev: { data: string }) => void)[]>();
  onerror: unknown = null;
  closes = 0;
  constructor(readonly url: string) {}
  addEventListener(type: string, listener: (ev: { data: string }) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  emit(type: string, data: unknown): void {
    this.emitRaw(type, JSON.stringify(data));
  }
  emitRaw(type: string, data: string): void {
    for (const l of this.listeners.get(type) ?? []) l({ data });
  }
  fail(): void {
    (this.onerror as () => void)();
  }
  close(): void {
    this.closes += 1;
  }
}

interface Rig {
  session: RunSession;
  net: ReturnType<typeof fakeFetch>;
  streams: FakeStream[];
  /** Every callback the session made, in order, as short strings. */
  events: string[];
  /** Every log batch handed to on.log. */
  batches: LogBatch[];
  /** Every request and stream open, in order. */
  order: string[];
}

interface RigOptions {
  projectKey?: string;
  runId?: string;
  outputs?: OutputCache;
  net?: ReturnType<typeof fakeFetch>;
  events?: string[];
  order?: string[];
}

function rig(o: RigOptions = {}): Rig {
  const order = o.order ?? [];
  const events = o.events ?? [];
  const net = o.net ?? fakeFetch(order);
  const streams: FakeStream[] = [];
  const batches: LogBatch[] = [];
  const runId = o.runId ?? "r1";
  const session = createRunSession({
    projectKey: o.projectKey ?? "",
    runId,
    fetch: net.fn,
    openStream: (url) => {
      order.push(`STREAM ${url}`);
      const s = new FakeStream(url);
      streams.push(s);
      return s;
    },
    outputs: o.outputs ?? createOutputCache(),
    on: {
      snapshot: (s, cause) => events.push(`snapshot:${runId}:${cause}:${String(s.status)}`),
      step: (d) => events.push(`step:${String(d.stepId)}`),
      log: (b) => {
        batches.push(b);
        events.push(`log:${b.applied.map((e) => String(e.seq)).join(",")}`);
      },
      stream: (open) => events.push(`stream:${String(open)}`),
      error: (e) => events.push(`error:${e.message}`),
    },
  });
  return { session, net, streams, events, batches, order };
}

const RUNNING = { pipelineId: "p", status: "running", steps: {} };

/** Open a session whose snapshot and (empty) log have both been answered. */
async function opened(o: RigOptions & { snapshot?: Record<string, unknown> } = {}): Promise<Rig> {
  const r = rig(o);
  const done = r.session.open();
  r.net.calls[0]?.reply({ json: o.snapshot ?? RUNNING });
  await tick();
  r.net.to("/log")[0]?.reply({ text: "" });
  await done;
  return r;
}

/** The seqs one log batch handed to on.log. */
const seqs = (r: Rig, batch: number): number[] | undefined =>
  r.batches[batch]?.applied.map((e) => Number(e.seq));

/** The seqs of every log batch, in order. */
const allSeqs = (r: Rig): number[][] => r.batches.map((b) => b.applied.map((e) => Number(e.seq)));

const logLine = (seq: number, stepId = "s"): string =>
  JSON.stringify({ seq, stepId, kind: "text", text: `line ${seq}` });

describe("open — what is requested, and in what order", () => {
  for (const [label, projectKey, prefix] of [
    ["this daemon", "", ""],
    ["another project", "k/x", "/api/projects/k%2Fx"],
  ] as const) {
    it(`reads the snapshot, opens the stream, then reads the log (${label})`, async () => {
      const r = rig({ projectKey });
      const done = r.session.open();
      assert.deepEqual(r.order, [`GET ${prefix}/api/runs/r1`]);
      r.net.calls[0]?.reply({ json: RUNNING });
      await tick();
      // The stream is open BEFORE the log is read, so no event can fall in the gap.
      assert.deepEqual(r.order, [
        `GET ${prefix}/api/runs/r1`,
        `STREAM ${prefix}/api/runs/r1/events`,
        `GET ${prefix}/api/runs/r1/log`,
      ]);
      r.net.to("/log")[0]?.reply({ text: "" });
      await done;
      assert.deepEqual(r.events, ["snapshot:r1:open:running", "stream:true"]);
    });
  }

  it("encodes a run id that is not path-safe", async () => {
    const r = rig({ runId: "a b/c" });
    void r.session.open();
    assert.deepEqual(r.order, ["GET /api/runs/a%20b%2Fc"]);
  });

  it("a restored run opens no stream but still reads its log", async () => {
    const r = rig();
    const done = r.session.open();
    r.net.calls[0]?.reply({ json: { ...RUNNING, source: "disk" } });
    await tick();
    assert.equal(r.streams.length, 0, "a disk run has nothing left to stream");
    assert.equal(r.session.streamState, "none");
    r.net.to("/log")[0]?.reply({ text: `${logLine(1)}\n` });
    await done;
    assert.deepEqual(r.events, ["snapshot:r1:open:running", "log:1"]);
  });

  it("reports a snapshot that cannot be read, with the daemon's own message", async () => {
    const r = rig();
    const done = r.session.open();
    r.net.calls[0]?.reply({ status: 404, json: { error: "run not found" } });
    await done;
    assert.deepEqual(r.events, ["error:run not found"]);
    assert.equal(r.streams.length, 0);
  });
});

describe("close — a closed session never paints", () => {
  it("before the snapshot lands: nothing is emitted, opened or requested, and open() resolves", async () => {
    const r = rig();
    const done = r.session.open();
    r.session.close();
    r.net.calls[0]?.reply({ json: RUNNING });
    await done;
    assert.deepEqual(r.events, []);
    assert.equal(r.streams.length, 0);
    assert.equal(r.net.calls.length, 1, "the log must not be requested for a closed session");
  });

  it("a failed snapshot after close shows no error either", async () => {
    const r = rig();
    const done = r.session.open();
    r.session.close();
    r.net.calls[0]?.reply({ status: 500, json: { error: "late" } });
    await done;
    assert.deepEqual(r.events, []);
  });

  it("during the log backfill: the late log and the buffered events are dropped", async () => {
    const r = rig();
    const done = r.session.open();
    r.net.calls[0]?.reply({ json: RUNNING });
    await tick();
    r.streams[0]?.emit("log", { seq: 2, stepId: "s" });
    r.session.close();
    r.net.to("/log")[0]?.reply({ text: `${logLine(1)}\n` });
    await done;
    assert.deepEqual(
      r.events.filter((e) => e.startsWith("log:")),
      []
    );
  });

  it("stream events after close are dropped, and the stream is closed once", async () => {
    const r = await opened();
    r.session.close();
    r.session.close();
    const before = r.events.length;
    r.streams[0]?.emit("snapshot", { ...RUNNING, status: "succeeded" });
    r.streams[0]?.emit("step", { stepId: "a", status: "started" });
    r.streams[0]?.emit("log", { seq: 9, stepId: "a" });
    assert.equal(r.events.length, before, "a closed session painted something");
    assert.equal(r.streams[0]?.closes, 1);
    assert.deepEqual(
      r.events.filter((e) => e.startsWith("stream:")),
      ["stream:true", "stream:false"]
    );
    assert.equal(r.session.closed, true);
    assert.equal(r.session.streamState, "closed");
  });

  it("switching runs: the first session's late snapshot cannot reach the second's screen", async () => {
    const events: string[] = [];
    const order: string[] = [];
    const a = rig({ runId: "A", events, order });
    const doneA = a.session.open();
    a.session.close();
    const b = rig({ runId: "B", events, order });
    const doneB = b.session.open();
    b.net.calls[0]?.reply({ json: RUNNING });
    await tick();
    b.net.to("/log")[0]?.reply({ text: "" });
    await doneB;
    a.net.calls[0]?.reply({ json: RUNNING });
    await doneA;
    assert.deepEqual(
      events.filter((e) => e.startsWith("snapshot:")),
      ["snapshot:B:open:running"]
    );
  });
});

describe("stream — an error ends it for good", () => {
  it("closes it once, reports it once, and never reconnects", async () => {
    const r = await opened();
    r.streams[0]?.fail();
    r.streams[0]?.fail();
    assert.equal(r.streams[0]?.closes, 1);
    assert.equal(r.streams.length, 1, "an error must not open a second stream");
    assert.equal(r.session.streamState, "detached");
    r.session.close();
    assert.equal(r.streams[0]?.closes, 1, "close() after an error closed the stream again");
    assert.deepEqual(
      r.events.filter((e) => e.startsWith("stream:")),
      ["stream:true", "stream:false"],
      "exactly one false for the one true"
    );
  });

  it("ignores a payload that is not JSON", async () => {
    const r = await opened();
    const before = r.events.length;
    r.streams[0]?.emitRaw("snapshot", "{not json");
    r.streams[0]?.emitRaw("step", "");
    assert.equal(r.events.length, before);
  });
});

describe("the log — backfill first, then live, each event once", () => {
  it("merges the backfill with the events buffered meanwhile, then paints live events at once", async () => {
    const r = rig();
    const done = r.session.open();
    r.net.calls[0]?.reply({ json: RUNNING });
    await tick();
    r.streams[0]?.emit("log", { seq: 5, stepId: "s" });
    r.streams[0]?.emit("log", { seq: 6, stepId: "s" });
    assert.equal(r.batches.length, 0, "buffered events must wait for the backfill");
    r.net.to("/log")[0]?.reply({ text: [1, 2, 3, 4, 5].map((n) => logLine(n)).join("\n") });
    await done;
    assert.deepEqual(allSeqs(r), [[1, 2, 3, 4, 5], [6]], "every seq exactly once, in order");
    r.streams[0]?.emit("log", { seq: 7, stepId: "s" });
    assert.deepEqual(seqs(r, 2), [7]);
    assert.equal(r.session.logState.lastSeq, 7);
  });

  it("paints an event that appears twice in one batch only once", async () => {
    const r = rig();
    const done = r.session.open();
    r.net.calls[0]?.reply({ json: RUNNING });
    await tick();
    r.net.to("/log")[0]?.reply({ text: [1, 2, 2, 3].map((n) => logLine(n)).join("\n") });
    await done;
    assert.deepEqual(seqs(r, 0), [1, 2, 3]);
  });

  it("drops a torn last line of a log still being written", async () => {
    const r = rig();
    const done = r.session.open();
    r.net.calls[0]?.reply({ json: RUNNING });
    await tick();
    r.net.to("/log")[0]?.reply({ text: `${logLine(1)}\n{"seq":2,"ste` });
    await done;
    assert.deepEqual(seqs(r, 0), [1]);
  });
});

describe("refresh", () => {
  it("drops a refresh made while one is in flight, then allows the next", async () => {
    const r = await opened();
    const before = r.net.calls.length;
    const all = [r.session.refresh(), r.session.refresh(), r.session.refresh()];
    assert.equal(r.net.calls.length, before + 1, "overlapping refreshes must share one request");
    r.net.calls[before]?.reply({ json: { ...RUNNING, status: "succeeded" } });
    await Promise.all(all);
    assert.equal(r.events.filter((e) => e.includes(":refresh:")).length, 1);
    assert.equal(r.session.snapshot?.status, "succeeded");
    void r.session.refresh();
    assert.equal(r.net.calls.length, before + 2, "the flag must clear once the refresh lands");
  });

  it("resolves, and emits nothing, when the session closes while it is in flight", async () => {
    const r = await opened();
    const before = r.events.length;
    const p = r.session.refresh();
    r.session.close();
    r.net.calls[r.net.calls.length - 1]?.reply({ json: RUNNING });
    await p;
    assert.equal(r.events.length, before + 1, "only the stream(false) from close()");
    assert.equal(r.events.at(-1), "stream:false");
  });

  it("resolves quietly when the request fails", async () => {
    const r = await opened();
    const before = r.events.length;
    const p = r.session.refresh();
    r.net.calls[r.net.calls.length - 1]?.fail(new Error("network"));
    await p;
    assert.equal(r.events.length, before);
  });

  it("is per session: a refresh in flight for one run does not drop another's", async () => {
    const a = await opened({ runId: "A" });
    const b = await opened({ runId: "B" });
    void a.session.refresh();
    const before = b.net.calls.length;
    void b.session.refresh();
    assert.equal(b.net.calls.length, before + 1);
  });
});

describe("stepDetail", () => {
  it("makes its own snapshot request per call, so a step never gets another's response", async () => {
    const r = await opened();
    const before = r.net.calls.length;
    const forA = r.session.stepDetail("a");
    const forB = r.session.stepDetail("b");
    assert.equal(r.net.calls.length, before + 2, "a call joined another step's request");
    // A's request was made before B's step recorded its prompt; B's carries it.
    r.net.calls[before]?.reply({ json: { steps: { a: { prompt: "x" } } } });
    r.net.calls[before + 1]?.reply({
      json: { steps: { a: { prompt: "x" }, b: { command: "y" } } },
    });
    assert.deepEqual(await forA, { prompt: "x" });
    assert.deepEqual(await forB, { command: "y" });
  });

  it("is undefined when the snapshot cannot be read", async () => {
    const r = await opened();
    const p = r.session.stepDetail("a");
    r.net.calls[r.net.calls.length - 1]?.reply({ status: 500 });
    assert.equal(await p, undefined);
  });

  it("never settles once the session is closed", async () => {
    const r = await opened();
    const p = r.session.stepDetail("a");
    r.session.close();
    r.net.calls[r.net.calls.length - 1]?.reply({ json: { steps: { a: { prompt: "x" } } } });
    assert.equal(await settles(p), false, "a closed session resumed its caller");
  });
});

describe("stepOutput — one fetcher, one cache", () => {
  const outputUrl = (s: string): string => `/api/runs/r1/steps/${s}/output`;

  it("serves a second ask from the cache", async () => {
    const r = await opened();
    const first = r.session.stepOutput("a");
    r.net.to(outputUrl("a"))[0]?.reply({ json: { kind: "text", output: "hi" } });
    assert.deepEqual(await first, { kind: "text", output: "hi" });
    assert.deepEqual(await r.session.stepOutput("a"), { kind: "text", output: "hi" });
    assert.equal(r.net.to(outputUrl("a")).length, 1);
  });

  it("shares one request between concurrent askers", async () => {
    const r = await opened();
    const asks = [r.session.stepOutput("a"), r.session.stepOutput("a"), r.session.stepOutput("a")];
    assert.equal(r.net.to(outputUrl("a")).length, 1);
    r.net.to(outputUrl("a"))[0]?.reply({ json: { kind: "text", output: "hi" } });
    assert.deepEqual(await Promise.all(asks), Array(3).fill({ kind: "text", output: "hi" }));
  });

  it("caches a 404 as 'none persisted' once the step has settled", async () => {
    for (const status of SETTLED_STEP_STATUSES) {
      const r = await opened({ snapshot: { ...RUNNING, steps: { a: { status } } } });
      const p = r.session.stepOutput("a");
      r.net.to(outputUrl("a"))[0]?.reply({ status: 404 });
      assert.equal(await p, null);
      assert.equal(await r.session.stepOutput("a"), null);
      assert.equal(r.net.to(outputUrl("a")).length, 1, `a 404 for a ${status} step is final`);
    }
  });

  it("caches a 404 for a settled run and for a restored one", async () => {
    for (const snapshot of [
      { pipelineId: "p", status: "succeeded", steps: {} },
      { ...RUNNING, source: "disk" },
    ]) {
      const r = await opened({ snapshot });
      const p = r.session.stepOutput("a");
      r.net.to(outputUrl("a"))[0]?.reply({ status: 404 });
      assert.equal(await p, null);
      await r.session.stepOutput("a");
      assert.equal(r.net.to(outputUrl("a")).length, 1);
    }
  });

  it("asks again after a 404 for a step that is still running", async () => {
    const r = await opened({ snapshot: { ...RUNNING, steps: { a: { status: "started" } } } });
    const first = r.session.stepOutput("a");
    r.net.to(outputUrl("a"))[0]?.reply({ status: 404 });
    assert.equal(await first, null);
    const second = r.session.stepOutput("a");
    assert.equal(r.net.to(outputUrl("a")).length, 2, "the output is not written yet, not absent");
    r.net.to(outputUrl("a"))[1]?.reply({ json: { kind: "text", output: "now" } });
    assert.deepEqual(await second, { kind: "text", output: "now" });
  });

  it("does not cache a 404 that was asked while the step ran, even if it settled before the reply", async () => {
    const r = await opened({ snapshot: { ...RUNNING, steps: { a: { status: "started" } } } });
    const first = r.session.stepOutput("a");
    // The step settles while the request is in flight; the 404 predates its output.
    r.streams[0]?.emit("step", { stepId: "a", status: "succeeded" });
    r.net.to(outputUrl("a"))[0]?.reply({ status: 404 });
    assert.equal(await first, null);
    const second = r.session.stepOutput("a");
    assert.equal(r.net.to(outputUrl("a")).length, 2, "a late 404 was cached as final");
    r.net.to(outputUrl("a"))[1]?.reply({ json: { kind: "text", output: "written" } });
    assert.deepEqual(await second, { kind: "text", output: "written" });
  });

  it("rejects a server error without caching it", async () => {
    const r = await opened();
    const first = r.session.stepOutput("a");
    r.net.to(outputUrl("a"))[0]?.reply({ status: 500 });
    await assert.rejects(first, /Request failed \(500\)/u);
    const second = r.session.stepOutput("a");
    assert.equal(r.net.to(outputUrl("a")).length, 2, "a failure must be retryable");
    r.net.to(outputUrl("a"))[1]?.reply({ json: { kind: "text", output: "ok" } });
    assert.deepEqual(await second, { kind: "text", output: "ok" });
  });

  it("fills the cache even when the session that asked has closed", async () => {
    const outputs = createOutputCache();
    const a = await opened({ outputs });
    const asked = a.session.stepOutput("a");
    a.session.close();
    a.net.to(outputUrl("a"))[0]?.reply({ json: { kind: "text", output: "late" } });
    assert.equal(await settles(asked), false, "the closed session's caller must not resume");
    await tick();
    const b = await opened({ outputs });
    assert.deepEqual(await b.session.stepOutput("a"), { kind: "text", output: "late" });
    assert.equal(b.net.to(outputUrl("a")).length, 0, "the answer was already cached");
  });

  it("keeps the same run id in two projects apart", async () => {
    const outputs = createOutputCache();
    const one = await opened({ outputs, projectKey: "P1" });
    const two = await opened({ outputs, projectKey: "P2" });
    const a = one.session.stepOutput("s");
    const b = two.session.stepOutput("s");
    assert.equal(one.net.to("/steps/s/output").length, 1);
    assert.equal(two.net.to("/steps/s/output").length, 1);
    assert.match(one.net.to("/steps/s/output")[0]?.url ?? "", /^\/api\/projects\/P1\//u);
    assert.match(two.net.to("/steps/s/output")[0]?.url ?? "", /^\/api\/projects\/P2\//u);
    one.net.to("/steps/s/output")[0]?.reply({ json: { output: "from P1" } });
    two.net.to("/steps/s/output")[0]?.reply({ json: { output: "from P2" } });
    assert.deepEqual(await a, { output: "from P1" });
    assert.deepEqual(await b, { output: "from P2" });
  });

  it("builds a key that tells project, run and step apart", () => {
    assert.notEqual(outputKey("P1", "r", "s"), outputKey("P2", "r", "s"));
    assert.notEqual(outputKey("p", "ab", "c"), outputKey("p", "a", "bc"));
  });
});

describe("step events patch the session's snapshot", () => {
  it("merges the status and excerpt into the step, leaving the rest", async () => {
    const r = await opened({
      snapshot: { ...RUNNING, steps: { a: { status: "started", model: "m" }, b: { status: "x" } } },
    });
    const before = r.session.snapshot;
    r.streams[0]?.emit("step", {
      stepId: "a",
      status: "succeeded",
      outputExcerpt: "hi",
      outputTruncated: true,
    });
    assert.deepEqual(r.session.snapshot?.steps, {
      a: { status: "succeeded", model: "m", outputExcerpt: "hi", outputTruncated: true },
      b: { status: "x" },
    });
    assert.notEqual(r.session.snapshot, before, "the snapshot a caller holds must not change");
    assert.equal(before?.steps.a.status, "started");
    assert.ok(r.events.includes("step:a"));
  });

  it("adds a step the snapshot had not seen, and ignores an event with no step id", async () => {
    const r = await opened();
    r.streams[0]?.emit("step", { stepId: "new", status: "started" });
    r.streams[0]?.emit("step", { status: "started" });
    assert.deepEqual(r.session.snapshot?.steps, { new: { status: "started" } });
  });
});

describe("whileOpen", () => {
  it("passes a value or a rejection through while the session is open", async () => {
    const r = rig();
    assert.equal(await r.session.whileOpen(Promise.resolve(7)), 7);
    assert.equal(await r.session.whileOpen(7), 7);
    await assert.rejects(r.session.whileOpen(Promise.reject(new Error("no"))), /no/u);
  });

  it("never settles once the session is closed, for a value or a rejection", async () => {
    const r = rig();
    let release!: () => void;
    let fail!: (e: Error) => void;
    const slow = new Promise<number>((resolve) => (release = () => resolve(1)));
    const bad = new Promise<number>((_, reject) => (fail = reject));
    const a = r.session.whileOpen(slow);
    const b = r.session.whileOpen(bad);
    r.session.close();
    release();
    fail(new Error("late"));
    assert.equal(await settles(a), false);
    assert.equal(await settles(b), false);
  });

  it("swallows a rejection that arrives after close instead of leaking it", async () => {
    const r = rig();
    let fail!: (e: Error) => void;
    const bad = new Promise<number>((_, reject) => (fail = reject));
    void r.session.whileOpen(bad);
    r.session.close();
    const leaked: unknown[] = [];
    const listener = (e: unknown): void => void leaked.push(e);
    process.on("unhandledRejection", listener);
    try {
      fail(new Error("late"));
      await new Promise((resolve) => setTimeout(resolve, 30));
    } finally {
      process.off("unhandledRejection", listener);
    }
    assert.deepEqual(leaked, [], "a rejection after close surfaced as unhandled");
  });
});
