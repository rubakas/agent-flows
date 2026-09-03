#!/usr/bin/env tsx
// Smoke test for Binding B (Mastra).
// MUST be the very first line: disable Mastra telemetry before any @mastra import.
process.env.MASTRA_TELEMETRY_DISABLED = "1";

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Mastra } from "@mastra/core/mastra";
import { LibSQLStore } from "@mastra/libsql";
import { listPipelines, loadPipeline } from "../../canon/load.js";
import { defaultRegistry, getProfile, resolveStepModel } from "../../canon/registry.js";
import { makeDb } from "../../db/index.js";
import { DrizzleTicketStore } from "../../store/sqlite.js";
import { buildPipelineWorkflow, mastraDbPath } from "./build.js";
import type { ModelEntry } from "../../canon/registry.js";
import type { StepDef } from "../../canon/types.js";

// ── CLI args ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

function getFlag(flag: string, fallback: string): string {
  const idx = args.indexOf(flag);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : fallback;
}

function getOptFlag(flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : undefined;
}

function hasFlag(flag: string): boolean {
  return args.includes(flag);
}

const dbPath = getFlag("--db", "/tmp/yoke-mastra-smoke.sqlite");
const mastraDb = mastraDbPath(dbPath);
const providerId = getFlag("--provider", process.env.YOKE_PROVIDER ?? "anthropic");
const profile = getProfile(providerId);

// --intake-model: explicit override for the intake step only, opt-in (no default)
const intakeModelOverride = getOptFlag("--intake-model");

// --cheap: pin every step to the profile's scout entry for quick iteration
const cheap = hasFlag("--cheap");

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = join(__dirname, "..", "..", "..");

console.log(`Smoke: provider=${providerId} db=${dbPath}`);

// ── Setup ─────────────────────────────────────────────────────────────────────

const mastraStorage = new LibSQLStore({ id: "yoke-smoke", url: `file:${mastraDb}` });
const yokeDb = makeDb(dbPath);
const store = new DrizzleTicketStore(yokeDb);
const registry = defaultRegistry();

const pipelinesDir = join(repoRoot, "pipelines");
const [pipelineFile] = listPipelines(pipelinesDir).filter((f) => f.includes("spec-creation"));
if (!pipelineFile) {
  console.error("No spec-creation pipeline found");
  process.exit(1);
}

const loaded = loadPipeline(pipelineFile);
const llmSteps = loaded.def.steps.filter((s): s is StepDef => s.kind === "llm");

// ── Build models override map ─────────────────────────────────────────────────
// By default pass no overrides — every step resolves via the active ProviderProfile.
// --cheap: pin all steps to the scout entry (portable across providers).
// --intake-model <id>: override only the intake step (applied on top of --cheap if both set).

const modelsOverride: Record<string, string> = {};

if (cheap) {
  const scoutId = profile.roles.scout;
  for (const step of llmSteps) {
    modelsOverride[step.id] = scoutId;
  }
}

if (intakeModelOverride) {
  modelsOverride.intake = intakeModelOverride;
}

// ── Resolution table ──────────────────────────────────────────────────────────
// Shows what model each step will actually use — evidence that the provider swap is real.

function describeEntry(entry: ModelEntry): string {
  if (entry.transport === "cli") {
    const model = entry.cli?.model ? ` --model ${entry.cli.model}` : "";
    return `cli:${entry.cli?.bin ?? "?"}${model}`;
  }
  return `api:${entry.api?.endpoint ?? "?"}`;
}

console.log("\nResolution table:");
for (const step of llmSteps) {
  const overrideId = modelsOverride[step.id];
  const entry = overrideId
    ? registry.resolve(overrideId)
    : resolveStepModel(step, profile, registry);
  const source = overrideId ? `override(${overrideId})` : `role:${step.role ?? "—"} → ${entry.id}`;
  console.log(`  ${step.id.padEnd(10)} ${source.padEnd(32)} ${describeEntry(entry)}`);
}
console.log("");

// ── Run ───────────────────────────────────────────────────────────────────────

const wf = buildPipelineWorkflow(loaded, { registry, store, profile });
const mastra = new Mastra({ storage: mastraStorage, workflows: { [loaded.def.id]: wf } });
const mastraWf = mastra.getWorkflow(loaded.def.id);

const run = await mastraWf.createRun();

const inputData: Record<string, unknown> = {
  request:
    "Add a dark mode toggle to the web app. Users should be able to switch between light and dark themes and have the preference persisted across sessions.",
};
if (Object.keys(modelsOverride).length > 0) {
  inputData.models = modelsOverride;
}

let ticketCreated = false;

// ── Helpers ───────────────────────────────────────────────────────────────────

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

try {
  const r1 = await run.start({ inputData });

  console.log(`After start: status=${r1.status}`);

  if (r1.status === "suspended") {
    const gateStep = r1.steps?.approve as Record<string, unknown> | undefined;
    const suspendPayload = gateStep?.suspendPayload as Record<string, unknown> | undefined;
    const spec = suspendPayload?.spec as Record<string, unknown> | undefined;

    if (spec) {
      console.log(`\nSpec title: ${String(spec.title)}`);
      const reqs = spec.requirements as string[] | undefined;
      console.log(`Requirements: ${String(reqs?.length ?? 0)}`);
      const acs = spec.acceptanceCriteria as string[] | undefined;
      console.log(`Acceptance criteria: ${String(acs?.length ?? 0)}`);
      const weaknesses = spec.weaknesses as unknown[] | undefined;
      console.log(`Weaknesses: ${String(weaknesses?.length ?? 0)}`);
      const secFindings = spec.securityFindings as unknown[] | undefined;
      console.log(`Security findings: ${String(secFindings?.length ?? 0)}`);
    } else {
      console.error("ERROR: suspend payload missing spec — pipeline did not complete LLM steps.");
      process.exitCode = 1;
    }

    console.log("\nAuto-approving…");
    const r2 = await run.resume({
      step: r1.suspended[0],
      resumeData: { approved: true },
    });

    console.log(`After resume: status=${r2.status}`);
    if (r2.status !== "success") {
      const errMsg = extractRunError(r2);
      console.error(`\nERROR: resume did not succeed. ${errMsg}`);
      process.exitCode = 1;
    } else {
      const result = r2.result as Record<string, unknown> | undefined;
      if (result?.ticketId) {
        console.log(`\nTicket created: id=${(result.ticketId as number).toString()}`);
        ticketCreated = true;
      } else {
        console.error("\nERROR: run succeeded but no ticketId in result.");
        process.exitCode = 1;
      }
    }
  } else if (r1.status === "success") {
    // Pipelines without a gate step complete immediately.
    const result = r1.result as Record<string, unknown> | undefined;
    if (result?.ticketId) {
      console.log(`Ticket created: id=${(result.ticketId as number).toString()}`);
      ticketCreated = true;
    } else {
      console.log("Completed without gate and without ticket — check pipeline definition.");
      process.exitCode = 1;
    }
  } else {
    const errMsg = extractRunError(r1);
    console.error(`\nERROR: run failed before gate. ${errMsg}`);
    process.exitCode = 1;
  }
} catch (err) {
  console.error(
    `\nFATAL: unexpected error during run: ${err instanceof Error ? err.message : String(err)}`
  );
  process.exitCode = 1;
}

// ── Verify rows ───────────────────────────────────────────────────────────────

const tickets = await store.listTickets();
console.log(`\nTickets in ${dbPath}: ${tickets.length.toString()}`);
for (const t of tickets) {
  console.log(`  [${t.id.toString()}] ${t.title} (state: ${t.state})`);
  const reqs = await store.listRequirements(t.id);
  const acs = await store.listAcceptanceCriteria(t.id);
  const ws = await store.listWeaknesses(t.id);
  const sf = await store.listSecurityFindings(t.id);
  console.log(
    `       reqs=${reqs.length.toString()} AC=${acs.length.toString()} weaknesses=${ws.length.toString()} secFindings=${sf.length.toString()}`
  );
}

if (!ticketCreated) {
  console.error("\nSmoke FAILED — no ticket persisted.");
  process.exitCode = 1;
} else {
  console.log("\nSmoke PASSED.");
}
