// Spec 042 D23 — what the provider columns may say about the account.
//
// The load-bearing test is the last one: `claude auth status` prints the
// signed-in email and an organisation id beside the plan, and neither may reach
// the page. A parser that spreads the CLI's object would pass every other test
// here and leak both.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  accountLabel,
  parseAnthropicStatus,
  parseOpenaiStatus,
  probeProviderAccounts,
} from "./providerAccounts.js";

const CLAUDE_STATUS = JSON.stringify({
  loggedIn: true,
  authMethod: "claude.ai",
  apiProvider: "firstParty",
  projectsDirectory: "/Users/someone/.claude/projects",
  configDirectory: "/Users/someone/.claude",
  email: "someone@example.com",
  orgId: "b2f8046c-94f1-4519-bcf7-4a8cffc92442",
  orgName: "someone@example.com's Organization",
  subscriptionType: "max",
});

describe("parseAnthropicStatus — the plan, and nothing else", () => {
  it("reads the subscription tier and the auth method", () => {
    assert.deepEqual(parseAnthropicStatus(CLAUDE_STATUS), {
      plan: "max",
      authMethod: "claude.ai",
    });
  });

  it("carries neither the email nor the organisation id", () => {
    const account = parseAnthropicStatus(CLAUDE_STATUS);
    const serialised = JSON.stringify(account);
    assert.ok(!serialised.includes("example.com"), `the email must not travel: ${serialised}`);
    assert.ok(!serialised.includes("b2f8046c"), `the org id must not travel: ${serialised}`);
    assert.deepEqual(Object.keys(account).sort(), ["authMethod", "plan"]);
  });

  it("says so when the CLI is not signed in", () => {
    assert.deepEqual(parseAnthropicStatus(JSON.stringify({ loggedIn: false })), {
      error: "not signed in",
    });
  });

  it("refuses output it cannot read rather than inventing a plan", () => {
    assert.match(String(parseAnthropicStatus("not json").error), /did not print JSON/u);
    assert.match(String(parseAnthropicStatus(undefined).error), /did not answer/u);
    assert.equal(parseAnthropicStatus(JSON.stringify({ loggedIn: true })).plan, undefined);
  });
});

describe("parseOpenaiStatus — an auth method, and no invented plan", () => {
  it("reads how the CLI is signed in", () => {
    assert.deepEqual(parseOpenaiStatus("Logged in using ChatGPT"), { authMethod: "ChatGPT" });
  });

  it("reports no plan, because the CLI reports none", () => {
    // The codex model list does depend on the plan, which is exactly why a
    // guess here would be worse than an absence.
    assert.equal(parseOpenaiStatus("Logged in using ChatGPT").plan, undefined);
  });

  it("says so when the CLI is not signed in", () => {
    assert.deepEqual(parseOpenaiStatus("Not logged in"), { error: "not signed in" });
  });
});

describe("accountLabel — one line for a column header", () => {
  it("prefers the plan, falls back to the auth method", () => {
    assert.equal(accountLabel({ plan: "max", authMethod: "claude.ai" }), "max");
    assert.equal(accountLabel({ authMethod: "ChatGPT" }), "ChatGPT");
  });

  it("shows the reason when there is one, rather than an empty column", () => {
    assert.equal(accountLabel({ error: "not signed in" }), "not signed in");
    assert.equal(accountLabel(undefined), "");
  });
});

describe("probeProviderAccounts — keyed by the vendor the matrix already uses", () => {
  it("asks each CLI its own status command", () => {
    const calls: string[] = [];
    const accounts = probeProviderAccounts((bin, args) => {
      calls.push([bin, ...args].join(" "));
      return bin === "claude" ? CLAUDE_STATUS : "Logged in using ChatGPT";
    });
    assert.deepEqual(calls, ["claude auth status", "codex login status"]);
    assert.equal(accounts.anthropic.plan, "max");
    assert.equal(accounts.openai.authMethod, "ChatGPT");
  });

  it("survives a CLI that is not installed", () => {
    const accounts = probeProviderAccounts(() => undefined);
    assert.ok(accounts.anthropic.error, "an absent CLI is an answer, not a crash");
    assert.ok(accounts.openai.error);
  });
});
