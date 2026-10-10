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

// ── Moved from layers.test.ts: loading through the merged view ─────────────────
//
// These pinned `loadFromCatalog` / `loadCatalogPipelines` (FR-018, FR-019 and
// the listing path); `get` and `all` are the same behaviour behind the new
// interface.

/** A pipeline with one llm step reading `prompts/<promptName>.md` of its own layer. */
function writePromptPipeline(
  layer: CanonLayer,
  id: string,
  promptName: string,
  promptText: string
): void {
  write(layer, id, [
    "inputs: []",
    "steps:",
    "  - id: write",
    "    kind: llm",
    "    role: worker",
    `    prompt: prompts/${promptName}.md`,
  ]);
  writeFileSync(join(layer.promptsDir, `${promptName}.md`), promptText);
}

describe("prompts resolve within the owning layer (FR-018)", () => {
  it("two layers holding a prompt file of the same name each read their own", () => {
    const bundled = makeLayer("bundled", "package");
    const repo = makeLayer("repo", "project/.agent-flows");
    writePromptPipeline(bundled, "bundled-writer", "shared", "BUNDLED PROMPT BODY");
    writePromptPipeline(repo, "repo-writer", "shared", "REPO PROMPT BODY");
    const view = pipelinesIn([bundled, repo]);

    assert.equal(
      okOf(view.get("bundled-writer")).loaded.prompts.write,
      "BUNDLED PROMPT BODY",
      "a bundled pipeline must not read the repository copy of prompts/shared.md"
    );
    assert.equal(
      okOf(view.get("repo-writer")).loaded.prompts.write,
      "REPO PROMPT BODY",
      "a repository pipeline must not read the bundled copy of prompts/shared.md"
    );
  });

  it("a nested child's prompts come from the child's layer, not the parent's", () => {
    const bundled = makeLayer("bundled", "package");
    const repo = makeLayer("repo", "project/.agent-flows");
    writePromptPipeline(bundled, "child", "shared", "BUNDLED PROMPT BODY");
    writeFileSync(join(repo.promptsDir, "shared.md"), "REPO PROMPT BODY");
    write(repo, "parent", mount("child"));

    assert.equal(
      okOf(pipelinesIn([bundled, repo]).get("parent")).loaded.prompts["mount.write"],
      "BUNDLED PROMPT BODY",
      "the mounted child's prompt must come from the child's own layer"
    );
  });
});

describe("nested pipelines resolve across layers (FR-019)", () => {
  it("a repository parent mounts a bundled child and a user-library child in one run", () => {
    const bundled = makeLayer("bundled", "package");
    const user = makeLayer("user", "home/workflows");
    const repo = makeLayer("repo", "project/.agent-flows");
    write(bundled, "bundled-child", GATE);
    write(user, "user-child", GATE);
    write(repo, "parent", [
      "inputs: []",
      "steps:",
      "  - id: from-bundled",
      "    kind: pipeline",
      "    pipeline: bundled-child",
      "  - id: from-user",
      "    kind: pipeline",
      "    pipeline: user-child",
      "    dependsOn: [from-bundled]",
    ]);

    const parent = okOf(pipelinesIn([bundled, user, repo]).get("parent"));

    assert.deepEqual(
      parent.loaded.def.steps.map((s) => s.id),
      ["from-bundled.start", "from-user.start"],
      "both mounts expand into the parent's step list"
    );
  });

  it("a user-library parent mounts a bundled child, including as a loop body", () => {
    const bundled = makeLayer("bundled", "package");
    const user = makeLayer("user", "home/workflows");
    write(bundled, "round", [
      "inputs: []",
      "steps:",
      "  - id: check",
      "    kind: check",
      "    command: true",
    ]);
    write(
      user,
      "personal",
      mount("round", "loop").map((l) =>
        l === "    until: start.passed" ? "    until: check.passed" : l
      )
    );

    const personal = okOf(pipelinesIn([bundled, user]).get("personal"));

    assert.deepEqual(
      personal.loaded.bodies?.mount.def.steps.map((s) => s.id),
      ["check"],
      "the loop body is the bundled child, resolved across layers"
    );
  });

  it("a later layer's copy of a child id is the one a parent mounts", () => {
    const bundled = makeLayer("bundled", "package");
    const repo = makeLayer("repo", "project/.agent-flows");
    writePromptPipeline(bundled, "child", "child", "BUNDLED CHILD PROMPT");
    writePromptPipeline(repo, "child", "child", "FORKED CHILD PROMPT");
    write(bundled, "parent", mount("child"));

    assert.equal(
      okOf(pipelinesIn([bundled, repo]).get("parent")).loaded.prompts["mount.write"],
      "FORKED CHILD PROMPT",
      "the forked child wins over the bundled one it shadows"
    );
  });

  it("reports a cycle that only exists because a later layer shadows a child id", () => {
    const bundled = makeLayer("bundled", "package");
    const repo = makeLayer("repo", "project/.agent-flows");
    write(bundled, "child", GATE);
    write(bundled, "parent", mount("child"));
    // The fork of `child` mounts `parent` — a cycle that does not exist in
    // either layer on its own.
    write(repo, "child", mount("parent"));

    const lookup = pipelinesIn([bundled, repo]).get("parent");

    assert.equal(lookup.kind, "broken");
    assert.match(
      lookup.kind === "broken" ? lookup.error.message : "",
      /cycle detected in nested pipelines/,
      "a cross-layer cycle must be reported, not recursed into"
    );
  });

  it("names a mount that no layer defines", () => {
    const repo = makeLayer("repo", "project/.agent-flows");
    write(repo, "parent", mount("nowhere"));

    const lookup = pipelinesIn([repo]).get("parent");

    assert.equal(lookup.kind, "broken");
    assert.match(
      lookup.kind === "broken" ? lookup.error.message : "",
      /nested pipeline "nowhere" is not defined in any workflow layer/
    );
  });
});

describe("all — the listing path", () => {
  it("returns one entry per id with its layer, and a malformed file as an error", () => {
    const bundled = makeLayer("bundled", "package");
    const repo = makeLayer("repo", "project/.agent-flows");
    write(bundled, "alpha", GATE);
    writeFileSync(
      join(repo.pipelinesDir, "alpha.yaml"),
      "id: alpha\nversion: 1\ndescription: forked alpha\ninputs: []\nsteps:\n  - id: start\n    kind: gate\n"
    );
    write(bundled, "beta", GATE);
    writeFileSync(join(repo.pipelinesDir, "broken.yaml"), "id: broken\nsteps: [{ id: x }]\n");

    const { found, errors } = pipelinesIn([bundled, repo]).all();

    assert.deepEqual(
      found.map((f) => [f.file.id, f.file.layer.source]),
      [
        ["alpha", "repo"],
        ["beta", "bundled"],
      ]
    );
    assert.equal(found[0]?.loaded.def.description, "forked alpha");
    assert.equal(errors.length, 1, `one broken file must be reported: ${JSON.stringify(errors)}`);
    assert.match(errors[0].file, /broken\.yaml$/);
  });
});

// Editability is decided by where a file really is, never by the label of the layer
// that listed it. A hostile repository can commit `.agent-flows/pipelines` as a link to
// the installed package's `pipelines/`; its layer then wins the id and lists the
// package's own files under a writable label.
describe("editable and layerOf — decided on realpaths", () => {
  /** A bundled layer with two pipelines (one gate-only) and a prompt. */
  function makeBundled(): CanonLayer {
    const bundled = makeLayer("bundled", "package");
    write(bundled, "shared", GATE);
    write(bundled, "other", GATE);
    writeFileSync(join(bundled.promptsDir, "shared.md"), "{{request}}\n");
    return bundled;
  }

  /** A layer of `source` whose pipelines/ and prompts/ are links into `bundled`. */
  function makeLinkedLayer(source: CanonLayer["source"], name: string, bundled: CanonLayer) {
    const layer = layerFrom(source, join(dir, name));
    mkdirSync(layer.root, { recursive: true });
    symlinkSync(bundled.pipelinesDir, layer.pipelinesDir, "dir");
    symlinkSync(bundled.promptsDir, layer.promptsDir, "dir");
    return layer;
  }

  for (const source of ["user", "repo"] as const) {
    it(`a ${source} layer whose pipelines/ is a link into the package is not editable`, () => {
      const bundled = makeBundled();
      const linked = makeLinkedLayer(source, source, bundled);
      const view = pipelinesIn([bundled, linked]);

      const found = okOf(view.get("shared"));

      assert.equal(found.file.layer.source, source, "listed under the writable label");
      assert.equal(found.file.editable, false, "but it is the package's own file");
      assert.equal(view.layerOf(found.file.filePath)?.source, "bundled");
    });
  }

  it("layerOf answers the bundled layer when several layers resolve to one directory, whatever the order", () => {
    const bundled = makeBundled();
    const linked = makeLinkedLayer("user", "user", bundled);
    const file = join(linked.pipelinesDir, "shared.yaml");

    assert.equal(pipelinesIn([bundled, linked]).layerOf(file)?.source, "bundled");
    assert.equal(pipelinesIn([linked, bundled]).layerOf(file)?.source, "bundled");
  });

  it("a symlinked file is where it points: into the package, or into no layer at all", () => {
    const bundled = makeBundled();
    const repo = makeLayer("repo", "repo");
    const outside = join(dir, "outside");
    mkdirSync(outside);
    writeFileSync(
      join(outside, "elsewhere.yaml"),
      readFileSync(join(bundled.pipelinesDir, "other.yaml"))
    );
    symlinkSync(join(bundled.pipelinesDir, "other.yaml"), join(repo.pipelinesDir, "into-pkg.yaml"));
    symlinkSync(join(outside, "elsewhere.yaml"), join(repo.pipelinesDir, "out.yaml"));
    const view = pipelinesIn([bundled, repo]);

    assert.equal(view.layerOf(join(repo.pipelinesDir, "into-pkg.yaml"))?.source, "bundled");
    assert.equal(view.layerOf(join(repo.pipelinesDir, "out.yaml")), undefined);
  });

  it("a symlink to a file in the same layer is that layer's", () => {
    const repo = makeLayer("repo", "repo");
    write(repo, "real", GATE);
    symlinkSync(join(repo.pipelinesDir, "real.yaml"), join(repo.pipelinesDir, "alias.yaml"));

    assert.equal(
      pipelinesIn([repo]).layerOf(join(repo.pipelinesDir, "alias.yaml"))?.source,
      "repo"
    );
  });

  it("a file that no longer exists is placed by its directory", () => {
    const repo = makeLayer("repo", "repo");
    assert.equal(
      pipelinesIn([repo]).layerOf(join(repo.pipelinesDir, "deleted.yaml"))?.source,
      "repo"
    );
    assert.equal(pipelinesIn([repo]).layerOf(join(dir, "no-such-dir", "x.yaml")), undefined);
  });

  it("an ordinary repo layer stays editable, and a bundled one does not", () => {
    const bundled = makeBundled();
    const repo = makeLayer("repo", "repo");
    write(repo, "mine", GATE);
    const view = pipelinesIn([bundled, repo]);

    assert.equal(okOf(view.get("mine")).file.editable, true);
    assert.equal(okOf(view.get("shared")).file.editable, false);
  });

  it("canWritePrompt refuses a target that resolves into the package's prompts/", () => {
    const bundled = makeBundled();
    const repo = makeLayer("repo", "repo");
    const view = pipelinesIn([bundled, repo]);
    writeFileSync(join(repo.promptsDir, "own.md"), "x");
    symlinkSync(join(bundled.promptsDir, "shared.md"), join(repo.promptsDir, "link.md"));

    assert.equal(view.canWritePrompt(join(repo.promptsDir, "own.md"), repo), true);
    assert.equal(view.canWritePrompt(join(repo.promptsDir, "link.md"), repo), false);
    assert.equal(view.canWritePrompt(join(bundled.promptsDir, "shared.md"), bundled), false);
  });
});
