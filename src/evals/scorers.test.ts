import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { packageRoot } from "../packageRoot.js";
import auditPlantedDefects from "./fixtures/audit-planted-defects.js";
import bugMissingDetail from "./fixtures/bug-missing-detail.js";
import codeReviewCitations from "./fixtures/code-review-citations.js";
import featureCollision from "./fixtures/feature-collision.js";
import { assertReadOnly } from "./safetyGuard.js";
import {
  auditDefectsFound,
  citedPathsExist,
  existingFunctionalityNamed,
  plantedGapsFound,
  reviewConditional,
  reviewVerdicts,
} from "./scorers.js";
import { stepOutputText } from "./stepOutput.js";
import type { ClaimedFindings, ConditionalItem, KeyedItem, VerdictExpectation } from "./scorers.js";
import type { LoadedPipeline } from "../canon/types.js";

// Spec 038 FR-004: the package root is found by walking up to package.json.
const REPO_ROOT = packageRoot();
const FIXTURES_DIR = join(REPO_ROOT, "src", "evals", "fixtures", "__fixtures__");

// ── citedPathsExist ───────────────────────────────────────────────────────────

describe("citedPathsExist", () => {
  it("scores 1.0 when no path-shaped tokens are present", () => {
    const result = citedPathsExist("No file references here at all.", REPO_ROOT);
    assert.equal(result.score, 1);
    assert.equal(result.total, 0);
    assert.deepEqual(result.found, []);
    assert.deepEqual(result.invented, []);
  });

  it("accepts a real file cited in backticks", () => {
    const result = citedPathsExist("See `src/canon/nest.ts` for details.", REPO_ROOT);
    assert.ok(result.found.includes("src/canon/nest.ts"), "real path must be in found");
    assert.deepEqual(result.invented, []);
    assert.equal(result.score, 1);
  });

  it("accepts a real file cited as prose with known prefix", () => {
    const result = citedPathsExist(
      "The implementation lives in src/canon/types.ts and handles this.",
      REPO_ROOT
    );
    assert.ok(result.found.includes("src/canon/types.ts"), "real prose path must be found");
    assert.equal(result.score, 1);
  });

  it("flags a fabricated path as invented", () => {
    const result = citedPathsExist(
      "See `src/evals/nonexistent-fabricated-file.ts` for the scorer.",
      REPO_ROOT
    );
    assert.ok(
      result.invented.includes("src/evals/nonexistent-fabricated-file.ts"),
      "fabricated path must be in invented"
    );
    assert.equal(result.found.length, 0);
    assert.equal(result.score, 0);
  });

  it("flags a fabricated prose path as invented", () => {
    const result = citedPathsExist(
      "The function is in src/canon/totally-made-up.ts which handles this.",
      REPO_ROOT
    );
    assert.ok(
      result.invented.includes("src/canon/totally-made-up.ts"),
      "fabricated prose path must be invented"
    );
    assert.equal(result.score, 0);
  });

  it("partial score when mix of real and fabricated paths", () => {
    const result = citedPathsExist(
      "Real: `src/canon/nest.ts`. Fake: `src/evals/ghost.ts`.",
      REPO_ROOT
    );
    assert.ok(result.found.includes("src/canon/nest.ts"));
    assert.ok(result.invented.includes("src/evals/ghost.ts"));
    assert.equal(result.score, 0.5);
  });

  it("ignores URLs that contain a slash", () => {
    const result = citedPathsExist(
      "See https://mastra.ai/docs/evals/overview for reference.",
      REPO_ROOT
    );
    // URL must not be treated as a repo path.
    assert.equal(result.total, 0);
  });

  it("ignores prose words with dots but no known prefix", () => {
    const result = citedPathsExist("Use example.com/path for external docs.", REPO_ROOT);
    // example.com/path starts with "example", not a known prefix.
    assert.equal(result.total, 0);
  });

  it("scores a real directory neither way — not a file, but not a fabrication", () => {
    const result = citedPathsExist(
      "The logic lives in src/canon and src/canon/nest.ts.",
      REPO_ROOT
    );
    assert.deepEqual(result.invented, []);
    assert.deepEqual(result.found, ["src/canon/nest.ts"]);
    assert.equal(result.total, 1, "the directory is excluded from the total");
    assert.equal(result.score, 1);
  });

  it("does not report a real path as invented when sentence punctuation follows it", () => {
    const result = citedPathsExist(
      "Nesting lives in src/canon/nest.ts. Loading is in src/canon/load.ts, and types in src/canon/types.ts.",
      REPO_ROOT
    );
    assert.deepEqual(result.invented, []);
    assert.equal(result.score, 1);
  });
});

// ── plantedGapsFound ──────────────────────────────────────────────────────────

describe("plantedGapsFound", () => {
  it("scores 1.0 when expectedGaps is empty", () => {
    const result = plantedGapsFound("any output", []);
    assert.equal(result.score, 1);
    assert.deepEqual(result.surfaced, []);
    assert.deepEqual(result.missed, []);
  });

  it("reports a gap as surfaced when all keywords are present", () => {
    const result = plantedGapsFound("The until condition is never set so maxIterations runs out.", [
      { phrase: "until not specified", keywords: ["until", "maxIterations"] },
    ]);
    assert.deepEqual(result.surfaced, ["until not specified"]);
    assert.deepEqual(result.missed, []);
    assert.equal(result.score, 1);
  });

  it("reports a gap as missed when any keyword is absent", () => {
    const result = plantedGapsFound("The pipeline name is unclear.", [
      { phrase: "until not specified", keywords: ["until", "maxIterations"] },
    ]);
    assert.deepEqual(result.missed, ["until not specified"]);
    assert.deepEqual(result.surfaced, []);
    assert.equal(result.score, 0);
  });

  it("partial score when some gaps are surfaced and some missed", () => {
    const output = "The until condition is missing but the pipeline name is there.";
    const result = plantedGapsFound(output, [
      { phrase: "until missing", keywords: ["until"] },
      { phrase: "maxIterations missing", keywords: ["maxIterations"] },
    ]);
    assert.equal(result.score, 0.5);
    assert.deepEqual(result.surfaced, ["until missing"]);
    assert.deepEqual(result.missed, ["maxIterations missing"]);
  });

  it("matching is case-insensitive", () => {
    const result = plantedGapsFound("UNTIL and MAXITERATIONS are both unset.", [
      { phrase: "until", keywords: ["until", "maxiterations"] },
    ]);
    assert.equal(result.score, 1);
  });

  it("fails when output is entirely unrelated to the gaps", () => {
    const result = plantedGapsFound("The weather today is sunny.", [
      { phrase: "until not specified", keywords: ["until"] },
      { phrase: "no pipeline name", keywords: ["pipeline", "which"] },
    ]);
    assert.equal(result.score, 0);
    assert.equal(result.missed.length, 2);
  });
});

// ── existingFunctionalityNamed ────────────────────────────────────────────────

describe("existingFunctionalityNamed", () => {
  it("scores 1.0 when expectedExisting is empty", () => {
    const result = existingFunctionalityNamed("any output", []);
    assert.equal(result.score, 1);
  });

  it("credits output that names the existing implementation", () => {
    const result = existingFunctionalityNamed(
      "expandNested in nest.ts already handles this at load time.",
      [{ phrase: "expandNested in nest.ts", keywords: ["expandNested", "nest"] }]
    );
    assert.deepEqual(result.identified, ["expandNested in nest.ts"]);
    assert.deepEqual(result.missed, []);
    assert.equal(result.score, 1);
  });

  it("fails an output that proposes to build something already existing", () => {
    const result = existingFunctionalityNamed(
      "We should add a new function to handle pipeline nesting from scratch.",
      [{ phrase: "expandNested in nest.ts", keywords: ["expandNested", "nest"] }]
    );
    assert.deepEqual(result.missed, ["expandNested in nest.ts"]);
    assert.equal(result.score, 0);
  });

  it("partial score when some items are identified and some missed", () => {
    const output = "expandNested is in nest.ts. The Mastra compilation path was not examined.";
    const result = existingFunctionalityNamed(output, [
      { phrase: "expandNested in nest.ts", keywords: ["expandNested", "nest"] },
      { phrase: "buildLoopStep using dountil", keywords: ["dountil", "build"] },
    ]);
    assert.equal(result.score, 0.5);
    assert.deepEqual(result.identified, ["expandNested in nest.ts"]);
    assert.deepEqual(result.missed, ["buildLoopStep using dountil"]);
  });
});

// ── fixture answer-key integrity (anti-rot) ───────────────────────────────────

describe("fixture answer-key paths all exist on disk", () => {
  for (const [name, fixture] of [
    ["feature-collision", featureCollision],
    ["bug-missing-detail", bugMissingDetail],
  ] as const) {
    for (const p of fixture.expectedPaths) {
      it(`${name}: ${p}`, () => {
        assert.ok(
          existsSync(join(REPO_ROOT, p)),
          `answer-key path does not exist: ${p} — update the fixture`
        );
      });
    }
  }
});

// ── scorers agree with fixture answer keys ────────────────────────────────────

describe("feature-collision fixture: correct investigation passes all scorers", () => {
  // A synthetic "correct" investigation output that names all expected items.
  const goodOutput = `
    The codebase already implements nested pipeline support.
    \`src/canon/nest.ts\` exports \`expandNested\` which splices pipeline steps at load time.
    \`src/canon/types.ts\` defines StepKind which includes "pipeline".
    Gap: the standard library is incomplete — ADR-0015 specifies verify-plan and correct-plan,
    and neither exists in pipelines/.
  `;

  it("citedPathsExist: no invented paths", () => {
    const r = citedPathsExist(goodOutput, REPO_ROOT);
    assert.deepEqual(r.invented, [], `invented paths must be empty; got: ${r.invented.join(", ")}`);
  });

  it("existingFunctionalityNamed: all items identified", () => {
    const r = existingFunctionalityNamed(goodOutput, featureCollision.expectedExisting);
    assert.equal(r.score, 1, `missed: ${r.missed.join(", ")}`);
  });

  it("plantedGapsFound: all gaps surfaced", () => {
    const r = plantedGapsFound(goodOutput, featureCollision.expectedGaps);
    assert.equal(r.score, 1, `missed: ${r.missed.join(", ")}`);
  });
});

describe("feature-collision fixture: shallow investigation fails scorers", () => {
  // An output that proposes building from scratch, cites no real files.
  const shallowOutput =
    "We should implement a new pipeline composition system. " +
    "Add a pipelineRunner module in src/runtime/pipelineRunner.ts.";

  it("citedPathsExist: invented path is flagged", () => {
    const r = citedPathsExist(shallowOutput, REPO_ROOT);
    assert.ok(r.invented.length > 0, "fabricated path must be detected");
    assert.ok(r.score < 1, "score must be less than 1");
  });

  it("existingFunctionalityNamed: existing items missed", () => {
    const r = existingFunctionalityNamed(shallowOutput, featureCollision.expectedExisting);
    assert.ok(r.score < 1, "shallow output must not score 1 on existing items");
  });
});

describe("bug-missing-detail fixture: correct investigation passes all scorers", () => {
  const goodOutput = `
    The loop step kind is defined in src/canon/types.ts with maxIterations and until fields.
    src/bindings/mastra/build.ts compiles it to Mastra's dountil primitive via buildLoopStep.
    Open questions:
    1. Which pipeline has the offending loop step?
    2. What is the until condition — is it ever set to truthy?
    3. What is the maxIterations budget?
  `;

  it("citedPathsExist: no invented paths", () => {
    const r = citedPathsExist(goodOutput, REPO_ROOT);
    assert.deepEqual(r.invented, [], `invented: ${r.invented.join(", ")}`);
  });

  it("existingFunctionalityNamed: loop implementation identified", () => {
    const r = existingFunctionalityNamed(goodOutput, bugMissingDetail.expectedExisting);
    assert.equal(r.score, 1, `missed: ${r.missed.join(", ")}`);
  });

  it("plantedGapsFound: all gaps surfaced", () => {
    const r = plantedGapsFound(goodOutput, bugMissingDetail.expectedGaps);
    assert.equal(r.score, 1, `missed: ${r.missed.join(", ")}`);
  });
});

describe("bug-missing-detail fixture: shallow investigation fails scorers", () => {
  // Output that says nothing specific — just generic advice.
  const shallowOutput =
    "Add a break condition to your loop. Make sure the termination logic is correct.";

  it("existingFunctionalityNamed: loop implementation not named", () => {
    const r = existingFunctionalityNamed(shallowOutput, bugMissingDetail.expectedExisting);
    assert.ok(r.score < 1, "generic advice must not score 1 on existing items");
  });

  it("plantedGapsFound: specific gaps not surfaced", () => {
    const r = plantedGapsFound(shallowOutput, bugMissingDetail.expectedGaps);
    assert.ok(r.score < 1, "vague output must not surface all planted gaps");
  });
});

// ── assertReadOnly: loop body safety guard (Fix 4) ────────────────────────────

describe("assertReadOnly: loop body safety check", () => {
  function makeLoopPipeline(bodyStepKind: string): LoadedPipeline {
    const body: LoadedPipeline = {
      def: {
        id: "body-pipeline",
        version: 1,
        description: "loop body",
        inputs: [],
        steps: [
          {
            id: "dangerous-step",
            kind: bodyStepKind as "check",
            command: "rm -rf /",
          },
        ],
      },
      prompts: {},
    };
    return {
      def: {
        id: "outer-pipeline",
        version: 1,
        description: "outer",
        inputs: ["request"],
        steps: [
          {
            id: "myloop",
            kind: "loop",
            pipeline: "body-pipeline",
            maxIterations: 3,
            until: "done",
          },
        ],
      },
      prompts: {},
      bodies: { myloop: body },
    };
  }

  it("refuses a loop body containing a check step", () => {
    const loaded = makeLoopPipeline("check");
    assert.throws(
      () => assertReadOnly(loaded),
      (err: Error) => {
        assert.ok(
          err.message.includes("dangerous-step") || err.message.includes("check"),
          `error must identify the dangerous step; got: ${err.message}`
        );
        return true;
      }
    );
  });

  it("accepts a loop body with only llm steps", () => {
    const body: LoadedPipeline = {
      def: {
        id: "body-pipeline",
        version: 1,
        description: "loop body",
        inputs: [],
        steps: [
          {
            id: "safe-step",
            kind: "llm",
            role: "worker",
            prompt: "prompts/safe.md",
          },
        ],
      },
      prompts: { "safe-step": "do safe work" },
    };
    const loaded: LoadedPipeline = {
      def: {
        id: "outer-pipeline",
        version: 1,
        description: "outer",
        inputs: ["request"],
        steps: [
          {
            id: "myloop",
            kind: "loop",
            pipeline: "body-pipeline",
            maxIterations: 3,
            until: "done",
          },
        ],
      },
      prompts: {},
      bodies: { myloop: body },
    };
    assert.doesNotThrow(() => assertReadOnly(loaded));
  });
});

// ── feature-collision fixture: gap freshness anti-rot guard (Fix 5) ──────────

describe("feature-collision fixture: gap freshness guard", () => {
  it("Binding A still does not implement loop steps — if this fails, the gap is implemented and the fixture must be updated", () => {
    const claudeCodePath = join(REPO_ROOT, "src/bindings/claudeCode.ts");
    const source = readFileSync(claudeCodePath, "utf8");
    // The refusal guard in generateWorkflowScript (SUPPORTED_STEP_KINDS) must
    // exist and must NOT list "loop" — evidence that loop steps are still refused.
    assert.ok(
      source.includes("SUPPORTED_STEP_KINDS"),
      `SUPPORTED_STEP_KINDS missing from src/bindings/claudeCode.ts — ` +
        `update the feature-collision fixture expectedGaps to reflect the new open gap`
    );
    const kindSet = /SUPPORTED_STEP_KINDS\s*=\s*new Set[^;]+/.exec(source)?.[0] ?? "";
    assert.ok(
      !kindSet.includes('"loop"'),
      `"loop" was added to SUPPORTED_STEP_KINDS — ` +
        `update the feature-collision fixture expectedGaps to reflect the new open gap`
    );
  });
});

// ── auditDefectsFound ─────────────────────────────────────────────────────────

describe("auditDefectsFound", () => {
  const { plantedDefects, decoys } = auditPlantedDefects;

  it("scores recall 1.0 when audit names all planted defects and raises no decoy", () => {
    // Mentions both planted defect keywords and explicitly says the parseInt path is safe.
    const goodOutput =
      "Two issues found in runCheckStep. " +
      'First: the command fallback order is inverted — context["command"] takes priority and overrides step.command, ' +
      "so any caller that sets a context key named 'command' silently hijacks the step definition. " +
      "Second: step.id is interpolated directly into a shell string via execSync; " +
      "this is a shell injection vector if the YAML source is not fully trusted. " +
      "The parseInt call with a default is safe and is not a finding.";
    const r = auditDefectsFound(goodOutput, plantedDefects, decoys);
    assert.equal(r.recall, 1, `missed defects: ${r.missed.join(", ")}`);
    assert.deepEqual(r.falsePositives, [], "good audit must produce no false positives");
    assert.equal(r.found.length, plantedDefects.length);
    assert.deepEqual(r.missed, []);
  });

  it("reports all planted defects as missed when audit output is unrelated", () => {
    const blindOutput =
      "The step validation logic looks straightforward. No issues found in the execution helper.";
    const r = auditDefectsFound(blindOutput, plantedDefects, decoys);
    assert.ok(r.recall < 1, "blind audit must not score full recall");
    assert.equal(r.missed.length, plantedDefects.length, "all defects must be in missed");
    assert.equal(r.found.length, 0);
  });

  it("counts a finding about the decoy as a false positive", () => {
    // Mentions all planted defect keywords AND raises parseInt/NaN as a concern.
    const paranoidOutput =
      "Issues found: " +
      "1. command fallback is wrong — context overrides step.command. " +
      "2. step.id is used in a shell command — injection risk. " +
      "3. parseInt could yield NaN if maxIterations is not a valid integer — this is a risk.";
    const r = auditDefectsFound(paranoidOutput, plantedDefects, decoys);
    assert.equal(r.recall, 1, `missed defects: ${r.missed.join(", ")}`);
    assert.equal(r.falsePositives.length, 1, "decoy must be counted as exactly one false positive");
    assert.ok(
      r.falsePositives[0].toLowerCase().includes("parseint"),
      "false positive phrase must identify the parseInt decoy"
    );
  });

  it("scores recall 1.0 when no defects are planted (vacuously correct)", () => {
    const r = auditDefectsFound("any audit output", [], []);
    assert.equal(r.recall, 1);
    assert.deepEqual(r.falsePositives, []);
    assert.deepEqual(r.found, []);
    assert.deepEqual(r.missed, []);
  });

  it("partial recall when only the correctness defect is found", () => {
    // Contains command+context+override keywords but not step.id+injection.
    const partialOutput =
      "The command fallback order is wrong: context overrides step.command, " +
      "violating the principle that the step definition should be authoritative.";
    const r = auditDefectsFound(partialOutput, plantedDefects, decoys);
    assert.ok(r.recall > 0 && r.recall < 1, "partial recall must be strictly between 0 and 1");
    assert.equal(r.found.length, 1, "exactly one defect must be found");
    assert.equal(r.missed.length, plantedDefects.length - 1, "remaining defects must be missed");
    assert.deepEqual(r.falsePositives, [], "no false positives in partial output");
  });

  it("no false positive when decoy keywords are absent from the output", () => {
    const safeOutput =
      "The command fallback is inverted — context overrides step.command. " +
      "step.id is shell injection risk.";
    const r = auditDefectsFound(safeOutput, plantedDefects, decoys);
    assert.deepEqual(r.falsePositives, [], "output without NaN must not trigger the decoy");
  });

  it("matching is case-insensitive for both defects and decoys", () => {
    const upperOutput =
      "COMMAND from CONTEXT can OVERRIDE STEP.COMMAND. STEP.ID causes shell INJECTION. " +
      "PARSEINT yields NAN for bad input.";
    const r = auditDefectsFound(upperOutput, plantedDefects, decoys);
    assert.equal(r.recall, 1, "uppercase output must still match defect keywords");
    assert.equal(r.falsePositives.length, 1, "uppercase output must still match decoy keywords");
  });
});

// ── audit-planted-defects fixture: anti-rot guard ─────────────────────────────

describe("audit-planted-defects fixture: planted defect keywords present in the diff", () => {
  const diffLower = auditPlantedDefects.diff.toLowerCase();

  for (const defect of auditPlantedDefects.plantedDefects) {
    for (const kw of defect.keywords) {
      it(`defect "${defect.phrase}" keyword "${kw}" is in the diff`, () => {
        assert.ok(
          diffLower.includes(kw.toLowerCase()),
          `keyword "${kw}" must appear in the fixture diff — update the diff or the keyword`
        );
      });
    }
  }

  for (const decoy of auditPlantedDefects.decoys) {
    for (const kw of decoy.keywords) {
      it(`decoy "${decoy.phrase}" keyword "${kw}" is in the diff`, () => {
        assert.ok(
          diffLower.includes(kw.toLowerCase()),
          `decoy keyword "${kw}" must appear in the fixture diff — update the diff or the keyword`
        );
      });
    }
  }
});

describe("audit-planted-defects fixture: answer-key paths all exist on disk", () => {
  for (const p of auditPlantedDefects.expectedPaths) {
    it(p, () => {
      assert.ok(
        existsSync(join(REPO_ROOT, p)),
        `answer-key path does not exist: ${p} — update the fixture`
      );
    });
  }
});

// ── reviewVerdicts ────────────────────────────────────────────────────────────

/** One finding in the shape the verify step's codeReviewFindings schema emits. */
function finding(over: Record<string, unknown>): Record<string, unknown> {
  return {
    claim: "",
    file: "src/billing/refund.ts",
    line: 1,
    quote: "",
    verdict: "CONFIRMED",
    citationAccurate: true,
    scope: "introduced",
    kind: "defect",
    severity: "minor",
    probes: { guard: "", reachability: "", remedy: "", callers: "", scope: "" },
    correctedWording: "",
    ...over,
  };
}

function jsonOutput(findings: Record<string, unknown>[]): string {
  return JSON.stringify({ codeReviewFindings: findings });
}

/**
 * Pull an answer-key entry out of the fixture by a fragment of its phrase, so
 * the scorer tests are scored against the same expectations a live eval run
 * uses. Reordering the fixture cannot silently detach these tests from it.
 */
function expectationFor(fragment: string): VerdictExpectation {
  const found = codeReviewCitations.expectations.find((e) => e.phrase.includes(fragment));
  assert.ok(found, `no fixture expectation whose phrase contains "${fragment}"`);
  return found;
}

/**
 * Spec 030 acceptance criteria 1-3 grade the verifier's adjudication of a claim
 * the reviewer got WRONG. No input to the live pipeline can seed such a claim
 * (see the header of fixtures/code-review-citations.ts), so these answer keys
 * live here, against synthetic verify output, and not in the fixture.
 */
const BAD_CITATION_EXPECTATION: VerdictExpectation = {
  phrase: "citation does not support the claim — the cited lines ARE the validation (criterion 1)",
  keywords: ["amountCents", "positive integer"],
  expectedVerdict: "DECLINED",
  expectedKind: "defect",
};

const PARENT_GUARD_EXPECTATION: VerdictExpectation = {
  phrase: "over-refund is already closed by the parent guard assertRefundable (criterion 2)",
  keywords: ["assertRefundable", "paidCents"],
  expectedVerdict: "DECLINED",
  expectedKind: "defect",
};

/**
 * The policy call as an ANSWER KEY for `reviewVerdicts`, kept here rather than
 * pulled from the fixture: the fixture grades it conditionally, because no worker
 * prompt can emit a non-defect, while the scorer's handling of a business-decision
 * — excluded from the blocking count, kind mismatch reported — is worth grading
 * unconditionally and needs no model.
 */
const POLICY_EXPECTATION: VerdictExpectation = {
  phrase: "90-day refund window is a finance policy call, not a defect (criterion 4)",
  keywords: ["REFUND_WINDOW_DAYS", "90"],
  expectedVerdict: "CONFIRMED",
  expectedKind: "business-decision",
};

const REMEDY_EXISTS_EXPECTATION: VerdictExpectation = {
  phrase: "a remedy exists (reverseRefund) but excludes partial refunds (criterion 3)",
  keywords: ["reverseRefund", "partial"],
  expectedVerdict: "PARTIAL",
  expectedKind: "defect",
};

describe("reviewVerdicts", () => {
  it("scores DECLINED when the cited file:line does not support the finding (criterion 1)", () => {
    const exp = BAD_CITATION_EXPECTATION;
    const output = jsonOutput([
      finding({
        claim: "amountCents is never validated before it is used",
        line: 16,
        quote: "if (!Number.isInteger(amountCents) || amountCents <= 0) {",
        verdict: "DECLINED",
        citationAccurate: false,
        correctedWording:
          "the cited lines are the validation: they reject anything that is not a positive integer number of cents",
      }),
    ]);

    const r = reviewVerdicts(output, [exp]);
    assert.deepEqual(r.correct, [exp.phrase], `wrong: ${JSON.stringify(r.wrong)}`);
    assert.deepEqual(r.missing, []);
    assert.equal(r.accuracy, 1);
  });

  it("scores DECLINED when a parent-level guard closes the finding, naming the guard (criterion 2)", () => {
    const exp = PARENT_GUARD_EXPECTATION;
    const output = jsonOutput([
      finding({
        claim: "a refund can exceed the amount paid",
        file: "src/billing/refundController.ts",
        line: 21,
        quote: "if (amountCents > order.paidCents - order.refundedCents) {",
        verdict: "DECLINED",
        correctedWording:
          "assertRefundable already rejects any amount above order.paidCents minus refunds",
        probes: {
          guard: "assertRefundable already rejects any amount above order.paidCents minus refunds",
          reachability: "handleRefund calls assertRefundable before applyRefund",
          remedy: "n/a",
          callers: "handleRefund is the only production caller",
          scope: "introduced — added line in the refundController.ts:18 hunk",
        },
      }),
    ]);

    const r = reviewVerdicts(output, [exp]);
    assert.deepEqual(r.correct, [exp.phrase], `wrong: ${JSON.stringify(r.wrong)}`);

    // A DECLINED verdict that does not name the guard is a hunch, not evidence.
    // Naming it in a probe does not count: probes record what was looked at, not
    // what the finding asserts, and the answer key grades the assertion.
    const withoutGuardName = jsonOutput([
      finding({
        claim: "a refund can exceed the amount paid",
        verdict: "DECLINED",
        probes: {
          guard: "assertRefundable already caps this against order.paidCents",
          reachability: "",
          remedy: "",
          callers: "",
          scope: "",
        },
      }),
    ]);
    const r2 = reviewVerdicts(withoutGuardName, [exp]);
    assert.deepEqual(
      r2.missing,
      [exp.phrase],
      "a verdict that never names assertRefundable must not be credited with closing the finding"
    );
  });

  it("scores PARTIAL when a remedy exists but does not cover this case (criterion 3)", () => {
    const exp = REMEDY_EXISTS_EXPECTATION;
    const output = jsonOutput([
      finding({
        claim: "there is no way to undo a refund once applied",
        verdict: "PARTIAL",
        severity: "major",
        correctedWording:
          "reverseRefund undoes a full refund; the finding holds only for a partial refund, which it explicitly rejects",
        probes: {
          guard: "none",
          reachability: "exported and called from the refund controller",
          remedy: "reverseRefund exists and covers full refunds only",
          callers: "production caller present",
          scope: "introduced",
        },
      }),
    ]);

    const r = reviewVerdicts(output, [exp]);
    assert.deepEqual(r.correct, [exp.phrase], `wrong: ${JSON.stringify(r.wrong)}`);
    assert.equal(r.accuracy, 1);
  });

  it("keeps a real defect CONFIRMED even though the reviewer cited the wrong line (criterion 5)", () => {
    const exp = expectationFor("real ordering defect");
    const output = jsonOutput([
      finding({
        claim: "the order is marked refunded before the ledger write",
        line: 30,
        quote: "order.refundedCents += amountCents;",
        verdict: "CONFIRMED",
        // The reviewer pointed at the wrong line; the defect is still real.
        citationAccurate: false,
        severity: "blocking",
        correctedWording:
          "corrected citation: the write to order.refundedCents precedes writeLedgerEntry, so a failed ledger write leaves the order refunded with no ledger entry",
      }),
    ]);

    const r = reviewVerdicts(output, [exp]);
    assert.deepEqual(
      r.correct,
      [exp.phrase],
      "a real defect with a sloppy citation must survive as CONFIRMED — " +
        "a verifier strict enough to DECLINE it destroys true findings, which is a worse " +
        "failure than the wrong citation this pipeline exists to fix. " +
        `got wrong=${JSON.stringify(r.wrong)} missing=${JSON.stringify(r.missing)}`
    );
    assert.equal(r.blockingCount, 1, "the confirmed blocking defect must be counted");
  });

  it("excludes a business-decision from blockingCount while counting a blocking defect (criterion 4)", () => {
    const policy = POLICY_EXPECTATION;
    const defect = expectationFor("real ordering defect");
    const output = jsonOutput([
      finding({
        claim: "should REFUND_WINDOW_DAYS stay at 90 days?",
        verdict: "CONFIRMED",
        kind: "business-decision",
        // Deliberately marked blocking: kind, not severity, is what excludes it.
        severity: "blocking",
        correctedWording: "owner: finance — one question, not adjudicated here",
      }),
      finding({
        claim: "order.refundedCents is updated before the ledger write",
        verdict: "CONFIRMED",
        kind: "defect",
        severity: "blocking",
        quote: "order.refundedCents += amountCents;",
        correctedWording: "a failed ledger write leaves the two stores disagreeing",
      }),
    ]);

    const r = reviewVerdicts(output, [policy, defect]);
    assert.equal(
      r.accuracy,
      1,
      `wrong: ${JSON.stringify(r.wrong)} missing: ${r.missing.join(", ")}`
    );
    assert.equal(
      r.blockingCount,
      1,
      "only the defect may be counted — a business-decision is excluded from the blocking " +
        "count however severe it is marked (spec 030 FR-004)"
    );
  });

  it("reports a wrong verdict in wrong[] and an absent finding in missing[]", () => {
    const declined = BAD_CITATION_EXPECTATION;
    const absent = REMEDY_EXISTS_EXPECTATION;
    const output = jsonOutput([
      finding({
        claim: "amountCents is never validated before it is used",
        // The answer key says DECLINED; the verifier confirmed it instead.
        verdict: "CONFIRMED",
        correctedWording: "amountCents must be a positive integer and this is not checked",
      }),
    ]);

    const r = reviewVerdicts(output, [declined, absent]);
    assert.equal(
      r.wrong.length,
      1,
      `expected exactly one wrong verdict; got ${JSON.stringify(r.wrong)}`
    );
    assert.equal(r.wrong[0].phrase, declined.phrase);
    assert.match(r.wrong[0].expected, /DECLINED/);
    assert.match(r.wrong[0].actual, /CONFIRMED/);
    assert.deepEqual(r.missing, [absent.phrase], "a finding never emitted must land in missing[]");
    assert.deepEqual(r.correct, []);
    assert.equal(r.accuracy, 0);
  });

  it("reports a kind mismatch in wrong[] with both kinds named", () => {
    const policy = POLICY_EXPECTATION;
    const output = jsonOutput([
      finding({
        claim: "REFUND_WINDOW_DAYS of 90 days is too short",
        verdict: "CONFIRMED",
        // Right verdict, wrong classification: treated as a defect, so it would
        // be adjudicated and counted instead of being handed to finance.
        kind: "defect",
        severity: "blocking",
        correctedWording: "owner: finance",
      }),
    ]);

    const r = reviewVerdicts(output, [policy]);
    assert.equal(r.wrong.length, 1, `expected a kind mismatch; got ${JSON.stringify(r)}`);
    assert.match(r.wrong[0].expected, /business-decision/);
    assert.match(r.wrong[0].actual, /defect/);
    assert.equal(r.blockingCount, 1, "misclassified as a defect, it is counted — that is the harm");
  });

  it("falls back to windowed substring matching when the output is prose, not JSON", () => {
    const badCitation = BAD_CITATION_EXPECTATION;
    const ordering = expectationFor("real ordering defect");
    const prose = [
      "Finding 1 — DECLINED. kind: defect. The claim that amountCents is unchecked does not",
      "survive the file: the cited lines reject anything that is not a positive integer number",
      'of cents: "if (!Number.isInteger(amountCents) || amountCents <= 0)".',
      "",
      "Finding 2 — CONFIRMED. kind: defect, severity: blocking. order.refundedCents is",
      "incremented before the ledger write, so a failed writeLedgerEntry leaves the order",
      "refunded with no ledger entry. The reviewer's line number was wrong; the defect is not.",
    ].join("\n");

    const r = reviewVerdicts(prose, [badCitation, ordering]);
    assert.equal(
      r.accuracy,
      1,
      `wrong: ${JSON.stringify(r.wrong)} missing: ${r.missing.join(", ")}`
    );
    assert.equal(r.blockingCount, 1, "the prose path must read severity from the same block");
  });

  it("does not credit a verdict token that belongs to a different finding's block", () => {
    const ordering = expectationFor("real ordering defect");
    const prose = [
      "Finding 1 — CONFIRMED. kind: defect. Unrelated: the fee rate constant is undocumented.",
      "",
      "Finding 2 — DECLINED. kind: defect. order.refundedCents and the ledger write are fine.",
    ].join("\n");

    const r = reviewVerdicts(prose, [ordering]);
    assert.deepEqual(
      r.wrong.map((w) => w.actual),
      ["DECLINED (kind: defect)"],
      "the verdict must come from the block that contains the keywords, not from elsewhere in the report"
    );
  });

  it("scores accuracy 1 with no expectations (vacuously correct, matching auditDefectsFound)", () => {
    const r = reviewVerdicts(jsonOutput([]), []);
    assert.equal(r.accuracy, 1);
    assert.deepEqual(r.correct, []);
    assert.deepEqual(r.wrong, []);
    assert.deepEqual(r.missing, []);
    assert.equal(r.blockingCount, 0);
  });

  it("treats an unparseable or empty output as accounting for nothing", () => {
    const exp = expectationFor("real ordering defect");
    const r = reviewVerdicts("", [exp]);
    assert.deepEqual(r.missing, [exp.phrase]);
    assert.equal(r.accuracy, 0);
    assert.equal(r.blockingCount, 0);
  });

  it("matches keywords case-insensitively", () => {
    const exp = expectationFor("real ordering defect");
    const output = jsonOutput([
      finding({
        claim: "ORDER.REFUNDEDCENTS IS WRITTEN BEFORE THE LEDGER ENTRY",
        verdict: "CONFIRMED",
        severity: "blocking",
      }),
    ]);
    const r = reviewVerdicts(output, [exp]);
    assert.deepEqual(r.correct, [exp.phrase]);
  });

  it("does not count a DECLINED blocking defect in blockingCount", () => {
    // The verifier disproved it, so synthesis drops it. Counting it would put
    // this number permanently out of step with the verdict line it validates.
    const output = jsonOutput([
      finding({
        claim: "a refund can exceed the amount paid",
        verdict: "DECLINED",
        kind: "defect",
        severity: "blocking",
      }),
    ]);

    const r = reviewVerdicts(output, []);
    assert.equal(
      r.blockingCount,
      0,
      "a blocking defect the verifier DECLINED must not be counted as blocking"
    );
  });

  it("does not count a DECLINED blocking defect in blockingCount on the prose path", () => {
    const prose =
      "Finding 1 — DECLINED. kind: defect, severity: blocking. " +
      "The claim does not survive the file: the guard it says is missing is right there.";

    const r = reviewVerdicts(prose, []);
    assert.equal(r.blockingCount, 0, "the prose path must exclude DECLINED the same way");
  });

  it("takes the earliest verdict token in a block, not the first in token order", () => {
    // The verify prompt deliberately produces blocks naming both tokens
    // ("CONFIRMED as a defect while its details are DECLINED"), so scanning for
    // CONFIRMED first grades a declined finding as confirmed.
    const ordering = expectationFor("real ordering defect");
    const prose =
      "Finding 1 — DECLINED. kind: defect. order.refundedCents and the ledger write are " +
      "already sequenced correctly; this would be CONFIRMED only if writeLedgerEntry could " +
      "fail without throwing, and it cannot.";

    const r = reviewVerdicts(prose, [ordering]);
    assert.deepEqual(
      r.wrong.map((w) => w.actual),
      ["DECLINED (kind: defect)"],
      "the earliest token in the block is the verdict; a later token is discussion"
    );
  });

  it("prefers an anchored `verdict:` label and matches it case-insensitively", () => {
    const ordering = expectationFor("real ordering defect");
    const prose =
      "Finding 1 — kind: defect, severity: blocking. DECLINED was the reviewer's own " +
      "expectation; verdict: confirmed. order.refundedCents is incremented before the " +
      "ledger write, so a failed write leaves the two stores disagreeing.";

    const r = reviewVerdicts(prose, [ordering]);
    assert.deepEqual(
      r.correct,
      [ordering.phrase],
      `an anchored verdict label wins over any earlier loose token, whatever its case; got ${JSON.stringify(r.wrong)}`
    );
  });

  it("parses JSON wrapped in a markdown code fence", () => {
    // The schema travels as a prompt suffix, not a transport constraint, so a
    // fenced object is the right answer in the wrong envelope. Graded as prose it
    // would collapse into a single block and every expectation would share one
    // verdict.
    const ordering = expectationFor("real ordering defect");
    const json = jsonOutput([
      finding({
        claim: "amountCents is never validated before it is used",
        verdict: "DECLINED",
        correctedWording:
          "the cited lines reject anything that is not a positive integer number of cents",
      }),
      finding({
        claim: "order.refundedCents is updated before the ledger write",
        verdict: "CONFIRMED",
        severity: "blocking",
      }),
    ]);

    const r = reviewVerdicts("```json\n" + json + "\n```", [BAD_CITATION_EXPECTATION, ordering]);
    assert.equal(
      r.accuracy,
      1,
      `fenced JSON must be unwrapped, not graded as prose; wrong: ${JSON.stringify(r.wrong)} missing: ${r.missing.join(", ")}`
    );
    assert.equal(r.blockingCount, 1, "only the CONFIRMED blocking defect counts");
  });

  it("accounts for nothing when valid JSON lacks the codeReviewFindings key", () => {
    // Falling through to the prose parser here is the dangerous case: a
    // single-line JSON blob has no blank line, so the whole output becomes one
    // block, every expectation matches it and all of them are graded against one
    // verdict — a confident, wrong number.
    const ordering = expectationFor("real ordering defect");
    const output = JSON.stringify({
      findings: [
        {
          claim: "order.refundedCents is updated before the ledger write",
          verdict: "CONFIRMED",
          kind: "defect",
          severity: "blocking",
        },
      ],
    });

    const r = reviewVerdicts(output, [ordering]);
    assert.deepEqual(
      r.missing,
      [ordering.phrase],
      "a schema failure must report everything missing, not grade it as prose"
    );
    assert.equal(r.accuracy, 0);
    assert.equal(r.blockingCount, 0);
  });

  it("matches keywords across claim and quote, and never across probes", () => {
    const ordering = expectationFor(
      "saveOrder persists order.refundedCents before the ledger entry"
    );

    // One keyword in the claim, the other only in the quote: the asserted text is
    // matched as a whole, so an answer key need not guess which field carries which
    // word.
    const split = jsonOutput([
      finding({
        claim: "refundedCents is updated before the write that records it",
        quote: "writeLedgerEntry({ orderId: order.id, amountCents, feeCents });",
        verdict: "CONFIRMED",
        kind: "defect",
      }),
    ]);
    assert.deepEqual(reviewVerdicts(split, [ordering]).correct, [ordering.phrase]);

    // Same words, but one of them only in a probe: not an assertion, not a match.
    const inProbe = jsonOutput([
      finding({
        claim: "refundedCents is updated before the write that records it",
        quote: "order.refundedCents += amountCents;",
        verdict: "CONFIRMED",
        kind: "defect",
        probes: {
          guard: "writeLedgerEntry in ledger.js has no compensating entry",
          reachability: "",
          remedy: "",
          callers: "",
          scope: "",
        },
      }),
    ]);
    assert.deepEqual(reviewVerdicts(inProbe, [ordering]).missing, [ordering.phrase]);
  });
});

// ── reviewConditional ─────────────────────────────────────────────────────────

/**
 * Pull a conditional item out of the fixture by a fragment of its phrase, for the
 * same reason `expectationFor` exists: these tests must grade the items a live
 * eval actually ships, not a copy of them that can drift.
 */
function conditionalFor(fragment: string): ConditionalItem {
  const found = codeReviewCitations.conditional.find((c) => c.phrase.includes(fragment));
  assert.ok(found, `no fixture conditional whose phrase contains "${fragment}"`);
  return found;
}

/** Bait closed in the diff: assertRefundable caps the amount one frame up. */
const BOUND_DECOY = conditionalFor("applyRefund never checks amountCents");
/** Bait closed in the baseline: Order.paidAt is non-nullable on a paid order. */
const PAIDAT_DECOY = conditionalFor("daysSince(order.paidAt) could go NaN");
/** Graded on kind, not verdict: no producer can originate a non-defect. */
const POLICY_ITEM = conditionalFor("90-day refund window is a finance policy call");

describe("reviewConditional", () => {
  it("routes a declined decoy on the JSON path, and fails nothing", () => {
    const output = jsonOutput([
      finding({
        claim:
          "applyRefund never checks amountCents against order.paidCents — a caller can refund an amount that exceeds the order",
        verdict: "DECLINED",
        severity: "blocking",
        probes: {
          guard: "assertRefundable rejects amountCents above order.paidCents minus refunds",
          reachability: "handleRefund is the only production caller and calls it first",
          remedy: "n/a",
          callers: "handleRefund",
          scope: "introduced — added line in the refundController.ts:18 hunk",
        },
      }),
    ]);

    const r = reviewConditional(output, [BOUND_DECOY]);
    assert.deepEqual(
      r.routed.map((x) => x.phrase),
      [BOUND_DECOY.phrase]
    );
    assert.deepEqual(r.misrouted, []);
    assert.deepEqual(r.notRaised, []);
  });

  it("routes a declined decoy on the prose path", () => {
    const prose = [
      "Finding 1 — verdict: DECLINED (defect, blocking)",
      "The claim is that applyRefund never rejects a refund that exceeds order.paidCents.",
      "assertRefundable already rejects any amount above paidCents minus refunds.",
    ].join("\n");

    const r = reviewConditional(prose, [BOUND_DECOY]);
    assert.deepEqual(
      r.routed.map((x) => x.phrase),
      [BOUND_DECOY.phrase]
    );
    assert.deepEqual(r.misrouted, []);
    assert.deepEqual(r.notRaised, []);
  });

  it("never matches a keyword that appears only inside probes", () => {
    // The finding is about the ledger ordering; it merely LOOKED at the bound
    // check while probing. Matching the whole object would hand this finding's
    // CONFIRMED verdict to the bait's answer key and fail the eval for a defect
    // the verifier got right.
    const output = jsonOutput([
      finding({
        claim: "order.refundedCents is written before the ledger entry",
        quote: "order.refundedCents += amountCents;",
        verdict: "CONFIRMED",
        probes: {
          guard: "applyRefund is preceded by assertRefundable, which bounds paidCents",
          reachability: "handleRefund",
          remedy: "",
          callers: "handleRefund",
          scope: "introduced",
        },
      }),
    ]);

    const r = reviewConditional(output, [BOUND_DECOY]);
    assert.deepEqual(
      r.notRaised,
      [BOUND_DECOY.phrase],
      "probes record what was investigated, not what the finding claims — matching them " +
        "binds an answer key to a finding that never made its claim"
    );
    assert.deepEqual(r.misrouted, []);
  });

  it("misroutes a CONFIRMED decoy on the JSON path", () => {
    const output = jsonOutput([
      finding({
        claim:
          "nothing bounds amountCents: applyRefund never rejects an amount that exceeds order.paidCents",
        verdict: "CONFIRMED",
        severity: "blocking",
      }),
    ]);

    const r = reviewConditional(output, [BOUND_DECOY]);
    assert.deepEqual(
      r.misrouted,
      [
        {
          phrase: BOUND_DECOY.phrase,
          expected: "not verdict CONFIRMED, kind defect",
          got: "verdict CONFIRMED, kind defect",
        },
      ],
      "a verifier that passes through a finding a reachable guard closes is the failure this " +
        "pipeline exists to prevent — scoring it as routed, or as never raised, hides exactly " +
        "the rubber stamp the DECLINED path was built to catch"
    );
    assert.deepEqual(r.routed, []);
    assert.deepEqual(r.notRaised, []);
  });

  it("reports a PARTIAL decoy as inconclusive, not as a failure, on the prose path", () => {
    const prose = [
      "Finding 2 — verdict: PARTIAL (defect)",
      "If order.paidAt is unset, daysSince returns NaN and the window comparison is false,",
      "so a stale order would be refundable.",
    ].join("\n");

    const r = reviewConditional(prose, [PAIDAT_DECOY]);
    assert.deepEqual(
      r.misrouted,
      [],
      "only a rubber stamp fails a bait: a narrowed PARTIAL is a judgement about the claim, " +
        "not the pass-through this pipeline exists to catch"
    );
    assert.deepEqual(r.routed, []);
    assert.deepEqual(
      r.inconclusive.map((i) => i.phrase),
      [PAIDAT_DECOY.phrase]
    );
  });

  it("routes the policy item on kind alone, whatever verdict it carries", () => {
    // No worker prompt can emit a non-defect, so this arrives only as a defect the
    // verifier reclassified. Grading its verdict would red the eval for a
    // reclassification that is exactly what was asked for.
    const output = jsonOutput([
      finding({
        claim: "daysSince(order.paidAt) > REFUND_WINDOW_DAYS hard-codes a 90-day policy",
        verdict: "CONFIRMED",
        kind: "business-decision",
      }),
    ]);

    const r = reviewConditional(output, [POLICY_ITEM]);
    assert.deepEqual(
      r.routed.map((x) => x.phrase),
      [POLICY_ITEM.phrase]
    );
    assert.deepEqual(r.misrouted, []);
  });

  it("reports the policy item as inconclusive when the kind is wrong, never as a failure", () => {
    const output = jsonOutput([
      finding({
        claim: "daysSince(order.paidAt) > REFUND_WINDOW_DAYS hard-codes a 90-day policy",
        verdict: "CONFIRMED",
        kind: "defect",
        severity: "blocking",
      }),
    ]);

    const r = reviewConditional(output, [POLICY_ITEM]);
    assert.deepEqual(
      r.misrouted,
      [],
      "the policy item forbids nothing: a key that also sweeps a real defect about the same " +
        "constant must not fail the run for it"
    );
    assert.deepEqual(r.routed, []);
    assert.deepEqual(
      r.inconclusive,
      [{ phrase: POLICY_ITEM.phrase, got: ["verdict CONFIRMED, kind defect"] }],
      "raised, nothing wanted matched — reported with what was claimed instead, and not scored"
    );
  });

  it("scores an absent item as `notRaised` on the JSON path, and fails nothing", () => {
    const output = jsonOutput([
      finding({ claim: "order.refundedCents is written before writeLedgerEntry" }),
    ]);

    const r = reviewConditional(output, [PAIDAT_DECOY]);
    assert.deepEqual(
      r.notRaised,
      [PAIDAT_DECOY.phrase],
      "no worker raised the bait, so the verifier was never asked — inconclusive, not a pass"
    );
    assert.deepEqual(r.routed, []);
    assert.deepEqual(r.misrouted, [], "an unraised item must never be reported as a failure");
  });

  it("scores an absent item as `notRaised` on the prose path", () => {
    const prose =
      "Finding 1 — verdict: CONFIRMED (defect)\nrefundedCents is written before the ledger entry.";

    const r = reviewConditional(prose, [PAIDAT_DECOY]);
    assert.deepEqual(r.notRaised, [PAIDAT_DECOY.phrase]);
    assert.deepEqual(r.misrouted, []);
  });

  it("separates the four states across several items in one output", () => {
    const output = jsonOutput([
      finding({
        claim: "applyRefund does not reject an amountCents that exceeds order.paidCents",
        verdict: "DECLINED",
      }),
      finding({
        claim: "daysSince(order.paidAt) yields NaN when paidAt is unset",
        verdict: "CONFIRMED",
      }),
    ]);

    const untaken: ConditionalItem = {
      phrase: "bait nobody took",
      keywords: ["legacyRefund", "transaction"],
      want: { verdict: "DECLINED" },
      forbid: { verdict: "CONFIRMED", kind: "defect" },
    };

    const r = reviewConditional(output, [BOUND_DECOY, PAIDAT_DECOY, untaken]);
    assert.deepEqual(
      r.routed.map((x) => x.phrase),
      [BOUND_DECOY.phrase]
    );
    assert.deepEqual(r.misrouted, [
      {
        phrase: PAIDAT_DECOY.phrase,
        expected: "not verdict CONFIRMED, kind defect",
        got: "verdict CONFIRMED, kind defect",
      },
    ]);
    assert.deepEqual(r.inconclusive, []);
    assert.deepEqual(r.notRaised, [untaken.phrase]);
  });

  it("reports a raised item whose only hit is an unrelated caveat as inconclusive", () => {
    // The fourth state, and the reason it exists: a key about the window check
    // also matches a caveat about files that are missing from the workspace.
    // PARTIAL and external-confirmation are neither wanted nor forbidden, so the
    // bait is neither routed nor failed — it was simply never adjudicated.
    const output = jsonOutput([
      finding({
        claim:
          "Correctness, broader caveat: order.ts and clock.ts do not exist here, so the daysSince and paidAt findings rest on assumptions",
        verdict: "PARTIAL",
        kind: "external-confirmation",
      }),
    ]);

    const r = reviewConditional(output, [PAIDAT_DECOY]);
    assert.deepEqual(r.misrouted, [], "a neighbour's PARTIAL must never fail a bait");
    assert.deepEqual(r.routed, []);
    assert.deepEqual(r.inconclusive, [
      { phrase: PAIDAT_DECOY.phrase, got: ["verdict PARTIAL, kind external-confirmation"] },
    ]);
  });

  it("treats a raised item with no readable verdict as inconclusive, not routed", () => {
    const output = jsonOutput([
      finding({
        claim: "applyRefund never rejects an amountCents that exceeds order.paidCents",
        verdict: "",
      }),
    ]);

    const r = reviewConditional(output, [BOUND_DECOY]);
    assert.deepEqual(
      r.inconclusive,
      [{ phrase: BOUND_DECOY.phrase, got: ["verdict NONE, kind defect"] }],
      "an unreadable verdict is not a declining one, and it is not a rubber stamp either"
    );
    assert.deepEqual(r.routed, []);
    assert.deepEqual(r.misrouted, []);
  });

  it("reports nothing when the fixture carries no conditional items", () => {
    const r = reviewConditional(jsonOutput([finding({})]), []);
    assert.deepEqual(r, { routed: [], misrouted: [], inconclusive: [], notRaised: [] });
  });

  it("never counts a conditional item in blockingCount", () => {
    // A declined decoy is excluded because DECLINED is excluded — the same rule
    // that keeps synthesis and the blocking line in step.
    const declinedDecoy = jsonOutput([
      finding({
        claim: "applyRefund never rejects an amountCents that exceeds order.paidCents",
        verdict: "DECLINED",
        kind: "defect",
        severity: "blocking",
      }),
    ]);
    assert.deepEqual(
      reviewConditional(declinedDecoy, [BOUND_DECOY]).routed.map((x) => x.phrase),
      [BOUND_DECOY.phrase]
    );
    assert.equal(
      reviewVerdicts(declinedDecoy, []).blockingCount,
      0,
      "bait the verifier correctly declined must not inflate the number of blocking findings"
    );

    // A misrouted decoy is caught by `misrouted`, which fails the eval.
    // blockingCount is left reporting what the verifier actually said: subtracting
    // these there would make the number disagree with the verdict line it
    // validates, and would hide the failure instead of surfacing it.
    const stampedDecoy = jsonOutput([
      finding({
        claim: "applyRefund never rejects an amountCents that exceeds order.paidCents",
        verdict: "CONFIRMED",
        kind: "defect",
        severity: "blocking",
      }),
    ]);
    assert.equal(reviewConditional(stampedDecoy, [BOUND_DECOY]).misrouted.length, 1);
  });
});

// ── claim-once attribution ────────────────────────────────────────────────────

describe("claim-once attribution across scorers", () => {
  /**
   * One finding that satisfies two keys at once. The bait is about paidAt going
   * NaN, and it names the window constant it claims to bypass — which is exactly
   * what the policy key matches on. Graded twice, this single finding is both
   * correctly-declined bait and a policy call misclassified as a defect, and the
   * eval fails on a verifier that did the right thing.
   */
  const AMBIGUOUS = jsonOutput([
    finding({
      claim:
        "daysSince(order.paidAt) returns NaN for an unset paidAt, so REFUND_WINDOW_DAYS never rejects the order",
      verdict: "DECLINED",
      kind: "defect",
    }),
  ]);

  it("attributes a doubly-matching finding to the first key only", () => {
    const claimed: ClaimedFindings = new Set();
    const r = reviewConditional(AMBIGUOUS, [PAIDAT_DECOY, POLICY_ITEM], claimed);

    assert.deepEqual(
      r.routed.map((x) => x.phrase),
      [PAIDAT_DECOY.phrase],
      "the bait is listed first, so it claims the finding"
    );
    assert.deepEqual(
      r.notRaised,
      [POLICY_ITEM.phrase],
      "the policy key must find nothing left to grade — the finding is already answered"
    );
    assert.deepEqual(r.misrouted, [], "a claimed finding must never fail a later key");
  });

  it("satisfies both keys when the output carries two distinct findings", () => {
    const claimed: ClaimedFindings = new Set();
    const output = jsonOutput([
      finding({
        claim: "daysSince(order.paidAt) returns NaN for an unset paidAt and skips the window",
        verdict: "DECLINED",
        kind: "defect",
      }),
      finding({
        // Named the way a real policy finding names itself: the declaration and
        // the window length, with no reference to the guard line the bait quotes.
        claim: "REFUND_WINDOW_DAYS = 90 is a business decision about window length",
        quote: "+export const REFUND_WINDOW_DAYS = 90;",
        verdict: "CONFIRMED",
        kind: "business-decision",
      }),
    ]);

    const r = reviewConditional(output, [PAIDAT_DECOY, POLICY_ITEM], claimed);
    assert.deepEqual(
      r.routed.map((x) => x.phrase).sort(),
      [PAIDAT_DECOY.phrase, POLICY_ITEM.phrase].sort()
    );
    assert.deepEqual(r.notRaised, []);
    assert.deepEqual(r.misrouted, []);
  });

  it("lets an expectation claim a finding before a conditional key sees it", () => {
    const ordering = expectationFor("real ordering defect");
    const claimed: ClaimedFindings = new Set();
    const output = jsonOutput([
      finding({
        claim:
          "order.refundedCents is written before the ledger entry, and applyRefund never rejects an amount that exceeds order.paidCents",
        verdict: "CONFIRMED",
        kind: "defect",
      }),
    ]);

    const v = reviewVerdicts(output, [ordering], claimed);
    const c = reviewConditional(output, [BOUND_DECOY], claimed);

    assert.deepEqual(v.correct, [ordering.phrase]);
    assert.deepEqual(
      c.notRaised,
      [BOUND_DECOY.phrase],
      "a required expectation outranks bait for a finding both could match"
    );
    assert.deepEqual(c.misrouted, []);
  });

  it("claims every copy of a finding, so a second copy cannot leak to a later key", () => {
    // Two workers review the same diff, so the same bait arrives twice. One of
    // them rubber-stamped it, and that copy is the failure — a key that claimed
    // only the first would report the item routed and hand the author the stamp.
    const claimed: ClaimedFindings = new Set();
    const output = jsonOutput([
      finding({
        claim: "Correctness — applyRefund never rejects an amount that exceeds order.paidCents",
        verdict: "DECLINED",
        kind: "defect",
      }),
      finding({
        claim: "Security — applyRefund never rejects an amount that exceeds order.paidCents",
        verdict: "CONFIRMED",
        kind: "defect",
        severity: "blocking",
      }),
    ]);

    const r = reviewConditional(output, [BOUND_DECOY], claimed);
    assert.deepEqual(
      r.misrouted,
      [
        {
          phrase: BOUND_DECOY.phrase,
          expected: "not verdict CONFIRMED, kind defect",
          got: "verdict CONFIRMED, kind defect",
        },
      ],
      "one worker declining the bait does not excuse another confirming it"
    );
    assert.deepEqual(r.routed, [], "an item with any failing copy is not routed");
    assert.deepEqual(r.notRaised, []);
  });

  it("fails a bait only on the rubber stamp, and routes it despite a neighbouring PARTIAL", () => {
    // One bait, three shapes of company. A CONFIRMED defect is the rubber stamp
    // and fails. An external-confirmation PARTIAL is a different finding about the
    // same lines and must not. A lone PARTIAL defect adjudicates nothing.
    const stamped = reviewConditional(
      jsonOutput([
        finding({
          claim: "Correctness — applyRefund never rejects an amount that exceeds order.paidCents",
          verdict: "DECLINED",
          kind: "defect",
        }),
        finding({
          claim: "Security — applyRefund never rejects an amount that exceeds order.paidCents",
          verdict: "CONFIRMED",
          kind: "defect",
        }),
      ]),
      [BOUND_DECOY],
      new Set()
    );
    assert.equal(stamped.misrouted.length, 1, `misrouted: ${JSON.stringify(stamped.misrouted)}`);
    assert.match(stamped.misrouted[0].got, /CONFIRMED/);
    assert.deepEqual(stamped.routed, []);

    const withCaveat = reviewConditional(
      jsonOutput([
        finding({
          claim: "Correctness — applyRefund never rejects an amount that exceeds order.paidCents",
          verdict: "DECLINED",
          kind: "defect",
        }),
        finding({
          claim:
            "Caveat — applyRefund and the guard that exceeds-checks it live in files not present here",
          verdict: "PARTIAL",
          kind: "external-confirmation",
        }),
      ]),
      [BOUND_DECOY],
      new Set()
    );
    assert.deepEqual(
      withCaveat.routed.map((x) => x.phrase),
      [BOUND_DECOY.phrase],
      "the bait was declined; a caveat swept up beside it changes nothing"
    );
    assert.deepEqual(withCaveat.misrouted, []);

    const narrowedOnly = reviewConditional(
      jsonOutput([
        finding({
          claim: "applyRefund never rejects an amount that exceeds order.paidCents in some paths",
          verdict: "PARTIAL",
          kind: "defect",
        }),
      ]),
      [BOUND_DECOY],
      new Set()
    );
    assert.deepEqual(
      narrowedOnly.inconclusive.map((i) => i.phrase),
      [BOUND_DECOY.phrase]
    );
    assert.deepEqual(narrowedOnly.misrouted, []);
    assert.deepEqual(narrowedOnly.routed, []);
  });

  it("grades every key independently when no claimed set is passed", () => {
    // The set is opt-in: the single-key unit tests above pass none, and must keep
    // seeing the finding they were written against.
    const r = reviewConditional(AMBIGUOUS, [PAIDAT_DECOY, POLICY_ITEM]);
    assert.equal(
      r.routed.length + r.inconclusive.length,
      2,
      "both keys matched the one finding: the bait routes it, the policy key reports it unadjudicated"
    );
  });
});

// ── regression: the real verifier output of 2026-09-13 ────────────────────────

describe("code-review-citations scored against a real verify run (2026-09-13)", () => {
  // Verbatim `verify.json` from a live run of the code-review pipeline over this
  // fixture. The run was RIGHT and the answer key was wrong: two workers each
  // raised the NaN bait, and the policy key — then keyed on the window-check
  // line's identifiers — took the security worker's copy of that bait instead of
  // the genuine policy finding, reporting a misroute for a verifier that had
  // classified everything correctly. Kept as a file, not as a paraphrase: a
  // paraphrase is a second answer key, and it is the paraphrasing that fails.
  const output = readFileSync(join(FIXTURES_DIR, "verify-2026-09-13.json"), "utf8");

  it("grades the run as the clean sweep it was", () => {
    const claimed: ClaimedFindings = new Set();
    const v = reviewVerdicts(output, codeReviewCitations.expectations, claimed);
    const c = reviewConditional(output, codeReviewCitations.conditional, claimed);

    assert.equal(v.correct.length, 1, `correct: ${JSON.stringify(v.correct)}`);
    assert.deepEqual(v.wrong, [], "no expectation may be graded against the wrong finding");
    assert.deepEqual(v.missing, [], "the ordering defect was raised, twice over");

    assert.equal(c.routed.length, 3, `routed: ${JSON.stringify(c.routed.map((r) => r.phrase))}`);
    assert.deepEqual(
      c.misrouted,
      [],
      "every bait was declined and the policy call was classified — a misroute here is the " +
        "answer key failing, not the pipeline"
    );
    assert.deepEqual(c.notRaised, []);
  });
});

// ── regression: the real verifier output of run 2 (2026-09-13) ───────────────

describe("code-review-citations scored against a real verify run (run 2, 2026-09-13)", () => {
  // The run that motivated `want`/`forbid`. Verbatim again, for the same reason.
  const output = readFileSync(join(FIXTURES_DIR, "verify-2026-09-13-run2.json"), "utf8");

  it("routes all three conditional items, failing nothing", () => {
    const claimed: ClaimedFindings = new Set();
    reviewVerdicts(output, codeReviewCitations.expectations, claimed);
    const c = reviewConditional(output, codeReviewCitations.conditional, claimed);

    assert.equal(c.routed.length, 3, `routed: ${JSON.stringify(c.routed.map((r) => r.phrase))}`);
    assert.deepEqual(
      c.misrouted,
      [],
      "the NaN bait's key also swept a caveat about missing files, PARTIAL and " +
        "external-confirmation — neither the rubber stamp it forbids nor the DECLINED it wants"
    );
    assert.deepEqual(c.inconclusive, [], "every item had a hit matching what it wants");
    assert.deepEqual(c.notRaised, []);
  });

  it("documents the ambiguity this fixture's diff was changed to remove", () => {
    // On THIS diff — the one without saveOrder — the verifier narrowed the
    // ordering claim to PARTIAL and said why: applyRefund's shown body persists
    // nothing, so a durable two-store divergence was not established. That is a
    // correct PARTIAL under FR-009 and a wrong answer only because the fixture
    // over-claimed. The diff now persists the order before the ledger write, so
    // the narrowing evidence no longer exists; this test keeps the old output as
    // the record of why.
    const claimed: ClaimedFindings = new Set();
    const v = reviewVerdicts(output, codeReviewCitations.expectations, claimed);

    assert.equal(v.wrong.length, 1, `wrong: ${JSON.stringify(v.wrong)}`);
    assert.match(v.wrong[0].expected, /CONFIRMED/);
    assert.match(v.wrong[0].actual, /PARTIAL/);
  });
});

// ── verify step output → scorer ───────────────────────────────────────────────

describe("stepOutputText", () => {
  // The verify step declares `schema: codeReviewFindings`, so its entry in the
  // accumulated context is the PARSED OBJECT, never a string. Reading it with a
  // `typeof === "string"` test produced "" on every successful run, and the eval
  // runner exited 1 before any verdict was ever scored.
  const verifyStepOutput: unknown = {
    codeReviewFindings: [
      finding({
        claim: "order.refundedCents is updated before the ledger write",
        verdict: "CONFIRMED",
        severity: "blocking",
      }),
      finding({
        claim: "the 90-day REFUND_WINDOW_DAYS value is a finance policy call",
        verdict: "CONFIRMED",
        kind: "business-decision",
        severity: "major",
      }),
    ],
  };

  it("carries a schema-gated step's object output through to the scorer", () => {
    const text = stepOutputText(verifyStepOutput);
    assert.ok(
      text.length > 0,
      "a schema-gated step stores an object; dropping it leaves the eval nothing to score"
    );

    const r = reviewVerdicts(text, [expectationFor("real ordering defect"), POLICY_EXPECTATION]);
    assert.equal(
      r.accuracy,
      1,
      `wrong: ${JSON.stringify(r.wrong)} missing: ${r.missing.join(", ")}`
    );
    assert.equal(r.blockingCount, 1, "the business-decision item is excluded from the count");
  });

  it("passes a plain string step output through unchanged", () => {
    assert.equal(stepOutputText("verdict: CONFIRMED"), "verdict: CONFIRMED");
  });

  it("reports empty text for a step that produced nothing", () => {
    assert.equal(stepOutputText(undefined), "");
    assert.equal(stepOutputText(null), "");
  });
});

// ── code-review-citations fixture: anti-rot guard ─────────────────────────────

describe("code-review-citations fixture: expectation identifiers are present in the diff", () => {
  const diffLower = codeReviewCitations.diff.toLowerCase();

  for (const exp of codeReviewCitations.expectations) {
    it(`expectation "${exp.phrase}" names at least one identifier`, () => {
      assert.ok(
        exp.identifiers.length > 0,
        "an expectation with no identifier cannot be checked against the diff at all"
      );
    });

    for (const id of exp.identifiers) {
      it(`expectation "${exp.phrase}" identifier "${id}" is in the diff`, () => {
        assert.ok(
          diffLower.includes(id.toLowerCase()),
          `identifier "${id}" must appear in the fixture diff — a verifier cannot cite what is not there; update the diff or the identifier`
        );
      });
    }
  }

  // Two keywords minimum, both present in the diff. One keyword is enough for an
  // unrelated finding to latch onto an answer key — that is how the policy item's
  // single `REFUND_WINDOW_DAYS` key ended up graded against a decoy — and a
  // keyword the diff never contains cannot be reached by a verifier that only
  // ever sees the diff.
  const keyedItems: { label: string; item: KeyedItem }[] = [
    ...codeReviewCitations.expectations.map((e) => ({
      label: `expectation "${e.phrase}"`,
      item: e,
    })),
    ...codeReviewCitations.conditional.map((c) => ({
      label: `conditional "${c.phrase}"`,
      item: c,
    })),
  ];

  for (const { label, item } of keyedItems) {
    it(`${label} carries at least two keywords`, () => {
      assert.ok(
        item.keywords.length >= 2,
        `a single keyword identifies a finding only by luck — ${label} needs two or more`
      );
    });

    for (const kw of item.keywords) {
      it(`${label} keyword "${kw}" is in the diff`, () => {
        assert.ok(
          diffLower.includes(kw.toLowerCase()),
          `keyword "${kw}" must appear in the fixture diff — nothing the verifier is shown can produce it; update the diff or the keyword`
        );
      });
    }
  }

  // A hunk header that disagrees with its body tells the verifier the listing is
  // elided, and a verifier that doubts the listing hedges every finding drawn
  // from it. The live run of 2026-09-13 did exactly that, in three findings at
  // once: "the hunk header declares 48 added lines and only 38 appear".
  interface CountedHunk {
    header: string;
    declaredOld: number;
    declaredNew: number;
    countedOld: number;
    countedNew: number;
  }

  function countHunks(diff: string): CountedHunk[] {
    const lines = diff.replace(/\n$/, "").split("\n");
    const hunks: CountedHunk[] = [];
    let i = 0;
    while (i < lines.length) {
      const header = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(lines[i]);
      if (header === null) {
        i += 1;
        continue;
      }
      let context = 0;
      let removed = 0;
      let added = 0;
      let j = i + 1;
      for (; j < lines.length; j += 1) {
        const line = lines[j];
        if (line.startsWith("@@") || line.startsWith("diff --git")) break;
        if (line.startsWith("+")) added += 1;
        else if (line.startsWith("-")) removed += 1;
        else context += 1;
      }
      hunks.push({
        header: lines[i],
        declaredOld: Number(header[1] ?? "1"),
        declaredNew: Number(header[2] ?? "1"),
        countedOld: context + removed,
        countedNew: context + added,
      });
      i = j;
    }
    return hunks;
  }

  const hunks = countHunks(codeReviewCitations.diff);

  it("the diff declares at least one hunk", () => {
    assert.ok(hunks.length > 0, "a diff with no parsable hunk header cannot be checked at all");
  });

  for (const hunk of hunks) {
    it(`hunk header counts match the body: ${hunk.header.slice(0, 40)}`, () => {
      assert.equal(
        hunk.countedOld,
        hunk.declaredOld,
        `${hunk.header} declares ${hunk.declaredOld.toString()} pre-image lines, body has ${hunk.countedOld.toString()}`
      );
      assert.equal(
        hunk.countedNew,
        hunk.declaredNew,
        `${hunk.header} declares ${hunk.declaredNew.toString()} post-image lines, body has ${hunk.countedNew.toString()} — a verifier reading this concludes the listing is elided and hedges every finding drawn from it`
      );
    });
  }

  // ANSWER-KEY DISCIPLINE: a model scores by copying a comment that states the
  // answer, not by verifying anything. The diff may carry ordinary code comments
  // and must carry none that names the defect, the owner or the remedy.
  const PLANTED_ANSWER_MARKERS = [
    "bug:",
    "fixme",
    "todo",
    "hack:",
    "xxx",
    "owner:",
    "business-decision",
    "policy",
    "race condition",
    "should be",
  ];

  for (const marker of PLANTED_ANSWER_MARKERS) {
    it(`fixture diff plants no answer: "${marker}" does not appear`, () => {
      assert.ok(
        !diffLower.includes(marker),
        `"${marker}" in the diff hands the verifier its answer — it would score by copying a comment instead of verifying the code`
      );
    });
  }

  it("every conditional item says what a correct adjudication looks like", () => {
    for (const c of codeReviewCitations.conditional) {
      assert.ok(
        c.want.verdict !== undefined || c.want.kind !== undefined,
        `conditional "${c.phrase}" wants nothing — it can never be routed, only counted`
      );
    }
  });

  it("covers what it claims to: a real defect, the business-decision case, and the DECLINED path", () => {
    // Criteria 1, 2 and 5 (seeded WRONG claims) are covered by the reviewVerdicts
    // unit tests above, not here: nothing in the live pipeline can make a
    // reviewer raise a false claim for the verifier to disprove.
    assert.ok(
      codeReviewCitations.expectations.some(
        (e) => e.expectedKind === "defect" && e.expectedVerdict === "CONFIRMED"
      ),
      "at least one real defect the verifier must CONFIRM on the merits"
    );
    assert.ok(
      codeReviewCitations.conditional.some((c) => c.want.kind === "business-decision"),
      "at least one business-decision item (criterion 4) — conditional, because audit's worker " +
        "prompts omit non-defects by instruction, so it reaches verify only as a reclassification"
    );
    assert.ok(
      !codeReviewCitations.expectations.some((e) => e.expectedVerdict === "DECLINED"),
      "a DECLINED expectation cannot be reached end to end — the wrong claim it adjudicates " +
        "is never raised, so the eval would fail by construction at verdictAccuracy = 1"
    );
    // Bait is how the DECLINED path is reached instead: it is scored three-state,
    // so bait nobody takes costs nothing and only a misroute fails.
    assert.ok(
      codeReviewCitations.conditional.some((c) => c.want.verdict === "DECLINED"),
      "without bait the DECLINED path is never exercised end to end, and a verifier that " +
        "declines nothing is indistinguishable from a rubber stamp"
    );
  });

  for (const p of codeReviewCitations.expectedPaths) {
    it(`answer-key path exists: ${p}`, () => {
      assert.ok(
        existsSync(join(REPO_ROOT, p)),
        `answer-key path does not exist: ${p} — update the fixture`
      );
    });
  }
});
