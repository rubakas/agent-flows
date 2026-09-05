#!/usr/bin/env tsx
// Eval runner for read-only pipelines.
//
// Usage: tsx src/evals/run.ts <fixture-name>
// Available fixtures: bug-missing-detail, feature-collision
//
// Thresholds (exit non-zero if any falls below):
//   citedPathsExist      ≥ 50% — anti-hallucination: cited paths must mostly exist
//   plantedGapsFound     ≥ 50% — at least half the planted gaps must be surfaced
//   existingFunctionality ≥ 50% — at least half the existing impls must be identified
//
// SAFETY: refuses any pipeline containing a step with permissions.contents:write or kind:check.
// Those pipelines write files in the owner's working repo or execute shell commands.

// MUST be the very first line: disable Mastra telemetry before any @mastra import.
process.env.MASTRA_TELEMETRY_DISABLED = "1";

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Mastra } from "@mastra/core/mastra";
import { LibSQLStore } from "@mastra/libsql";
import { buildPipelineWorkflow } from "../bindings/mastra/build.js";
import { mastraDbPath } from "../bindings/mastra/paths.js";
import { loadPipeline } from "../canon/load.js";
import { defaultRegistry, getProfile } from "../canon/registry.js";
import { makeDb } from "../db/index.js";
import { DrizzleTicketStore } from "../store/sqlite.js";
import { assertReadOnly } from "./safetyGuard.js";
import { citedPathsExist, existingFunctionalityNamed, plantedGapsFound } from "./scorers.js";
import type { KeyedItem } from "./scorers.js";

// ── Types ─────────────────────────────────────────────────────────────────────

interface EvalFixture {
  seedPrompt: string;
  expectedExisting: KeyedItem[];
  expectedGaps: KeyedItem[];
  /** Every path listed here must exist in the repo (anti-rot assertion). */
  expectedPaths: string[];
}

// ── Thresholds ────────────────────────────────────────────────────────────────
// 50% across the board: these are minimum baselines, not quality bars.
// The verbatim output (which items passed/missed) is the most valuable signal.

const THRESHOLDS = {
  citedPathsExist: 0.5,
  plantedGapsFound: 0.5,
  existingFunctionalityNamed: 0.5,
} as const;

// ── Paths ─────────────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = join(__dirname, "..", "..");
const pipelinesDir = join(repoRoot, "pipelines");

// ── CLI args ──────────────────────────────────────────────────────────────────

const KNOWN_FIXTURES = ["bug-missing-detail", "feature-collision"] as const;

const fixtureName = process.argv[2];
if (!fixtureName || !(KNOWN_FIXTURES as readonly string[]).includes(fixtureName)) {
  console.error(`Usage: tsx src/evals/run.ts <fixture>`);
  console.error(`Available fixtures: ${KNOWN_FIXTURES.join(", ")}`);
  process.exit(1);
}

// ── Error extraction (mirrors smoke.ts) ──────────────────────────────────────

function extractRunError(runResult: unknown): string {
  const r = runResult as Record<string, unknown> | undefined;
  if (!r) return "unknown error";
  const steps = r.steps as Record<string, Record<string, unknown>> | undefined;
  if (steps) {
    for (const [stepId, step] of Object.entries(steps)) {
      if (step.status === "failed") {
        const err = step.error as { message?: string } | undefined;
        return `Step "${stepId}" failed: ${err?.message ?? "unknown error"}`;
      }
    }
  }
  const errField = r.error as { message?: string } | undefined;
  if (errField?.message) return errField.message;
  return "run did not succeed";
}

// ── Setup ─────────────────────────────────────────────────────────────────────

const dbPath = `/tmp/yoke-eval-${fixtureName}.sqlite`;
const mastraDb = mastraDbPath(dbPath);
const providerId = process.env.YOKE_PROVIDER ?? "anthropic";
const profile = getProfile(providerId);
const registry = defaultRegistry();

console.log(`\nEval: fixture=${fixtureName} provider=${providerId}`);

// ── Load fixture ──────────────────────────────────────────────────────────────

const { default: fixture } = (await import(`./fixtures/${fixtureName}.js`)) as {
  default: EvalFixture;
};

// Anti-rot: all expectedPaths must exist on disk today.
for (const p of fixture.expectedPaths) {
  if (!existsSync(join(repoRoot, p))) {
    console.error(`FIXTURE ERROR: expectedPaths entry "${p}" does not exist — fixture is stale`);
    process.exit(1);
  }
}

// ── Load pipeline ─────────────────────────────────────────────────────────────

const investigatePath = join(pipelinesDir, "investigate.yaml");
const loaded = loadPipeline(investigatePath);

// Safety guard: refuse pipelines with any writing or shell-exec steps (including loop bodies).
assertReadOnly(loaded);

const llmStepCount = loaded.def.steps.filter((s) => s.kind === "llm").length;
console.log(
  `Pipeline: ${loaded.def.id} (${llmStepCount.toString()} LLM steps → ~${llmStepCount.toString()} model calls)`
);

// ── Run ───────────────────────────────────────────────────────────────────────

const mastraStorage = new LibSQLStore({ id: "yoke-eval", url: `file:${mastraDb}` });
const yokeDb = makeDb(dbPath);
const store = new DrizzleTicketStore(yokeDb);

const wf = buildPipelineWorkflow(loaded, { registry, store, profile, cwd: repoRoot });
const mastra = new Mastra({ storage: mastraStorage, workflows: { [loaded.def.id]: wf } });
const mastraWf = mastra.getWorkflow(loaded.def.id);

const run = await mastraWf.createRun();

console.log(`\nSeed prompt: "${fixture.seedPrompt}"`);
console.log("\nRunning…\n");

const startTime = Date.now();
const r1 = await run.start({ inputData: { request: fixture.seedPrompt } });
const elapsedMs = Date.now() - startTime;

if (r1.status !== "success") {
  const errMsg = extractRunError(r1);
  console.error(`\nRUN FAILED: ${errMsg}`);
  process.exit(1);
}

const result = r1.result as Record<string, unknown>;

// Combine survey + findings: survey cites paths; findings surfaces gaps and existing items.
const surveyText = typeof result.survey === "string" ? result.survey : "";
const findingsText = typeof result.findings === "string" ? result.findings : "";
const fullOutput = [surveyText, findingsText].filter(Boolean).join("\n\n");

if (!fullOutput) {
  console.error("RUN ERROR: no output in result.survey or result.findings");
  process.exit(1);
}

// ── Score ─────────────────────────────────────────────────────────────────────

const pathResult = citedPathsExist(fullOutput, repoRoot);
const gapResult = plantedGapsFound(fullOutput, fixture.expectedGaps);
const existingResult = existingFunctionalityNamed(fullOutput, fixture.expectedExisting);

// ── Report ────────────────────────────────────────────────────────────────────

const bar = "═".repeat(60);
const fmt = (score: number): string => `${(score * 100).toFixed(0)}%`;
const verdict = (score: number, key: keyof typeof THRESHOLDS): string =>
  score >= THRESHOLDS[key] ? "PASS" : "FAIL";

console.log(`\n${bar}`);
console.log(`EVAL REPORT — ${fixtureName}`);
console.log(
  `Elapsed: ${(elapsedMs / 1000).toFixed(1)}s  |  ~${llmStepCount.toString()} model calls`
);
console.log(`${bar}\n`);

console.log("SCORES");
console.log(
  `  citedPathsExist       ${fmt(pathResult.score).padStart(4)}` +
    `  [≥${fmt(THRESHOLDS.citedPathsExist)}]` +
    `  ${verdict(pathResult.score, "citedPathsExist")}`
);
console.log(
  `  plantedGapsFound      ${fmt(gapResult.score).padStart(4)}` +
    `  [≥${fmt(THRESHOLDS.plantedGapsFound)}]` +
    `  ${verdict(gapResult.score, "plantedGapsFound")}`
);
console.log(
  `  existingFunctionality ${fmt(existingResult.score).padStart(4)}` +
    `  [≥${fmt(THRESHOLDS.existingFunctionalityNamed)}]` +
    `  ${verdict(existingResult.score, "existingFunctionalityNamed")}`
);

console.log(`\nPATHS CITED (${pathResult.total.toString()} total)`);
if (pathResult.total === 0) {
  console.log("  (none cited)");
} else {
  if (pathResult.found.length > 0)
    console.log(
      `  REAL    (${pathResult.found.length.toString()}): ${pathResult.found.join(", ")}`
    );
  if (pathResult.invented.length > 0)
    console.log(
      `  INVENTED (${pathResult.invented.length.toString()}): ${pathResult.invented.join(", ")}`
    );
}

console.log(
  `\nGAPS SURFACED (${gapResult.surfaced.length.toString()}/${fixture.expectedGaps.length.toString()})`
);
for (const g of gapResult.surfaced) console.log(`  + ${g}`);
for (const g of gapResult.missed) console.log(`  - (missed) ${g}`);

console.log(
  `\nEXISTING FUNCTIONALITY IDENTIFIED (${existingResult.identified.length.toString()}/${fixture.expectedExisting.length.toString()})`
);
for (const e of existingResult.identified) console.log(`  + ${e}`);
for (const e of existingResult.missed) console.log(`  - (missed) ${e}`);

// ── Exit ──────────────────────────────────────────────────────────────────────

const failed =
  pathResult.score < THRESHOLDS.citedPathsExist ||
  gapResult.score < THRESHOLDS.plantedGapsFound ||
  existingResult.score < THRESHOLDS.existingFunctionalityNamed;

console.log(`\n${bar}`);
console.log(failed ? "EVAL FAILED — one or more scorers below threshold" : "EVAL PASSED");
console.log(bar);

if (failed) process.exitCode = 1;
