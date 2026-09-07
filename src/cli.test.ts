// Tests for the agent-flows CLI entry point (FR-001, FR-002, FR-003, FR-009).
//
// Each test section verifies a specific property that can genuinely fail:
//  - verb routing to its intended module
//  - unknown verbs and unknown generate targets exit non-zero
//  - package.json scripts do not collide with pnpm built-in commands
//  - bin/agent-flows is committed, executable, and wired in package.json

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { accessSync, constants, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = join(__dirname, "..");

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
    assert.match(stderr, /n8n/);
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

// ── 6. bin/agent-flows is committed, executable, and wired in package.json ────

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
