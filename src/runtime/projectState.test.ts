// Tests for spec 032 FR-001/FR-002/FR-003/FR-009: project key, state dir, and
// the one-time non-destructive copy of a legacy runs/ directory (V1, V4).
//
// AGENT_FLOWS_HOME is always pinned to a mkdtemp directory, so the owner's real
// ~/.agent-flows is never read or written by these tests.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  ensureProjectState,
  projectKey,
  resolveProjectState,
  stateRoot,
  type ProjectState,
} from "./projectState.js";

// ── Temp directory lifecycle ──────────────────────────────────────────────────

const dirsToClean: string[] = [];

function makeTmpDir(prefix = "af-state-test-"): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirsToClean.push(dir);
  return dir;
}

after(() => {
  for (const dir of dirsToClean) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

/** Content hash of a directory tree: relative path + bytes of every file. */
function hashTree(dir: string, prefix = ""): string {
  const hash = createHash("sha256");
  const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name)
  );
  for (const e of entries) {
    const rel = prefix === "" ? e.name : `${prefix}/${e.name}`;
    hash.update(rel);
    if (e.isDirectory()) {
      hash.update(hashTree(join(dir, e.name), rel));
    } else {
      hash.update(readFileSync(join(dir, e.name)));
    }
  }
  return hash.digest("hex");
}

/** Seed a legacy <projectDir>/.agent-flows/runs tree with two run directories. */
function seedLegacyRuns(projectDir: string): string {
  const legacy = join(projectDir, ".agent-flows", "runs");
  mkdirSync(join(legacy, "run-a"), { recursive: true });
  mkdirSync(join(legacy, "run-b"), { recursive: true });
  writeFileSync(join(legacy, "run-a", "investigate.json"), '{"status":"succeeded"}\n', "utf8");
  writeFileSync(join(legacy, "run-a", "manifest.json"), '{"runId":"run-a"}\n', "utf8");
  writeFileSync(join(legacy, "run-b", "build.json"), '{"status":"failed"}\n', "utf8");
  return legacy;
}

// ── V1: key derivation ────────────────────────────────────────────────────────

describe("FR-001: project key derivation", () => {
  it("escapes every character outside [A-Za-z0-9_-] to a dash", () => {
    const dir = makeTmpDir();
    const key = projectKey(dir, {});
    assert.equal(key, realpathSync(dir).replace(/[^A-Za-z0-9_-]/gu, "-"));
    assert.ok(/^[A-Za-z0-9_-]+$/u.test(key), `key must contain only safe characters: ${key}`);
  });

  it("keeps underscores, digits and dashes intact", () => {
    const parent = makeTmpDir();
    const dir = join(parent, "My_Project-9");
    mkdirSync(dir, { recursive: true });
    const key = projectKey(dir, {});
    assert.ok(key.endsWith("My_Project-9"), `key must preserve safe characters: ${key}`);
  });

  it("truncates to 200 characters plus an 8-char sha256 of the unescaped realpath (209 total)", () => {
    const parent = makeTmpDir();
    // Nest directories until the absolute path is comfortably over 200 chars.
    let deep = parent;
    while (deep.length <= 240) {
      deep = join(deep, "abcdefghijklmnopqrstuvwxyz0123456789");
      mkdirSync(deep, { recursive: true });
    }
    const real = realpathSync(deep);
    const escaped = real.replace(/[^A-Za-z0-9_-]/gu, "-");
    const expectedHash = createHash("sha256").update(real).digest("hex").slice(0, 8);

    const key = projectKey(deep, {});
    assert.equal(key.length, 209, `truncated key must be exactly 209 chars; got ${key.length}`);
    assert.equal(key, `${escaped.slice(0, 200)}-${expectedHash}`);
  });

  it("AGENT_FLOWS_PROJECT_KEY overrides the derivation entirely", () => {
    const dir = makeTmpDir();
    assert.equal(projectKey(dir, { AGENT_FLOWS_PROJECT_KEY: "pinned-key" }), "pinned-key");
  });

  it("falls back to a lexical resolve when the directory does not exist", () => {
    const missing = join(makeTmpDir(), "not", "there");
    const key = projectKey(missing, {});
    assert.equal(key, missing.replace(/[^A-Za-z0-9_-]/gu, "-"));
  });
});

// ── V1: state root and resolution ─────────────────────────────────────────────

describe("FR-002: state dir resolution", () => {
  it("AGENT_FLOWS_HOME wins over the home directory default", () => {
    const home = makeTmpDir();
    assert.equal(stateRoot({ AGENT_FLOWS_HOME: home }), home);
  });

  it("defaults to ~/.agent-flows when AGENT_FLOWS_HOME is absent", () => {
    assert.ok(stateRoot({}).endsWith(join(".agent-flows")), stateRoot({}));
  });

  it("resolves every machine-local path under <root>/projects/<key>", () => {
    const home = makeTmpDir();
    const projectDir = makeTmpDir();
    const state = resolveProjectState(projectDir, {
      AGENT_FLOWS_HOME: home,
      AGENT_FLOWS_PROJECT_KEY: "k",
    });
    assert.equal(state.key, "k");
    assert.equal(state.dir, join(home, "projects", "k"));
    assert.equal(state.runsDir, join(home, "projects", "k", "runs"));
    assert.equal(state.dbPath, join(home, "projects", "k", "agent-flows.sqlite"));
    assert.equal(state.mastraDbPath, join(home, "projects", "k", "agent-flows-mastra.db"));
    assert.equal(state.n8nMapPath, join(home, "projects", "k", "n8n.json"));
    assert.equal(state.projectJsonPath, join(home, "projects", "k", "project.json"));
  });

  it("resolution creates nothing on disk", () => {
    const home = makeTmpDir();
    const projectDir = makeTmpDir();
    resolveProjectState(projectDir, { AGENT_FLOWS_HOME: home });
    assert.deepEqual(readdirSync(home), [], "resolveProjectState must not create directories");
  });
});

// ── V1: project.json marker ───────────────────────────────────────────────────

describe("FR-003: project.json is written once and never overwritten", () => {
  it("records projectDir, key and schemaVersion on first resolution", () => {
    const home = makeTmpDir();
    const projectDir = makeTmpDir();
    const state = ensureProjectState(projectDir, { AGENT_FLOWS_HOME: home }, () => undefined);

    const marker = JSON.parse(readFileSync(state.projectJsonPath, "utf8")) as Record<
      string,
      unknown
    >;
    assert.equal(marker.projectDir, realpathSync(projectDir));
    assert.equal(marker.key, state.key);
    assert.equal(marker.schemaVersion, 1);
    assert.equal(typeof marker.createdAt, "string");
  });

  it("a second call leaves the file byte-identical", () => {
    const home = makeTmpDir();
    const projectDir = makeTmpDir();
    const state = ensureProjectState(projectDir, { AGENT_FLOWS_HOME: home }, () => undefined);
    const first = readFileSync(state.projectJsonPath, "utf8");

    ensureProjectState(projectDir, { AGENT_FLOWS_HOME: home }, () => undefined);
    assert.equal(readFileSync(state.projectJsonPath, "utf8"), first);
  });
});

// ── V4: legacy runs migration ─────────────────────────────────────────────────

describe("FR-009: legacy runs/ is copied once, non-destructively", () => {
  it("copies a legacy runs dir into the state dir and logs one notice", () => {
    const home = makeTmpDir();
    const projectDir = makeTmpDir();
    const legacy = seedLegacyRuns(projectDir);
    const legacyHash = hashTree(legacy);

    const notices: string[] = [];
    const state = ensureProjectState(projectDir, { AGENT_FLOWS_HOME: home }, (m) =>
      notices.push(m)
    );

    assert.equal(hashTree(state.runsDir), legacyHash, "the copy must be byte-identical");
    assert.equal(hashTree(legacy), legacyHash, "the legacy dir must be untouched");
    assert.equal(notices.length, 1, `exactly one notice expected; got ${notices.length}`);
    assert.ok(notices[0].includes(legacy) && notices[0].includes(state.runsDir));
    assert.ok(!existsSync(join(state.dir, "runs.partial")), "no partial dir may survive");
  });

  it("redoes an interrupted copy, discarding the stale runs.partial", () => {
    const home = makeTmpDir();
    const projectDir = makeTmpDir();
    const legacy = seedLegacyRuns(projectDir);
    const legacyHash = hashTree(legacy);

    // Simulate a copy that died halfway: runs.partial present, runs absent.
    const state = resolveProjectState(projectDir, { AGENT_FLOWS_HOME: home });
    mkdirSync(join(state.dir, "runs.partial"), { recursive: true });
    writeFileSync(join(state.dir, "runs.partial", "stray.json"), "{}", "utf8");

    ensureProjectState(projectDir, { AGENT_FLOWS_HOME: home }, () => undefined);

    assert.ok(!existsSync(join(state.dir, "runs.partial")), "the stale partial must be gone");
    assert.ok(
      !existsSync(join(state.runsDir, "stray.json")),
      "the interrupted copy's content must not be kept"
    );
    assert.equal(hashTree(state.runsDir), legacyHash, "the redone copy must be complete");
    assert.equal(hashTree(legacy), legacyHash, "the legacy dir must be untouched");
  });

  it("performs no copy when the state dir already has runs/", () => {
    const home = makeTmpDir();
    const projectDir = makeTmpDir();
    const legacy = seedLegacyRuns(projectDir);
    const legacyHash = hashTree(legacy);

    const state: ProjectState = ensureProjectState(
      projectDir,
      { AGENT_FLOWS_HOME: home },
      () => undefined
    );
    // A run written after the migration must survive a second start.
    mkdirSync(join(state.runsDir, "run-new"), { recursive: true });
    writeFileSync(join(state.runsDir, "run-new", "later.json"), '{"later":true}\n', "utf8");
    const afterFirst = hashTree(state.runsDir);

    const notices: string[] = [];
    ensureProjectState(projectDir, { AGENT_FLOWS_HOME: home }, (m) => notices.push(m));

    assert.equal(hashTree(state.runsDir), afterFirst, "a second start must not copy again");
    assert.equal(notices.length, 0, "a second start must print no migration notice");
    assert.equal(hashTree(legacy), legacyHash, "the legacy dir must be untouched");
  });

  it("does nothing when there is no legacy runs dir", () => {
    const home = makeTmpDir();
    const projectDir = makeTmpDir();
    const notices: string[] = [];
    const state = ensureProjectState(projectDir, { AGENT_FLOWS_HOME: home }, (m) =>
      notices.push(m)
    );
    assert.ok(!existsSync(state.runsDir), "no runs dir may be created without a legacy one");
    assert.equal(notices.length, 0);
  });
});
