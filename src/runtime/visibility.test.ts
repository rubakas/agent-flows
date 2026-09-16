// Per-project visibility file (spec 038 D15, FR-024, FR-025).
//
// Every case writes into a mkdtemp state directory: the real file lives in the
// owner's ~/.agent-flows/projects/<key>/, which no test may touch.

import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { listPipelinesPayload } from "../bindings/mastra/listPipelines.js";
import { resolveProjectState } from "./projectState.js";
import { readHidden, setHidden, visibilityPath } from "./visibility.js";

function tempDir(prefix: string): string {
  return realpathSync(mkdtempSync(join(realpathSync(tmpdir()), prefix)));
}

describe("FR-024: <stateDir>/visibility.json", () => {
  it("absence means nothing is hidden", () => {
    const dir = tempDir("af-vis-absent-");
    try {
      assert.ok(!existsSync(visibilityPath(dir)));
      assert.deepEqual([...readHidden(dir)], []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is created on first write, mode 0600, holding { hidden: [...] }", () => {
    const dir = tempDir("af-vis-write-");
    try {
      const list = setHidden(join(dir, "state"), "investigate", true);
      assert.deepEqual(list, ["investigate"]);
      const path = visibilityPath(join(dir, "state"));
      assert.equal(
        statSync(path).mode & 0o777,
        0o600,
        "the file must not be group- or world-readable"
      );
      assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { hidden: ["investigate"] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("enable removes an id, disable adds one, and both are idempotent", () => {
    const dir = tempDir("af-vis-toggle-");
    try {
      setHidden(dir, "a", true);
      setHidden(dir, "a", true);
      assert.deepEqual(setHidden(dir, "b", true), ["a", "b"]);
      assert.deepEqual(setHidden(dir, "a", false), ["b"]);
      assert.deepEqual(setHidden(dir, "a", false), ["b"], "enabling a visible id changes nothing");
      assert.deepEqual([...readHidden(dir)], ["b"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("an id that no longer exists in the merged view is ignored, not an error", () => {
    // AGENT_FLOWS_HOME is pinned so both the state directory this writes into
    // and the user library layer are the temp tree, never the owner's own.
    const home = tempDir("af-vis-unknown-home-");
    const project = tempDir("af-vis-unknown-project-");
    try {
      const env = { AGENT_FLOWS_HOME: home };
      setHidden(resolveProjectState(project, env).dir, "workflow-that-vanished", true);
      const ids = listPipelinesPayload(project, env).pipelines.map((p) => p.id);
      assert.ok(ids.includes("investigate"), "a hidden id nothing defines any more hides nothing");
      assert.ok(ids.includes("cycle"));
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(project, { recursive: true, force: true });
    }
  });

  it("a malformed file reads as nothing hidden rather than failing a listing", () => {
    const dir = tempDir("af-vis-malformed-");
    try {
      setHidden(dir, "a", true);
      writeFileSync(visibilityPath(dir), "{not json", "utf8");
      assert.deepEqual([...readHidden(dir)], []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
