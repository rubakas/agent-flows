# Existing capabilities vs. the "missing primitives" in ADR-0015

Date: 2026-09-05
Purpose: **ergonomics audit.** ADR-0015 "Consequences" lists four canon primitives as blockers. This
note examines two of them — `workspace: write` and a `check`/`command` step kind — against what the
tools we *already* use provide, before any code is written. Q3 is a short retrospective on the
`kind: "loop"` implementation.

**Ground rule (owner's):** facts only, primary sources cited. Anything not confirmed against a
primary source or a local run is marked **[unverified]**.

Primary sources used:

- Local CLI `claude` **v2.1.259**, `claude --help` (authoritative — installed at `/Users/en3e/.local/bin/claude`)
- Claude Code CLI reference — https://code.claude.com/docs/en/cli-reference
  (canonical redirect target of `docs.claude.com/en/docs/claude-code/cli-reference`, HTTP 301)
- Claude Code permission modes — https://code.claude.com/docs/en/permission-modes
- Claude Code permissions — https://code.claude.com/docs/en/permissions
- Mastra `WorkspaceSandbox` / `LocalSandbox` references, shipped inside the installed
  `@mastra/core@1.63.2` (`node_modules/@mastra/core/dist/docs/references/reference-workspace-sandbox.md`,
  `reference-workspace-local-sandbox.md`) and its `.d.ts` type declarations
- Mastra `workflow.dountil()` reference — https://github.com/mastra-ai/mastra/blob/main/docs/src/content/en/reference/workflows/workflow-methods/dountil.mdx (via context7 `/mastra-ai/mastra`)
- n8n Execute Command node — https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.executecommand/

Local experiments were run in a scratchpad directory; each is labelled **TEST A–G** below and its
observed output is reported verbatim in substance.

---

## Question 1 — `workspace: write`

### What the code does today

`src/canon/runStep.ts` implements `workspace: "read"` in exactly one place:

```ts
const extraArgs: string[] = [];
if (resolvedWorkspaceDir !== undefined) {
  extraArgs.push("--allowedTools", "Read,Glob");
}
const result = await runClaudeCli(prompt, { model, signal, cwd: resolvedWorkspaceDir, extraArgs }, deps);
```

`src/canon/runClaudeCli.ts` always spawns `claude -p --output-format text [--model M] [...extraArgs]`
with `cwd` set. So the mechanism is: **a cwd + an array of extra argv flags.**

### Verbatim flags from `claude --help` (v2.1.259)

Reproduced exactly as printed, only re-wrapped:

```
  --add-dir <directories...>            Additional directories to allow tool
                                        access to
  --allow-dangerously-skip-permissions  Enable bypassing all permission checks
                                        as an option, without it being enabled
                                        by default. Recommended only for
                                        sandboxes with no internet access.
  --allowedTools, --allowed-tools <tools...>
      Comma or space-separated list of tool names to allow (e.g. "Bash(git *)
      Edit")
  --dangerously-skip-permissions        Bypass all permission checks.
                                        Recommended only for sandboxes with no
                                        internet access.
  --disallowedTools, --disallowed-tools <tools...>
      Comma or space-separated list of tool names to deny (e.g. "Bash(git *)
      Edit")
  --json-schema <schema>                JSON Schema for structured output
                                        validation. Example:
                                        {"type":"object","properties":{"name":{"type":"string"}},"required":["name"]}
  --output-format <format>              Output format (only works with --print):
                                        "text" (default), "json" (single
                                        result), or "stream-json" (realtime
                                        streaming) (choices: "text", "json",
                                        "stream-json")
  --permission-mode <mode>              Permission mode to use for the session
                                        (choices: "acceptEdits", "auto",
                                        "bypassPermissions", "manual",
                                        "dontAsk", "plan")
  --permission-prompts <target>         Who answers permission prompts with
                                        --print: "host" (the SDK host or
                                        --permission-prompt-tool) or "none"
                                        (nobody: anything that would prompt is
                                        denied automatically; the permission
                                        mode still decides everything else)
                                        (choices: "host", "none", default:
                                        "host")
  -p, --print                           Print response and exit (useful for
                                        pipes). Note: The workspace trust dialog
                                        is skipped when Claude is run in
                                        non-interactive mode (via -p, or when
                                        stdout is not a TTY, e.g. piped or
                                        redirected output). Only use this in
                                        directories you trust. Settings files
                                        that fail validation are silently
                                        ignored in this mode (no error dialog is
                                        shown).
  --restricted                          Restricted mode: removes the built-in
                                        tools that run commands or code (Bash,
                                        PowerShell, REPL and the other
                                        code-running tools) and WebFetch unless
                                        --tools names them, and ignores user,
                                        project and local settings files
                                        (managed settings and --settings still
                                        apply; add --strict-mcp-config to skip
                                        MCP servers too). Also confines the file
                                        tools to the working directories
                                        (--add-dir included), refuses
                                        bypassPermissions, and lets only a
                                        person or the configured permission
                                        handler approve writes to settings, git
                                        and tool-configuration files.
  --settings <file-or-json>             Path to a settings JSON file or a JSON
                                        string to load additional settings from
  --tools <tools...>                    Specify the list of available tools from
                                        the built-in set. Use "" to disable all
                                        tools, "default" to use all tools, or
                                        specify tool names (e.g.
                                        "Bash,Edit,Read").
```

### What the docs say the flags mean

From the CLI reference (https://code.claude.com/docs/en/cli-reference):

- `--allowedTools` — "Tools that execute without prompting for permission. […] **To restrict which
  tools are available, use `--tools` instead.**"
- `--tools` — restricts the available set from the built-in tools.
- `--add-dir` — "Add additional working directories for Claude to **read and edit** files."
- `--permission-mode` — "Begin in a specified permission mode. Accepts `default`, `acceptEdits`,
  `plan`, `auto`, `dontAsk`, `bypassPermissions`, or `manual`."

From permission modes (https://code.claude.com/docs/en/permission-modes):

- `acceptEdits` — "`acceptEdits` mode lets Claude create and edit files in your working directory
  without prompting." Auto-approval "applies only to paths inside your working directory or
  `additionalDirectories`."
- `dontAsk` — "auto-denies every tool call that would otherwise prompt you. Claude runs only actions
  matching your `permissions.allow` rules […] Use this mode for CI pipelines […] the session never
  waits for input."
- `claude -p` starts in `default` (Manual) mode — stated in the "Which mode a session starts in"
  table: `claude -p` or the Agent SDK → `default`.

The docs give the CI recipe verbatim:

> `claude -p "run the test suite" --permission-mode dontAsk --allowedTools "Bash(npm test)" "Read"`

### Local verification

| Test | Command shape | Result |
| --- | --- | --- |
| **A** | today's exact read mode: `-p --allowedTools "Read,Glob"`, asked to create a file | **Write denied.** Model reported "the Write was denied… doesn't have Write permission granted", no file created. Read mode genuinely enforces. |
| **B** | `-p --permission-mode acceptEdits`, cwd = target dir | **File created**, exact contents. No prompt, fully non-interactive. |
| **F** | `-p --permission-mode acceptEdits`, asked to write to an **absolute path outside cwd** | **Refused, no file created.** Confinement to the working directory holds. |
| **G** | **same mechanism as today, allowlist widened only**: `-p --allowedTools "Read,Glob,Edit,Write"` | **File created.** |

TEST G is the decisive one: it changes nothing but the string in the existing `extraArgs.push(...)`.

### Which flags express "the agent may edit files in this directory"

Two equivalent expressions, both already available, both non-interactive:

1. **Widen the existing allowlist** — `--allowedTools "Read,Glob,Edit,Write"` (+ `Bash` if the step
   needs to run commands). This is the *same* argv mechanism `runStep.ts` already uses. Verified
   by TEST G.
2. **Switch the permission mode** — `--permission-mode acceptEdits`, which grants file
   create/edit plus `mkdir`/`touch`/`mv`/`cp` inside the cwd. Verified by TEST B.

The directory scope in both cases is the `cwd` that `runClaudeCli` already passes; `--add-dir`
extends it to extra directories if a step ever needs more than one root.

**Not needed:** `--dangerously-skip-permissions` / `bypassPermissions`. It is strictly more dangerous
(the docs: "offers no protection against prompt injection or unintended actions"; writes to protected
paths are allowed) and buys nothing the two options above don't already give inside a repo.

### Incidental finding (not part of the verdict)

`runStep.ts`'s read mode uses `--allowedTools`, which per the docs means "executes without prompting"
— an allow-list, not a restriction. Read-only holds today only because a `-p` run has no prompt to
fall back on, so everything else is denied (TEST A confirms the behaviour). The flag that *removes*
the tools is `--tools "Read,Glob"`, and `--permission-prompts none` makes the deny-on-prompt explicit
rather than incidental. Tightening this is a one-line hardening, independent of Q1.

### **Verdict: NOT NEEDED — `workspace: "write"` is a different `--allowedTools` string on the existing mechanism, not a new primitive.**

Concretely: widen `extraArgs` in `src/canon/runStep.ts` from `"Read,Glob"` to `"Read,Glob,Edit,Write"`
(optionally `+ Bash`), or add `--permission-mode acceptEdits`; and relax the `workspace?: "read"`
type in `src/canon/types.ts` to `"read" | "write"`. The cwd plumbing, the directory validation, the
api-transport rejection and the timeout handling are all already written and already correct for
both modes. Codex's branch needs its hard-coded `-s read-only` made conditional — the same shape of
change, in the same function.

---

## Question 2 — the "check / command step kind"

### The canon's existing structured-output mechanism

`src/canon/types.ts` allows `schema?: "weaknesses" | "securityFindings"` on a step;
`src/canon/schemas.ts` holds those two JSON Schemas; `src/bindings/mastra/build.ts` (`buildLlmStep`)
enforces them by **appending the schema to the prompt** and parsing the reply, with one retry:

```ts
prompt += `\n\nReturn ONLY a valid JSON object matching this JSON Schema` +
  ` (no markdown, no code fences, no commentary):\n${JSON.stringify(schema)}`;
```

That is prompt-level enforcement. The CLI has a stronger, native version of the same thing.

### `--json-schema` is native, validated structured output

`claude --help` (v2.1.259) lists `--json-schema <schema>`; the CLI reference describes it as "Get
validated JSON output matching a JSON Schema after the agent completes its workflow (print mode
only)."

**TEST E** — a real failing shell script, run by the agent's own Bash tool, with a check-shaped schema:

```
claude -p --permission-mode dontAsk --allowedTools "Bash" "Read" \
  --json-schema '{"type":"object","properties":{"passed":{"type":"boolean"},
                  "exitCode":{"type":"integer"},"output":{"type":"string"}},
                  "required":["passed","exitCode","output"],"additionalProperties":false}' \
  --output-format json
```

Returned, in the result JSON's `structured_output` field:

```json
{ "passed": false, "exitCode": 1,
  "output": "./run-checks.sh exited with code 1 (failure). Output:\ncheck 1: ok\ncheck 2: FAILED expected 3 got 4" }
```

The script's real exit code was 1. The `-p` result JSON also carries `permission_denials`, `is_error`
and `subtype` as machine-readable fields.

So yes: **an `llm` step with `workspace: write` (or just `Bash` allowed) plus a check-shaped schema
produces `{passed, output}` and gives the loop its `until:` signal with no new step kind** — and the
schema can be enforced by the CLI natively rather than by prompt text.

### But: can you trust an LLM to report its own test results?

**No, not unconditionally.** This is the sharpest finding of the audit, and it is empirical, not
theoretical.

**TEST C** — identical to TEST E except the allowlist was `"Bash(./run-checks.sh)"`, which failed to
match because the model issued `./run-checks.sh; echo "EXIT_CODE=$?"`. The command **never ran**. The
model still returned schema-valid output:

```json
{ "passed": false, "exitCode": 1, "output": "Could not run ./run-checks.sh — Bash execution permission was denied…" }
```

The `exitCode: 1` is **fabricated** — nothing produced it. The prose field was honest, but the
machine-readable field a loop would branch on was invented to satisfy the schema. A `dountil`
condition reading `passed` would have seen a plausible, well-formed, wrong answer, and a converge
loop would have iterated against a check that never executed.

Two secondary lessons from the same run: `Bash(cmd)` prefix rules are brittle against the model's own
command composition; and `permission_denials` in the `-p` JSON result is a real, machine-readable
tripwire for exactly this failure — a check step reading it would have caught the fabrication.

### Does Mastra provide a built-in shell/command step?

**Yes — and it is already installed.** `@mastra/core@1.63.2` ships `@mastra/core/workspace` with
`Workspace`, `LocalFilesystem` and `LocalSandbox` (`WorkspaceSandbox` interface, "Added in
`@mastra/core@1.1.0`").

`node_modules/@mastra/core/dist/workspace/sandbox/sandbox.d.ts:273`:

```ts
executeCommand?(command: string, args?: string[], options?: ExecuteCommandOptions): Promise<CommandResult>;
```

and `.../sandbox/types.d.ts` defines the result:

```ts
export interface ExecutionResult {
    success: boolean;      // Whether execution completed successfully (exitCode === 0)
    exitCode: number;      // Exit code (0 = success)
    stdout: string;
    stderr: string;
    executionTimeMs: number;
    timedOut?: boolean;
    killed?: boolean;
    // + stdout/stderrTruncated, stdout/stderrDroppedBytes
}
```

`LocalSandbox` takes `workingDirectory`, `env`, `timeout` (default 30000ms) and
`isolation: 'none' | 'seatbelt' | 'bwrap'` with `readOnlyPaths` / `readWritePaths` — i.e. native OS
sandboxing on macOS and Linux.

That is a deterministic `{passed: success, exitCode, output: stdout+stderr}` with **no model in the
loop**, from a dependency the repo already has.

Two caveats, stated honestly:

- The docs present `Workspace` as something you attach to a Mastra **`Agent`** (which then gets an
  `execute_command` tool). Yoke's Binding B does not use Mastra agents at all — `runLlmStep` spawns
  the `claude`/`codex` CLI directly, because auth is the owner's subscription. Calling
  `sandbox.executeCommand()` directly from inside a plain `createStep` is the non-agent path and is
  what the interface supports, but **[unverified]** — not exercised locally in this audit.
- Mastra Code's `execute_command` tool (30s timeout, `CI=true`) is part of the Mastra Code TUI
  product, not the workflow package. Don't confuse the two.

Also note the repo already spawns subprocesses in two places (`runClaudeCli`, `runCodexCli`), so a
`node:child_process` check step is ~15 lines of code the codebase already knows how to write. Mastra's
sandbox buys OS-level isolation and a richer result type, not the basic capability.

### n8n side (Binding C)

Confirmed: `n8n-nodes-base.executeCommand` exists. Per
https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.executecommand/ it "runs shell
commands on the host machine that runs n8n", takes a **Command** parameter and an **Execute Once**
toggle. Two material limitations: **"This node isn't available on n8n Cloud"** (self-hosted only),
and it is **"disabled by default from n8n 2.0"** for security reasons. In Docker, commands run inside
the n8n container, not the host.

**Does it change the picture?** Only mildly, and it argues *for* a command step rather than against.
Binding C today emits `n8n-nodes-base.noOp` for every non-`llm` kind (`src/bindings/n8n/build.ts`,
`buildStepNode`). A canon `check` kind would map to a real, first-class n8n node instead of a no-op —
whereas an `llm`-step-runs-the-tests approach maps onto the custom `n8n-nodes-yoke.yokeAgent` node
and keeps the fabrication risk. It does not make a new kind *necessary*; it makes one *cheap and
well-supported* on that binding.

### Tradeoffs, plainly

| | `llm` step + `workspace: write` + schema | dedicated `check`/`command` step |
| --- | --- | --- |
| New canon code | none (Q1's one-line change covers it) | a new `StepKind` + a builder per binding |
| Pass/fail source | model's report of an exit code | the exit code itself |
| Can fabricate a result | **yes — observed in TEST C** | no |
| Cost per loop iteration | a full model turn | ~0 |
| Handles "run the tests, then judge if the failures matter" | yes | no — needs a following `llm` step |
| Binding C mapping | custom yoke node | `n8n-nodes-base.executeCommand` (self-hosted only) |

### **Verdict: NOT NEEDED to unblock the loop — but a `check` kind is the right call for the termination signal specifically.**

The canon as it stands *can* close the loop today: an `llm` step with write/Bash access, a
`{passed, output}` schema (ideally enforced by `--json-schema` rather than prompt text), and
`until: "<stepId>.passed"` is sufficient, and it needs no new step kind. The ADR's premise —
"`test` is not an `llm` step" — is **not a capability gap**; it is a *trust* argument, and the trust
argument is correct: TEST C shows the model returning a fabricated `exitCode` for a command that
never ran. A loop that terminates on a model's self-report can terminate on a lie.

So the honest answer is two-part: **no new primitive is required to make `build` runnable**, and the
eventual `check` kind is a ~15-line `spawn` (or a `LocalSandbox.executeCommand` call) justified by
determinism and per-iteration cost, not by a missing capability. It is a cheap, well-scoped addition
to make deliberately later — not a blocker gating the whole library.

---

## Question 3 — retrospective on `kind: "loop"`

`buildLoopStep` in `src/bindings/mastra/build.ts` is ~100 lines. Was there a lower-code path?

**Mostly no, with one avoidable piece.** Mastra's `.dountil()` is precisely the construct for this,
and Yoke is already using it correctly. Per the reference
(https://github.com/mastra-ai/mastra/blob/main/docs/src/content/en/reference/workflows/workflow-methods/dountil.mdx):

```typescript
workflow.dountil(
  step: Step,
  condition: (params: ExecuteParams & { iterationCount: number }) => Promise<boolean>,
  options?: StepFlowEntryOptions
): Workflow
```

"It always runs the step at least once before evaluating the condition. The first time the condition
is evaluated, `iterationCount` is `1`." The `options` argument carries only `id`, `description` and
`metadata` — **there is no built-in `maxIterations` option**, so expressing the cap as
`|| iterationCount >= step.maxIterations` inside the condition, which `buildLoopStep` already does, is
the idiomatic way. Nothing more direct exists in Mastra for "repeat until a field is truthy, capped at
N". `.dowhile()` is the same construct inverted; `.foreach()` has a `concurrency` option but iterates
a known array, not to convergence.

The one genuinely avoidable piece: the `__<id>_counter` step appended to the body, the `iterKey`
threaded through the accumulator context, and the destructuring that strips it again in the outcome
step. The cap does **not** need it — the condition already uses Mastra's own `iterationCount`. That
machinery exists solely to report `{ converged, iterations }` from the outcome step, because
`.dountil()` doesn't expose `iterationCount` to downstream steps. Roughly 20 of the 100 lines buy one
reporting field.

Building the body as a committed child workflow (`createWorkflow(...).commit()`) is necessary —
`.dountil()` takes a single step or workflow — and reusing `buildLevelsOntoBuilder` for it is the
right call. The remaining bulk is TypeScript ceremony around Mastra's builder types (`any` casts,
already annotated with eslint-disable comments), not logic.

**Assessment: the right primitive was used; the implementation is roughly 20 lines heavier than
necessary, for a reporting field.** No rewrite warranted.

---

## Recommended next step

1. Do the Q1 change as a one-liner: widen `extraArgs` to `"Read,Glob,Edit,Write,Bash"` for
   `workspace: "write"`, widen the type to `"read" | "write"`, make codex's `-s read-only` conditional.
2. Close the `build` loop **now** with an `llm` step + `--json-schema` `{passed, output}` — no new
   step kind, so `develop → loop(test → audit)` becomes runnable this week.
3. Harden the read path while in the file: `--tools` instead of `--allowedTools`, `--permission-prompts none`.
4. Treat the `check` kind as a deliberate, ~15-line follow-up for determinism (TEST C: a model
   fabricated an exit code for a command that never ran), not as a blocker.
5. Amend ADR-0015: of its four "missing primitives", numbers 3 and 4 are not primitives.
