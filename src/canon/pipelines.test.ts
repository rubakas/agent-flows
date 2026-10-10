// Tests for the project-scoped pipelines module (spec 047 FR-12).
//
// Every test builds its own layers under a mkdtemp directory and never reads the
// owner's real user library: the one test that goes through `projectPipelines`
// pins AGENT_FLOWS_HOME.

import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { layerFrom, type CanonLayer } from "./layers.js";
import {
  bundledPipelines,
  PipelinePathError,
  pipelinesIn,
  projectPipelines,
  type Lookup,
} from "./pipelines.js";

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "af-pipelines-")));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A layer with both of its directories created. */
function makeLayer(source: CanonLayer["source"], name: string): CanonLayer {
  const layer = layerFrom(source, join(dir, name));
  mkdirSync(layer.pipelinesDir, { recursive: true });
  mkdirSync(layer.promptsDir, { recursive: true });
  return layer;
}

function write(layer: CanonLayer, id: string, lines: string[], file = id): string {
  const path = join(layer.pipelinesDir, `${file}.yaml`);
  writeFileSync(path, [`id: ${id}`, "version: 1", `description: ${id}`, ...lines, ""].join("\n"));
  return path;
}

const GATE = ["inputs: []", "steps:", "  - id: start", "    kind: gate"];

const mount = (child: string, kind = "pipeline"): string[] => [
  "inputs: []",
  "steps:",
  "  - id: mount",
  `    kind: ${kind}`,
  `    pipeline: ${child}`,
  ...(kind === "loop" ? ["    maxIterations: 2", "    until: start.passed"] : []),
];

const llm = (prompt: string, stepId = "write"): string[] => [
  "inputs:",
  "  - request",
  "steps:",
  `  - id: ${stepId}`,
  "    kind: llm",
  "    role: worker",
  `    prompt: ${prompt}`,
];

function okOf(lookup: Lookup) {
  assert.equal(lookup.kind, "ok", `expected ok, got ${lookup.kind}`);
  if (lookup.kind !== "ok") throw new Error("unreachable");
  return lookup;
}

describe("get — one id across layers", () => {
  it("is absent for an id no layer defines", () => {
    const repo = makeLayer("repo", "repo");
    assert.deepEqual(pipelinesIn([repo]).get("nope"), { kind: "absent" });
  });

  it("loads a parent whose child lives in another layer (the sibling rule would 404)", () => {
    const bundled = makeLayer("bundled", "pkg");
    const repo = makeLayer("repo", "repo");
    write(bundled, "child", GATE);
    write(repo, "parent", mount("child"));

    const found = okOf(pipelinesIn([bundled, repo]).get("parent"));

    assert.equal(found.file.layer.source, "repo");
    assert.deepEqual(
      found.loaded.def.steps.map((s) => s.id),
      ["mount.start"],
      "the child was mounted from the bundled layer"
    );
  });

  it("resolves a nested id to the winning layer's copy", () => {
    const bundled = makeLayer("bundled", "pkg");
    const user = makeLayer("user", "user");
    write(bundled, "child", ["inputs: []", "steps:", "  - id: old", "    kind: gate"]);
    write(user, "child", ["inputs: []", "steps:", "  - id: fresh", "    kind: gate"]);
    write(bundled, "parent", mount("child"));

    const found = okOf(pipelinesIn([bundled, user]).get("parent"));

    assert.deepEqual(
      found.loaded.def.steps.map((s) => s.id),
      ["mount.fresh"]
    );
  });

  it("answers the highest-precedence file and records what it shadows", () => {
    const bundled = makeLayer("bundled", "pkg");
    const user = makeLayer("user", "user");
    const repo = makeLayer("repo", "repo");
    write(bundled, "shared", GATE);
    write(user, "shared", GATE);
    const repoFile = write(repo, "shared", GATE);

    const found = okOf(pipelinesIn([bundled, user, repo]).get("shared"));

    assert.equal(found.file.filePath, repoFile);
    assert.deepEqual(found.file.shadows, ["bundled", "user"]);
  });

  it("reports a defined-but-unloadable pipeline as broken, keeping the original Error", () => {
    const repo = makeLayer("repo", "repo");
    write(repo, "bad", ["inputs: []", "steps:", "  - id: a", "    kind: llm", "    role: worker"]);

    const lookup = pipelinesIn([repo]).get("bad");

    assert.equal(lookup.kind, "broken");
    if (lookup.kind !== "broken") return;
    assert.ok(lookup.error instanceof Error);
    assert.match(lookup.error.message, /llm step requires prompt/);
    assert.equal(lookup.file.id, "bad", "the file is still named, so a caller can say which one");
  });

  it("reports a nested id that no layer defines as broken, not as a sibling lookup", () => {
    const repo = makeLayer("repo", "repo");
    write(repo, "parent", mount("ghost"));
    // A sibling file the old loader would have found by name must not rescue it:
    // it is in no catalogue entry because its declared id differs.
    write(repo, "elsewhere", GATE, "ghost");

    const lookup = pipelinesIn([repo]).get("parent");

    assert.equal(lookup.kind, "broken");
    if (lookup.kind !== "broken") return;
    assert.match(lookup.error.message, /ghost/);
  });
});

describe("editable", () => {
  it("is true for the repo and user layers and false for the bundled layer", () => {
    const bundled = makeLayer("bundled", "pkg");
    const user = makeLayer("user", "user");
    const repo = makeLayer("repo", "repo");
    write(bundled, "b", GATE);
    write(user, "u", GATE);
    write(repo, "r", GATE);
    const view = pipelinesIn([bundled, user, repo]);

    assert.equal(okOf(view.get("b")).file.editable, false);
    assert.equal(okOf(view.get("u")).file.editable, true);
    assert.equal(okOf(view.get("r")).file.editable, true);
  });

  it("follows the winner: a repo fork of a bundled id is editable, the bundled copy is not", () => {
    const bundled = makeLayer("bundled", "pkg");
    const repo = makeLayer("repo", "repo");
    write(bundled, "shared", GATE);
    assert.equal(okOf(pipelinesIn([bundled, repo]).get("shared")).file.editable, false);

    write(repo, "shared", GATE);
    assert.equal(okOf(pipelinesIn([bundled, repo]).get("shared")).file.editable, true);
  });
});

describe("prompts — the own llm steps' files", () => {
  it("lists every own llm step, writable only for an existing .md under the layer's prompts/", () => {
    const repo = makeLayer("repo", "repo");
    writeFileSync(join(repo.promptsDir, "ok.md"), "{{request}}");
    writeFileSync(join(repo.promptsDir, "evil.yaml"), "not markdown\n");
    writeFileSync(join(repo.root, "providers.yaml"), "profiles: {}\n");
    write(repo, "p", [
      "inputs:",
      "  - request",
      "steps:",
      "  - id: good",
      "    kind: llm",
      "    role: worker",
      "    prompt: prompts/ok.md",
      "  - id: yaml",
      "    kind: llm",
      "    role: worker",
      "    prompt: prompts/evil.yaml",
      "    dependsOn: [good]",
      "  - id: outside",
      "    kind: llm",
      "    role: worker",
      "    prompt: providers.yaml",
      "    dependsOn: [yaml]",
      "  - id: after",
      "    kind: gate",
      "    dependsOn: [outside]",
    ]);

    const prompts = okOf(pipelinesIn([repo]).get("p")).file.prompts;

    assert.deepEqual([...prompts.keys()], ["good", "yaml", "outside"], "no entry for a gate step");
    assert.equal(prompts.get("good")?.writable, true);
    assert.equal(prompts.get("good")?.rel, "prompts/ok.md");
    assert.equal(prompts.get("good")?.abs, join(repo.root, "prompts", "ok.md"));
    assert.equal(prompts.get("yaml")?.writable, false, "a non-.md file is not writable");
    assert.equal(prompts.get("outside")?.writable, false, "providers.yaml is not under prompts/");
  });

  it("is not writable for a symlink under prompts/ that points outside it, inside the layer root", () => {
    const repo = makeLayer("repo", "repo");
    const elsewhere = join(repo.root, "providers-notes.md");
    writeFileSync(elsewhere, "{{request}}");
    symlinkSync(elsewhere, join(repo.promptsDir, "link.md"));
    write(repo, "p", llm("prompts/link.md"));

    const found = okOf(pipelinesIn([repo]).get("p"));

    assert.equal(found.file.prompts.get("write")?.writable, false);
  });

  it("is not writable for a .md name that is a symlink to a non-.md file inside prompts/", () => {
    const repo = makeLayer("repo", "repo");
    writeFileSync(join(repo.promptsDir, "real.yaml"), "not markdown\n");
    symlinkSync(join(repo.promptsDir, "real.yaml"), join(repo.promptsDir, "alias.md"));
    write(repo, "p", llm("prompts/alias.md"));

    const found = okOf(pipelinesIn([repo]).get("p"));

    assert.equal(found.file.prompts.get("write")?.writable, false);
  });

  it("is not writable when the prompt file does not exist", () => {
    const repo = makeLayer("repo", "repo");
    write(repo, "p", llm("prompts/missing.md"));

    const lookup = pipelinesIn([repo]).get("p");

    assert.equal(lookup.kind, "broken", "the loader also needs the file");
    if (lookup.kind !== "broken") return;
    assert.equal(lookup.file.prompts.get("write")?.writable, false);
  });

  it("omits a nested pipeline's steps: they belong to another file", () => {
    const bundled = makeLayer("bundled", "pkg");
    const repo = makeLayer("repo", "repo");
    writeFileSync(join(bundled.promptsDir, "c.md"), "{{request}}");
    write(bundled, "child", llm("prompts/c.md"));
    write(repo, "parent", [
      "inputs:",
      "  - request",
      "steps:",
      "  - id: m",
      "    kind: pipeline",
      "    pipeline: child",
      "    with:",
      "      request: request",
    ]);

    const found = okOf(pipelinesIn([bundled, repo]).get("parent"));

    assert.ok(
      found.loaded.def.steps.some((s) => s.id === "m.write"),
      "the child's step is inlined"
    );
    assert.equal(found.file.prompts.size, 0, "but its prompt is not the parent's to edit");
  });

  it("is empty for a document that does not parse", () => {
    const repo = makeLayer("repo", "repo");
    writeFileSync(join(repo.pipelinesDir, "junk.yaml"), "id: junk\nsteps: [this is: not valid");

    // Not parseable, so it has no catalogue entry at all.
    assert.deepEqual(pipelinesIn([repo]).get("junk"), { kind: "absent" });
  });
});

describe("all", () => {
  it("returns every loadable winning pipeline and reports everything else", () => {
    const bundled = makeLayer("bundled", "pkg");
    const repo = makeLayer("repo", "repo");
    write(bundled, "good", GATE);
    write(repo, "broken", [
      "inputs: []",
      "steps:",
      "  - id: a",
      "    kind: llm",
      "    role: worker",
    ]);
    writeFileSync(join(repo.pipelinesDir, "noid.yaml"), "version: 1\n");

    const { found, errors } = pipelinesIn([bundled, repo]).all();

    assert.deepEqual(
      found.map((f) => f.file.id),
      ["good"]
    );
    assert.equal(errors.length, 2, JSON.stringify(errors));
    assert.ok(errors.some((e) => e.file.endsWith("broken.yaml")));
    assert.ok(errors.some((e) => e.file.endsWith("noid.yaml")));
  });

  it("reports two files of one layer declaring one id", () => {
    const repo = makeLayer("repo", "repo");
    write(repo, "twin", GATE, "twin-a");
    write(repo, "twin", GATE, "twin-b");

    const { found, errors } = pipelinesIn([repo]).all();

    assert.equal(errors.length, 1, JSON.stringify(errors));
    assert.match(errors[0].error, /"twin" is also declared by .*twin-a\.yaml/);
    assert.match(errors[0].file, /twin-b\.yaml$/);
    assert.deepEqual(
      found.map((f) => f.file.id),
      ["twin"],
      "the later file still wins, as before"
    );
    assert.deepEqual(found[0]?.file.shadows, [], "a same-layer twin is not shadowing");
  });

  it("does not report the same id in different layers as a collision", () => {
    const bundled = makeLayer("bundled", "pkg");
    const repo = makeLayer("repo", "repo");
    write(bundled, "shared", GATE);
    write(repo, "shared", GATE);

    assert.deepEqual(pipelinesIn([bundled, repo]).all().errors, []);
  });

  it("lists in id order", () => {
    const repo = makeLayer("repo", "repo");
    for (const id of ["c", "a", "b"]) write(repo, id, GATE);

    assert.deepEqual(
      pipelinesIn([repo])
        .all()
        .found.map((f) => f.file.id),
      ["a", "b", "c"]
    );
  });
});

describe("layerOf", () => {
  it("names the layer whose pipelines/ directory holds the file", () => {
    const bundled = makeLayer("bundled", "pkg");
    const repo = makeLayer("repo", "repo");
    const view = pipelinesIn([bundled, repo]);

    assert.equal(view.layerOf(join(repo.pipelinesDir, "x.yaml"))?.source, "repo");
    assert.equal(view.layerOf(join(bundled.pipelinesDir, "x.yml"))?.source, "bundled");
  });

  it("is undefined for a path in no layer, a subdirectory, a non-YAML file or a missing directory", () => {
    const repo = makeLayer("repo", "repo");
    mkdirSync(join(repo.pipelinesDir, "sub"));
    const view = pipelinesIn([repo]);

    assert.equal(view.layerOf(join(dir, "elsewhere", "x.yaml")), undefined);
    assert.equal(view.layerOf(join(repo.pipelinesDir, "sub", "x.yaml")), undefined);
    assert.equal(view.layerOf(join(repo.pipelinesDir, "notes.md")), undefined);
    assert.equal(view.layerOf(join(repo.pipelinesDir, "..", "x.yaml")), undefined);
  });

  it("compares real paths, so a symlinked alias of a layer directory is still that layer", () => {
    const repo = makeLayer("repo", "repo");
    const alias = join(dir, "alias");
    symlinkSync(repo.pipelinesDir, alias);

    assert.equal(pipelinesIn([repo]).layerOf(join(alias, "x.yaml"))?.source, "repo");
  });
});

describe("check — validate a file of the view with in-memory edits", () => {
  it("loads a file whose child is in another layer, which the bare loader could not", () => {
    const bundled = makeLayer("bundled", "pkg");
    const repo = makeLayer("repo", "repo");
    write(bundled, "child", GATE);
    const parent = write(repo, "parent", mount("child"));

    const loaded = pipelinesIn([bundled, repo]).check(parent);

    assert.deepEqual(
      loaded.def.steps.map((s) => s.id),
      ["mount.start"]
    );
  });

  it("validates a draft body in place of the file without writing it", () => {
    const repo = makeLayer("repo", "repo");
    const file = write(repo, "p", GATE);
    const before = readFileSync(file, "utf8");
    const view = pipelinesIn([repo]);

    const loaded = view.check(file, {
      body: before.replace("kind: gate", "kind: gate\n  - id: b\n    kind: gate"),
    });
    assert.equal(loaded.def.steps.length, 2);

    assert.throws(() => view.check(file, { body: "id: p\nsteps: [this is: not valid" }));
    assert.equal(readFileSync(file, "utf8"), before, "check never writes");
  });

  it("validates the load error of the edited body, not of the file on disk", () => {
    const repo = makeLayer("repo", "repo");
    const file = write(repo, "p", GATE);
    const broken = readFileSync(file, "utf8").replace("kind: gate", "kind: llm");

    assert.throws(() => pipelinesIn([repo]).check(file, { body: broken }), /llm step requires/);
    assert.doesNotThrow(() => pipelinesIn([repo]).check(file), "the file on disk is fine");
  });

  it("validates new prompt text in place of the file, reporting an unknown placeholder", () => {
    const repo = makeLayer("repo", "repo");
    const prompt = join(repo.promptsDir, "w.md");
    writeFileSync(prompt, "{{request}}");
    const file = write(repo, "p", llm("prompts/w.md"));
    const view = pipelinesIn([repo]);

    assert.doesNotThrow(() => view.check(file, { prompts: { write: "fine {{request}}" } }));
    assert.throws(
      () => view.check(file, { prompts: { write: "{{nonsense}}" } }),
      /unknown placeholder "\{\{nonsense\}\}"/
    );
    assert.equal(readFileSync(prompt, "utf8"), "{{request}}", "the prompt on disk is untouched");
  });

  it("takes prompt paths from the draft body: a re-pointed step is checked against its new file", () => {
    const repo = makeLayer("repo", "repo");
    writeFileSync(join(repo.promptsDir, "old.md"), "{{request}}");
    writeFileSync(join(repo.promptsDir, "new.md"), "{{request}}");
    const file = write(repo, "p", llm("prompts/old.md"));
    const repointed = readFileSync(file, "utf8").replace("prompts/old.md", "prompts/new.md");
    const view = pipelinesIn([repo]);

    // The bad text is for the NEW file. Read from disk, the old path would take
    // the override and the new file would pass unchecked.
    assert.throws(
      () => view.check(file, { body: repointed, prompts: { write: "{{nonsense}}" } }),
      /unknown placeholder/
    );
    // Without a body the same edit targets the file on disk.
    assert.throws(
      () => view.check(file, { prompts: { write: "{{nonsense}}" } }),
      /unknown placeholder/
    );
  });

  it("ignores prompt text for a step that is not an own llm step", () => {
    const repo = makeLayer("repo", "repo");
    const file = write(repo, "p", GATE);

    assert.doesNotThrow(() => pipelinesIn([repo]).check(file, { prompts: { start: "{{x}}" } }));
  });

  it("refuses a path that is not a pipeline file of any layer", () => {
    const repo = makeLayer("repo", "repo");
    const outside = join(dir, "outside.yaml");
    writeFileSync(outside, "id: outside\nversion: 1\ndescription: x\ninputs: []\nsteps: []\n");
    mkdirSync(join(repo.pipelinesDir, "sub"));
    writeFileSync(join(repo.pipelinesDir, "sub", "x.yaml"), "id: x\n");
    const view = pipelinesIn([repo]);

    for (const path of [
      outside,
      join(repo.pipelinesDir, "sub", "x.yaml"),
      join(repo.pipelinesDir, "..", "outside.yaml"),
      join(repo.promptsDir, "w.md"),
    ]) {
      assert.throws(
        () => view.check(path, { body: "id: x" }),
        PipelinePathError,
        `must refuse ${path}`
      );
    }
  });
});

describe("nesters — who mounts an id, in any layer", () => {
  it("finds a parent in another layer, by a pipeline step or a loop step", () => {
    const bundled = makeLayer("bundled", "pkg");
    const user = makeLayer("user", "user");
    const repo = makeLayer("repo", "repo");
    write(repo, "child", GATE);
    write(user, "personal-parent", mount("child"));
    write(bundled, "looper", mount("child", "loop"));
    write(bundled, "unrelated", GATE);

    assert.deepEqual(pipelinesIn([bundled, user, repo]).nesters("child"), [
      "looper",
      "personal-parent",
    ]);
  });

  it("does not count the id itself, nor an unparseable file", () => {
    const repo = makeLayer("repo", "repo");
    write(repo, "child", mount("child"));
    writeFileSync(join(repo.pipelinesDir, "junk.yaml"), "id: junk\nsteps: [this is: not valid");

    assert.deepEqual(pipelinesIn([repo]).nesters("child"), []);
  });

  it("counts only winning pipelines: a shadowed parent is not in use", () => {
    const bundled = makeLayer("bundled", "pkg");
    const repo = makeLayer("repo", "repo");
    write(repo, "child", GATE);
    write(bundled, "parent", mount("child"));
    write(repo, "parent", GATE); // the repo copy wins and no longer mounts child

    assert.deepEqual(pipelinesIn([bundled, repo]).nesters("child"), []);
  });
});

describe("the three constructors", () => {
  it("projectPipelines stacks the layers present for a project, lowest precedence first", () => {
    const home = join(dir, "home");
    const project = join(dir, "project");
    mkdirSync(join(home, "workflows", "pipelines"), { recursive: true });
    mkdirSync(join(project, ".agent-flows", "pipelines"), { recursive: true });

    const view = projectPipelines(project, { AGENT_FLOWS_HOME: home });

    assert.deepEqual(
      view.layers.map((l) => l.source),
      ["bundled", "user", "repo"]
    );
    assert.equal(view.layers[1]?.root, join(home, "workflows"));
  });

  it("bundledPipelines is the package's own catalogue and loads without errors", () => {
    const view = bundledPipelines();
    const { found, errors } = view.all();

    assert.deepEqual(errors, []);
    assert.deepEqual(
      view.layers.map((l) => l.source),
      ["bundled"]
    );
    assert.ok(found.some((f) => f.file.id === "build"));
    assert.equal(okOf(view.get("build")).file.editable, false);
    assert.ok(
      okOf(view.get("build")).loaded.def.steps.some((s) => s.id.startsWith("develop.")),
      "build mounts develop from the same layer"
    );
  });
});
