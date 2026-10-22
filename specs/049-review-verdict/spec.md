# 049. A computed review verdict

| Field        | Value                                                          |
| ------------ | -------------------------------------------------------------- |
| Feature Name | Computed merge verdict for `/af:review`                        |
| Branch       | `fix/049-review-verdict`                                       |
| Status       | Decided by the lead; the owner may overturn any decision below |
| Created      | 2026-10-22                                                     |

## Problem

The merge verdict that ends an af code review is a sentence the synthesis model writes from
`prompts/code-review-synthesis.md` (plugin copy `plugin/skills/review/references/prompts/synthesis.md`):
"Change is ready to merge" unless there are BLOCKING findings. Nothing in code checks it.

Replaying 40 historical runs against their persisted `verify.json`:

- 11 runs said "Change is ready to merge" while the verified list held 1-4 CONFIRMED or PARTIAL,
  introduced, MAJOR defects. The prompt rule only counts `blocking`, so a major defect does not
  move the verdict, and the model did not argue it into one.
- One run said "1 blocking" when the list held 2 blocking.

The verified findings already carry everything a verdict needs (`verdict`, `severity`, `kind`,
`scope`, schema `plugin/skills/review/references/schemas/findings.json`). The coverage half is also
known deterministically on the Workflow path: the engine knows which worker returned nothing or threw
(`optional()` in `src/af-plugin/buildReviewEngine.ts`). A sentence a model writes from data that code
can read is a computation done by the wrong party.

## Decisions

Recorded as the lead's. The owner may overturn any of them.

**D1 - The gate set.** A finding gates the merge when `kind` is `defect`, `verdict` is `CONFIRMED` or
`PARTIAL`, and `scope` is `introduced` or `undetermined`. `undetermined` fails closed. B is the count of
`blocking` and M the count of `major` in the gate set.

**D2 - What does not gate, but is named.** Pre-existing blocking/major defects do not block (the change
did not introduce them) but the verdict counts them. `business-decision` and `external-confirmation`
entries never count (the synthesis prompt already excludes them "whatever its verdict") but the
verdict counts them as questions for owners. `DECLINED` never counts.

**D3 - The verdict, in priority order.**

1. B+M > 0: `Not ready to merge: B blocking and M major finding(s) introduced by this change.`, plus
   ` Not examined: <step> (<reason>).` when any axis failed.
2. Any axis failed: `Readiness not established: <step> did not run (<reason>)[, ...].`
3. Any `UNVERIFIABLE` defect that is blocking or major and not pre-existing:
   `Readiness not established: K blocking or major claim(s) could not be verified.`
4. Otherwise: `Ready to merge: no blocking or major defect introduced; examined <ran axes>[; <skipped
axis> not checked: <reason>].` followed by the non-zero clauses: N minor finding(s), P pre-existing
   blocking/major finding(s) not introduced by this change, Q question(s) for owners.

Never an unqualified readiness claim: the Ready line always names the axes that ran and any skipped.
The exact wording may be polished; the structure and order may not.

**D4 - Coverage is deterministic on the Workflow path.** The engine returns
`coverage: { ran: [stepIds], failed: [{step, reason}], skipped: [{step, reason}] }` over the five
worker axes (falsifiability, correctness, security, radius, delivery). Delivery is `skipped` with
reason "no spec sources" when `hasSpecs` is false and `failed` when its worker threw or returned
nothing. Existing return keys are unchanged. On Codex there is no engine: the lead writes the same
shape to `out/coverage.json` from what it observed (`references/codex.md`).

**D5 - Computed in `check.mjs`.** A new subcommand `node check.mjs verdict <runDir>` in
`plugin/skills/review/scripts/check.mjs`: one consumer, so no new TypeScript module and no transpile.
It validates `<runDir>/out/verify.json` with the existing `validate(loadSchema("findings"), ...)` and
reads `<runDir>/out/coverage.json`. Any unreadable, non-JSON or schema-invalid input, or a coverage
file that is missing, malformed or names an unknown step, prints `Verdict not established: <why>` and
exits 1. An established verdict (ready or not ready) prints one line, writes it to
`<runDir>/out/verdict.txt` and exits 0. Only the bare `{codeReviewFindings}` shape is accepted.

**D6 - The computed line is authoritative.** `SKILL.md` writes the engine's `coverage` verbatim to
`out/coverage.json`, runs the subcommand after the findings check, puts the line in `report.md` above
the synthesis and shows it to the user first. If the synthesis's own verdict line disagrees, the
skill says so.

**D7 - The synthesis prompt is brought into line.** The canon prompt's verdict rule uses the same gate
set: "Change is ready to merge" only when no blocking or major defect introduced by the change remains,
else "Change has B blocking and M major finding(s) - resolve before merge". The five-axis coverage
clause and the ban on an unqualified readiness claim stay. The daemon pipeline shares that prompt, so
it gets the prompt rule only.

## Requirements

| ID   | Requirement                                                                                                                    |
| ---- | ------------------------------------------------------------------------------------------------------------------------------ |
| FR-1 | `check.mjs verdict <runDir>` computes the D3 line from `out/verify.json` and `out/coverage.json`                               |
| FR-2 | The subcommand refuses (exit 1, "Verdict not established") on invalid or missing inputs                                        |
| FR-3 | The engine returns `coverage` with `ran`, `failed` and `skipped` for the five worker axes                                      |
| FR-4 | `SKILL.md` and `references/codex.md` write `out/coverage.json` and run the subcommand; the report leads with the computed line |
| FR-5 | The canon synthesis prompt's verdict rule counts major defects introduced by the change; the plugin copy is byte-equal         |
| FR-6 | Plugin version 0.2.1 to 0.2.2                                                                                                  |

## Acceptance

- Verdict tests with temp run dirs: introduced CONFIRMED major gives Not ready (1 major); two blocking
  (one PARTIAL) gives "2 blocking"; pre-existing major only gives Ready and names it; a business-decision
  major gives Ready and a question; a DECLINED major gives Ready; an UNVERIFIABLE introduced major gives
  not established; a failed security axis gives not established naming security and the reason; a failed
  axis plus a major gives Not ready with the Not examined clause; delivery skipped gives Ready naming
  delivery as not checked; empty findings with full coverage gives Ready; missing `coverage.json` and a
  schema-invalid `verify.json` exit 1; `verdict.txt` equals stdout.
- Engine tests: `coverage` for success, a throwing worker, a null-returning worker, and no specs.
- Text pins: `SKILL.md` references `check.mjs' verdict` and `out/coverage.json`; `codex.md` references
  `coverage.json`; the canon verdict paragraph contains the major rule.
- Falsifiability: the major branch of the verdict rule is neutered once and the tests that go red are
  recorded; the rule is then restored.
- The generated engine and schema files are regenerated, never hand-edited; the freshness and copies
  tests pass.

## Out of scope / Follow-ups

- **The daemon pipeline has no computed verdict.** It shares the canon prompt and gets the prompt rule
  only. A verdict computed in the daemon from the persisted verify output is a follow-up.
- The 40-run replay is a one-off measurement, not a committed fixture.
- A reviewer-proposed severity is still the verifier's argued judgement; this spec does not change how
  severity is assigned, only what is done with it.
- Lenient unwrapping of `verify.json` shapes other than bare `{codeReviewFindings}`.
