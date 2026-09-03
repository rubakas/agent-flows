// Tests for src/canon/canonWriter.ts — FR-007.
// Run via: npx tsx --test src/canon/canonWriter.test.ts

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { parseDocument } from "yaml";
import { makeInMemoryDb } from "../db/index.js";
import { docToString, hashContent, saveDraft } from "./canonWriter.js";
import { addDraftOp, getDraft, indexSource, listDraftOps, openDraft } from "./draftStore.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, "..", "..");
const REAL_PIPELINE_PATH = join(REPO_ROOT, "pipelines", "spec-creation.yaml");

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Create a temporary directory tree that loadPipeline expects:
 *   <root>/pipelines/<name>.yaml
 *
 * Returns { root, pipelineDir, pipelinePath }.
 */
function makeTmpPipelineDir(name = "test") {
  const root = mkdtempSync(join(tmpdir(), "yoke-writer-test-"));
  const pipelineDir = join(root, "pipelines");
  mkdirSync(pipelineDir);
  const pipelinePath = join(pipelineDir, `${name}.yaml`);
  return { root, pipelineDir, pipelinePath };
}

/** A valid gate pipeline — no prompts, so no prompt files are needed. */
const GATE_PIPELINE = `\
id: test
version: 1
description: Test pipeline
inputs:
  - request
steps:
  - id: gate
    kind: gate
    message: approve?
`;

/**
 * A gate pipeline with comments at multiple levels — used to verify that the
 * Document AST write path does not strip them.
 */
const COMMENTED_PIPELINE = `\
# Top-level pipeline comment
id: commented
version: 1
description: Pipeline with comments
inputs:
  - request
steps:
  # This step approves the work
  - id: gate
    kind: gate
    message: approve?
`;

/** An invalid pipeline body (llm step missing role/model). */
const INVALID_PIPELINE = `\
id: test
version: 1
description: Bad pipeline
inputs:
  - request
steps:
  - id: s1
    kind: llm
    prompt: prompts/intake.md
`;

function setup(content: string) {
  const { root, pipelinePath } = makeTmpPipelineDir();
  writeFileSync(pipelinePath, content, "utf8");
  const db = makeInMemoryDb();
  const relPath = "pipelines/test.yaml";
  const baseHash = hashContent(content);
  const sourceId = indexSource(db, root, relPath, "pipeline", baseHash);
  const draftId = openDraft(db, sourceId, content, baseHash);
  return { db, root, pipelinePath, sourceId, draftId };
}

// ── Byte-identical round-trip (regression) ────────────────────────────────────

describe("docToString — byte-identical serialisation", () => {
  it("round-trips pipelines/spec-creation.yaml with no byte difference", () => {
    // This is the repo's own canon pipeline. It uses flow collections
    // (dependsOn: [intake]) without spaces inside the brackets.
    // A default toString() pads them to [ intake ], producing noisy diffs
    // on every save even when nothing changed. This test pins the fix.
    const original = readFileSync(REAL_PIPELINE_PATH, "utf8");
    const doc = parseDocument(original);
    const output = docToString(doc);
    assert.equal(
      output,
      original,
      "serialising an unmodified Document must return byte-identical content"
    );
  });
});

// ── Comment and key-order preservation ───────────────────────────────────────

describe("saveDraft — comment and key order preservation", () => {
  it("round-trips a pipeline with comments: comments survive intact", () => {
    const { root, pipelinePath } = makeTmpPipelineDir("commented");
    writeFileSync(pipelinePath, COMMENTED_PIPELINE, "utf8");
    const db = makeInMemoryDb();
    const relPath = "pipelines/commented.yaml";
    const baseHash = hashContent(COMMENTED_PIPELINE);
    const sourceId = indexSource(db, root, relPath, "pipeline", baseHash);
    const draftId = openDraft(db, sourceId, COMMENTED_PIPELINE, baseHash);

    const result = saveDraft(db, draftId);

    assert.ok(result.ok, `Expected ok, got: ${JSON.stringify(result)}`);

    const written = readFileSync(pipelinePath, "utf8");
    assert.ok(written.includes("# Top-level pipeline comment"), "top-level comment must survive");
    assert.ok(written.includes("# This step approves the work"), "step-level comment must survive");
  });

  it("preserves key order after a round-trip through the Document AST", () => {
    const { root, pipelinePath } = makeTmpPipelineDir("ordered");
    writeFileSync(pipelinePath, GATE_PIPELINE, "utf8");
    const db = makeInMemoryDb();
    const relPath = "pipelines/ordered.yaml";
    const baseHash = hashContent(GATE_PIPELINE);
    const sourceId = indexSource(db, root, relPath, "pipeline", baseHash);
    const draftId = openDraft(db, sourceId, GATE_PIPELINE, baseHash);

    const result = saveDraft(db, draftId);
    assert.ok(result.ok);

    const written = readFileSync(pipelinePath, "utf8");
    // id must appear before version, which must appear before description
    const idPos = written.indexOf("id:");
    const versionPos = written.indexOf("version:");
    const descPos = written.indexOf("description:");
    assert.ok(idPos < versionPos, "id must come before version");
    assert.ok(versionPos < descPos, "version must come before description");

    try {
      rmSync(join(root, ".."), { recursive: true, force: true });
    } catch {
      // cleanup failure is non-fatal
    }
  });
});

// ── Invalid draft ─────────────────────────────────────────────────────────────

describe("saveDraft — invalid draft", () => {
  it("returns ok:false reason:invalid when loadPipeline rejects the body", () => {
    const { db, pipelinePath, draftId } = setup(INVALID_PIPELINE);

    const result = saveDraft(db, draftId);

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, "invalid");
      assert.ok(result.message.length > 0, "message should be non-empty");
    }

    // File must be unchanged
    const onDisk = readFileSync(pipelinePath, "utf8");
    assert.equal(onDisk, INVALID_PIPELINE);
  });

  it("stores the validator message on the draft when invalid", () => {
    const { db, draftId } = setup(INVALID_PIPELINE);

    saveDraft(db, draftId);

    const draft = getDraft(db, draftId);
    assert.ok(draft !== undefined);
    assert.equal(draft.validationState, "invalid");
    assert.ok(
      draft.validationMessage !== null && draft.validationMessage.length > 0,
      "validator message must be stored on the draft"
    );
  });

  it("draft body survives an invalid save attempt unchanged", () => {
    const { db, draftId } = setup(INVALID_PIPELINE);

    saveDraft(db, draftId);

    const draft = getDraft(db, draftId);
    assert.equal(draft?.body, INVALID_PIPELINE);
  });
});

// ── Conflict detection ────────────────────────────────────────────────────────

describe("saveDraft — conflict", () => {
  it("refuses when the file was edited on disk after the draft was opened", () => {
    const { db, pipelinePath, draftId } = setup(GATE_PIPELINE);

    // Simulate another agent editing the file behind the draft's back
    writeFileSync(pipelinePath, GATE_PIPELINE + "# edited by someone else\n", "utf8");

    const result = saveDraft(db, draftId);

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, "conflict");
    }
  });

  it("leaves the draft intact after a conflict", () => {
    const { db, pipelinePath, draftId } = setup(GATE_PIPELINE);

    writeFileSync(pipelinePath, GATE_PIPELINE + "# conflict\n", "utf8");
    saveDraft(db, draftId);

    const draft = getDraft(db, draftId);
    assert.ok(draft !== undefined, "draft must still exist");
    assert.equal(draft.body, GATE_PIPELINE);
  });

  it("does not overwrite the file on conflict", () => {
    const { db, pipelinePath, draftId } = setup(GATE_PIPELINE);

    const modified = GATE_PIPELINE + "# conflict sentinel\n";
    writeFileSync(pipelinePath, modified, "utf8");
    saveDraft(db, draftId);

    const onDisk = readFileSync(pipelinePath, "utf8");
    assert.equal(onDisk, modified, "file must not have been overwritten");
  });
});

// ── Clean save updates stored hash ────────────────────────────────────────────

describe("saveDraft — clean save", () => {
  it("succeeds and returns ok:true", () => {
    const { db, draftId } = setup(GATE_PIPELINE);
    const result = saveDraft(db, draftId);
    assert.ok(result.ok);
  });

  it("updates the draft baseHash after a successful save", () => {
    const { db, draftId } = setup(GATE_PIPELINE);

    saveDraft(db, draftId);

    const draft = getDraft(db, draftId);
    assert.ok(draft !== undefined);
    // The base hash must be a full sha256 hex string (64 chars)
    assert.ok(draft.baseHash.length === 64, "baseHash should be a sha256 hex string");
  });

  it("a second save on the same draft does not produce a false conflict", () => {
    const { db, draftId } = setup(GATE_PIPELINE);

    const first = saveDraft(db, draftId);
    assert.ok(first.ok, "first save must succeed");

    const second = saveDraft(db, draftId);
    assert.ok(second.ok, "second save must not be a false conflict");
  });

  it("sets validationState to valid after a successful save", () => {
    const { db, draftId } = setup(GATE_PIPELINE);

    saveDraft(db, draftId);

    const draft = getDraft(db, draftId);
    assert.equal(draft?.validationState, "valid");
  });
});

// ── Undo ops replay ───────────────────────────────────────────────────────────

describe("undo ops replay", () => {
  it("ops added before and after a save are all present and ordered", () => {
    const { db, sourceId, draftId } = setup(GATE_PIPELINE);

    const op1 = { type: "set", path: ["description"], value: "v1" };
    const op2 = { type: "set", path: ["description"], value: "v2" };
    const op3 = { type: "set", path: ["id"], value: "renamed" };

    addDraftOp(db, draftId, 1, op1);
    addDraftOp(db, draftId, 2, op2);

    saveDraft(db, draftId);

    addDraftOp(db, draftId, 3, op3);

    const ops = listDraftOps(db, draftId);
    assert.equal(ops.length, 3);
    assert.equal(ops[0].seq, 1);
    assert.deepEqual(JSON.parse(ops[0].op), op1);
    assert.equal(ops[1].seq, 2);
    assert.deepEqual(JSON.parse(ops[1].op), op2);
    assert.equal(ops[2].seq, 3);
    assert.deepEqual(JSON.parse(ops[2].op), op3);

    // Suppress unused variable warning
    void sourceId;
  });

  it("replaying ops in seq order reconstructs the edit history", () => {
    const db = makeInMemoryDb();
    const root = mkdtempSync(join(tmpdir(), "yoke-undo-test-"));
    const pipelineDir = join(root, "pipelines");
    mkdirSync(pipelineDir);
    const pipelinePath = join(pipelineDir, "undo.yaml");
    writeFileSync(pipelinePath, GATE_PIPELINE, "utf8");

    const relPath = "pipelines/undo.yaml";
    const baseHash = hashContent(GATE_PIPELINE);
    const sourceId = indexSource(db, root, relPath, "pipeline", baseHash);
    const draftId = openDraft(db, sourceId, GATE_PIPELINE, baseHash);

    // Record three ops representing a sequence of field edits
    const ops = [
      { seq: 1, op: { type: "set", path: ["id"], value: "step-a" } },
      { seq: 2, op: { type: "set", path: ["description"], value: "Updated desc" } },
      { seq: 3, op: { type: "set", path: ["id"], value: "step-b" } },
    ];
    for (const { seq, op } of ops) {
      addDraftOp(db, draftId, seq, op);
    }

    // Replay: ops come back in seq order — applying them in that order
    // yields the final intended state.
    const stored = listDraftOps(db, draftId);
    assert.equal(stored.length, ops.length);

    let currentId = "test"; // initial value from GATE_PIPELINE
    for (const row of stored) {
      const parsed = JSON.parse(row.op) as { type: string; path: string[]; value: string };
      if (parsed.path[0] === "id") {
        currentId = parsed.value;
      }
    }
    // After replaying all ops, the last id set was "step-b"
    assert.equal(currentId, "step-b");

    rmSync(root, { recursive: true, force: true });

    void sourceId;
  });
});
