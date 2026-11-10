---
name: dual-review
description: Run two independent code reviews of a branch in parallel — the agent-flows review `/af:review` (correctness / security / test-falsifiability / blast radius / delivery) and the agent-notes axes (Standards / Spec / Gates) — verify every claim against the files, then report them side by side with a comparison. Use when the user wants a branch, PR, or range reviewed thoroughly, says "dual review", or asks to review with both agent-flows and agents.
---

Two review engines, run at the same time over one fixed range, then compared. They are complementary by
construction, not redundant: **agent-flows checks delivery only against the spec sources it is handed, and
the agent-notes axes have no falsifiability check.** Either one alone closes a review with the other's
hole open.

Run every step. Do not skip the verification step — it is the one that keeps this honest.

## 1. Pin the range

```bash
git fetch origin --prune
git checkout <branch> && git pull --ff-only
BASE=$(git merge-base origin/<default-branch> HEAD)
git log --oneline $BASE..HEAD          # two dots — the commit list
git diff --stat $BASE...HEAD           # three dots — diff against merge-base
```

Stop here if `BASE` doesn't resolve or the diff is empty. A bad range fails cheaply now and expensively
inside six agents later. Note whether the working tree is clean and whether HEAD is detached — check out a
real branch before reviewing.

## 2. Gather the specs (both tracks need them)

Extract ticket references from the commit subjects (`#1234`, `Closes #45`). Fetch each one — `gh issue view N
--json number,title,state,body` — and **write them to files**, one per ticket, plus the diff and commit list:

```
/tmp/<slug>/diff.patch      /tmp/<slug>/commits.txt      /tmp/<slug>/specs/issue-N.md
```

This is not optional bookkeeping: the `analyst` subagent has no Bash, so without files on disk its Spec axis
reviews commit subjects instead of code. If there is no tracker, look for a PRD/spec under `docs/`, `specs/`
or `.scratch/`; if there is none at all, say so and let the Spec axis report "no spec available".

## 3. Start agent-flows FIRST — it is the long pole (~15–20 min)

Run it through the `af:review` skill (`/af:review`). It runs as a Claude Code workflow, so its progress shows
in the status bar and in `/workflows`. Never start it through the agent-flows MCP tools (`start_run`,
`run_pipeline`): those run on the daemon, which Claude Code cannot see, and the user gets no progress at all.

Invoke the `af:review` skill and do its steps 1 and 2 now:

- capture with `--base '<BASE SHA>'`, one `--spec-file` per spec file written in step 2, and `--plan-file`
  with the plan below — follow that skill's rules for writing those files;
- start the workflow `af:review-engine` with the args that skill gives. It runs in the background: do not
  wait for it, go straight to step 4.

**The plan decides the quality of the entire run.** Give it:

- one line per commit saying what that commit was _meant_ to do, mapped to its ticket;
- explicit acceptance criteria (what "correct" means for this change);
- the repo's known landmines — the traps a fresh reader would fall into.

A thin plan produces a thin review. The landmine list is what steers the review toward the failure classes
that actually recur in this repo.

If no `Workflow` tool is available, stop and tell the user that workflows must be enabled in Claude Code. Do
not fall back to the daemon.

## 4. While it runs, run the agent-notes track

Invoke the `code-review` skill with the same `BASE`. It dispatches `reviewer` (Standards: documented repo
standards + the Fowler smell baseline) and `analyst` (Spec: did the code deliver the ticket) in parallel.

Add a third agent when the diff earns it:

- `security-auditor` — the diff touches auth, policies, compliance gates, or authority boundaries;
- `database-specialist` — migrations or query shape changed.

Brief the extra agent with **3–5 specific, file-anchored questions** ("did every caller of X get the new
bound?"), never "audit this". Specific questions come back with file:line; vague ones come back with prose.

## 5. Verify every claim before you believe it

Non-negotiable, and it is where most of the value is added. For each finding: open the file, check the
anchor, confirm the premise. In practice, per run, expect roughly:

- **line-number drift** — the claim is right, the anchor is off by 20–500 lines;
- **overstated severity** — a "medium" that the ticket itself prescribed;
- **at least one false premise** — a finding built on a commit subject, a comment, or a name rather than on
  code. A commit that says it removed documents may have removed none; check with `git show --stat` and
  `git log --all --diff-filter=A -- '<paths>'` before escalating it.

Also check what the finding is _scoped_ to: is the file even in the diff (`git diff --name-only $BASE...HEAD`)?
"Pre-existing gap the fix didn't reach" and "regression this branch introduced" are different reports.

## 6. Collect the agent-flows result

- Wait for the workflow's completion notification; do not poll it. Its progress is in the status bar and in
  `/workflows`.
- Then finish the `af:review` skill from where its step 2 left off: write the `out/` files, run its checks and
  the verdict (its step 3), and write `<runDir>/report.md` (its step 4).
- Read `<runDir>/out/synthesis.md` and `<runDir>/out/verify.json`. The computed verdict line in
  `<runDir>/out/verdict.txt` is authoritative; if the synthesis's own closing verdict disagrees, say so. When
  the verdict was not established, report the `Verdict not established: <why>` line and offer no verdict of
  your own.

## 7. Run the test suite — only after the review has finished

The review ends by listing every working-tree path that changed while it ran (`check-tree`: changed tracked
files and untracked, non-ignored ones). A suite run in the middle of it can write such files and bury a real
change in noise. Wait for the workflow to finish and its checks to run, then run the suite. Report the real
numbers; never assert green without them.

## 8. Report

Rank findings high → low by what actually matters, each as: **what** (file:line), **why it matters** (the
concrete failure: inputs → wrong outcome, and what bounds the severity), **fix** (concrete, or "owner
decision" when it is a business call). Keep majors in the body; collapse the rest into one named paragraph so
nothing is silently lost.

Then the comparison, which is the point of running both:

- found by **both** (highest confidence);
- found only by **agent-flows** (typically: dead test fences, callers outside the diff, arithmetic drift);
- found only by **agent-notes** (typically: ticket not delivered, standards drift, mis-citations);
- **refuted** — anything either track got wrong, with the evidence that kills it;
- conflicting verdicts, and why they are both right about different questions.

A "ready to merge / zero blocking" line is a summary of the axes that ran, nothing more. Report it as such.

## 9. Close the loop without being asked

Before handing the report over: run the suite, apply the purely mechanical fixes the review found (a wrong
ticket citation, a stale comment — nothing that touches logic), save the report to a path the user can
actually open (a git-ignored `tmp/` inside the repo beats `/tmp`, which a sandboxed editor often cannot read),
and decompose the remaining code work into a ready plan. Send back only what genuinely needs a human:
business decisions, product trade-offs, scope cuts.
