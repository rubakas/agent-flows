// Spec 042 V1/V4/V5 — what the daemons panel is allowed to offer.
//
// The load-bearing parts need no DOM: a stale record must carry no Stop control
// wired to its pid (D3), a stop the page could not observe must not read as
// "stopped" (D9), and an empty panel must say what to do next (FR-006).

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  daemonRow,
  daemonsTable,
  fmtUptime,
  stopConfirmText,
  stopResultLine,
  type DaemonRowData,
} from "./ui-daemons.js";

const HOSTILE = '<img src=x onerror=alert(1)>"';

function entry(over: Partial<DaemonRowData> = {}): DaemonRowData {
  return {
    projectKey: "-Users-en3e-code-agent-flows",
    projectDir: "/Users/en3e/code/agent-flows",
    pid: 54733,
    port: 7411,
    startedAt: "2026-09-19T10:00:00.000Z",
    live: true,
    self: false,
    ...over,
  };
}

describe("daemonRow — only a verified record gets a Stop (spec 042 D3, V1)", () => {
  it("a live row shows pid, port, uptime and a Stop wired to the project key", () => {
    const html = daemonRow(entry(), { now: Date.parse("2026-09-21T12:00:00.000Z") });
    assert.ok(html.includes(">54733<"), `the pid must be visible: ${html}`);
    assert.ok(html.includes(">7411<"), `the port must be visible: ${html}`);
    assert.ok(html.includes(">2d 02h<"), `uptime must be visible: ${html}`);
    assert.ok(
      html.includes('data-stop-daemon="-Users-en3e-code-agent-flows"'),
      `a verified daemon is stoppable: ${html}`
    );
  });

  it("a stale row offers no Stop at all (V1)", () => {
    const html = daemonRow(
      entry({ live: false, staleReason: "nothing answered on port 7411" }),
      {}
    );
    assert.ok(
      !html.includes("data-stop-daemon"),
      `D3 forbids signalling an unverified pid — this row must carry no control: ${html}`
    );
    assert.ok(html.includes("not responding"), `the row must say why it is not live: ${html}`);
    assert.ok(html.includes("nothing answered on port 7411"), `the reason is kept: ${html}`);
  });

  it("marks the daemon serving this page, and no other (D9)", () => {
    const self = daemonRow(entry({ self: true }), {});
    assert.ok(self.includes("this page"), `the serving daemon must say so: ${self}`);
    // One chip, not a `running` chip plus a `this page` chip saying the same thing.
    assert.equal(self.match(/class="badge/gu)?.length, 1, `one chip per row: ${self}`);
    const other = daemonRow(entry({ self: false }), {});
    assert.ok(!other.includes("this page"), `only one row may claim the page: ${other}`);
    assert.ok(other.includes(">running<"), `another live daemon still reads as running: ${other}`);
  });

  it("a row whose stop is in flight shows stopping…, not a second button", () => {
    const html = daemonRow(entry(), { busy: "-Users-en3e-code-agent-flows" });
    assert.ok(html.includes("stopping…"));
    assert.ok(
      !html.includes("data-stop-daemon"),
      `a second click must not be able to issue a second SIGTERM: ${html}`
    );
  });

  it("escapes every field that comes from disk", () => {
    const html = daemonRow(entry({ projectDir: HOSTILE, projectKey: HOSTILE }), {});
    assert.ok(!html.includes("<img"), `raw markup must not reach the row: ${html}`);
  });
});

describe("daemonsTable — the empty state invites an action (spec 042 FR-006, V5)", () => {
  it("names the command that starts a daemon", () => {
    const html = daemonsTable([]);
    assert.match(html, /No daemon is running/u);
    assert.match(html, /pnpm serve/u, "an empty state with nothing to do about it is the bug");
  });

  it("renders one row per project, stale ones included (D2, D3)", () => {
    const html = daemonsTable([
      entry({ projectKey: "a", pid: 1 }),
      entry({ projectKey: "b", pid: 2, live: false }),
    ]);
    assert.equal(html.match(/data-daemon-row=/gu)?.length, 2);
    assert.equal(
      html.match(/data-stop-daemon=/gu)?.length,
      1,
      "only the verified row may be stoppable"
    );
  });
});

describe("stop confirmation and outcome (spec 042 D8, FR-003/FR-004)", () => {
  it("the confirm names the project and the pid being killed", () => {
    const text = stopConfirmText("agent-flows", 54733);
    assert.match(text, /agent-flows/u);
    assert.match(text, /pid 54733/u);
  });

  it("renders each StopReport outcome verbatim, with no retry language", () => {
    assert.equal(stopResultLine({ outcome: "stopped" }), "Stopped.");
    assert.match(stopResultLine({ outcome: "no-daemon", reason: "stale" }), /Nothing to stop/u);
    assert.match(
      stopResultLine({ outcome: "unresolved", reason: "still answering" }),
      /Unresolved — still answering\./u
    );
  });

  it("a stop the page could not observe reads disconnected, never stopped (V4)", () => {
    const line = stopResultLine({ disconnected: true });
    assert.match(line, /Disconnected/u);
    assert.ok(
      !/stopped\./iu.test(line),
      `the page has no daemon left to ask, so it must not claim a stop it cannot see: ${line}`
    );
  });
});

describe("fmtUptime", () => {
  it("counts days once a daemon has outlived the operator's memory of it", () => {
    assert.equal(
      fmtUptime("2026-09-19T10:00:00.000Z", Date.parse("2026-09-21T12:30:00.000Z")),
      "2d 02h"
    );
    assert.equal(
      fmtUptime("2026-09-21T10:00:00.000Z", Date.parse("2026-09-21T12:30:00.000Z")),
      "2h 30m"
    );
    assert.equal(fmtUptime("not a date"), "—");
  });
});
