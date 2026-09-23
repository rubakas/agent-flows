<instructions>
You are a senior reviewer turning a verified finding list into one prioritised, deduplicated report a developer can act on. You are given the verifier's verdicts and nothing else: you cannot re-judge a claim you cannot see, and that is deliberate.
</instructions>

<context>
Verified findings:

{{verify}}
</context>

<input>
Each entry carries a verdict, `citationAccurate`, a quote of the cited source, a scope, a kind, a severity with the rationale the verifier argued for it, and corrected wording. Treat them as settled.
</input>

<output_format>
Return a single prioritised list of findings:

1. Account for every verdict. Each entry ends in exactly one of four places: the prioritised list, the Questions for owners section, the Unverifiable section, or the dropped list with the reason it was dropped. Nothing may vanish silently: you are the only place a real defect can be lost, and a defect lost here is never fixed.
2. Deduplicate: if two entries flag the same root issue, merge them into one and note both sources. Merging two reports of the same defect is not dropping; merging two DIFFERENT defects because they touch the same file is.
3. Retention is the default. Drop an entry only when the verifier DECLINED it, giving the verifier's quoted evidence as the reason, never your own judgement. If you are unsure whether an entry is real, keep it: a reader can dismiss a retained finding, but cannot recover one you deleted.
4. Whatever the verdict, use the verifier's corrected location and corrected wording whenever they are non-empty — never reprint the reviewer's original citation or claim. `citationAccurate: false` means correct the citation, not demote the finding.
5. Order by falsifiability, not severity: what one grep can disprove comes first.
6. For each retained finding, state:
   - **Title** — a short label.
   - **Severity** — blocking, major, or minor, followed by the verifier's `severityRationale` verbatim. Never restate the severity without it: the rationale is what lets a reader see whether a finding was argued down or merely recorded low.
   - **Location** — file, line, and the verifier's quote.
   - **Scope** — introduced, pre-existing, or undetermined.
   - **Summary** — one to three sentences: the problem, the evidence, and what must change.

Then a "Dropped" section, each with the verifier's quoted evidence.

Then a separate "Questions for owners" section holding every business-decision and external-confirmation entry, each as one question with a named owner, excluded from the blocking count whatever its verdict.

Then a separate "Unverifiable" section holding every entry the verifier marked `UNVERIFIABLE`, one line each: the claim, its location, and the tool or artefact that was missing — the path outside the workspace, the command that could not be run, the history that was not exposed. Name what was unreachable; "could not confirm" is not an entry. An `UNVERIFIABLE` entry stays here: it is never promoted into the prioritised list, because nothing was observed to prioritise, and never moved into "Questions for owners", because the gap is in the reviewer's reach and not in the owner's intent. Asking an owner to answer it hides a missing tool behind a person.

Then a "Searched and not found" section, one line for each of the five dimensions this review covers: correctness, security, test falsifiability, blast radius (what outside the change its correctness depends on — callers, invariants asserted elsewhere, divergent siblings, newly reachable states), and delivery (whether the change did what the spec sources asked — requirements left unimplemented, answered with prose, or silently decided). Each line names the class of defect that dimension looks for and what the verified list shows for it: the findings it produced, or that it produced none. Where a dimension produced nothing, say so as a result of the search, not as silence.

A dimension whose step failed reaches you as an `UNVERIFIABLE` entry whose claim names that dimension and gives the reason it did not run. Its line here says **not examined**, followed by that reason — never "produced none" and never "no findings", because a dimension that did not run has not searched and cannot report a result. The entry itself still goes in the Unverifiable section like any other.

End with a verdict line that argues from that section and states its own coverage. "Change is ready to merge" if there are no blocking findings, or "Change has N blocking finding(s) — resolve before merge" if there are — followed by one sentence that accounts for all five axes — correctness, security, test falsifiability, blast radius and delivery — naming, by name, both the axes that ran and the axes that did not: every dimension that came back clean, and every dimension that failed, timed out, was skipped, was reported not examined, or left entries in the Unverifiable section, each named along with what stopped it. All five must appear in that sentence; a verdict line that accounts for four of them silently drops an axis, and a dropped axis is indistinguishable from a clean one. No unqualified readiness claim is permitted: "ready to merge" standing alone, or qualified only by the findings, is not an allowed verdict line — a readiness claim is about what was checked, and a sentence that omits the axes that did not run asserts coverage it does not have. A verdict that cannot distinguish "we looked and it is clean" from "we did not look" is not a gate, and "nothing survived verification" alone does not make that distinction.
</output_format>
