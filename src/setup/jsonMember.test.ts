// The surgical JSON member edit behind `setup` / `setup --remove` (FR-030,
// FR-031). The property that matters is that deleteMember is the exact inverse
// of setMember: the user's OpenCode config has to come back byte for byte.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { deleteMember, findMember, rootObjectStart, setMember } from "./jsonMember.js";

const ENTRY = { type: "local", command: ["/opt/agent-flows", "mcp"] };

function roundTrip(text: string, key = "mcp"): string {
  const open = rootObjectStart(text);
  const inserted = setMember(text, open, key, ENTRY, "  ");
  assert.notEqual(inserted, text, "setMember must have changed something");
  JSON.parse(inserted);
  return deleteMember(inserted, rootObjectStart(inserted), key);
}

describe("setMember / deleteMember round-trip", () => {
  const fixtures: Record<string, string> = {
    "empty object": "{}\n",
    "one member": '{\n  "theme": "tokyonight"\n}\n',
    "four-space indent": '{\n    "theme": "tokyonight",\n    "a": 1\n}\n',
    "inline members": '{ "theme": "tokyonight", "list": [1, 2, 3] }',
    "no trailing newline": '{\n  "theme": "tokyonight"\n}',
    "tab indent": '{\n\t"theme": "tokyonight"\n}\n',
    "value with braces in a string": '{\n  "note": "a } and a { in here"\n}\n',
    "nested objects": '{\n  "a": { "b": { "c": [1, 2] } }\n}\n',
  };

  for (const [name, text] of Object.entries(fixtures)) {
    it(`${name}: insert then delete restores the file byte for byte`, () => {
      assert.equal(roundTrip(text), text);
    });
  }

  it("inserts into a nested object and restores it", () => {
    const text =
      '{\n  "theme": "tokyonight",\n  "mcp": {\n    "other": { "type": "local" }\n  }\n}\n';
    const mcp = findMember(text, rootObjectStart(text), "mcp");
    assert.ok(mcp);
    const inserted = setMember(text, mcp.valueStart, "agent-flows", ENTRY, "  ");
    const parsed = JSON.parse(inserted) as { mcp: Record<string, unknown> };
    assert.deepEqual(parsed.mcp["agent-flows"], ENTRY);
    assert.deepEqual(parsed.mcp.other, { type: "local" });

    const removed = deleteMember(
      inserted,
      findMember(inserted, rootObjectStart(inserted), "mcp")!.valueStart,
      "agent-flows"
    );
    assert.equal(removed, text);
  });

  it("replaces an existing member in place, leaving its neighbours alone", () => {
    const text = '{\n  "a": 1,\n  "mcp": { "old": true },\n  "z": 2\n}\n';
    const replaced = setMember(text, rootObjectStart(text), "mcp", ENTRY, "  ");
    const parsed = JSON.parse(replaced) as Record<string, unknown>;
    assert.deepEqual(parsed.mcp, ENTRY);
    assert.equal(parsed.a, 1);
    assert.equal(parsed.z, 2);
    assert.ok(replaced.startsWith('{\n  "a": 1,\n'), replaced);
  });

  it("deletes a last member together with the comma in front of it", () => {
    const text = '{\n  "a": 1,\n  "mcp": { "x": true }\n}\n';
    const removed = deleteMember(text, rootObjectStart(text), "mcp");
    assert.equal(removed, '{\n  "a": 1\n}\n');
    JSON.parse(removed);
  });

  // The single documented exception to byte-exactness: whitespace INSIDE an
  // object that is empty before and after the round-trip is not recoverable —
  // nothing in the remaining text records how much of it there was.
  it("normalises the interior whitespace of an object that was empty anyway", () => {
    assert.equal(roundTrip("{ }"), "{}");
  });

  it("leaves the text alone when the member is absent", () => {
    const text = '{\n  "a": 1\n}\n';
    assert.equal(deleteMember(text, rootObjectStart(text), "mcp"), text);
  });

  it("reports no root object for a non-object document", () => {
    assert.equal(rootObjectStart("[1, 2]"), -1);
  });
});
