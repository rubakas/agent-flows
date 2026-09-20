/**
 * Fixture: the verifier's severity discipline, graded in isolation.
 *
 * WHAT THIS FIXTURE COVERS
 * ────────────────────────
 * One behaviour only: a finding that arrives `major` must not leave `minor` with
 * nothing accounting for the drop (spec 040 D11, FR-016). Two benchmark runs
 * proved prose cannot hold this — the `falsifiability` worker proposed `major`
 * for the same finding in both, `verify` wrote `minor` in both, and the second
 * run's added "severity is argued, never assigned in silence" paragraph moved
 * nothing. The schema now requires `severityRationale` on every finding, and this
 * fixture is what can fail when that field goes back to being decorative.
 *
 * WHY IT SEEDS THE WORKER SIDE
 * ────────────────────────────
 * The graded event is a DOWNGRADE, which needs a known starting severity. A live
 * `falsifiability` worker cannot be compelled to raise a given finding at a given
 * severity, so a fixture that ran the whole pipeline would measure "did a worker
 * happen to say major today" far more often than it measured the verifier. The
 * worker output is therefore written by hand and only `verify` runs — the one
 * step whose behaviour is under test, with its real prompt, its real schema and
 * real read access to this repository.
 *
 * WHY THE FINDING IS REAL
 * ───────────────────────
 * The seeded finding is not a plant the verifier is meant to swallow: apply its
 * own neutering edit — set `MAX_PERSISTED_CHARS` to 1 — and the added test still
 * passes, because it builds its expected value out of the constant it is meant to
 * pin. That is shape 1 of the four unfalsifiable-spec shapes in spec 040 D3. A
 * verifier that CONFIRMS it and one that narrows it to PARTIAL are both doing
 * their job; the verdict is deliberately not graded here. Only the severity is.
 *
 * WHAT IT DOES NOT COVER
 * ──────────────────────
 * Verdict accuracy, citation accuracy, decline authority and the blocking count —
 * `code-review-citations` grades those, end to end, over the whole pipeline. It
 * also does not grade whether a stated reason is a GOOD reason: no offline scorer
 * can judge that, and a scorer that pretended to would be unfalsifiable in the
 * other direction. Keeping the severity passes; lowering it with a reason that
 * names what was moved from passes; the unaccounted drop is the only failure.
 *
 * ANSWER-KEY DISCIPLINE
 * ─────────────────────
 * The seeded worker output states the neutering edit and the severity it
 * proposes, because a worker really does state both. It does not state what the
 * verifier should do with them — no "this must stay major", no naming of the
 * field the verifier has to fill. A fixture that told the verifier the answer
 * would grade instruction-following, not severity discipline.
 */

import type { SeverityExpectation } from "../scorers.js";

/** Free-form worker text seeded into `verify` in place of a live worker run. */
export interface SeededWorkerOutputs {
  correctness: string;
  security: string;
  falsifiability: string;
}

export interface CodeReviewSeverityFixture {
  /** Diff passed as `plan` input to the verify step. */
  diff: string;
  /** What existed before the change; passed as the `baseline` input. */
  baseline: string;
  /** Hand-written worker output; replaces the upstream steps entirely. */
  workerOutputs: SeededWorkerOutputs;
  /** Severity outcomes the verifier must reach, one per seeded finding. */
  expectations: SeverityExpectation[];
  /** Repo paths that must exist on disk (anti-rot): the finding cites them. */
  expectedPaths: string[];
}

const DIFF = `\
diff --git a/src/evals/persistRun.ts b/src/evals/persistRun.ts
--- a/src/evals/persistRun.ts
+++ b/src/evals/persistRun.ts
@@ -10,6 +10,12 @@
 import { mkdirSync, writeFileSync } from "node:fs";
 import { join } from "node:path";

+/**
+ * Step outputs longer than this are truncated before they are written, so one
+ * runaway step cannot fill the operator's disk.
+ */
+export const MAX_PERSISTED_CHARS = 200_000;
+
 /** What is recorded about a run that threw or did not reach success. */
 export interface PersistedError {
   name: string;
@@ -43,7 +49,7 @@ export function persistRun(
   for (const [stepId, value] of Object.entries(result ?? {})) {
     if (typeof value === "string") {
-      writeFileSync(join(runDir, \`\${stepId}.md\`), value);
+      writeFileSync(join(runDir, \`\${stepId}.md\`), value.slice(0, MAX_PERSISTED_CHARS));
     } else {
       writeFileSync(join(runDir, \`\${stepId}.json\`), \`\${JSON.stringify(value, null, 2)}\\n\`);
     }
diff --git a/src/evals/persistRun.test.ts b/src/evals/persistRun.test.ts
--- a/src/evals/persistRun.test.ts
+++ b/src/evals/persistRun.test.ts
@@ -3,7 +3,7 @@
 import { tmpdir } from "node:os";
 import { join } from "node:path";
 import { describe, it } from "node:test";
-import { persistRun } from "./persistRun.js";
+import { MAX_PERSISTED_CHARS, persistRun } from "./persistRun.js";

 function freshDir(): string {
   return join(mkdtempSync(join(tmpdir(), "agent-flows-persist-")), "run");
@@ -63,4 +63,12 @@ describe("persistRun", () => {
     assert.match(verify, /\\n {2}"codeReviewFindings"/, "pretty-printed, so a human can read it");
     assert.ok(verify.endsWith("\\n"));
   });
+
+  it("truncates an oversized step output at the ceiling", () => {
+    const dir = freshDir();
+    persistRun(dir, { survey: "x".repeat(MAX_PERSISTED_CHARS + 500) });
+
+    const written = readFileSync(join(dir, "survey.md"), "utf8");
+    assert.equal(written.length, MAX_PERSISTED_CHARS);
+  });
 });
`;

const BASELINE = `\
Baseline: the tip of this branch before the change. src/evals/persistRun.ts exported persistRun and
PersistedError and nothing else; it wrote every string step output whole, with no ceiling of any kind,
and MAX_PERSISTED_CHARS did not exist. src/evals/persistRun.test.ts held four cases and imported only
persistRun. Both files are in this repository and can be read as they stand today; every line the diff
marks with a leading space is present there unchanged.

persistRun is called from src/evals/run.ts on three paths — the throw path, the did-not-succeed path
and the success path — and from nowhere else in production code.`;

const FALSIFIABILITY = `\
**Location** — src/evals/persistRun.test.ts, the added "truncates an oversized step output at the
ceiling" case in the @@ -63,4 +63,12 @@ hunk.

**Issue** — The only test covering the new truncation ceiling cannot fail if the ceiling is wrong. It
imports MAX_PERSISTED_CHARS and then uses it to build both sides of the comparison: the input is
\`"x".repeat(MAX_PERSISTED_CHARS + 500)\` and the expectation is \`written.length === MAX_PERSISTED_CHARS\`.
The expected value is the implementation's own value, so the assertion restates \`slice\` rather than
pinning the boundary the constant is supposed to express.

**Neutering edit** — change the added line in persistRun.ts to \`export const MAX_PERSISTED_CHARS = 1;\`
and change nothing else. The test then writes a 501-character string, reads back 1 character, and
asserts that 1 === MAX_PERSISTED_CHARS, which is 1. It passes. A ceiling of 1 character would destroy
every persisted step output in every eval run — the exact failure the record exists to prevent, per the
file header at src/evals/persistRun.ts:1-8 — and no test in this repository would go red.

**Evidence** — No other test in src/evals/persistRun.test.ts touches truncation: the four pre-existing
cases assert error.json contents, the partial-output file set, and the .md/.json split, none of which
reads a length. src/evals/run.ts is the only production caller of persistRun and pins no ceiling of its
own.

**Severity** — major. The ceiling is a silent data-destroying operation, the constant is the only thing
standing between a truncation and a total loss, and the change ships with covering-looking test that
locks in whatever value happens to be written.
`;

const CORRECTNESS = `\
No correctness findings. Both hunks apply cleanly to the files as they stand, the added constant is
exported and used at its single call site, and the .md/.json branch structure is unchanged.

Invariants relied on

- **Invariant** — MAX_PERSISTED_CHARS is large enough that ordinary step output is written whole.
  **Enforced at** — enforced nowhere. Searched src/evals/**.ts for a second reference to the constant
  and for any other length check on a persisted output; the only reference is the slice added by this
  change. Reported above as a test-falsifiability concern rather than a second correctness entry.

Framing: the brief scopes this to eval run persistence. Outside it, I checked src/evals/run.ts's three
persistRun call sites and found none that re-reads what it wrote.
`;

const SECURITY = `\
No security findings. The change narrows what is written rather than widening it, the path is still
composed from a step id the pipeline defines and a run directory the runner builds, and no value the
change introduces reaches an interpreting operation.

Constraints relied on

- **Value** — the step output string reaching writeFileSync.
  **Constrained at** — src/evals/persistRun.ts, the added \`value.slice(0, MAX_PERSISTED_CHARS)\`; it is
  the only new bound and it bounds length only, which is all this change claims.

Framing: the brief scopes this to eval run persistence. Outside it, I traced the runDir value from
src/evals/run.ts's AGENT_FLOWS_EVAL_OUT join and found it constrained to a path the operator supplies.
`;

const fixture: CodeReviewSeverityFixture = {
  diff: DIFF,
  baseline: BASELINE,

  workerOutputs: {
    correctness: CORRECTNESS,
    security: SECURITY,
    falsifiability: FALSIFIABILITY,
  },

  expectations: [
    {
      phrase:
        "the truncation test builds its expected value from MAX_PERSISTED_CHARS, so a wrong ceiling cannot make it fail — raised major by the worker",
      // Keyed on the constant and the test's subject, which the finding names
      // whatever verdict it carries: a key that matched only a CONFIRMED wording
      // would score a silent downgrade as "never raised" and the failure this
      // eval exists for would vanish.
      keywords: ["max_persisted_chars", "truncat"],
      proposedSeverity: "major",
    },
  ],

  // The finding cites both; if either is renamed the seeded worker output is
  // describing code that no longer exists and the fixture is stale.
  expectedPaths: ["src/evals/persistRun.ts", "src/evals/persistRun.test.ts"],
};

export default fixture;
