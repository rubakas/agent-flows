// Which workflow files the routes will write or delete, in a project with more than
// one layer (spec 047 FR-12 review: M1, L1, L2, W1).
//
// Its own file because it pins AGENT_FLOWS_HOME for the whole process: the user
// library is a layer, so an unpinned case would read and write the owner's real
// ~/.agent-flows/workflows.
//
// The linked-layer cases point a layer's `pipelines/` at the bundled layer's own
// `pipelines/` -- the file a hostile repository could commit as a link. The bundled
// layer is a COPY of the package's pipelines/ and prompts/ (startServer's
// bundledPipelinesDir relocates it), so if the guard under test ever fails, a request
// deletes a file in a temp directory, not in the installed package. A file-level hash
// of the real package, taken when this file loads and compared after the last case, proves
// the real files were never touched.
//
// Do not test `?source=bundled` with a package copy: layerForPipelinesDir labels a
// copy "repo", so the answer would not be the bundled one.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  cpSync,
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
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { eq } from "drizzle-orm";
import { canonSource } from "../db/schema.js";
import { makeDb, type DbInstance } from "../db/index.js";
import { getDraft } from "../canon/draftStore.js";
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

/** sha256 over the sorted (name, bytes) of every file in the real package's pipelines/ and prompts/. */
function packageDigest(): string {
  const hash = createHash("sha256");
  for (const sub of ["pipelines", "prompts"]) {
    const dir = join(packageRoot(), sub);
    for (const name of readdirSync(dir).sort()) {
      hash.update(`${sub}/${name}\0`);
      hash.update(readFileSync(join(dir, name)));
    }
  }
  return hash.digest("hex");
}

/** A throwaway copy of the package's pipelines/ and prompts/: `<tmp>/pkg/{pipelines,prompts}`. */
function packageCopy(tmpDir: string): string {
  const copy = join(tmpDir, "pkg");
  for (const sub of ["pipelines", "prompts"]) {
    cpSync(join(packageRoot(), sub), join(copy, sub), { recursive: true });
  }
  return copy;
}

const digestBefore = packageDigest();
after(() => {
  assert.equal(
    packageDigest(),
    digestBefore,
    "a test changed a file in the real package's pipelines/ or prompts/"
  );
});

/** A pipeline with no llm step: the loader refuses a linked prompts/, so only these load through a link. */
const PACKAGE_PIPELINE = "ship";

describe("a layer whose pipelines/ is a link into the package is not editable (M1)", () => {
  for (const linked of ["user", "repo"] as const) {
    describe(`${linked} layer`, () => {
      let srv: ServeHandle;
      let tmpDir: string;
      let previousHome: string | undefined;
      let target: string;

      before(async () => {
        tmpDir = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), `af-linked-${linked}-`)));
        const copy = packageCopy(tmpDir);
        target = join(copy, "pipelines", `${PACKAGE_PIPELINE}.yaml`);
        const projectDir = join(tmpDir, "project");
        const home = join(tmpDir, "home");
        mkdirSync(projectDir, { recursive: true });
        const layerRoot =
          linked === "user" ? join(home, "workflows") : join(projectDir, ".agent-flows");
        mkdirSync(layerRoot, { recursive: true });
        symlinkSync(join(copy, "pipelines"), join(layerRoot, "pipelines"), "dir");
        mkdirSync(join(layerRoot, "prompts"));

        previousHome = process.env.AGENT_FLOWS_HOME;
        process.env.AGENT_FLOWS_HOME = home;
        srv = await startServer({
          state: resolveProjectState(projectDir, { AGENT_FLOWS_HOME: home }),
          bundledPipelinesDir: join(copy, "pipelines"),
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
    const copy = packageCopy(tmpDir);
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
      bundledPipelinesDir: join(copy, "pipelines"),
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

// A message that names a file must not name where on the machine it is. The create
// target's root used to be the only one redacted, so an error about a file in
// another layer carried the owner's home directory into the response.
describe("an error about a file in any layer redacts every root (L1)", () => {
  let srv: ServeHandle;
  let tmpDir: string;
  let previousHome: string | undefined;
  let userFile: string;

  before(async () => {
    tmpDir = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "af-redact-")));
    const copy = packageCopy(tmpDir);
    const projectDir = join(tmpDir, "project");
    const home = join(tmpDir, "home");
    const gate = (id: string) =>
      `id: ${id}\nversion: 1\ndescription: ${id}\ninputs: []\nsteps:\n  - id: a\n    kind: gate\n`;
    // Both layers exist, so the create target (the repository canon) is NOT the
    // layer the failing file lives in.
    mkdirSync(join(projectDir, ".agent-flows", "pipelines"), { recursive: true });
    writeFileSync(join(projectDir, ".agent-flows", "pipelines", "team.yaml"), gate("team"));
    mkdirSync(join(home, "workflows", "pipelines"), { recursive: true });
    userFile = join(home, "workflows", "pipelines", "personal.yaml");
    writeFileSync(userFile, gate("personal"));

    previousHome = process.env.AGENT_FLOWS_HOME;
    process.env.AGENT_FLOWS_HOME = home;
    srv = await startServer({
      state: resolveProjectState(projectDir, { AGENT_FLOWS_HOME: home }),
      bundledPipelinesDir: join(copy, "pipelines"),
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

  it("saving a draft whose user-layer file was deleted names no path on this machine", async () => {
    const opened = await call(srv.port, "POST", "/api/pipelines/personal/drafts");
    assert.equal(opened.status, 200, await opened.clone().text());
    const { draftId } = (await opened.json()) as { draftId: number };

    rmSync(userFile);
    const res = await call(srv.port, "POST", `/api/drafts/${draftId}/save`);

    const text = await res.text();
    assert.ok(res.status >= 400, `a draft with no file must not save: ${res.status} ${text}`);
    assert.ok(text.includes("<root>"), `the failing path must be shown redacted: ${text}`);
    assert.ok(!text.includes(tmpDir), `a layer root leaked: ${text}`);
    assert.ok(!text.includes(homedir()), `the home directory leaked: ${text}`);
  });

  // L2: a refusal on a route that may carry a body drains it first. Observable as the
  // 413 an oversized body earns, which a refusal that answered early would not give.
  it("refusing a bundled workflow drains an oversized body first", async () => {
    const res = await fetch(`http://127.0.0.1:${srv.port}/api/pipelines/investigate`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: "x".repeat(70_000),
    });
    assert.equal(res.status, 413, await res.clone().text());
  });
});

// A draft stores which file it edits; preview and save re-check that file against the
// layers, because the stored row is data the route did not just validate. In a
// project with more than one layer the row can name a file the draft was never
// opened on (W1): one in the bundled layer is refused, one in no layer is not found.
describe("preview and save re-check the file a stored draft names (W1)", () => {
  let srv: ServeHandle;
  let tmpDir: string;
  let previousHome: string | undefined;
  let db: DbInstance;
  let outside: string;
  let copyRoot: string;

  before(async () => {
    tmpDir = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "af-guard-")));
    copyRoot = packageCopy(tmpDir);
    const projectDir = join(tmpDir, "project");
    const home = join(tmpDir, "home");
    mkdirSync(join(projectDir, ".agent-flows", "pipelines"), { recursive: true });
    writeFileSync(
      join(projectDir, ".agent-flows", "pipelines", "team.yaml"),
      "id: team\nversion: 1\ndescription: team\ninputs: []\nsteps:\n  - id: a\n    kind: gate\n"
    );
    // A real pipeline file that no layer of this project contains.
    outside = join(tmpDir, "outside");
    mkdirSync(outside);
    writeFileSync(
      join(outside, "stray.yaml"),
      "id: stray\nversion: 1\ndescription: stray\ninputs: []\nsteps:\n  - id: a\n    kind: gate\n"
    );

    const dbPath = join(tmpDir, "drafts.sqlite");
    previousHome = process.env.AGENT_FLOWS_HOME;
    process.env.AGENT_FLOWS_HOME = home;
    srv = await startServer({
      state: resolveProjectState(projectDir, { AGENT_FLOWS_HOME: home }),
      bundledPipelinesDir: join(copyRoot, "pipelines"),
      port: 0,
      dbPath,
      projectDir,
    });
    db = makeDb(dbPath);
  });
  after(async () => {
    await srv.close();
    if (previousHome === undefined) delete process.env.AGENT_FLOWS_HOME;
    else process.env.AGENT_FLOWS_HOME = previousHome;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Opens a draft on the repository file `team`, then points its stored source at `root`/`relPath`. */
  async function draftNaming(root: string, relPath: string): Promise<number> {
    const opened = await call(srv.port, "POST", "/api/pipelines/team/drafts");
    assert.equal(opened.status, 200, await opened.clone().text());
    const { draftId } = (await opened.json()) as { draftId: number };
    const sourceId = getDraft(db, draftId)?.sourceId;
    assert.ok(sourceId !== undefined);
    db.update(canonSource).set({ root, relPath }).where(eq(canonSource.id, sourceId)).run();
    return draftId;
  }

  it("a draft that still names its repository file previews", async () => {
    const draftId = await draftNaming(
      join(realpathSync(tmpDir), "project", ".agent-flows"),
      join("pipelines", "team.yaml")
    );
    const res = await call(srv.port, "POST", `/api/drafts/${draftId}/preview`, {});
    assert.equal(res.status, 200, await res.clone().text());
  });

  it("a draft re-pointed at a bundled file is refused with 403 by preview and save", async () => {
    const draftId = await draftNaming(copyRoot, join("pipelines", "ship.yaml"));
    const preview = await call(srv.port, "POST", `/api/drafts/${draftId}/preview`, {});
    assert.equal(preview.status, 403, await preview.clone().text());
    const save = await call(srv.port, "POST", `/api/drafts/${draftId}/save`);
    assert.equal(save.status, 403, await save.clone().text());
  });

  it("a draft re-pointed at a file in no layer is a 404 for preview and save", async () => {
    const draftId = await draftNaming(outside, "stray.yaml");
    const preview = await call(srv.port, "POST", `/api/drafts/${draftId}/preview`, {});
    assert.equal(preview.status, 404, await preview.clone().text());
    const save = await call(srv.port, "POST", `/api/drafts/${draftId}/save`);
    assert.equal(save.status, 404, await save.clone().text());
  });
});

// The bundled layer is addressed by its `pipelines/` directory but relocated by its
// root: only a directory named `pipelines` has a root that holds a `prompts/` beside it.
describe("a relocated bundled directory must be a package's pipelines/", () => {
  it("startServer refuses a bundledPipelinesDir that is not named pipelines", async () => {
    const tmpDir = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "af-bundled-name-")));
    try {
      const projectDir = join(tmpDir, "project");
      const home = join(tmpDir, "home");
      mkdirSync(projectDir, { recursive: true });
      const attempt = startServer({
        state: resolveProjectState(projectDir, { AGENT_FLOWS_HOME: home }),
        port: 0,
        dbPath: ":memory:",
        projectDir,
        bundledPipelinesDir: join(tmpDir, "wf"),
      });
      // A server that did start must not keep the process alive after the assertion fails.
      attempt.then(
        (handle) => handle.close(),
        () => undefined
      );
      await assert.rejects(attempt, /bundledPipelinesDir.*pipelines/);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
