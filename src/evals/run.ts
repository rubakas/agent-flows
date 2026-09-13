#!/usr/bin/env tsx
// Eval runner for read-only pipelines.
//
// Usage: tsx src/evals/run.ts <fixture-name>
// Usage: tsx src/evals/run.ts --list   (prints available fixtures and exits)
// Available fixtures: bug-missing-detail, feature-collision, audit-planted-defects,
//                      code-review-citations
//
// Thresholds (exit non-zero if any falls below):
//   citedPathsExist      = 100% — anti-hallucination: every cited path must exist
//   plantedGapsFound     ≥ 80% — most of the planted gaps must be surfaced
//   existingFunctionality = 100% — every existing impl must be identified
//   verdictAccuracy      = 100% — every verified finding must reach the expected verdict
//   conditional misrouted =    0 — no raised item may carry the adjudication it forbids
//                                  (an item nobody raised, or raised without anything matching
//                                   what it wants, is inconclusive and fails nothing)
//
// Every step's raw output is written to a run directory outside the repo
// (AGENT_FLOWS_EVAL_OUT, else the OS temp dir) and its path is printed first:
// scorer summaries alone cannot diagnose why a verdict came out wrong.
//
// SAFETY: refuses any pipeline containing a step with permissions.contents:write or kind:check.
// Those pipelines write files in the owner's working repo or execute shell commands.

// MUST be the very first line: disable Mastra telemetry before any @mastra import.
process.env.MASTRA_TELEMETRY_DISABLED = "1";

import { existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Mastra } from "@mastra/core/mastra";
import { LibSQLStore } from "@mastra/libsql";
import { buildPipelineWorkflow } from "../bindings/mastra/build.js";
import { mastraDbPath } from "../bindings/mastra/paths.js";
import { loadPipeline } from "../canon/load.js";
import { loadProviders } from "../canon/loadProviders.js";
import { defaultRegistry, getProfile } from "../canon/registry.js";
import { makeDb } from "../db/index.js";
import { DrizzleTicketStore } from "../store/sqlite.js";
import { persistRun } from "./persistRun.js";
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

interface CodeReviewFixture {
  /** Diff passed as `plan` input to the code-review pipeline. */
  diff: string;
  /** What existed before the change; passed as the `baseline` input. */
  baseline: string;
  /** Verdicts the verifier must reach, one per finding raised upstream. */
  expectations: VerdictExpectation[];
  /** Items graded only when raised: each must match its `ifRaised` fields. */
  conditional: ConditionalItem[];
  /** Every path listed here must exist in the repo (anti-rot assertion). */
  expectedPaths: string[];
}

type AnyFixture = EvalFixture | AuditFixture | CodeReviewFixture;

/** Checked before isAuditFixture: a code-review fixture also carries a diff. */
function isCodeReviewFixture(f: AnyFixture): f is CodeReviewFixture {
  return "expectations" in f && Array.isArray((f as CodeReviewFixture).expectations);
}

function isAuditFixture(f: AnyFixture): f is AuditFixture {
  return !isCodeReviewFixture(f) && "diff" in f && typeof (f as AuditFixture).diff === "string";
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
  // 1.0 for the same reason as citedPathsExist: a verifier that reaches the
  // wrong verdict on a finding is precisely the failure this pipeline exists to
  // prevent, so a fractional bar would make PASS meaningless.
  verdictAccuracy: 1,
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
  "code-review-citations",
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
const providers = loadProviders(repoRoot);
const providerId = process.env.AGENT_FLOWS_PROVIDER ?? providers.defaultProvider ?? "anthropic";
const profile = getProfile(providerId, providers.profiles);
const registry = defaultRegistry(process.env, providers.models);

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

const pipelineFile = isCodeReviewFixture(fixture)
  ? "code-review.yaml"
  : isAuditFixture(fixture)
    ? "audit.yaml"
    : "investigate.yaml";
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

if (isCodeReviewFixture(fixture)) {
  console.log(
    `\nDiff: ${fixture.diff.length.toString()} chars, ${fixture.expectations.length.toString()} expected verdict(s), ${fixture.conditional.length.toString()} conditional item(s)`
  );
} else if (isAuditFixture(fixture)) {
  console.log(
    `\nDiff: ${fixture.diff.length.toString()} chars, ${fixture.plantedDefects.length.toString()} planted defect(s), ${fixture.decoys.length.toString()} decoy(s)`
  );
} else {
  console.log(`\nSeed prompt: "${fixture.seedPrompt}"`);
}
console.log("\nRunning…\n");

const runInput = isCodeReviewFixture(fixture)
  ? { plan: fixture.diff, baseline: fixture.baseline, introducedCommits: "" }
  : isAuditFixture(fixture)
    ? { plan: fixture.diff }
    : { request: fixture.seedPrompt };

// ── Persist the raw run ───────────────────────────────────────────────────────
// Every step's output is written verbatim, before scoring, so the artifact that
// was graded still exists afterwards — and on the failure paths too, where the
// partial outputs and the error are the only evidence of where the run stopped.
//
// Outside the repo by default: the eval refuses pipelines that can write here
// (assertReadOnly), and a runner that then wrote into the working tree itself
// would reintroduce exactly what that guard forbids.

const runDir = join(
  process.env.AGENT_FLOWS_EVAL_OUT ?? tmpdir(),
  "agent-flows-evals",
  fixtureName,
  new Date().toISOString().replaceAll(":", "-")
);

/** Whatever finished before the run stopped; `result` is absent on a failed run. */
function partialOutputs(runResult: unknown): Record<string, unknown> {
  const r = runResult as Record<string, unknown> | undefined;
  const steps = r?.steps as Record<string, Record<string, unknown>> | undefined;
  const out: Record<string, unknown> = {};
  for (const [stepId, step] of Object.entries(steps ?? {})) {
    if (step.output !== undefined) out[stepId] = step.output;
  }
  return out;
}

const startTime = Date.now();

let r1: Awaited<ReturnType<typeof run.start>>;
try {
  r1 = await run.start({ inputData: runInput });
} catch (err) {
  persistRun(runDir, undefined, err);
  console.log(`run dir: ${runDir}`);
  console.error(`\nRUN THREW: ${err instanceof Error ? err.message : "unknown error"}`);
  process.exit(1);
}
const elapsedMs = Date.now() - startTime;

if (r1.status !== "success") {
  const errMsg = extractRunError(r1);
  persistRun(runDir, partialOutputs(r1), errMsg);
  console.log(`run dir: ${runDir}`);
  console.error(`\nRUN FAILED: ${errMsg}`);
  process.exit(1);
}

const result = r1.result as Record<string, unknown>;

// Printed here, not with the report: the three "no output in result.*" exits
// below abort before any report is written, and a run whose directory is never
// named is a run nobody can inspect.
persistRun(runDir, result);
console.log(`\nrun dir: ${runDir}`);

// ── Extract output ────────────────────────────────────────────────────────────

let fullOutput: string;
// Audit only: the raw sub-audit text, before synthesis merged and pruned it.
// Scoring the synthesis alone cannot distinguish "never found" from "found then
// dropped", and those call for opposite fixes.
let preSynthesisOutput = "";

if (isCodeReviewFixture(fixture)) {
  // The per-finding verdicts live in the verify step's output; synthesis sees
  // only what verify passed on, so scoring it would score the wrong artifact.
  // verify is schema-gated, so its context entry is the parsed object, not a
  // string — reading it as a string would fail every live run before scoring.
  const verifyText = stepOutputText(result.verify);
  if (!verifyText) {
    console.error("RUN ERROR: no output in result.verify");
    process.exit(1);
  }
  fullOutput = verifyText;
} else if (isAuditFixture(fixture)) {
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
let summary: Record<string, unknown>;

if (isCodeReviewFixture(fixture)) {
  // One finding answers one key. Expectations claim first, conditionals second,
  // each in fixture order: a finding both could match belongs to the key that is
  // required, not to the one that is merely graded if raised.
  const claimed: ClaimedFindings = new Set();
  const reviewResult = reviewVerdicts(fullOutput, fixture.expectations, claimed);
  const conditionalResult = reviewConditional(fullOutput, fixture.conditional, claimed);
  const accuracyVerdict = reviewResult.accuracy >= THRESHOLDS.verdictAccuracy ? "PASS" : "FAIL";
  const misroutedVerdict = conditionalResult.misrouted.length === 0 ? "PASS" : "FAIL";

  console.log("SCORES");
  console.log(
    `  verdictAccuracy       ${fmt(reviewResult.accuracy).padStart(4)}` +
      `  [≥${fmt(THRESHOLDS.verdictAccuracy)}]` +
      `  ${accuracyVerdict}`
  );
  console.log(
    `  conditional misrouted ${conditionalResult.misrouted.length.toString().padStart(4)}` +
      `  [=0]   ` +
      `  ${misroutedVerdict}`
  );

  console.log(
    `\nVERDICTS CORRECT (${reviewResult.correct.length.toString()}/${fixture.expectations.length.toString()})`
  );
  for (const c of reviewResult.correct) console.log(`  + ${c}`);

  console.log(`\nVERDICTS WRONG (${reviewResult.wrong.length.toString()})`);
  if (reviewResult.wrong.length === 0) {
    console.log("  (none)");
  } else {
    for (const w of reviewResult.wrong)
      console.log(`  ! ${w.phrase} — expected ${w.expected}, got ${w.actual}`);
  }

  console.log(`\nFINDINGS MISSING (${reviewResult.missing.length.toString()})`);
  if (reviewResult.missing.length === 0) {
    console.log("  (none)");
  } else {
    for (const m of reviewResult.missing) console.log(`  - (missing) ${m}`);
  }

  console.log(`\nBLOCKING FINDINGS: ${reviewResult.blockingCount.toString()}`);

  // The three conditional states are printed apart on purpose. "Routed" is the
  // only one that is evidence the verifier works; collapsing the other two into
  // it would let a run where nobody raised the item read as a clean sweep.
  console.log(
    `\nCONDITIONAL ROUTED (${conditionalResult.routed.length.toString()}/${fixture.conditional.length.toString()})`
  );
  if (conditionalResult.routed.length === 0) {
    console.log("  (none)");
  } else {
    for (const r of conditionalResult.routed)
      console.log(
        `  + ${r.phrase} — verdict ${r.hit.verdict}, kind ${r.hit.kind ?? "unclassified"}`
      );
  }

  console.log(`\nCONDITIONAL MISROUTED (${conditionalResult.misrouted.length.toString()}) [=0]`);
  if (conditionalResult.misrouted.length === 0) {
    console.log("  (none)");
  } else {
    for (const m of conditionalResult.misrouted)
      console.log(`  ! ${m.phrase} — ${m.expected}, got ${m.got}`);
  }

  // Raised, nothing forbidden, nothing wanted: the key swept neighbouring
  // findings and the item itself was never adjudicated. Never gating — failing
  // here would punish a verifier for a finding it got right from another angle.
  console.log(
    `\nCONDITIONAL INCONCLUSIVE (${conditionalResult.inconclusive.length.toString()}) — raised, but nothing matched what this item wants`
  );
  if (conditionalResult.inconclusive.length === 0) {
    console.log("  (none)");
  } else {
    for (const i of conditionalResult.inconclusive)
      console.log(`  ~ ${i.phrase} — claimed ${i.got.join("; ")}`);
  }

  console.log(
    `\nCONDITIONAL NOT RAISED (${conditionalResult.notRaised.length.toString()}) — INCONCLUSIVE`
  );
  if (conditionalResult.notRaised.length === 0) {
    console.log("  (none)");
  } else {
    console.log("  No producer raised this item, so the verifier was never asked about it.");
    console.log("  This is not a pass and not a failure: it proves nothing either way.");
    for (const n of conditionalResult.notRaised) console.log(`  ~ ${n}`);
  }

  summary = {
    fixture: fixtureName,
    provider: providerId,
    elapsedMs,
    verdictAccuracy: reviewResult.accuracy,
    verdicts: reviewResult,
    conditional: {
      routed: conditionalResult.routed.map((r) => r.phrase),
      misrouted: conditionalResult.misrouted,
      notRaised: conditionalResult.notRaised,
    },
  };

  failed =
    reviewResult.accuracy < THRESHOLDS.verdictAccuracy || conditionalResult.misrouted.length > 0;
} else if (isAuditFixture(fixture)) {
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

  summary = {
    fixture: fixtureName,
    provider: providerId,
    elapsedMs,
    recall: auditResult.recall,
    found: auditResult.found,
    missed: auditResult.missed,
    falsePositives: auditResult.falsePositives,
  };

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

  summary = {
    fixture: fixtureName,
    provider: providerId,
    elapsedMs,
    citedPathsExist: pathResult,
    plantedGapsFound: gapResult,
    existingFunctionalityNamed: existingResult,
  };

  failed =
    pathResult.score < THRESHOLDS.citedPathsExist ||
    gapResult.score < THRESHOLDS.plantedGapsFound ||
    existingResult.score < THRESHOLDS.existingFunctionalityNamed;
}

// ── Exit ──────────────────────────────────────────────────────────────────────

writeFileSync(join(runDir, "summary.json"), `${JSON.stringify({ ...summary, failed }, null, 2)}\n`);

console.log(`\n${bar}`);
console.log(failed ? "EVAL FAILED — one or more scorers below threshold" : "EVAL PASSED");
console.log(bar);

if (failed) process.exitCode = 1;
