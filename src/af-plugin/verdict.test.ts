// The computed merge verdict (spec 049). `check.mjs verdict <runDir>` reads the verified
// findings and the engine's coverage and prints the one line the report leads with, so the
// verdict is code over data and not a sentence a model chose to write.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

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

type Obj = Record<string, unknown>;

const AXES = ["falsifiability", "correctness", "security", "radius", "delivery"];

function finding(overrides: Obj = {}): Obj {
  return {
    claim: "the guard is skipped when the lot is nil",
    file: "app/models/lot.rb",
    line: 12,
    quote: "return unless lot",
    verdict: "CONFIRMED",
    citationAccurate: true,
    evidenceBasis: "file-content",
    remedyScope: "single-site",
    sites: [],
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
    correctedWording: "",
    ...overrides,
  };
}

function unverifiable(overrides: Obj = {}): Obj {
  return finding({ verdict: "UNVERIFIABLE", evidenceBasis: "none", ...overrides });
}

const fullCoverage = { ran: AXES, failed: [], skipped: [] };

describe("check.mjs verdict (spec 049)", () => {
  const root = mkdtempSync(join(tmpdir(), "af-verdict-"));
  after(() => rmSync(root, { recursive: true, force: true }));
  let counter = 0;

  /** A fresh run dir; a null part is left unwritten. */
  function runDir(verify: unknown, coverage: unknown = fullCoverage): string {
    const dir = join(root, `run${String(counter++)}`);
    mkdirSync(join(dir, "out"), { recursive: true });
    const text = (value: unknown) => (typeof value === "string" ? value : JSON.stringify(value));
    if (verify !== null) writeFileSync(join(dir, "out", "verify.json"), text(verify));
    if (coverage !== null) writeFileSync(join(dir, "out", "coverage.json"), text(coverage));
    return dir;
  }
  const verdict = (dir: string) =>
    spawnSync(process.execPath, [checkScript, "verdict", dir], { encoding: "utf8" });
  const withFindings = (...entries: Obj[]) => ({ codeReviewFindings: entries });

  /** Runs the subcommand, asserts it established a verdict, and returns the line. */
  function established(dir: string): string {
    const result = verdict(dir);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(result.stdout.endsWith("\n"), true);
    assert.equal(result.stdout.trimEnd().includes("\n"), false, "the verdict is one line");
    return result.stdout.trimEnd();
  }

  function notEstablished(dir: string): string {
    const result = verdict(dir);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /^Verdict not established: /);
    return result.stdout;
  }

  describe("blocks", () => {
    it("an introduced CONFIRMED major defect is not ready (1 major)", () => {
      const line = established(runDir(withFindings(finding())));
      assert.match(line, /^Not ready to merge: 0 blocking and 1 major finding\(s\) introduced/);
    });

    it("two blocking defects, one PARTIAL, say 2 blocking", () => {
      const line = established(
        runDir(
          withFindings(
            finding({ severity: "blocking" }),
            finding({ severity: "blocking", verdict: "PARTIAL" })
          )
        )
      );
      assert.match(line, /^Not ready to merge: 2 blocking and 0 major finding\(s\)/);
    });

    it("an undetermined scope fails closed", () => {
      const line = established(runDir(withFindings(finding({ scope: "undetermined" }))));
      assert.match(line, /^Not ready to merge: 0 blocking and 1 major/);
    });

    it("a failed axis plus a major is still not ready, and says what was not examined", () => {
      const coverage = {
        ran: ["falsifiability", "correctness", "radius", "delivery"],
        failed: [{ step: "security", reason: "the step returned no output" }],
        skipped: [],
      };
      const line = established(runDir(withFindings(finding()), coverage));
      assert.match(line, /^Not ready to merge: 0 blocking and 1 major/);
      assert.match(line, /Not examined: security \(the step returned no output\)\./);
    });
  });

  describe("does not block", () => {
    it("a pre-existing major alone is ready, and is named", () => {
      const line = established(runDir(withFindings(finding({ scope: "pre-existing" }))));
      assert.match(line, /^Ready to merge: no blocking or major defect introduced/);
      assert.match(line, /1 pre-existing blocking\/major finding\(s\) not introduced/);
    });

    it("a business-decision major is ready, and is a question for owners", () => {
      const line = established(runDir(withFindings(finding({ kind: "business-decision" }))));
      assert.match(line, /^Ready to merge:/);
      assert.match(line, /1 question\(s\) for owners/);
    });

    it("an external-confirmation blocking is a question, not a block", () => {
      const line = established(
        runDir(withFindings(finding({ kind: "external-confirmation", severity: "blocking" })))
      );
      assert.match(line, /^Ready to merge:/);
      assert.match(line, /1 question\(s\) for owners/);
    });

    it("a DECLINED major counts for nothing", () => {
      const line = established(runDir(withFindings(finding({ verdict: "DECLINED" }))));
      assert.match(line, /^Ready to merge:/);
      assert.doesNotMatch(line, /pre-existing|question/);
    });

    it("minor findings are counted, never blocking", () => {
      const line = established(runDir(withFindings(finding({ severity: "minor" }))));
      assert.match(line, /^Ready to merge:/);
      assert.match(line, /1 minor finding\(s\)/);
    });

    it("empty findings with full coverage is ready and names every axis that ran", () => {
      const line = established(runDir(withFindings()));
      assert.match(line, /^Ready to merge: no blocking or major defect introduced; examined /);
      for (const axis of AXES) assert.ok(line.includes(axis), `${axis} missing from: ${line}`);
      assert.doesNotMatch(line, /minor|pre-existing|question|not checked/);
    });

    it("a skipped delivery is ready, naming delivery as not checked and why", () => {
      const coverage = {
        ran: ["falsifiability", "correctness", "security", "radius"],
        failed: [],
        skipped: [{ step: "delivery", reason: "no spec sources" }],
      };
      const line = established(runDir(withFindings(), coverage));
      assert.match(line, /^Ready to merge:/);
      assert.match(line, /delivery not checked: no spec sources/);
      assert.doesNotMatch(line, /examined[^;]*delivery/);
    });
  });

  describe("readiness not established", () => {
    it("an UNVERIFIABLE introduced major cannot be called ready", () => {
      const line = established(runDir(withFindings(unverifiable())));
      assert.match(
        line,
        /^Readiness not established: 1 blocking or major claim\(s\) could not be verified\./
      );
    });

    it("an UNVERIFIABLE pre-existing major does not unsettle it", () => {
      const line = established(runDir(withFindings(unverifiable({ scope: "pre-existing" }))));
      assert.match(line, /^Ready to merge:/);
    });

    it("an UNVERIFIABLE minor (the unavailable-step entry) does not unsettle it", () => {
      const line = established(runDir(withFindings(unverifiable({ severity: "minor" }))));
      assert.match(line, /^Ready to merge:/);
    });

    it("a failed axis names the step and the reason", () => {
      const coverage = {
        ran: ["falsifiability", "correctness", "radius", "delivery"],
        failed: [{ step: "security", reason: "schema still invalid after 5 attempts" }],
        skipped: [],
      };
      const line = established(runDir(withFindings(), coverage));
      assert.equal(
        line,
        "Readiness not established: security did not run (schema still invalid after 5 attempts)."
      );
    });

    it("several failed axes are all named, and a multi-line reason stays on one line", () => {
      const coverage = {
        ran: ["falsifiability", "radius", "delivery"],
        failed: [
          { step: "security", reason: "boom\nsecond line" },
          { step: "correctness", reason: "timed out" },
        ],
        skipped: [],
      };
      const line = established(runDir(withFindings(), coverage));
      assert.match(line, /^Readiness not established: security did not run \(boom second line\)/);
      assert.match(line, /correctness did not run \(timed out\)\.$/);
    });

    it("a failed axis outranks an unverifiable major", () => {
      const coverage = {
        ran: ["falsifiability", "correctness", "radius", "delivery"],
        failed: [{ step: "security", reason: "x" }],
        skipped: [],
      };
      const line = established(runDir(withFindings(unverifiable()), coverage));
      assert.match(line, /^Readiness not established: security did not run/);
    });
  });

  describe("refuses", () => {
    it("a missing coverage.json", () => {
      assert.match(notEstablished(runDir(withFindings(), null)), /coverage\.json/);
    });

    it("an unparseable coverage.json", () => {
      assert.match(notEstablished(runDir(withFindings(), "{nope")), /coverage\.json/);
    });

    it("coverage naming an unknown step", () => {
      const coverage = { ran: [...AXES, "brief"], failed: [], skipped: [] };
      assert.match(notEstablished(runDir(withFindings(), coverage)), /brief/);
    });

    it("coverage that drops an axis, which would read as a clean one", () => {
      const coverage = { ran: AXES.slice(1), failed: [], skipped: [] };
      assert.match(notEstablished(runDir(withFindings(), coverage)), /falsifiability/);
    });

    it("coverage with a malformed failed entry", () => {
      const coverage = { ran: AXES.slice(1), failed: [{ step: "falsifiability" }], skipped: [] };
      notEstablished(runDir(withFindings(), coverage));
    });

    it("a missing verify.json", () => {
      assert.match(notEstablished(runDir(null)), /verify\.json/);
    });

    it("a verify.json that is not JSON (a fenced block)", () => {
      notEstablished(runDir("```json\n{}\n```"));
    });

    it("a verify.json that breaks the schema", () => {
      const bad = withFindings(finding({ evidenceBasis: "commit-message" }));
      assert.match(notEstablished(runDir(bad)), /verify\.json/);
    });

    it("a verify.json with a severity outside the enum", () => {
      notEstablished(runDir(withFindings(finding({ severity: "critical" }))));
    });

    it("exits 2 on stderr for a usage error", () => {
      for (const args of [["verdict"], ["verdict", "a", "b"]]) {
        const result = spawnSync(process.execPath, [checkScript, ...args], { encoding: "utf8" });
        assert.equal(result.status, 2);
        assert.match(result.stderr, /usage.*verdict/);
        assert.equal(result.stdout, "");
      }
    });
  });

  it("writes out/verdict.txt equal to the line it prints", () => {
    const dir = runDir(withFindings(finding()));
    const line = established(dir);
    assert.equal(readFileSync(join(dir, "out", "verdict.txt"), "utf8"), line + "\n");
  });

  it("writes no verdict.txt when the verdict is not established", () => {
    const dir = runDir(withFindings(), null);
    notEstablished(dir);
    assert.throws(() => readFileSync(join(dir, "out", "verdict.txt"), "utf8"), /ENOENT/);
  });
});

describe("the procedures run the verdict (spec 049 D6)", () => {
  const skillDir = join(dirname(checkScript), "..");
  const skill = readFileSync(join(skillDir, "SKILL.md"), "utf8");
  const codex = readFileSync(join(skillDir, "references", "codex.md"), "utf8");

  it("SKILL.md runs check.mjs verdict on the run dir", () => {
    assert.ok(skill.includes("check.mjs' verdict '<runDir>'"));
  });

  it("SKILL.md writes the engine's coverage to out/coverage.json, verbatim", () => {
    assert.match(skill, /`coverage` object VERBATIM to `<runDir>\/out\/coverage\.json`/);
  });

  it("SKILL.md leads the report and the answer with the computed line", () => {
    const report = skill.slice(skill.indexOf("## 4. Report"), skill.indexOf("## 5. Answer"));
    assert.ok(report.includes("out/verdict.txt"), "the report step must take the line from there");
    assert.ok(
      report.indexOf("verdict.txt") < report.indexOf("The synthesis, exactly as produced"),
      "the computed line comes before the synthesis"
    );
    const answer = skill.slice(skill.indexOf("## 5. Answer"));
    assert.match(answer, /computed verdict line verbatim first/);
    assert.match(answer, /authoritative/);
  });

  it("codex.md has the lead write out/coverage.json before SKILL.md step 3", () => {
    assert.ok(codex.includes("<runDir>/out/coverage.json"));
    assert.match(codex, /Write nothing else into the file/);
  });
});
