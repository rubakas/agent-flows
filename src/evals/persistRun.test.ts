import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { persistRun } from "./persistRun.js";

function freshDir(): string {
  return join(mkdtempSync(join(tmpdir(), "agent-flows-persist-")), "run");
}

describe("persistRun", () => {
  it("writes error.json when the run produced nothing at all", () => {
    const dir = freshDir();
    persistRun(dir, undefined, new Error("provider refused the request"));

    assert.deepEqual(readdirSync(dir), ["error.json"]);
    const written = JSON.parse(readFileSync(join(dir, "error.json"), "utf8")) as {
      name: string;
      message: string;
      stack?: string;
    };
    assert.equal(written.message, "provider refused the request");
    assert.equal(written.name, "Error");
    assert.ok(
      written.stack !== undefined && written.stack.length > 0,
      "a run that threw is the case that most needs its stack recorded"
    );
  });

  it("records a failure message that is not an Error object", () => {
    const dir = freshDir();
    persistRun(dir, {}, 'Step "verify" failed: schema validation error');

    const written = JSON.parse(readFileSync(join(dir, "error.json"), "utf8")) as {
      message: string;
    };
    assert.equal(written.message, 'Step "verify" failed: schema validation error');
  });

  it("keeps the partial outputs of a failed run alongside the error", () => {
    const dir = freshDir();
    persistRun(
      dir,
      { correctness: "prose findings", verify: { codeReviewFindings: [] } },
      "verify never ran"
    );

    assert.deepEqual(readdirSync(dir).sort(), ["correctness.md", "error.json", "verify.json"]);
    assert.equal(
      readFileSync(join(dir, "correctness.md"), "utf8"),
      "prose findings",
      "the steps that did finish are the only evidence of where the run stopped"
    );
  });

  it("writes strings as .md and everything else as pretty JSON, with no error file", () => {
    const dir = freshDir();
    persistRun(dir, { survey: "text", verify: { codeReviewFindings: [{ claim: "x" }] } });

    assert.deepEqual(readdirSync(dir).sort(), ["survey.md", "verify.json"]);
    const verify = readFileSync(join(dir, "verify.json"), "utf8");
    assert.match(verify, /\n {2}"codeReviewFindings"/, "pretty-printed, so a human can read it");
    assert.ok(verify.endsWith("\n"));
  });
});
