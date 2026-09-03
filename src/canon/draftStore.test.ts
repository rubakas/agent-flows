// Tests for src/canon/draftStore.ts — FR-006.
// Run via: npx tsx --test src/canon/draftStore.test.ts

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { makeInMemoryDb } from "../db/index.js";
import {
  addDraftOp,
  discardDraft,
  getDraft,
  getSource,
  indexSource,
  listDraftOps,
  openDraft,
  setDraftValidation,
  updateDraftBaseHash,
  updateDraftBody,
  updateSourceHash,
} from "./draftStore.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeDb() {
  return makeInMemoryDb();
}

const FAKE_ROOT = "/tmp/fake-root";
const FAKE_REL = "pipelines/test.yaml";
const FAKE_HASH = "abc123";
const FAKE_BODY = "id: test\nversion: 1\n";

// ── indexSource / getSource ───────────────────────────────────────────────────

describe("indexSource", () => {
  it("returns a numeric id", () => {
    const db = makeDb();
    const id = indexSource(db, FAKE_ROOT, FAKE_REL, "pipeline", FAKE_HASH);
    assert.ok(typeof id === "number");
    assert.ok(id > 0);
  });

  it("getSource returns the inserted row", () => {
    const db = makeDb();
    const id = indexSource(db, FAKE_ROOT, FAKE_REL, "pipeline", FAKE_HASH);
    const row = getSource(db, id);
    assert.ok(row !== undefined);
    assert.equal(row.root, FAKE_ROOT);
    assert.equal(row.relPath, FAKE_REL);
    assert.equal(row.kind, "pipeline");
    assert.equal(row.contentHash, FAKE_HASH);
    assert.equal(row.parseState, "ok");
  });

  it("getSource returns undefined for unknown id", () => {
    const db = makeDb();
    assert.equal(getSource(db, 9999), undefined);
  });

  it("multiple sources get distinct ids", () => {
    const db = makeDb();
    const a = indexSource(db, FAKE_ROOT, "pipelines/a.yaml", "pipeline", "hash-a");
    const b = indexSource(db, FAKE_ROOT, "pipelines/b.yaml", "pipeline", "hash-b");
    assert.notEqual(a, b);
  });
});

describe("updateSourceHash", () => {
  it("updates the stored content hash", () => {
    const db = makeDb();
    const id = indexSource(db, FAKE_ROOT, FAKE_REL, "pipeline", "old-hash");
    updateSourceHash(db, id, "new-hash");
    const row = getSource(db, id);
    assert.equal(row?.contentHash, "new-hash");
  });
});

// ── openDraft / getDraft ──────────────────────────────────────────────────────

describe("openDraft", () => {
  it("returns a numeric id", () => {
    const db = makeDb();
    const sourceId = indexSource(db, FAKE_ROOT, FAKE_REL, "pipeline", FAKE_HASH);
    const draftId = openDraft(db, sourceId, FAKE_BODY, FAKE_HASH);
    assert.ok(typeof draftId === "number");
    assert.ok(draftId > 0);
  });

  it("getDraft returns the inserted row with defaults", () => {
    const db = makeDb();
    const sourceId = indexSource(db, FAKE_ROOT, FAKE_REL, "pipeline", FAKE_HASH);
    const draftId = openDraft(db, sourceId, FAKE_BODY, FAKE_HASH);
    const draft = getDraft(db, draftId);
    assert.ok(draft !== undefined);
    assert.equal(draft.sourceId, sourceId);
    assert.equal(draft.body, FAKE_BODY);
    assert.equal(draft.baseHash, FAKE_HASH);
    assert.equal(draft.validationState, "pending");
    assert.equal(draft.validationMessage, null);
  });

  it("getDraft returns undefined for unknown id", () => {
    const db = makeDb();
    assert.equal(getDraft(db, 9999), undefined);
  });
});

// ── updateDraftBody ───────────────────────────────────────────────────────────

describe("updateDraftBody", () => {
  it("replaces the body and resets validation state to pending", () => {
    const db = makeDb();
    const sourceId = indexSource(db, FAKE_ROOT, FAKE_REL, "pipeline", FAKE_HASH);
    const draftId = openDraft(db, sourceId, FAKE_BODY, FAKE_HASH);

    // Mark as valid first
    setDraftValidation(db, draftId, "valid");
    assert.equal(getDraft(db, draftId)?.validationState, "valid");

    // Update body — should reset to pending
    updateDraftBody(db, draftId, "id: updated\n");
    const updated = getDraft(db, draftId);
    assert.equal(updated?.body, "id: updated\n");
    assert.equal(updated?.validationState, "pending");
    assert.equal(updated?.validationMessage, null);
  });
});

// ── setDraftValidation ────────────────────────────────────────────────────────

describe("setDraftValidation", () => {
  it("sets state to valid", () => {
    const db = makeDb();
    const sourceId = indexSource(db, FAKE_ROOT, FAKE_REL, "pipeline", FAKE_HASH);
    const draftId = openDraft(db, sourceId, FAKE_BODY, FAKE_HASH);
    setDraftValidation(db, draftId, "valid");
    assert.equal(getDraft(db, draftId)?.validationState, "valid");
    assert.equal(getDraft(db, draftId)?.validationMessage, null);
  });

  it("sets state to invalid with message", () => {
    const db = makeDb();
    const sourceId = indexSource(db, FAKE_ROOT, FAKE_REL, "pipeline", FAKE_HASH);
    const draftId = openDraft(db, sourceId, FAKE_BODY, FAKE_HASH);
    setDraftValidation(db, draftId, "invalid", "Step s1: llm step requires role or model");
    const draft = getDraft(db, draftId);
    assert.equal(draft?.validationState, "invalid");
    assert.equal(draft?.validationMessage, "Step s1: llm step requires role or model");
  });
});

// ── updateDraftBaseHash ───────────────────────────────────────────────────────

describe("updateDraftBaseHash", () => {
  it("updates the stored base hash", () => {
    const db = makeDb();
    const sourceId = indexSource(db, FAKE_ROOT, FAKE_REL, "pipeline", FAKE_HASH);
    const draftId = openDraft(db, sourceId, FAKE_BODY, "old-base");
    updateDraftBaseHash(db, draftId, "new-base");
    assert.equal(getDraft(db, draftId)?.baseHash, "new-base");
  });
});

// ── discardDraft ──────────────────────────────────────────────────────────────

describe("discardDraft", () => {
  it("removes the draft and its ops", () => {
    const db = makeDb();
    const sourceId = indexSource(db, FAKE_ROOT, FAKE_REL, "pipeline", FAKE_HASH);
    const draftId = openDraft(db, sourceId, FAKE_BODY, FAKE_HASH);
    addDraftOp(db, draftId, 1, { type: "set", path: ["id"], value: "new" });
    addDraftOp(db, draftId, 2, { type: "set", path: ["description"], value: "x" });

    discardDraft(db, draftId);

    assert.equal(getDraft(db, draftId), undefined);
    assert.deepEqual(listDraftOps(db, draftId), []);
  });

  it("leaves other drafts intact", () => {
    const db = makeDb();
    const sourceId = indexSource(db, FAKE_ROOT, FAKE_REL, "pipeline", FAKE_HASH);
    const d1 = openDraft(db, sourceId, FAKE_BODY, FAKE_HASH);
    const d2 = openDraft(db, sourceId, FAKE_BODY, FAKE_HASH);

    discardDraft(db, d1);

    assert.equal(getDraft(db, d1), undefined);
    assert.ok(getDraft(db, d2) !== undefined);
  });
});

// ── addDraftOp / listDraftOps ─────────────────────────────────────────────────

describe("addDraftOp / listDraftOps", () => {
  it("returns ops in ascending seq order regardless of insertion order", () => {
    const db = makeDb();
    const sourceId = indexSource(db, FAKE_ROOT, FAKE_REL, "pipeline", FAKE_HASH);
    const draftId = openDraft(db, sourceId, FAKE_BODY, FAKE_HASH);

    const op3 = { type: "set", path: ["steps", 0, "id"], value: "c" };
    const op1 = { type: "set", path: ["id"], value: "a" };
    const op2 = { type: "set", path: ["description"], value: "b" };

    addDraftOp(db, draftId, 3, op3);
    addDraftOp(db, draftId, 1, op1);
    addDraftOp(db, draftId, 2, op2);

    const ops = listDraftOps(db, draftId);
    assert.equal(ops.length, 3);
    assert.equal(ops[0].seq, 1);
    assert.equal(ops[1].seq, 2);
    assert.equal(ops[2].seq, 3);
    assert.deepEqual(JSON.parse(ops[0].op), op1);
    assert.deepEqual(JSON.parse(ops[1].op), op2);
    assert.deepEqual(JSON.parse(ops[2].op), op3);
  });

  it("addDraftOp returns a numeric id", () => {
    const db = makeDb();
    const sourceId = indexSource(db, FAKE_ROOT, FAKE_REL, "pipeline", FAKE_HASH);
    const draftId = openDraft(db, sourceId, FAKE_BODY, FAKE_HASH);
    const opId = addDraftOp(db, draftId, 1, { type: "noop" });
    assert.ok(typeof opId === "number");
    assert.ok(opId > 0);
  });

  it("listDraftOps returns empty array when no ops exist", () => {
    const db = makeDb();
    const sourceId = indexSource(db, FAKE_ROOT, FAKE_REL, "pipeline", FAKE_HASH);
    const draftId = openDraft(db, sourceId, FAKE_BODY, FAKE_HASH);
    assert.deepEqual(listDraftOps(db, draftId), []);
  });

  it("ops from different drafts are independent", () => {
    const db = makeDb();
    const sourceId = indexSource(db, FAKE_ROOT, FAKE_REL, "pipeline", FAKE_HASH);
    const d1 = openDraft(db, sourceId, FAKE_BODY, FAKE_HASH);
    const d2 = openDraft(db, sourceId, FAKE_BODY, FAKE_HASH);

    addDraftOp(db, d1, 1, { draft: 1 });
    addDraftOp(db, d2, 1, { draft: 2 });

    const ops1 = listDraftOps(db, d1);
    const ops2 = listDraftOps(db, d2);

    assert.equal(ops1.length, 1);
    assert.equal(ops2.length, 1);
    assert.deepEqual(JSON.parse(ops1[0].op), { draft: 1 });
    assert.deepEqual(JSON.parse(ops2[0].op), { draft: 2 });
  });
});
