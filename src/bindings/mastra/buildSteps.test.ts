// Tests for buildCheckStep and buildLlmStep step builders.

import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { ModelRegistry } from "../../canon/registry.js";
import { CREDENTIAL_DENY_PATTERNS, StepTimeoutError, runLlmStep } from "../../canon/runStep.js";
import { makeFakeChild, makeStreamJsonChild } from "../../canon/testing/fakeSpawn.js";
import {
  closeRunLog,
  openRunLog,
  readRunLog,
  readStepOutput,
  runLogFile,
  stepOutputFile,
} from "../../runtime/stepLog.js";
import { DEFAULT_CHECK_COMMAND, buildCheckStep, buildLlmStep } from "./buildSteps.js";
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
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "package.json");
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
