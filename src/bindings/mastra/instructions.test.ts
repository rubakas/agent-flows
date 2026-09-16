// Tests for the MCP instructions block (spec 038 D7, FR-010).
//
// Asserted against the exported constants themselves, never a copy: a bound that
// checks a duplicate of the text proves nothing about what the server sends.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { FULL_INSTRUCTIONS, SHORT_INSTRUCTIONS, instructionsFor } from "./instructions.js";

/** Claude Code truncates the instructions block past this many bytes. */
const CLAUDE_CODE_CAP_BYTES = 2048;

/** Roughly what Codex surfaces when deciding whether a server is relevant. */
const CODEX_HEAD_BYTES = 512;

describe("FULL_INSTRUCTIONS — fits the harness bounds (FR-010)", () => {
  it("is under Claude Code's 2048-byte cap", () => {
    const size = Buffer.byteLength(FULL_INSTRUCTIONS, "utf8");
    assert.ok(
      size < CLAUDE_CODE_CAP_BYTES,
      `instructions are ${size} bytes; Claude Code truncates past ${CLAUDE_CODE_CAP_BYTES}`
    );
  });

  it("names decide_entry_point in its first 512 bytes", () => {
    const head = Buffer.from(FULL_INSTRUCTIONS, "utf8").subarray(0, CODEX_HEAD_BYTES).toString();
    assert.ok(
      head.includes("decide_entry_point"),
      `the first ${CODEX_HEAD_BYTES} bytes must name the first tool to call; got: ${head}`
    );
  });

  it("its first 512 bytes end at a sentence boundary", () => {
    const head = Buffer.from(FULL_INSTRUCTIONS, "utf8").subarray(0, CODEX_HEAD_BYTES).toString();
    assert.ok(
      /[.!?]\s*$/u.test(head),
      `a harness cutting at ${CODEX_HEAD_BYTES} bytes must not land mid-sentence; ` +
        `the cut currently falls after: ${JSON.stringify(head.slice(-60))}`
    );
  });

  it("says what agent-flows is, and names the durable-run and gate facts", () => {
    for (const phrase of [
      "list_pipelines",
      "repository",
      "durable",
      "resumed by id",
      "approve",
    ] as const) {
      assert.ok(FULL_INSTRUCTIONS.includes(phrase), `full instructions must mention "${phrase}"`);
    }
  });
});

describe("SHORT_INSTRUCTIONS — the pointer for an uncustomized project (FR-010)", () => {
  it("is materially shorter than the full text", () => {
    const short = Buffer.byteLength(SHORT_INSTRUCTIONS, "utf8");
    const full = Buffer.byteLength(FULL_INSTRUCTIONS, "utf8");
    assert.ok(short * 2 < full, `short pointer is ${short} bytes against a full text of ${full}`);
  });

  it("still names the first tool to call", () => {
    assert.ok(SHORT_INSTRUCTIONS.includes("decide_entry_point"));
  });
});

describe("instructionsFor — scope follows the merged layer view (D7, D13)", () => {
  // AGENT_FLOWS_HOME is pinned in every case: the user library is one of the
  // three layers, so an unpinned run would answer from the owner's real one.
  it("sends the pointer for a project with only the bundled layer", () => {
    const dir = mkdtempSync(join(realpathSync(tmpdir()), "af-instructions-"));
    const home = mkdtempSync(join(realpathSync(tmpdir()), "af-instructions-home-"));
    try {
      assert.equal(instructionsFor(dir, { AGENT_FLOWS_HOME: home }), SHORT_INSTRUCTIONS);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("sends the full text once the project has a repository canon", () => {
    const dir = mkdtempSync(join(realpathSync(tmpdir()), "af-instructions-"));
    const home = mkdtempSync(join(realpathSync(tmpdir()), "af-instructions-home-"));
    try {
      const pipelines = join(dir, ".agent-flows", "pipelines");
      mkdirSync(pipelines, { recursive: true });
      writeFileSync(join(pipelines, "own.yaml"), "id: own\nversion: 1\nsteps: []\n");
      assert.equal(instructionsFor(dir, { AGENT_FLOWS_HOME: home }), FULL_INSTRUCTIONS);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("sends the full text once the user library contributes a layer (D13)", () => {
    const dir = mkdtempSync(join(realpathSync(tmpdir()), "af-instructions-"));
    const home = mkdtempSync(join(realpathSync(tmpdir()), "af-instructions-home-"));
    try {
      mkdirSync(join(home, "workflows", "pipelines"), { recursive: true });
      assert.equal(instructionsFor(dir, { AGENT_FLOWS_HOME: home }), FULL_INSTRUCTIONS);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });
});
