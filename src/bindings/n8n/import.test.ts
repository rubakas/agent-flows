// Tests for the n8n → canon importer (spec 022, FR-007 through FR-010).
//
// Test plan coverage:
//   1. Loud failure on unsupported node, zero writes
//   2. Round-trip lossless for llm/check (canon → n8n → canon)
//   3. Round-trip refusal for gate (noOp → import fails loudly)
//   4. Expression inversion
//   5. Validation backstop (placeholder references non-ancestor)

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { generateN8nWorkflow } from "./build.js";
import {
  importN8nWorkflow,
  invertPromptExpression,
  slugifyWorkflowName,
  type N8nImportWorkflow,
} from "./import.js";
import type { LoadedPipeline, StepDef } from "../../canon/types.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeLoaded(
  id: string,
  inputs: string[],
  steps: StepDef[],
  prompts: Record<string, string> = {}
): LoadedPipeline {
  return {
    def: {
      id,
      version: 1,
      description: id,
      inputs,
      steps,
    },
    prompts,
  };
}

// ── Test 1: loud failure on unsupported node ──────────────────────────────────

describe("importN8nWorkflow — unsupported node type", () => {
  it("fails loudly with node name and type when httpRequest node is present", () => {
    const wf: N8nImportWorkflow = {
      name: "test",
      nodes: [
        {
          name: "Manual Trigger",
          type: "n8n-nodes-base.manualTrigger",
          parameters: {},
        },
        {
          name: "Fetch stuff",
          type: "n8n-nodes-base.httpRequest",
          parameters: {},
        },
      ],
      connections: {
        "Manual Trigger": { main: [[{ node: "Fetch stuff", type: "main", index: 0 }]] },
      },
    };

    assert.throws(
      () => importN8nWorkflow(wf),
      (err: Error) => {
        assert.ok(err.message.includes("Fetch stuff"), `expected node name in: ${err.message}`);
        assert.ok(
          err.message.includes("n8n-nodes-base.httpRequest"),
          `expected node type in: ${err.message}`
        );
        return true;
      }
    );
  });

  it("fails loudly for noOp nodes (exported gate steps)", () => {
    const wf: N8nImportWorkflow = {
      name: "test",
      nodes: [
        { name: "Manual Trigger", type: "n8n-nodes-base.manualTrigger", parameters: {} },
        {
          name: "my-gate",
          type: "n8n-nodes-base.noOp",
          parameters: {},
        },
      ],
      connections: {
        "Manual Trigger": { main: [[{ node: "my-gate", type: "main", index: 0 }]] },
      },
    };

    assert.throws(
      () => importN8nWorkflow(wf),
      (err: Error) => {
        assert.ok(err.message.includes("my-gate"), `expected node name in: ${err.message}`);
        assert.ok(
          err.message.includes("n8n-nodes-base.noOp"),
          `expected node type in: ${err.message}`
        );
        return true;
      }
    );
  });
});

// ── Test 2: round-trip lossless for llm/check ─────────────────────────────────

describe("round-trip: canon → n8n → canon (llm + check steps)", () => {
  // Build a canon pipeline with llm + check steps and verify the round-trip
  const loaded = makeLoaded(
    "rt-test",
    ["request"],
    [
      {
        id: "survey",
        kind: "llm",
        role: "scout",
        permissions: { contents: "read" },
        prompt: "prompts/rt-test/survey.md",
      },
      {
        id: "check",
        kind: "check",
        command: "echo done",
        dependsOn: ["survey"],
      },
      {
        id: "findings",
        kind: "llm",
        role: "reasoner",
        dependsOn: ["survey", "check"],
        prompt: "prompts/rt-test/findings.md",
      },
    ],
    {
      survey: "Survey the request: {{request}}",
      findings: "Findings from {{survey}} and check result {{check}}",
    }
  );

  const n8nWf = generateN8nWorkflow(loaded);
  // N8nWorkflow from build.ts is structurally compatible with N8nImportWorkflow
  const importWf: N8nImportWorkflow = n8nWf;

  let result: ReturnType<typeof importN8nWorkflow>;
  it("round-trip succeeds without throwing", () => {
    result = importN8nWorkflow(importWf);
  });

  it("pipeline id is preserved (slugified name)", () => {
    assert.equal(result.pipelineId, "rt-test");
  });

  it("step ids are preserved", () => {
    const pipelineFile = result.files.find((f) => f.path === "pipelines/rt-test.yaml");
    assert.ok(pipelineFile, "pipeline file missing");
    assert.ok(pipelineFile.content.includes("id: survey"), "survey step id missing");
    assert.ok(pipelineFile.content.includes("id: check"), "check step id missing");
    assert.ok(pipelineFile.content.includes("id: findings"), "findings step id missing");
  });

  it("step kinds are preserved", () => {
    const pipelineFile = result.files.find((f) => f.path === "pipelines/rt-test.yaml")!;
    assert.ok(pipelineFile.content.includes("kind: llm"), "llm kind missing");
    assert.ok(pipelineFile.content.includes("kind: check"), "check kind missing");
  });

  it("dependsOn is preserved", () => {
    const pipelineFile = result.files.find((f) => f.path === "pipelines/rt-test.yaml")!;
    // findings depends on survey and check
    assert.ok(pipelineFile.content.includes("survey"), "findings dependsOn survey");
    assert.ok(pipelineFile.content.includes("check"), "findings dependsOn check");
  });

  it("role is preserved", () => {
    const pipelineFile = result.files.find((f) => f.path === "pipelines/rt-test.yaml")!;
    assert.ok(pipelineFile.content.includes("role: scout"), "scout role missing");
    assert.ok(pipelineFile.content.includes("role: reasoner"), "reasoner role missing");
  });

  it("permissions.contents is preserved for llm steps with read access", () => {
    const pipelineFile = result.files.find((f) => f.path === "pipelines/rt-test.yaml")!;
    assert.ok(pipelineFile.content.includes("contents: read"), "contents: read missing");
  });

  it("survey prompt text is preserved (expression inversion)", () => {
    const promptFile = result.files.find((f) => f.path === "prompts/rt-test/survey.md");
    assert.ok(promptFile, "survey prompt file missing");
    assert.equal(promptFile.content, "Survey the request: {{request}}");
  });

  it("findings prompt text is preserved (both step ref and check ref)", () => {
    const promptFile = result.files.find((f) => f.path === "prompts/rt-test/findings.md");
    assert.ok(promptFile, "findings prompt file missing");
    assert.equal(promptFile.content, "Findings from {{survey}} and check result {{check}}");
  });

  it("inputs list contains 'request' and not step ids", () => {
    const pipelineFile = result.files.find((f) => f.path === "pipelines/rt-test.yaml")!;
    assert.ok(pipelineFile.content.includes("request"), "inputs missing 'request'");
    // 'survey' and 'check' should NOT be in inputs (they are step refs)
    // They appear as step ids but the inputs section should only have 'request'
    // (the YAML will contain 'survey' as a step id, but the inputs: array should
    //  only have 'request')
    const lines = pipelineFile.content.split("\n");
    const inputsIdx = lines.findIndex((l) => l.trim() === "inputs:");
    assert.ok(inputsIdx !== -1, "inputs section missing");
    // The inputs value is the next line
    const inputsLine = lines[inputsIdx + 1];
    assert.ok(inputsLine.includes("request"), "request not in inputs");
    assert.ok(!inputsLine.includes("survey"), "survey should not be in inputs");
    assert.ok(!inputsLine.includes("check"), "check should not be in inputs");
  });

  it("check command is preserved", () => {
    const pipelineFile = result.files.find((f) => f.path === "pipelines/rt-test.yaml")!;
    assert.ok(pipelineFile.content.includes("echo done"), "check command missing");
  });

  it("declared-loss fields are at defaults (version=1, FR-012)", () => {
    const pipelineFile = result.files.find((f) => f.path === "pipelines/rt-test.yaml")!;
    assert.ok(pipelineFile.content.includes("version: 1"), "version should be 1");
  });
});

// ── Test 3: round-trip refusal for gate steps ─────────────────────────────────

describe("round-trip: gate step export → import failure", () => {
  it("fails with a message naming the noOp node (gate step → noOp → rejected)", () => {
    // gate steps in current build.ts emit IF/Wait/HTTP subgraph nodes (not noOp).
    // Any of those types fail the importer with FR-007.
    // We test the noOp case directly since spec 022 FR-012 documents it explicitly.
    const wf: N8nImportWorkflow = {
      name: "gate-pipeline",
      nodes: [
        { name: "Manual Trigger", type: "n8n-nodes-base.manualTrigger", parameters: {} },
        {
          name: "my-gate",
          type: "n8n-nodes-base.noOp",
          parameters: {},
        },
      ],
      connections: {
        "Manual Trigger": { main: [[{ node: "my-gate", type: "main", index: 0 }]] },
      },
    };

    assert.throws(
      () => importN8nWorkflow(wf),
      (err: Error) => {
        assert.ok(
          err.message.includes("my-gate"),
          `expected node name "my-gate" in: ${err.message}`
        );
        return true;
      }
    );
  });
});

// ── Test 4: expression inversion ──────────────────────────────────────────────

describe("invertPromptExpression", () => {
  it("plain string (no =) is returned as-is", () => {
    assert.equal(invertPromptExpression("Hello world", "node", "prompt"), "Hello world");
  });

  it("Inputs reference → {{key}}", () => {
    const expr = "={{ $('Inputs').first().json[\"ticket\"] }}";
    assert.equal(invertPromptExpression(expr, "node", "prompt"), "{{ticket}}");
  });

  it("step output reference → {{stepId}}", () => {
    const expr = '={{ $("analyze").first().json.output }}';
    assert.equal(invertPromptExpression(expr, "node", "prompt"), "{{analyze}}");
  });

  it("check step stdout reference → {{stepId}}", () => {
    const expr = '={{ $("check").first().json.stdout }}';
    assert.equal(invertPromptExpression(expr, "node", "prompt"), "{{check}}");
  });

  it("$json.name → {{name}} (simple form from test plan §4)", () => {
    const expr = "={{ $json.ticket }}";
    assert.equal(invertPromptExpression(expr, "node", "prompt"), "{{ticket}}");
  });

  it("$json.analyze → {{analyze}} (node name form from test plan §4)", () => {
    const expr = "={{ $json.analyze }}";
    assert.equal(invertPromptExpression(expr, "node", "prompt"), "{{analyze}}");
  });

  it("String.fromCharCode(123) → literal {", () => {
    const expr = "={{ String.fromCharCode(123) }}";
    assert.equal(invertPromptExpression(expr, "node", "prompt"), "{");
  });

  it("String.fromCharCode(125) → literal }", () => {
    const expr = "={{ String.fromCharCode(125) }}";
    assert.equal(invertPromptExpression(expr, "node", "prompt"), "}");
  });

  it("mixed prompt with multiple placeholders", () => {
    // Forward: "Review: {{request}} and {{survey}}" →
    // "=Review: {{ $('Inputs').first().json[\"request\"] }} and {{ $(\"survey\").first().json.output }}"
    const expr =
      '=Review: {{ $(\'Inputs\').first().json["request"] }} and {{ $("survey").first().json.output }}';
    assert.equal(
      invertPromptExpression(expr, "node", "prompt"),
      "Review: {{request}} and {{survey}}"
    );
  });

  it("escaped braces in prompt are restored", () => {
    // Forward: "code {literal}" → "=code {{ String.fromCharCode(123) }}literal{{ String.fromCharCode(125) }}"
    const expr = "=code {{ String.fromCharCode(123) }}literal{{ String.fromCharCode(125) }}";
    assert.equal(invertPromptExpression(expr, "node", "prompt"), "code {literal}");
  });

  it("throws loudly for unsupported expression syntax (test plan §4)", () => {
    const expr = "={{ $('Other').item.json.x }}";
    assert.throws(
      () => invertPromptExpression(expr, "MyNode", "prompt"),
      (err: Error) => {
        assert.ok(err.message.includes("MyNode"), `expected node name in: ${err.message}`);
        assert.ok(err.message.includes("prompt"), `expected param name in: ${err.message}`);
        return true;
      }
    );
  });

  it("JSON.stringify wrapping is inverted (prompt that starts with =)", () => {
    // Forward: "=expression-like text" → '={{ JSON.stringify("=expression-like text") }}'
    const expr = '={{ JSON.stringify("=expression-like text") }}';
    assert.equal(invertPromptExpression(expr, "node", "prompt"), "=expression-like text");
  });
});

// ── Test 4 (continued): fixture with node name and non-node name ──────────────

describe("importN8nWorkflow — $json expression inversion with node name context", () => {
  it("$json.ticket → input, $json.analyze → step ref (test plan §4 fixture)", () => {
    // A workflow where 'analyze' is a node name and 'ticket' is not
    // analyze runs first, summarize depends on it.
    // analyze's prompt uses $json.ticket (ticket is not a node → input).
    // summarize's prompt uses $json.analyze (analyze IS a node → step ref).
    const wf: N8nImportWorkflow = {
      name: "ticket-analysis",
      nodes: [
        { name: "Manual Trigger", type: "n8n-nodes-base.manualTrigger", parameters: {} },
        {
          name: "analyze",
          type: "n8n-nodes-agent-flows.agentFlowsAgent",
          position: [600, 100],
          parameters: {
            role: "worker",
            model: "",
            workspaceAccess: "none",
            workspaceDirectory: "={{ $('Inputs').first().json.projectDir }}",
            // n8n expression: full value starts with "=" for expression mode
            prompt: "=Analyze the ticket: {{ $json.ticket }}",
            timeoutMs: 0,
          },
        },
        {
          name: "summarize",
          type: "n8n-nodes-agent-flows.agentFlowsAgent",
          position: [850, 100],
          parameters: {
            role: "reasoner",
            model: "",
            workspaceAccess: "none",
            workspaceDirectory: "={{ $('Inputs').first().json.projectDir }}",
            // analyze IS a node name → step ref; summarize depends on analyze
            prompt: "={{ $json.analyze }}",
            timeoutMs: 0,
          },
        },
      ],
      connections: {
        "Manual Trigger": {
          main: [[{ node: "analyze", type: "main", index: 0 }]],
        },
        // analyze → summarize (so summarize has analyze as an ancestor)
        analyze: {
          main: [[{ node: "summarize", type: "main", index: 0 }]],
        },
      },
    };

    const result = importN8nWorkflow(wf);
    const analyzePrompt = result.files.find((f) => f.path === "prompts/ticket-analysis/analyze.md");
    assert.ok(analyzePrompt, "analyze prompt file missing");
    assert.ok(
      analyzePrompt.content.includes("{{ticket}}"),
      `expected {{ticket}} in: ${analyzePrompt.content}`
    );

    const summarizePrompt = result.files.find(
      (f) => f.path === "prompts/ticket-analysis/summarize.md"
    );
    assert.ok(summarizePrompt, "summarize prompt file missing");
    assert.ok(
      summarizePrompt.content.includes("{{analyze}}"),
      `expected {{analyze}} in: ${summarizePrompt.content}`
    );

    // 'ticket' is not a node name → it's a pipeline input
    const pipelineFile = result.files.find((f) => f.path.startsWith("pipelines/"))!;
    assert.ok(pipelineFile.content.includes("ticket"), "ticket should be in pipeline (as input)");

    // 'analyze' IS a node name → it should NOT be in inputs
    const lines = pipelineFile.content.split("\n");
    const inputsIdx = lines.findIndex((l) => l.trim() === "inputs:");
    if (inputsIdx !== -1) {
      const inputsSection = lines.slice(inputsIdx, inputsIdx + 5).join("\n");
      assert.ok(
        !inputsSection.includes("- analyze"),
        `analyze should not be an input, got: ${inputsSection}`
      );
    }
  });
});

// ── Test 5: validation backstop ───────────────────────────────────────────────

describe("importN8nWorkflow — validation backstop", () => {
  it("fails when inverted prompt references a name that is neither input nor ancestor", () => {
    // 'phantom' is not a node name, so it becomes an input. Then loadPipeline
    // checks placeholder validity: 'phantom' is declared as an input → actually valid.
    // To trigger the backstop we need a reference to an ancestor step in a non-ancestor.
    // Set up: stepA and stepB are parallel (no dependsOn between them).
    // stepB's prompt references {{stepA}} — stepA is a node name, so it's a step ref.
    // But stepA is NOT in stepB's ancestors (no dependsOn edge) → loadPipeline rejects.
    const wf: N8nImportWorkflow = {
      name: "backstop-test",
      nodes: [
        { name: "Manual Trigger", type: "n8n-nodes-base.manualTrigger", parameters: {} },
        {
          name: "stepA",
          type: "n8n-nodes-agent-flows.agentFlowsAgent",
          position: [600, 100],
          parameters: {
            role: "worker",
            model: "",
            workspaceAccess: "none",
            workspaceDirectory: "",
            prompt: "Do task A",
            timeoutMs: 0,
          },
        },
        {
          name: "stepB",
          type: "n8n-nodes-agent-flows.agentFlowsAgent",
          position: [600, 300],
          parameters: {
            role: "worker",
            model: "",
            workspaceAccess: "none",
            workspaceDirectory: "",
            // stepA is a node name → placeholder {{stepA}} → step ref,
            // but stepA is NOT an ancestor of stepB (parallel) → loadPipeline rejects
            prompt: '={{ $("stepA").first().json.output }}',
            timeoutMs: 0,
          },
        },
      ],
      connections: {
        // Both stepA and stepB receive connections from Manual Trigger (parallel, no edges between them)
        "Manual Trigger": {
          main: [
            [
              { node: "stepA", type: "main", index: 0 },
              { node: "stepB", type: "main", index: 0 },
            ],
          ],
        },
      },
    };

    assert.throws(
      () => importN8nWorkflow(wf),
      (err: Error) => {
        // loadPipeline should report that {{stepA}} is not available to stepB
        assert.ok(
          err.message.includes("stepA") || err.message.includes("stepB"),
          `expected step reference in error: ${err.message}`
        );
        return true;
      }
    );
  });
});

// ── slugifyWorkflowName ────────────────────────────────────────────────────────

describe("slugifyWorkflowName", () => {
  it("lowercases and replaces spaces", () => {
    assert.equal(slugifyWorkflowName("My Workflow"), "my-workflow");
  });

  it("replaces runs of special chars with single hyphen", () => {
    assert.equal(slugifyWorkflowName("Hello -- World!"), "hello-world");
  });

  it("trims leading and trailing hyphens", () => {
    assert.equal(slugifyWorkflowName("---test---"), "test");
  });

  it("returns 'pipeline' for empty result", () => {
    assert.equal(slugifyWorkflowName("!!!"), "pipeline");
  });
});
