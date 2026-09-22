// V5: the exact pipeline × profile portability matrix printed by `pnpm canon:check`.
//
// Snapshot, not a shape check: a capability change, a new pipeline, or a step
// gaining `permissions.contents` must show up here as a diff, with the reason.

import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import { packageRoot } from "../packageRoot.js";
import { listPipelines, loadPipeline } from "./load.js";
import { renderPortabilityMatrix } from "./portability.js";
import { MATRIX_PROFILE_IDS, defaultRegistry, getProfile } from "./registry.js";

const repoRoot = packageRoot();

const EXPECTED_MATRIX = `PIPELINE       PROFILE    VERDICT
audit          anthropic  runs
audit          openai     runs
audit          local      refused: correctness: step "correctness" under profile "local" resolves to model entry "ollama-qwen" (transport api), which cannot enforce permissions.contents "read"
build-round    anthropic  runs
build-round    openai     refused: fix: step "fix" under profile "openai" resolves to model entry "gpt-terra" (transport cli:codex), which cannot enforce permissions.contents "write"
build-round    local      refused: fix: step "fix" under profile "local" resolves to model entry "ollama-qwen" (transport api), which cannot enforce permissions.contents "write"
build          anthropic  runs
build          openai     refused: develop.implement: step "develop.implement" under profile "openai" resolves to model entry "gpt-terra" (transport cli:codex), which cannot enforce permissions.contents "write"
build          local      refused: develop.implement: step "develop.implement" under profile "local" resolves to model entry "ollama-qwen" (transport api), which cannot enforce permissions.contents "write"
code-review    anthropic  runs
code-review    openai     runs
code-review    local      refused: radius: step "radius" under profile "local" resolves to model entry "ollama-qwen" (transport api), which cannot enforce permissions.contents "read"
correct-plan   anthropic  runs
correct-plan   openai     runs
correct-plan   local      refused: revise: step "revise" under profile "local" resolves to model entry "ollama-qwen" (transport api), which cannot enforce permissions.contents "read"
cycle-dev      anthropic  runs
cycle-dev      openai     refused: build.develop.implement: step "build.develop.implement" under profile "openai" resolves to model entry "gpt-terra" (transport cli:codex), which cannot enforce permissions.contents "write"
cycle-dev      local      refused: investigate.survey: step "investigate.survey" under profile "local" resolves to model entry "ollama-qwen" (transport api), which cannot enforce permissions.contents "read"
cycle          anthropic  runs
cycle          openai     refused: build.develop.implement: step "build.develop.implement" under profile "openai" resolves to model entry "gpt-terra" (transport cli:codex), which cannot enforce permissions.contents "write"
cycle          local      refused: investigate.survey: step "investigate.survey" under profile "local" resolves to model entry "ollama-qwen" (transport api), which cannot enforce permissions.contents "read"
develop        anthropic  runs
develop        openai     refused: implement: step "implement" under profile "openai" resolves to model entry "gpt-terra" (transport cli:codex), which cannot enforce permissions.contents "write"
develop        local      refused: implement: step "implement" under profile "local" resolves to model entry "ollama-qwen" (transport api), which cannot enforce permissions.contents "write"
investigate    anthropic  runs
investigate    openai     runs
investigate    local      refused: survey: step "survey" under profile "local" resolves to model entry "ollama-qwen" (transport api), which cannot enforce permissions.contents "read"
ship           anthropic  runs
ship           openai     runs
ship           local      runs
spec-creation  anthropic  runs
spec-creation  openai     runs
spec-creation  local      refused: verify.correctness: step "verify.correctness" under profile "local" resolves to model entry "ollama-qwen" (transport api), which cannot enforce permissions.contents "read"
test           anthropic  runs
test           openai     runs
test           local      runs`;

describe("portability matrix — canon:check output (V5)", () => {
  it("matches the expected table for every pipeline × profile", () => {
    const files = listPipelines(join(repoRoot, "pipelines"));
    assert.equal(files.length, 12, "the repo ships 12 pipelines");

    // V7: every pipeline must still load after the permissions.allow removal.
    const loaded = files.map((f) => loadPipeline(f));

    const table = renderPortabilityMatrix(
      loaded,
      MATRIX_PROFILE_IDS.map((id) => getProfile(id)),
      // A fixed env keeps api endpoints — and therefore the table — machine-independent.
      defaultRegistry({})
    );
    assert.equal(table, EXPECTED_MATRIX);
  });

  it("reports three profiles per pipeline", () => {
    assert.deepEqual([...MATRIX_PROFILE_IDS], ["anthropic", "openai", "local"]);
  });
});
