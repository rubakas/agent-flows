// Spec 048 FR-4: scripts/use-pinned-node.sh refuses a Node below the security floor.
//
// Hermetic by construction. The script is run in a child shell whose PATH holds
// only a temp directory with a fake `node` (plus the system directories), and
// whose NVM_DIR holds a fake nvm.sh. The child environment is built explicitly:
// scripts/test.sh puts a good Node on the PATH it runs us under, and inheriting
// that would rescue exactly the cases these tests exist to refuse.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { requiredNodePin } from "./nodeVersion.js";
import { packageRoot } from "./packageRoot.js";

const ROOT = packageRoot();
const PIN = requiredNodePin(ROOT);
const SCRIPT = join(ROOT, "scripts", "use-pinned-node.sh");
const BELOW_FLOOR = `${String(PIN.major)}.${String(PIN.minor)}.${String(PIN.patch - 1)}`;
const NEWER_PATCH = `${String(PIN.major)}.${String(PIN.minor)}.${String(PIN.patch + 1)}`;
const NEWER_MINOR = `${String(PIN.major)}.${String(PIN.minor + 1)}.0`;
const OTHER_MAJOR = `${String(PIN.major + 2)}.0.0`;

interface Sandbox {
  dir: string;
  initialBin: string;
  nvmBin: string;
  nvmDir: string;
  calls: string;
}

function makeSandbox(nvmrc: string = PIN.floor): Sandbox {
  assert.ok(PIN.patch > 0, "the pin's patch must be above 0 to derive a below-floor version");
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "af-shell-")));
  mkdirSync(join(dir, "nvm"));
  writeFileSync(join(dir, ".nvmrc"), `${nvmrc}\n`);
  return {
    dir,
    initialBin: join(dir, "initial"),
    nvmBin: join(dir, "offered"),
    nvmDir: join(dir, "nvm"),
    calls: join(dir, "nvm-calls"),
  };
}

/** A `node` that answers the two questions the scripts ask, and nothing else. */
function fakeNode(binDir: string, version: string): void {
  mkdirSync(binDir, { recursive: true });
  const path = join(binDir, "node");
  writeFileSync(
    path,
    [
      "#!/bin/sh",
      'case "$1" in',
      `  -p) echo '${version}' ;;`,
      `  -v|--version) echo 'v${version}' ;;`,
      "  *) exit 2 ;;",
      "esac",
      "",
    ].join("\n")
  );
  chmodSync(path, 0o755);
}

/**
 * A fake nvm.sh. `nvm use <major>` records the call and, when a node is on offer,
 * puts it first on PATH -- which is all the real one does that matters here.
 */
function fakeNvm(sandbox: Sandbox, offersNode: boolean): void {
  writeFileSync(
    join(sandbox.nvmDir, "nvm.sh"),
    [
      "nvm() {",
      `  echo "$*" >> '${sandbox.calls}'`,
      `  if [ "$1" = use ] && ${offersNode ? "true" : "false"}; then`,
      `    PATH='${sandbox.nvmBin}':"$PATH"`,
      "  fi",
      "}",
      "",
    ].join("\n")
  );
}

function source(sandbox: Sandbox): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("/bin/bash", ["-c", `. '${SCRIPT}' && echo OK`], {
    cwd: sandbox.dir,
    env: {
      PATH: `${sandbox.initialBin}:/usr/bin:/bin`,
      NVM_DIR: sandbox.nvmDir,
      HOME: sandbox.dir,
    },
    encoding: "utf8",
    timeout: 30_000,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function nvmCalls(sandbox: Sandbox): string[] {
  return existsSync(sandbox.calls) ? readFileSync(sandbox.calls, "utf8").trim().split("\n") : [];
}

function inSandbox(body: (sandbox: Sandbox) => void, nvmrc?: string): void {
  const sandbox = makeSandbox(nvmrc);
  try {
    body(sandbox);
  } finally {
    rmSync(sandbox.dir, { recursive: true, force: true });
  }
}

describe("scripts/use-pinned-node.sh", () => {
  for (const [label, version] of [
    ["exactly the floor", PIN.floor],
    ["a newer patch", NEWER_PATCH],
    ["a newer minor", NEWER_MINOR],
  ] as const) {
    it(`accepts ${label} (${version}) without touching nvm`, () => {
      inSandbox((sandbox) => {
        fakeNode(sandbox.initialBin, version);
        fakeNvm(sandbox, false);
        const result = source(sandbox);
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stdout.trim(), "OK");
        assert.deepEqual(nvmCalls(sandbox), [], "nvm was called although the node was fine");
      });
    });
  }

  for (const [label, version] of [
    ["a pre-release of the floor", `${PIN.floor}-rc.1`],
    ["a nightly build", `${PIN.floor}-nightly20261022abcdef`],
    ["a version with no patch", `${String(PIN.major)}.${String(PIN.minor + 1)}`],
    ["a version with a fourth part", `${PIN.floor}.1`],
  ] as const) {
    it(`refuses ${label} (${version})`, () => {
      inSandbox((sandbox) => {
        fakeNode(sandbox.initialBin, version);
        fakeNvm(sandbox, false);
        const result = source(sandbox);
        assert.equal(result.status, 1, `expected exit 1:\n${result.stderr}`);
        assert.ok(!result.stdout.includes("OK"));
      });
    });
  }

  it("below the floor, switches with `nvm use <major>` and accepts a satisfying node", () => {
    inSandbox((sandbox) => {
      fakeNode(sandbox.initialBin, BELOW_FLOOR);
      fakeNode(sandbox.nvmBin, NEWER_PATCH);
      fakeNvm(sandbox, true);
      const result = source(sandbox);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout.trim(), "OK");
      assert.deepEqual(nvmCalls(sandbox), [`use ${String(PIN.major)}`]);
    });
  });

  it("below the floor with nvm offering only a below-floor node: refuses, naming the floor and the remedy", () => {
    inSandbox((sandbox) => {
      fakeNode(sandbox.initialBin, BELOW_FLOOR);
      fakeNode(sandbox.nvmBin, BELOW_FLOOR);
      fakeNvm(sandbox, true);
      const result = source(sandbox);
      assert.equal(result.status, 1, `expected exit 1:\n${result.stderr}`);
      assert.ok(!result.stdout.includes("OK"), "the script went on after refusing");
      assert.ok(result.stderr.includes(PIN.floor), `must name the floor:\n${result.stderr}`);
      assert.ok(
        result.stderr.includes(`nvm install ${String(PIN.major)}`),
        `must say how to fix it:\n${result.stderr}`
      );
      assert.ok(result.stderr.includes(BELOW_FLOOR), `must name what it found:\n${result.stderr}`);
    });
  });

  it("below the floor with no nvm at all: refuses", () => {
    inSandbox((sandbox) => {
      fakeNode(sandbox.initialBin, BELOW_FLOOR);
      const result = source(sandbox);
      assert.equal(result.status, 1, result.stderr);
      assert.ok(result.stderr.includes(PIN.floor), result.stderr);
    });
  });

  it("another major is refused even though it is newer", () => {
    inSandbox((sandbox) => {
      fakeNode(sandbox.initialBin, OTHER_MAJOR);
      fakeNvm(sandbox, false);
      const result = source(sandbox);
      assert.equal(result.status, 1, `expected exit 1:\n${result.stderr}`);
      assert.ok(result.stderr.includes(OTHER_MAJOR), result.stderr);
      assert.ok(result.stderr.includes(`nvm install ${String(PIN.major)}`), result.stderr);
    });
  });

  it("another major is switched away from when nvm offers a satisfying node", () => {
    inSandbox((sandbox) => {
      fakeNode(sandbox.initialBin, OTHER_MAJOR);
      fakeNode(sandbox.nvmBin, PIN.floor);
      fakeNvm(sandbox, true);
      const result = source(sandbox);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(nvmCalls(sandbox), [`use ${String(PIN.major)}`]);
    });
  });

  it("compares numerically: a minor of two digits is not below a minor of one", () => {
    inSandbox((sandbox) => {
      // 22.100.0 is above 22.23.4; as text it would sort below it.
      fakeNode(sandbox.initialBin, `${String(PIN.major)}.${String(PIN.minor + 77)}.0`);
      fakeNvm(sandbox, false);
      const result = source(sandbox);
      assert.equal(result.status, 0, result.stderr);
    });
  });
});

describe("scripts/use-pinned-node.sh: the .nvmrc it reads", () => {
  // A legacy bare major ("22") used to read as a floor of 22.22.22 and pass.
  for (const nvmrc of ["22", "22.23", "lts/*", "garbage", "22.23.4.1", "22.x.4", "22..4"]) {
    it(`refuses ${JSON.stringify(nvmrc)} and names .nvmrc`, () => {
      inSandbox((sandbox) => {
        fakeNode(sandbox.initialBin, PIN.floor);
        fakeNvm(sandbox, false);
        const result = source(sandbox);
        assert.equal(result.status, 1, `expected exit 1:\n${result.stdout}${result.stderr}`);
        assert.ok(!result.stdout.includes("OK"));
        assert.ok(result.stderr.includes(".nvmrc"), result.stderr);
        assert.deepEqual(nvmCalls(sandbox), [], "it went on to nvm with an invalid floor");
      }, nvmrc);
    });
  }

  it("accepts a leading v", () => {
    inSandbox((sandbox) => {
      fakeNode(sandbox.initialBin, PIN.floor);
      const result = source(sandbox);
      assert.equal(result.status, 0, result.stderr);
    }, `v${PIN.floor}`);
  });

  it("leaves none of its working variables or helpers in the sourcing shell", () => {
    inSandbox((sandbox) => {
      fakeNode(sandbox.initialBin, PIN.floor);
      const result = spawnSync(
        "/bin/bash",
        ["-c", `. '${SCRIPT}' && { set | grep -E '^_[A-Za-z_]+=|^_node_' ; echo DONE; }`],
        {
          cwd: sandbox.dir,
          env: {
            PATH: `${sandbox.initialBin}:/usr/bin:/bin`,
            NVM_DIR: sandbox.nvmDir,
            HOME: sandbox.dir,
          },
          encoding: "utf8",
        }
      );
      assert.equal(result.stdout.trim(), "DONE", `left behind:\n${result.stdout}`);
    });
  });
});

describe("bootstrap.sh shares the one shell implementation", () => {
  const bootstrap = join(ROOT, "bootstrap.sh");

  it("sources use-pinned-node.sh instead of carrying its own major check", () => {
    const text = readFileSync(bootstrap, "utf8");
    assert.match(text, /use-pinned-node\.sh/u);
    assert.ok(!text.includes("_node_major"), "bootstrap.sh still carries its own version parser");
    assert.ok(!/-lt\s+\d+/u.test(text), "bootstrap.sh still gates on a hardcoded major");
  });

  for (const [label, version] of [
    ["below the floor", BELOW_FLOOR],
    ["another major", OTHER_MAJOR],
  ] as const) {
    it(`refuses ${label} (${version}) before doing anything`, () => {
      inSandbox((sandbox) => {
        fakeNode(sandbox.initialBin, version);
        fakeNvm(sandbox, false);
        const result = spawnSync("/bin/bash", [bootstrap, "--dry-run"], {
          cwd: sandbox.dir,
          env: {
            PATH: `${sandbox.initialBin}:/usr/bin:/bin`,
            NVM_DIR: sandbox.nvmDir,
            HOME: sandbox.dir,
          },
          encoding: "utf8",
          timeout: 30_000,
        });
        assert.equal(result.status, 1, `expected exit 1:\n${result.stdout}${result.stderr}`);
        assert.ok(result.stderr.includes(PIN.floor), result.stderr);
        assert.ok(result.stderr.includes(`nvm install ${String(PIN.major)}`), result.stderr);
      });
    });
  }
});
