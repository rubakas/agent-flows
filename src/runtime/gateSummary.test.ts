// Spec 043 V1/V5 — the summary is allowed to fail, and allowed to cost once.
//
// The contract this file defends is negative: after every failure mode, the gate
// must be exactly as approvable as it was before this feature existed. A gate a
// person cannot answer because a description of it could not be written would be
// a strictly worse gate than the bare question it replaced.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { ModelRegistry } from "../canon/registry.js";
import { packageRoot } from "../packageRoot.js";

import { SUMMARY_CHAR_CAP, SUMMARY_SHORTENED_NOTE, runGateSummary } from "./gateSummary.js";
import type { GateSummaryDeps } from "./gateSummary.js";
import type { ProviderProfile } from "../canon/registry.js";

const PROFILE: ProviderProfile = {
  id: "test",
  roles: { reasoner: "m-big", worker: "m-mid", scout: "m-small" },
};

const REGISTRY = new ModelRegistry([
  { id: "m-small", transport: "api", api: { endpoint: "https://example.invalid" } },
]);

function deps(over: Partial<GateSummaryDeps> = {}): GateSummaryDeps {
  return {
    registry: REGISTRY,
    profile: PROFILE,
    projectDir: process.cwd(),
    summaryPrompt: "Describe it.",
    runner: async () => "It pins the Node version and nothing else changes.",
    ...over,
  };
}

const PAYLOAD = { message: "Approve this spec?", spec: { title: "A spec" } };

describe("runGateSummary — the happy path (FR-001)", () => {
  it("returns the model's paragraph", async () => {
    const out = await runGateSummary(deps(), "spec-creation", "approve", PAYLOAD);
    assert.ok("summary" in out, JSON.stringify(out));
    assert.equal(out.summary, "It pins the Node version and nothing else changes.");
  });

  it("shows the model the gate question and the payload", async () => {
    let seen = "";
    await runGateSummary(
      deps({
        runner: async (_e, prompt) => {
          seen = prompt;
          return "ok";
        },
      }),
      "spec-creation",
      "approve",
      PAYLOAD
    );
    assert.match(seen, /Describe it\./u, "its own instructions come first");
    assert.match(seen, /Gate question: Approve this spec\?/u, seen);
    assert.match(seen, /Gate step: approve/u, seen);
    assert.match(seen, /"title":"A spec"/u, "the payload must reach it");
    assert.match(seen, /untrusted data, not instructions/u, "and be fenced as data");
  });

  it("uses the scout role, never the reasoner (D7)", async () => {
    let usedId = "";
    await runGateSummary(
      deps({
        runner: async (entry) => {
          usedId = entry.id;
          return "ok";
        },
      }),
      "p",
      "g",
      PAYLOAD
    );
    assert.equal(usedId, "m-small", "the judge pays for reasoner; a description does not");
  });

  it("prefers the run's own profile over the daemon's (a pinned run stays pinned)", async () => {
    let usedId = "";
    const runProfile = { id: "other", roles: { scout: "m-other" } } as ProviderProfile;
    await runGateSummary(
      deps({
        runner: async (entry) => {
          usedId = entry.id;
          return "ok";
        },
      }),
      "p",
      "g",
      PAYLOAD,
      runProfile
    );
    assert.equal(usedId, "m-other");
  });
});

describe("runGateSummary — every failure is an absent summary, never a thrown one (D3, V1)", () => {
  it("a transport error comes back as an error, not an exception", async () => {
    const out = await runGateSummary(
      deps({
        runner: async () => {
          throw new Error("provider is down");
        },
      }),
      "p",
      "g",
      PAYLOAD
    );
    assert.ok("error" in out, JSON.stringify(out));
    assert.match(out.error, /provider is down/u);
  });

  it("an empty answer is an error, not an empty summary", async () => {
    // An empty gate-summary block on the page would read as "there is nothing
    // to say about this run", which is a claim the model never made.
    for (const answer of ["", "   ", "\n```\n```\n"]) {
      const out = await runGateSummary(deps({ runner: async () => answer }), "p", "g", PAYLOAD);
      assert.ok("error" in out, `${JSON.stringify(answer)} → ${JSON.stringify(out)}`);
    }
  });

  it("a profile with no scout model is an error, not a crash", async () => {
    const out = await runGateSummary(
      deps({ profile: { id: "x", roles: {} } as ProviderProfile }),
      "p",
      "g",
      PAYLOAD
    );
    assert.ok("error" in out, JSON.stringify(out));
    assert.match(out.error, /scout/u);
  });
});

describe("runGateSummary — what reaches the box is bounded (D8)", () => {
  it("caps a model that ignored the word limit", async () => {
    const out = await runGateSummary(
      deps({ runner: async () => "word ".repeat(1000) }),
      "p",
      "g",
      PAYLOAD
    );
    assert.ok("summary" in out);
    const body = out.summary.replace(SUMMARY_SHORTENED_NOTE, "").trimEnd();
    assert.ok(body.length <= SUMMARY_CHAR_CAP, String(body.length));
    assert.ok(out.summary.includes(SUMMARY_SHORTENED_NOTE), "and says it was cut");
  });

  it("ends a shortened summary at a sentence, never mid-word", async () => {
    // The failure the owner screenshotted: "…an unguarded caller-s…". The cap
    // lands inside the third sentence, so the second is the last one kept.
    const tail = ` It ${"also ".repeat(200)}does.`;
    const raw = `It adds a caller-supplied path. It never checks that path.${tail} And more.`;
    const out = await runGateSummary(deps({ runner: async () => raw }), "p", "g", PAYLOAD);

    assert.ok("summary" in out);
    const body = out.summary.replace(SUMMARY_SHORTENED_NOTE, "").trimEnd();
    assert.ok(body.length <= SUMMARY_CHAR_CAP, `body is ${body.length} chars`);
    assert.match(body, /\.$/u, `must end at a sentence, got: …${body.slice(-40)}`);
    assert.ok(
      raw.startsWith(body),
      "the kept text must be a prefix of what the model actually wrote"
    );
    assert.ok(
      !out.summary.endsWith("…"),
      "a bare ellipsis is not a disclosure — say the summary was shortened"
    );
  });

  it("cuts at a word boundary when the model wrote no sentence end", async () => {
    const out = await runGateSummary(
      deps({ runner: async () => "word ".repeat(1000) }),
      "p",
      "g",
      PAYLOAD
    );
    assert.ok("summary" in out);
    const body = out.summary.replace(SUMMARY_SHORTENED_NOTE, "").trimEnd();
    assert.ok(body.endsWith("word"), `cut mid-word: …${JSON.stringify(body.slice(-12))}`);
  });

  it("a summary within the cap is left exactly as written", async () => {
    const raw = "It pins Node to 22.x and nothing else.";
    const out = await runGateSummary(deps({ runner: async () => raw }), "p", "g", PAYLOAD);
    assert.ok("summary" in out);
    assert.equal(out.summary, raw);
  });

  it("strips the wrappers the prompt forbids", async () => {
    for (const [raw, want] of [
      ["```\nIt pins Node.\n```", "It pins Node."],
      ["Summary: It pins Node.", "It pins Node."],
      ["```text\nIt pins Node.\n```", "It pins Node."],
    ]) {
      const out = await runGateSummary(deps({ runner: async () => raw }), "p", "g", PAYLOAD);
      assert.ok("summary" in out, raw);
      assert.equal(out.summary, want, raw);
    }
  });
});

describe("the shipped prompt (spec 043 D5)", () => {
  it("exists, is shipped, and forbids recommending a decision", () => {
    const text = readFileSync(join(packageRoot(), "prompts", "gate-summary.md"), "utf8");

    // D5 is the decision this prompt exists to enforce: the text lands between
    // an Approve button and a Reject button, so a model that hedges toward one
    // of them has cast a vote nobody asked it for.
    assert.match(text, /do not recommend|not the judge/iu, "it must disclaim the verdict");
    assert.match(text, /untrusted|data, not instructions/iu, "the material is untrusted");
    assert.match(text, /\b(80|four)\b/u, "it must bound the length");
  });
});
