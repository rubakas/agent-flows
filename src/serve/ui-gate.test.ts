// Spec 043 V2/V3/V4 — the box a person decides from.
//
// The load-bearing assertions are the ones about telling the two summaries
// apart (D4) and about the material staying reachable (D6). A summary is model
// output about model output; if the page cannot say which text is which, or
// hides what the text is describing, it has made the gate less trustworthy than
// the bare question it replaced.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { gateBox, structuralSummary } from "./ui-gate.js";

const HOSTILE = '<img src=x onerror=alert(1)>"';

const SPEC = {
  title: "Pin one Node version",
  description: "Declare the version once and derive it everywhere else.",
  requirements: ["engines.node is the source", "the launcher reads it"],
  acceptanceCriteria: ["pnpm refuses a wrong Node"],
  weaknesses: [{ severity: "minor", title: "bootstrap.sh reads a file it may not have" }],
};

describe("gateBox — approve and reject are always reachable (FR-006)", () => {
  const cases: [string, { gateMessage: string; gateSummary?: string; spec?: unknown }][] = [
    ["a model summary", { gateMessage: "Approve?", gateSummary: "It pins Node.", spec: SPEC }],
    ["only a spec", { gateMessage: "Approve?", spec: SPEC }],
    ["neither", { gateMessage: "Commit all staged changes locally?" }],
  ];
  for (const [name, gate] of cases) {
    it(`offers both buttons with ${name}`, () => {
      const html = gateBox(gate);
      assert.ok(html.includes('id="btn-approve-run"'), html);
      assert.ok(html.includes('id="btn-reject-run"'), html);
      assert.ok(html.includes(gate.gateMessage), "the question is never dropped");
    });
  }
});

describe("gateBox — the two summaries are distinguishable (spec 043 D4, V2)", () => {
  it("says a model wrote the summary when one did", () => {
    const html = gateBox({ gateSummary: "It pins the Node version to 22.", spec: SPEC });
    assert.match(html, /written by a model/u, html);
    assert.ok(html.includes("It pins the Node version to 22."), html);
  });

  it("says the fields are the spec's own when no summary was produced", () => {
    const html = gateBox({ spec: SPEC });
    assert.match(html, /the spec's own fields/u, html);
    assert.ok(!html.includes("written by a model"), "nothing may claim a summary that is not one");
  });

  it("a model summary does not hide the fields — they move under the expander", () => {
    const html = gateBox({ gateSummary: "A paragraph.", spec: SPEC });
    assert.ok(html.includes("Pin one Node version"), `the title must survive: ${html}`);
  });
});

describe("gateBox — the material stays one click away (spec 043 D6, V3)", () => {
  it("carries every list of the spec, in full", () => {
    const html = gateBox({ gateSummary: "A paragraph.", spec: SPEC });
    assert.ok(html.includes("<details"), `it must be expandable, not gone: ${html}`);
    assert.ok(html.includes("engines.node is the source"), html);
    assert.ok(html.includes("pnpm refuses a wrong Node"), html);
    assert.ok(html.includes("bootstrap.sh reads a file it may not have"), html);
    assert.ok(html.includes("minor"), "a finding's severity travels with it");
  });

  it("with nothing attached, says what was looked for (FR-005)", () => {
    const html = gateBox({ gateMessage: "Commit all staged changes locally?", gateStepId: "ship" });
    assert.match(html, /no spec payload and no summary/u, html);
    assert.ok(html.includes("ship"), "the gate step is named");
    assert.ok(!html.includes("<details"), `an empty expander is worse than none: ${html}`);
  });
});

describe("gateBox — every field is untrusted (V4)", () => {
  it("escapes the summary, the question and every spec field", () => {
    const html = gateBox({
      gateMessage: HOSTILE,
      gateSummary: HOSTILE,
      gateStepId: HOSTILE,
      spec: {
        title: HOSTILE,
        description: HOSTILE,
        requirements: [HOSTILE],
        weaknesses: [{ severity: HOSTILE, title: HOSTILE, location: HOSTILE }],
      },
    });
    assert.ok(!html.includes("<img"), `raw markup must not reach the box: ${html}`);
    assert.ok(html.includes("&lt;img"), "it must still be readable as text");
  });
});

describe("structuralSummary", () => {
  it("counts only the lists that have something in them", () => {
    const html = structuralSummary(SPEC);
    assert.match(html, /2 requirements/u, html);
    assert.match(html, /1 acceptance criteria/u, html);
    assert.ok(!html.includes("security findings"), `an empty list is not a count: ${html}`);
  });

  it("is empty for a payload with nothing to say, so the caller can tell", () => {
    assert.equal(structuralSummary(undefined), "");
    assert.equal(structuralSummary("a string"), "");
    assert.equal(structuralSummary({}), "");
  });
});

describe("gateBox — the material is readable, not one escaped line per bullet", () => {
  const MARKDOWN =
    "## The check\n\n- it must run `pnpm lint`\n- and **fail** on a warning\n\n```sh\npnpm lint\n```";

  it("renders a markdown requirement as markup", () => {
    const html = gateBox({ spec: { requirements: [MARKDOWN] } });
    assert.ok(html.includes('<div class="md">'), `markdown must reach the renderer: ${html}`);
    assert.match(html, /<strong>fail<\/strong>/u, html);
    assert.match(html, /<code class="md-code">pnpm lint<\/code>/u, html);
    assert.ok(
      !html.includes("## The check"),
      `a heading rendered as its own source text is the defect: ${html}`
    );
  });

  it("wraps a plain multi-line requirement rather than flattening it", () => {
    const html = gateBox({ spec: { requirements: ["first line\nsecond line"] } });
    assert.ok(html.includes('<pre class="code-block">'), html);
    assert.ok(html.includes("first line\nsecond line"), html);
  });

  it("leaves a one-line requirement as text", () => {
    const html = gateBox({ spec: { requirements: ["engines.node is the source"] } });
    assert.ok(html.includes("<li>engines.node is the source</li>"), html);
  });

  it("keeps a Finding structured rather than turning it into prose", () => {
    const html = gateBox({
      spec: { weaknesses: [{ severity: "minor", title: "**bold** title", location: "a.ts:1" }] },
    });
    assert.ok(html.includes("minor — **bold** title — a.ts:1"), html);
    assert.ok(!html.includes("<strong>bold</strong>"), "a finding is three fields, not a blob");
  });

  it("escapes markdown that carries markup", () => {
    const html = gateBox({
      spec: {
        description: `# ${HOSTILE}`,
        requirements: [`- ${HOSTILE}`, `**${HOSTILE}**`],
      },
    });
    assert.ok(!html.includes("<img"), `the renderer must escape before it marks up: ${html}`);
    assert.ok(html.includes("&lt;img"), html);
  });
});

// A revision step publishes the finished document as a plain string, so the
// spec the gate is handed is markdown and not a HardenedSpec. These fail
// against the previous box: structuralSummary returns "" for a string, so the
// person was shown "nothing was attached to this gate to describe" while the
// document they were approving sat in the payload.
describe("gateBox — a spec that is a finished document (string)", () => {
  const DOCUMENT =
    "# Feature T\n\n## Requirements\n\n- it must run `pnpm lint`\n- and **fail** on a warning\n";

  it("renders the document as markdown instead of claiming nothing was attached", () => {
    const html = gateBox({ gateMessage: "Approve?", spec: DOCUMENT, gateStepId: "approve" });
    assert.ok(html.includes('<div class="md">'), `the document must be rendered: ${html}`);
    assert.match(html, /<strong>fail<\/strong>/u, html);
    assert.match(html, /<code class="md-code">pnpm lint<\/code>/u, html);
    assert.ok(
      !html.includes("no spec payload and no summary"),
      `the document IS the payload: ${html}`
    );
    assert.ok(
      !html.includes("# Feature T"),
      `a heading left as source text is the defect: ${html}`
    );
  });

  it("keeps the document one click away when a model summary takes the body", () => {
    const html = gateBox({ gateSummary: "It resolves every finding.", spec: DOCUMENT });
    assert.match(html, /written by a model/u, html);
    assert.ok(html.includes("<details"), `the material must stay reachable: ${html}`);
    assert.match(html, /<strong>fail<\/strong>/u, "the document travels into the expander");
  });

  it("escapes a hostile document", () => {
    const html = gateBox({ spec: `# ${HOSTILE}\n\n- ${HOSTILE}\n` });
    assert.ok(!html.includes("<img"), `the renderer must escape before it marks up: ${html}`);
    assert.ok(html.includes("&lt;img"), html);
  });

  it("an object spec is shown exactly as before", () => {
    const html = gateBox({ gateMessage: "Approve?", spec: SPEC });
    assert.match(html, /the spec's own fields/u, html);
    assert.ok(html.includes("Pin one Node version"), html);
    assert.ok(html.includes("engines.node is the source"), html);
  });

  it("a blank string is no payload at all", () => {
    const html = gateBox({ gateMessage: "Approve?", spec: "   ", gateStepId: "approve" });
    assert.match(html, /no spec payload and no summary/u, html);
    assert.ok(!html.includes("<details"), `an empty expander is worse than none: ${html}`);
  });
});
