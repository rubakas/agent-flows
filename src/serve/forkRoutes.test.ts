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
