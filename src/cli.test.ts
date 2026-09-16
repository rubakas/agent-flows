// Tests for the agent-flows CLI entry point (FR-001, FR-002, FR-003, FR-009).
//
// Each test section verifies a specific property that can genuinely fail:
//  - verb routing to its intended module
//  - unknown verbs and unknown generate targets exit non-zero
//  - package.json scripts do not collide with pnpm built-in commands
//  - bin/agent-flows is committed, executable, and wired in package.json

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  copyFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { describe, it } from "node:test";

import { packageRoot } from "./packageRoot.js";

// Resolved by walking up to package.json (spec 038 FR-004) rather than by a
// fixed hop count, so this file reads the same root under tsx and compiled.
const repoRoot = packageRoot();

// ── Helpers ───────────────────────────────────────────────────────────────────

// Run src/cli.ts with tsx and return { code, stdout, stderr }.
// We run through tsx directly (not through bin/agent-flows which sources nvm
// and changes directory) so tests are fast and don't depend on nvm.
function runCli(args: string[]): { code: number; stdout: string; stderr: string } {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx/esm", join(repoRoot, "src", "cli.ts"), ...args],
    {
      cwd: repoRoot,
      env: { ...process.env, AGENT_FLOWS_PROJECT_DIR: repoRoot },
      encoding: "utf8",
      timeout: 30_000,
    }
  );
  return {
    code: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

// ── 1. Help / no-verb ─────────────────────────────────────────────────────────

describe("cli: help", () => {
  it("prints usage and exits 0 with no args", () => {
    const { code, stdout } = runCli([]);
    assert.equal(code, 0);
    assert.match(stdout, /Usage: agent-flows/);
  });

  it("prints usage and exits 0 with --help", () => {
    const { code, stdout } = runCli(["--help"]);
    assert.equal(code, 0);
    assert.match(stdout, /Usage: agent-flows/);
  });

  it("prints usage and exits 0 with -h", () => {
    const { code, stdout } = runCli(["-h"]);
    assert.equal(code, 0);
    assert.match(stdout, /Usage: agent-flows/);
  });

  it("help output lists every verb", () => {
    const { stdout } = runCli(["--help"]);
    for (const verb of ["doctor", "serve", "mcp", "list", "install", "validate", "generate"]) {
      assert.match(stdout, new RegExp(verb), `help output should mention verb: ${verb}`);
    }
  });
});

// ── 2. Unknown verbs exit non-zero ────────────────────────────────────────────

describe("cli: unknown verb", () => {
  it("exits non-zero for an unknown verb", () => {
    const { code, stderr } = runCli(["nonexistent-verb"]);
    assert.notEqual(code, 0);
    assert.match(stderr, /unknown verb/i);
  });

  it("names the unknown verb in the error message", () => {
    const { stderr } = runCli(["totally-bogus"]);
    assert.match(stderr, /totally-bogus/);
  });

  it("lists valid verbs in the error message", () => {
    const { stderr } = runCli(["oops"]);
    // Should tell the user what is valid
    assert.match(stderr, /doctor/);
  });
});

// ── 3. generate with unknown target exits non-zero ────────────────────────────

describe("cli: generate target validation", () => {
  it("exits non-zero for an unknown generate target", () => {
    const { code, stderr } = runCli(["generate", "ruby"]);
    assert.notEqual(code, 0);
    assert.match(stderr, /ruby/);
  });

  it("names valid generate targets in the error", () => {
    const { stderr } = runCli(["generate", "oops"]);
    assert.match(stderr, /claude/);
  });

  it("exits non-zero when generate has no target", () => {
    const { code, stderr } = runCli(["generate"]);
    assert.notEqual(code, 0);
    assert.match(stderr, /target required/i);
  });
});

// ── 4. Verb routing — each verb reaches its intended module ───────────────────
//
// We verify routing by checking that the subprocess output comes from the
// correct module: each target module has distinctive output that cannot come
// from cli.ts itself. We do not execute the full action (e.g., we do not
// actually start the daemon) — we pass arguments that trigger an immediate
// exit with recognisable output from that module.

describe("cli: verb routing — doctor", () => {
  it("routes 'doctor' to src/doctor.ts (runs preflight)", async () => {
    // doctor runs async checks; we just need evidence it started the right module.
    // The doctor module is the only one that prints "Node.js" as a check name.
    // Give it a short timeout — it will complete all checks and exit.
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx/esm", join(repoRoot, "src", "cli.ts"), "doctor"],
      {
        cwd: repoRoot,
        env: { ...process.env, AGENT_FLOWS_PROJECT_DIR: repoRoot },
        encoding: "utf8",
        timeout: 60_000,
      }
    );
    const output = result.stdout + result.stderr;
    // doctor always prints the Node.js version check — this is unique to doctor.ts
    assert.match(output, /Node\.js/);
  });
});

describe("cli: verb routing — list", () => {
  it("routes 'list' to src/install/run.ts with 'list' subcommand", () => {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx/esm", join(repoRoot, "src", "cli.ts"), "list"],
      {
        cwd: repoRoot,
        env: { ...process.env, AGENT_FLOWS_PROJECT_DIR: repoRoot },
        encoding: "utf8",
        timeout: 30_000,
      }
    );
    const output = result.stdout + result.stderr;
    // install/run.ts list mode always prints "AVAILABLE WORKFLOWS:"
    assert.match(output, /AVAILABLE WORKFLOWS/);
  });
});

describe("cli: verb routing — validate", () => {
  it("routes 'validate' to src/canon/validate-cli.ts", () => {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx/esm", join(repoRoot, "src", "cli.ts"), "validate"],
      {
        cwd: repoRoot,
        env: { ...process.env, AGENT_FLOWS_PROJECT_DIR: repoRoot },
        encoding: "utf8",
        timeout: 30_000,
      }
    );
    const output = result.stdout + result.stderr;
    // validate-cli.ts prints "<id> OK" lines for each pipeline it validates
    assert.match(output, /OK \(\d+ steps\)/);
  });
});

describe("cli: verb routing — install", () => {
  it("routes 'install' to src/install/run.ts with 'install' subcommand", () => {
    // We do not actually install; we pass an id that does not exist so it exits
    // without writing files, but the routing is confirmed by the output format
    // from install/run.ts (which prints "Installing into").
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx/esm",
        join(repoRoot, "src", "cli.ts"),
        "install",
        "__nonexistent_workflow__",
      ],
      {
        cwd: repoRoot,
        env: { ...process.env, AGENT_FLOWS_PROJECT_DIR: repoRoot },
        encoding: "utf8",
        timeout: 30_000,
      }
    );
    const output = result.stdout + result.stderr;
    assert.match(output, /Installing into/);
  });
});

// ── 5. FR-009: pnpm script name collision guard ───────────────────────────────
//
// pnpm has built-in commands that shadow same-named package scripts: running
// `pnpm doctor` invokes pnpm's own doctor, never this project's preflight.
// This test asserts that no script in package.json collides with a pnpm
// built-in. If a collision is found, the documented command silently does
// nothing — which FR-009 forbids.
//
// NOTE: `install`, `list`, `test`, and `start` in this set are genuine pnpm
// built-ins. This project does NOT expose any of them as package.json script
// names that could be shadowed, so none are intentional collisions.

describe("FR-009: pnpm built-in name collision guard", () => {
  // Authoritative set of pnpm built-in commands (as of pnpm 10.x) that
  // SHADOW a same-named package script: when the user runs `pnpm <name>`,
  // pnpm runs its own built-in and NEVER delegates to the script.
  //
  // Note — pnpm lifecycle aliases are intentionally absent from this set:
  //   "test"  → `pnpm test` delegates to the "test" script (like `npm test`)
  //   "start" → `pnpm start` delegates to the "start" script
  // Having a script named "test" is therefore safe and intentional in this
  // project.  Having a script named "doctor" is NOT safe — `pnpm doctor`
  // runs pnpm's own doctor and ignores the script entirely (FR-009's root
  // cause).
  const PNPM_BUILTINS = new Set([
    "add",
    "audit",
    "bin",
    "create",
    "deploy",
    "dlx",
    "doctor", // ← the specific one FR-009 fixes; must NOT appear in scripts
    "env",
    "exec",
    "fetch",
    "import",
    "init",
    "install",
    "licenses",
    "link",
    "list",
    "outdated",
    "pack",
    "patch",
    "prune",
    "publish",
    "rebuild",
    "remove",
    "root",
    "run",
    "server",
    "setup",
    "store",
    "uninstall",
    "update",
    "why",
    // "test" and "start" omitted: these are lifecycle aliases that route to
    // the package.json script, not pnpm's own commands. They are safe to use.
  ]);

  it("no package.json script name matches a pnpm built-in command", () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    const scripts = Object.keys(pkg.scripts);
    const collisions = scripts.filter((name) => PNPM_BUILTINS.has(name));
    assert.deepEqual(
      collisions,
      [],
      `These script names collide with pnpm built-in commands and will be shadowed: ${collisions.join(", ")}.\n` +
        "Rename them (e.g. 'doctor' → 'preflight') per FR-009."
    );
  });

  it("the package script formerly named 'doctor' is now named 'preflight'", () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    assert.ok(
      "preflight" in pkg.scripts,
      "package.json must have a 'preflight' script (the renamed doctor)"
    );
    assert.ok(
      !("doctor" in pkg.scripts),
      "package.json must not have a 'doctor' script — it shadows pnpm's built-in"
    );
  });
});

// -- 6. bin/agent-flows: runs the compiled CLI (spec 038 FR-002, FR-003) ------
//
// The launcher is a plain node script now: no tsx, no nvm sourcing, and no $PWD
// capture -- it never changes directory, so the CLI's process.cwd() already is
// the invocation directory and resolveProjectDir() falls back to it. When
// installed on PATH the command is reached through a symlink; node resolves
// import.meta.url to the real file, so the walk up to package.json starts there.

/** Builds dist/ if it is not there -- bin/agent-flows runs the compiled output. */
function ensureBuild(): void {
  if (existsSync(join(repoRoot, "dist", "cli.js"))) return;
  execFileSync(
    process.execPath,
    [join(repoRoot, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.build.json"],
    { cwd: repoRoot, stdio: "pipe" }
  );
  execFileSync(process.execPath, [join(repoRoot, "scripts", "copy-dist-assets.mjs")], {
    cwd: repoRoot,
    stdio: "pipe",
  });
}

/** An installed node older than 22, if this machine has one. */
function olderNodeBinary(): string | undefined {
  const versionsDir = join(homedir(), ".nvm", "versions", "node");
  if (!existsSync(versionsDir)) return undefined;
  for (const entry of readdirSync(versionsDir).sort().reverse()) {
    const major = Number.parseInt(entry.replace(/^v/u, ""), 10);
    // Below 20 the launcher never reaches its own check: node refuses to load an
    // extensionless entry point inside a "type": "module" package at all.
    if (!Number.isFinite(major) || major >= 22 || major < 20) continue;
    const candidate = join(versionsDir, entry, "bin", "node");
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/**
 * The environment a harness gives the launcher: an old node first on PATH and
 * no other node anywhere on it, so the launcher's own search has to do the
 * work. Inheriting the test runner's PATH would hide that -- it carries the
 * Node 22 the suite runs under, which would rescue any selection bug.
 */
function harnessEnv(oldNode: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, AGENT_FLOWS_PROJECT_DIR: repoRoot };
  delete env.AGENT_FLOWS_NODE;
  delete env.AGENT_FLOWS_NODE_REEXEC;
  env.PATH = [dirname(oldNode), "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(delimiter);
  return env;
}

describe("bin/agent-flows: symlink resolution and project targeting", () => {
  it("runs the compiled CLI and resolves the invocation directory as the project", () => {
    ensureBuild();
    // Fresh temp dirs: one to act as the user's working directory, one to hold
    // the symlink (simulating ~/.local/bin or a pnpm global bin directory).
    // realpathSync normalises macOS /var -> /private/var so the comparison does
    // not fail on path aliasing.
    const invocationDir = realpathSync(mkdtempSync(join(tmpdir(), "af-invoke-")));
    const linkDir = realpathSync(mkdtempSync(join(tmpdir(), "af-bin-")));
    const linkPath = join(linkDir, "agent-flows");
    try {
      symlinkSync(join(repoRoot, "bin", "agent-flows"), linkPath);
      const childEnv = { ...process.env };
      delete childEnv.AGENT_FLOWS_PROJECT_DIR;
      const result = spawnSync(linkPath, ["list"], {
        cwd: invocationDir,
        env: childEnv,
        encoding: "utf8",
        timeout: 60_000,
      });
      const output = result.stdout + result.stderr;
      assert.equal(result.status, 0, `Expected exit 0 (wrong package root?):\n${output}`);
      // list prints "Project: <resolved project dir>" first: with no explicit
      // override, that must be where the command was run from.
      assert.ok(
        output.includes(`Project: ${invocationDir}`),
        `Expected "Project: ${invocationDir}" in output:\n${output}`
      );
      // The pipelines it lists come from the package, reached through the link.
      assert.match(output, /AVAILABLE WORKFLOWS/u);
    } finally {
      rmSync(invocationDir, { recursive: true, force: true });
      rmSync(linkDir, { recursive: true, force: true });
    }
  });

  it("is a node script with no tsx and no nvm in it (FR-002)", () => {
    const source = readFileSync(join(repoRoot, "bin", "agent-flows"), "utf8");
    assert.match(source, /^#!\/usr\/bin\/env node\n/u);
    assert.doesNotMatch(source, /\btsx\b/u, "the launcher must not depend on tsx");
    assert.doesNotMatch(source, /nvm\.sh/u, "the launcher must not source nvm");
  });

  it("re-execs under a compatible node when the ambient node is too old (FR-003)", (t) => {
    const oldNode = olderNodeBinary();
    if (oldNode === undefined) {
      t.skip("no node older than 22 (and at least 20) is installed on this machine");
      return;
    }
    ensureBuild();
    // Exactly the harness case: the launcher is started by a node older than 22
    // whose directory is also the first PATH entry, so nothing on PATH rescues
    // it -- the launcher's own search must find the interpreter.
    const childEnv = harnessEnv(oldNode);
    const result = spawnSync(oldNode, [join(repoRoot, "bin", "agent-flows"), "list"], {
      env: childEnv,
      encoding: "utf8",
      timeout: 60_000,
    });
    const output = (result.stdout ?? "") + (result.stderr ?? "");
    assert.equal(result.status, 0, `expected the re-exec to succeed:\n${output}`);
    assert.match(result.stdout ?? "", /AVAILABLE WORKFLOWS/u);
    // A silent, correct run is the point: no version complaint on the way.
    assert.doesNotMatch(
      result.stderr ?? "",
      /Node 22 or newer is required/u,
      `the success path must print no version message:\n${result.stderr ?? ""}`
    );
  });

  it("re-execs onto an interpreter that can load the native module, not merely a newer one (FR-003)", (t) => {
    const oldNode = olderNodeBinary();
    if (oldNode === undefined) {
      t.skip("no node older than 22 (and at least 20) is installed on this machine");
      return;
    }
    ensureBuild();
    // "doctor" is the cheapest verb that opens a database, so it is the only
    // available proof that the chosen interpreter can dlopen better-sqlite3 --
    // a newer major passes the version floor and still fails here.
    const childEnv = harnessEnv(oldNode);
    const result = spawnSync(oldNode, [join(repoRoot, "bin", "agent-flows"), "doctor"], {
      env: childEnv,
      encoding: "utf8",
      timeout: 120_000,
    });
    const output = (result.stdout ?? "") + (result.stderr ?? "");
    assert.match(output, /better-sqlite3 \(native ABI\)/u, `doctor did not run at all:\n${output}`);
    assert.doesNotMatch(
      output,
      /ABI mismatch|ERR_DLOPEN_FAILED/u,
      `the re-exec chose an interpreter that cannot load the database module:\n${output}`
    );
  });

  it("fails loudly when AGENT_FLOWS_NODE points at an unusable binary (FR-003)", (t) => {
    const oldNode = olderNodeBinary();
    if (oldNode === undefined) {
      t.skip("no node older than 22 (and at least 20) is installed on this machine");
      return;
    }
    // A file that exists but is not an interpreter: the override must not fall
    // through to the search, because a wrong explicit setting has to be visible.
    const bogus = join(repoRoot, "package.json");
    const result = spawnSync(oldNode, [join(repoRoot, "bin", "agent-flows"), "list"], {
      env: { ...process.env, AGENT_FLOWS_NODE: bogus },
      encoding: "utf8",
      timeout: 30_000,
    });
    const output = (result.stdout ?? "") + (result.stderr ?? "");
    assert.notEqual(result.status, 0, `expected a non-zero exit:\n${output}`);
    assert.ok(output.includes(bogus), `the message must name ${bogus}:\n${output}`);
  });

  it("refuses instead of re-execing again once the loop marker is set (FR-003)", (t) => {
    const oldNode = olderNodeBinary();
    if (oldNode === undefined) {
      t.skip("no node older than 22 (and at least 20) is installed on this machine");
      return;
    }
    const result = spawnSync(oldNode, [join(repoRoot, "bin", "agent-flows"), "list"], {
      env: { ...process.env, AGENT_FLOWS_NODE_REEXEC: "1" },
      encoding: "utf8",
      timeout: 30_000,
    });
    const output = (result.stdout ?? "") + (result.stderr ?? "");
    assert.notEqual(result.status, 0, `expected a non-zero exit:\n${output}`);
    assert.match(output, /Node 22 or newer is required/u);
    const running = execFileSync(oldNode, ["-p", "process.versions.node"], {
      encoding: "utf8",
    }).trim();
    assert.ok(
      output.includes(running),
      `the message must name the version found (${running}):\n${output}`
    );
  });

  it("refuses to run without a build, naming the command that fixes it", () => {
    // A package root holding the launcher but no dist/ -- a fresh checkout.
    const fakeRoot = realpathSync(mkdtempSync(join(tmpdir(), "af-nodist-")));
    try {
      mkdirSync(join(fakeRoot, "bin"));
      mkdirSync(join(fakeRoot, "pipelines"));
      mkdirSync(join(fakeRoot, "prompts"));
      copyFileSync(join(repoRoot, "bin", "agent-flows"), join(fakeRoot, "bin", "agent-flows"));
      copyFileSync(join(repoRoot, "package.json"), join(fakeRoot, "package.json"));
      const result = spawnSync(process.execPath, [join(fakeRoot, "bin", "agent-flows"), "list"], {
        encoding: "utf8",
        timeout: 30_000,
      });
      const output = result.stdout + result.stderr;
      assert.notEqual(result.status, 0, `expected a non-zero exit:\n${output}`);
      assert.match(output, /pnpm build/u);
    } finally {
      rmSync(fakeRoot, { recursive: true, force: true });
    }
  });
});

// ── 7. bin/agent-flows is committed, executable, and wired in package.json ────

describe("FR-001: bin/agent-flows committed and wired", () => {
  it("bin/agent-flows file exists", () => {
    accessSync(join(repoRoot, "bin", "agent-flows"), constants.F_OK);
  });

  it("bin/agent-flows is executable", () => {
    accessSync(join(repoRoot, "bin", "agent-flows"), constants.X_OK);
  });

  it("package.json bin field points to bin/agent-flows", () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
      bin?: Record<string, string>;
    };
    assert.ok(pkg.bin, "package.json must have a 'bin' field");
    assert.equal(
      pkg.bin["agent-flows"],
      "bin/agent-flows",
      "package.json bin['agent-flows'] must equal 'bin/agent-flows'"
    );
  });

  it("bin/agent-flows is tracked in git (not .gitignored)", () => {
    // git ls-files returns the path if it is tracked; empty string if not.
    const result = execFileSync("git", ["ls-files", "bin/agent-flows"], {
      cwd: repoRoot,
      encoding: "utf8",
    }).trim();
    assert.equal(result, "bin/agent-flows", "bin/agent-flows must be committed to git");
  });
});
