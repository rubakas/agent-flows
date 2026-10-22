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
  chmodSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  copyFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { describe, it } from "node:test";

import { nodeInstallRemedy, nodeSatisfies, requiredNodePin } from "./nodeVersion.js";
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
    for (const verb of [
      "doctor",
      "install",
      "uninstall",
      "serve",
      "mcp",
      "list",
      "fork",
      "enable",
      "disable",
      "validate",
      "generate",
    ]) {
      assert.match(stdout, new RegExp(verb), `help output should mention verb: ${verb}`);
    }
  });
});

// ── 2. Unknown verbs exit non-zero ────────────────────────────────────────────

describe("cli: unknown verb", () => {
  it("exits non-zero for a workflow id passed to install (spec 038 FR-028)", () => {
    // `install` now registers harnesses and takes no arguments; installing a
    // workflow into a project is gone, and editing forks instead.
    const { code, stderr } = runCli(["install", "investigate"]);
    assert.notEqual(code, 0, "install takes no workflow id");
    assert.match(stderr, /takes no arguments/i);
  });

  it("exits non-zero when uninstall is given an argument", () => {
    const { code, stderr } = runCli(["uninstall", "--remove"]);
    assert.notEqual(code, 0, "uninstall takes no arguments");
    assert.match(stderr, /takes no arguments/i);
  });

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
  it("routes 'list' to src/canon/list-cli.ts", () => {
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
    // list-cli.ts always prints "AVAILABLE WORKFLOWS:"
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

describe("cli: verb routing — fork", () => {
  it("routes 'fork' to src/canon/fork-cli.ts (spec 038 FR-021)", () => {
    // No id is passed, so fork-cli prints its usage and exits 0 without writing
    // anything — enough to prove the routing.
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx/esm", join(repoRoot, "src", "cli.ts"), "fork"],
      {
        cwd: repoRoot,
        env: { ...process.env, AGENT_FLOWS_PROJECT_DIR: repoRoot },
        encoding: "utf8",
        timeout: 30_000,
      }
    );
    const output = result.stdout + result.stderr;
    assert.match(output, /Usage: agent-flows fork/);
  });
});

describe("cli: verb routing — install/uninstall", () => {
  it("routes 'install --help' to src/harness/install-cli.ts, which prints its usage", () => {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx/esm", join(repoRoot, "src", "cli.ts"), "install", "--help"],
      {
        cwd: repoRoot,
        env: { ...process.env, AGENT_FLOWS_PROJECT_DIR: repoRoot },
        encoding: "utf8",
        timeout: 30_000,
      }
    );
    assert.equal(result.status, 0, "asking what a command does must not be an error");
    assert.match(result.stdout, /Usage: agent-flows install/);
  });

  it("routes 'uninstall -h' to src/harness/uninstall-cli.ts, which prints its usage", () => {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx/esm", join(repoRoot, "src", "cli.ts"), "uninstall", "-h"],
      {
        cwd: repoRoot,
        env: { ...process.env, AGENT_FLOWS_PROJECT_DIR: repoRoot },
        encoding: "utf8",
        timeout: 30_000,
      }
    );
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Usage: agent-flows uninstall/);
  });
});

describe("cli: verb routing — enable/disable", () => {
  it("routes 'disable' with no id to src/runtime/visibility-cli.ts", () => {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx/esm", join(repoRoot, "src", "cli.ts"), "disable"],
      {
        cwd: repoRoot,
        env: { ...process.env, AGENT_FLOWS_PROJECT_DIR: repoRoot },
        encoding: "utf8",
        timeout: 30_000,
      }
    );
    const output = result.stdout + result.stderr;
    assert.match(output, /a workflow id is required/);
    assert.notEqual(result.status, 0);
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

// The launcher only searches when the RUNNING node does not satisfy the pin, so
// these tests need a starting interpreter that does not. No such Node is installed
// (and none should have to be): a preload, passed on the child's argv only, makes
// a real Node report a chosen version. It is not in NODE_OPTIONS, so it cannot
// leak into the interpreter the launcher re-execs.

const PIN = requiredNodePin(repoRoot);
const BELOW_FLOOR = `${String(PIN.major)}.${String(PIN.minor)}.${String(PIN.patch - 1)}`;
const NEWER_PATCH = `${String(PIN.major)}.${String(PIN.minor)}.${String(PIN.patch + 1)}`;
const NEWER_MINOR = `${String(PIN.major)}.${String(PIN.minor + 1)}.0`;
const SYSTEM_DIRS = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];
// Locations the launcher searches that a test cannot redirect.
const FIXED_NODES = ["/opt/homebrew/bin/node", "/usr/local/bin/node"];

/** One launcher scenario: a scratch directory holding fake interpreters and markers. */
interface Scenario {
  dir: string;
  nvmDir: string;
  markerDir: string;
}

function makeScenario(): Scenario {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "af-launch-")));
  const markerDir = join(dir, "markers");
  mkdirSync(markerDir);
  return { dir, nvmDir: join(dir, "nvm"), markerDir };
}

/** Fails, never skips, when this machine cannot host the scenario hermetically. */
function requireHermeticMachine(): void {
  assert.ok(
    nodeSatisfies(process.versions.node, PIN),
    `the test runner (Node ${process.versions.node}) must itself satisfy the pin: the fake interpreters exec it`
  );
  assert.ok(PIN.patch > 0, "the pin's patch must be above 0 to derive a below-floor version");
  const stray = [...FIXED_NODES, ...SYSTEM_DIRS.map((dir) => join(dir, "node"))].filter((path) =>
    existsSync(path)
  );
  assert.deepEqual(
    stray,
    [],
    `${stray.join(", ")} exists, and the launcher searches it where this test cannot redirect it, ` +
      "so the scenario cannot be hermetic. Remove it for the run, or give the launcher a way to skip it."
  );
}

/**
 * A fake `node` at <binDir>/node. It answers `-p` with `version`, and otherwise runs the
 * real Node. Every call leaves a marker of its own kind, so a test can tell
 * which interpreter was probed, which was asked to load the native module, and
 * which actually ran the CLI -- the run itself is identical whichever it was.
 */
function installFakeNode(
  scenario: Scenario,
  binDir: string,
  name: string,
  version: string
): { path: string; marker: (kind: "probe" | "native" | "run") => string } {
  mkdirSync(binDir, { recursive: true });
  const path = join(binDir, "node");
  const marker = (kind: "probe" | "native" | "run"): string =>
    join(scenario.markerDir, `${name}.${kind}`);
  writeFileSync(
    path,
    [
      "#!/bin/sh",
      'case "$1" in',
      `  -p) : > '${marker("probe")}'; echo '${version}' ;;`,
      `  -e) : > '${marker("native")}'; exec '${process.execPath}' "$@" ;;`,
      `  *) : > '${marker("run")}'; exec '${process.execPath}' "$@" ;;`,
      "esac",
      "",
    ].join("\n")
  );
  chmodSync(path, 0o755);
  return { path, marker };
}

/** The real Node, linked where nvm would keep it -- the interpreter that really can run the CLI. */
function installRealNvmNode(scenario: Scenario): void {
  const binDir = join(scenario.nvmDir, "versions", "node", `v${process.versions.node}`, "bin");
  mkdirSync(binDir, { recursive: true });
  symlinkSync(process.execPath, join(binDir, "node"));
}

/**
 * Run the launcher under a real Node that reports `startingVersion`, with a PATH
 * of `pathDirs` plus the system directories and nothing else. The ambient
 * environment is not inherited where it matters: the test runner's PATH carries
 * the Node the suite runs under, which would rescue any selection bug.
 */
function runLauncher(
  scenario: Scenario,
  startingVersion: string,
  args: string[],
  options: { pathDirs?: string[]; extraEnv?: NodeJS.ProcessEnv; timeout?: number } = {}
): { status: number | null; stdout: string; stderr: string } {
  const preload = join(scenario.dir, `report-${startingVersion}.cjs`);
  writeFileSync(
    preload,
    `Object.defineProperty(process.versions, "node", { value: "${startingVersion}", configurable: true });\n`
  );
  const childEnv: NodeJS.ProcessEnv = { ...process.env, AGENT_FLOWS_PROJECT_DIR: repoRoot };
  delete childEnv.AGENT_FLOWS_NODE;
  delete childEnv.AGENT_FLOWS_NODE_REEXEC;
  delete childEnv.NODE_OPTIONS;
  childEnv.PATH = [...(options.pathDirs ?? []), ...SYSTEM_DIRS].join(delimiter);
  childEnv.NVM_DIR = scenario.nvmDir;
  Object.assign(childEnv, options.extraEnv);
  const result = spawnSync(
    process.execPath,
    ["-r", preload, join(repoRoot, "bin", "agent-flows"), ...args],
    { env: childEnv, encoding: "utf8", timeout: options.timeout ?? 60_000 }
  );
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
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

  it("the starting interpreter really reports the version the preload gives it", () => {
    const scenario = makeScenario();
    try {
      const preload = join(scenario.dir, "probe.cjs");
      writeFileSync(
        preload,
        `Object.defineProperty(process.versions, "node", { value: "${BELOW_FLOOR}", configurable: true });\n`
      );
      const reported = execFileSync(
        process.execPath,
        ["-r", preload, "-p", "process.versions.node"],
        { encoding: "utf8" }
      ).trim();
      assert.equal(reported, BELOW_FLOOR);
      assert.ok(!nodeSatisfies(reported, PIN), "the starting interpreter must not satisfy the pin");
    } finally {
      rmSync(scenario.dir, { recursive: true, force: true });
    }
  });

  it("re-execs under a compatible node when the ambient node is below the floor (FR-003)", () => {
    requireHermeticMachine();
    ensureBuild();
    const scenario = makeScenario();
    try {
      // Exactly the harness case: the launcher is started by a node that does not
      // satisfy the pin and nothing on PATH rescues it -- the launcher's own
      // search must find the interpreter.
      installRealNvmNode(scenario);
      const result = runLauncher(scenario, BELOW_FLOOR, ["list"]);
      const output = result.stdout + result.stderr;
      assert.equal(result.status, 0, `expected the re-exec to succeed:\n${output}`);
      assert.match(result.stdout, /AVAILABLE WORKFLOWS/u);
      // A silent, correct run is the point: no version complaint on the way.
      assert.doesNotMatch(
        result.stderr,
        /is required/u,
        `the success path must print no version message:\n${result.stderr}`
      );
    } finally {
      rmSync(scenario.dir, { recursive: true, force: true });
    }
  });

  it("re-execs onto an interpreter that can load the native module, not merely a newer one (FR-003)", () => {
    requireHermeticMachine();
    ensureBuild();
    const scenario = makeScenario();
    try {
      installRealNvmNode(scenario);
      // "doctor" is the cheapest verb that opens a database, so it is the only
      // available proof that the chosen interpreter can dlopen better-sqlite3 --
      // a newer major passes the version floor and still fails here.
      const result = runLauncher(scenario, BELOW_FLOOR, ["doctor"], { timeout: 120_000 });
      const output = result.stdout + result.stderr;
      assert.match(
        output,
        /better-sqlite3 \(native ABI\)/u,
        `doctor did not run at all:\n${output}`
      );
      assert.doesNotMatch(
        output,
        /ABI mismatch|ERR_DLOPEN_FAILED/u,
        `the re-exec chose an interpreter that cannot load the database module:\n${output}`
      );
    } finally {
      rmSync(scenario.dir, { recursive: true, force: true });
    }
  });

  it("fails loudly when AGENT_FLOWS_NODE points at an unusable binary (FR-003)", () => {
    const scenario = makeScenario();
    try {
      // A file that exists but is not an interpreter: the override must not fall
      // through to the search, because a wrong explicit setting has to be visible.
      const bogus = join(repoRoot, "package.json");
      const result = runLauncher(scenario, BELOW_FLOOR, ["list"], {
        extraEnv: { AGENT_FLOWS_NODE: bogus },
        timeout: 30_000,
      });
      const output = result.stdout + result.stderr;
      assert.notEqual(result.status, 0, `expected a non-zero exit:\n${output}`);
      assert.ok(output.includes(bogus), `the message must name ${bogus}:\n${output}`);
    } finally {
      rmSync(scenario.dir, { recursive: true, force: true });
    }
  });

  it("refuses an AGENT_FLOWS_NODE that is the right major but below the floor", () => {
    requireHermeticMachine();
    const scenario = makeScenario();
    try {
      const fake = installFakeNode(
        scenario,
        join(scenario.dir, "override"),
        "override",
        BELOW_FLOOR
      );
      const result = runLauncher(scenario, BELOW_FLOOR, ["list"], {
        extraEnv: { AGENT_FLOWS_NODE: fake.path },
        timeout: 30_000,
      });
      const output = result.stdout + result.stderr;
      assert.notEqual(result.status, 0, `expected a non-zero exit:\n${output}`);
      assert.ok(output.includes(fake.path), `the message must name ${fake.path}:\n${output}`);
      assert.ok(
        output.includes(PIN.floor),
        `the message must name the floor ${PIN.floor}:\n${output}`
      );
      assert.ok(output.includes(BELOW_FLOOR), `the message must name what it reports:\n${output}`);
      assert.ok(!existsSync(fake.marker("run")), "a below-floor override must not run the CLI");
    } finally {
      rmSync(scenario.dir, { recursive: true, force: true });
    }
  });

  it("refuses instead of re-execing again once the loop marker is set (FR-003)", () => {
    const scenario = makeScenario();
    try {
      const result = runLauncher(scenario, BELOW_FLOOR, ["list"], {
        extraEnv: { AGENT_FLOWS_NODE_REEXEC: "1" },
        timeout: 30_000,
      });
      const output = result.stdout + result.stderr;
      assert.notEqual(result.status, 0, `expected a non-zero exit:\n${output}`);
      assert.match(
        output,
        new RegExp(
          `Node ${String(PIN.major)} at or above ${PIN.floor.replace(/\./gu, "\\.")} is required`,
          "u"
        )
      );
      assert.ok(
        output.includes(BELOW_FLOOR),
        `the message must name the version found (${BELOW_FLOOR}):\n${output}`
      );
    } finally {
      rmSync(scenario.dir, { recursive: true, force: true });
    }
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

// -- 6b. bin/agent-flows: the security floor (spec 048 FR-3) --------------------
//
// Every assertion is on markers the fake interpreters leave, not on exit codes:
// the real CLI that eventually runs is the same whichever interpreter was
// chosen, so a green exit proves nothing about the selection.

describe("bin/agent-flows: interpreter search honours the security floor", () => {
  it("passes over a below-floor node on PATH for a satisfying one under nvm", () => {
    requireHermeticMachine();
    ensureBuild();
    const scenario = makeScenario();
    try {
      const onPath = installFakeNode(scenario, join(scenario.dir, "path"), "path", BELOW_FLOOR);
      const nvmBin = join(scenario.nvmDir, "versions", "node", `v${PIN.floor}`, "bin");
      const underNvm = installFakeNode(scenario, nvmBin, "nvm", PIN.floor);
      const result = runLauncher(scenario, BELOW_FLOOR, ["list"], {
        pathDirs: [dirname(onPath.path)],
      });
      const output = result.stdout + result.stderr;
      assert.equal(result.status, 0, `expected success:\n${output}`);
      assert.ok(existsSync(onPath.marker("probe")), "the PATH node was never even considered");
      assert.ok(
        !existsSync(onPath.marker("native")),
        "a below-floor node reached the native probe"
      );
      assert.ok(!existsSync(onPath.marker("run")), "the below-floor PATH node ran the CLI");
      assert.ok(
        existsSync(underNvm.marker("native")),
        "the nvm node was not probed for the module"
      );
      assert.ok(existsSync(underNvm.marker("run")), "the nvm node did not run the CLI");
    } finally {
      rmSync(scenario.dir, { recursive: true, force: true });
    }
  });

  for (const [label, version] of [
    ["exactly the floor", PIN.floor],
    ["a newer patch", NEWER_PATCH],
    ["a newer minor", NEWER_MINOR],
  ] as const) {
    it(`chooses a PATH node at ${label} (${version})`, () => {
      requireHermeticMachine();
      ensureBuild();
      const scenario = makeScenario();
      try {
        const onPath = installFakeNode(scenario, join(scenario.dir, "path"), "path", version);
        const result = runLauncher(scenario, BELOW_FLOOR, ["list"], {
          pathDirs: [dirname(onPath.path)],
        });
        const output = result.stdout + result.stderr;
        assert.equal(result.status, 0, `expected success:\n${output}`);
        assert.ok(existsSync(onPath.marker("run")), `the ${version} PATH node did not run the CLI`);
      } finally {
        rmSync(scenario.dir, { recursive: true, force: true });
      }
    });
  }

  it("does not search at all when the running node already satisfies the pin", () => {
    requireHermeticMachine();
    ensureBuild();
    const scenario = makeScenario();
    try {
      const onPath = installFakeNode(scenario, join(scenario.dir, "path"), "path", PIN.floor);
      const result = runLauncher(scenario, PIN.floor, ["list"], {
        pathDirs: [dirname(onPath.path)],
      });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.ok(!existsSync(onPath.marker("probe")), "a satisfying running node still searched");
    } finally {
      rmSync(scenario.dir, { recursive: true, force: true });
    }
  });

  it("refuses when every candidate is below the floor, naming the floor, the remedy and the paths", () => {
    // Fails, not skips, where a fixed-location node exists: it would be found,
    // and this refusal could not be reached (see requireHermeticMachine).
    requireHermeticMachine();
    const scenario = makeScenario();
    try {
      const onPath = installFakeNode(scenario, join(scenario.dir, "path"), "path", BELOW_FLOOR);
      const oldVersion = `${String(PIN.major)}.0.0`;
      const underNvm = installFakeNode(
        scenario,
        join(scenario.nvmDir, "versions", "node", `v${oldVersion}`, "bin"),
        "nvm",
        oldVersion
      );
      const result = runLauncher(scenario, BELOW_FLOOR, ["list"], {
        pathDirs: [dirname(onPath.path)],
        timeout: 30_000,
      });
      const output = result.stdout + result.stderr;
      assert.notEqual(result.status, 0, `expected a refusal:\n${output}`);
      assert.ok(
        output.includes(PIN.floor),
        `the refusal must name the floor ${PIN.floor}:\n${output}`
      );
      assert.ok(
        output.includes(nodeInstallRemedy(PIN)),
        `the refusal must say "${nodeInstallRemedy(PIN)}":\n${output}`
      );
      assert.ok(
        output.includes(BELOW_FLOOR),
        `the refusal must name what it is running:\n${output}`
      );
      for (const rejected of [onPath.path, underNvm.path]) {
        assert.ok(output.includes(rejected), `the refusal must name ${rejected}:\n${output}`);
      }
      assert.ok(!existsSync(onPath.marker("run")) && !existsSync(underNvm.marker("run")));
    } finally {
      rmSync(scenario.dir, { recursive: true, force: true });
    }
  });

  it("does not count another major as 'below the floor' in the refusal", () => {
    requireHermeticMachine();
    const scenario = makeScenario();
    try {
      const otherMajor = installFakeNode(
        scenario,
        join(scenario.dir, "path"),
        "path",
        `${String(PIN.major + 2)}.0.0`
      );
      const result = runLauncher(scenario, BELOW_FLOOR, ["list"], {
        pathDirs: [dirname(otherMajor.path)],
        timeout: 30_000,
      });
      assert.notEqual(result.status, 0);
      assert.ok(
        !result.stderr.includes(otherMajor.path),
        `named a wrong-major node:\n${result.stderr}`
      );
    } finally {
      rmSync(scenario.dir, { recursive: true, force: true });
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
