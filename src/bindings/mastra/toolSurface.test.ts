// What the MCP tool descriptions tell a host chat model.
//
// The descriptions are the only instruction a model gets before it decides
// whether to run a pipeline or stop and interrogate the operator. code-review
// runs from `inputs: {}` — it derives its own baseline, fetches its own spec
// sources and writes its own brief — so a description implying inputs are
// required costs the owner the one thing the tool exists for.
//
// Asserted against the source text because src/bindings/mastra/server.ts calls
// startStdio() at the top level and cannot be imported (see
// src/cli.entrypoints.test.ts, which pins that fact).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { packageRoot } from "../../packageRoot.js";

const SERVER_SOURCE = readFileSync(join(packageRoot(), "src/bindings/mastra/server.ts"), "utf8");

/**
 * The source text of one field of `startInputSchema`, from its name to the next
 * field's. Sliced on anchors rather than searched whole: every field in that
 * schema carries the word "optional", so a whole-file search proves nothing.
 */
function schemaField(name: string, next: string): string {
  const start = SERVER_SOURCE.indexOf(`const startInputSchema`);
  assert.notEqual(start, -1, "startInputSchema must still be declared in server.ts");
  const from = SERVER_SOURCE.indexOf(`\n  ${name}: z`, start);
  assert.notEqual(from, -1, `startInputSchema must still declare the "${name}" field`);
  const to = SERVER_SOURCE.indexOf(`\n  ${next}: z`, from);
  assert.notEqual(to, -1, `the "${name}" field must still be followed by "${next}"`);
  return SERVER_SOURCE.slice(from, to);
}

describe("start_run / run_pipeline: the inputs field does not claim values are required", () => {
  const field = schemaField("inputs", "models");

  it("no longer says inputs are optional only when artifact_path is provided", () => {
    assert.doesNotMatch(
      field,
      /optional when artifact_path is provided/u,
      "that phrasing reads as 'otherwise required' and makes a model stop and ask the " +
        `operator for values it does not need; got:\n${field}`
    );
  });

  it("says an empty input set is a legitimate call", () => {
    assert.match(
      field,
      /`\{\}`/u,
      `the description must name \`{}\` as a call a model may make; got:\n${field}`
    );
    assert.match(
      field,
      /derive/u,
      `the description must say a pipeline may derive what it needs; got:\n${field}`
    );
  });

  it("points at list_pipelines for which inputs a given pipeline requires", () => {
    assert.match(
      field,
      /list_pipelines/u,
      "some pipelines DO have required inputs, so the description must name the " +
        `surface that tells a model which; got:\n${field}`
    );
  });
});

describe("list_pipelines: its description says the listing distinguishes required from optional", () => {
  it("names optionalInputs and how to derive the required set", () => {
    const start = SERVER_SOURCE.indexOf(`id: "list_pipelines"`);
    assert.notEqual(start, -1, "the list_pipelines tool must still be declared");
    const description = SERVER_SOURCE.slice(start, SERVER_SOURCE.indexOf("inputSchema", start));
    assert.match(
      description,
      /optionalInputs/u,
      `the description must name the field it now returns; got:\n${description}`
    );
    assert.match(
      description,
      /required/u,
      `the description must say the listing distinguishes required inputs; got:\n${description}`
    );
  });
});

describe("decide_entry_point: its kind enum matches the daemon's routes", () => {
  it("offers review-request alongside the two pre-existing kinds", () => {
    const start = SERVER_SOURCE.indexOf(`id: "decide_entry_point"`);
    assert.notEqual(start, -1, "the decide_entry_point tool must still be declared");
    const tool = SERVER_SOURCE.slice(start, SERVER_SOURCE.indexOf("execute:", start));
    for (const kind of ["feature-request", "task-description", "review-request"]) {
      assert.ok(tool.includes(`"${kind}"`), `the kind enum must offer "${kind}"; got:\n${tool}`);
    }
    assert.match(
      tool,
      /code-review/u,
      `the kind description must name where a review request routes; got:\n${tool}`
    );
  });
});
