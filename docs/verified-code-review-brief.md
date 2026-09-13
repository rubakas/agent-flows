# Task: make `audit` produce findings that survive being checked

You are working in the `agent-flows` repo. Your job is to add a NEW pipeline, `code-review`,
alongside the existing `audit` — so that a single run over a code change yields findings a reviewer
can hand to an author without losing the argument: correct citations, no already-guarded issues, and
non-code items routed out rather than recirculated.

**Do not modify `audit`.** It is mounted directly twice — `spec-creation`'s `verify` step and
`build`'s `review` step — and reached transitively from `cycle` and `cycle-dev`, which mount both.
The two mounts are different jobs. At
`spec-creation` it reviews a _plan_, where there is no `file:line` to open, no git baseline, no
production callers and no reachable remedy — the verification described below is meaningless there
and `audit` is already appropriate. At `build` it reviews _code_, and that is the mount that needs
this. One existing line changes: `build.yaml`'s `review` step points at `code-review` instead.

Read this whole brief before editing. Section 1 is field evidence and explains _why_ the changes in
Section 3 are the ones that matter; do not skip to Section 3.

---

## 1. Field evidence

This brief comes out of a two-day, human-in-the-loop review of a large financial-application PR
(Rails, ~500 changed files, five review rounds). The final round was measured precisely:

- **4 findings reviewed. 4/4 were real defects.** Nothing was withdrawn.
- **~15 supporting details were wrong.**
- **Every one of the four contained at least one assertion the author could have falsified with a
  single grep.**
- Across earlier rounds: one fix shipped, was later found wrong, and had to be reverted.

Read that ratio carefully, because it determines where effort belongs. **Discovery was not the
problem.** A pipeline scored on "is the bug real" passes this review at 100% and the review still
gets dismissed — because what a defensive author attacks is the citation, not the claim.

### The seven failure classes, with the actual cases

1. **Wrong citation.** A finding cited `service.rb:302-309` as the division that produced a corrupted
   share count. Those lines were a ±0.5% tolerance comparison. The real division was elsewhere and
   used a different input entirely. The defect was real; the cite was not.

2. **An existing guard was missed.** A finding's headline was "nothing caps this value from above,
   at any layer". A parent-model validation required the child rows to sum to the parent's amount —
   so every value _was_ bounded. The real defect (the value is never checked against the row it is
   paying) survived, but the headline was falsifiable in one grep and would have sunk the whole item.

3. **Wrong mechanism named.** A finding said a record was undeletable because of
   `dependent: :restrict_with_error`. That association restricted something else. The actual guard
   was a concern's `before_destroy`, whose own docstring says it is deliberately _not_
   `restrict_with_error`. Same conclusion, wrong reason — and a reader who checks stops trusting the
   rest.

4. **Dead reference cited as load-bearing.** A finding listed a query scope as one of three forces
   freezing a record. That scope had **zero production callers** — specs only.

5. **Remedy assumed absent.** A finding said there was "no remedy in the system" for a mispriced,
   already-funded transaction. A reversal path existed, and excluded neither that transaction type
   nor funded records. Four prior review passes had verified the _arithmetic_ of the same area and
   none had asked whether an operator could act on it.

6. **Scope asserted, never checked.** A finding was labelled "pre-existing, not introduced by this
   work". `git merge-base --is-ancestor` showed both responsible commits were branch-local. Scope
   claims are cheap to verify and expensive to get wrong — they decide who owns the fix.

7. **Category error.** Two of the four items were not code findings at all. One needed a business
   owner to rule on a policy; one needed a lawyer to read a contract clause. They had circulated
   through multiple review rounds because a code-review process has nowhere else to put them. **No
   pipeline can converge these.** Routing them out is the only way they stop consuming rounds.

### The rule that falls out

Rank every correction by **"can the author disprove this in one grep?"** — not by severity. A wrong
line number is cosmetic. A false load-bearing sentence guarding a real finding is the expensive
failure, because the finding dies with it.

---

## 2. Diagnosis of the current pipeline

Verified against the repo; re-verify before relying on any of it.

- `pipelines/audit.yaml` has three steps: `correctness` (worker, `contents: read`), `security`
  (worker, `contents: read`), `synthesis` (reasoner, `dependsOn: [correctness, security]`).
- **`synthesis` declares no `permissions:` block.** Per `src/canon/types.ts`, absent permissions
  means no repo access. Its prompt interpolates only `{{correctness}}` and `{{security}}`. It
  reconciles two text blobs blind and cannot open a cited file.
- **No audit step declares a `schema:`.** Findings are free prose — Location / Issue / Evidence /
  Severity. There is no machine-checkable `file`, `line`, or quoted source.
- Both worker prompts _do_ carry a guard check ("check whether something already prevents it — a
  validator, a type, a schema, an earlier guard"). It is asked of the agent that wants to report the
  finding: **self-certification**. It is the right question put to the wrong party, and case 2 above
  is what it misses.
- No prompt anywhere contains language about disproving a finding, checking a baseline, checking
  production callers, or checking that a prescribed remedy is reachable.
- `pipelines/build.yaml`'s `review` step mounts `audit` with `plan: plan` — the original plan text,
  not the diff. Post-build review re-audits the spec. The workers can read the repo, but nothing
  hands them the change and there is no baseline to diff against.

**Structural conclusion:** no step in the pipeline ever checks a finding against the artifact after
the agent that authored it. Every one of the seven failure classes passes through untouched.

---

## 3. What to implement

### Phase 1 — zero edits to existing files except one line

Everything in this phase is new files, plus a single one-line change in `build.yaml`. If it goes
wrong, revert that one line and the system is exactly as it was.

**3.1 — `pipelines/code-review.yaml` (new)**

```yaml
id: code-review
version: 1
description: Adversarial review of a code change, with every finding verified against the repo
inputs:
  - plan # the change under review: a diff, or the plan the change implements
  - baseline # git ref the change is measured against (e.g. the merge-base)
steps:
  - id: correctness
    kind: llm
    role: worker
    permissions:
      contents: read
    prompt: prompts/audit-correctness.md # reused unchanged in phase 1
  - id: security
    kind: llm
    role: worker
    permissions:
      contents: read
    prompt: prompts/audit-security.md # reused unchanged in phase 1
  - id: verify
    kind: llm
    role: reasoner
    permissions:
      contents: read
    dependsOn: [correctness, security]
    prompt: prompts/code-review-verify.md # new
  - id: synthesis
    kind: llm
    role: reasoner
    permissions:
      contents: read
    dependsOn: [verify]
    prompt: prompts/code-review-synthesis.md # new
```

The two worker prompts are reused as-is. They already say "a plan, a diff, or source code", so they
work on a diff without edits, and reusing them keeps phase 1 additive. Their weaknesses are addressed
in phase 2.

**3.2 — `prompts/code-review-verify.md` (new)**

Receives `{{plan}}`, `{{baseline}}`, `{{correctness}}`, `{{security}}`. Contract:

- Take each finding **one at a time**, and **try to disprove it**. The framing is not "check this
  over" — it is "find the reason this is wrong."
- Open every cited path. **Quote the actual lines.** If the cited lines do not say what the finding
  says, the citation is DECLINED even when the underlying defect is real — then emit the corrected
  location.
- Run these five probes on every finding and record each answer explicitly:
  - **Guard** — does a validator, constraint, type, schema, or parent-level rule already close this?
    Check the _parent_ and the _caller_, not only the file the finding names.
  - **Reachability** — is there a real path to this? Name the entry point, the permitted inputs, and
    whether anything server-side derives or clamps the value before it lands.
  - **Remedy** — if the finding claims no remedy exists, go find one. Search reversal, correction,
    void, amendment and override paths, and check whether they actually exclude this case.
  - **Callers** — does every symbol the finding leans on have production callers? A scope or constant
    referenced only by tests cannot be load-bearing.
  - **Scope** — `git merge-base --is-ancestor <commit> {{baseline}}` for the responsible commits.
    Report introduced vs pre-existing as a fact, never as a judgement.
- Emit per finding: `verdict` (CONFIRMED | PARTIAL | DECLINED), corrected citation, quoted source,
  the five probe answers, and for PARTIAL exactly which sub-claim failed and the accurate wording.
- **A finding may be CONFIRMED as a defect while its supporting details are DECLINED.** These are
  separate judgements and the output must keep them separate. Collapsing them is the single most
  common way this stage fails.

**3.3 — `prompts/code-review-synthesis.md` (new)**

Start from the existing `audit-synthesis.md` — its anti-loss discipline ("nothing may vanish
silently; you are the only place a real defect can be lost") is good and must be preserved verbatim.
Add:

- Consume verdicts. DECLINED findings go to the dropped list **with the verifier's quoted evidence**,
  never on synthesis's own judgement.
- PARTIAL findings are promoted using the verifier's corrected wording, never the worker's original.
- Emit `business-decision` and `external-confirmation` items in a **separate section**, each as one
  question with a named owner. They carry no code severity and are excluded from the blocking count.
- Order the _corrections_ by falsifiability, not severity: a false load-bearing sentence outranks a
  wrong line number.

**3.4 — `build.yaml` (one line)**

```yaml
- id: review
  kind: pipeline
  pipeline: code-review # was: audit
  with:
    plan: <the diff> # was: plan: plan — the original plan text, not the change
    baseline: <merge-base ref>
  dependsOn: [converge]
```

Passing `plan: plan` is a live defect independent of everything else here: post-build review
currently re-audits the spec instead of the code. Fix it as part of this wiring.

Note the reach: `build` is mounted by `cycle` and `cycle-dev`, so this one line changes the review
stage of the full cycle too. That is the intent — but run `cycle-dev` once before and after, and
confirm the only behavioural difference is at the review stage.

### Phase 2 — only after phase 1 is proven

**3.5 — code-specific worker prompts.** Fork `audit-correctness.md` / `audit-security.md` into
`code-review-*` variants. Changes: require a **verbatim quote** of the cited lines in every finding
(an agent forced to paste the line usually notices when it does not say what it expected); demote the
existing guard check from a _suppression_ rule to a required _field_ ("guards I checked and why they
do not close this") — suppression by the finding's own author both hides real defects and keeps false
ones, and the verifier now adjudicates it with the repo open; require `kind` at authoring time.

**3.6 — finding schema.** Add a `schema:` to the `code-review` steps carrying at least
`file, line, quote, severity, verdict, scope (introduced|pre-existing),
kind (defect | business-decision | external-confirmation)`. `kind` is what stops failure class 7: a
`business-decision` needs a named owner and one answerable question, an `external-confirmation` needs
a named document or party. Neither is a defect and neither belongs in a severity queue.

**3.7 — converge gate.** `build.yaml`'s `converge` gates on `test.passed`. Green tests do not mean a
finding is resolved — that is exactly how a wrong fix shipped and was reverted. Gate on
re-verification of the findings the round was opened to fix.

### Phase 3 — needs a canon change, do last

Per-finding parallel verification — one adversarial verifier per claim — is what actually worked in
the field. It needs a `map`/`forEach` step kind; the existing `loop` is retry-shaped
(`maxIterations` / `until`), not map-shaped. Propose that canon change separately, after phases 1-2
have shipped.

---

## 4. Acceptance criteria

1. A finding whose cited `file:line` does not support it comes out **DECLINED**, with the real
   content of those lines quoted. Build a fixture for this and prove it fails before your change and
   passes after — a gate that cannot fail is not a gate.
2. A finding whose issue is already closed by a parent-level validation comes out DECLINED, naming
   the guard.
3. A finding claiming no remedy exists, where one does, comes out PARTIAL with the remedy named.
4. A `business-decision` item never appears in the blocking count and always carries an owner and a
   single question.
5. A defect that is real but badly cited comes out CONFIRMED-with-corrected-citation, **not** dropped.
   Losing true findings to a strict verifier is a worse failure than the one you are fixing.
6. **`pipelines/audit.yaml` and the three `audit-*.md` prompts are byte-identical to what they were
   before your change**, and `spec-creation` runs exactly as it did. Verify with `git diff`, not by
   recollection.

---

## 5. Do not

- **Do not modify `audit` or its prompts.** Phase 1 is additive by design. If you find yourself
  needing to edit them, you have merged the plan-review and code-review jobs again.
- **Do not add more reviewer dimensions.** Discovery scored 4/4. A third or fourth axis would have
  found nothing new and would add reports nobody verifies.
- **Do not raise iteration counts.** The rounds were spent correcting citations, not finding more
  bugs. More rounds of the same unverified output reproduces the problem at higher cost.
- **Do not let the verifier soften findings into vagueness.** "May be an issue in some cases" is not
  a verified finding, it is an unfalsifiable one. Every output must stay specific enough to be
  provably wrong.
- **Do not give any new step write access.** Verification is read-only.

---

## 6. Deliverables

`pipelines/code-review.yaml`, `prompts/code-review-verify.md`, `prompts/code-review-synthesis.md`, the
one-line `build.yaml` change, and the fixtures proving criteria 1-3. Report what you changed, what
you verified by running, and anything in this brief you found to be wrong about the current repo —
Section 2 was checked against the tree on one date, and you should treat it as a claim to verify
rather than a fact to build on.
