import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import auditPlantedDefects from "./fixtures/audit-planted-defects.js";
import bugMissingDetail from "./fixtures/bug-missing-detail.js";
import featureCollision from "./fixtures/feature-collision.js";
import { assertReadOnly } from "./safetyGuard.js";
import {
  auditDefectsFound,
  citedPathsExist,
  existingFunctionalityNamed,
  plantedGapsFound,
} from "./scorers.js";
import type { LoadedPipeline } from "../canon/types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// Two levels up from src/evals/ → repo root.
const REPO_ROOT = join(__dirname, "..", "..");

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
