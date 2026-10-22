// The computed merge verdict (spec 049). `check.mjs verdict <runDir>` reads the verified
// findings and the engine's coverage and prints the one line the report leads with, so the
// verdict is code over data and not a sentence a model chose to write.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
const validDelivery = { specSourcesProvided: true, codeReviewDelivery: [] };
const ESC = String.fromCharCode(27);

describe("check.mjs verdict (spec 049)", () => {
  const root = mkdtempSync(join(tmpdir(), "af-verdict-"));
  after(() => rmSync(root, { recursive: true, force: true }));
  let counter = 0;

  /** A fresh run dir; a null part is left unwritten. */
  function runDir(
    verify: unknown,
    coverage: unknown = fullCoverage,
    delivery: unknown = validDelivery
  ): string {
    const dir = join(root, `run${String(counter++)}`);
    mkdirSync(join(dir, "out"), { recursive: true });
    const text = (value: unknown) => (typeof value === "string" ? value : JSON.stringify(value));
    if (verify !== null) writeFileSync(join(dir, "out", "verify.json"), text(verify));
    if (coverage !== null) writeFileSync(join(dir, "out", "coverage.json"), text(coverage));
    if (delivery !== null) writeFileSync(join(dir, "out", "delivery.json"), text(delivery));
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

  describe("delivery output is checked, not trusted (spec 049 review)", () => {
    const ranWithoutDelivery = AXES.slice(0, 4);
    const deliveryFailed = "out/delivery.json is missing or breaks the delivery schema";
    const disagrees = "coverage says delivery ran but out/delivery.json reports no spec sources";

    it("a valid delivery.json with entries leaves delivery examined", () => {
      const delivery = {
        specSourcesProvided: true,
        codeReviewDelivery: [
          {
            requirement: "Bids close at the lot deadline",
            source: "issue #12",
            classification: "implemented",
            evidence: "app/models/lot.rb:42 closes the bid window",
          },
        ],
      };
      const line = established(runDir(withFindings(), fullCoverage, delivery));
      assert.match(line, /^Ready to merge:.*examined [^;]*delivery/);
    });

    it("a delivery.json that breaks its schema while delivery ran is not established", () => {
      const bad = { specSourcesProvided: false, codeReviewDelivery: [{ requirement: "x" }] };
      assert.equal(
        established(runDir(withFindings(), fullCoverage, bad)),
        `Readiness not established: delivery output did not pass its check (${deliveryFailed}).`
      );
    });

    it("a missing delivery.json while delivery ran is not established", () => {
      assert.equal(
        established(runDir(withFindings(), fullCoverage, null)),
        `Readiness not established: delivery output did not pass its check (${deliveryFailed}).`
      );
    });

    it("an unparseable delivery.json while delivery ran is not established", () => {
      const line = established(runDir(withFindings(), fullCoverage, "```json\n{}\n```"));
      assert.match(line, /^Readiness not established: delivery output did not pass its check/);
    });

    it("coverage saying delivery ran while delivery.json says no spec sources fails closed", () => {
      const contradiction = { specSourcesProvided: false, codeReviewDelivery: [] };
      assert.equal(
        established(runDir(withFindings(), fullCoverage, contradiction)),
        `Readiness not established: delivery output did not pass its check (${disagrees}).`
      );
      const heavy = established(runDir(withFindings(finding()), fullCoverage, contradiction));
      assert.ok(heavy.endsWith(` Not examined: delivery (${disagrees}).`), heavy);
    });

    it("the failed-delivery line never claims the step did not run", () => {
      const line = established(runDir(withFindings(), fullCoverage, null));
      assert.doesNotMatch(line, /did not run/);
    });

    it("a step that really did not run still says so", () => {
      const coverage = {
        ran: AXES.slice(1),
        failed: [{ step: "falsifiability", reason: "timed out" }],
        skipped: [],
      };
      assert.match(established(runDir(withFindings(), coverage)), /falsifiability did not run/);
    });

    it("a failed delivery check plus a major is Not ready with the Not examined clause", () => {
      const line = established(runDir(withFindings(finding()), fullCoverage, null));
      assert.match(line, /^Not ready to merge: 0 blocking and 1 major/);
      assert.ok(line.endsWith(` Not examined: delivery (${deliveryFailed}).`), line);
    });

    it("a delivery.json is not read when delivery was skipped", () => {
      const coverage = {
        ran: ranWithoutDelivery,
        failed: [],
        skipped: [{ step: "delivery", reason: "no spec sources" }],
      };
      const line = established(runDir(withFindings(), coverage, "garbage"));
      assert.match(line, /^Ready to merge:.*delivery not checked: no spec sources/);
    });
  });

  describe("output is one printable line", () => {
    it("an ESC byte in a coverage reason never reaches stdout or verdict.txt", () => {
      const coverage = {
        ran: AXES.slice(1),
        failed: [{ step: "falsifiability", reason: `died ${ESC}[31mred\u007f${ESC}[0m` }],
        skipped: [],
      };
      const dir = runDir(withFindings(), coverage);
      const line = established(dir);
      const control = [...line].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127);
      assert.equal(control, false, JSON.stringify(line));
      assert.match(line, /died \[31mred/);
      assert.equal(readFileSync(join(dir, "out", "verdict.txt"), "utf8").includes(ESC), false);
    });

    it("an ESC byte in an unexpected key of a finding never reaches the refusal", () => {
      const bad = withFindings({ ...finding(), [`${ESC}[31mevil`]: 1 });
      const out = notEstablished(runDir(bad));
      assert.equal(out.includes(ESC), false, JSON.stringify(out));
      assert.match(out, /unexpected field/);
    });

    it("an ESC byte at the start of a non-JSON verify.json never reaches the refusal", () => {
      const out = notEstablished(runDir(`${ESC}[31mnot json`));
      assert.equal(out.includes(ESC), false, JSON.stringify(out));
    });

    it("check.mjs findings no longer echoes an ESC byte in an unexpected field", () => {
      const dir = runDir({ codeReviewFindings: [{ ...finding(), [`${ESC}[2Jx`]: 1 }] });
      const result = spawnSync(
        process.execPath,
        [checkScript, "findings", join(dir, "out", "verify.json")],
        { encoding: "utf8" }
      );
      assert.equal(result.status, 1);
      assert.equal(result.stdout.includes(ESC), false, JSON.stringify(result.stdout));
      assert.match(result.stdout, /unexpected field/);
    });

    it("caps a very long reason with an ellipsis", () => {
      const coverage = {
        ran: AXES.slice(1),
        failed: [{ step: "falsifiability", reason: "x".repeat(5000) }],
        skipped: [],
      };
      const line = established(runDir(withFindings(), coverage));
      assert.ok(line.includes("\u2026"), "an ellipsis marks the cut");
      assert.ok(line.length < 400, `the line is ${String(line.length)} chars`);
    });
  });

  describe("counts only what it should", () => {
    it("a DECLINED pre-existing major is not named as pre-existing", () => {
      const line = established(
        runDir(withFindings(finding({ scope: "pre-existing", verdict: "DECLINED" })))
      );
      assert.match(line, /^Ready to merge:/);
      assert.doesNotMatch(line, /pre-existing/);
    });

    it("a DECLINED business-decision is not a question for owners", () => {
      const line = established(
        runDir(withFindings(finding({ kind: "business-decision", verdict: "DECLINED" })))
      );
      assert.match(line, /^Ready to merge:/);
      assert.doesNotMatch(line, /question/);
    });

    it("an UNVERIFIABLE blocking business-decision does not unsettle readiness", () => {
      const line = established(
        runDir(withFindings(unverifiable({ kind: "business-decision", severity: "blocking" })))
      );
      assert.match(line, /^Ready to merge:/);
      assert.doesNotMatch(line, /could not be verified|question/);
    });

    it("an UNVERIFIABLE blocking external-confirmation does not unsettle readiness", () => {
      const line = established(
        runDir(withFindings(unverifiable({ kind: "external-confirmation", severity: "blocking" })))
      );
      assert.match(line, /^Ready to merge:/);
    });

    it("a failed axis outranks pre-existing-only findings", () => {
      const coverage = {
        ran: AXES.slice(1),
        failed: [{ step: "falsifiability", reason: "timed out" }],
        skipped: [],
      };
      const line = established(runDir(withFindings(finding({ scope: "pre-existing" })), coverage));
      assert.equal(line, "Readiness not established: falsifiability did not run (timed out).");
    });

    it("a skipped axis with pre-existing-only findings is ready, naming both", () => {
      const coverage = {
        ran: AXES.slice(0, 4),
        failed: [],
        skipped: [{ step: "delivery", reason: "no spec sources" }],
      };
      const line = established(runDir(withFindings(finding({ scope: "pre-existing" })), coverage));
      assert.match(line, /^Ready to merge:.*delivery not checked: no spec sources\./);
      assert.match(line, /1 pre-existing blocking\/major finding\(s\)/);
    });
  });

  describe("refuses a coverage.json that is not exactly the shape", () => {
    it("an axis in both ran and skipped", () => {
      const coverage = {
        ran: AXES,
        failed: [],
        skipped: [{ step: "delivery", reason: "no spec sources" }],
      };
      assert.match(notEstablished(runDir(withFindings(), coverage)), /delivery.*exactly once/);
    });

    it("a non-array ran", () => {
      const coverage = { ran: "falsifiability", failed: [], skipped: [] };
      assert.match(notEstablished(runDir(withFindings(), coverage)), /"ran" must be an array/);
    });

    it("a non-array failed or skipped", () => {
      for (const key of ["failed", "skipped"]) {
        const coverage = { ran: AXES, failed: [], skipped: [], [key]: {} };
        assert.match(notEstablished(runDir(withFindings(), coverage)), /must be an array/);
      }
    });

    it("an unknown top-level key", () => {
      const coverage = { ...fullCoverage, extra: [] };
      assert.match(notEstablished(runDir(withFindings(), coverage)), /unexpected key.*extra/);
    });

    it("an unknown key in a failed entry", () => {
      const coverage = {
        ran: AXES.slice(1),
        failed: [{ step: "falsifiability", reason: "x", note: "y" }],
        skipped: [],
      };
      assert.match(notEstablished(runDir(withFindings(), coverage)), /unexpected key.*note/);
    });

    it("an array where the object belongs", () => {
      notEstablished(runDir(withFindings(), []));
    });
  });

  describe("verdict.txt housekeeping", () => {
    it("a stale verdict.txt does not survive a refusal", () => {
      const dir = runDir(withFindings(), null);
      writeFileSync(join(dir, "out", "verdict.txt"), "Ready to merge: stale\n");
      notEstablished(dir);
      assert.equal(existsSync(join(dir, "out", "verdict.txt")), false);
    });

    it("a verdict.txt that is a directory refuses without a stack trace", () => {
      const dir = runDir(withFindings());
      mkdirSync(join(dir, "out", "verdict.txt"));
      const result = verdict(dir);
      assert.equal(result.status, 1);
      assert.match(result.stdout, /^Verdict not established: /);
      assert.equal(result.stderr, "");
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

  /** The text between two anchors; both must exist, or the slice would be silently empty. */
  function between(text: string, from: string, to?: string): string {
    const start = text.indexOf(from);
    assert.notEqual(start, -1, `anchor not found: ${from}`);
    if (to === undefined) return text.slice(start);
    const end = text.indexOf(to, start);
    assert.notEqual(end, -1, `anchor not found: ${to}`);
    return text.slice(start, end);
  }
  /** Each needle must occur, in the given order. */
  function inOrder(text: string, needles: string[]): void {
    let at = -1;
    for (const needle of needles) {
      const found = text.indexOf(needle, at + 1);
      assert.notEqual(found, -1, `missing, or out of order: ${needle}`);
      at = found;
    }
  }

  it("SKILL.md step 3 checks the findings, then computes the verdict, then checks the tree", () => {
    const check = between(skill, "## 3. Check", "## 4. Report");
    inOrder(check, [
      "check.mjs' findings '<runDir>/out/verify.json'",
      "check.mjs' verdict '<runDir>'",
      "capture.mjs' check-tree",
    ]);
  });

  it("SKILL.md writes the engine's coverage to out/coverage.json, verbatim", () => {
    assert.match(skill, /`coverage` object VERBATIM to `<runDir>\/out\/coverage\.json`/);
  });

  it("SKILL.md says what happens when the engine result has no coverage", () => {
    const engine = between(skill, "## 2. Run the engine", "## 3. Check");
    assert.match(engine, /has no `coverage`.*verdict.*will refuse/s);
  });

  it("SKILL.md orders the report: refusal, warnings, verdict, synthesis, pointer", () => {
    const report = between(skill, "## 4. Report", "## 5. Answer");
    inOrder(report, [
      "Verdict not established",
      "`changed` is non-empty",
      "check.mjs reported errors",
      "out/verdict.txt",
      "The synthesis, exactly as produced",
      "verify.json",
    ]);
    assert.match(report, /very first line of the report/);
    assert.match(report, /unverified and is not a readiness claim/);
  });

  it("SKILL.md answers with the computed line first, or the refusal, and calls it authoritative", () => {
    const answer = between(skill, "## 5. Answer");
    assert.match(answer, /computed verdict line verbatim first/);
    assert.match(answer, /Verdict not established: <why>/);
    assert.match(answer, /unverified and not a readiness claim/);
    assert.match(answer, /authoritative/);
  });

  it("codex.md has a Coverage section that names the five axes, the exact-once rule and both examples", () => {
    const coverage = between(codex, "## Coverage", "## Finish");
    for (const axis of ["falsifiability", "correctness", "security", "radius", "delivery"]) {
      assert.ok(coverage.includes(axis), `${axis} missing from the Coverage section`);
    }
    assert.ok(coverage.includes("<runDir>/out/coverage.json"));
    assert.match(coverage, /exactly one of the three lists/);
    assert.match(coverage, /Write nothing else into the file/);
    assert.ok(coverage.includes('{"step":"security","reason":'), "a failed example");
    assert.ok(coverage.includes('{"step":"delivery","reason":"no spec sources"}'), "a skipped one");
    assert.ok(
      coverage.includes(
        '"ran":["falsifiability","correctness","security","radius","delivery"],"failed":[],"skipped":[]'
      ),
      "an all-ran example"
    );
    inOrder(codex, ["## Coverage", "## Finish"]);
  });
});
