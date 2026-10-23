// Spec 048: one Node requirement, declared once — a major pin with a security floor.
//
// The mirrors matter more than the parser. The version is written in package.json,
// in .nvmrc, in bin/agent-flows, in bootstrap.sh and in doctor's output, and
// hand-kept copies of one number is how a project ends up running on a Node it
// says it does not support.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  nodeInstallRemedy,
  nodeRequirement,
  nodeSatisfies,
  parseNodePin,
  requiredNodePin,
} from "./nodeVersion.js";
import { packageRoot } from "./packageRoot.js";

const ROOT = packageRoot();

describe("parseNodePin — one major with a security floor", () => {
  it("reads the single accepted form", () => {
    assert.deepEqual(parseNodePin("^24.22.1"), {
      major: 24,
      minor: 22,
      patch: 1,
      floor: "24.22.1",
    });
  });

  it("refuses every other form, with the one error text", () => {
    // "22.x" is the value this change deletes: it admitted a vulnerable 22.x.
    // ">=22" is older: it admitted every newer major, which cannot load the compiled addon.
    for (const range of [
      "22.x",
      "22",
      "^22",
      "22.17.1",
      ">=22",
      ">=22.23.4 <23",
      "^22.23.4 || ^24.22.1",
      "",
      "^022.23.4",
      "^22.023.4",
      "^22.23.04",
    ]) {
      assert.throws(
        () => parseNodePin(range),
        (error: Error) =>
          error.message ===
          `engines.node must be "^MAJOR.MINOR.PATCH" — one major with a security floor inside it (e.g. "^24.22.1") — got "${range}"`,
        `accepted or mis-worded: "${range}"`
      );
    }
  });
});

describe("nodeSatisfies — same major, at or above the floor", () => {
  const pin = parseNodePin("^24.22.1");
  const table: [string, boolean][] = [
    ["24.22.1", true],
    ["24.22.2", true],
    ["24.23.0", true],
    ["v24.22.1", true],
    ["24.22.10", true],
    ["24.100.0", true],
    ["24.22.1-rc.1", false],
    ["24.22.1-nightly20261022abcdef", false],
    ["24.22.1.1", false],
    ["24.22", false],
    ["24.22.0", false],
    ["24.14.0", false],
    ["22.23.4", false],
    ["26.12.1", false],
    ["26.99.0", false],
    ["23.9.0", false],
  ];
  for (const [version, expected] of table) {
    it(`${version} -> ${String(expected)}`, () => {
      assert.equal(nodeSatisfies(version, pin), expected);
    });
  }

  it("compares numerically, not as text", () => {
    assert.equal(nodeSatisfies("24.100.0", pin), true);
    assert.equal(nodeSatisfies("24.22.10", pin), true);
    assert.equal(nodeSatisfies("24.9.99", pin), false);
  });

  it("refuses garbage rather than guessing", () => {
    for (const version of ["", "24", "twenty-four", "24.x.1"]) {
      assert.equal(nodeSatisfies(version, pin), false, `accepted: "${version}"`);
    }
  });
});

describe("messages derive from the pin", () => {
  const pin = parseNodePin("^24.22.1");
  it("name the major and the floor", () => {
    assert.equal(nodeRequirement(pin), "Node 24 at or above 24.22.1");
    assert.equal(nodeInstallRemedy(pin), "nvm install 24");
  });
  it("follow a different pin, so no literal is baked in", () => {
    const other = parseNodePin("^30.1.2");
    assert.equal(nodeRequirement(other), "Node 30 at or above 30.1.2");
    assert.equal(nodeInstallRemedy(other), "nvm install 30");
  });
});

describe("every copy of the version agrees", () => {
  it("package.json engines.node is the source: a pin with a floor of at least 24.22.1", () => {
    const pin = requiredNodePin(ROOT);
    assert.equal(pin.major, 24);
    assert.ok(
      nodeSatisfies(pin.floor, parseNodePin("^24.22.1")),
      `floor ${pin.floor} is below the 24.22.1 floor of spec 050`
    );
  });

  it(".nvmrc is the floor exactly, so `nvm use` cannot land on a vulnerable release of the major", () => {
    const nvmrc = readFileSync(join(ROOT, ".nvmrc"), "utf8").trim();
    assert.equal(nvmrc, requiredNodePin(ROOT).floor);
  });

  it("bin/agent-flows reads the version rather than carrying its own copy", () => {
    // The launcher runs before a build exists and under a Node that may not be
    // able to load this package, so it cannot import nodeVersion.ts — but it can
    // read the same package.json it already locates.
    const launcher = readFileSync(join(ROOT, "bin", "agent-flows"), "utf8");
    assert.match(launcher, /engines/u, "it must read engines.node");
  });

  it("no code message hardcodes the major or the floor", () => {
    const pin = requiredNodePin(ROOT);
    const hardcoded = new RegExp(
      `\\bnvm (install|use) ${String(pin.major)}\\b|Node ${String(pin.major)}\\b|${pin.floor.replace(/\./gu, "\\.")}`,
      "u"
    );
    for (const name of ["bin/agent-flows", "bootstrap.sh", "scripts/use-pinned-node.sh"]) {
      const code = readFileSync(join(ROOT, name), "utf8")
        .split("\n")
        // Comments, and the parse error's own example, which is fixed text by design.
        .filter(
          (line) => !/^\s*(#|\/\/|\*|\/\*)/u.test(line) && !line.includes("MAJOR.MINOR.PATCH")
        )
        .join("\n");
      assert.ok(!hardcoded.test(code), `${name} hardcodes the version; it must derive it`);
    }
  });
});
