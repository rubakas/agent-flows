// Fixture-driven tests for the adapters' stream parsers (spec 036 V2).
//
// The fixtures are real streams captured on 2026-09-14 from a scratch directory
// holding only package.json and notes.txt, so the assertions below describe what
// the CLIs actually emit rather than what this repository hopes they emit.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { claudeStreamLineToEvents } from "../runClaudeCli.js";
import { codexStreamLineToEvents } from "./codex.js";
import type { StepLogEventInput } from "../stepLogEvents.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

type LineParser = (line: string) => StepLogEventInput[];

function eventsFromFixture(name: string, parse: LineParser): StepLogEventInput[] {
  const raw = readFileSync(join(__dirname, "__fixtures__", name), "utf8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .flatMap((line) => parse(line));
}

/** `kind` plus the one field that distinguishes calls and results, for readable diffs. */
function summarise(event: StepLogEventInput): string {
  if (event.kind === "tool.call") return `tool.call ${event.name}`;
  if (event.kind === "tool.result") return `tool.result ${event.ok ? "ok" : "error"}`;
  return event.kind;
}

function usageOf(events: StepLogEventInput[]): Extract<StepLogEventInput, { kind: "usage" }> {
  const usage = events.find(
    (event): event is Extract<StepLogEventInput, { kind: "usage" }> => event.kind === "usage"
  );
  assert.ok(usage !== undefined, "the stream must produce a usage event");
  return usage;
}

describe("claudeStreamLineToEvents — captured claude stream (FR-002)", () => {
  it("maps a two-Read turn onto tool calls, results, the answer and usage", () => {
    const events = eventsFromFixture("claude-stream.jsonl", claudeStreamLineToEvents);
    assert.deepEqual(events.map(summarise), [
      "tool.call Read",
      "tool.result ok",
      "tool.call Read",
      "tool.result ok",
      "message",
      "usage",
    ]);

    const usage = usageOf(events);
    assert.equal(usage.turns, 3, "turns must come from the result event's num_turns");
    assert.equal(usage.denials, 0, "an unrefused run reports zero denials");
    assert.ok((usage.costUsd ?? 0) > 0, "cost must come from total_cost_usd");
    assert.ok((usage.usage?.inputTokens ?? 0) > 0, "token counts must come from result.usage");
  });

  it("carries the tool input and the result excerpt", () => {
    const events = eventsFromFixture("claude-stream.jsonl", claudeStreamLineToEvents);
    const call = events[0];
    assert.equal(call.kind, "tool.call");
    if (call.kind !== "tool.call") return;
    assert.match((call.input as { file_path: string }).file_path, /package\.json$/u);
    assert.equal(call.callId, "toolu_0123YjsihFk9kZxfJtuG3vTb");

    const result = events[1];
    assert.equal(result.kind, "tool.result");
    if (result.kind !== "tool.result") return;
    assert.equal(result.callId, call.callId, "a result must be matchable to its call");
    assert.match(String(result.excerpt), /stream-probe/u);
  });

  it("reports a refused tool call as a failed result and a denial (FR-002)", () => {
    const events = eventsFromFixture("claude-denied-stream.jsonl", claudeStreamLineToEvents);
    assert.deepEqual(events.map(summarise), [
      "tool.call Bash",
      "tool.result error",
      "message",
      "usage",
    ]);
    assert.equal(usageOf(events).denials, 1, "permission_denials is the run-level refusal signal");
  });

  it("skips system, stream_event, rate_limit_event and unparseable lines", () => {
    assert.deepEqual(claudeStreamLineToEvents('{"type":"system","subtype":"init"}'), []);
    assert.deepEqual(claudeStreamLineToEvents('{"type":"stream_event","event":{}}'), []);
    assert.deepEqual(claudeStreamLineToEvents('{"type":"rate_limit_event"}'), []);
    assert.deepEqual(claudeStreamLineToEvents("not json at all"), []);
  });
});

describe("codexStreamLineToEvents — captured codex stream (FR-003)", () => {
  it("maps a command execution turn onto calls, results, messages and usage", () => {
    const events = eventsFromFixture("codex-stream.jsonl", codexStreamLineToEvents);
    assert.deepEqual(events.map(summarise), [
      "message",
      "tool.call command",
      "tool.result ok",
      "message",
      "usage",
    ]);
    assert.ok((usageOf(events).usage?.inputTokens ?? 0) > 0);
  });

  it("maps a file change turn, keeping the change list on the call", () => {
    const events = eventsFromFixture("codex-write-stream.jsonl", codexStreamLineToEvents);
    assert.deepEqual(events.map(summarise), [
      "message",
      "tool.call file_change",
      "tool.result ok",
      "message",
      "tool.call command",
      "tool.result ok",
      "message",
      "usage",
    ]);

    const call = events[1];
    assert.equal(call.kind, "tool.call");
    if (call.kind !== "tool.call") return;
    const changes = (call.input as { changes: { path: string; kind: string }[] }).changes;
    assert.equal(changes[0].kind, "update");
    assert.match(changes[0].path, /notes\.txt$/u);
    assert.ok((usageOf(events).usage?.inputTokens ?? 0) > 0);
  });

  it("skips thread.started, turn.started and unparseable lines", () => {
    assert.deepEqual(codexStreamLineToEvents('{"type":"thread.started","thread_id":"x"}'), []);
    assert.deepEqual(codexStreamLineToEvents('{"type":"turn.started"}'), []);
    assert.deepEqual(codexStreamLineToEvents("header noise"), []);
  });
});

const ALL_FIXTURES: [string, LineParser][] = [
  ["claude-stream.jsonl", claudeStreamLineToEvents],
  ["claude-denied-stream.jsonl", claudeStreamLineToEvents],
  ["codex-stream.jsonl", codexStreamLineToEvents],
  ["codex-write-stream.jsonl", codexStreamLineToEvents],
];

describe("adapters never emit the builder's own events (D2)", () => {
  for (const [name, parse] of ALL_FIXTURES) {
    it(`${name} produces no step.start or step.result`, () => {
      const kinds = eventsFromFixture(name, parse).map((event) => event.kind);
      assert.equal(kinds.includes("step.start"), false);
      assert.equal(kinds.includes("step.result"), false);
    });
  }
});

// The credential guard (spec 036 D8) redacts a denied call's result by callId,
// having seen the call first. That is an assumption about every adapter's
// stream, so the fixtures gate it rather than a comment claiming it.
describe("every result is matchable to a call that preceded it (D8)", () => {
  for (const [name, parse] of ALL_FIXTURES) {
    it(`${name} pairs each tool.result with an earlier tool.call`, () => {
      const seen = new Set<string>();
      for (const event of eventsFromFixture(name, parse)) {
        if (event.kind === "tool.call") {
          assert.equal(
            typeof event.callId,
            "string",
            `tool.call ${event.name} must carry a callId for the guard to key on`
          );
          seen.add(String(event.callId));
        }
        if (event.kind === "tool.result") {
          assert.ok(
            event.callId !== undefined && seen.has(event.callId),
            `tool.result callId ${String(event.callId)} was never announced by a call`
          );
        }
      }
    });
  }
});
