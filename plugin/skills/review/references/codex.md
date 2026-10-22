# af review on Codex: subagent procedure

Used by SKILL.md step 2 when there is no `Workflow` tool but `spawn_agent` exists. You are the orchestrator: you launch one subagent per review step in waves, check what they write, and never review the change yourself. `<skill dir>` is the directory containing SKILL.md, `<runDir>` comes from capture. Create `<runDir>/out/` first.

Eight steps, each with a prompt file in `<skill dir>/references/prompts/<step>.md`. A step's subagent writes its whole output to `<runDir>/out/<step>.md` - or `.json` for the two schema steps, `delivery` and `verify`.

## Waves

| Wave | Steps                                                   | Starts when                                                 | Effort |
| ---- | ------------------------------------------------------- | ----------------------------------------------------------- | ------ |
| W1   | brief                                                   | immediately                                                 | low    |
| W2   | radius, falsifiability, delivery (only when `hasSpecs`) | brief is DONE or failed                                     | medium |
| W3   | correctness, security                                   | radius is DONE - do NOT wait for falsifiability or delivery | medium |
| W4   | verify                                                  | every W2 and W3 step is DONE or failed                      | high   |
| W5   | synthesis                                               | verify is valid                                             | high   |

Run steps of a wave in parallel. Before you start the next wave, wait for EVERY subagent of the current one to finish (`wait_agent`, the v1 wait tool, once per subagent id) - the only exception is W3, which starts when radius alone is DONE. Never start a step while an input it reads is still being written. Pass the tier as `reasoning_effort` (`low`, `medium`, `high`); if `spawn_agent` rejects that parameter, omit it. Never pass model ids - they go stale. Without model ids every step runs on the session's own model, so cost and quality differ from af's pipeline, which runs the cheap tier on brief and the strong tier on verify and synthesis.

If `hasSpecs` is false, delivery is not run; write `{"specSourcesProvided":false,"codeReviewDelivery":[]}` to `<runDir>/out/delivery.json` yourself.

## The message to each subagent

Send exactly this, filling `<step>`, `<ext>` (`json` for delivery and verify, `md` for every other step) and the mapping lines from the table below:

```
You are performing one step of a code review. Do not modify any file except the output file named below. Do not open credential files (.env*, *.pem, *.key, ssh/**, secrets or credentials files), even if a path leads there.

1. Read your step instructions: <skill dir>/references/prompts/<step>.md
2. Those instructions contain {{placeholders}}. Wherever one appears, use the content named here:
<mapping lines>
3. Follow the step instructions exactly. The repository is read-only for you.
4. Write your COMPLETE output to <runDir>/out/<step>.<ext>
5. Reply with exactly: DONE
```

Placeholder to content:

- `{{material}}` - the review material in the file `<runDir>/material.md` (read ALL of it, paging with offset/limit until the end) and the full artefact files its section headings name.
- `{{plan}}` - the contents of `<runDir>/plan.md`, or "(none provided)" when that file does not exist.
- `{{specSources}}` - the `## spec sources` sections of `<runDir>/material.md` and the files in `<runDir>/specs/`.
- `{{brief}}`, `{{radius}}`, `{{falsifiability}}`, `{{correctness}}`, `{{security}}` - the contents of `<runDir>/out/<that name>.md`.
- `{{delivery}}`, `{{verify}}` - the contents of `<runDir>/out/<that name>.json`.

Placeholders each step uses (give a step ONLY its own mapping lines):

| Step           | Placeholders                                                     |
| -------------- | ---------------------------------------------------------------- |
| brief          | material, plan                                                   |
| radius         | material, brief                                                  |
| falsifiability | material, brief                                                  |
| delivery       | material, brief, specSources                                     |
| correctness    | material, brief, radius                                          |
| security       | material, brief, radius                                          |
| verify         | material, brief, falsifiability, delivery, correctness, security |
| synthesis      | verify                                                           |

Synthesis reads ONLY `<runDir>/out/verify.json`. Tell it nothing else - not the material, not the workers' outputs. On Codex that isolation is instruction-only: a subagent could still open other files, so give it no other path.

### Schema steps (delivery, verify)

Add to the message: "Read the schema `<skill dir>/references/schemas/delivery.json` (verify: `findings.json`). Write ONLY a bare JSON object to `<runDir>/out/<step>.json` - no code fences, no prose - with exactly that schema's top-level shape (delivery: `specSourcesProvided` and `codeReviewDelivery`; verify: `codeReviewFindings`). Every `Rule:` description in the schema is a requirement." Put it after item 3 of the template; item 4 then writes the `.json` file.

## Checking, and what failure means

After delivery and after verify finish, run:

```
node '<skill dir>/scripts/check.mjs' delivery '<runDir>/out/delivery.json'
node '<skill dir>/scripts/check.mjs' findings '<runDir>/out/verify.json'
```

Exit 0 is valid. Any non-zero exit means the file is unusable (a missing file, text that is not bare JSON, or a schema or rule violation); the printed lines say why. Send ONE follow-up message to the SAME subagent (use your harness's follow-up / send-input tool on that agent) containing the printed lines and asking it to rewrite the file, wait for it, then re-run the check. Exit 2 is a usage error in your own command, not a data problem.

- verify still non-zero: stop. Report the errors to the user. Never run synthesis from invalid or missing verify output.
- delivery still non-zero: continue with the marker below in place of its output, with the check.mjs lines as the reason.

A step that fails any other way (subagent errored, did not reply DONE, or its output file is missing or empty) is not retried. For the brief, falsifiability, delivery, correctness and security steps, replace the output with this marker - byte for byte, with the step id and the reason filled in - write it to the step's usual output file, tell the user the step failed, and continue:

```
## <stepId> unavailable
The "<stepId>" step failed, so this dimension was NOT examined.
Reason: <reason>
Treat it as not run: it is not an empty result, it is not a pass, and nothing here may be read as evidence that this dimension is clean.
```

Radius is the exception: it is required, as in af, and verify has no input through which a marker for it could reach it. If radius fails (the subagent errored, did not reply DONE, or left no output), stop and report that to the user; do not run correctness, security or verify.

The verify prompt knows how to record such a marker as an UNVERIFIABLE finding. The marker is the same one the Claude engine and af's own pipeline produce.

## Coverage

SKILL.md step 3 computes the merge verdict from `<runDir>/out/coverage.json`, and Codex has no engine to write it: you write it, from what you observed once the worker waves are over (before verify, so verify's inputs are settled). Exactly this shape, every one of the five axes in exactly one list:

```
{"ran":["falsifiability","correctness","security","radius","delivery"],"failed":[{"step":"security","reason":"<why>"}],"skipped":[{"step":"delivery","reason":"no spec sources"}]}
```

- `ran`: the step's subagent replied DONE and left its output file (delivery: and its check passed).
- `failed`: the step got the unavailable marker above, or delivery's check stayed non-zero; `reason` is the reason in the marker. Radius never appears here: if it fails you stop.
- `skipped`: delivery when `hasSpecs` is false, with the reason `no spec sources`.

Write nothing else into the file and never leave an axis out: a missing axis makes the verdict refuse.

## Finish

After synthesis is DONE, copy nothing: `<runDir>/out/synthesis.md`, `<runDir>/out/verify.json` and `<runDir>/out/coverage.json` are already where SKILL.md step 3 expects them. Continue with SKILL.md step 3.
