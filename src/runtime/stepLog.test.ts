// Tests for the step log sink (spec 036 V1).
//
// Every test works against a throwaway directory and asserts the file, not the
// in-memory bookkeeping: the file is the contract both the SSE stream and the
// backfill route are read from.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  appendRunLogFileEvent,
  appendStepLog,
  closeRunLog,
  openRunLog,
  readRunLog,
  readStepOutput,
  runLogFile,
  stepOutputFile,
  subscribeRunLog,
  writeStepOutput,
} from "./stepLog.js";
import type { StepLogEvent } from "../canon/stepLogEvents.js";

function makeDir(): string {
  return mkdtempSync(join(tmpdir(), "af-steplog-"));
}

/** Every event on disk, parsed, regardless of seq. */
function linesOf(dir: string, pipelineId: string): StepLogEvent[] {
  return readRunLog(runLogFile(dir, pipelineId));
}

/** Asserts an event's kind and narrows it so its own fields can be read. */
function expectKind<K extends StepLogEvent["kind"]>(
  event: StepLogEvent | undefined,
  kind: K
): Extract<StepLogEvent, { kind: K }> {
  assert.ok(event !== undefined, `expected an event of kind ${kind}`);
  assert.equal(event.kind, kind);
  return event as Extract<StepLogEvent, { kind: K }>;
}

describe("stepLog — appending (FR-001)", () => {
  it("stamps a monotonic seq from 1 with the run's identity", () => {
    const dir = makeDir();
    try {
      openRunLog("seq-run", { dir, pipelineId: "test" });
      appendStepLog("seq-run", "one", { kind: "message", role: "assistant", text: "a" });
      appendStepLog("seq-run", "one", { kind: "message", role: "assistant", text: "b" });
      const last = appendStepLog("seq-run", "two", {
        kind: "step.result",
        status: "succeeded",
        durationMs: 5,
      });

      const events = linesOf(dir, "test");
      assert.deepEqual(
        events.map((e) => e.seq),
        [1, 2, 3],
        "seq must start at 1 and increase by exactly one per line"
      );
      assert.equal(last?.seq, 3, "the returned event must carry the same seq as the line");
      assert.equal(events[2].runId, "seq-run");
      assert.equal(events[2].pipelineId, "test");
      assert.equal(events[2].stepId, "two");
      assert.match(events[0].at, /^\d{4}-\d{2}-\d{2}T.*\dZ$/u, "at must be ISO-8601");
    } finally {
      closeRunLog("seq-run");
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("creates the file 0600 inside a 0700 directory", () => {
    const root = makeDir();
    const dir = join(root, "run-dir");
    try {
      openRunLog("mode-run", { dir, pipelineId: "test" });
      const file = runLogFile(dir, "test");
      assert.equal(existsSync(file), true, "the events file must exist before the first step");
      assert.equal(statSync(file).mode & 0o777, 0o600, "events file must be owner-only");
      assert.equal(statSync(dir).mode & 0o777, 0o700, "run directory must be owner-only");
    } finally {
      closeRunLog("mode-run");
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("drops an event for an unknown run and writes nothing", () => {
    const dir = makeDir();
    try {
      const result = appendStepLog("never-opened", "one", {
        kind: "message",
        role: "assistant",
        text: "a",
      });
      assert.equal(result, undefined, "an unknown run must be dropped, not an error");
      assert.equal(
        existsSync(runLogFile(dir, "test")),
        false,
        "no file may be created for a run the sink never opened"
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes only the first step.result of a step and drops the second", () => {
    const dir = makeDir();
    try {
      openRunLog("twice-run", { dir, pipelineId: "test" });
      const first = appendStepLog("twice-run", "one", {
        kind: "step.result",
        status: "cancelled",
        durationMs: 3,
        error: "Run cancelled",
      });
      // The builder's own abort emit, racing the run service's synthetic event.
      const second = appendStepLog("twice-run", "one", {
        kind: "step.result",
        status: "cancelled",
        durationMs: 7,
      });
      // A different step is unaffected: the guard is per step, not per run.
      appendStepLog("twice-run", "two", {
        kind: "step.result",
        status: "succeeded",
        durationMs: 1,
      });

      assert.equal(first?.seq, 1);
      assert.equal(second, undefined, "the second terminal event of a step must be dropped");
      const events = linesOf(dir, "test");
      assert.deepEqual(
        events.map((e) => e.stepId),
        ["one", "two"],
        "exactly one terminal line per step, whichever emitter won the race"
      );
      assert.equal(expectKind(events[0], "step.result").durationMs, 3);
    } finally {
      closeRunLog("twice-run");
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("continues the sequence across a reopen with a torn last line", () => {
    const dir = makeDir();
    const file = runLogFile(dir, "test");
    try {
      openRunLog("reopen-run", { dir, pipelineId: "test" });
      appendStepLog("reopen-run", "one", { kind: "message", role: "assistant", text: "a" });
      appendStepLog("reopen-run", "one", { kind: "message", role: "assistant", text: "b" });
      closeRunLog("reopen-run");

      // A write interrupted mid-line, as a crashed daemon leaves behind.
      writeFileSync(file, `${readFileSync(file, "utf8")}{"seq":3,"kind":"mes`);

      openRunLog("reopen-run", { dir, pipelineId: "test" });
      const next = appendStepLog("reopen-run", "one", {
        kind: "message",
        role: "assistant",
        text: "c",
      });

      assert.equal(next?.seq, 3, "a torn line must not consume a seq and leave a gap");
    } finally {
      closeRunLog("reopen-run");
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("stepLog — delivery (FR-006)", () => {
  it("notifies a listener only after the line is on disk", () => {
    const dir = makeDir();
    try {
      openRunLog("notify-run", { dir, pipelineId: "test" });
      const seen: { seq: number; onDisk: number }[] = [];
      subscribeRunLog("notify-run", (event) => {
        // Read inside the callback: the file must already hold this line.
        seen.push({ seq: event.seq, onDisk: linesOf(dir, "test").length });
      });

      appendStepLog("notify-run", "one", { kind: "message", role: "assistant", text: "a" });
      appendStepLog("notify-run", "one", { kind: "message", role: "assistant", text: "b" });

      assert.deepEqual(seen, [
        { seq: 1, onDisk: 1 },
        { seq: 2, onDisk: 2 },
      ]);
    } finally {
      closeRunLog("notify-run");
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("closeRunLog stops notifications and later appends", () => {
    const dir = makeDir();
    try {
      openRunLog("close-run", { dir, pipelineId: "test" });
      let delivered = 0;
      subscribeRunLog("close-run", () => {
        delivered += 1;
      });
      appendStepLog("close-run", "one", { kind: "message", role: "assistant", text: "a" });
      closeRunLog("close-run");
      const after = appendStepLog("close-run", "one", {
        kind: "message",
        role: "assistant",
        text: "b",
      });

      assert.equal(delivered, 1, "a closed run must not notify its former subscribers");
      assert.equal(after, undefined, "a closed run is an unknown run to appendStepLog");
      assert.equal(linesOf(dir, "test").length, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("appendRunLogFileEvent continues the sequence after the run was closed", () => {
    const dir = makeDir();
    try {
      openRunLog("late-run", { dir, pipelineId: "test" });
      appendStepLog("late-run", "one", { kind: "message", role: "assistant", text: "a" });
      appendStepLog("late-run", "one", { kind: "message", role: "assistant", text: "b" });
      closeRunLog("late-run");

      const event = appendRunLogFileEvent(dir, "test", "late-run", "approve", {
        kind: "decision",
        gateStepId: "approve",
        mode: "auto",
        decidedBy: "agent",
        approved: true,
        superseded: true,
      });

      assert.equal(event?.seq, 3, "the file-level path must continue the file's own sequence");
      const events = linesOf(dir, "test");
      assert.equal(events.length, 3);
      assert.equal(events[2].kind, "decision");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("stepLog — reading (FR-007)", () => {
  it("drops a torn last line and honours after", () => {
    const dir = makeDir();
    const file = runLogFile(dir, "test");
    try {
      openRunLog("read-run", { dir, pipelineId: "test" });
      appendStepLog("read-run", "one", { kind: "message", role: "assistant", text: "a" });
      appendStepLog("read-run", "one", { kind: "message", role: "assistant", text: "b" });
      closeRunLog("read-run");

      // A write interrupted mid-line, as a crashed daemon leaves behind.
      writeFileSync(file, `${readFileSync(file, "utf8")}{"seq":3,"kind":"mes`);

      const all = readRunLog(file);
      assert.deepEqual(
        all.map((e) => e.seq),
        [1, 2],
        "the incomplete final line must be dropped, not parsed"
      );
      assert.deepEqual(
        readRunLog(file, { after: 1 }).map((e) => e.seq),
        [2],
        "after must exclude everything at or below the given seq"
      );
      assert.deepEqual(readRunLog(join(dir, "absent.events.jsonl")), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads the stamped seq, not a seq nested in a tool input", () => {
    const dir = makeDir();
    const file = runLogFile(dir, "test");
    try {
      openRunLog("nested-seq", { dir, pipelineId: "test" });
      appendStepLog("nested-seq", "one", { kind: "message", role: "assistant", text: "a" });
      appendStepLog("nested-seq", "one", {
        kind: "tool.call",
        callId: "call-1",
        name: "Task",
        input: { seq: 999 },
      });
      closeRunLog("nested-seq");

      assert.deepEqual(
        readRunLog(file).map((e) => e.seq),
        [1, 2],
        "the stamps are serialised last, so the last seq in the line is the real one"
      );
      assert.deepEqual(
        readRunLog(file, { after: 2 }).map((e) => e.seq),
        [],
        "a nested seq must not smuggle an already-delivered event past after"
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("stepLog — credential deny guard (FR-010)", () => {
  const cases = [
    { name: "repo-relative", path: ".env" },
    { name: "absolute", path: "/Users/x/proj/.env" },
    { name: "nested absolute", path: "/Users/x/proj/config/credentials.json" },
  ];

  for (const { name, path } of cases) {
    it(`redacts a ${name} credential path and its result`, () => {
      const dir = makeDir();
      const runId = `deny-${name.replace(/\s/gu, "-")}`;
      try {
        openRunLog(runId, { dir, pipelineId: "test" });
        appendStepLog(runId, "one", {
          kind: "tool.call",
          callId: "call-1",
          name: "Read",
          input: { file_path: path },
        });
        appendStepLog(runId, "one", {
          kind: "tool.result",
          callId: "call-1",
          ok: true,
          excerpt: "SECRET=hunter2",
        });

        const [rawCall, rawResult] = linesOf(dir, "test");
        const call = expectKind(rawCall, "tool.call");
        const result = expectKind(rawResult, "tool.result");
        assert.equal(call.denied, true);
        assert.deepEqual(call.input, { path }, "the input must be reduced to the matched path");
        assert.equal(result.redacted, true);
        assert.equal(result.excerpt, undefined, "a denied call's result carries no excerpt");
        assert.equal(
          readFileSync(runLogFile(dir, "test"), "utf8").includes("hunter2"),
          false,
          "the file must never hold the content of a denied read"
        );
      } finally {
        closeRunLog(runId);
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  it("redacts a credential path named inside a shell command and its result", () => {
    const dir = makeDir();
    try {
      openRunLog("deny-command", { dir, pipelineId: "test" });
      appendStepLog("deny-command", "one", {
        kind: "tool.call",
        callId: "call-1",
        name: "command",
        input: { command: "cat /x/.env | head" },
      });
      appendStepLog("deny-command", "one", {
        kind: "tool.result",
        callId: "call-1",
        ok: true,
        excerpt: "SECRET=hunter2",
      });

      const [rawCall, rawResult] = linesOf(dir, "test");
      const call = expectKind(rawCall, "tool.call");
      assert.equal(call.denied, true);
      assert.deepEqual(call.input, { path: "/x/.env" }, "the matched token replaces the command");
      assert.equal(expectKind(rawResult, "tool.result").redacted, true);
      assert.equal(
        readFileSync(runLogFile(dir, "test"), "utf8").includes("hunter2"),
        false,
        "the file must never hold the content of a denied read"
      );
    } finally {
      closeRunLog("deny-command");
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("redacts a quoted credential path inside a shell command", () => {
    const dir = makeDir();
    try {
      openRunLog("deny-quoted", { dir, pipelineId: "test" });
      appendStepLog("deny-quoted", "one", {
        kind: "tool.call",
        callId: "call-1",
        name: "command",
        input: { command: 'cat "/x/.env"' },
      });

      const call = expectKind(linesOf(dir, "test")[0], "tool.call");
      assert.equal(call.denied, true, "quoting a path must not defeat the token match");
      assert.deepEqual(call.input, { path: "/x/.env" });
    } finally {
      closeRunLog("deny-quoted");
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("leaves an ordinary source path and its result untouched", () => {
    const dir = makeDir();
    try {
      openRunLog("allow-run", { dir, pipelineId: "test" });
      appendStepLog("allow-run", "one", {
        kind: "tool.call",
        callId: "call-1",
        name: "Read",
        input: { file_path: "/Users/x/proj/src/index.ts" },
      });
      appendStepLog("allow-run", "one", {
        kind: "tool.result",
        callId: "call-1",
        ok: true,
        excerpt: "export const x = 1;",
      });

      const [rawCall, rawResult] = linesOf(dir, "test");
      assert.equal(expectKind(rawCall, "tool.call").denied, undefined);
      assert.equal(expectKind(rawResult, "tool.result").excerpt, "export const x = 1;");
    } finally {
      closeRunLog("allow-run");
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("stepLog — bounds and caps (FR-009)", () => {
  it("cuts an over-long message and marks it truncated", () => {
    const dir = makeDir();
    try {
      openRunLog("bound-run", { dir, pipelineId: "test" });
      appendStepLog("bound-run", "one", {
        kind: "message",
        role: "assistant",
        text: "x".repeat(9000),
      });

      const event = expectKind(linesOf(dir, "test")[0], "message");
      assert.equal(event.text.length, 8192);
      assert.equal(event.truncated, true);
    } finally {
      closeRunLog("bound-run");
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("counts the byte cap in UTF-8 bytes, not string length", () => {
    const dir = makeDir();
    try {
      // 400 three-byte characters: 400 UTF-16 units but 1200 bytes, so the line
      // is under the cap by `.length` and well over it by its real size.
      const text = "한".repeat(400);
      openRunLog("utf8-run", { dir, pipelineId: "test", caps: { bytes: 700 } });
      appendStepLog("utf8-run", "one", { kind: "message", role: "assistant", text });
      assert.ok(
        readFileSync(runLogFile(dir, "test"), "utf8").length < 700,
        "the fixture must be under the cap by string length, or it proves nothing"
      );
      appendStepLog("utf8-run", "one", { kind: "message", role: "assistant", text: "next" });

      const kinds = linesOf(dir, "test").map((e) => e.kind);
      assert.deepEqual(kinds, ["message", "log.truncated"], "the byte cap must count UTF-8 bytes");
    } finally {
      closeRunLog("utf8-run");
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("marks the log truncated once at the cap and then keeps only the structural kinds", () => {
    const dir = makeDir();
    try {
      openRunLog("cap-run", { dir, pipelineId: "test", caps: { events: 5 } });
      for (let i = 0; i < 5; i++) {
        appendStepLog("cap-run", "one", { kind: "message", role: "assistant", text: `m${i}` });
      }
      const overflow = appendStepLog("cap-run", "one", {
        kind: "message",
        role: "assistant",
        text: "dropped",
      });
      appendStepLog("cap-run", "one", { kind: "message", role: "assistant", text: "also dropped" });
      appendStepLog("cap-run", "one", {
        kind: "step.result",
        status: "succeeded",
        durationMs: 1,
      });

      assert.equal(overflow, undefined, "an event dropped by the cap reports nothing appended");
      const kinds = linesOf(dir, "test").map((e) => e.kind);
      assert.deepEqual(kinds, [
        "message",
        "message",
        "message",
        "message",
        "message",
        "log.truncated",
        "step.result",
      ]);
      assert.equal(
        readFileSync(runLogFile(dir, "test"), "utf8").includes("dropped"),
        false,
        "no bulk event may be written after the cap"
      );
    } finally {
      closeRunLog("cap-run");
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("stepLog — step outputs (FR-008)", () => {
  it("writes the full output 0600 and reads it back", () => {
    const dir = makeDir();
    try {
      openRunLog("out-run", { dir, pipelineId: "test" });
      writeStepOutput("out-run", "verify.findings", {
        kind: "json",
        schema: "findings",
        output: { findings: [{ id: 1 }] },
      });

      const path = stepOutputFile(dir, "test", "verify.findings");
      assert.equal(statSync(path).mode & 0o777, 0o600);
      assert.deepEqual(readStepOutput(path), {
        runId: "out-run",
        pipelineId: "test",
        stepId: "verify.findings",
        kind: "json",
        schema: "findings",
        output: { findings: [{ id: 1 }] },
      });
      assert.equal(readStepOutput(join(dir, "absent.json")), undefined);
    } finally {
      closeRunLog("out-run");
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a step id that could escape the outputs directory", () => {
    const dir = makeDir();
    try {
      openRunLog("escape-run", { dir, pipelineId: "test" });
      assert.throws(
        () => writeStepOutput("escape-run", "../../etc/passwd", { kind: "text", output: "x" }),
        RangeError
      );
      assert.throws(() => stepOutputFile(dir, "test", "a/b"), RangeError);
      // The pipeline id is read back from a persisted artifact, so it is held
      // to the same class as the step id.
      assert.throws(() => runLogFile(dir, "../../x"), RangeError);
      assert.throws(() => stepOutputFile(dir, "../../x", "one"), RangeError);
    } finally {
      closeRunLog("escape-run");
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
