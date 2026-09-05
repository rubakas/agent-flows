import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import bugMissingDetail from "./fixtures/bug-missing-detail.js";
import featureCollision from "./fixtures/feature-collision.js";
import { citedPathsExist, existingFunctionalityNamed, plantedGapsFound } from "./scorers.js";

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

  it("treats a directory as invented — only real files count as citations", () => {
    const result = citedPathsExist(
      "The logic lives in src/canon and src/canon/nest.ts.",
      REPO_ROOT
    );
    assert.deepEqual(result.invented, ["src/canon"]);
    assert.deepEqual(result.found, ["src/canon/nest.ts"]);
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
    Gap: workspace and write access are not yet implemented in runStep.
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
