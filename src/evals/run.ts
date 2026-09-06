#!/usr/bin/env tsx
// Eval runner for read-only pipelines.
//
// Usage: tsx src/evals/run.ts <fixture-name>
// Usage: tsx src/evals/run.ts --list   (prints available fixtures and exits)
// Available fixtures: bug-missing-detail, feature-collision, audit-planted-defects
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
import {
  auditDefectsFound,
  citedPathsExist,
  existingFunctionalityNamed,
  plantedGapsFound,
} from "./scorers.js";
import type { KeyedItem } from "./scorers.js";

// ── Types ─────────────────────────────────────────────────────────────────────

interface EvalFixture {
  seedPrompt: string;
  expectedExisting: KeyedItem[];
  expectedGaps: KeyedItem[];
  /** Every path listed here must exist in the repo (anti-rot assertion). */
  expectedPaths: string[];
}

interface AuditFixture {
  /** Diff passed as `plan` input to the audit pipeline. */
  diff: string;
  /** Defects deliberately planted in the diff; the auditor should find all of them. */
  plantedDefects: KeyedItem[];
  /** Code that looks suspicious but is actually fine; auditor must NOT flag these. */
  decoys: KeyedItem[];
  /** Every path listed here must exist in the repo (anti-rot assertion). */
  expectedPaths: string[];
}

type AnyFixture = EvalFixture | AuditFixture;

function isAuditFixture(f: AnyFixture): f is AuditFixture {
  return "diff" in f && typeof (f as AuditFixture).diff === "string";
}

// ── Thresholds ────────────────────────────────────────────────────────────────
// These are quality bars, not baselines. A run that misses half of what it was
// supposed to find should not report success — a lenient threshold makes "PASS"
// mean nothing. The verbatim per-item output remains the most useful signal.
//
// citedPathsExist is 1.0 deliberately: a single fabricated file path is a
// hallucination, and tolerating a fraction of them defeats the check.

const THRESHOLDS = {
  citedPathsExist: 1,
  plantedGapsFound: 0.8,
  existingFunctionalityNamed: 1,
} as const;

// ── Paths ─────────────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = join(__dirname, "..", "..");
const pipelinesDir = join(repoRoot, "pipelines");

// ── CLI args ──────────────────────────────────────────────────────────────────

const KNOWN_FIXTURES = [
  "bug-missing-detail",
  "feature-collision",
  "audit-planted-defects",
] as const;

if (process.argv.includes("--list")) {
  for (const name of KNOWN_FIXTURES) console.log(name);
  process.exit(0);
}

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

const dbPath = `/tmp/agent-flows-eval-${fixtureName}.sqlite`;
const mastraDb = mastraDbPath(dbPath);
const providerId = process.env.AGENT_FLOWS_PROVIDER ?? "anthropic";
const profile = getProfile(providerId);
const registry = defaultRegistry();

console.log(`\nEval: fixture=${fixtureName} provider=${providerId}`);

// ── Load fixture ──────────────────────────────────────────────────────────────

const { default: fixture } = (await import(`./fixtures/${fixtureName}.js`)) as {
  default: AnyFixture;
};

// Anti-rot: all expectedPaths must exist on disk today.
for (const p of fixture.expectedPaths) {
  if (!existsSync(join(repoRoot, p))) {
    console.error(`FIXTURE ERROR: expectedPaths entry "${p}" does not exist — fixture is stale`);
    process.exit(1);
  }
}

// ── Load pipeline ─────────────────────────────────────────────────────────────

const pipelineFile = isAuditFixture(fixture) ? "audit.yaml" : "investigate.yaml";
const loaded = loadPipeline(join(pipelinesDir, pipelineFile));

// Safety guard: refuse pipelines with any writing or shell-exec steps (including loop bodies).
assertReadOnly(loaded);

const llmStepCount = loaded.def.steps.filter((s) => s.kind === "llm").length;
console.log(
  `Pipeline: ${loaded.def.id} (${llmStepCount.toString()} LLM steps → ~${llmStepCount.toString()} model calls)`
);

// ── Run ───────────────────────────────────────────────────────────────────────

const mastraStorage = new LibSQLStore({ id: "agent-flows-eval", url: `file:${mastraDb}` });
const db = makeDb(dbPath);
const store = new DrizzleTicketStore(db);

const wf = buildPipelineWorkflow(loaded, { registry, store, profile, cwd: repoRoot });
const mastra = new Mastra({ storage: mastraStorage, workflows: { [loaded.def.id]: wf } });
const mastraWf = mastra.getWorkflow(loaded.def.id);

const run = await mastraWf.createRun();

if (isAuditFixture(fixture)) {
  console.log(
    `\nDiff: ${fixture.diff.length.toString()} chars, ${fixture.plantedDefects.length.toString()} planted defect(s), ${fixture.decoys.length.toString()} decoy(s)`
  );
} else {
  console.log(`\nSeed prompt: "${fixture.seedPrompt}"`);
}
console.log("\nRunning…\n");

const runInput = isAuditFixture(fixture) ? { plan: fixture.diff } : { request: fixture.seedPrompt };

const startTime = Date.now();
const r1 = await run.start({ inputData: runInput });
const elapsedMs = Date.now() - startTime;

if (r1.status !== "success") {
  const errMsg = extractRunError(r1);
  console.error(`\nRUN FAILED: ${errMsg}`);
  process.exit(1);
}

const result = r1.result as Record<string, unknown>;

// ── Extract output ────────────────────────────────────────────────────────────

let fullOutput: string;
// Audit only: the raw sub-audit text, before synthesis merged and pruned it.
// Scoring the synthesis alone cannot distinguish "never found" from "found then
// dropped", and those call for opposite fixes.
let preSynthesisOutput = "";

if (isAuditFixture(fixture)) {
  const synthesisText = typeof result.synthesis === "string" ? result.synthesis : "";
  if (!synthesisText) {
    console.error("RUN ERROR: no output in result.synthesis");
    process.exit(1);
  }
  fullOutput = synthesisText;
  preSynthesisOutput = [
    typeof result.correctness === "string" ? result.correctness : "",
    typeof result.security === "string" ? result.security : "",
  ]
    .filter(Boolean)
    .join("\n\n");
} else {
  // Combine survey + findings: survey cites paths; findings surfaces gaps and existing items.
  const surveyText = typeof result.survey === "string" ? result.survey : "";
  const findingsText = typeof result.findings === "string" ? result.findings : "";
  fullOutput = [surveyText, findingsText].filter(Boolean).join("\n\n");
  if (!fullOutput) {
    console.error("RUN ERROR: no output in result.survey or result.findings");
    process.exit(1);
  }
}

// ── Score ─────────────────────────────────────────────────────────────────────

const bar = "═".repeat(60);
const fmt = (score: number): string => `${(score * 100).toFixed(0)}%`;

console.log(`\n${bar}`);
console.log(`EVAL REPORT — ${fixtureName}`);
console.log(
  `Elapsed: ${(elapsedMs / 1000).toFixed(1)}s  |  ~${llmStepCount.toString()} model calls`
);
console.log(`${bar}\n`);

let failed: boolean;

if (isAuditFixture(fixture)) {
  // An audit that misses a planted defect has failed at its one job, and a
  // security miss is the expensive kind. A decoy flagged as real is equally a
  // failure: an auditor that reports everything is as useless as one that
  // reports nothing, and downstream correction would act on the noise.
  const AUDIT_RECALL_THRESHOLD = 1;
  const AUDIT_FP_MAX = 0;

  // The synthesis prompt requires a trailing "Dropped" section explaining each
  // finding it excluded. A decoy named there was correctly dismissed, not
  // asserted — scoring that text as a false positive would penalise exactly the
  // behaviour we asked for. Recall reads the whole output; decoys read only the
  // asserted part above that heading.
  const droppedAt = fullOutput.search(/^#{0,4}\s*\**Dropped\b/im);
  const assertedOutput = droppedAt === -1 ? fullOutput : fullOutput.slice(0, droppedAt);

  const recallSide = auditDefectsFound(fullOutput, fixture.plantedDefects, []);
  const decoySide = auditDefectsFound(assertedOutput, [], fixture.decoys);
  const auditResult = { ...recallSide, falsePositives: decoySide.falsePositives };

  const recallVerdict = auditResult.recall >= AUDIT_RECALL_THRESHOLD ? "PASS" : "FAIL";
  const fpVerdict = auditResult.falsePositives.length <= AUDIT_FP_MAX ? "PASS" : "FAIL";

  console.log("SCORES");
  console.log(
    `  recall (defects found) ${fmt(auditResult.recall).padStart(4)}` +
      `  [≥${fmt(AUDIT_RECALL_THRESHOLD)}]` +
      `  ${recallVerdict}`
  );
  console.log(
    `  false positives        ${auditResult.falsePositives.length.toString().padStart(4)}` +
      `  [≤${AUDIT_FP_MAX.toString()}]` +
      `  ${fpVerdict}`
  );

  console.log(
    `\nDEFECTS FOUND (${auditResult.found.length.toString()}/${fixture.plantedDefects.length.toString()})`
  );
  for (const d of auditResult.found) console.log(`  + ${d}`);
  for (const d of auditResult.missed) console.log(`  - (missed) ${d}`);

  console.log(`\nFALSE POSITIVES (${auditResult.falsePositives.length.toString()})`);
  if (auditResult.falsePositives.length === 0) {
    console.log("  (none)");
  } else {
    for (const fp of auditResult.falsePositives) console.log(`  ! ${fp}`);
  }

  // Diagnostic, not scored: what the sub-audits found before synthesis pruned.
  // A defect present here but missing above was found and then dropped — that is
  // a synthesis problem, not a reviewer problem, and the fix differs.
  if (preSynthesisOutput) {
    const raw = auditDefectsFound(preSynthesisOutput, fixture.plantedDefects, fixture.decoys);
    console.log(
      `\nBEFORE SYNTHESIS (diagnostic, not scored) — found ${raw.found.length.toString()}/${fixture.plantedDefects.length.toString()}, decoys flagged ${raw.falsePositives.length.toString()}`
    );
    for (const d of raw.found) console.log(`  + ${d}`);
    for (const d of raw.missed) console.log(`  - (never found) ${d}`);
  }

  failed =
    auditResult.recall < AUDIT_RECALL_THRESHOLD || auditResult.falsePositives.length > AUDIT_FP_MAX;
} else {
  const verdict = (score: number, key: keyof typeof THRESHOLDS): string =>
    score >= THRESHOLDS[key] ? "PASS" : "FAIL";

  const pathResult = citedPathsExist(fullOutput, repoRoot);
  const gapResult = plantedGapsFound(fullOutput, fixture.expectedGaps);
  const existingResult = existingFunctionalityNamed(fullOutput, fixture.expectedExisting);

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

  failed =
    pathResult.score < THRESHOLDS.citedPathsExist ||
    gapResult.score < THRESHOLDS.plantedGapsFound ||
    existingResult.score < THRESHOLDS.existingFunctionalityNamed;
}

// ── Exit ──────────────────────────────────────────────────────────────────────

console.log(`\n${bar}`);
console.log(failed ? "EVAL FAILED — one or more scorers below threshold" : "EVAL PASSED");
console.log(bar);

if (failed) process.exitCode = 1;
