// Tests for buildCheckStep and buildLlmStep step builders.

import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";
import { ModelRegistry, defaultRegistry, getProfile } from "../../canon/registry.js";
import { UNRECOGNIZED_MODEL_SUBTYPE } from "../../canon/runClaudeCli.js";
import {
  CREDENTIAL_DENY_PATTERNS,
  StepTimeoutError,
  TransportFailureError,
  runLlmStep,
} from "../../canon/runStep.js";
import { WEAK_SCHEMA } from "../../canon/schemas.js";
import { makeFakeChild, makeStreamJsonChild } from "../../canon/testing/fakeSpawn.js";
import { packageRoot } from "../../packageRoot.js";
import {
  clearRun as clearStepIntrospection,
  getRun as getStepIntrospection,
} from "../../runtime/stepIntrospection.js";
import {
  closeRunLog,
  openRunLog,
  readRunLog,
  readStepOutput,
  runLogFile,
  stepOutputFile,
  stepRawOutputFile,
} from "../../runtime/stepLog.js";
import {
  DEFAULT_CHECK_COMMAND,
  buildCheckStep,
  buildLlmStep,
  buildReviewMaterialStep,
  unavailableStepMarker,
} from "./buildSteps.js";
import type { ModelEntry } from "../../canon/registry.js";
import type { SpawnFn } from "../../canon/runClaudeCli.js";
import type { StepLogEvent } from "../../canon/stepLogEvents.js";
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

// Command-capturing spawn: captures args[1] (the shell command) and exits with
// the mapped code, or 0 for unmapped commands.
function makeCommandCapturingSpawn(exitCodes: Record<string, number> = {}): {
  spawn: SpawnFn;
  getCapturedCommand: () => string | undefined;
} {
  let capturedCommand: string | undefined;
  const spawn = ((_cmd: string, args: string[]) => {
    // /bin/sh -c <command> — args[1] is the command string.
    capturedCommand = args[1];
    const exitCode = capturedCommand !== undefined ? (exitCodes[capturedCommand] ?? 0) : 0;
    const { child } = makeFakeChild({ exitCode });
    return child;
  }) as unknown as SpawnFn;
  return { spawn, getCapturedCommand: () => capturedCommand };
}

// ── Minimal deps for check step (registry and store are unused by buildCheckStep) ─

const NOOP_REGISTRY = new ModelRegistry([]);
const NOOP_STORE = {} as unknown as TicketStore;

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("buildCheckStep — step.env reaches the child process", () => {
  it("variable declared in step.env is present in the child's environment", async () => {
    // AGENT_FLOWS_TEST_CHECK_ENV_VAR is not in CHECK_ENV_ALLOWLIST.
    // Without step.env → envAllowlist mapping it would be stripped by buildCheckEnv.
    const sentinelKey = "AGENT_FLOWS_TEST_CHECK_ENV_VAR";
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
    const undeclaredKey = "AGENT_FLOWS_TEST_UNDECLARED_VAR";
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

// ─── FR-003 / FR-004: {{checkCommand}} substitution ──────────────────────────

describe("buildCheckStep — {{checkCommand}} substitution (FR-003/FR-004)", () => {
  it("absent checkCommand in deps uses DEFAULT_CHECK_COMMAND", async () => {
    const { spawn, getCapturedCommand } = makeCommandCapturingSpawn();
    const step: StepDef = { id: "test", kind: "check", command: "{{checkCommand}}" };
    const checkStep = buildCheckStep(
      step,
      { registry: NOOP_REGISTRY, store: NOOP_STORE, runnerDeps: { spawn } },
      undefined
    );
    await (checkStep as any).execute({ inputData: {}, suspend: () => undefined as never });
    assert.equal(
      getCapturedCommand(),
      DEFAULT_CHECK_COMMAND,
      "missing checkCommand must resolve to DEFAULT_CHECK_COMMAND"
    );
  });

  it("checkCommand in deps is substituted into the command at build time", async () => {
    const customCmd = "make test";
    const { spawn, getCapturedCommand } = makeCommandCapturingSpawn();
    const step: StepDef = { id: "test", kind: "check", command: "{{checkCommand}}" };
    const checkStep = buildCheckStep(
      step,
      {
        registry: NOOP_REGISTRY,
        store: NOOP_STORE,
        runnerDeps: { spawn },
        checkCommand: customCmd,
      },
      undefined
    );
    await (checkStep as any).execute({ inputData: {}, suspend: () => undefined as never });
    assert.equal(getCapturedCommand(), customCmd, "configured checkCommand must be substituted");
  });

  it("run-context key named checkCommand has no effect — substitution is build-time only", async () => {
    // Even if the pipeline input or step output carries a key named "checkCommand",
    // the substitution already happened at build time from BuildDeps.
    // Passing a different value in inputData must not change the executed command.
    const buildTimeCmd = "exit 1";
    const { spawn, getCapturedCommand } = makeCommandCapturingSpawn({ "exit 1": 1 });
    const step: StepDef = { id: "test", kind: "check", command: "{{checkCommand}}" };
    const checkStep = buildCheckStep(
      step,
      {
        registry: NOOP_REGISTRY,
        store: NOOP_STORE,
        runnerDeps: { spawn },
        checkCommand: buildTimeCmd,
      },
      undefined
    );
    // Run with a context that tries to override checkCommand — must have no effect.
    await (checkStep as any).execute({
      inputData: { checkCommand: "exit 0" },
      suspend: () => undefined as never,
    });
    assert.equal(
      getCapturedCommand(),
      "exit 1",
      "run-context checkCommand must not override the build-time substitution"
    );
  });

  it("literal command with no braces is passed through unchanged", async () => {
    const { spawn, getCapturedCommand } = makeCommandCapturingSpawn();
    const step: StepDef = { id: "test", kind: "check", command: "pnpm lint && pnpm typecheck" };
    const checkStep = buildCheckStep(
      step,
      { registry: NOOP_REGISTRY, store: NOOP_STORE, runnerDeps: { spawn } },
      undefined
    );
    await (checkStep as any).execute({ inputData: {}, suspend: () => undefined as never });
    assert.equal(
      getCapturedCommand(),
      "pnpm lint && pnpm typecheck",
      "command without placeholders must reach the shell byte-identical"
    );
  });

  it("DEFAULT_CHECK_COMMAND mirrors package.json check script — divergence goes red", () => {
    // This test reads the project's real gate from package.json and asserts it
    // equals DEFAULT_CHECK_COMMAND. If a step is added to one without the other
    // this test goes red, catching the same defect class found on 2026-09-07:
    // a self-run converged with passing tests + clean typecheck but failing
    // format:check because the old default omitted pnpm format:check.
    const pkgPath = join(packageRoot(), "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { scripts: { check: string } };
    assert.equal(
      DEFAULT_CHECK_COMMAND,
      pkg.scripts.check,
      "DEFAULT_CHECK_COMMAND must be byte-identical to the check script in package.json. " +
        "Add the missing step to whichever side diverged."
    );
  });
});

// ─── FR-007: step id labeling on runner errors ────────────────────────────────

describe("buildLlmStep — step id in error message (FR-007)", () => {
  it("non-write step timeout surfaces as Step '<id>': StepTimeoutError without workspace suffix", async () => {
    // FR-007 applies to every step; FR-008 (workspace state) only applies to write steps.
    const throwingRunner: typeof runLlmStep = async () => {
      throw new StepTimeoutError(600_000);
    };
    const step: StepDef = {
      id: "investigate.survey",
      kind: "llm",
      prompt: "prompts/survey.md",
    };
    const deps = {
      registry: NOOP_REGISTRY,
      store: NOOP_STORE,
      runner: throwingRunner,
    };
    const llmStep = buildLlmStep(step, { "investigate.survey": "survey prompt" }, deps, undefined);

    await assert.rejects(
      (llmStep as any).execute({ inputData: {}, suspend: () => undefined as never }),
      (err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        assert.ok(
          msg.startsWith('Step "investigate.survey":'),
          `error must start with step id prefix; got: ${msg}`
        );
        assert.ok(msg.includes("timed out"), `error must contain 'timed out'; got: ${msg}`);
        assert.ok(
          !msg.includes("Workspace may contain partial writes"),
          "non-write step must NOT include workspace suffix"
        );
        return true;
      }
    );
  });
});

// ─── FR-007 / FR-008: dirty workspace report on write step failure ────────────

describe("buildLlmStep — dirty workspace report on write step failure (FR-007/FR-008/FR-009)", () => {
  it("write step failure in a git repo appends git status to the error and leaves file untouched", async () => {
    // Create a temp git repo so git status --porcelain can run.
    const tempDir = mkdtempSync(join(tmpdir(), "spec023-git-"));
    const modifiedFile = join(tempDir, "modified.ts");
    const originalContent = "// original\n";
    try {
      execSync("git init", { cwd: tempDir, stdio: "ignore" });
      // The file exists before the step runs.
      writeFileSync(modifiedFile, originalContent);
      execSync("git add .", { cwd: tempDir, stdio: "ignore" });
      execSync("git -c user.email=test@t.com -c user.name=Test commit -m init", {
        cwd: tempDir,
        stdio: "ignore",
      });

      const partialContent = "// partial write from step\n";
      const throwingRunner: typeof runLlmStep = async () => {
        // Simulate a partial write followed by a timeout.
        writeFileSync(modifiedFile, partialContent);
        throw new StepTimeoutError(600_000);
      };

      const step: StepDef = {
        id: "build.develop.implement",
        kind: "llm",
        prompt: "prompts/implement.md",
        permissions: { contents: "write" },
      };
      const deps = {
        registry: NOOP_REGISTRY,
        store: NOOP_STORE,
        runner: throwingRunner,
        cwd: tempDir,
      };
      const llmStep = buildLlmStep(
        step,
        { "build.develop.implement": "implement prompt" },
        deps,
        undefined
      );

      let thrownError: Error | undefined;
      try {
        await (llmStep as any).execute({ inputData: {}, suspend: () => undefined as never });
      } catch (err) {
        thrownError = err instanceof Error ? err : new Error(String(err));
      }

      assert.ok(thrownError !== undefined, "write step must throw on runner failure");
      const msg = thrownError.message;

      // FR-007: error names the step.
      assert.ok(
        msg.includes("build.develop.implement"),
        `error must name the step id; got: ${msg}`
      );
      // FR-007: error describes the failure.
      assert.ok(msg.includes("timed out"), `error must include 'timed out'; got: ${msg}`);
      // FR-008: error mentions the modified file (relative path in git status output).
      assert.ok(
        msg.includes("modified.ts"),
        `error must include the modified file from git status; got: ${msg}`
      );
      // FR-008: error includes the workspace prefix phrase.
      assert.ok(
        msg.includes("Workspace may contain partial writes"),
        `error must include the workspace warning; got: ${msg}`
      );

      // FR-009: the file bytes are identical to what the runner wrote — the daemon
      // read the workspace state (git status) but did not modify any file.
      const fileBytes = readFileSync(modifiedFile, "utf8");
      assert.equal(
        fileBytes,
        partialContent,
        "file content must equal what the runner wrote — daemon must not revert, stash, or delete"
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("write step failure in a non-git directory appends the documented not-a-git-repository message", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "spec023-nogit-"));
    try {
      const throwingRunner: typeof runLlmStep = async () => {
        throw new StepTimeoutError(100);
      };
      const step: StepDef = {
        id: "build.develop.implement",
        kind: "llm",
        prompt: "prompts/implement.md",
        permissions: { contents: "write" },
      };
      const deps = {
        registry: NOOP_REGISTRY,
        store: NOOP_STORE,
        runner: throwingRunner,
        cwd: tempDir,
      };
      const llmStep = buildLlmStep(
        step,
        { "build.develop.implement": "implement prompt" },
        deps,
        undefined
      );

      await assert.rejects(
        (llmStep as any).execute({ inputData: {}, suspend: () => undefined as never }),
        (err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          assert.ok(
            msg.includes("not a git repository"),
            `error must include the documented not-a-git-repository message; got: ${msg}`
          );
          return true;
        }
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

// ─── FR-008: workspace report on write step schema-retry failure ──────────────

describe("buildLlmStep — workspace report on write step schema-retry failure (FR-008)", () => {
  it("write step with schema whose retry call fails includes step id and workspace state", async () => {
    // FR-008 says the workspace report is appended when a write step fails "for
    // any reason". A failing schema retry is one such reason; this guards the
    // retry catch path specifically.
    const tempDir = mkdtempSync(join(tmpdir(), "spec023-schema-retry-"));
    try {
      execSync("git init", { cwd: tempDir, stdio: "ignore" });
      execSync("git -c user.email=test@t.com -c user.name=Test commit --allow-empty -m init", {
        cwd: tempDir,
        stdio: "ignore",
      });

      let callCount = 0;
      // First call returns invalid JSON (triggers retry). Second call (retry) throws.
      const schemaRetryRunner: typeof runLlmStep = async () => {
        callCount += 1;
        if (callCount === 1) return "not-json";
        throw new StepTimeoutError(600_000);
      };

      const step: StepDef = {
        id: "build.develop.implement",
        kind: "llm",
        prompt: "prompts/implement.md",
        permissions: { contents: "write" },
        schema: "weaknesses",
      };
      const deps = {
        registry: NOOP_REGISTRY,
        store: NOOP_STORE,
        runner: schemaRetryRunner,
        cwd: tempDir,
      };
      const llmStep = buildLlmStep(
        step,
        { "build.develop.implement": "implement prompt" },
        deps,
        undefined
      );

      let thrownError: Error | undefined;
      try {
        await (llmStep as any).execute({ inputData: {}, suspend: () => undefined as never });
      } catch (err) {
        thrownError = err instanceof Error ? err : new Error(String(err));
      }

      assert.ok(thrownError !== undefined, "schema-retry failure must throw");
      const msg = thrownError.message;

      // FR-007: step id present.
      assert.ok(
        msg.includes("build.develop.implement"),
        `error must name the step id; got: ${msg}`
      );
      // FR-008: workspace state appended on the retry path.
      assert.ok(
        msg.includes("Workspace may contain partial writes"),
        `error must include the workspace warning on retry path; got: ${msg}`
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

// ─── a contents: none step still gets the full credential deny list ───────────

describe("buildLlmStep — permissions.contents none", () => {
  it("keeps the credential denial for a step that declares no file access", async () => {
    // A step declaring `contents: none` still receives the hardened Read,Glob
    // fallback in the claude adapter, so its credential denials must be emitted
    // regardless of what else the step declares.
    const secretFile = "credentials.toml";
    const step: StepDef = {
      id: "review.synthesis",
      kind: "llm",
      prompt: "prompts/synthesis.md",
      permissions: { contents: "none" },
    };

    const entry: ModelEntry = {
      id: "haiku",
      transport: "cli",
      cli: { bin: "claude", model: "haiku" },
    };
    const { child } = makeStreamJsonChild("ok");
    let capturedArgs: string[] = [];
    const spawn = ((_cmd: string, args: string[]) => {
      capturedArgs = args;
      return child;
    }) as unknown as SpawnFn;

    // Forward the runnerDeps the binding built into the real runner, so the
    // assertion lands on the CLI invocation, not on an intermediate shape.
    const runner: typeof runLlmStep = async (_entry, prompt, runnerDeps) =>
      runLlmStep(entry, prompt, { ...runnerDeps, spawn });

    const deps = { registry: NOOP_REGISTRY, store: NOOP_STORE, runner };
    const llmStep = buildLlmStep(step, { "review.synthesis": "synthesis prompt" }, deps, undefined);
    await (llmStep as any).execute({ inputData: {}, suspend: () => undefined as never });

    const disallowedIdx = capturedArgs.indexOf("--disallowedTools");
    assert.ok(disallowedIdx !== -1, "a no-permissions step must still emit --disallowedTools");
    const disallowedValue = capturedArgs[disallowedIdx + 1];

    const pattern = CREDENTIAL_DENY_PATTERNS.find((p) => p.includes(secretFile));
    assert.ok(pattern !== undefined, `${secretFile} must be a credential deny pattern`);
    assert.ok(
      disallowedValue.includes(`Read(${pattern})`),
      `a contents: none step must still deny Read(${pattern}); got: ${disallowedValue}`
    );
    assert.ok(
      disallowedValue.includes(`Grep(${pattern})`),
      `a contents: none step must still deny Grep(${pattern}); got: ${disallowedValue}`
    );
  });
});

// ─── D3: run-start portability refusal, before any model call ─────────────────

describe("buildLlmStep — refuses an unportable step before the runner is called", () => {
  const codexProfile = {
    id: "openai",
    roles: { reasoner: "codex", worker: "codex", scout: "codex" },
  };
  const codexRegistry = new ModelRegistry([
    { id: "codex", transport: "cli" as const, cli: { bin: "codex" as const } },
  ]);

  it("throws naming the step and never invokes the runner (contents: write on codex)", async () => {
    const step: StepDef = {
      id: "develop.implement",
      kind: "llm",
      role: "worker",
      prompt: "prompts/develop.md",
      permissions: { contents: "write" },
    };

    let runnerCalls = 0;
    const runner: typeof runLlmStep = async () => {
      runnerCalls += 1;
      return "never";
    };

    const deps = {
      registry: codexRegistry,
      store: NOOP_STORE,
      profile: codexProfile,
      runner,
    };
    const llmStep = buildLlmStep(step, { "develop.implement": "prompt" }, deps, undefined);

    await assert.rejects(
      (llmStep as any).execute({ inputData: {}, suspend: () => undefined as never }),
      (err: Error) => {
        assert.match(err.message, /develop\.implement/);
        assert.match(err.message, /openai/);
        assert.match(err.message, /permissions\.contents "write"/);
        return true;
      }
    );
    assert.equal(runnerCalls, 0, "no model call may be made for an unportable step");
  });
});

// ─── FR-013: per-run abort signal reaches the runner ─────────────────────────

describe("buildLlmStep — per-run abortSignal (FR-013)", () => {
  const step: StepDef = {
    id: "investigate.survey",
    kind: "llm",
    prompt: "prompts/survey.md",
  };
  const prompts = { "investigate.survey": "survey prompt" };

  // Records the signal each call received so a test can abort afterwards and
  // observe whether the runner would have been interrupted.
  function makeSignalRecordingRunner(): {
    runner: typeof runLlmStep;
    signals: (AbortSignal | undefined)[];
  } {
    const signals: (AbortSignal | undefined)[] = [];
    const runner: typeof runLlmStep = async (_entry, _prompt, deps) => {
      signals.push(deps?.signal);
      return "ok";
    };
    return { runner, signals };
  }

  it("the runner's signal aborts when Mastra's abortSignal aborts", async () => {
    const { runner, signals } = makeSignalRecordingRunner();
    const llmStep = buildLlmStep(
      step,
      prompts,
      { registry: NOOP_REGISTRY, store: NOOP_STORE, runner },
      undefined
    );

    const controller = new AbortController();
    await (llmStep as any).execute({
      inputData: {},
      abortSignal: controller.signal,
      suspend: () => undefined as never,
    });

    assert.equal(signals.length, 1, "runner must have been called once");
    const seen = signals[0];
    assert.ok(seen !== undefined, "runner must receive a signal — FR-013");
    assert.equal(seen.aborted, false, "signal must not be aborted before cancel");
    controller.abort();
    assert.equal(seen.aborted, true, "cancelling the run must abort the runner's signal");
  });

  it("two concurrent runs on one built step have independent signals", async () => {
    const { runner, signals } = makeSignalRecordingRunner();
    const llmStep = buildLlmStep(
      step,
      prompts,
      { registry: NOOP_REGISTRY, store: NOOP_STORE, runner },
      undefined
    );

    const runA = new AbortController();
    const runB = new AbortController();
    await (llmStep as any).execute({
      inputData: {},
      abortSignal: runA.signal,
      suspend: () => undefined as never,
    });
    await (llmStep as any).execute({
      inputData: {},
      abortSignal: runB.signal,
      suspend: () => undefined as never,
    });

    assert.equal(signals.length, 2, "runner must have been called once per run");
    runA.abort();
    assert.equal(signals[0]!.aborted, true, "run A's signal must abort");
    assert.equal(
      signals[1]!.aborted,
      false,
      "run B must be unaffected — a build-time shared signal would abort both"
    );
  });

  it("an already-aborted run throws before the runner is called", async () => {
    let runnerCalls = 0;
    const runner: typeof runLlmStep = async () => {
      runnerCalls += 1;
      return "never";
    };
    const llmStep = buildLlmStep(
      step,
      prompts,
      { registry: NOOP_REGISTRY, store: NOOP_STORE, runner },
      undefined
    );

    const controller = new AbortController();
    controller.abort();

    await assert.rejects(
      (llmStep as any).execute({
        inputData: {},
        abortSignal: controller.signal,
        suspend: () => undefined as never,
      }),
      (err: Error) => {
        assert.equal(err.message, "run cancelled before step investigate.survey started");
        return true;
      }
    );
    assert.equal(runnerCalls, 0, "a cancelled run must not reach the runner");
  });

  it("a build-time signal is combined with the per-run signal, either one aborting", async () => {
    for (const abortSide of ["build", "run"] as const) {
      const { runner, signals } = makeSignalRecordingRunner();
      const buildController = new AbortController();
      const llmStep = buildLlmStep(
        step,
        prompts,
        {
          registry: NOOP_REGISTRY,
          store: NOOP_STORE,
          runner,
          runnerDeps: { signal: buildController.signal },
        },
        undefined
      );

      const runController = new AbortController();
      await (llmStep as any).execute({
        inputData: {},
        abortSignal: runController.signal,
        suspend: () => undefined as never,
      });

      const seen = signals[0];
      assert.ok(seen !== undefined, "runner must receive a combined signal");
      assert.equal(seen.aborted, false, "combined signal must start unaborted");
      if (abortSide === "build") buildController.abort();
      else runController.abort();
      assert.equal(
        seen.aborted,
        true,
        `aborting the ${abortSide} signal must abort the combination`
      );
    }
  });
});

describe("buildCheckStep — per-run abortSignal (FR-013)", () => {
  it("cancelling the run kills the check step's child", async () => {
    const killCalls: string[] = [];
    // A child that never exits on its own, so only the abort path can end it.
    const spawn = ((_cmd: string, _args: string[]) => {
      const emitter = new EventEmitter();
      const child = Object.assign(emitter, {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        pid: undefined,
        kill(signal?: string) {
          killCalls.push(signal ?? "SIGTERM");
          setImmediate(() => emitter.emit("close", null));
        },
      });
      return child;
    }) as unknown as SpawnFn;

    const step: StepDef = { id: "test.check", kind: "check", command: "sleep 60" };
    const checkStep = buildCheckStep(
      step,
      { registry: NOOP_REGISTRY, store: NOOP_STORE, runnerDeps: { spawn } },
      undefined
    );

    const controller = new AbortController();
    const pending = (checkStep as any).execute({
      inputData: {},
      abortSignal: controller.signal,
      suspend: () => undefined as never,
    });
    setImmediate(() => controller.abort());

    const out = await pending;
    assert.deepEqual(killCalls, ["SIGTERM"], "abort must SIGTERM the check step's child");
    assert.equal(out["test.check"].passed, false);
    assert.match(out["test.check"].output, /cancelled/i);
  });
});

// ─── Spec 036 D2/FR-014: the builder owns step.start and step.result ─────────

describe("step builders — one step.start and exactly one terminal step.result", () => {
  const llmDef: StepDef = {
    id: "investigate.survey",
    kind: "llm",
    prompt: "prompts/survey.md",
    model: "sonnet",
  };
  const prompts = { "investigate.survey": "survey prompt" };

  /** A registered run log in a throwaway directory, with its own reader. */
  function openTempRunLog(runId: string): {
    dir: string;
    events: () => StepLogEvent[];
    cleanup: () => void;
  } {
    const dir = mkdtempSync(join(tmpdir(), "af-steplog-builder-"));
    openRunLog(runId, { dir, pipelineId: "test-pipeline" });
    return {
      dir,
      events: () => readRunLog(runLogFile(dir, "test-pipeline")),
      cleanup: () => {
        closeRunLog(runId);
        rmSync(dir, { recursive: true, force: true });
      },
    };
  }

  function terminalOf(events: StepLogEvent[]): Extract<StepLogEvent, { kind: "step.result" }> {
    const terminal = events.filter(
      (e): e is Extract<StepLogEvent, { kind: "step.result" }> => e.kind === "step.result"
    );
    assert.equal(terminal.length, 1, "a step must produce exactly one terminal event");
    return terminal[0];
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

  it("a step that returns logs start, the adapter's events, the result and the output", async () => {
    const runId = "log-success";
    const log = openTempRunLog(runId);
    try {
      const runner: typeof runLlmStep = async (_entry, _prompt, deps) => {
        deps?.onEvent?.({ kind: "message", role: "assistant", text: "the answer" });
        deps?.onEvent?.({ kind: "usage", costUsd: 0.02, turns: 2 });
        return "the answer";
      };
      const llmStep = buildLlmStep(
        llmDef,
        prompts,
        { registry: NOOP_REGISTRY, store: NOOP_STORE, runner },
        undefined
      );
      await (llmStep as any).execute({ inputData: {}, runId, suspend: () => undefined as never });

      const events = log.events();
      assert.deepEqual(
        events.map((e) => e.kind),
        ["step.start", "message", "usage", "step.result"],
        "the adapter contributes no start or terminal event of its own"
      );
      const start = expectKind(events[0], "step.start");
      assert.equal(start.model, "sonnet (cli:claude)");
      assert.equal(start.transport, "cli");
      assert.equal(terminalOf(events).status, "succeeded");

      assert.deepEqual(
        readStepOutput(stepOutputFile(log.dir, "test-pipeline", llmDef.id)),
        {
          runId,
          pipelineId: "test-pipeline",
          stepId: llmDef.id,
          kind: "text",
          output: "the answer",
        },
        "a returning llm step must persist its full output — FR-008"
      );
    } finally {
      log.cleanup();
    }
  });

  it("a step whose runner throws logs one failed result carrying the message", async () => {
    const runId = "log-failure";
    const log = openTempRunLog(runId);
    try {
      const runner: typeof runLlmStep = async () => {
        throw new Error("transport exploded");
      };
      const llmStep = buildLlmStep(
        llmDef,
        prompts,
        { registry: NOOP_REGISTRY, store: NOOP_STORE, runner },
        undefined
      );
      await assert.rejects(
        (llmStep as any).execute({ inputData: {}, runId, suspend: () => undefined as never })
      );

      const events = log.events();
      assert.deepEqual(
        events.map((e) => e.kind),
        ["step.start", "step.result"]
      );
      const terminal = terminalOf(events);
      assert.equal(terminal.status, "failed");
      assert.match(terminal.error ?? "", /transport exploded/u);
    } finally {
      log.cleanup();
    }
  });

  it("a step interrupted by a cancelled run logs a cancelled result (FR-014)", async () => {
    const runId = "log-cancel";
    const log = openTempRunLog(runId);
    try {
      const controller = new AbortController();
      const runner: typeof runLlmStep = async () => {
        // What a cancelled run looks like from inside: the signal fires, then the
        // transport rejects.
        controller.abort();
        throw new Error("Claude CLI aborted");
      };
      const llmStep = buildLlmStep(
        llmDef,
        prompts,
        { registry: NOOP_REGISTRY, store: NOOP_STORE, runner },
        undefined
      );
      await assert.rejects(
        (llmStep as any).execute({
          inputData: {},
          runId,
          abortSignal: controller.signal,
          suspend: () => undefined as never,
        })
      );

      assert.equal(
        terminalOf(log.events()).status,
        "cancelled",
        "an aborted run must not be reported as an ordinary failure"
      );
    } finally {
      log.cleanup();
    }
  });

  it(
    "watchdog exhaustion over two claude attempts still logs one terminal result",
    { timeout: 4_000 },
    async () => {
      const runId = "log-watchdog";
      const log = openTempRunLog(runId);
      try {
        // A child that emits nothing and only closes when killed: the stall
        // detector trips on both attempts, so the adapter calls the CLI twice.
        const spawn = (() => {
          const emitter = new EventEmitter();
          const stdout = new PassThrough();
          const stderr = new PassThrough();
          return Object.assign(emitter, {
            stdin: new PassThrough(),
            stdout,
            stderr,
            kill() {
              setImmediate(() => {
                if (!stdout.destroyed) stdout.push(null);
                if (!stderr.destroyed) stderr.push(null);
                emitter.emit("close", null);
              });
            },
          });
        }) as unknown as SpawnFn;

        const llmStep = buildLlmStep(
          llmDef,
          prompts,
          {
            registry: NOOP_REGISTRY,
            store: NOOP_STORE,
            runnerDeps: { spawn, _stallSilenceMs: 40 },
          },
          undefined
        );
        await assert.rejects(
          (llmStep as any).execute({ inputData: {}, runId, suspend: () => undefined as never })
        );

        const events = log.events();
        assert.equal(
          events.filter((e) => e.kind === "step.start").length,
          1,
          "two transport attempts are still one step"
        );
        assert.deepEqual(
          events.flatMap((e) => (e.kind === "watchdog" ? [e.attempt] : [])),
          [1, 2],
          "each attempt must record its own trip"
        );
        assert.equal(terminalOf(events).status, "failed");
      } finally {
        log.cleanup();
      }
    }
  );

  it("a check step logs both output streams, scrubbed of declared env values", async () => {
    const runId = "log-check";
    const log = openTempRunLog(runId);
    const secretKey = "PROBE_SECRET_VALUE";
    process.env[secretKey] = "hunter2xyz";
    try {
      const step: StepDef = {
        id: "test.check",
        kind: "check",
        command: `printf out; printf "$${secretKey}"; printf err >&2`,
        env: [secretKey],
      };
      const checkStep = buildCheckStep(
        step,
        { registry: NOOP_REGISTRY, store: NOOP_STORE },
        undefined
      );
      const out = await (checkStep as any).execute({
        inputData: {},
        runId,
        suspend: () => undefined as never,
      });

      const events = log.events();
      expectKind(events[0], "step.start");
      expectKind(events[events.length - 1], "step.result");
      // Both streams must be logged, each labelled with its own. Their relative
      // arrival order is the OS's business (two pipes), and a pipe may deliver
      // two writes as one chunk, so each stream is compared as a whole.
      const streamText = (stream: "stdout" | "stderr"): string =>
        events
          .flatMap((e) => (e.kind === "check.output" && e.stream === stream ? [e.text] : []))
          .join("");
      assert.equal(streamText("stdout"), "out[redacted:PROBE_SECRET_VALUE]");
      assert.equal(streamText("stderr"), "err");
      assert.equal(
        readFileSync(runLogFile(log.dir, "test-pipeline"), "utf8").includes("hunter2xyz"),
        false,
        "a declared credential must never reach the durable log — FR-015"
      );
      assert.equal(
        out["test.check"].output.includes("hunter2xyz"),
        false,
        "the ctx value the next step reads — and the artifact's outputExcerpt — must be scrubbed too"
      );
      assert.ok(
        out["test.check"].output.includes("[redacted:PROBE_SECRET_VALUE]"),
        "the scrubbed result must still show where the value was"
      );
      assert.equal(terminalOf(events).status, "succeeded");
    } finally {
      delete process.env[secretKey];
      log.cleanup();
    }
  });

  it("a failing check step logs the exit code as the result error", async () => {
    const runId = "log-check-fail";
    const log = openTempRunLog(runId);
    try {
      const step: StepDef = { id: "test.check", kind: "check", command: "exit 3" };
      const checkStep = buildCheckStep(
        step,
        { registry: NOOP_REGISTRY, store: NOOP_STORE },
        undefined
      );
      await (checkStep as any).execute({ inputData: {}, runId, suspend: () => undefined as never });

      const terminal = terminalOf(log.events());
      assert.equal(terminal.status, "failed");
      assert.equal(terminal.error, "exit 3");
    } finally {
      log.cleanup();
    }
  });
});

// ─── Spec 039: the provider profile is resolved per run, not per build ────────

describe("buildLlmStep — per-run provider", () => {
  const step: StepDef = {
    id: "investigate.survey",
    kind: "llm",
    role: "worker",
    prompt: "prompts/survey.md",
  };
  const prompts = { "investigate.survey": "survey prompt" };

  /** Records the ModelEntry id each call resolved to. */
  function makeEntryRecordingRunner(): { runner: typeof runLlmStep; entries: string[] } {
    const entries: string[] = [];
    const runner: typeof runLlmStep = async (entry) => {
      entries.push(entry.id);
      return "ok";
    };
    return { runner, entries };
  }

  it("two runs of one built step under different providers resolve different models", async () => {
    const { runner, entries } = makeEntryRecordingRunner();
    const llmStep = buildLlmStep(
      step,
      prompts,
      {
        registry: defaultRegistry({}),
        store: NOOP_STORE,
        profile: getProfile("anthropic"),
        runner,
      },
      undefined
    );

    await (llmStep as any).execute({ inputData: {}, suspend: () => undefined as never });
    await (llmStep as any).execute({
      inputData: { provider: "openai" },
      suspend: () => undefined as never,
    });

    assert.deepEqual(
      entries,
      // openai's worker role is a pinned codex model now, not the bare entry (042 D21).
      ["sonnet", "gpt-terra"],
      "the profile must be read per execution, not captured at build time"
    );
  });

  it("no provider in the run input keeps the build-time default profile", async () => {
    const { runner, entries } = makeEntryRecordingRunner();
    const llmStep = buildLlmStep(
      step,
      prompts,
      {
        registry: defaultRegistry({}),
        store: NOOP_STORE,
        profile: getProfile("openai"),
        runner,
      },
      undefined
    );

    await (llmStep as any).execute({ inputData: {}, suspend: () => undefined as never });

    assert.deepEqual(entries, ["gpt-terra"]);
  });

  it("an unknown provider throws naming the step and the id, without a model call", async () => {
    const { runner, entries } = makeEntryRecordingRunner();
    const llmStep = buildLlmStep(
      step,
      prompts,
      {
        registry: defaultRegistry({}),
        store: NOOP_STORE,
        profile: getProfile("anthropic"),
        runner,
      },
      undefined
    );

    await assert.rejects(
      (llmStep as any).execute({
        inputData: { provider: "nope" },
        suspend: () => undefined as never,
      }),
      (err: Error) => {
        assert.match(err.message, /investigate\.survey/);
        assert.match(err.message, /nope/);
        return true;
      }
    );
    assert.equal(entries.length, 0, "an unknown provider must not reach a model call");
  });

  it("a project-declared profile is resolvable per run via providerProfiles", async () => {
    const { runner, entries } = makeEntryRecordingRunner();
    const llmStep = buildLlmStep(
      step,
      prompts,
      {
        registry: defaultRegistry({}),
        store: NOOP_STORE,
        profile: getProfile("anthropic"),
        providerProfiles: [
          { id: "house", roles: { reasoner: "opus", worker: "haiku", scout: "haiku" } },
        ],
        runner,
      },
      undefined
    );

    await (llmStep as any).execute({
      inputData: { provider: "house" },
      suspend: () => undefined as never,
    });

    assert.deepEqual(entries, ["haiku"]);
  });
});

// ─── Spec 039: step-level failover to the next profile in the chain ───────────

describe("buildLlmStep — provider failover", () => {
  const PRIMARY = {
    id: "primary",
    roles: { reasoner: "m1", worker: "m1", scout: "m1" },
    fallback: ["secondary"],
  };
  const SECONDARY = {
    id: "secondary",
    roles: { reasoner: "m2", worker: "m2", scout: "m2" },
  };
  /** Text-only: the api transport has no tool loop, so it cannot read a repo. */
  const TEXT_ONLY = {
    id: "text-only",
    roles: { reasoner: "m-api", worker: "m-api", scout: "m-api" },
  };
  const REGISTRY = new ModelRegistry([
    { id: "m1", transport: "cli" as const, cli: { bin: "claude" as const, model: "m1" } },
    { id: "m2", transport: "cli" as const, cli: { bin: "claude" as const, model: "m2" } },
    {
      id: "m-api",
      transport: "api" as const,
      api: { endpoint: "http://localhost:11434/v1/chat/completions", model: "qwen" },
    },
  ]);

  const step: StepDef = {
    id: "investigate.survey",
    kind: "llm",
    role: "worker",
    prompt: "prompts/survey.md",
  };
  const prompts = { "investigate.survey": "survey prompt" };

  /** A transport failure exactly as the claude adapter reports one. */
  function transportFailure(): Error {
    return new TransportFailureError("claude exited with code 1\nstderr: connection reset", {
      transport: "cli:claude",
      exitCode: 1,
    });
  }

  function makeDeps(
    runner: typeof runLlmStep,
    profile: { id: string; roles: Record<string, string>; fallback?: string[] },
    profiles = [PRIMARY, SECONDARY, TEXT_ONLY]
  ) {
    return {
      registry: REGISTRY,
      store: NOOP_STORE,
      profile: profile as never,
      providerProfiles: profiles as never,
      runner,
    };
  }

  it("a transport failure is retried on the next profile, with a different model", async () => {
    const seen: string[] = [];
    const runner: typeof runLlmStep = async (entry) => {
      seen.push(entry.id);
      if (entry.id === "m1") throw transportFailure();
      return "answered by the fallback";
    };

    const llmStep = buildLlmStep(step, prompts, makeDeps(runner, PRIMARY), undefined);
    const out = (await (llmStep as any).execute({
      inputData: {},
      suspend: () => undefined as never,
    })) as Record<string, unknown>;

    assert.deepEqual(seen, ["m1", "m2"], "the fallback must resolve to a different model");
    assert.equal(out["investigate.survey"], "answered by the fallback");
  });

  it("a step with failover: false is never handed to a second provider", async () => {
    const seen: string[] = [];
    const runner: typeof runLlmStep = async (entry) => {
      seen.push(entry.id);
      throw transportFailure();
    };
    const pinnedStep: StepDef = { ...step, failover: false };

    const llmStep = buildLlmStep(pinnedStep, prompts, makeDeps(runner, PRIMARY), undefined);

    await assert.rejects(
      (llmStep as any).execute({ inputData: {}, suspend: () => undefined as never }),
      (err: Error) => {
        assert.match(
          err.message,
          /Failover refused: the step sets failover: false/,
          `the failure must say the step was pinned: ${err.message}`
        );
        return true;
      }
    );
    assert.deepEqual(seen, ["m1"], "a pinned step must not attempt any candidate");
  });

  for (const [label, failover] of [
    ["failover: true", true],
    ["no failover field", undefined],
  ] as const) {
    it(`a step with ${label} still walks the chain`, async () => {
      const seen: string[] = [];
      const runner: typeof runLlmStep = async (entry) => {
        seen.push(entry.id);
        if (entry.id === "m1") throw transportFailure();
        return "answered by the fallback";
      };
      const chainedStep: StepDef =
        failover === undefined ? { ...step } : { ...step, failover: true };

      const llmStep = buildLlmStep(chainedStep, prompts, makeDeps(runner, PRIMARY), undefined);
      const out = (await (llmStep as any).execute({
        inputData: {},
        suspend: () => undefined as never,
      })) as Record<string, unknown>;

      assert.deepEqual(seen, ["m1", "m2"], "the chain must still be walked");
      assert.equal(out["investigate.survey"], "answered by the fallback");
    });
  }

  it("a step that declares permissions.contents is never failed over onto a text-only profile", async () => {
    const seen: string[] = [];
    const runner: typeof runLlmStep = async (entry) => {
      seen.push(entry.id);
      throw transportFailure();
    };
    const readStep: StepDef = { ...step, permissions: { contents: "read" } };
    const chained = { ...PRIMARY, fallback: ["text-only"] };

    const llmStep = buildLlmStep(readStep, prompts, makeDeps(runner, chained), undefined);

    await assert.rejects(
      (llmStep as any).execute({ inputData: {}, suspend: () => undefined as never }),
      (err: Error) => {
        assert.match(err.message, /permissions\.contents "read"/);
        return true;
      }
    );
    assert.deepEqual(seen, ["m1"], "a text-only candidate must be skipped, not attempted");
  });

  it("a step that declares permissions.deny is never failed over onto a transport that cannot enforce it", async () => {
    const seen: string[] = [];
    const runner: typeof runLlmStep = async (entry) => {
      seen.push(entry.id);
      throw transportFailure();
    };
    const denyStep: StepDef = {
      ...step,
      permissions: { contents: "read", deny: ["ops/secrets-notes/**"] },
    };
    const chained = { ...PRIMARY, fallback: ["text-only"] };

    const llmStep = buildLlmStep(denyStep, prompts, makeDeps(runner, chained), undefined);

    await assert.rejects(
      (llmStep as any).execute({ inputData: {}, suspend: () => undefined as never }),
      (err: Error) => {
        assert.match(
          err.message,
          /permissions\.deny/,
          `the refusal must name the deny list: ${err.message}`
        );
        return true;
      }
    );
    assert.deepEqual(
      seen,
      ["m1"],
      "a candidate that cannot enforce the deny list must be skipped, not attempted"
    );
  });

  // Two independent guards stop a cancelled step crossing providers: the error
  // name, and the run signal. One test covering both stays green when either is
  // removed, so they are pinned separately.
  it("an AbortError is not failed over, even with the run signal still live", async () => {
    const seen: string[] = [];
    const controller = new AbortController();
    const runner: typeof runLlmStep = async (entry) => {
      seen.push(entry.id);
      throw new DOMException("Claude CLI aborted", "AbortError");
    };

    const llmStep = buildLlmStep(step, prompts, makeDeps(runner, PRIMARY), undefined);

    await assert.rejects(
      (llmStep as any).execute({
        inputData: {},
        abortSignal: controller.signal,
        suspend: () => undefined as never,
      })
    );
    assert.equal(controller.signal.aborted, false, "the signal guard must not be what fires here");
    assert.deepEqual(seen, ["m1"], "an abort must not reach another provider on its name alone");
  });

  it("a cancelled run is not failed over, even when the failure is a transport failure", async () => {
    const seen: string[] = [];
    const controller = new AbortController();
    const runner: typeof runLlmStep = async (entry) => {
      seen.push(entry.id);
      controller.abort();
      // Failover-worthy on its own — only the cancelled run stops it.
      throw transportFailure();
    };

    const llmStep = buildLlmStep(step, prompts, makeDeps(runner, PRIMARY), undefined);

    await assert.rejects(
      (llmStep as any).execute({
        inputData: {},
        abortSignal: controller.signal,
        suspend: () => undefined as never,
      })
    );
    assert.deepEqual(seen, ["m1"], "an operator cancellation must not reach another provider");
  });

  it("a request-shaped claude subtype is not failed over", async () => {
    const seen: string[] = [];
    const runner: typeof runLlmStep = async (entry) => {
      seen.push(entry.id);
      throw new TransportFailureError('claude: result subtype "error_max_turns": ran out', {
        transport: "cli:claude",
        exitCode: 0,
        subtype: "error_max_turns",
      });
    };

    const llmStep = buildLlmStep(step, prompts, makeDeps(runner, PRIMARY), undefined);

    await assert.rejects(
      (llmStep as any).execute({ inputData: {}, suspend: () => undefined as never })
    );
    assert.deepEqual(
      seen,
      ["m1"],
      "a turn limit is about the request; a second provider would spend a whole step repeating it"
    );
  });

  it("a model the local CLI does not recognise is failed over", async () => {
    const seen: string[] = [];
    const runner: typeof runLlmStep = async (entry) => {
      seen.push(entry.id);
      if (entry.id === "m1") {
        throw new TransportFailureError('claude CLI rejected model "m1": unrecognized_model', {
          transport: "cli:claude",
          exitCode: 0,
          subtype: UNRECOGNIZED_MODEL_SUBTYPE,
        });
      }
      return "answered by the fallback";
    };

    const llmStep = buildLlmStep(step, prompts, makeDeps(runner, PRIMARY), undefined);
    const out = (await (llmStep as any).execute({
      inputData: {},
      suspend: () => undefined as never,
    })) as Record<string, unknown>;

    assert.deepEqual(seen, ["m1", "m2"], "an alias one CLI lacks is exactly what another may have");
    assert.equal(out["investigate.survey"], "answered by the fallback");
  });

  it("a transport syscall code is failed over but an ERR_* programming error is not", async () => {
    const syscall: string[] = [];
    const errSeen: string[] = [];

    const syscallRunner: typeof runLlmStep = async (entry) => {
      syscall.push(entry.id);
      if (entry.id === "m1") {
        const err: NodeJS.ErrnoException = new Error("spawn claude ENOENT");
        err.code = "ENOENT";
        throw err;
      }
      return "ok";
    };
    await (buildLlmStep(step, prompts, makeDeps(syscallRunner, PRIMARY), undefined) as any).execute(
      { inputData: {}, suspend: () => undefined as never }
    );
    assert.deepEqual(syscall, ["m1", "m2"], "a child that never spawned is a transport failure");

    const errRunner: typeof runLlmStep = async (entry) => {
      errSeen.push(entry.id);
      const err: NodeJS.ErrnoException = new Error('The "path" argument must be of type string');
      err.code = "ERR_INVALID_ARG_TYPE";
      throw err;
    };
    await assert.rejects(
      (buildLlmStep(step, prompts, makeDeps(errRunner, PRIMARY), undefined) as any).execute({
        inputData: {},
        suspend: () => undefined as never,
      })
    );
    assert.deepEqual(
      errSeen,
      ["m1"],
      "every Node ERR_* error carries a string code; that is not a transport failure"
    );
  });

  it("an explicit per-run model override is never failed over", async () => {
    const seen: string[] = [];
    const runner: typeof runLlmStep = async (entry) => {
      seen.push(entry.id);
      throw transportFailure();
    };

    const llmStep = buildLlmStep(step, prompts, makeDeps(runner, PRIMARY), undefined);

    await assert.rejects(
      (llmStep as any).execute({
        inputData: { models: { "investigate.survey": "m2" } },
        suspend: () => undefined as never,
      })
    );
    assert.deepEqual(
      seen,
      ["m2"],
      "an operator who pinned a model made a choice the chain must not quietly replace"
    );
  });

  it("the step's declared deadline bounds the STEP, not each attempt", async () => {
    const timeouts: (number | undefined)[] = [];
    const declaredMs = 5_000;
    const runner: typeof runLlmStep = async (entry, _prompt, deps) => {
      timeouts.push(deps!.timeoutMs);
      if (entry.id === "m1") {
        await new Promise((resolve) => setTimeout(resolve, 25));
        throw transportFailure();
      }
      return "ok";
    };

    const timedStep: StepDef = { ...step, timeoutMs: declaredMs };
    const llmStep = buildLlmStep(timedStep, prompts, makeDeps(runner, PRIMARY), undefined);
    await (llmStep as any).execute({ inputData: {}, suspend: () => undefined as never });

    assert.equal(timeouts[0], declaredMs, "the first attempt gets the whole declared deadline");
    assert.ok(
      timeouts[1] !== undefined && timeouts[1] > 0 && timeouts[1] < declaredMs,
      `the fallback must get what is LEFT of ${declaredMs}ms, got ${String(timeouts[1])}`
    );
  });

  it("a chain is not walked once the step's deadline is already spent", async () => {
    const seen: string[] = [];
    const runner: typeof runLlmStep = async (entry) => {
      seen.push(entry.id);
      await new Promise((resolve) => setTimeout(resolve, 20));
      throw transportFailure();
    };

    const timedStep: StepDef = { ...step, timeoutMs: 1 };
    const llmStep = buildLlmStep(timedStep, prompts, makeDeps(runner, PRIMARY), undefined);

    await assert.rejects(
      (llmStep as any).execute({ inputData: {}, suspend: () => undefined as never }),
      (err: Error) => {
        assert.match(err.message, /deadline is spent/, err.message);
        return true;
      }
    );
    assert.deepEqual(seen, ["m1"], "a spent deadline must not buy a second full-length attempt");
  });

  it("the step's declared budget bounds the STEP, not each attempt", async () => {
    const budgets: (number | undefined)[] = [];
    const runner: typeof runLlmStep = async (entry, _prompt, deps) => {
      budgets.push(deps!.maxBudgetUsd);
      if (entry.id === "m1") {
        deps!.onEvent?.({ kind: "usage", costUsd: 0.75 });
        throw transportFailure();
      }
      return "ok";
    };

    const costedStep: StepDef = { ...step, maxBudgetUsd: 1 };
    const llmStep = buildLlmStep(costedStep, prompts, makeDeps(runner, PRIMARY), undefined);
    await (llmStep as any).execute({ inputData: {}, suspend: () => undefined as never });

    assert.equal(budgets[0], 1, "the first attempt gets the whole declared budget");
    assert.equal(budgets[1], 0.25, "the fallback gets only what the first attempt left");
  });

  it("a chain is not walked once the step's budget is already spent", async () => {
    const seen: string[] = [];
    const runner: typeof runLlmStep = async (entry, _prompt, deps) => {
      seen.push(entry.id);
      deps!.onEvent?.({ kind: "usage", costUsd: 1 });
      throw transportFailure();
    };

    const costedStep: StepDef = { ...step, maxBudgetUsd: 1 };
    const llmStep = buildLlmStep(costedStep, prompts, makeDeps(runner, PRIMARY), undefined);

    await assert.rejects(
      (llmStep as any).execute({ inputData: {}, suspend: () => undefined as never }),
      (err: Error) => {
        assert.match(err.message, /budget is spent/, err.message);
        return true;
      }
    );
    assert.deepEqual(seen, ["m1"], "a spent budget must not buy a second full-budget attempt");
  });

  it("a failed-over step records the provider that actually answered", async () => {
    const runId = "provenance-failover";
    const dir = mkdtempSync(join(tmpdir(), "af-steplog-provenance-"));
    openRunLog(runId, { dir, pipelineId: "test-pipeline" });
    try {
      const runner: typeof runLlmStep = async (entry) => {
        if (entry.id === "m1") throw transportFailure();
        return "ok";
      };
      const llmStep = buildLlmStep(step, prompts, makeDeps(runner, PRIMARY), undefined);
      await (llmStep as any).execute({
        inputData: {},
        runId,
        suspend: () => undefined as never,
      });

      const recorded = getStepIntrospection(runId)?.[step.id];
      assert.ok(recorded, "the step must have recorded its invocation");
      assert.match(
        String(recorded.model),
        /^m2 /,
        `stepIntrospection must name the winner, not the model that failed: ${String(recorded.model)}`
      );
      assert.deepEqual(recorded.actual, {
        profileId: "secondary",
        transport: "cli",
        modelId: "m2",
        model: "m2",
      });

      const events = readRunLog(runLogFile(dir, "test-pipeline"));
      const start = events.find((e) => e.kind === "step.start") as unknown as Record<
        string,
        unknown
      >;
      assert.match(String(start.model), /^m1 /, "step.start still records what was PLANNED");
      const result = events.find((e) => e.kind === "step.result") as unknown as Record<
        string,
        unknown
      >;
      assert.match(
        String(result.model),
        /^m2 /,
        `the terminal event must name the provider that answered: ${JSON.stringify(result)}`
      );
      assert.equal(result.transport, "cli");
    } finally {
      clearStepIntrospection(runId);
      closeRunLog(runId);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("an exhausted chain throws the original error, naming the attempts", async () => {
    const runner: typeof runLlmStep = async (entry) => {
      if (entry.id === "m1") throw transportFailure();
      throw new TransportFailureError("codex exec: exit 2; no agent_message found.", {
        transport: "cli:codex",
        exitCode: 2,
      });
    };

    const llmStep = buildLlmStep(step, prompts, makeDeps(runner, PRIMARY), undefined);

    await assert.rejects(
      (llmStep as any).execute({ inputData: {}, suspend: () => undefined as never }),
      (err: Error) => {
        assert.match(
          err.message,
          /claude exited with code 1/,
          "the original failure is the one the operator must see"
        );
        assert.match(err.message, /Failover exhausted: secondary:/);
        return true;
      }
    );
  });

  it("a budget failure is not failed over", async () => {
    const seen: string[] = [];
    const runner: typeof runLlmStep = async (entry) => {
      seen.push(entry.id);
      const err = new Error("Step exceeded budget limit of $1.0000 USD");
      err.name = "StepBudgetExceededError";
      throw err;
    };

    const llmStep = buildLlmStep(step, prompts, makeDeps(runner, PRIMARY), undefined);

    await assert.rejects(
      (llmStep as any).execute({ inputData: {}, suspend: () => undefined as never })
    );
    assert.deepEqual(seen, ["m1"], "a spent budget is not a transport failure");
  });

  it("the crossing is recorded in the run's event log", async () => {
    const runId = "log-failover";
    const dir = mkdtempSync(join(tmpdir(), "af-steplog-failover-"));
    openRunLog(runId, { dir, pipelineId: "test-pipeline" });
    try {
      const runner: typeof runLlmStep = async (entry) => {
        if (entry.id === "m1") throw transportFailure();
        return "ok";
      };
      const llmStep = buildLlmStep(step, prompts, makeDeps(runner, PRIMARY), undefined);
      await (llmStep as any).execute({
        inputData: {},
        runId,
        suspend: () => undefined as never,
      });

      const events = readRunLog(runLogFile(dir, "test-pipeline"));
      const failover = events.find((e) => e.kind === "failover");
      assert.ok(failover !== undefined, "the failover must appear in the run's event log");
      const payload = failover as unknown as Record<string, unknown>;
      assert.equal(payload.fromProfile, "primary");
      assert.equal(payload.toProfile, "secondary");
      assert.equal(payload.stepId, step.id);
      assert.match(String(payload.reason), /claude exited with code 1/);
    } finally {
      closeRunLog(runId);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── Declared schema is enforced, not just pasted into the prompt ─────────────

describe("buildLlmStep — schema-gated output is validated against the canon schema", () => {
  const VALID_WEAKNESS = `{"weaknesses":[{"text":"Ambiguous","severity":"medium","blocking":false}]}`;
  // Parses, carries the required top-level key, and violates the FINDING enum.
  const BAD_SEVERITY = `{"weaknesses":[{"text":"Ambiguous","severity":"moderate","blocking":false}]}`;

  const step: StepDef = {
    id: "critic",
    kind: "llm",
    prompt: "prompts/critic.md",
    schema: "weaknesses",
  };

  function runStep(runner: typeof runLlmStep): Promise<Record<string, unknown>> {
    const llmStep = buildLlmStep(
      step,
      { critic: "critic prompt" },
      { registry: NOOP_REGISTRY, store: NOOP_STORE, runner },
      undefined
    );
    return (llmStep as any).execute({ inputData: {}, suspend: () => undefined as never });
  }

  it("retries once with a prompt naming the field and the constraint", async () => {
    const prompts: string[] = [];
    let call = 0;
    const runner: typeof runLlmStep = async (_entry, prompt) => {
      prompts.push(prompt);
      call += 1;
      return call === 1 ? BAD_SEVERITY : VALID_WEAKNESS;
    };

    const out = await runStep(runner);

    assert.equal(prompts.length, 2, "one retry, no more");
    const retryPrompt = prompts[1] ?? "";
    assert.match(retryPrompt, /weaknesses\.0\.severity/);
    assert.match(retryPrompt, /must be one of low, medium, high, critical/);
    assert.match(retryPrompt, /"moderate"/);
    assert.deepEqual(out.critic, JSON.parse(VALID_WEAKNESS));
  });

  it("fails the step when the retry violates the schema too", async () => {
    let call = 0;
    const runner: typeof runLlmStep = async () => {
      call += 1;
      return BAD_SEVERITY;
    };

    let thrown: Error | undefined;
    try {
      await runStep(runner);
    } catch (err) {
      thrown = err instanceof Error ? err : new Error(String(err));
    }

    assert.equal(call, 2, "exactly one retry before failing");
    assert.ok(thrown !== undefined, "a twice-invalid output must fail the step");
    assert.match(thrown.message, /Step "critic": output does not match schema "weaknesses"/);
    assert.match(thrown.message, /must be one of low, medium, high, critical/);
  });

  it("accepts a schema-valid output without retrying", async () => {
    let call = 0;
    const runner: typeof runLlmStep = async () => {
      call += 1;
      return VALID_WEAKNESS;
    };

    const out = await runStep(runner);

    assert.equal(call, 1, "a valid output must not be retried");
    assert.deepEqual(out.critic, JSON.parse(VALID_WEAKNESS));
  });
});

// ─── review-material: deterministic capture merged into the run context ──────

describe("buildReviewMaterialStep", () => {
  const GIT_ENV = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_AUTHOR_NAME: "Fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  };

  function fixtureRepo(): { repo: string; baseline: string } {
    const repo = mkdtempSync(join(tmpdir(), "af-review-step-"));
    const run = (cmd: string): string =>
      execSync(cmd, { cwd: repo, env: GIT_ENV, encoding: "utf8" });
    run("git init -q -b main");
    writeFileSync(join(repo, "kept.txt"), "one\n");
    run("git add -A && git commit -qm baseline");
    const baseline = run("git rev-parse HEAD").trim();
    writeFileSync(join(repo, "added.txt"), "brand new\n");
    run("git add -A && git commit -qm change");
    return { repo, baseline };
  }

  it("merges the capture into ctx under its own id, where a dependent step reads it", async () => {
    const { repo, baseline } = fixtureRepo();
    const runId = "review-material-ctx";
    const dir = mkdtempSync(join(tmpdir(), "af-steplog-review-"));
    openRunLog(runId, { dir, pipelineId: "test-pipeline" });
    try {
      const step: StepDef = { id: "material", kind: "review-material" };
      const materialStep = buildReviewMaterialStep(step, {
        registry: NOOP_REGISTRY,
        store: NOOP_STORE,
        cwd: repo,
      });

      const out = (await (materialStep as any).execute({
        inputData: { baseline },
        runId,
        suspend: () => undefined as never,
      })) as Record<string, any>;

      // The ctx value is the RENDERED capture, not the structured object: ctxVars
      // JSON-stringifies a non-string value, which would put the diff into the
      // prompt on one line with every newline written `\n` (spec 044 D4/FR-003).
      assert.equal(typeof out.material, "string", JSON.stringify(out.material));
      assert.match(out.material, /^## baseline\n/u);
      assert.match(out.material, /\n## diff \(full: \//u);
      assert.match(out.material, /\n## changed files \(full: \//u);
      assert.match(out.material, /added\.txt/);
      assert.ok(
        !out.material.includes("\\n"),
        `the capture must reach the prompt as plain text, not escaped JSON: ${out.material}`
      );

      // A downstream llm step reaches it as {{material}}.
      let rendered = "";
      const runner: typeof runLlmStep = async (_entry, prompt) => {
        rendered = prompt;
        return "ok";
      };
      const reviewStep: StepDef = { id: "review", kind: "llm", prompt: "prompts/review.md" };
      const llmStep = buildLlmStep(
        reviewStep,
        { review: "material follows: {{material}}" },
        { registry: NOOP_REGISTRY, store: NOOP_STORE, runner },
        undefined
      );
      await (llmStep as any).execute({ inputData: out, suspend: () => undefined as never });

      assert.match(rendered, /added\.txt/, `dependent step must see the capture: ${rendered}`);

      const events = readRunLog(runLogFile(dir, "test-pipeline"));
      const start = events.find((e) => e.kind === "step.start") as any;
      assert.equal(start?.transport, "git");
      const result = events.find((e) => e.kind === "step.result") as any;
      assert.equal(result?.status, "succeeded");
    } finally {
      closeRunLog(runId);
      rmSync(dir, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("an unavailable capture does not fail the run unless the step is required", async () => {
    const { repo } = fixtureRepo();
    const runId = "review-material-unavailable";
    const dir = mkdtempSync(join(tmpdir(), "af-steplog-review-"));
    openRunLog(runId, { dir, pipelineId: "test-pipeline" });
    try {
      const deps = { registry: NOOP_REGISTRY, store: NOOP_STORE, cwd: repo };
      const optional = buildReviewMaterialStep({ id: "material", kind: "review-material" }, deps);
      const out = (await (optional as any).execute({
        inputData: { baseline: "--upload-pack=/bin/echo" },
        runId,
        suspend: () => undefined as never,
      })) as Record<string, any>;
      assert.match(out.material, /^## review material unavailable\n/u);
      assert.match(out.material, /option/);

      const required = buildReviewMaterialStep(
        { id: "material", kind: "review-material", required: true },
        deps
      );
      await assert.rejects(
        (required as any).execute({
          inputData: { baseline: "--upload-pack=/bin/echo" },
          runId,
          suspend: () => undefined as never,
        }),
        (err: Error) => {
          assert.match(err.message, /review material unavailable/);
          return true;
        }
      );
    } finally {
      closeRunLog(runId);
      rmSync(dir, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

// ─── an optional dimension may fail without taking the run with it ────────────

describe("buildLlmStep — required: false is an optional dimension", () => {
  const prompts = { delivery: "delivery prompt" };
  const optional: StepDef = {
    id: "delivery",
    kind: "llm",
    prompt: "prompts/code-review-delivery.md",
    required: false,
  };
  const failingRunner: typeof runLlmStep = async () => {
    throw new Error("schema validation failed after retry");
  };

  it("a failure fills the step's ctx key with a marker and lets the run continue", async () => {
    const llmStep = buildLlmStep(
      optional,
      prompts,
      { registry: NOOP_REGISTRY, store: NOOP_STORE, runner: failingRunner },
      undefined
    );

    const out = (await (llmStep as any).execute({
      // The other axes have already run and are in the context.
      inputData: { material: "## baseline\nabc", correctness: "no findings" },
      suspend: () => undefined as never,
    })) as Record<string, string>;

    assert.equal(
      out.delivery,
      unavailableStepMarker("delivery", 'Step "delivery": schema validation failed after retry'),
      "the key must hold the marker: renderPrompt throws on a placeholder with no value, so " +
        "an absent key takes the run down through the next prompt — the opposite of optional"
    );
    // The marker has to be readable as "not examined", never as an empty result.
    assert.match(out.delivery, /NOT examined/u);
    assert.match(out.delivery, /Reason: Step "delivery": schema validation failed after retry/u);
    assert.ok(
      !out.delivery.includes("no findings"),
      "the marker must carry nothing another axis produced"
    );
    // Everything the other axes produced survives untouched.
    assert.equal(out.material, "## baseline\nabc");
    assert.equal(out.correctness, "no findings");
  });

  it("the same failure on a step that did not declare required: false still fails the run", async () => {
    const llmStep = buildLlmStep(
      { ...optional, required: undefined },
      prompts,
      { registry: NOOP_REGISTRY, store: NOOP_STORE, runner: failingRunner },
      undefined
    );

    await assert.rejects(
      (llmStep as any).execute({ inputData: {}, suspend: () => undefined as never }),
      /schema validation failed after retry/u,
      "required defaults to true on an llm step: every pipeline that says nothing keeps the " +
        "behaviour it had"
    );
  });

  it("a cancelled optional step still throws — cancellation is never optional", async () => {
    const controller = new AbortController();
    const cancellingRunner: typeof runLlmStep = async () => {
      controller.abort();
      throw new Error("aborted");
    };
    const llmStep = buildLlmStep(
      optional,
      prompts,
      { registry: NOOP_REGISTRY, store: NOOP_STORE, runner: cancellingRunner },
      undefined
    );

    await assert.rejects(
      (llmStep as any).execute({
        inputData: {},
        abortSignal: controller.signal,
        suspend: () => undefined as never,
      }),
      /aborted/u,
      "a cancelled run must not walk into its next step because this one was skippable"
    );
  });
});

// ─── Narrated, fenced and trailing-prose JSON (spec 044) ─────────────────────

describe("buildLlmStep — extracting the JSON out of what the model actually says", () => {
  const step: StepDef = {
    id: "critic",
    kind: "llm",
    prompt: "prompts/critic.md",
    schema: "weaknesses",
  };
  const FINDING = { text: "Ambiguous", severity: "medium", blocking: false };

  /** A registered run log in a throwaway directory, with its own readers. */
  function openTempRunLog(runId: string): {
    dir: string;
    events: () => StepLogEvent[];
    rawOutput: () => string | undefined;
    cleanup: () => void;
  } {
    const dir = mkdtempSync(join(tmpdir(), "af-schema-extract-"));
    openRunLog(runId, { dir, pipelineId: "test-pipeline" });
    return {
      dir,
      events: () => readRunLog(runLogFile(dir, "test-pipeline")),
      rawOutput: () => {
        try {
          return readFileSync(stepRawOutputFile(dir, "test-pipeline", step.id), "utf8");
        } catch {
          return undefined;
        }
      },
      cleanup: () => {
        closeRunLog(runId);
        rmSync(dir, { recursive: true, force: true });
      },
    };
  }

  function runStep(runner: typeof runLlmStep, runId?: string): Promise<Record<string, unknown>> {
    const llmStep = buildLlmStep(
      step,
      { critic: "critic prompt" },
      { registry: NOOP_REGISTRY, store: NOOP_STORE, runner },
      undefined
    );
    return (llmStep as any).execute({
      inputData: {},
      ...(runId !== undefined ? { runId } : {}),
      suspend: () => undefined as never,
    });
  }

  /** Answers `text` once and counts how many times the model was asked. */
  function constantRunner(text: string): { runner: typeof runLlmStep; calls: () => number } {
    let calls = 0;
    const runner: typeof runLlmStep = async () => {
      calls += 1;
      return text;
    };
    return { runner, calls: () => calls };
  }

  it("parses the run that failed: narration, then a fenced object", async () => {
    // Verbatim shape of run b565e7fd's `critic` output, which threw
    // `Unexpected token 'N', "Now produc"... is not valid JSON`.
    const answer = 'Now producing the final critique as JSON.\n\n```json\n{"weaknesses":[]}\n```';
    const { runner, calls } = constantRunner(answer);

    const out = await runStep(runner);

    assert.equal(calls(), 1, "a recoverable answer must not be paid for twice");
    assert.deepEqual(out.critic, { weaknesses: [] });
  });

  it("parses a bare fenced object", async () => {
    const { runner, calls } = constantRunner(
      '```json\n{"weaknesses":[' + JSON.stringify(FINDING) + "]}\n```"
    );

    const out = await runStep(runner);

    assert.equal(calls(), 1);
    assert.deepEqual(out.critic, { weaknesses: [FINDING] });
  });

  it("parses an object followed by trailing prose", async () => {
    const { runner, calls } = constantRunner(
      '{"weaknesses":[]}\n\nThat concludes the critique — let me know if you want more.'
    );

    const out = await runStep(runner);

    assert.equal(calls(), 1);
    assert.deepEqual(out.critic, { weaknesses: [] });
  });

  it("does not stop at a brace inside a string value", async () => {
    // The scanner has to track string state: the first `}` here is inside
    // "use {placeholder}", and an escaped quote follows it.
    const finding = {
      text: 'use {placeholder} and a literal " quote',
      severity: "high",
      blocking: true,
    };
    const { runner, calls } = constantRunner(
      'Here it is:\n\n```json\n{"weaknesses":[' + JSON.stringify(finding) + "]}\n```\nDone."
    );

    const out = await runStep(runner);

    assert.equal(calls(), 1);
    assert.deepEqual(out.critic, { weaknesses: [finding] });
  });

  it("retries once, logging a parse retry, when no JSON can be found at all", async () => {
    const runId = "schema-unparseable";
    const log = openTempRunLog(runId);
    try {
      let calls = 0;
      const runner: typeof runLlmStep = async () => {
        calls += 1;
        return calls === 1
          ? "I could not complete this task."
          : '{"weaknesses":[' + JSON.stringify(FINDING) + "]}";
      };

      const out = await runStep(runner, runId);

      assert.equal(calls, 2, "an unparseable answer must be retried exactly once");
      assert.deepEqual(out.critic, { weaknesses: [FINDING] });
      const retries = log
        .events()
        .filter((e): e is Extract<StepLogEvent, { kind: "retry" }> => e.kind === "retry");
      assert.equal(retries.length, 1, "the retry must be visible in the log");
      assert.equal(retries[0].stepId, step.id);
      assert.equal(retries[0].reason, "parse");
    } finally {
      log.cleanup();
    }
  });

  it("retries once, logging a schema retry, when the JSON breaks the schema", async () => {
    const runId = "schema-violation";
    const log = openTempRunLog(runId);
    try {
      let calls = 0;
      const runner: typeof runLlmStep = async () => {
        calls += 1;
        return calls === 1
          ? '{"weaknesses":[{"text":"x","severity":"moderate","blocking":false}]}'
          : '{"weaknesses":[' + JSON.stringify(FINDING) + "]}";
      };

      const out = await runStep(runner, runId);

      assert.equal(calls, 2);
      assert.deepEqual(out.critic, { weaknesses: [FINDING] });
      const retries = log
        .events()
        .filter((e): e is Extract<StepLogEvent, { kind: "retry" }> => e.kind === "retry");
      assert.equal(retries.length, 1);
      assert.equal(retries[0].reason, "schema", "parsed-but-invalid is a schema retry");
    } finally {
      log.cleanup();
    }
  });

  it("tells a model that dropped the top-level key that the key is missing", async () => {
    const prompts: string[] = [];
    let calls = 0;
    const runner: typeof runLlmStep = async (_entry, prompt) => {
      prompts.push(prompt);
      calls += 1;
      return calls === 1
        ? "[" + JSON.stringify(FINDING) + "]"
        : '{"weaknesses":[' + JSON.stringify(FINDING) + "]}";
    };

    await runStep(runner);

    const retryPrompt = prompts[1] ?? "";
    assert.match(
      retryPrompt,
      /valid JSON but had no top-level "weaknesses" key/u,
      "a parsed answer must not be told it was invalid JSON"
    );
  });

  it("fails after the retry and leaves both raw answers on disk", async () => {
    const runId = "schema-twice-bad";
    const log = openTempRunLog(runId);
    try {
      let calls = 0;
      const runner: typeof runLlmStep = async () => {
        calls += 1;
        return calls === 1 ? "first narration, no JSON" : "second narration, still no JSON";
      };

      await assert.rejects(runStep(runner, runId), /Step "critic":/u);

      const raw = log.rawOutput();
      assert.ok(raw !== undefined, "a failed parse must leave its raw text on disk");
      assert.match(raw, /first narration, no JSON/u);
      assert.match(raw, /second narration, still no JSON/u);
    } finally {
      log.cleanup();
    }
  });

  it("hands the canon schema to the runner for the transports that enforce it", async () => {
    let captured: unknown;
    const runner: typeof runLlmStep = async (_entry, _prompt, deps) => {
      captured = deps?.outputJsonSchema;
      return '{"weaknesses":[]}';
    };

    await runStep(runner);

    assert.deepEqual(captured, WEAK_SCHEMA, "the declared schema must reach the runner deps");
  });

  it("hands no schema to the runner for a step that declares none", async () => {
    let captured: unknown = "unset";
    const runner: typeof runLlmStep = async (_entry, _prompt, deps) => {
      captured = deps?.outputJsonSchema;
      return "prose";
    };
    const llmStep = buildLlmStep(
      { id: "enrich", kind: "llm", prompt: "prompts/enrich.md" },
      { enrich: "enrich prompt" },
      { registry: NOOP_REGISTRY, store: NOOP_STORE, runner },
      undefined
    );
    await (llmStep as any).execute({ inputData: {}, suspend: () => undefined as never });

    assert.equal(captured, undefined);
  });
});
