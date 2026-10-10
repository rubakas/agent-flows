// Fork, visibility and import-target routes (spec 038 FR-021–FR-023, FR-026,
// FR-027) plus the cross-layer export closure (FR-029/D16).
//
// Its own file rather than a block in server.test.ts because it pins
// AGENT_FLOWS_HOME for the whole process: the fork and import routes default to
// the user library, so an unpinned case would write into the owner's real
// ~/.agent-flows/workflows.

import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { parse } from "yaml";

import { packageRoot } from "../packageRoot.js";
import { resolveProjectState } from "../runtime/projectState.js";
import { RunService, type MastraLike } from "../runtime/runService.js";
import { startServer, type ServeHandle } from "./server.js";

async function mutate(
  port: number,
  method: string,
  path: string,
  body: unknown
): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** A RunService over a Mastra stub, so POST /api/runs can start a run. */
function makeRunService(): RunService {
  const run = {
    runId: "fork-routes-run",
    start: async () => ({ status: "success", result: {} }),
    resume: async () => ({ status: "success", result: {} }),
    watch: () => () => undefined,
  };
  const mastra: MastraLike = {
    getWorkflow: () => ({
      createRun: async () => run,
    }),
  };
  return new RunService(mastra);
}

function writePipeline(pipelinesDir: string, id: string, lines: string[]): void {
  mkdirSync(pipelinesDir, { recursive: true });
  writeFileSync(join(pipelinesDir, `${id}.yaml`), lines.join("\n") + "\n");
}

describe("spec 038 Ship 3 — fork, visibility and import routes", () => {
  let srv: ServeHandle;
  let tmpDir: string;
  let projectDir: string;
  let home: string;
  let previousHome: string | undefined;

  before(async () => {
    tmpDir = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "af-fork-routes-")));
    projectDir = join(tmpDir, "project");
    home = join(tmpDir, "home");
    mkdirSync(projectDir, { recursive: true });

    // The user library owns a parent that mounts a child owned by the
    // repository canon — the cross-layer closure the exporter has to resolve.
    writePipeline(join(home, "workflows", "pipelines"), "personal-parent", [
      "id: personal-parent",
      "version: 1",
      "description: a personal parent mounting a team child",
      "inputs: []",
      "steps:",
      "  - id: think",
      "    kind: llm",
      "    role: worker",
      "    prompt: prompts/personal-think.md",
      "  - id: nested",
      "    kind: pipeline",
      "    pipeline: team-child",
      "    dependsOn: [think]",
    ]);
    mkdirSync(join(home, "workflows", "prompts"), { recursive: true });
    writeFileSync(join(home, "workflows", "prompts", "personal-think.md"), "personal think\n");

    writePipeline(join(projectDir, ".agent-flows", "pipelines"), "team-child", [
      "id: team-child",
      "version: 1",
      "description: a team child",
      "inputs: []",
      "steps:",
      "  - id: read",
      "    kind: llm",
      "    role: scout",
      "    prompt: prompts/team-read.md",
    ]);
    mkdirSync(join(projectDir, ".agent-flows", "prompts"), { recursive: true });
    writeFileSync(join(projectDir, ".agent-flows", "prompts", "team-read.md"), "team read\n");

    previousHome = process.env.AGENT_FLOWS_HOME;
    process.env.AGENT_FLOWS_HOME = home;

    srv = await startServer({
      state: resolveProjectState(projectDir, { AGENT_FLOWS_HOME: home }),
      port: 0,
      dbPath: ":memory:",
      projectDir,
      runService: makeRunService(),
    });
  });

  after(async () => {
    await srv.close();
    if (previousHome === undefined) delete process.env.AGENT_FLOWS_HOME;
    else process.env.AGENT_FLOWS_HOME = previousHome;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── FR-021/FR-022: fork ────────────────────────────────────────────────────

  it("POST /api/pipelines/:id/fork copies a bundled workflow into the chosen layer", async () => {
    const res = await mutate(srv.port, "POST", "/api/pipelines/investigate/fork", { to: "repo" });
    const text = await res.text();
    assert.equal(res.status, 200, text);
    const report = JSON.parse(text) as {
      from: string;
      target: string;
      root: string;
      written: string[];
    };
    assert.equal(report.from, "bundled");
    assert.equal(report.target, "repo");
    assert.ok(report.written.includes("pipelines/investigate.yaml"));
    assert.ok(
      report.written.some((p) => p.startsWith("prompts/")),
      `the fork carries its own prompts: ${report.written.join(", ")}`
    );
    assert.ok(existsSync(join(projectDir, ".agent-flows", "pipelines", "investigate.yaml")));

    // The merged view now resolves the id to the fork, and the rest of the
    // bundled catalogue is untouched.
    const list = (await (await fetch(`http://127.0.0.1:${srv.port}/api/pipelines`)).json()) as {
      pipelines: { id: string; layer: string; shadows?: string[] }[];
    };
    const row = list.pipelines.find((p) => p.id === "investigate");
    assert.equal(row?.layer, "repo");
    assert.deepEqual(row?.shadows, ["bundled"]);
    assert.ok(list.pipelines.some((p) => p.id === "cycle" && p.layer === "bundled"));
  });

  it("a second fork of the same id is refused with 409 and names the layer", async () => {
    const res = await mutate(srv.port, "POST", "/api/pipelines/investigate/fork", { to: "repo" });
    const text = await res.text();
    assert.equal(res.status, 409, text);
    const body = JSON.parse(text) as { error: string };
    assert.match(body.error, /already exists in the repo layer/u);
  });

  it("overwrite: true re-forks over the existing copy", async () => {
    const res = await mutate(srv.port, "POST", "/api/pipelines/investigate/fork", {
      to: "repo",
      overwrite: true,
    });
    assert.equal(res.status, 200, await res.text());
  });

  it("an unknown id is 422 and an invalid id is 400", async () => {
    const unknown = await mutate(srv.port, "POST", "/api/pipelines/nope/fork", { to: "repo" });
    assert.equal(unknown.status, 422);
    const invalid = await mutate(srv.port, "POST", "/api/pipelines/..%2Fetc/fork", { to: "repo" });
    assert.equal(invalid.status, 400);
    const badTarget = await mutate(srv.port, "POST", "/api/pipelines/cycle/fork", {
      to: "package",
    });
    assert.equal(badTarget.status, 400);
  });

  it("FR-023: no fork target can be the package, and the package stays untouched", async () => {
    const before = statSync(join(packageRoot(), "pipelines")).mtimeMs;
    for (const to of ["user", "repo"]) {
      const res = await mutate(srv.port, "POST", "/api/pipelines/cycle/fork", {
        to,
        overwrite: true,
      });
      const text = await res.text();
      assert.equal(res.status, 200, text);
      const report = JSON.parse(text) as { root: string };
      assert.ok(
        !realpathSync(report.root).startsWith(realpathSync(packageRoot())),
        `a fork target must never be inside the package; got ${report.root}`
      );
    }
    assert.equal(
      statSync(join(packageRoot(), "pipelines")).mtimeMs,
      before,
      "the package is untouched"
    );
  });

  // ── FR-026: visibility ─────────────────────────────────────────────────────

  it("a hidden workflow leaves the page's workflow list and comes back with ?include=hidden", async () => {
    const hide = await mutate(srv.port, "POST", "/api/pipelines/team-child/visibility", {
      hidden: true,
    });
    assert.equal(hide.status, 200, await hide.text());

    const listed = (await (await fetch(`http://127.0.0.1:${srv.port}/api/pipelines`)).json()) as {
      pipelines: { id: string; hidden?: boolean }[];
    };
    assert.ok(
      !listed.pipelines.some((p) => p.id === "team-child"),
      "a hidden workflow is unlisted on the page's workflow list"
    );

    const all = (await (
      await fetch(`http://127.0.0.1:${srv.port}/api/pipelines?include=hidden`)
    ).json()) as { pipelines: { id: string; hidden?: boolean }[] };
    const row = all.pipelines.find((p) => p.id === "team-child");
    assert.equal(
      row?.hidden,
      true,
      "the management view marks it hidden so it can be brought back"
    );
  });

  it("a hidden workflow still runs when it is named explicitly by id", async () => {
    const res = await mutate(srv.port, "POST", "/api/runs", {
      pipeline: "team-child",
      inputs: {},
    });
    const text = await res.text();
    assert.equal(res.status, 200, `hiding must never refuse a run: ${text}`);
    assert.match(text, /"status":"running"/u, "the run actually started");
  });

  it("unhiding puts it back", async () => {
    const show = await mutate(srv.port, "POST", "/api/pipelines/team-child/visibility", {
      hidden: false,
    });
    assert.equal(show.status, 200);
    const listed = (await (await fetch(`http://127.0.0.1:${srv.port}/api/pipelines`)).json()) as {
      pipelines: { id: string }[];
    };
    assert.ok(listed.pipelines.some((p) => p.id === "team-child"));
  });

  // ── FR-029/D16: the export closure spans layers ────────────────────────────

  it("GET /api/export/:id resolves a child owned by another layer", async () => {
    const res = await fetch(`http://127.0.0.1:${srv.port}/api/export/personal-parent`);
    const text = await res.text();
    assert.equal(res.status, 200, text);
    const bundle = parse(text) as { files: { path: string; content: string }[] };
    const paths = bundle.files.map((f) => f.path).sort();
    assert.ok(paths.includes("pipelines/personal-parent.yaml"), paths.join(", "));
    assert.ok(
      paths.includes("pipelines/team-child.yaml"),
      `the child from the repository layer must travel with the parent: ${paths.join(", ")}`
    );
    assert.ok(paths.includes("prompts/personal-think.md"), paths.join(", "));
    assert.ok(
      paths.includes("prompts/team-read.md"),
      `and so must the child's own prompt: ${paths.join(", ")}`
    );
    assert.equal(
      bundle.files.find((f) => f.path === "prompts/team-read.md")?.content,
      "team read\n",
      "the child's prompt is read from the child's own layer root"
    );
  });

  // ── FR-027: import target ──────────────────────────────────────────────────

  it("POST /api/import defaults to the user library", async () => {
    const bundleText = await (
      await fetch(`http://127.0.0.1:${srv.port}/api/export/team-child`)
    ).text();
    const res = await mutate(srv.port, "POST", "/api/import", { bundle: bundleText });
    const text = await res.text();
    assert.equal(res.status, 200, text);
    const report = JSON.parse(text) as { target: string; root: string; written: string[] };
    assert.equal(report.target, "user");
    assert.equal(report.root, join(home, "workflows"));
    assert.ok(existsSync(join(home, "workflows", "pipelines", "team-child.yaml")));
  });

  it("a traversal entry is still refused with the user library as the target", async () => {
    const malicious =
      "bundleVersion: 1\nsourcePipeline: evil\nexportedAt: 2026-01-01T00:00:00.000Z\n" +
      'files:\n  - path: "../evil.txt"\n    content: "# bad"\n';
    const res = await mutate(srv.port, "POST", "/api/import", { bundle: malicious });
    assert.equal(res.status, 422, await res.text());
    assert.ok(
      !existsSync(join(home, "evil.txt")),
      "nothing may be written next to the user library"
    );
    assert.ok(!existsSync(join(tmpDir, "evil.txt")));
  });

  it("an absolute path entry is still refused with the user library as the target", async () => {
    const outside = join(tmpDir, "absolute-evil.txt");
    const malicious =
      "bundleVersion: 1\nsourcePipeline: evil\nexportedAt: 2026-01-01T00:00:00.000Z\n" +
      `files:\n  - path: "${outside}"\n    content: "# bad"\n`;
    const res = await mutate(srv.port, "POST", "/api/import", { bundle: malicious });
    assert.equal(res.status, 422, await res.text());
    assert.ok(!existsSync(outside), "an absolute entry path must write nothing");
  });

  it("target: repo imports into the repository canon instead", async () => {
    const bundleText = await (
      await fetch(`http://127.0.0.1:${srv.port}/api/export/personal-parent`)
    ).text();
    const res = await mutate(srv.port, "POST", "/api/import", {
      bundle: bundleText,
      target: "repo",
      overwrite: true,
    });
    const text = await res.text();
    assert.equal(res.status, 200, text);
    const report = JSON.parse(text) as { target: string; root: string };
    assert.equal(report.target, "repo");
    assert.equal(report.root, join(projectDir, ".agent-flows"));
    assert.equal(
      readFileSync(join(projectDir, ".agent-flows", "prompts", "personal-think.md"), "utf8"),
      "personal think\n"
    );
  });
});

// ── spec 047 FR-12: one answer to "which file is this pipeline" across layers ──
//
// THE DEFECT these cases encode: the editor routes looked a pipeline up in the
// write layer's directory alone and loaded it with the bare loader, which finds
// a nested child as a sibling file. So a repository fork of a bundled workflow
// whose children stay bundled (`build` mounts `develop`, `build-round`, `audit`)
// answered 404 on POST /drafts and GET /prompts, a user-layer workflow could not
// be edited at all, and DELETE only looked for nesters in the write layer.
// server.test.ts cannot see any of it: it pins one `pipelinesDir`, where a
// sibling and the catalogue are the same directory.

describe("spec 047 FR-12 — editor routes resolve a pipeline across layers", () => {
  let srv: ServeHandle;
  let tmpDir: string;
  let projectDir: string;
  let home: string;
  let previousHome: string | undefined;

  const url = (path: string): string => `http://127.0.0.1:${srv.port}${path}`;

  before(async () => {
    tmpDir = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "af-fr12-routes-")));
    projectDir = join(tmpDir, "project");
    home = join(tmpDir, "home");
    mkdirSync(projectDir, { recursive: true });

    writePipeline(join(home, "workflows", "pipelines"), "personal-parent", [
      "id: personal-parent",
      "version: 1",
      "description: a personal parent mounting a team child",
      "inputs: []",
      "steps:",
      "  - id: think",
      "    kind: llm",
      "    role: worker",
      "    prompt: prompts/personal-think.md",
      "  - id: nested",
      "    kind: pipeline",
      "    pipeline: team-child",
      "    dependsOn: [think]",
    ]);
    mkdirSync(join(home, "workflows", "prompts"), { recursive: true });
    writeFileSync(join(home, "workflows", "prompts", "personal-think.md"), "personal think\n");

    writePipeline(join(projectDir, ".agent-flows", "pipelines"), "team-child", [
      "id: team-child",
      "version: 1",
      "description: a team child",
      "inputs: []",
      "steps:",
      "  - id: read",
      "    kind: llm",
      "    role: scout",
      "    prompt: prompts/team-read.md",
    ]);
    mkdirSync(join(projectDir, ".agent-flows", "prompts"), { recursive: true });
    writeFileSync(join(projectDir, ".agent-flows", "prompts", "team-read.md"), "team read\n");

    previousHome = process.env.AGENT_FLOWS_HOME;
    process.env.AGENT_FLOWS_HOME = home;

    srv = await startServer({
      state: resolveProjectState(projectDir, { AGENT_FLOWS_HOME: home }),
      port: 0,
      dbPath: ":memory:",
      projectDir,
    });
  });

  after(async () => {
    await srv.close();
    if (previousHome === undefined) delete process.env.AGENT_FLOWS_HOME;
    else process.env.AGENT_FLOWS_HOME = previousHome;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function openDraft(id: string): Promise<{ draftId: number; body: string }> {
    const res = await mutate(srv.port, "POST", `/api/pipelines/${id}/drafts`, {});
    const text = await res.text();
    assert.equal(res.status, 200, `opening a draft of "${id}": ${text}`);
    return JSON.parse(text) as { draftId: number; body: string };
  }

  it("a repository fork of a bundled workflow keeps its bundled children and opens in the editor", async () => {
    const fork = await mutate(srv.port, "POST", "/api/pipelines/build/fork", { to: "repo" });
    assert.equal(fork.status, 200, await fork.text());
    const forked = join(projectDir, ".agent-flows", "pipelines", "build.yaml");
    const before = readFileSync(forked, "utf8");

    const prompts = await fetch(url("/api/pipelines/build/prompts"));
    assert.equal(prompts.status, 200, `GET prompts of the fork: ${await prompts.text()}`);

    const draft = await openDraft("build");
    assert.equal(draft.body, before);

    const save = await mutate(srv.port, "POST", `/api/drafts/${draft.draftId}/save`, {});
    assert.equal(save.status, 200, `saving an unchanged draft: ${await save.text()}`);
    assert.equal(readFileSync(forked, "utf8"), before, "an unchanged save rewrites nothing");
  });

  it("a user-layer workflow opens in the editor: draft, prompts, preview, prompt write, save", async () => {
    const draft = await openDraft("personal-parent");

    const prompts = await fetch(url("/api/pipelines/personal-parent/prompts"));
    const promptsText = await prompts.text();
    assert.equal(prompts.status, 200, promptsText);
    const map = JSON.parse(promptsText) as Record<string, { text: string; hash: string }>;
    assert.deepEqual(Object.keys(map), ["think"], "only its own llm step, not the child's");
    assert.equal(map.think?.text, "personal think\n");

    const preview = await mutate(srv.port, "POST", `/api/drafts/${draft.draftId}/preview`, {
      prompts: { think: "edited {{nonsense}}" },
    });
    assert.equal(
      preview.status,
      422,
      "an unknown placeholder is reported before anything is written"
    );

    const write = await mutate(srv.port, "PUT", "/api/pipelines/personal-parent/prompts/think", {
      text: "edited think\n",
      ifMatch: map.think?.hash,
    });
    assert.equal(write.status, 200, await write.text());
    assert.equal(
      readFileSync(join(home, "workflows", "prompts", "personal-think.md"), "utf8"),
      "edited think\n"
    );

    const save = await mutate(srv.port, "POST", `/api/drafts/${draft.draftId}/save`, {});
    assert.equal(save.status, 200, await save.text());
  });

  it("an error from a user-layer workflow names no path of its own layer", async () => {
    const draft = await openDraft("personal-parent");
    const layerRoot = join(home, "workflows");
    const hostile = draft.body.replace("prompts/personal-think.md", `${layerRoot}/../../x.md`);

    const preview = await mutate(srv.port, "POST", `/api/drafts/${draft.draftId}/preview`, {});
    assert.equal(preview.status, 200, "an unedited draft previews");
    await mutate(srv.port, "PUT", `/api/drafts/${draft.draftId}`, { body: hostile });
    const bad = await mutate(srv.port, "POST", `/api/drafts/${draft.draftId}/preview`, {});
    const text = await bad.text();
    assert.equal(bad.status, 422, text);
    assert.ok(!text.includes(layerRoot), `the user layer's root must be redacted: ${text}`);
    assert.match(text, /<root>/u);
  });

  it("a bundled workflow that no layer overrides is refused with 403 on every editor route", async () => {
    for (const [method, path] of [
      ["POST", "/api/pipelines/investigate/drafts"],
      ["GET", "/api/pipelines/investigate/prompts"],
      ["PUT", "/api/pipelines/investigate/prompts/survey"],
      ["DELETE", "/api/pipelines/investigate"],
    ] as const) {
      const res =
        method === "GET"
          ? await fetch(url(path))
          : await mutate(srv.port, method, path, { text: "x", ifMatch: "0".repeat(64) });
      assert.equal(res.status, 403, `${method} ${path}: ${await res.text()}`);
    }
  });

  it("an unknown id is 404 on the editor routes", async () => {
    const drafts = await mutate(srv.port, "POST", "/api/pipelines/no-such/drafts", {});
    assert.equal(drafts.status, 404);
    const prompts = await fetch(url("/api/pipelines/no-such/prompts"));
    assert.equal(prompts.status, 404);
    const del = await mutate(srv.port, "DELETE", "/api/pipelines/no-such", {});
    assert.equal(del.status, 404);
  });

  it("DELETE refuses a repository child that a user-layer workflow mounts", async () => {
    const res = await mutate(srv.port, "DELETE", "/api/pipelines/team-child", {});
    const text = await res.text();
    assert.equal(res.status, 409, text);
    assert.match(text, /personal-parent/u);
    assert.ok(
      existsSync(join(projectDir, ".agent-flows", "pipelines", "team-child.yaml")),
      "the refused delete removed nothing"
    );
  });

  it("DELETE removes a repository fork that a nester mounts when a lower layer still defines the id", async () => {
    const fork = await mutate(srv.port, "POST", "/api/pipelines/develop/fork", { to: "repo" });
    assert.equal(fork.status, 200, await fork.text());
    const forked = join(projectDir, ".agent-flows", "pipelines", "develop.yaml");
    assert.ok(existsSync(forked));

    // The repo `build` fork (made above) mounts `develop`, but the bundled
    // `develop` remains, so the nesters fall back to it.
    const res = await mutate(srv.port, "DELETE", "/api/pipelines/develop", {});
    assert.equal(res.status, 200, await res.text());
    assert.ok(!existsSync(forked));
  });

  it("DELETE removes a user-layer workflow", async () => {
    const res = await mutate(srv.port, "DELETE", "/api/pipelines/personal-parent", {});
    assert.equal(res.status, 200, await res.text());
    assert.ok(!existsSync(join(home, "workflows", "pipelines", "personal-parent.yaml")));
  });
});
