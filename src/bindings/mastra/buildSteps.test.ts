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
import { StepTimeoutError } from "../../canon/runStep.js";
import { makeFakeChild } from "../../canon/testing/fakeSpawn.js";
import { DEFAULT_CHECK_COMMAND, buildCheckStep, buildLlmStep } from "./buildSteps.js";
import type { SpawnFn } from "../../canon/runClaudeCli.js";
import type { runLlmStep } from "../../canon/runStep.js";
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
