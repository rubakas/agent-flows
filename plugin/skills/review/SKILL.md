---
name: review
description: af review - the agent-flows code review with independent verification. Captures a git change deterministically (diff, commits, history, optional ticket/spec sources), has parallel reviewers examine correctness, security, blast radius, test falsifiability and delivery, has a separate verifier try to refute every claim against the files, and writes one prioritised report. Use when asked for an "af review" or an agent-flows review of a branch or range. Review only - never edits code.
---

# af review

Review a change on the current branch. You orchestrate; the reviewers read, you never fix code and you never edit any file outside `.af-review/`.

`<skill dir>` below is the directory that contains this SKILL.md (Claude Code reports it as the skill's base directory). Every command runs from the repository root.

## 1. Capture

Collect from the user: a base ref (optional; capture derives one when absent), ticket references (`#12`, `owner/repo#12`, a GitHub URL), literal ticket or spec text, and a change description (the plan).

User-supplied text never goes on a command line.

- Literal ticket or spec text: write each one to its own file with the Write tool, under a fresh directory made with `mktemp -d "${TMPDIR:-/tmp}/af-review.XXXXXX"`, and pass `--spec-file '<that file>'` (repeat per text).
- The change description: write it to a file there too and pass `--plan-file '<that file>'`.
- Only GitHub references go to `--spec '<ref>'` (repeatable) and the base ref to `--base '<ref>'`, each single-quoted, and only when it matches `^[A-Za-z0-9._/#:~^@+-]+$`. If a value does not match, stop and ask the user for a different one.

```
node '<skill dir>/scripts/capture.mjs' [--base '<ref>'] [--spec '<ref>']... [--spec-file '<file>']... [--plan-file '<file>']
```

It prints one line of JSON. If it has `"ok":false`, report `reason` to the user and stop. Otherwise keep `runDir` and `hasSpecs`; `withheld` lists paths excluded by credential policy and `truncated` flags capped artefacts - mention either in your final answer when non-empty.

If you passed any `--spec` or `--spec-file` and `hasSpecs` is false, no spec source resolved: tell the user the delivery dimension was not run for that reason.

## 2. Run the engine

- If a `Workflow` tool is available: start the workflow `af:review-engine` with args `{"runDir": "<runDir>", "plan": "<the change description, omitted when none>", "hasSpecs": <hasSpecs>}` and wait for it. It returns `{synthesis, verify, delivery, coverage}`; `delivery` is absent when delivery did not run or failed, and `coverage` says which review dimensions ran, failed or were skipped. Create `<runDir>/out/`, then write the `verify` object VERBATIM to `<runDir>/out/verify.json`, the `coverage` object VERBATIM to `<runDir>/out/coverage.json`, the `delivery` object VERBATIM to `<runDir>/out/delivery.json` when it is present, and the `synthesis` text to `<runDir>/out/synthesis.md`. If `synthesis` is missing, say so, still write `verify.json` and `coverage.json`, and skip to step 3. If the result has no `coverage`, say so in the report: there is nothing to write to `coverage.json`, so the verdict in step 3 will refuse.
- Otherwise, if a `spawn_agent` tool is available: follow `<skill dir>/references/codex.md`. It writes `<runDir>/out/verify.json`, `<runDir>/out/coverage.json` and `<runDir>/out/synthesis.md` itself.
- Otherwise stop and tell the user that workflows must be enabled in Claude Code (or that Codex subagents are required); do not review inline.

## 3. Check

1. `node '<skill dir>/scripts/check.mjs' findings '<runDir>/out/verify.json'` - a non-zero exit means the verify output broke the schema or one of its rules. Report the printed lines prominently; never present an unchecked verify result as clean.
   On the Workflow path, when you wrote `<runDir>/out/delivery.json` in step 2, also run `node '<skill dir>/scripts/check.mjs' delivery '<runDir>/out/delivery.json'` - a non-zero exit means the delivery output broke the schema or its rule (for example `specSourcesProvided: false` with entries). Report the printed lines prominently, the same way; never present an unchecked delivery result as clean. (The Codex path checks delivery itself in `<skill dir>/references/codex.md`.) If `hasSpecs` was true but the engine returned no `delivery`, the delivery step failed: say in the report that delivery was not checked for that reason.
2. `node '<skill dir>/scripts/check.mjs' verdict '<runDir>'` - computes the merge verdict from the verified findings in `out/verify.json` and the coverage in `out/coverage.json`, prints it as one line and writes it to `<runDir>/out/verdict.txt`. It also re-checks `out/delivery.json` when the coverage says delivery ran, and counts delivery as not examined when that file is missing or invalid. Exit 0 means a verdict was established (ready or not ready). A non-zero exit prints `Verdict not established: <why>` and writes no `verdict.txt`: step 4 and step 5 lead with that line, and you do not offer any verdict of your own.
3. `node '<skill dir>/scripts/capture.mjs' check-tree '<runDir>'` - prints `{"changed":[...]}`: working-tree paths that differ from before the review.

## 4. Report

Write `<runDir>/report.md`:

1. If the verdict was not established, the printed `Verdict not established: <why>` line, as the very first line of the report, before everything below.
2. If `changed` is non-empty, a prominent warning: these paths changed during the review - by a reviewer or by you - followed by the paths.
3. If check.mjs reported errors, a prominent warning with them.
4. The computed verdict line from `<runDir>/out/verdict.txt`, verbatim, labelled as computed from the verified findings (omitted when the verdict was not established).
5. The synthesis, exactly as produced. When the verdict was not established, put one line directly above it: the synthesis's own closing verdict line is unverified and is not a readiness claim.
6. A final line pointing at `<runDir>/out/verify.json` for the verified findings JSON (do not copy the JSON into the report).

## 5. Answer

Show the user the computed verdict line verbatim first - or, when the verdict was not established, the `Verdict not established: <why>` line, saying the synthesis's closing verdict line is unverified and not a readiness claim - then the synthesis and the absolute path of `report.md`. The computed line is authoritative: if the synthesis ends in a verdict line that disagrees with it, say so. Do not fix anything the review found.
