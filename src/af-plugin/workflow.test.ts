// The review-engine workflow (spec 046 D5, FR-5). The committed script and schema files are
// generated from the plugin's prompts and the canon's schema rules; this file pins them to
// the generator and runs the script against stub runtime globals to prove the step graph,
// models, schemas and isolation it promises.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";

import { unavailableStepMarker } from "../bindings/mastra/buildSteps.js";
import { pipelineAncestors } from "../canon/graph.js";
import { bundledPipelines } from "../canon/pipelines.js";
import { getProfile } from "../canon/registry.js";
import {
  buildSchemaFiles,
  buildWorkflow,
  reviewEngineTables,
  STEPS,
  WORKFLOW_PATH,
} from "./buildReviewEngine.js";
import type { LoadedPipeline } from "../canon/types.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// The plugin's check.mjs sits outside tsconfig's program: it is loaded by a computed
// specifier and described here, so no declaration file has to ship inside the plugin.
interface Checker {
  loadSchema: (name: string) => unknown;
}
const checker = (await import(
  pathToFileURL(join(root, "plugin", "skills", "review", "scripts", "check.mjs")).href
)) as Checker;
const { loadSchema } = checker;
const committed = readFileSync(WORKFLOW_PATH, "utf8");

/** The bundled code-review pipeline as the generator loads it, safe to mutate. */
function reviewPipeline(): LoadedPipeline {
  const found = bundledPipelines().get("code-review");
  assert.equal(found.kind, "ok", "the bundled code-review pipeline must load");
  if (found.kind !== "ok") throw new Error("unreachable");
  return structuredClone(found.loaded);
}

interface Call {
  prompt: string;
  opts: Record<string, any>;
}

/** Compiles a workflow body as an async function over the runtime globals. */
function compile(source: string) {
  const body = source.replace(/^export const meta = /m, "const meta = ");
  assert.notEqual(body, source, "script has no `export const meta`");
  const script = new vm.Script(
    `(async function (agent, parallel, phase, log, args) {\n${body}\n})`,
    { filename: "review-engine.js" }
  );
  return script.runInNewContext({}) as (...globals: unknown[]) => Promise<any>;
}

function stubs(overrides: Record<string, (call: Call) => unknown> = {}) {
  const calls: Call[] = [];
  const events: string[] = [];
  const logs: string[] = [];
  const phases: string[] = [];
  const outputs: Record<string, unknown> = {
    brief: "BRIEF_OUT",
    radius: "RADIUS_OUT",
    falsifiability: "FALSIFIABILITY_OUT",
    delivery: { specSourcesProvided: true, codeReviewDelivery: [{ requirement: "DELIVERY_OUT" }] },
    correctness: "CORRECTNESS_OUT",
    security: "SECURITY_OUT",
    verify: { codeReviewFindings: [{ claim: "VERIFY_OUT" }] },
    synthesis: "SYNTHESIS_OUT",
  };
  // falsifiability and delivery finish only after BOTH correctness and security have been
  // called, so a script that made them wait would never get there (the test times out).
  let dimensionsStarted!: () => void;
  const dimensionsCalled = new Promise<void>((resolve) => (dimensionsStarted = resolve));
  const agent = async (prompt: string, opts: Record<string, any>) => {
    const call = { prompt, opts };
    calls.push(call);
    events.push(`start:${opts.label}`);
    if (
      calls.some((c) => c.opts.label === "correctness") &&
      calls.some((c) => c.opts.label === "security")
    ) {
      dimensionsStarted();
    }
    if (opts.label === "falsifiability" || opts.label === "delivery") await dimensionsCalled;
    await Promise.resolve();
    events.push(`end:${opts.label}`);
    return opts.label in overrides ? overrides[opts.label](call) : outputs[opts.label];
  };
  const parallel = (thunks: (() => Promise<unknown>)[]) =>
    Promise.all(thunks.map((thunk) => thunk()));
  return {
    calls,
    events,
    logs,
    phases,
    globals: (args: unknown) => [
      agent,
      parallel,
      (title: string) => phases.push(title),
      (message: string) => logs.push(message),
      args,
    ],
  };
}

const byLabel = (calls: Call[], label: string) => calls.find((c) => c.opts.label === label)!;

describe("review-engine freshness (FR-5)", () => {
  it("the committed script equals the generator output", () => {
    assert.equal(
      committed,
      buildWorkflow(),
      "plugin/workflows/review-engine.js is stale or hand-edited - run: pnpm plugin:generate"
    );
  });

  it("the committed schema files equal the generated ones, and nothing else sits beside them", async () => {
    const generated = await buildSchemaFiles();
    for (const [path, text] of Object.entries(generated)) {
      assert.equal(
        readFileSync(path, "utf8"),
        text,
        `${path} is stale or hand-edited - run: pnpm plugin:generate`
      );
    }
    assert.deepEqual(
      readdirSync(join(root, "plugin", "skills", "review", "references", "schemas")).sort(),
      Object.keys(generated)
        .map((path) => path.slice(path.lastIndexOf("/") + 1))
        .sort()
    );
  });

  it("starts with a literal meta block and uses no clock or randomness", () => {
    const code = committed.replace(/^\/\/.*\n/gm, "");
    assert.ok(code.startsWith("export const meta = {"), "meta must be the first statement");
    // Prompts are prose and may mention dates; only the script's own logic is checked.
    assert.doesNotMatch(
      committed.slice(committed.indexOf("const ARGS")),
      /Date\.now|Math\.random|new Date\(/
    );
    const literal = /^export const meta = (\{[\s\S]*?\n\})\n/m.exec(committed)![1];
    const meta = JSON.parse(JSON.stringify(vm.runInNewContext(`(${literal})`))) as {
      name: string;
      phases: { title: string }[];
    };
    assert.equal(meta.name, "review-engine");
    assert.deepEqual(
      meta.phases.map((p) => p.title),
      ["Brief", "Review", "Verify", "Synthesis"]
    );
  });

  describe("generator refuses", () => {
    const refuses = (edit: (loaded: LoadedPipeline) => void, message: RegExp) => {
      const loaded = reviewPipeline();
      edit(loaded);
      assert.throws(() => buildWorkflow(loaded), message);
    };
    const step = (loaded: LoadedPipeline, id: string) =>
      loaded.def.steps.find((st) => st.id === id)!;

    it("builds the committed script from the pipeline as it is", () => {
      assert.equal(buildWorkflow(reviewPipeline()), committed);
    });

    it("a step kind the engine has no code for", () => {
      refuses((loaded) => {
        step(loaded, "security").kind = "check";
      }, /security.*kind check/);
    });

    it("an llm step without a role", () => {
      refuses((loaded) => {
        delete step(loaded, "correctness").role;
      }, /correctness.*no role/);
    });

    it("a role the anthropic profile maps outside opus, sonnet and haiku", () => {
      const roles = { reasoner: "gpt-terra", worker: "sonnet", scout: "haiku" } as const;
      assert.throws(
        () => reviewEngineTables(reviewPipeline(), roles),
        /verify.*gpt-terra.*opus, sonnet, haiku/
      );
    });

    it("a schema key with no schema file", () => {
      refuses((loaded) => {
        step(loaded, "verify").schema = "weaknesses";
      }, /verify.*schema weaknesses/);
    });

    it("a schema key that only exists on Object.prototype", () => {
      refuses((loaded) => {
        (step(loaded, "verify") as { schema?: string }).schema = "constructor";
      }, /verify.*schema constructor/);
    });

    it("a placeholder the engine cannot fill", () => {
      refuses((loaded) => {
        loaded.prompts.verify += "\n{{baseline}}\n";
      }, /verify.*placeholder.*baseline/);
    });

    it("a synthesis prompt that takes more than {{verify}}", () => {
      refuses((loaded) => {
        loaded.prompts.synthesis += "\nBrief:\n{{brief}}\n";
      }, /synthesis.*beyond \{\{verify\}\}: brief/);
    });

    it("follows a flipped role into the script's model table", () => {
      const loaded = reviewPipeline();
      step(loaded, "correctness").role = "reasoner";
      const script = buildWorkflow(loaded);
      assert.notEqual(script, committed);
      assert.match(script, /"correctness": "opus"/);
      assert.match(committed, /"correctness": "sonnet"/);
    });

    it("reads the anthropic tiers, never the active provider", () => {
      const before = process.env.AGENT_FLOWS_PROVIDER;
      process.env.AGENT_FLOWS_PROVIDER = "openai";
      try {
        assert.equal(buildWorkflow(), committed);
      } finally {
        if (before === undefined) delete process.env.AGENT_FLOWS_PROVIDER;
        else process.env.AGENT_FLOWS_PROVIDER = before;
      }
    });
  });
});

describe("review-engine run", () => {
  const run = compile(committed);
  const args = { runDir: "/repo/.af-review/RUN", plan: "THE_PLAN", hasSpecs: true };

  it("runs eight steps with specs, all as af:reviewer, and returns synthesis and verify", async () => {
    const s = stubs();
    const result = await run(...s.globals(args));
    assert.equal(s.calls.length, 8);
    for (const call of s.calls) {
      assert.equal(call.opts.agentType, "af:reviewer");
      assert.ok(call.opts.label && call.opts.phase);
    }
    // The script runs in another realm; compare by value, not prototype.
    assert.deepEqual(JSON.parse(JSON.stringify(result)), {
      synthesis: "SYNTHESIS_OUT",
      verify: { codeReviewFindings: [{ claim: "VERIFY_OUT" }] },
    });
    assert.deepEqual(s.phases, ["Brief", "Review", "Verify", "Synthesis"]);
  });

  it("runs seven steps without specs and gives verify the empty delivery JSON", async () => {
    const s = stubs();
    await run(...s.globals({ ...args, hasSpecs: false }));
    assert.equal(s.calls.length, 7);
    assert.equal(
      s.calls.some((c) => c.opts.label === "delivery"),
      false
    );
    assert.ok(
      byLabel(s.calls, "verify").prompt.includes(
        '{"specSourcesProvided":false,"codeReviewDelivery":[]}'
      )
    );
  });

  it("assigns models by tier", async () => {
    const s = stubs();
    await run(...s.globals(args));
    const models = Object.fromEntries(s.calls.map((c) => [c.opts.label, c.opts.model]));
    assert.deepEqual(models, {
      brief: "haiku",
      radius: "sonnet",
      falsifiability: "sonnet",
      delivery: "sonnet",
      correctness: "sonnet",
      security: "sonnet",
      verify: "opus",
      synthesis: "opus",
    });
  });

  it("gives verify and delivery their schemas and no other step one", async () => {
    const s = stubs();
    await run(...s.globals(args));
    for (const call of s.calls) {
      const expected =
        call.opts.label === "verify"
          ? loadSchema("findings")
          : call.opts.label === "delivery"
            ? loadSchema("delivery")
            : undefined;
      assert.deepEqual(
        call.opts.schema === undefined ? undefined : JSON.parse(JSON.stringify(call.opts.schema)),
        expected,
        call.opts.label
      );
    }
  });

  it(
    "starts correctness and security without waiting for falsifiability or delivery",
    { timeout: 5000 },
    async () => {
      const s = stubs();
      await run(...s.globals(args));
      const at = (event: string) => s.events.indexOf(event);
      for (const dimension of ["correctness", "security"]) {
        assert.ok(at(`start:${dimension}`) > at("end:radius"), `${dimension} waits for radius`);
        assert.ok(
          at(`start:${dimension}`) < at("end:falsifiability"),
          `${dimension} vs falsifiability`
        );
        assert.ok(at(`start:${dimension}`) < at("end:delivery"), `${dimension} vs delivery`);
      }
      assert.ok(at("start:verify") > at("end:delivery"));
      assert.ok(at("start:verify") > at("end:security"));
    }
  );

  it("hands synthesis the verify output and none of the worker outputs", async () => {
    const s = stubs();
    await run(...s.globals(args));
    const prompt = byLabel(s.calls, "synthesis").prompt;
    assert.match(prompt, /VERIFY_OUT/);
    for (const marker of [
      "BRIEF_OUT",
      "RADIUS_OUT",
      "FALSIFIABILITY_OUT",
      "DELIVERY_OUT",
      "CORRECTNESS_OUT",
      "SECURITY_OUT",
      "THE_PLAN",
      "material.md",
    ]) {
      assert.equal(prompt.includes(marker), false, `synthesis prompt leaked ${marker}`);
    }
  });

  it("feeds the workers' outputs and the material instruction to verify", async () => {
    const s = stubs();
    await run(...s.globals(args));
    const prompt = byLabel(s.calls, "verify").prompt;
    for (const marker of [
      "BRIEF_OUT",
      "FALSIFIABILITY_OUT",
      "DELIVERY_OUT",
      "CORRECTNESS_OUT",
      "SECURITY_OUT",
      "/repo/.af-review/RUN/material.md",
    ]) {
      assert.ok(prompt.includes(marker), `verify prompt lacks ${marker}`);
    }
    assert.match(byLabel(s.calls, "brief").prompt, /THE_PLAN/);
    assert.match(byLabel(s.calls, "delivery").prompt, /\/repo\/\.af-review\/RUN\/specs\//);
  });

  it("leaves no placeholder in any prompt sent", async () => {
    const s = stubs();
    await run(...s.globals(args));
    for (const call of s.calls) assert.doesNotMatch(call.prompt, /\{\{/, call.opts.label);
  });

  it("renders {{plan}} as nothing when no plan was given", async () => {
    const s = stubs();
    await run(...s.globals({ runDir: "/r", hasSpecs: false }));
    const prompt = byLabel(s.calls, "brief").prompt;
    assert.doesNotMatch(prompt, /undefined|none provided|\{\{/);
  });

  it("treats only hasSpecs === true as specs", async () => {
    const s = stubs();
    await run(...s.globals({ runDir: "/r", hasSpecs: "yes" }));
    assert.equal(s.calls.length, 7);
  });

  it("wires each step's inputs to the right upstream outputs", async () => {
    const s = stubs();
    await run(...s.globals(args));
    const prompt = (label: string) => byLabel(s.calls, label).prompt;
    for (const label of ["radius", "falsifiability", "delivery", "correctness", "security"]) {
      assert.ok(prompt(label).includes("BRIEF_OUT"), `${label} lacks the brief`);
    }
    for (const label of ["correctness", "security"]) {
      assert.ok(prompt(label).includes("RADIUS_OUT"), `${label} lacks radius`);
    }
    for (const label of ["radius", "falsifiability", "delivery"]) {
      assert.equal(prompt(label).includes("RADIUS_OUT"), false, `${label} must not see radius`);
    }
    const specs = "/repo/.af-review/RUN/specs/";
    for (const call of s.calls) {
      assert.equal(
        call.prompt.includes(specs),
        call.opts.label === "delivery",
        `spec-sources pointer in ${call.opts.label}`
      );
    }
    for (const marker of [
      "FALSIFIABILITY_OUT",
      "DELIVERY_OUT",
      "CORRECTNESS_OUT",
      "SECURITY_OUT",
    ]) {
      assert.ok(prompt("verify").includes(marker), `verify lacks ${marker}`);
    }
    // verify.md has no {{radius}}: the dimension's output reaches verify through its workers.
    assert.equal(prompt("verify").includes("RADIUS_OUT"), false);
  });

  it("aborts when radius returns nothing, and runs nothing after it", async () => {
    const s = stubs({ radius: () => null });
    await assert.rejects(run(...s.globals(args)), /radius/);
    for (const label of ["correctness", "security", "verify", "synthesis"]) {
      assert.equal(
        s.calls.some((c) => c.opts.label === label),
        false,
        label
      );
    }
  });

  it("aborts when radius throws", async () => {
    const s = stubs({
      radius: () => {
        throw new Error("boom");
      },
    });
    await assert.rejects(run(...s.globals(args)), /boom/);
    assert.equal(
      s.calls.some((c) => c.opts.label === "verify"),
      false
    );
  });

  it("replaces a worker that returns nothing with af's unavailable-step marker and logs it", async () => {
    const s = stubs({ security: () => null });
    await run(...s.globals(args));
    const marker = unavailableStepMarker("security", "the step returned no output");
    assert.ok(byLabel(s.calls, "verify").prompt.includes(marker));
    assert.ok(s.logs.some((message) => message.includes("security")));
    assert.equal(s.calls.length, 8);
  });

  it("replaces a worker that throws with the marker and the run continues", async () => {
    const s = stubs({
      delivery: () => {
        throw new Error("schema still invalid after 5 attempts");
      },
    });
    const result = await run(...s.globals(args));
    const marker = unavailableStepMarker("delivery", "schema still invalid after 5 attempts");
    assert.ok(byLabel(s.calls, "verify").prompt.includes(marker));
    assert.equal(result.synthesis, "SYNTHESIS_OUT");
  });

  it("feeds a failed brief to the dimensions as the marker", async () => {
    const s = stubs({ brief: () => null });
    await run(...s.globals(args));
    const marker = unavailableStepMarker("brief", "the step returned no output");
    assert.ok(byLabel(s.calls, "radius").prompt.includes(marker));
  });

  it("replaces every occurrence of a placeholder, prose mentions included", async () => {
    const s = stubs();
    await run(...s.globals(args));
    const source = readFileSync(
      join(root, "plugin", "skills", "review", "references", "prompts", "verify.md"),
      "utf8"
    );
    const mentions = source.match(/\{\{delivery\}\}/g)!.length;
    assert.ok(mentions >= 2);
    const sent = byLabel(s.calls, "verify").prompt;
    assert.equal(sent.split("DELIVERY_OUT").length - 1, mentions);
  });

  it("throws when verify returns nothing, and runs no synthesis", async () => {
    const s = stubs({ verify: () => null });
    await assert.rejects(run(...s.globals(args)), /verify/);
    assert.equal(
      s.calls.some((c) => c.opts.label === "synthesis"),
      false
    );
  });

  it("throws without runDir", async () => {
    await assert.rejects(run(...stubs().globals({ hasSpecs: true })), /runDir/);
    await assert.rejects(run(...stubs().globals(undefined)), /runDir/);
  });

  it("fails loudly when a placeholder has no mapping", async () => {
    const broken = committed.replace("{ verify: text(verify) }", "{}");
    assert.notEqual(broken, committed);
    await assert.rejects(compile(broken)(...stubs().globals(args)), /no value: verify/);
  });
});

// The review engine is a hand-written schedule (spec 046 D5), so nothing makes it agree
// with pipelines/code-review.yaml except this test. It reads the bundled pipeline through
// the loader and compares everything the YAML declares that the engine also decides.
describe("review engine vs the code-review pipeline", () => {
  type Behaviour = "abort" | "marker" | "log" | "silent";

  // D5 as data: where a null result ends the run in the YAML but the engine carries on. A
  // reviewer that fails must not cost the other dimensions' findings (falsifiability,
  // correctness, security become a marker); a failed synthesis still leaves the verified
  // findings to report (log only). This list must equal what the engine does, so an
  // override that stops differing from the YAML goes red instead of lingering.
  const PLUGIN_DEVIATIONS: Record<string, Behaviour> = {
    falsifiability: "marker",
    correctness: "marker",
    security: "marker",
    synthesis: "log",
  };
  const SCHEMA_FILE = { codeReviewFindings: "findings", codeReviewDelivery: "delivery" } as const;
  const NULL_REASON = "the step returned no output";
  const args = { runDir: "/repo/.af-review/RUN", plan: "THE_PLAN", hasSpecs: true };
  const run = compile(committed);

  function codeReview(): LoadedPipeline["def"] {
    const found = bundledPipelines().get("code-review");
    assert.equal(found.kind, "ok", "the bundled code-review pipeline must load");
    if (found.kind !== "ok") throw new Error("unreachable");
    return structuredClone(found.loaded.def);
  }

  async function behaviourOnNull(id: string): Promise<Behaviour> {
    const s = stubs({ [id]: () => null });
    try {
      await run(...s.globals(args));
    } catch {
      return "abort";
    }
    const marker = unavailableStepMarker(id, NULL_REASON);
    if (s.calls.some((c) => c.prompt.includes(marker))) return "marker";
    if (s.logs.some((message) => message.includes(id))) return "log";
    return "silent";
  }

  /** Every way the engine differs from `def`, empty when they agree. */
  async function disagreements(def: LoadedPipeline["def"]): Promise<string[]> {
    const out: string[] = [];
    const steps = def.steps.filter((step) => step.id !== "material");
    const byId = new Map(steps.map((step) => [step.id, step]));

    const yamlIds = steps.map((step) => step.id).sort();
    const engineIds = [...STEPS].sort();
    if (JSON.stringify(yamlIds) !== JSON.stringify(engineIds)) {
      out.push(`step ids: pipeline ${yamlIds.join(",")} engine ${engineIds.join(",")}`);
      return out;
    }

    const s = stubs();
    await run(...s.globals(args));

    const roles = getProfile("anthropic").roles;
    for (const call of s.calls) {
      const step = byId.get(call.opts.label)!;
      const model = step.role === undefined ? undefined : roles[step.role];
      if (call.opts.model !== model) {
        out.push(`model of ${step.id}: pipeline ${model} engine ${call.opts.model}`);
      }
      const key = step.schema as keyof typeof SCHEMA_FILE | undefined;
      const expected = key === undefined ? undefined : loadSchema(SCHEMA_FILE[key]);
      const actual =
        call.opts.schema === undefined ? undefined : JSON.parse(JSON.stringify(call.opts.schema));
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        out.push(`schema of ${step.id}: pipeline declares ${key ?? "none"}`);
      }
    }

    const at = (event: string) => s.events.indexOf(event);
    for (const step of steps) {
      for (const dep of step.dependsOn ?? []) {
        if (dep === "material") continue;
        if (!(at(`end:${dep}`) !== -1 && at(`end:${dep}`) < at(`start:${step.id}`))) {
          out.push(`edge ${dep} -> ${step.id}: ${step.id} starts before ${dep} has ended`);
        }
      }
    }

    const deviations: Record<string, Behaviour> = {};
    for (const step of steps) {
      const expected: Behaviour = step.required === false ? "marker" : "abort";
      const observed = await behaviourOnNull(step.id);
      if (observed !== expected) deviations[step.id] = observed;
    }
    if (JSON.stringify(deviations) !== JSON.stringify(PLUGIN_DEVIATIONS)) {
      out.push(
        `failure handling: engine deviates from the pipeline's required flags as ` +
          `${JSON.stringify(deviations)}, declared ${JSON.stringify(PLUGIN_DEVIATIONS)}`
      );
    }
    return out;
  }

  it("agrees with pipelines/code-review.yaml on steps, edges, models, schemas and failure handling", async () => {
    assert.deepEqual(await disagreements(codeReview()), []);
  });

  it("declares the schemas the engine hands the agents", () => {
    const schemas = Object.fromEntries(
      codeReview()
        .steps.filter((step) => step.schema !== undefined)
        .map((step) => [step.id, step.schema])
    );
    assert.deepEqual(schemas, { delivery: "codeReviewDelivery", verify: "codeReviewFindings" });
  });

  it("hides no wait: independent steps run side by side", async () => {
    const def = codeReview();
    const ancestors = pipelineAncestors(def.steps);
    const llm = def.steps.filter((st) => st.kind === "llm").map((st) => st.id);
    const related = (a: string, b: string) => ancestors.get(a)!.has(b) || ancestors.get(b)!.has(a);
    const serialised: string[] = [];
    for (const a of llm) {
      for (const b of llm) {
        if (a === b || related(a, b)) continue;
        // a's agent call stays open until b's has started: if the engine makes b wait for a,
        // b never starts and the race below times out.
        let started!: () => void;
        const bStarted = new Promise<void>((resolve) => (started = resolve));
        const s = stubs({ [a]: () => bStarted.then(() => `${a}_OUT`) });
        const [agent, ...rest] = s.globals(args);
        const watching = (prompt: string, opts: Record<string, any>) => {
          if (opts.label === b) started();
          return (agent as (p: string, o: Record<string, any>) => Promise<unknown>)(prompt, opts);
        };
        let timer: NodeJS.Timeout | undefined;
        const timeout = new Promise<string>((resolve) => {
          timer = setTimeout(() => resolve("timeout"), 5000);
        });
        try {
          const outcome = await Promise.race([run(watching, ...rest).then(() => "done"), timeout]);
          if (outcome === "timeout") serialised.push(`${a} -> ${b}`);
        } finally {
          clearTimeout(timer);
        }
      }
    }
    assert.deepEqual(serialised, []);
  });

  describe("can fail", () => {
    const mutate = (edit: (def: LoadedPipeline["def"]) => void) => {
      const def = codeReview();
      edit(def);
      return disagreements(def);
    };
    const step = (def: LoadedPipeline["def"], id: string) => def.steps.find((st) => st.id === id)!;

    it("a flipped role", async () => {
      const found = await mutate((def) => {
        step(def, "correctness").role = "reasoner";
      });
      assert.deepEqual(found, ["model of correctness: pipeline opus engine sonnet"]);
    });

    it("a flipped required on a step the engine degrades (a dead override)", async () => {
      const found = await mutate((def) => {
        step(def, "security").required = false;
      });
      assert.equal(found.length, 1);
      assert.match(found[0], /^failure handling: .*declared/);
    });

    it("a flipped required on a step the engine aborts on", async () => {
      const found = await mutate((def) => {
        step(def, "radius").required = false;
      });
      assert.equal(found.length, 1);
      assert.match(found[0], /^failure handling: /);
    });

    it("an added edge", async () => {
      const found = await mutate((def) => {
        step(def, "falsifiability").dependsOn = ["brief", "radius"];
      });
      assert.deepEqual(found, [
        "edge radius -> falsifiability: falsifiability starts before radius has ended",
      ]);
    });

    it("a changed schema key", async () => {
      const found = await mutate((def) => {
        step(def, "verify").schema = "codeReviewDelivery";
      });
      assert.deepEqual(found, ["schema of verify: pipeline declares codeReviewDelivery"]);
    });

    it("a step the engine does not have", async () => {
      const found = await mutate((def) => {
        def.steps = [...def.steps, { id: "extra", kind: "llm", role: "worker", prompt: "p.md" }];
      });
      assert.match(found[0], /^step ids: /);
    });
  });
});
