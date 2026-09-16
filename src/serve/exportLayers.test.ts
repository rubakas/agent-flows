// GET /api/export/:id resolves the owning layer before exporting (spec 038 FR-029).
//
// Its own file rather than a block inside server.test.ts because it pins
// AGENT_FLOWS_HOME for the whole process: the user library is a layer, so the
// daemon must never resolve the owner's real ~/.agent-flows/workflows here.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { parse } from "yaml";

import { resolveProjectState } from "../runtime/projectState.js";
import { startServer, type ServeHandle } from "./server.js";

interface BundleFile {
  path: string;
  content: string;
}

function writePipeline(pipelinesDir: string, id: string, description: string): void {
  mkdirSync(pipelinesDir, { recursive: true });
  writeFileSync(
    join(pipelinesDir, `${id}.yaml`),
    [
      `id: ${id}`,
      "version: 1",
      `description: ${description}`,
      "inputs: []",
      "steps:",
      "  - id: start",
      "    kind: gate",
      "",
    ].join("\n")
  );
}

describe("GET /api/export/:id — the owning layer supplies the bundle (FR-029)", () => {
  let srv: ServeHandle;
  let tmpDir: string;
  let projectDir: string;
  let home: string;
  let previousHome: string | undefined;

  before(async () => {
    tmpDir = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "af-export-layers-")));
    projectDir = join(tmpDir, "project");
    home = join(tmpDir, "home");
    mkdirSync(projectDir, { recursive: true });

    // The user library and the repository canon each hold one workflow.
    writePipeline(join(home, "workflows", "pipelines"), "personal", "from the user library");
    writePipeline(join(projectDir, ".agent-flows", "pipelines"), "team", "from the repository");

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
    if (previousHome === undefined) {
      delete process.env.AGENT_FLOWS_HOME;
    } else {
      process.env.AGENT_FLOWS_HOME = previousHome;
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("exports a user-library workflow the project never copied in", async () => {
    const res = await fetch(`http://127.0.0.1:${srv.port}/api/export/personal`);
    const text = await res.text();
    assert.equal(res.status, 200, `expected 200, got ${res.status}: ${text}`);
    const bundle = parse(text) as { sourcePipeline: string; files: BundleFile[] };
    assert.equal(bundle.sourcePipeline, "personal");
    const yamlFile = bundle.files.find((f) => f.path === "pipelines/personal.yaml");
    assert.ok(yamlFile, `the bundle must carry the pipeline: ${JSON.stringify(bundle.files)}`);
    assert.match(yamlFile.content, /from the user library/);
  });

  it("exports a repository workflow from the repository layer", async () => {
    const res = await fetch(`http://127.0.0.1:${srv.port}/api/export/team`);
    const text = await res.text();
    assert.equal(res.status, 200, `expected 200, got ${res.status}: ${text}`);
    const bundle = parse(text) as { files: BundleFile[] };
    const yamlFile = bundle.files.find((f) => f.path === "pipelines/team.yaml");
    assert.ok(yamlFile);
    assert.match(yamlFile.content, /from the repository/);
  });

  it("exports a bundled workflow even though the project has a canon of its own", async () => {
    const res = await fetch(`http://127.0.0.1:${srv.port}/api/export/investigate`);
    const text = await res.text();
    assert.equal(res.status, 200, `expected 200, got ${res.status}: ${text}`);
    const bundle = parse(text) as { files: BundleFile[] };
    assert.ok(
      bundle.files.some((f) => f.path === "pipelines/investigate.yaml"),
      "the bundled layer must answer for an id no other layer defines"
    );
  });

  it("answers 422 for an id no layer defines", async () => {
    const res = await fetch(`http://127.0.0.1:${srv.port}/api/export/nowhere`);
    assert.equal(res.status, 422);
  });
});
