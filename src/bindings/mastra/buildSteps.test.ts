// Tests for buildCheckStep: verifies that step.env is mapped to envAllowlist so
// declared environment variables actually reach the child process.

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";
import { buildCheckStep } from "./buildSteps.js";
import type { ModelRegistry } from "../../canon/registry.js";
import type { SpawnFn } from "../../canon/runClaudeCli.js";
import type { StepDef } from "../../canon/types.js";
import type { TicketStore } from "../../module/seams.js";

// ── Env-capturing spawn factory ───────────────────────────────────────────────

function makeEnvCapturingSpawn(): {
  spawn: SpawnFn;
  getCapturedEnv: () => NodeJS.ProcessEnv | undefined;
} {
  let capturedEnv: NodeJS.ProcessEnv | undefined;
  const spawn = ((_cmd: string, _args: string[], opts: { env?: NodeJS.ProcessEnv }) => {
    capturedEnv = opts.env;
    const emitter = new EventEmitter();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child = Object.assign(emitter, {
      stdin,
      stdout,
      stderr,
      kill: () => undefined,
    });
    setImmediate(() => {
      stdout.push(null);
      stderr.push(null);
      emitter.emit("close", 0);
    });
    return child;
  }) as unknown as SpawnFn;
  return { spawn, getCapturedEnv: () => capturedEnv };
}

// ── Minimal deps for check step (registry and store are unused by buildCheckStep) ─

const NOOP_REGISTRY = {} as unknown as ModelRegistry;
const NOOP_STORE = {} as unknown as TicketStore;

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("buildCheckStep — step.env reaches the child process", () => {
  it("variable declared in step.env is present in the child's environment", async () => {
    // YOKE_TEST_CHECK_ENV_VAR is not in CHECK_ENV_ALLOWLIST.
    // Without step.env → envAllowlist mapping it would be stripped by buildCheckEnv.
    const sentinelKey = "YOKE_TEST_CHECK_ENV_VAR";
    const sentinelVal = "sentinel_abc_123";
    process.env[sentinelKey] = sentinelVal;
    try {
      const { spawn, getCapturedEnv } = makeEnvCapturingSpawn();
      const step: StepDef = {
        id: "check-step",
        kind: "check",
        command: "echo hi",
        env: [sentinelKey],
      };
      const checkStep = buildCheckStep(
        step,
        {
          registry: NOOP_REGISTRY,
          store: NOOP_STORE,
          runnerDeps: { spawn },
        },
        undefined
      );

      await (checkStep as any).execute({ inputData: {}, suspend: () => undefined as never });

      const env = getCapturedEnv();
      assert.ok(env !== undefined, "spawn must be called with an env object");
      assert.equal(
        env![sentinelKey],
        sentinelVal,
        `${sentinelKey} must reach the child process — fails without step.env → envAllowlist mapping`
      );
    } finally {
      delete process.env[sentinelKey];
    }
  });

  it("variable NOT declared in step.env is stripped from the child's environment", async () => {
    const undeclaredKey = "YOKE_TEST_UNDECLARED_VAR";
    process.env[undeclaredKey] = "should_be_stripped";
    try {
      const { spawn, getCapturedEnv } = makeEnvCapturingSpawn();
      const step: StepDef = {
        id: "check-step-no-env",
        kind: "check",
        command: "echo hi",
        // No env declaration — undeclaredKey must be absent from child env
      };
      const checkStep = buildCheckStep(
        step,
        {
          registry: NOOP_REGISTRY,
          store: NOOP_STORE,
          runnerDeps: { spawn },
        },
        undefined
      );

      await (checkStep as any).execute({ inputData: {}, suspend: () => undefined as never });

      const env = getCapturedEnv();
      assert.equal(
        env?.[undeclaredKey],
        undefined,
        "undeclared variable must be stripped by the base allowlist"
      );
    } finally {
      delete process.env[undeclaredKey];
    }
  });
});
