// Tests for the schema output contract: extracting JSON out of what a model
// actually says, validating it against the canon schema, and the notes a retry
// and a failed step carry.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { schemaContract } from "./outputContract.js";
import { WEAK_SCHEMA } from "./schemas.js";

const FINDING = { text: "Ambiguous", severity: "medium", blocking: false };
const contract = schemaContract("weaknesses");

describe("schemaContract — extracting the JSON out of what the model actually says", () => {
  it("parses the run that failed: narration, then a fenced object", () => {
    // Verbatim shape of run b565e7fd's `critic` output, which threw
    // `Unexpected token 'N', "Now produc"... is not valid JSON`.
    const answer = 'Now producing the final critique as JSON.\n\n```json\n{"weaknesses":[]}\n```';

    assert.deepEqual(contract.parse(answer), { ok: true, value: { weaknesses: [] } });
  });

  it("parses a bare fenced object", () => {
    const answer = '```json\n{"weaknesses":[' + JSON.stringify(FINDING) + "]}\n```";

    assert.deepEqual(contract.parse(answer), { ok: true, value: { weaknesses: [FINDING] } });
  });

  it("parses an object followed by trailing prose", () => {
    const answer =
      '{"weaknesses":[]}\n\nThat concludes the critique — let me know if you want more.';

    assert.deepEqual(contract.parse(answer), { ok: true, value: { weaknesses: [] } });
  });

  it("does not stop at a brace inside a string value", () => {
    // The scanner has to track string state: the first `}` here is inside
    // "use {placeholder}", and an escaped quote follows it.
    const finding = {
      text: 'use {placeholder} and a literal " quote',
      severity: "high",
      blocking: true,
    };
    const answer =
      'Here it is:\n\n```json\n{"weaknesses":[' + JSON.stringify(finding) + "]}\n```\nDone.";

    assert.deepEqual(contract.parse(answer), { ok: true, value: { weaknesses: [finding] } });
  });

  it("lets a stray brace in the preamble not hide the real object", () => {
    const answer = 'Opening { brace that never closes.\n{"weaknesses":[]}';

    assert.deepEqual(contract.parse(answer), { ok: true, value: { weaknesses: [] } });
  });
});

describe("schemaContract — rejecting what cannot be used", () => {
  it("rejects an answer with no JSON in it as a parse failure, reporting the strict attempt", () => {
    const r = contract.parse("I could not complete this task.");

    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.reason, "parse");
    assert.match(r.error, /Unexpected token/u);
    assert.match(r.retryNote, /^Your previous output was not valid JSON \(/u);
  });

  it("rejects valid JSON that lacks the top-level key, and says so rather than 'invalid JSON'", () => {
    const r = contract.parse("[" + JSON.stringify(FINDING) + "]");

    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.reason, "schema");
    assert.match(r.error, /^output missing required key "weaknesses"\. Got: /u);
    assert.match(r.retryNote, /valid JSON but had no top-level "weaknesses" key/u);
    assert.doesNotMatch(r.retryNote, /not valid JSON/u);
  });

  it("rejects a schema violation naming the field and the constraint", () => {
    const r = contract.parse(
      '{"weaknesses":[{"text":"Ambiguous","severity":"moderate","blocking":false}]}'
    );

    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.reason, "schema");
    for (const text of [r.error, r.retryNote]) {
      assert.match(text, /weaknesses\.0\.severity/u);
      assert.match(text, /must be one of low, medium, high, critical/u);
      assert.match(text, /"moderate"/u);
    }
    assert.match(r.error, /^output does not match schema "weaknesses": /u);
  });

  it("caps the quoted answer in the error at 200 characters", () => {
    const r = contract.parse(JSON.stringify({ other: "x".repeat(500) }));

    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.ok(r.error.length < 300, `the quoted answer must be capped: ${r.error.length}`);
  });

  it("ends every retry note with the closing instruction, so a caller adds nothing", () => {
    const notes = [
      contract.parse("not json"),
      contract.parse("[]"),
      contract.parse('{"weaknesses":[{"text":"x","severity":"moderate","blocking":false}]}'),
    ].map((r) => (r.ok ? "" : r.retryNote));

    assert.equal(notes.length, 3);
    for (const note of notes) assert.match(note, / Return ONLY the JSON object\.$/u);
  });
});

describe("schemaContract — the schema it hands to the transport", () => {
  it("exposes the canon schema of the declared key", () => {
    assert.deepEqual(contract.jsonSchema, WEAK_SCHEMA);
  });

  it("exposes none for a key the canon has no schema for, and still gates on the key", () => {
    const unknown = schemaContract("no-such-schema");

    assert.equal("jsonSchema" in unknown, false);
    assert.deepEqual(unknown.parse('{"no-such-schema":1}'), {
      ok: true,
      value: { "no-such-schema": 1 },
    });
    assert.equal(unknown.parse("{}").ok, false);
  });
});
