// Spec 042 D14 — the one line that tells two runs of the same workflow apart.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { runSubject, SUBJECT_MAX } from "./runSubject.js";

describe("runSubject — what a run was started against", () => {
  it("takes the heading of a code-review plan, without its markdown", () => {
    const subject = runSubject({
      inputs: {
        plan: "# Code change under review — PR #1366, branch `fix/1316_documents`\n\nRails 8 app.",
        baseline: "369f1e50 — the merge-base with develop",
        introducedCommits: "3 commits",
      },
    });
    assert.equal(subject, "Code change under review — PR #1366, branch fix/1316_documents");
  });

  it("prefers the substantive input over short refs, whatever their order", () => {
    const reversed = runSubject({
      inputs: {
        introducedCommits: "abc1234 fix: something",
        baseline: "deadbeef",
        plan: "Rename the deal document folder column",
      },
    });
    assert.equal(reversed, "Rename the deal document folder column");
  });

  it("skips blank leading lines rather than returning an empty subject", () => {
    assert.equal(
      runSubject({ inputs: { request: "\n\n   \nAdd a contacts panel" } }),
      "Add a contacts panel"
    );
  });

  it("truncates a long first line and marks it", () => {
    const long = "x".repeat(400);
    const subject = runSubject({ inputs: { plan: long } });
    assert.equal(subject?.length, SUBJECT_MAX);
    assert.ok(subject?.endsWith("…"), `a cut subject must say so: ${subject}`);
  });

  it("returns nothing when there is nothing to name", () => {
    assert.equal(runSubject(undefined), undefined);
    assert.equal(runSubject({}), undefined);
    assert.equal(runSubject({ inputs: {} }), undefined);
    assert.equal(runSubject({ inputs: { n: 7, ok: true } }), undefined);
    assert.equal(runSubject({ inputs: { plan: "   \n  " } }), undefined);
  });
});
