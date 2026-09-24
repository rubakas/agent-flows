// Stage 2B: every codex step runs confined, against a grant that is removed
// afterwards — the sanitized copy for a `contents: read` step, an empty
// directory for a text-only one.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { devNull, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { PassThrough } from "node:stream";
import { after, describe, it } from "node:test";
import { defaultRegistry } from "../registry.js";
import { codexConfinementArgs } from "../workspace/codexProfile.js";
import { CODEX_ENV_ALLOWLIST, codexAdapter } from "./codex.js";
import type { ModelEntry } from "../registry.js";
import type { SpawnFn } from "../runClaudeCli.js";

const cleanups: (() => void)[] = [];
after(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function git(cwd: string, ...args: string[]): void {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: devNull,
      GIT_CONFIG_SYSTEM: devNull,
      GIT_AUTHOR_NAME: "Fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    },
  });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
}

/** A minimal git repo: one ordinary file, one credential-named file. */
function buildFixtureRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "agent-flows-codex-fixture-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, "repo");
  mkdirSync(join(repo, "src"), { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "src", "index.ts"), "export const ok = true;\n");
  writeFileSync(join(repo, "id_rsa"), "PLANTED\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "fixture");
  return repo;
}

const codexEntry: ModelEntry = { id: "codex", transport: "cli", cli: { bin: "codex" } };

function codexJsonl(text: string): string {
  return JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } });
}

interface Captured {
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Contents of the grant directory at spawn time — it is gone by assertion time. */
  entries: string[];
}

/** Fake spawn that records argv and cwd; `mode` decides how the child ends. */
function makeCapturingSpawn(mode: "ok" | "spawn-error"): {
  spawn: SpawnFn;
  captured: () => Captured | undefined;
} {
  let captured: Captured | undefined;
  const spawn = ((
    _cmd: string,
    args: string[],
    opts: { cwd?: string; env?: NodeJS.ProcessEnv }
  ) => {
    captured = {
      args,
      cwd: opts.cwd,
      env: opts.env,
      entries: opts.cwd !== undefined ? readdirSync(opts.cwd).sort() : [],
    };
    const emitter = new EventEmitter();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdin = new PassThrough();
    const child = Object.assign(emitter, {
      stdout,
      stderr,
      stdin,
      kill: () => undefined,
    });
    setImmediate(() => {
      if (mode === "spawn-error") {
        emitter.emit("error", new Error("boom"));
        return;
      }
      stdout.push(codexJsonl("OK"));
      stdout.push(null);
      stderr.push(null);
      emitter.emit("close", 0);
    });
    return child;
  }) as unknown as SpawnFn;
  return { spawn, captured: () => captured };
}

describe("codex adapter — claude-only structured output is ignored", () => {
  it("outputJsonSchema puts no --json-schema in argv and does not fail the step", async () => {
    const { spawn, captured } = makeCapturingSpawn("ok");

    const out = await codexAdapter.run("hi", codexEntry, {
      spawn,
      outputJsonSchema: { type: "object", required: ["weaknesses"] },
    });

    assert.equal(out, "OK", "a claude-only flag must not fail a codex step");
    assert.ok(
      !(captured()?.args ?? []).includes("--json-schema"),
      "codex must never receive the claude CLI's structured-output flag"
    );
  });
});

describe("codex adapter — confinement and grant lifecycle (2B)", () => {
  it("read step: runs in the sanitized copy with the confinement flags and no -s", async () => {
    const repo = buildFixtureRepo();
    const { spawn, captured } = makeCapturingSpawn("ok");

    const out = await codexAdapter.run("hi", codexEntry, {
      spawn,
      contentsAccess: "read",
      workspaceDir: repo,
    });
    assert.equal(out, "OK");

    const call = captured();
    assert.ok(call, "codex must have been spawned");
    const grantDir = call.cwd;
    assert.ok(grantDir, "the step must run in the grant directory");
    assert.notEqual(grantDir, repo, "the step must not run in the real repo");

    // -C points at the grant, and the whole confinement flag array is present.
    const dashCIdx = call.args.indexOf("-C");
    assert.notEqual(dashCIdx, -1, "-C must be passed");
    assert.equal(call.args[dashCIdx + 1], grantDir);

    for (const flag of codexConfinementArgs(grantDir)) {
      assert.ok(
        call.args.includes(flag),
        `confinement flag missing from argv: ${flag}\ngot: ${call.args.join(" ")}`
      );
    }

    // `-s` is forbidden: it does not confine reads and cannot be combined with
    // default_permissions. The operator's own config must not be consulted either.
    assert.ok(!call.args.includes("-s"), `argv must not contain -s; got: ${call.args.join(" ")}`);
    assert.ok(
      call.args.includes("--ignore-user-config"),
      `argv must contain --ignore-user-config; got: ${call.args.join(" ")}`
    );
    // The grant dir is never a git repo, so codex would refuse to start without this.
    assert.ok(
      call.args.includes("--skip-git-repo-check"),
      `argv must contain --skip-git-repo-check; got: ${call.args.join(" ")}`
    );

    // The copy held the ordinary source and dropped the credential-named file.
    assert.deepEqual(call.entries, ["src"], `unexpected copy contents: ${call.entries.join(", ")}`);

    assert.ok(!existsSync(grantDir), "the sanitized copy must be removed after the run");
  });

  it("read step: the copy is removed even when the transport fails", async () => {
    const repo = buildFixtureRepo();
    const { spawn, captured } = makeCapturingSpawn("spawn-error");

    await assert.rejects(
      codexAdapter.run("hi", codexEntry, { spawn, contentsAccess: "read", workspaceDir: repo }),
      /spawn error/
    );

    const grantDir = captured()?.cwd;
    assert.ok(grantDir, "codex must have been spawned");
    assert.ok(!existsSync(grantDir), "the sanitized copy must be removed on failure too");
  });

  it("no-workspace step: the grant is an empty temp dir, also removed afterwards", async () => {
    const { spawn, captured } = makeCapturingSpawn("ok");

    await codexAdapter.run("hi", codexEntry, { spawn });

    const call = captured();
    assert.ok(call?.cwd, "codex must have been spawned with a grant directory");
    const grantDir = call.cwd;

    // A fresh, empty temp dir — not the process cwd — and it is gone now.
    assert.deepEqual(call.entries, [], "a text-only step's grant must be empty");
    assert.notEqual(grantDir, process.cwd());
    assert.ok(
      basename(grantDir).startsWith("agent-flows-ws-"),
      `the grant must live under the swept prefix; got: ${grantDir}`
    );
    assert.ok(!existsSync(grantDir), "the empty grant must be removed after the run");

    const dashCIdx = call.args.indexOf("-C");
    assert.equal(call.args[dashCIdx + 1], grantDir);
    for (const flag of codexConfinementArgs(grantDir)) {
      assert.ok(call.args.includes(flag), `confinement flag missing from argv: ${flag}`);
    }
    assert.ok(!call.args.includes("-s"), "argv must not contain -s");
    assert.ok(call.args.includes("--ignore-user-config"), "argv must contain --ignore-user-config");
    assert.ok(
      call.args.includes("--skip-git-repo-check"),
      "argv must contain --skip-git-repo-check"
    );
  });
});

describe("codex adapter — child environment is an allowlist", () => {
  it("drops an unlisted variable and keeps the ones codex needs", async () => {
    const marker = "GH_TOKEN_TEST_MARKER";
    process.env[marker] = "leak-me";
    try {
      const { spawn, captured } = makeCapturingSpawn("ok");
      await codexAdapter.run("hi", codexEntry, { spawn });

      const env = captured()?.env;
      assert.ok(env, "spawn must receive an env");
      assert.equal(
        env[marker],
        undefined,
        "an unlisted variable must never reach the codex child — its shell tool can run `env`"
      );
      assert.equal(env.PATH, process.env.PATH, "PATH must survive");
      assert.equal(env.HOME, process.env.HOME, "HOME must survive");
    } finally {
      delete process.env[marker];
    }
  });

  it("forwards AGENT_FLOWS_* by prefix and nothing else beyond the allowlist", async () => {
    const { spawn, captured } = makeCapturingSpawn("ok");
    await codexAdapter.run("hi", codexEntry, {
      spawn,
      env: {
        PATH: "/usr/bin",
        HOME: "/home/tester",
        AGENT_FLOWS_PROVIDER: "openai",
        AWS_SECRET_ACCESS_KEY: "leak-me",
        NPM_TOKEN: "leak-me",
        OPENAI_API_KEY: "leak-me",
      },
    });

    const env = captured()?.env ?? {};
    assert.deepEqual(env, {
      PATH: "/usr/bin",
      HOME: "/home/tester",
      AGENT_FLOWS_PROVIDER: "openai",
    });
  });

  it("allows exactly the documented names", () => {
    assert.deepEqual([...CODEX_ENV_ALLOWLIST].sort(), [
      "CODEX_HOME",
      "HOME",
      "LANG",
      "LC_ALL",
      "LOGNAME",
      "PATH",
      "SHELL",
      "TERM",
      "TMPDIR",
      "USER",
    ]);
  });
});

describe("codex model id — AGENT_FLOWS_CODEX_MODEL", () => {
  it("passes -m <model> when the env var is set", async () => {
    const entry = defaultRegistry({ AGENT_FLOWS_CODEX_MODEL: "gpt-5.6-luna" }).resolve("codex");
    const { spawn, captured } = makeCapturingSpawn("ok");

    await codexAdapter.run("hi", entry, { spawn });

    const args = captured()?.args ?? [];
    const modelIdx = args.indexOf("-m");
    assert.notEqual(modelIdx, -1, `-m must be passed; got: ${args.join(" ")}`);
    assert.equal(args[modelIdx + 1], "gpt-5.6-luna");
  });

  it("passes no -m when the env var is unset", async () => {
    const entry = defaultRegistry({}).resolve("codex");
    const { spawn, captured } = makeCapturingSpawn("ok");

    await codexAdapter.run("hi", entry, { spawn });

    const args = captured()?.args ?? [];
    assert.ok(!args.includes("-m"), `-m must be absent; got: ${args.join(" ")}`);
  });
});

describe("codex adapter — AdapterConfig reaches run(), not just capabilities()", () => {
  it("refuses a read step when confinement is disabled, before spawning", async () => {
    const repo = buildFixtureRepo();
    const { spawn, captured } = makeCapturingSpawn("ok");

    await assert.rejects(
      codexAdapter.run(
        "hi",
        codexEntry,
        { spawn, contentsAccess: "read", workspaceDir: repo },
        { codexConfinement: false }
      ),
      /permission profile is disabled/
    );
    assert.equal(captured(), undefined, "no child may be spawned for an unconfinable read");
  });

  it("still runs a text-only step under that config, confined against the empty grant", async () => {
    const { spawn, captured } = makeCapturingSpawn("ok");

    const out = await codexAdapter.run("hi", codexEntry, { spawn }, { codexConfinement: false });

    assert.equal(out, "OK");
    const call = captured();
    assert.ok(call?.cwd, "a text-only step still runs in a grant directory");
    assert.deepEqual(call.entries, [], "the grant is empty");
    // Confinement is unconditional: the flags are composed whatever the config says.
    for (const flag of codexConfinementArgs(call.cwd)) {
      assert.ok(call.args.includes(flag), `confinement flag missing from argv: ${flag}`);
    }
  });
});

describe("codex adapter — the empty grant sweeps stale siblings", () => {
  it("removes an abandoned grant directory older than 24h", async () => {
    const stale = join(tmpdir(), "agent-flows-ws-r5-stale-probe");
    const fresh = join(tmpdir(), "agent-flows-ws-r5-fresh-probe");
    mkdirSync(stale, { recursive: true });
    mkdirSync(fresh, { recursive: true });
    const twoDaysAgo = (Date.now() - 48 * 60 * 60 * 1000) / 1000;
    utimesSync(stale, twoDaysAgo, twoDaysAgo);

    try {
      const { spawn } = makeCapturingSpawn("ok");
      await codexAdapter.run("hi", codexEntry, { spawn });

      assert.equal(
        existsSync(stale),
        false,
        "a grant left behind by a crashed run must be reclaimed"
      );
      assert.equal(existsSync(fresh), true, "a fresh sibling must be left alone");
    } finally {
      rmSync(stale, { recursive: true, force: true });
      rmSync(fresh, { recursive: true, force: true });
    }
  });
});

describe("codex adapter — the step's own permissions.deny reaches the copy (spec 039)", () => {
  /** A repo holding one ordinary file and one the step's deny list names. */
  function buildDenyFixtureRepo(): string {
    const root = mkdtempSync(join(tmpdir(), "agent-flows-codex-deny-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const repo = join(root, "repo");
    mkdirSync(join(repo, "ops", "secrets-notes"), { recursive: true });
    mkdirSync(join(repo, "src"), { recursive: true });
    git(repo, "init", "-q", "-b", "main");
    writeFileSync(join(repo, "src", "index.ts"), "export const ok = true;\n");
    writeFileSync(join(repo, "ops", "secrets-notes", "rotation.md"), "PLANTED\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "fixture");
    return repo;
  }

  it("a declared deny glob is excluded from the sanitized copy, not merely unread", async () => {
    const repo = buildDenyFixtureRepo();
    let copied: string[] = [];
    const spawn = ((_cmd: string, _args: string[], opts: { cwd?: string }) => {
      copied =
        opts.cwd !== undefined
          ? readdirSync(opts.cwd, { recursive: true }).map((e) => String(e).replace(/\\/g, "/"))
          : [];
      const emitter = new EventEmitter();
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const stdin = new PassThrough();
      const child = Object.assign(emitter, { stdout, stderr, stdin, kill: () => undefined });
      setImmediate(() => {
        stdout.push(codexJsonl("OK"));
        stdout.push(null);
        stderr.push(null);
        emitter.emit("close", 0);
      });
      return child;
    }) as unknown as SpawnFn;

    await codexAdapter.run("hi", codexEntry, {
      spawn,
      contentsAccess: "read",
      workspaceDir: repo,
      denyPatterns: ["ops/secrets-notes/**"],
      env: {},
    });

    assert.ok(
      copied.includes("src/index.ts"),
      `the ordinary source must still be copied: ${copied.join(", ")}`
    );
    assert.ok(
      !copied.includes("ops/secrets-notes/rotation.md"),
      `a denied path must not exist inside the grant: ${copied.join(", ")}`
    );
  });
});
