// Tests for the run view's log, decision and output renderers (spec 036 V5,
// spec 037 V3/FR-011).
//
// These renderers are the only place the page builds HTML from model-produced
// JSON keys, so escaping is asserted per path: dropping esc() from any one of
// them has to turn a test red.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MAX_EVENTS_PER_STEP,
  mergeLogEvents,
  renderDecisions,
  renderLogEvent,
  renderOutput,
  renderStepFooter,
  toolCallSummary,
} from "./ui-log.js";

/** One event with the stamps the sink applies, so merge tests have real shapes. */
function event(seq: number, stepId: string, rest: Record<string, unknown>) {
  return { seq, stepId, at: "2026-09-14T10:00:00.000Z", runId: "r", pipelineId: "p", ...rest };
}

describe("toolCallSummary — one line per tool call (D10)", () => {
  it("summarises the built-in tools by their own argument names", () => {
    assert.equal(
      toolCallSummary({ name: "Read", input: { file_path: "/a/b.ts" } }),
      "Read /a/b.ts"
    );
    assert.equal(
      toolCallSummary({ name: "Grep", input: { pattern: "todo", path: "src" } }),
      'Grep "todo" src'
    );
    assert.equal(toolCallSummary({ name: "Glob", input: { pattern: "**/*.ts" } }), "Glob **/*.ts");
    assert.equal(toolCallSummary({ name: "Bash", input: { command: "ls -la" } }), "Bash ls -la");
    assert.equal(
      toolCallSummary({ name: "Edit", input: { file_path: "/a/b.ts" } }),
      "Edit /a/b.ts"
    );
    assert.equal(
      toolCallSummary({ name: "Write", input: { file_path: "/a/b.ts" } }),
      "Write /a/b.ts"
    );
  });

  it("falls back to the compact input for an unknown tool and cuts it at 160 chars", () => {
    assert.equal(
      toolCallSummary({ name: "WebFetch", input: { url: "https://example.test" } }),
      'WebFetch {"url":"https://example.test"}'
    );
    const long = toolCallSummary({ name: "Other", input: { q: "x".repeat(400) } });
    assert.ok(long.length <= 161, `expected a cut summary, got ${long.length} chars`);
    assert.ok(long.endsWith("…"), "a cut summary is marked with an ellipsis");
  });

  it("omits an argument the provider did not report", () => {
    assert.equal(toolCallSummary({ name: "Read", input: {} }), "Read");
    assert.equal(toolCallSummary({ name: "Grep", input: { pattern: "x" } }), 'Grep "x"');
  });
});

describe("renderLogEvent — escaping on every path (spec 036 Escaping, V5)", () => {
  it("escapes a message so a script tag cannot reach the DOM", () => {
    const html = renderLogEvent({ kind: "message", text: "<script>alert(1)</script>" });
    assert.ok(html.includes("&lt;script&gt;"), `message text must be escaped: ${html}`);
    assert.ok(!html.includes("<script"), "no live script tag may appear in the rendered HTML");
  });

  it("escapes a tool input, a check-output chunk and a watchdog detail", () => {
    const call = renderLogEvent({
      kind: "tool.call",
      name: "Read",
      input: { file_path: "<img src=x onerror=alert(1)>" },
    });
    assert.ok(call.includes("&lt;img"), `tool input must be escaped: ${call}`);
    assert.ok(!call.includes("<img"), "no live img tag from a tool input");

    const check = renderLogEvent({ kind: "check.output", stream: "stderr", text: "<b>boom</b>" });
    assert.ok(check.includes("&lt;b&gt;boom"), `check output must be escaped: ${check}`);
    assert.ok(check.includes('class="term stderr"'), "stderr is styled apart from stdout");

    const watchdog = renderLogEvent({
      kind: "watchdog",
      pathology: "stall",
      detail: "<i>no events</i>",
      attempt: 2,
    });
    assert.ok(watchdog.includes("&lt;i&gt;no events"), `watchdog detail must be escaped`);
    assert.ok(watchdog.includes("warn"), "a watchdog line is a warning line");
  });

  it("escapes a tool result excerpt and marks a denied call", () => {
    const result = renderLogEvent({ kind: "tool.result", ok: false, excerpt: "<hr>fail" });
    assert.ok(result.includes("result · error"), `an error result says so: ${result}`);
    assert.ok(result.includes("&lt;hr&gt;fail"), "the excerpt must be escaped");

    const redacted = renderLogEvent({ kind: "tool.result", ok: true, redacted: true });
    assert.ok(redacted.includes("redacted"), "a redacted result shows the word instead of output");

    const denied = renderLogEvent({
      kind: "tool.call",
      name: "Read",
      input: { path: ".env" },
      denied: true,
    });
    assert.ok(denied.includes("(denied)"), `a denied call is suffixed: ${denied}`);
    assert.ok(denied.includes("warn"), "a denied call is styled as a warning");
  });

  it("indents a nested call and renders the structural kinds as one muted line", () => {
    const nested = renderLogEvent({
      kind: "tool.call",
      name: "Glob",
      input: { pattern: "*" },
      nested: true,
    });
    assert.ok(nested.includes("nested"), `a subagent call is marked: ${nested}`);

    assert.ok(
      renderLogEvent({ kind: "log.truncated", events: 20000, bytes: 1 }).includes(
        "log truncated after 20000 events"
      )
    );
    assert.ok(
      renderLogEvent({ kind: "step.result", status: "succeeded", durationMs: 92000 }).includes(
        "1m 32s"
      )
    );
  });

  it("renders nothing for a usage event — the footer consumes it", () => {
    assert.equal(renderLogEvent({ kind: "usage", costUsd: 0.1 }), "");
    assert.equal(renderLogEvent({ kind: "not.a.kind" }), "");
  });
});

describe("renderStepFooter — cost, turns, duration, denials (D9)", () => {
  it("formats the parts the provider reported and omits the rest", () => {
    const html = renderStepFooter([
      event(1, "s", { kind: "usage", costUsd: 0.0123, turns: 14, denials: 2 }),
      event(2, "s", { kind: "step.result", status: "succeeded", durationMs: 92000 }),
    ]);
    assert.equal(html, "$0.0123 · 14 turns · 1m 32s · 2 denied");
  });

  it("shows tokens only when reported and drops a zero denial count", () => {
    const html = renderStepFooter([
      event(1, "s", { kind: "usage", usage: { inputTokens: 120, outputTokens: 34 }, denials: 0 }),
    ]);
    assert.equal(html, "120 in / 34 out");
  });

  it("reads the last usage event of the step", () => {
    const html = renderStepFooter([
      event(1, "s", { kind: "usage", turns: 1 }),
      event(2, "s", { kind: "usage", turns: 7 }),
    ]);
    assert.equal(html, "7 turns");
  });

  it("is empty when the step reported nothing", () => {
    assert.equal(renderStepFooter([event(1, "s", { kind: "message", text: "hi" })]), "");
    assert.equal(renderStepFooter([]), "");
  });
});

describe("renderDecisions — gate and judge verdicts (D10)", () => {
  it("renders a human row, a judge row, the superseded badge and the judge error", () => {
    const html = renderDecisions(
      [
        {
          gateStepId: "review",
          decidedBy: "human",
          approved: true,
          reason: "looks fine",
          decidedAt: "2026-09-14T10:00:00.000Z",
        },
        {
          gateStepId: "verify",
          decidedBy: "agent",
          approved: false,
          judgeModelId: "sonnet",
          reason: "<b>no</b>",
          decidedAt: "2026-09-14T10:05:00.000Z",
          superseded: true,
        },
      ],
      "judge returned malformed JSON twice"
    );
    assert.ok(html.includes("<td>human</td>"), `the human decider is named: ${html}`);
    assert.ok(html.includes("judge sonnet"), "a judge row names the judge model");
    assert.ok(html.includes("approved"), "the verdict column carries the verdict");
    assert.ok(html.includes("superseded"), "a superseded verdict is badged");
    assert.ok(html.includes("&lt;b&gt;no"), "a decision reason must be escaped");
    assert.ok(!html.includes("<b>no"), "no live markup from a decision reason");
    assert.ok(html.includes("judge returned malformed JSON twice"), "the judge error gets a row");
  });

  it("escapes the judge model id, which comes from the run record", () => {
    const html = renderDecisions(
      [{ gateStepId: "g", decidedBy: "agent", approved: true, judgeModelId: "<script>x</script>" }],
      undefined
    );
    assert.ok(html.includes("&lt;script&gt;"), `the judge model id must be escaped: ${html}`);
    assert.ok(!html.includes("<script"), "no live script tag from a judge model id");
  });

  it("is empty with no decisions and no judge error", () => {
    assert.equal(renderDecisions([], undefined), "");
    assert.equal(renderDecisions(undefined, undefined), "");
  });
});

describe("renderOutput — one step's persisted output (D6/D10)", () => {
  it("renders an array of objects as a table whose columns are the union of keys", () => {
    const html = renderOutput({
      kind: "json",
      output: [
        { file: "a.ts", verdict: "PASS" },
        { file: "b.ts", note: "n" },
      ],
    });
    assert.ok(html.includes("<th>file</th>"), `columns come from the keys: ${html}`);
    assert.match(
      html,
      /<th>file<\/th><th>verdict<\/th><th>note<\/th>/u,
      "columns keep their order of first appearance"
    );
    assert.ok(html.includes("PASS"), "cell values are rendered");
  });

  it("escapes a hostile column key and a hostile cell value", () => {
    const html = renderOutput({
      kind: "json",
      output: [{ "<img src=x onerror=alert(1)>": "<script>alert(2)</script>" }],
    });
    assert.ok(html.includes("&lt;img"), `the column key must be escaped: ${html}`);
    assert.ok(html.includes("&lt;script&gt;"), "the cell value must be escaped");
    assert.ok(!html.includes("<img"), "no live img tag from a JSON key");
    assert.ok(!html.includes("<script"), "no live script tag from a cell value");
  });

  it("cuts a long cell at 200 chars and keeps the full value behind an expander", () => {
    const long = "y".repeat(500);
    const html = renderOutput({ kind: "json", output: [{ note: long }] });
    assert.ok(html.includes("<details>"), `a long cell expands: ${html}`);
    assert.ok(html.includes(long), "the full value stays available");
    assert.ok(html.includes("…"), "the summary is cut");
  });

  it("pretty-prints any other JSON and renders text as-is", () => {
    const json = renderOutput({ kind: "json", output: { verdict: "PASS" } });
    assert.ok(json.includes("<pre"), "non-array JSON renders as a pre block");
    assert.ok(json.includes("&quot;verdict&quot;: &quot;PASS&quot;"), `escaped JSON: ${json}`);

    const text = renderOutput({ kind: "text", output: "<b>plain</b>" });
    assert.ok(text.includes("&lt;b&gt;plain"), `text output must be escaped: ${text}`);
    assert.ok(!text.includes("<b>plain"), "no live markup from a text output");
  });

  it("is empty without a payload", () => {
    assert.equal(renderOutput(undefined), "");
  });
});

describe("mergeLogEvents — idempotent merge by seq (D4/D5)", () => {
  it("drops events already applied and keeps the rest in seq order", () => {
    const first = mergeLogEvents(null, [
      event(2, "a", { kind: "message", text: "two" }),
      event(1, "a", { kind: "message", text: "one" }),
    ]);
    assert.equal(first.lastSeq, 2);
    assert.deepEqual(
      first.byStep.get("a")?.map((e) => (e as { text: string }).text),
      ["one", "two"],
      "an out-of-order batch is applied in seq order"
    );

    const second = mergeLogEvents(first, [
      event(2, "a", { kind: "message", text: "two" }),
      event(3, "a", { kind: "message", text: "three" }),
    ]);
    assert.equal(second.byStep.get("a")?.length, 3, "the duplicate seq is dropped, not appended");
    assert.equal(second.lastSeq, 3);
  });

  it("keeps each step's events apart and never mutates the given state", () => {
    const first = mergeLogEvents(null, [event(1, "a", { kind: "message", text: "a1" })]);
    const second = mergeLogEvents(first, [event(2, "b", { kind: "message", text: "b1" })]);
    assert.equal(first.byStep.has("b"), false, "the earlier state is untouched");
    assert.equal(first.lastSeq, 1);
    assert.equal(second.byStep.get("a")?.length, 1);
    assert.equal(second.byStep.get("b")?.length, 1);
  });

  it(`caps a step at ${MAX_EVENTS_PER_STEP} events and counts the ones it dropped`, () => {
    const batch = [];
    for (let i = 1; i <= MAX_EVENTS_PER_STEP + 5; i += 1)
      batch.push(event(i, "a", { kind: "message", text: `m${i}` }));
    const state = mergeLogEvents(null, batch);
    assert.equal(state.byStep.get("a")?.length, MAX_EVENTS_PER_STEP);
    assert.equal(state.droppedEarlier.get("a"), 5, "the page reports how many it cut");
    assert.equal(
      (state.byStep.get("a")?.[0] as { text: string }).text,
      "m6",
      "the oldest events are the ones dropped"
    );
  });
});
