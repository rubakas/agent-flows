// Tests for starting a run below the HTTP route (spec 047 FR-10).
//
// Every rule that decides whether a request is a valid run used to be reachable only
// through POST /api/runs, so each was pinned, if at all, by a regex over a response
// body after a server round trip. Here the run service is a fake, the catalogue is a
// temp directory, and each refusal is asserted as the exact string a caller sees.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { renderSpecKitSpec } from "../canon/exportSpec.js";
import { layerFrom } from "../canon/layers.js";
import { pipelinesIn } from "../canon/pipelines.js";
import { builtInProfileIds, type ProviderProfile } from "../canon/registry.js";
import { startRun, type RunRequest, type RunStartDeps } from "./runStart.js";
import type { RunService } from "./runService.js";

type StartArgs = Parameters<RunService["start"]>;

let dir: string;
let projectDir: string;
let stateRoot: string;
let calls: StartArgs[];
let pipelinesRoot: string;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "af-run-start-")));
  projectDir = join(dir, "project");
  stateRoot = join(dir, "state");
  pipelinesRoot = join(dir, "canon");
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(stateRoot, { recursive: true });
  mkdirSync(join(pipelinesRoot, "pipelines"), { recursive: true });
  mkdirSync(join(pipelinesRoot, "prompts"), { recursive: true });
  writeFileSync(join(pipelinesRoot, "prompts", "p.md"), "{{request}}\n");
  writeFileSync(join(pipelinesRoot, "prompts", "plan.md"), "{{plan}}\n");
  calls = [];

  pipeline("req-run", [
    "inputs:",
    "  - request",
    "steps:",
    "  - id: only",
    "    kind: llm",
    "    role: worker",
    "    prompt: prompts/p.md",
    "  - id: second",
    "    kind: llm",
    "    role: worker",
    "    prompt: prompts/p.md",
    "    dependsOn: [only]",
  ]);
  pipeline("plan-run", [
    "inputs:",
    "  - plan",
    "steps:",
    "  - id: only",
    "    kind: llm",
    "    role: worker",
    "    prompt: prompts/plan.md",
  ]);
  pipeline("body", ["inputs: []", "steps:", "  - id: inner", "    kind: gate"]);
  pipeline("loopy", [
    "inputs: []",
    "steps:",
    "  - id: again",
    "    kind: loop",
    "    pipeline: body",
    "    maxIterations: 2",
    "    until: inner.passed",
  ]);
  // Defined, but its prompt file is missing: it fails to load.
  pipeline("broken", [
    "inputs: []",
    "steps:",
    "  - id: only",
    "    kind: llm",
    "    role: worker",
    "    prompt: prompts/missing.md",
  ]);
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function pipeline(id: string, lines: string[]): void {
  writeFileSync(
    join(pipelinesRoot, "pipelines", `${id}.yaml`),
    [`id: ${id}`, "version: 1", `description: ${id}`, ...lines, ""].join("\n")
  );
}

function deps(overrides: Partial<RunStartDeps> = {}): RunStartDeps {
  const start: RunService["start"] = async (...args) => {
    calls.push(args);
    return { runId: "fake-run", status: "running" };
  };
  return {
    runService: { start },
    pipelines: pipelinesIn([layerFrom("repo", pipelinesRoot)]),
    projectDir,
    stateRoot,
    providerProfiles: [],
    ...overrides,
  };
}

/** The refusal message for `req`, asserting nothing was started. */
async function refusal(req: RunRequest, over: Partial<RunStartDeps> = {}): Promise<string> {
  const outcome = await startRun(req, deps(over));
  assert.equal(outcome.ok, false, `expected a refusal, got ${JSON.stringify(outcome)}`);
  if (outcome.ok) throw new Error("unreachable");
  assert.equal(outcome.refusal, "invalid");
  assert.equal(calls.length, 0, "a refused request must never reach the run service");
  return outcome.error;
}

const request = (extra: RunRequest = {}): RunRequest => ({
  pipeline: "req-run",
  inputs: { request: "r" },
  ...extra,
});

describe("startRun — refusals", () => {
  it("a pipeline that is not a string", async () => {
    assert.equal(await refusal({ pipeline: 7, inputs: {} }), 'Field "pipeline" must be a string');
  });

  it("a gateMode that is neither manual nor auto", async () => {
    assert.equal(
      await refusal(request({ gateMode: "sometimes" })),
      'Field "gateMode" must be "manual" or "auto"'
    );
  });

  it("a non-string input value, naming the key truncated to 100 characters", async () => {
    assert.equal(
      await refusal(request({ inputs: { task: { nested: "object" } } })),
      'Input "task" must be a string'
    );
    const long = "k".repeat(300);
    assert.equal(
      await refusal(request({ inputs: { [long]: 1 } })),
      `Input "${"k".repeat(100)}" must be a string`
    );
  });

  it("a models map that is not a flat object", async () => {
    assert.equal(await refusal(request({ models: ["gpt"] })), 'Field "models" must be an object');
    assert.equal(await refusal(request({ models: null })), 'Field "models" must be an object');
  });

  it("a model override for a step the pipeline does not have", async () => {
    assert.equal(
      await refusal(request({ models: { "no-such-step": "opus" } })),
      'Model override "no-such-step" is not a step of "req-run"'
    );
  });

  it("a model id that is not registry-shaped, too long, or not a string", async () => {
    const message = 'Model override "only" must be a model id';
    assert.equal(await refusal(request({ models: { only: "not a model id; rm -rf" } })), message);
    assert.equal(await refusal(request({ models: { only: "m".repeat(101) } })), message);
    assert.equal(await refusal(request({ models: { only: 7 } })), message);
  });

  it("models for a pipeline no layer defines cannot be validated", async () => {
    assert.equal(
      await refusal({ pipeline: "nope", inputs: {}, models: { some: "opus" } }),
      'Field "models" cannot be validated: pipeline "nope" not found'
    );
  });

  it("an unknown pipeline name is truncated to 100 characters, like the keys are", async () => {
    const long = "z".repeat(500);
    assert.equal(
      await refusal({ pipeline: long, inputs: {}, models: { some: "opus" } }),
      `Field "models" cannot be validated: pipeline "${"z".repeat(100)}" not found`
    );
    assert.equal(
      await refusal({ pipeline: long, inputs: { x: "y" } }),
      `Field "inputs" cannot be validated: pipeline "${"z".repeat(100)}" not found`
    );
  });

  it("a provider that is not a string", async () => {
    assert.equal(await refusal(request({ provider: 7 })), 'Field "provider" must be a string');
  });

  it("a provider no profile answers to, listing the ones that exist", async () => {
    assert.equal(
      await refusal(request({ provider: "no-such-profile" })),
      `Provider "no-such-profile" does not name a known profile. Available: ${builtInProfileIds().join(", ")}`
    );
  });

  it("a profile added to providers.yaml after startup is refused against the snapshot", async () => {
    writeProfileFile();
    const message = await refusal(request({ provider: "added-after-startup" }), {
      providerProfiles: [],
    });
    assert.match(message, /^Provider "added-after-startup" does not name a known profile/);
  });

  it("without a snapshot, providers.yaml is read, and an unreadable one is a refusal", async () => {
    mkdirSync(join(projectDir, ".agent-flows"), { recursive: true });
    writeFileSync(join(projectDir, ".agent-flows", "providers.yaml"), "version: 2\n");
    const message = await refusal(request({ provider: "anthropic" }), {
      providerProfiles: undefined,
    });
    assert.match(message, /^Field "provider" cannot be validated: /);
  });

  it("a reserved key inside inputs is refused, never merged", async () => {
    assert.equal(
      await refusal(request({ inputs: { request: "r", provider: "local" } })),
      'Input "provider" is reserved — pass it as the top-level "provider" field instead'
    );
    assert.equal(
      await refusal(request({ inputs: { request: "r", models: "x" } })),
      'Input "models" is reserved — pass it as the top-level "models" field instead'
    );
  });

  it("an input the pipeline does not declare", async () => {
    assert.equal(
      await refusal(request({ inputs: { request: "r", extra: "e" } })),
      'Input "extra" is not an input of "req-run". Declared: request'
    );
  });

  it("an artifactPath that is not a string", async () => {
    assert.equal(
      await refusal({ pipeline: "plan-run", artifactPath: 7 }),
      'Field "artifactPath" must be a string'
    );
  });

  it("an artifact the resolver refuses is the refusal, verbatim", async () => {
    const outside = join(dir, "elsewhere", "artifact.json");
    const message = await refusal({ pipeline: "plan-run", artifactPath: outside });
    assert.equal(message, `artifactPath must be under ${stateRoot}`);
  });

  it("no inputs and no artifactPath", async () => {
    assert.equal(await refusal({ pipeline: "req-run" }), 'Field "inputs" must be an object');
    assert.equal(
      await refusal({ pipeline: "req-run", inputs: ["a"] }),
      'Field "inputs" must be an object'
    );
  });

  it("a pipeline no layer defines is refused with its own message", async () => {
    assert.equal(await refusal({ pipeline: "nope", inputs: {} }), 'Pipeline "nope" not found');
  });

  it("a pipeline that exists but fails to load says so, with the loader's reason", async () => {
    const message = await refusal({ pipeline: "broken", inputs: {} });
    assert.equal(
      message,
      'Pipeline "broken" fails to load: Step "only": prompt file "prompts/missing.md" not found'
    );
    assert.equal(
      await refusal({ pipeline: "broken", inputs: { x: "y" } }),
      'Field "inputs" cannot be validated: pipeline "broken" fails to load: Step "only": prompt file "prompts/missing.md" not found'
    );
  });

  it("redacts the layer root from the loader's reason, as every route does", async () => {
    // The view lists its files when built and loads lazily, so a file that vanishes
    // after that fails at load with an error naming its absolute path.
    const view = deps();
    rmSync(join(pipelinesRoot, "pipelines", "req-run.yaml"));
    const message = await refusal({ pipeline: "req-run", inputs: {} }, view);
    assert.match(message, /^Pipeline "req-run" fails to load: /);
    assert.ok(!message.includes(pipelinesRoot), `the layer root must not leak: ${message}`);
    assert.ok(message.includes("<root>"), `the root must be replaced by <root>: ${message}`);
  });

  // The checks run in one fixed order, so a request that breaks several rules is
  // told about them one at a time, in the order below. Each step repairs the field
  // just reported and expects the next rule's message.
  it("reports the first broken rule, in the documented order", async () => {
    const body: Record<string, unknown> = {
      pipeline: 7,
      gateMode: "sometimes",
      inputs: { request: { n: 1 } },
      models: ["gpt"],
      provider: 7,
      artifactPath: 7,
    };
    const steps: [string, () => void][] = [
      ['Field "pipeline" must be a string', () => (body.pipeline = "req-run")],
      ['Field "gateMode" must be "manual" or "auto"', () => (body.gateMode = "auto")],
      [
        'Input "request" must be a string',
        () => (body.inputs = { provider: "x", ghost: "y", request: "r" }),
      ],
      ['Field "models" must be an object', () => (body.models = { ghost: "opus" })],
      [
        'Model override "ghost" is not a step of "req-run"',
        () => (body.models = { only: "bad id!" }),
      ],
      ['Model override "only" must be a model id', () => delete body.models],
      ['Field "provider" must be a string', () => (body.provider = "no-such-profile")],
      [
        `Provider "no-such-profile" does not name a known profile. Available: ${builtInProfileIds().join(", ")}`,
        () => delete body.provider,
      ],
      [
        'Input "provider" is reserved — pass it as the top-level "provider" field instead',
        () => (body.inputs = { ghost: "y" }),
      ],
      [
        'Input "ghost" is not an input of "req-run". Declared: request',
        () => (body.inputs = { request: "r" }),
      ],
      ['Field "artifactPath" must be a string', () => delete body.artifactPath],
    ];
    for (const [expected, repair] of steps) {
      assert.equal(await refusal(body as RunRequest), expected);
      repair();
    }
    const outcome = await startRun(body, deps());
    assert.equal(outcome.ok, true, JSON.stringify(outcome));
  });

  it("asks for inputs before it reports a pipeline that does not exist", async () => {
    assert.equal(await refusal({ pipeline: "nope" }), 'Field "inputs" must be an object');
  });
});

function writeProfileFile(): void {
  mkdirSync(join(projectDir, ".agent-flows"), { recursive: true });
  writeFileSync(
    join(projectDir, ".agent-flows", "providers.yaml"),
    [
      "version: 1",
      "profiles:",
      "  - id: added-after-startup",
      "    roles: { reasoner: opus, worker: sonnet, scout: haiku }",
      "",
    ].join("\n")
  );
}

describe("startRun — a valid request", () => {
  it("starts the pipeline with its loaded definition and a manual gate by default", async () => {
    const outcome = await startRun(request(), deps());
    assert.deepEqual(outcome, { ok: true, result: { runId: "fake-run", status: "running" } });
    assert.equal(calls.length, 1);
    const [id, wfInput, opts] = calls[0];
    assert.equal(id, "req-run");
    assert.deepEqual(wfInput, { request: "r" });
    assert.equal(opts?.gateMode, "manual");
    assert.deepEqual(
      opts?.loaded?.def.steps.map((s) => s.id),
      ["only", "second"]
    );
    assert.equal(opts?.loaded?.bodies, undefined);
    assert.equal(opts?.models, undefined);
    assert.equal(opts?.provider, undefined);
    assert.equal(opts?.chain, undefined);
  });

  it("passes an explicit gateMode through", async () => {
    await startRun(request({ gateMode: "auto" }), deps());
    assert.equal(calls[0][2]?.gateMode, "auto");
  });

  it("hands the validated models and provider to the run as options, not as inputs", async () => {
    // One without the other is a run that validated a provider it then never used,
    // or recorded provenance for a profile the steps did not resolve from.
    await startRun(request({ models: { only: "claude-sonnet-4-5" }, provider: "openai" }), deps());
    const [, wfInput, opts] = calls[0];
    assert.deepEqual(wfInput, { request: "r" });
    assert.deepEqual(opts?.models, { only: "claude-sonnet-4-5" });
    assert.equal(opts?.provider?.id, "openai");
  });

  it("takes a profile added to providers.yaml when the daemon holds no snapshot", async () => {
    writeProfileFile();
    const outcome = await startRun(
      request({ provider: "added-after-startup" }),
      deps({ providerProfiles: undefined })
    );
    assert.equal(outcome.ok, true, JSON.stringify(outcome));
    assert.equal(calls[0][2]?.provider?.id, "added-after-startup");
  });

  it("takes a profile from the snapshot the workflows were built with", async () => {
    const snapshot: ProviderProfile[] = [
      { id: "from-snapshot", roles: { reasoner: "opus", worker: "sonnet", scout: "haiku" } },
    ];
    const outcome = await startRun(
      request({ provider: "from-snapshot" }),
      deps({ providerProfiles: snapshot })
    );
    assert.equal(outcome.ok, true, JSON.stringify(outcome));
    assert.equal(calls[0][2]?.provider?.id, "from-snapshot");
  });

  it("hands a loop pipeline's bodies to the run so their steps are not logged twice", async () => {
    await startRun({ pipeline: "loopy", inputs: {} }, deps());
    assert.deepEqual(Object.keys(calls[0][2]?.loaded?.bodies ?? {}), ["again"]);
  });

  it("lets a throw from the run service through: a throw is a bug, not a refusal", async () => {
    const runService = {
      start: async (): Promise<never> => {
        throw new Error("boom");
      },
    };
    await assert.rejects(startRun(request(), deps({ runService })), /boom/);
  });
});

describe("startRun — an artifact seeds the inputs", () => {
  function writeArtifact(extra: Record<string, unknown> = {}): string {
    const path = join(stateRoot, "projects", "p", "runs", "run-src", "spec-creation.json");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        runId: "run-src",
        pipelineId: "spec-creation",
        status: "succeeded",
        gateMode: "manual",
        steps: {},
        gateDecisions: [],
        spec: "My Feature Spec: Implement dark mode",
        ...extra,
      }),
      "utf8"
    );
    return path;
  }

  it("maps artifact.spec onto the plan input and names the chain directory", async () => {
    const artifactPath = writeArtifact();
    const outcome = await startRun({ pipeline: "plan-run", artifactPath }, deps());
    assert.equal(outcome.ok, true, JSON.stringify(outcome));
    const [, wfInput, opts] = calls[0];
    assert.deepEqual(wfInput, { plan: "My Feature Spec: Implement dark mode" });
    assert.equal(typeof wfInput.plan, "string");
    assert.deepEqual(opts?.chain, { dir: dirname(artifactPath), artifactPath });
  });

  it("the artifact's value wins over an explicit input of the same name", async () => {
    const artifactPath = writeArtifact();
    await startRun(
      {
        pipeline: "plan-run",
        inputs: { plan: "explicit plan, to be overridden by the artifact" },
        artifactPath,
      },
      deps()
    );
    assert.equal(calls[0][1].plan, "My Feature Spec: Implement dark mode");
  });

  it("renders a structured spec to the same text the gate showed, not JSON", async () => {
    const hardened = {
      title: "Dark Mode",
      description: "Add a dark mode theme toggle to the application",
      requirements: ["System MUST provide a theme toggle"],
      acceptanceCriteria: ["Given a light theme, when the toggle is clicked, then it is dark"],
      weaknesses: [{ text: "Toggle state not persisted", severity: "medium" as const }],
      securityFindings: [],
    };
    const artifactPath = writeArtifact({ spec: hardened });
    await startRun({ pipeline: "plan-run", artifactPath }, deps());
    const plan = calls[0][1].plan;
    assert.equal(plan, renderSpecKitSpec(hardened));
    assert.ok(typeof plan === "string" && plan.includes("Dark Mode") && !plan.startsWith("{"));
  });

  it("reads a named result key of the accumulated context into a matching input", async () => {
    const artifactPath = writeArtifact({ result: { findings: "No security issues found" } });
    pipeline("find-run", [
      "inputs:",
      "  - findings",
      "steps:",
      "  - id: only",
      "    kind: llm",
      "    role: worker",
      "    prompt: prompts/p.md",
    ]);
    writeFileSync(join(pipelinesRoot, "prompts", "p.md"), "{{findings}}\n");
    await startRun({ pipeline: "find-run", artifactPath }, deps());
    assert.deepEqual(calls[0][1], { findings: "No security issues found" });
  });

  it("refuses, and starts nothing, when a required input cannot be resolved", async () => {
    const artifactPath = writeArtifact({ spec: undefined });
    const message = await refusal({ pipeline: "plan-run", artifactPath });
    assert.match(message, /plan/);
  });
});
