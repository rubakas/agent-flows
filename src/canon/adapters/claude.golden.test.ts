// V1 golden argv capture for the claude transport.
//
// Pins the exact claude CLI invocation produced for pipelines/code-review.yaml's
// `verify` step under profile `anthropic` — no ctx models override, no skills,
// no maxBudgetUsd, a fixed workspace and a fixed prompt. The capture was taken
// before the adapter extraction (spec 031 FR-001) and before permissions.allow
// was deleted (D5): if either change alters a flag, this test goes red.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { loadPipeline } from "../load.js";
import { defaultRegistry, getProfile, resolveStepModel } from "../registry.js";
import { runLlmStep } from "../runStep.js";
import { makeStreamJsonStdout } from "../testing/fakeSpawn.js";
import { makeFakeChild } from "../testing/fakeSpawn.js";
import type { SpawnFn } from "../runClaudeCli.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..", "..", "..");
const fixturePath = join(__dirname, "__fixtures__", "claude-argv.golden.json");

/** Placeholder substituted for the machine-specific workspace path. */
const WORKSPACE_PLACEHOLDER = "<WORKSPACE>";

/** The fixed argv prefix runClaudeCli emits before --model/--max-budget-usd/extraArgs. */
const BASE_ARGV = [
  "-p",
  "--output-format",
  "stream-json",
  "--verbose",
  "--include-partial-messages",
];

interface CapturedInvocation {
  model?: string;
  extraArgs: string[];
  cwd: string;
}

/** Splits a full claude argv into the model and the adapter-assembled extraArgs. */
function splitArgv(argv: string[]): { model?: string; extraArgs: string[] } {
  assert.deepEqual(argv.slice(0, BASE_ARGV.length), BASE_ARGV, "unexpected claude argv prefix");
  let rest = argv.slice(BASE_ARGV.length);
  let model: string | undefined;
  if (rest[0] === "--model") {
    model = rest[1];
    rest = rest.slice(2);
  }
  if (rest[0] === "--max-budget-usd") {
    rest = rest.slice(2);
  }
  return { model, extraArgs: rest };
}

async function captureVerifyStepInvocation(): Promise<CapturedInvocation> {
  const { def } = loadPipeline(join(repoRoot, "pipelines", "code-review.yaml"));
  const step = def.steps.find((s) => s.id === "verify");
  assert.ok(step, "code-review.yaml must declare a `verify` step");
  assert.equal(step.permissions?.contents, "read");

  const entry = resolveStepModel(step, getProfile("anthropic"), defaultRegistry({}));

  // A HOME with no .claude/settings.json keeps operatorDenyRules() deterministic.
  const home = mkdtempSync(join(tmpdir(), "agent-flows-golden-home-"));
  const workspace = mkdtempSync(join(tmpdir(), "agent-flows-golden-ws-"));

  let captured: { argv: string[]; cwd: string } | undefined;
  const spawn = ((_cmd: string, args: string[], opts: { cwd?: string }) => {
    captured = { argv: args, cwd: opts.cwd ?? "" };
    return makeFakeChild({ stdoutChunks: [makeStreamJsonStdout("ok")] }).child;
  }) as unknown as SpawnFn;

  try {
    await runLlmStep(entry, "GOLDEN PROMPT", {
      spawn,
      env: { HOME: home },
      contentsAccess: "read",
      workspaceDir: workspace,
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }

  assert.ok(captured, "claude CLI was never spawned");
  const { model, extraArgs } = splitArgv(captured.argv);
  assert.equal(captured.cwd, workspace, "step must run in the declared workspace");
  return { ...(model !== undefined ? { model } : {}), extraArgs, cwd: WORKSPACE_PLACEHOLDER };
}

describe("golden argv — code-review `verify` under profile anthropic (V1)", () => {
  it("matches the captured fixture byte for byte", async () => {
    const actual = await captureVerifyStepInvocation();
    const expected = JSON.parse(readFileSync(fixturePath, "utf8")) as CapturedInvocation;
    assert.deepEqual(actual, expected);
  });
});
