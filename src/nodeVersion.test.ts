// Spec: one Node version, declared once.
//
// The mirrors matter more than the parser. "22" is written in package.json, in
// .nvmrc, in bin/agent-flows, in bootstrap.sh and in doctor's output, and five
// hand-kept copies of one number is how a project ends up running on a Node it
// says it does not support.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { parseNodeMajor, requiredNodeMajor } from "./nodeVersion.js";
import { packageRoot } from "./packageRoot.js";

const ROOT = packageRoot();

describe("parseNodeMajor — a pin, never a range", () => {
  it("reads the pinned forms this project uses", () => {
    assert.equal(parseNodeMajor("22.x"), 22);
    assert.equal(parseNodeMajor("22"), 22);
    assert.equal(parseNodeMajor("22.17.1"), 22);
  });

  it("refuses a range, which cannot answer which Node", () => {
    // ">=22" is the value this module was written to delete: it admitted Node
    // 24, which is installed here and cannot load the compiled addon.
    for (const range of [">=22", "^22.0.0", "22 || 24", ">=22 <23", ""]) {
      assert.throws(() => parseNodeMajor(range), /pin one major version/u, `accepted: ${range}`);
    }
  });
});

describe("every copy of the version agrees", () => {
  it("package.json engines.node is the source and it is a pin", () => {
    assert.equal(requiredNodeMajor(ROOT), 22);
  });

  it(".nvmrc names the same major", () => {
    const nvmrc = readFileSync(join(ROOT, ".nvmrc"), "utf8").trim();
    assert.equal(
      parseNodeMajor(nvmrc),
      requiredNodeMajor(ROOT),
      ".nvmrc and package.json engines.node must name one version"
    );
  });

  it("bin/agent-flows reads the version rather than carrying its own copy", () => {
    // The launcher runs before a build exists and under a Node that may not be
    // able to load this package, so it cannot import nodeVersion.ts — but it can
    // read the same package.json it already locates.
    const launcher = readFileSync(join(ROOT, "bin", "agent-flows"), "utf8");
    assert.ok(
      !/REQUIRED_NODE_MAJOR\s*=\s*\d+/u.test(launcher),
      "bin/agent-flows must derive the major from package.json, not hardcode it"
    );
    assert.match(launcher, /engines/u, "it must read engines.node");
  });

  it("no shell script hardcodes the major either", () => {
    for (const name of ["bootstrap.sh", "scripts/use-pinned-node.sh"]) {
      const text = readFileSync(join(ROOT, name), "utf8");
      assert.ok(
        !/\bnvm (install|use) 22\b/u.test(text),
        `${name} hardcodes the version; it must read .nvmrc`
      );
    }
  });
});
