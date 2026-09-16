// Spec 038 Ship 4: `agent-flows setup`, `setup --remove` and doctor's reach
// report (D10, D11, D17, FR-030/FR-031/FR-032).
//
// EVERY path in this file lives under a fresh mkdtemp directory, and the
// harness CLIs are never really spawned: `home` and `run` are injected, so a
// test can neither read nor write the developer's real ~/.claude.json,
// ~/.codex/config.toml or ~/.config/opencode/. That is the only reason this
// suite is safe to run on a machine with all four harnesses installed.

import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { after, describe, it } from "node:test";

import {
  SERVER_NAME,
  claudeConfigPath,
  codexConfigPath,
  commandResolves,
  harnessReach,
  opencodeConfigPath,
  readClaudeRegistration,
  readCodexRegistration,
  readOpencodeRegistration,
  registeredCommand,
  runRemove,
  runSetup,
  type HarnessResult,
  type RunResult,
  type SetupEnv,
} from "./harnesses.js";

// ── Temp homes ────────────────────────────────────────────────────────────────

const homes: string[] = [];

/** A fresh, empty HOME under the OS temp directory. Never the real one. */
function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "agent-flows-setup-"));
  homes.push(home);
  return home;
}

after(() => {
  for (const home of homes) rmSync(home, { recursive: true, force: true });
});

const COMMAND = ["/opt/agent-flows/bin/agent-flows", "mcp"];

/** What a fake harness CLI was asked to do. */
interface Call {
  bin: string;
  args: string[];
}

interface Fake {
  env: SetupEnv;
  calls: Call[];
}

/**
 * A SetupEnv whose harness CLIs are fakes.
 *
 * `emulate: true` makes the fakes write and delete the same entries the real
 * `claude mcp add` / `codex mcp add` write, which is what lets the idempotence
 * test observe a second run finding the harness already registered. Left off,
 * the fakes only record — which is what the D17 test needs, so that every file
 * that changed during setup is one setup itself wrote.
 */
function fakeEnv(
  home: string,
  options: { installed?: string[]; emulate?: boolean; command?: string[] } = {}
): Fake {
  const installed = new Set(options.installed ?? ["claude", "codex", "opencode"]);
  const calls: Call[] = [];
  const env: SetupEnv = {
    home,
    command: options.command ?? COMMAND,
    which: (bin) => (installed.has(bin) ? `/usr/local/bin/${bin}` : undefined),
    run: (bin, args) => {
      calls.push({ bin, args });
      if (options.emulate !== true) return { code: 0, stdout: "", stderr: "" };
      return emulate(home, bin, args);
    },
  };
  return { env, calls };
}

/** Stand-in for the real harness CLIs, writing into the temp home only. */
function emulate(home: string, bin: string, args: string[]): RunResult {
  const [, verb] = args;
  const command = args.slice(args.indexOf("--") + 1);
  if (bin === "claude") {
    const path = claudeConfigPath(home);
    const config: Record<string, unknown> = readJson(path) ?? { numStartups: 3 };
    const servers = { ...((config.mcpServers as Record<string, unknown>) ?? {}) };
    if (verb === "add") servers[SERVER_NAME] = { command: command[0], args: command.slice(1) };
    else delete servers[SERVER_NAME];
    writeFileSync(path, JSON.stringify({ ...config, mcpServers: servers }, null, 2));
    return { code: 0, stdout: "", stderr: "" };
  }
  if (bin === "codex") {
    const path = codexConfigPath(home);
    mkdirSync(join(home, ".codex"), { recursive: true });
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      text = 'model = "gpt-5"\n';
    }
    if (verb === "add") {
      text += `\n[mcp_servers.${SERVER_NAME}]\ncommand = ${JSON.stringify(command[0])}\nargs = ${JSON.stringify(command.slice(1))}\n`;
    } else {
      text = text.replace(new RegExp(`\\n\\[mcp_servers\\.${SERVER_NAME}\\]\\n[^[]*`, "u"), "");
    }
    writeFileSync(path, text);
    return { code: 0, stdout: "", stderr: "" };
  }
  return { code: 1, stdout: "", stderr: `unknown fake binary ${bin}` };
}

function readJson(path: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function byHarness(results: HarnessResult[], harness: string): HarnessResult {
  const found = results.find((r) => r.harness === harness);
  assert.ok(found, `no result for ${harness}`);
  return found;
}

/** Every file under `root`, relative path → contents. */
function snapshot(root: string): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else files.set(relative(root, path), readFileSync(path, "utf8"));
    }
  };
  walk(root);
  return files;
}

/** Relative paths whose contents differ between two snapshots. */
function changedPaths(before: Map<string, string>, after: Map<string, string>): string[] {
  const paths = new Set([...before.keys(), ...after.keys()]);
  return [...paths].filter((path) => before.get(path) !== after.get(path)).sort();
}

function writeFile(path: string, content: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}

// ── The registered command (D10) ──────────────────────────────────────────────

describe("registeredCommand", () => {
  it("registers an absolute path plus `mcp`, never the bare name", () => {
    const home = makeHome();
    const launcher = join(home, "bin", "agent-flows");
    writeFile(launcher, "#!/usr/bin/env node\n");
    chmodSync(launcher, 0o755);

    const command = registeredCommand((bin) => (bin === "agent-flows" ? launcher : undefined));
    // realpath: a global install is reached through a symlink, and the real
    // file is what stays put (and what /tmp resolves to on macOS).
    assert.deepEqual(command, [realpathSync(launcher), "mcp"]);
    assert.notEqual(
      command[0],
      "agent-flows",
      "a bare name stops resolving as soon as another node version is selected"
    );
  });

  it("falls back to this package's own launcher when nothing is on PATH", () => {
    const command = registeredCommand(() => undefined);
    assert.match(command[0], /bin[/\\]agent-flows$/u);
    assert.equal(command[1], "mcp");
  });
});

// ── FR-030: setup registers each installed harness ────────────────────────────

describe("FR-030: setup registers the MCP server", () => {
  it("invokes each harness's own CLI with its documented argument vector", () => {
    const home = makeHome();
    const { env, calls } = fakeEnv(home);
    const results = runSetup(env);

    assert.deepEqual(calls, [
      {
        bin: "claude",
        args: ["mcp", "add", SERVER_NAME, "--scope", "user", "--", ...COMMAND],
      },
      { bin: "codex", args: ["mcp", "add", SERVER_NAME, "--", ...COMMAND] },
    ]);
    assert.equal(byHarness(results, "claude-code").status, "registered");
    assert.equal(byHarness(results, "codex").status, "registered");
  });

  it('writes only mcp["agent-flows"] into the OpenCode config', () => {
    const home = makeHome();
    writeFile(
      opencodeConfigPath(home),
      JSON.stringify(
        { theme: "tokyonight", mcp: { other: { type: "local", command: ["x"] } } },
        null,
        2
      ) + "\n"
    );
    const { env } = fakeEnv(home);
    runSetup(env);

    const config = readJson(opencodeConfigPath(home));
    assert.ok(config);
    assert.equal(config.theme, "tokyonight");
    const mcp = config.mcp as Record<string, Record<string, unknown>>;
    assert.deepEqual(mcp.other, { type: "local", command: ["x"] }, "other servers must survive");
    assert.deepEqual(mcp[SERVER_NAME], { type: "local", command: COMMAND, enabled: true });
  });

  it("copies the OpenCode config to .bak once, before the first edit", () => {
    const home = makeHome();
    const original = JSON.stringify({ theme: "tokyonight" }, null, 2) + "\n";
    writeFile(opencodeConfigPath(home), original);

    runSetup(fakeEnv(home).env);
    assert.equal(readFileSync(`${opencodeConfigPath(home)}.bak`, "utf8"), original);

    // A second setup must not replace the pre-agent-flows copy.
    runSetup(fakeEnv(home, { command: [COMMAND[0], "mcp", "--x"] }).env);
    assert.equal(readFileSync(`${opencodeConfigPath(home)}.bak`, "utf8"), original);
  });

  it("skips a harness whose binary is not on PATH", () => {
    const home = makeHome();
    const { env, calls } = fakeEnv(home, { installed: ["codex"] });
    const results = runSetup(env);

    assert.equal(byHarness(results, "claude-code").status, "not-installed");
    assert.equal(byHarness(results, "opencode").status, "not-installed");
    assert.deepEqual(
      calls.map((c) => c.bin),
      ["codex"]
    );
    assert.equal(readJson(opencodeConfigPath(home)), undefined, "no OpenCode config was created");
  });

  it("reports T3 Code as inheriting its provider's configuration", () => {
    const result = byHarness(runSetup(fakeEnv(makeHome()).env), "t3-code");
    assert.equal(result.status, "not-applicable");
    assert.match(result.detail, /inherits/u);
  });

  for (const rival of ["opencode.jsonc", "config.json"]) {
    it(`refuses to create a second OpenCode config next to ${rival}`, () => {
      const home = makeHome();
      const rivalPath = join(home, ".config", "opencode", rival);
      writeFile(rivalPath, "{}\n");

      const result = byHarness(runSetup(fakeEnv(home).env), "opencode");
      assert.equal(result.status, "refused");
      assert.ok(
        result.detail.includes(rivalPath),
        `the message must name the file: ${result.detail}`
      );
      assert.equal(
        readJson(opencodeConfigPath(home)),
        undefined,
        "a second config OpenCode would also load must not be created"
      );
    });
  }

  it("reports a harness CLI failure instead of claiming success", () => {
    const home = makeHome();
    const env: SetupEnv = {
      ...fakeEnv(home).env,
      run: () => ({ code: 1, stdout: "", stderr: "claude: not logged in\n" }),
    };
    const result = byHarness(runSetup(env), "claude-code");
    assert.equal(result.status, "failed");
    assert.match(result.detail, /not logged in/u);
  });
});

// ── FR-030: idempotence ───────────────────────────────────────────────────────

describe("FR-030: setup is idempotent", () => {
  it("a second setup changes nothing and reports every harness already registered", () => {
    const home = makeHome();
    writeFile(opencodeConfigPath(home), JSON.stringify({ theme: "tokyonight" }, null, 2) + "\n");

    runSetup(fakeEnv(home, { emulate: true }).env);
    const afterFirst = snapshot(home);

    const second = fakeEnv(home, { emulate: true });
    const results = runSetup(second.env);

    assert.deepEqual(
      changedPaths(afterFirst, snapshot(home)),
      [],
      "a second setup must write nothing"
    );
    assert.deepEqual(second.calls, [], "a registered harness's CLI must not be invoked again");
    for (const harness of ["claude-code", "codex", "opencode"]) {
      assert.equal(
        byHarness(results, harness).status,
        "already-registered",
        `${harness} should report already-registered`
      );
    }
  });

  it("replaces an entry that names a command from an older install location", () => {
    const home = makeHome();
    runSetup(fakeEnv(home, { emulate: true, command: ["/old/prefix/agent-flows", "mcp"] }).env);

    const second = fakeEnv(home, { emulate: true });
    const results = runSetup(second.env);

    assert.equal(byHarness(results, "claude-code").status, "registered");
    assert.deepEqual(
      second.calls.map((c) => c.args.slice(0, 3)),
      [
        ["mcp", "remove", SERVER_NAME],
        ["mcp", "add", SERVER_NAME],
        ["mcp", "remove", SERVER_NAME],
        ["mcp", "add", SERVER_NAME],
      ],
      "a stale entry is replaced, not duplicated"
    );
    assert.deepEqual(readClaudeRegistration(home)?.command, COMMAND);
    assert.deepEqual(readCodexRegistration(home)?.command, COMMAND);
  });
});

// ── FR-030 / D17: setup writes to no other path ───────────────────────────────

describe("D17: setup touches nothing that belongs to agent-notes", () => {
  // The dot-directory content of every harness — the memory file, rules,
  // agents, skills, settings hooks — belongs to agent-notes. agent-flows owns
  // exactly one thing in a harness's configuration: its MCP entry.
  const OWNED_BY_AGENT_NOTES = [
    ".claude/skills/agent-notes/SKILL.md",
    ".claude/agents/reviewer.md",
    ".claude/rules/safety.md",
    ".claude/settings.json",
    ".agents/skills/agent-notes/SKILL.md",
    ".codex/AGENTS.md",
    ".config/opencode/AGENTS.md",
    "CLAUDE.md",
    "AGENTS.md",
  ];

  it("changes only the OpenCode config it edits, and no harness dot-directory file", () => {
    const home = makeHome();
    for (const path of OWNED_BY_AGENT_NOTES) writeFile(join(home, path), `content of ${path}\n`);

    const before = snapshot(home);
    // The fakes only record: every file that changed was written by setup itself.
    runSetup(fakeEnv(home).env);
    const after = snapshot(home);

    assert.deepEqual(
      changedPaths(before, after),
      [join(".config", "opencode", "opencode.json")],
      "setup may write its own MCP entry and nothing else"
    );
    for (const path of OWNED_BY_AGENT_NOTES) {
      assert.equal(
        after.get(path),
        `content of ${path}\n`,
        `${path} belongs to agent-notes and must be untouched`
      );
    }
  });
});

// ── FR-031: setup --remove ────────────────────────────────────────────────────

describe("FR-031: setup --remove reverses exactly what setup wrote", () => {
  it("uses each harness's own removal command", () => {
    const home = makeHome();
    runSetup(fakeEnv(home, { emulate: true }).env);

    const removal = fakeEnv(home, { emulate: true });
    const results = runRemove(removal.env);

    assert.deepEqual(removal.calls, [
      { bin: "claude", args: ["mcp", "remove", SERVER_NAME, "--scope", "user"] },
      { bin: "codex", args: ["mcp", "remove", SERVER_NAME] },
    ]);
    assert.equal(byHarness(results, "claude-code").status, "removed");
    assert.equal(readClaudeRegistration(home), undefined);
    assert.equal(readCodexRegistration(home), undefined);
    assert.equal(readOpencodeRegistration(home), undefined);
  });

  it("leaves the whole OpenCode config directory as it found it, formatting included", () => {
    const home = makeHome();
    const original = [
      "{",
      '    "$schema": "https://opencode.ai/config.json",',
      '    "theme": "tokyonight",',
      '    "mcp": {',
      '        "some-other-server": {',
      '            "type": "local",',
      '            "command": ["other", "serve"]',
      "        }",
      "    },",
      '    "keybinds": { "leader": "ctrl+x" }',
      "}",
      "",
    ].join("\n");
    writeFile(opencodeConfigPath(home), original);
    const configDir = dirname(opencodeConfigPath(home));
    const before = snapshot(configDir);

    runSetup(fakeEnv(home, { emulate: true }).env);
    assert.notEqual(
      readFileSync(opencodeConfigPath(home), "utf8"),
      original,
      "setup must actually have edited the file, or this test proves nothing"
    );

    runRemove(fakeEnv(home, { emulate: true }).env);
    assert.equal(readFileSync(opencodeConfigPath(home), "utf8"), original);
    // The whole directory, not just the file: a leftover .bak is evidence too.
    assert.deepEqual(
      changedPaths(before, snapshot(configDir)),
      [],
      "remove must leave nothing behind in OpenCode's config directory"
    );
  });

  it("keeps the backup when the config changed after setup, and says where it is", () => {
    const home = makeHome();
    const original = JSON.stringify({ theme: "tokyonight" }, null, 2) + "\n";
    writeFile(opencodeConfigPath(home), original);
    runSetup(fakeEnv(home, { emulate: true }).env);

    // The user edits their own config while our entry sits in it: the restored
    // file will no longer match the backup, which is then the only copy left of
    // what was there before setup.
    const edited = readFileSync(opencodeConfigPath(home), "utf8").replace("tokyonight", "gruvbox");
    writeFileSync(opencodeConfigPath(home), edited);

    const result = byHarness(runRemove(fakeEnv(home, { emulate: true }).env), "opencode");
    const backup = `${opencodeConfigPath(home)}.bak`;
    assert.equal(readFileSync(backup, "utf8"), original, "the backup must survive");
    assert.ok(result.detail.includes(backup), `the line must name the backup: ${result.detail}`);
  });

  it("deletes an OpenCode config that setup itself created", () => {
    const home = makeHome();
    runSetup(fakeEnv(home, { emulate: true }).env);
    assert.ok(readOpencodeRegistration(home), "setup should have created the config");

    runRemove(fakeEnv(home, { emulate: true }).env);
    assert.throws(() => statSync(opencodeConfigPath(home)));
  });

  it("reports nothing to remove when nothing was registered", () => {
    const home = makeHome();
    const removal = fakeEnv(home);
    const results = runRemove(removal.env);

    assert.deepEqual(removal.calls, [], "no harness CLI is invoked when there is no entry");
    for (const harness of ["claude-code", "codex", "opencode"]) {
      assert.equal(byHarness(results, harness).status, "not-registered");
    }
  });

  it("refuses to declare success when the harness CLI is gone but the entry is not", () => {
    const home = makeHome();
    runSetup(fakeEnv(home, { emulate: true }).env);

    const results = runRemove(fakeEnv(home, { installed: ["codex"], emulate: true }).env);
    const claude = byHarness(results, "claude-code");
    assert.equal(claude.status, "failed");
    assert.ok(claude.detail.includes(claudeConfigPath(home)), claude.detail);
    assert.ok(readClaudeRegistration(home), "the entry is still there and must be reported");
  });
});

// ── FR-032: the reach report ──────────────────────────────────────────────────

describe("FR-032: harnessReach", () => {
  it("reports the config path and command of a live registration", () => {
    const home = makeHome();
    const launcher = join(home, "bin", "agent-flows");
    writeFile(launcher, "#!/usr/bin/env node\n");
    chmodSync(launcher, 0o755);

    const command = [launcher, "mcp"];
    runSetup(fakeEnv(home, { emulate: true, command }).env);

    const reach = harnessReach(fakeEnv(home, { command }).env);
    const claude = reach.find((r) => r.harness === "claude-code");
    assert.ok(claude);
    assert.equal(claude.registered, true);
    assert.equal(claude.stale, false);
    assert.equal(claude.configPath, claudeConfigPath(home));
    assert.deepEqual(claude.command, command);

    const codex = reach.find((r) => r.harness === "codex");
    assert.equal(codex?.configPath, codexConfigPath(home));
    assert.deepEqual(codex?.command, command);

    const opencode = reach.find((r) => r.harness === "opencode");
    assert.equal(opencode?.configPath, opencodeConfigPath(home));
    assert.deepEqual(opencode?.command, command);
  });

  it("flags a registration whose command no longer exists as stale", () => {
    const home = makeHome();
    const launcher = join(home, "bin", "agent-flows");
    writeFile(launcher, "#!/usr/bin/env node\n");
    chmodSync(launcher, 0o755);
    const command = [launcher, "mcp"];
    runSetup(fakeEnv(home, { emulate: true, command }).env);

    // The package is uninstalled without `setup --remove` first: every harness
    // now spawns a command that is not there (D10).
    rmSync(launcher);

    for (const reach of harnessReach(fakeEnv(home, { command }).env)) {
      if (!reach.registered) continue;
      assert.equal(reach.stale, true, `${reach.harness} should be stale`);
    }
  });

  it("reports an installed harness with no entry, and an absent harness", () => {
    const home = makeHome();
    const reach = harnessReach(fakeEnv(home, { installed: ["claude"] }).env);
    const claude = reach.find((r) => r.harness === "claude-code");
    assert.equal(claude?.registered, false);
    assert.equal(claude?.binaryPath, "/usr/local/bin/claude");

    const codex = reach.find((r) => r.harness === "codex");
    assert.equal(codex?.registered, false);
    assert.equal(codex?.binaryPath, undefined);
  });

  it("reports T3 Code with a note instead of a registration", () => {
    const t3 = harnessReach(fakeEnv(makeHome()).env).find((r) => r.harness === "t3-code");
    assert.ok(t3);
    assert.equal(t3.registered, false);
    assert.match(t3.note ?? "", /inherits/u);
  });
});

describe("commandResolves", () => {
  it("checks the filesystem for an absolute command and PATH for a bare one", () => {
    const home = makeHome();
    const launcher = join(home, "bin", "agent-flows");
    writeFile(launcher, "#!/usr/bin/env node\n");

    assert.equal(
      commandResolves(launcher, () => undefined),
      true
    );
    assert.equal(
      commandResolves(join(home, "bin", "gone"), () => undefined),
      false
    );
    assert.equal(
      commandResolves("agent-flows", () => "/usr/local/bin/agent-flows"),
      true
    );
    assert.equal(
      commandResolves("agent-flows", () => undefined),
      false
    );
  });
});
