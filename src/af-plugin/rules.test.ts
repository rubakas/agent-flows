// Rule parity (spec 046 FR-6). The plugin cannot call af's validateCanonOutput, so the
// eight cross-field rules live in the plugin's JSON schemas as if/then and pattern; they are
// owned by src/canon/schemaRules.ts and generated into the plugin. Three
// validators must agree on every case here: af's own, ajv on the plugin schemas (what
// Claude's structured output enforces) and check.mjs (what Codex runs).

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Ajv } from "ajv";

import { validateCanonOutput } from "../canon/validateOutput.js";

const checkScript = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "plugin",
  "skills",
  "review",
  "scripts",
  "check.mjs"
);

// check.mjs is plain JavaScript outside tsconfig's program: load it by a computed specifier
// and describe it here, so no declaration file has to ship inside the plugin.
const { loadSchema, validate } = (await import(pathToFileURL(checkScript).href)) as {
  loadSchema: (name: string) => Record<string, unknown>;
  validate: (schema: unknown, value: unknown) => string[];
};

// Same options as src/canon/validateOutput.ts.
const ajv = new Ajv({ allErrors: true, verbose: true, allowUnionTypes: true });
const plugin = {
  codeReviewFindings: ajv.compile(loadSchema("findings")),
  codeReviewDelivery: ajv.compile(loadSchema("delivery")),
};
const schemaFile = {
  codeReviewFindings: "findings",
  codeReviewDelivery: "delivery",
} as const;

type Key = keyof typeof plugin;
type Obj = Record<string, unknown>;

interface Case {
  name: string;
  key: Key;
  value: unknown;
  valid: boolean;
}

function site(overrides: Obj = {}): Obj {
  return {
    file: "app/models/lot.rb",
    line: 12,
    remedySafe: true,
    remedyNote: "guard is present",
    ...overrides,
  };
}

function finding(overrides: Obj = {}): Obj {
  return {
    claim: "the guard is skipped when the lot is nil",
    file: "app/models/lot.rb",
    line: 12,
    quote: "return unless lot",
    verdict: "CONFIRMED",
    citationAccurate: true,
    evidenceBasis: "file-content",
    remedyScope: "all-sites-verified",
    sites: [site(), site({ file: "app/models/bid.rb", line: "40" })],
    scope: "introduced",
    kind: "defect",
    severity: "major",
    severityRationale: "reachable from the public endpoint",
    probes: {
      guard: "none found",
      reachability: "routes.rb:10",
      remedy: "add the guard",
      callers: "two callers",
      scope: "diff adds the line",
    },
    correctedWording: "the guard is skipped when lot is nil",
    ...overrides,
  };
}

function findings(overrides: Obj = {}): Obj {
  return { codeReviewFindings: [finding(overrides)] };
}

function entry(overrides: Obj = {}): Obj {
  return {
    requirement: "Bids close at the lot deadline",
    source: "issue #12",
    classification: "implemented",
    evidence: "app/models/lot.rb:42 closes the bid window",
    ...overrides,
  };
}

function delivery(entries: Obj[], provided = true): Obj {
  return { specSourcesProvided: provided, codeReviewDelivery: entries };
}

const silent = {
  classification: "silently-decided",
  decisionTaken: "closes bids at midnight UTC",
  optionsForeclosed: "per-lot timezones",
};

const cases: Case[] = [
  { name: "valid findings", key: "codeReviewFindings", value: findings(), valid: true },
  {
    name: "valid findings, single-site with one site",
    key: "codeReviewFindings",
    value: findings({ remedyScope: "single-site", sites: [site()] }),
    valid: true,
  },
  {
    name: "valid findings, sites-differ with an unsafe site",
    key: "codeReviewFindings",
    value: findings({ remedyScope: "sites-differ", sites: [site(), site({ remedySafe: false })] }),
    valid: true,
  },
  {
    name: "valid findings, PARTIAL on a commit message",
    key: "codeReviewFindings",
    value: findings({ verdict: "PARTIAL", evidenceBasis: "commit-message" }),
    valid: true,
  },
  {
    name: "valid findings, empty list",
    key: "codeReviewFindings",
    value: { codeReviewFindings: [] },
    valid: true,
  },
  {
    name: "rule 1: CONFIRMED on a commit message",
    key: "codeReviewFindings",
    value: findings({ evidenceBasis: "commit-message" }),
    valid: false,
  },
  {
    name: "rule 2: all-sites-verified with an unsafe site",
    key: "codeReviewFindings",
    value: findings({ sites: [site(), site({ remedySafe: false })] }),
    valid: false,
  },
  {
    name: "rule 3: single-site naming two sites",
    key: "codeReviewFindings",
    value: findings({ remedyScope: "single-site" }),
    valid: false,
  },
  {
    name: "findings: missing required field",
    key: "codeReviewFindings",
    value: { codeReviewFindings: [(({ quote: _quote, ...rest }) => rest)(finding())] },
    valid: false,
  },
  {
    name: "findings: unexpected field",
    key: "codeReviewFindings",
    value: findings({ extra: true }),
    valid: false,
  },
  {
    name: "findings: line as an object",
    key: "codeReviewFindings",
    value: findings({ line: { n: 12 } }),
    valid: false,
  },
  {
    name: "findings: bad enum",
    key: "codeReviewFindings",
    value: findings({ severity: "moderate" }),
    valid: false,
  },
  {
    name: "findings: wrong type",
    key: "codeReviewFindings",
    value: findings({ citationAccurate: "yes" }),
    valid: false,
  },
  {
    name: "valid delivery",
    key: "codeReviewDelivery",
    value: delivery([
      entry(),
      entry({ classification: "partial", evidence: "lot.rb:42" }),
      entry({ ...silent, evidence: "nothing" }),
      entry({ classification: "correctly-deferred", evidence: "n/a" }),
      entry({ classification: "not-implemented", evidence: "no file touches it" }),
    ]),
    valid: true,
  },
  {
    name: "valid delivery, no spec sources and no entries",
    key: "codeReviewDelivery",
    value: delivery([], false),
    valid: true,
  },
  {
    name: "valid delivery, decision wording with two inner spaces is a decision to af",
    key: "codeReviewDelivery",
    value: delivery([entry({ ...silent, decisionTaken: "not  a decision" })]),
    valid: true,
  },
  {
    name: "valid delivery, 'Not a decision, but ...' names a decision",
    key: "codeReviewDelivery",
    value: delivery([entry({ ...silent, decisionTaken: "Not a decision, but a default: UTC" })]),
    valid: true,
  },
  {
    name: "rule 4: no spec sources but an entry",
    key: "codeReviewDelivery",
    value: delivery([entry()], false),
    valid: false,
  },
  {
    name: "rule 5: silently-decided with decisionTaken missing",
    key: "codeReviewDelivery",
    value: delivery([entry({ ...silent, decisionTaken: undefined })]),
    valid: false,
  },
  {
    name: "rule 5: silently-decided with a blank decisionTaken",
    key: "codeReviewDelivery",
    value: delivery([entry({ ...silent, decisionTaken: "   " })]),
    valid: false,
  },
  {
    name: "rule 5: silently-decided with decisionTaken 'NOT A DECISION'",
    key: "codeReviewDelivery",
    value: delivery([entry({ ...silent, decisionTaken: " NOT A DECISION " })]),
    valid: false,
  },
  {
    name: "rule 5: silently-decided with decisionTaken null",
    key: "codeReviewDelivery",
    value: delivery([entry({ ...silent, decisionTaken: null })]),
    valid: false,
  },
  {
    name: "rule 6: silently-decided with optionsForeclosed missing",
    key: "codeReviewDelivery",
    value: delivery([entry({ ...silent, optionsForeclosed: undefined })]),
    valid: false,
  },
  {
    name: "rule 6: silently-decided with optionsForeclosed 'Not A Decision'",
    key: "codeReviewDelivery",
    value: delivery([entry({ ...silent, optionsForeclosed: "Not A Decision" })]),
    valid: false,
  },
  {
    name: "rule 7: implemented citing no file",
    key: "codeReviewDelivery",
    value: delivery([entry({ evidence: "the service already does this" })]),
    valid: false,
  },
  {
    name: "rule 7: partial whose only file-like token is 'e.g.'",
    key: "codeReviewDelivery",
    value: delivery([entry({ classification: "partial", evidence: "e.g. the lot service" })]),
    valid: false,
  },
  {
    name: "rule 8: correctly-deferred with a blank requirement",
    key: "codeReviewDelivery",
    value: delivery([entry({ classification: "correctly-deferred", requirement: "  " })]),
    valid: false,
  },
  {
    name: "delivery: missing required evidence",
    key: "codeReviewDelivery",
    value: delivery([entry({ evidence: undefined })]),
    valid: false,
  },
  {
    name: "delivery: bad classification",
    key: "codeReviewDelivery",
    value: delivery([entry({ classification: "done" })]),
    valid: false,
  },
  {
    name: "delivery: missing specSourcesProvided",
    key: "codeReviewDelivery",
    value: { codeReviewDelivery: [] },
    valid: false,
  },
];

// undefined means "absent": drop the key so JSON and the validators see no property.
const clean = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

/** A distinctive phrase from each rule's own description in the plugin schemas. */
const RULE_TEXT: Record<number, string> = {
  1: "verdict CONFIRMED needs evidenceBasis",
  2: "remedyScope all-sites-verified requires every",
  3: "remedyScope single-site allows",
  4: "specSourcesProvided false means",
  5: "silently-decided needs decisionTaken",
  6: "silently-decided needs optionsForeclosed",
  7: "implemented or partial needs evidence",
  8: "correctly-deferred needs requirement",
};

describe("plugin schemas agree with af's validateCanonOutput", () => {
  for (const testCase of cases) {
    it(`${testCase.valid ? "accepts" : "rejects"}: ${testCase.name}`, () => {
      const value = clean(testCase.value);
      const af = validateCanonOutput(testCase.key, value) === undefined;
      const viaAjv = plugin[testCase.key](value);
      const viaCheck = validate(loadSchema(schemaFile[testCase.key]), value).length === 0;
      assert.deepEqual(
        { af, ajv: viaAjv, check: viaCheck },
        { af: testCase.valid, ajv: testCase.valid, check: testCase.valid }
      );
    });
  }

  for (const testCase of cases.filter((c) => /^rule \d:/.test(c.name))) {
    it(`check.mjs names the broken rule: ${testCase.name}`, () => {
      const rule = Number(/^rule (\d):/.exec(testCase.name)![1]);
      const errors = validate(loadSchema(schemaFile[testCase.key]), clean(testCase.value));
      assert.ok(
        errors.some((line) => line.includes(`Rule: `) && line.includes(RULE_TEXT[rule])),
        `no error line carries rule ${String(rule)}'s description:\n${errors.join("\n")}`
      );
    });
  }

  it("covers all eight rules, each with a rejecting mutation", () => {
    for (let rule = 1; rule <= 8; rule++) {
      assert.ok(
        cases.some((c) => !c.valid && c.name.startsWith(`rule ${String(rule)}:`)),
        `no mutation for rule ${String(rule)}`
      );
    }
  });
});

describe("check.mjs", () => {
  it("throws on a schema keyword it does not implement", () => {
    assert.throws(() => validate({ type: "object", minProperties: 1 }, {}), /minProperties/);
  });

  it("throws on an unsupported keyword inside a branch that never fires", () => {
    const schema = {
      type: "object",
      if: { required: ["a"] },
      then: { properties: { b: { type: "string", format: "date" } } },
    };
    assert.throws(() => validate(schema, {}), /format/);
  });

  describe("CLI", () => {
    const dir = mkdtempSync(join(tmpdir(), "af-check-"));

    function run(...args: string[]) {
      return spawnSync(process.execPath, [checkScript, ...args], { encoding: "utf8" });
    }
    function file(name: string, content: string): string {
      const path = join(dir, name);
      writeFileSync(path, content);
      return path;
    }

    it("exits 0 on a valid file and prints nothing", () => {
      const result = run("findings", file("ok.json", JSON.stringify(findings())));
      assert.equal(result.status, 0);
      assert.equal(result.stdout, "");
    });

    it("exits 1 and prints path: message lines on an invalid file", () => {
      const bad = findings({ evidenceBasis: "commit-message" });
      const result = run("findings", file("bad.json", JSON.stringify(bad)));
      assert.equal(result.status, 1);
      assert.match(result.stdout, /^\/codeReviewFindings\/0: Rule: verdict CONFIRMED needs/m);
    });

    it("delivery: exits 1 naming the rule for specSourcesProvided false with entries", () => {
      const bad = delivery([entry()], false);
      const result = run("delivery", file("delivery-bad.json", JSON.stringify(bad)));
      assert.equal(result.status, 1);
      assert.match(result.stdout, /Rule: specSourcesProvided false means/);
    });

    it("delivery: exits 0 for false with no entries and for true with valid entries", () => {
      for (const ok of [
        delivery([], false),
        delivery([entry()]),
        delivery([entry(), entry(silent)]),
      ]) {
        const result = run("delivery", file("delivery-ok.json", JSON.stringify(ok)));
        assert.equal(result.status, 0, result.stdout);
        assert.equal(result.stdout, "");
      }
    });

    it("exits 2, on stderr, only for usage errors", () => {
      for (const result of [
        run(),
        run("nonsense", file("a.json", "{}")),
        run("findings"),
        run("findings", "a.json", "extra"),
      ]) {
        assert.equal(result.status, 2);
        assert.match(result.stderr, /usage/);
        assert.equal(result.stdout, "");
      }
    });

    it("exits 1 with a readable stdout line for a missing file", () => {
      const result = run("findings", join(dir, "missing.json"));
      assert.equal(result.status, 1);
      assert.match(result.stdout, /missing\.json is not a readable bare JSON object/);
    });

    it("exits 1 for fenced or unparseable JSON", () => {
      const fenced = "```json\n" + JSON.stringify(findings()) + "\n```\n";
      for (const content of [fenced, "{not json", ""]) {
        const result = run("findings", file("bad-text.json", content));
        assert.equal(result.status, 1);
        assert.match(result.stdout, /not a readable bare JSON object \(no code fences, no prose\)/);
      }
    });

    it("cleanup", () => {
      rmSync(dir, { recursive: true, force: true });
    });
  });
});
