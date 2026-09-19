// V4: run-start refusal, decided without any model call.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkPortability } from "./portability.js";
import type { ModelEntry } from "./registry.js";
import type { StepDef } from "./types.js";

const claude: ModelEntry = { id: "sonnet", transport: "cli", cli: { bin: "claude" } };
const codex: ModelEntry = { id: "codex", transport: "cli", cli: { bin: "codex" } };
const api: ModelEntry = {
  id: "ollama-qwen",
  transport: "api",
  api: { endpoint: "http://localhost:11434/v1/chat/completions" },
};

function step(over: Partial<StepDef> = {}): StepDef {
  return { id: "verify", kind: "llm", prompt: "prompts/verify.md", ...over };
}

function reasonOf(result: ReturnType<typeof checkPortability>): string {
  assert.equal(result.ok, false, "expected a refusal");
  return result.ok ? "" : result.reason;
}

describe("checkPortability — refusals (V4)", () => {
  it("refuses codex with permissions.contents write", () => {
    const reason = reasonOf(
      checkPortability(step({ permissions: { contents: "write" } }), codex, "openai")
    );
    assert.match(reason, /"verify"/);
    assert.match(reason, /"openai"/);
    assert.match(reason, /cli:codex/);
    assert.match(reason, /permissions\.contents "write"/);
  });

  it("refuses the api transport with permissions.contents read", () => {
    const reason = reasonOf(
      checkPortability(step({ permissions: { contents: "read" } }), api, "local")
    );
    assert.match(reason, /"verify"/);
    assert.match(reason, /"local"/);
    assert.match(reason, /api/);
    assert.match(reason, /permissions\.contents "read"/);
  });

  it("refuses the api transport with permissions.contents write", () => {
    const reason = reasonOf(
      checkPortability(step({ permissions: { contents: "write" } }), api, "local")
    );
    assert.match(reason, /"verify"/);
    assert.match(reason, /permissions\.contents "write"/);
  });

  it("refuses a transport that cannot enforce the step's declared permissions.deny", () => {
    const reason = reasonOf(
      checkPortability(
        step({ permissions: { contents: "none", deny: ["ops/secrets-notes/**"] } }),
        api,
        "local"
      )
    );
    assert.match(reason, /"verify"/);
    assert.match(reason, /"local"/);
    assert.match(reason, /permissions\.deny/);
  });

  it("refuses codex with maxBudgetUsd", () => {
    const reason = reasonOf(checkPortability(step({ maxBudgetUsd: 0.5 }), codex, "openai"));
    assert.match(reason, /"verify"/);
    assert.match(reason, /maxBudgetUsd/);
  });

  // A pipeline-level cap is inherited by every step that declares none, so it must
  // be refused at run start too — otherwise the refusal only arrives at dispatch.
  it("refuses a pipeline-level maxBudgetUsd inherited by a codex step", () => {
    const reason = reasonOf(
      checkPortability(step(), codex, "openai", { defaultMaxBudgetUsd: 0.25 })
    );
    assert.match(reason, /"verify"/);
    assert.match(reason, /maxBudgetUsd/);
  });

  it("refuses a pipeline-level maxBudgetUsd inherited by an api step", () => {
    const reason = reasonOf(checkPortability(step(), api, "local", { defaultMaxBudgetUsd: 0.25 }));
    assert.match(reason, /maxBudgetUsd/);
  });

  it("accepts a pipeline-level maxBudgetUsd on claude", () => {
    assert.deepEqual(checkPortability(step(), claude, "anthropic", { defaultMaxBudgetUsd: 0.25 }), {
      ok: true,
    });
  });
});

describe("checkPortability — accepted combinations", () => {
  it("accepts claude with contents read and with contents write", () => {
    assert.deepEqual(
      checkPortability(step({ permissions: { contents: "read" } }), claude, "anthropic"),
      { ok: true }
    );
    assert.deepEqual(
      checkPortability(step({ permissions: { contents: "write" } }), claude, "anthropic"),
      { ok: true }
    );
  });

  it("accepts claude with maxBudgetUsd", () => {
    assert.deepEqual(checkPortability(step({ maxBudgetUsd: 1 }), claude, "anthropic"), {
      ok: true,
    });
  });

  it("accepts codex with a declared permissions.deny — the copy excludes those globs", () => {
    assert.deepEqual(
      checkPortability(
        step({ permissions: { contents: "read", deny: ["ops/secrets-notes/**"] } }),
        codex,
        "openai"
      ),
      { ok: true }
    );
  });

  it("accepts every transport for a step declaring no contents", () => {
    assert.deepEqual(checkPortability(step(), codex, "openai"), { ok: true });
    assert.deepEqual(checkPortability(step(), api, "local"), { ok: true });
  });
});

// FR-003a: capabilities are computed from config, so flipping one field flips
// the verdict. A hardcoded capability table cannot pass both halves of this test.
describe("checkPortability — codex read follows codexConfinement (FR-003a)", () => {
  const readStep = step({ permissions: { contents: "read" } });

  it("accepts codex + contents read when the confinement profile is composed", () => {
    assert.deepEqual(
      checkPortability(readStep, codex, "openai", { config: { codexConfinement: true } }),
      {
        ok: true,
      }
    );
  });

  it("refuses codex + contents read when the confinement profile is not composed", () => {
    const reason = reasonOf(
      checkPortability(readStep, codex, "openai", { config: { codexConfinement: false } })
    );
    assert.match(reason, /permissions\.contents "read"/);
  });
});
