// Which workflow files the routes will write or delete, in a project with more than
// one layer (spec 047 FR-12 review: M1, L1, L2, W1).
//
// Its own file because it pins AGENT_FLOWS_HOME for the whole process: the user
// library is a layer, so an unpinned case would read and write the owner's real
// ~/.agent-flows/workflows.
//
// The linked-layer cases point a layer's `pipelines/` at the installed package's own
// `pipelines/` -- the file a hostile repository could commit as a link. They run
// against the real package directory, because the bundled layer is always the
// package. If the guard under test ever fails, a request really would delete a
// package file, so every such case snapshots the package's pipelines and prompts
// first and puts back whatever differs afterwards.

import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { packageRoot } from "../packageRoot.js";
import { resolveProjectState } from "../runtime/projectState.js";
import { startServer, type ServeHandle } from "./server.js";

async function call(port: number, method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/** Every file under the package's pipelines/ and prompts/, so a failed guard can be undone. */
function snapshotPackage(): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  for (const sub of ["pipelines", "prompts"]) {
    const dir = join(packageRoot(), sub);
    for (const name of readdirSync(dir)) files.set(join(dir, name), readFileSync(join(dir, name)));
  }
  return files;
}

function restorePackage(snapshot: Map<string, Buffer>): void {
  for (const [path, content] of snapshot) {
    if (!existsSync(path) || !readFileSync(path).equals(content)) writeFileSync(path, content);
  }
}

/** A pipeline with no llm step: the loader refuses a linked prompts/, so only these load through a link. */
const PACKAGE_PIPELINE = "ship";

describe("a layer whose pipelines/ is a link into the package is not editable (M1)", () => {
  for (const linked of ["user", "repo"] as const) {
    describe(`${linked} layer`, () => {
      let srv: ServeHandle;
      let tmpDir: string;
      let previousHome: string | undefined;
      let snapshot: Map<string, Buffer>;
      const target = join(packageRoot(), "pipelines", `${PACKAGE_PIPELINE}.yaml`);

      before(async () => {
        snapshot = snapshotPackage();
        tmpDir = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), `af-linked-${linked}-`)));
        const projectDir = join(tmpDir, "project");
        const home = join(tmpDir, "home");
        mkdirSync(projectDir, { recursive: true });
        const layerRoot =
          linked === "user" ? join(home, "workflows") : join(projectDir, ".agent-flows");
        mkdirSync(layerRoot, { recursive: true });
        symlinkSync(join(packageRoot(), "pipelines"), join(layerRoot, "pipelines"), "dir");
        mkdirSync(join(layerRoot, "prompts"));

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
        restorePackage(snapshot);
        await srv.close();
        if (previousHome === undefined) delete process.env.AGENT_FLOWS_HOME;
        else process.env.AGENT_FLOWS_HOME = previousHome;
        rmSync(tmpDir, { recursive: true, force: true });
      });

      it("lists the package's file under the writable label (the premise of the attack)", async () => {
        const list = (await (await call(srv.port, "GET", "/api/pipelines")).json()) as {
          pipelines: { id: string; layer: string }[];
        };
        assert.equal(list.pipelines.find((p) => p.id === PACKAGE_PIPELINE)?.layer, linked);
      });

      it("DELETE is refused and the package file survives", async () => {
        const before = readFileSync(target);
        const res = await call(srv.port, "DELETE", `/api/pipelines/${PACKAGE_PIPELINE}`);
        assert.equal(res.status, 403, await res.clone().text());
        assert.ok(existsSync(target), "the package's own file must not be deleted");
        assert.ok(readFileSync(target).equals(before));
      });

      it("opening a draft, reading prompts and writing a prompt are refused", async () => {
        for (const [method, path, body] of [
          ["POST", `/api/pipelines/${PACKAGE_PIPELINE}/drafts`, undefined],
          ["GET", `/api/pipelines/${PACKAGE_PIPELINE}/prompts`, undefined],
          ["PUT", `/api/pipelines/${PACKAGE_PIPELINE}/prompts/only`, { text: "x", ifMatch: "y" }],
        ] as const) {
          const res = await call(srv.port, method, path, body);
          assert.equal(res.status, 403, `${method} ${path}: ${await res.clone().text()}`);
        }
      });
    });
  }

  it("a real file in a project layer is still deletable (the guard is not blanket)", async () => {
    const tmpDir = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "af-control-")));
    const previousHome = process.env.AGENT_FLOWS_HOME;
    const home = join(tmpDir, "home");
    const projectDir = join(tmpDir, "project");
    const pipelinesDir = join(projectDir, ".agent-flows", "pipelines");
    mkdirSync(pipelinesDir, { recursive: true });
    writeFileSync(
      join(pipelinesDir, "mine.yaml"),
      "id: mine\nversion: 1\ndescription: mine\ninputs: []\nsteps:\n  - id: a\n    kind: gate\n"
    );
    process.env.AGENT_FLOWS_HOME = home;
    const srv = await startServer({
      state: resolveProjectState(projectDir, { AGENT_FLOWS_HOME: home }),
      port: 0,
      dbPath: ":memory:",
      projectDir,
    });
    try {
      const res = await call(srv.port, "DELETE", "/api/pipelines/mine");
      assert.equal(res.status, 200, await res.clone().text());
      assert.equal(existsSync(join(pipelinesDir, "mine.yaml")), false);
    } finally {
      await srv.close();
      if (previousHome === undefined) delete process.env.AGENT_FLOWS_HOME;
      else process.env.AGENT_FLOWS_HOME = previousHome;
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
