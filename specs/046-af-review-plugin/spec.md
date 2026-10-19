# 046. Code review as a native Claude Code / Codex plugin

| Field        | Value                                                             |
| ------------ | ----------------------------------------------------------------- |
| Feature Name | `af-review` — code review as a native Claude Code / Codex plugin  |
| Branch       | `main`                                                            |
| Status       | Implemented 2026-10-09 — Claude smoke passed, Codex smoke partial |
| Created      | 2026-10-09                                                        |

## Origin

af's `code-review` pipeline runs from an AI CLI chat; the owner has run 48 reviews on one Rails
repository, all via Claude Code (Codex was never used because af's Codex binding was not ready).
The daemon and web page are not used. The owner wants review to run natively in the CLI he is
chatting in, ready for both Claude Code and OpenAI Codex.

af's Binding A refuses `code-review` (src/bindings/claudeCode.ts:115–132) because git capture runs
in the daemon via `spawnSync` argv (runtime/reviewMaterial.ts), and a generated workflow script
cannot invoke git without handing a shell string to a model—the injection danger Binding A forbids.
This spec moves the pipeline into a plugin — one shared entry, two engines (Claude dynamic workflow,
Codex subagent procedure), no daemon.

## Context

**Claude Code:** Dynamic workflows (https://code.claude.com/docs/en/workflows) are JS scripts with
`agent()`, `parallel()`, `pipeline()`, per-agent `model`, `agentType`, and `schema` (validated, 5
retries). Scripts have no fs or shell.

**Codex:** Version 0.160.0 has no workflow engine. It loads Claude-format plugins (reads
`.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json`, uses `skills/`, ignores
`agents/` and `workflows/`). Custom Codex agents cannot ship in a plugin and cannot set their own
sandbox (role config is limited to instructions/model/reasoning_effort since openai/codex PR #39299).

**Probe (2026-10-09):** All 18 checks passed. Plugin skill invoked in `claude -p`, reported its
base directory, started a plugin workflow by name. Plugin agent with `tools: Read, Grep, Glob` +
`omitClaudeMd: true` via `agent(…, {agentType:'afprobe:reader'})` reported Read/Grep/Glob/StructuredOutput,
no shell, and NO CLAUDE.md (control agent without `omitClaudeMd` quoted the Primary Assistant
Instructions). Deny rule from settings reached plugin workflow agents (denied with rule; readable
without). `if/then` in schema IS enforced: validation error named the failing keyword. Codex: skill
found its `scripts/` by path, ran a node git-capture script under default sandbox (rename shown as
R100), `spawn_agent` accepted explicit `model`, subagent wrote its output, a write into `.git` was
blocked, self-ignoring `.gitignore` (`*`) kept `git status` clean.

## Decisions

**D1 — One plugin, two engines, no daemon.** Plugin `af` at `plugin/` in this repo; marketplace
file `.claude-plugin/marketplace.json` lists it with a RELATIVE path source (`"./plugin"`) —
Codex skips Claude's `{"source":"github"}` entries and needs a relative path. Both CLIs install
from this repo. Entry: skill `review` → `/af:review` (Claude Code), `$af:review` (Codex).
Names avoid agent-notes' `code-review` skill and Claude's built-in review commands.

**D2 — Single prompt and schema source.** Prompts are byte copies at
`plugin/skills/review/references/prompts/{brief,radius,falsifiability,delivery,correctness,security,verify,synthesis}.md`
(matching `prompts/code-review-*.md`). Schemas are DERIVED at
`plugin/skills/review/references/schemas/{findings,delivery}.json` (af's schema + rule `allOf`
entries) and pinned by a test that strips the rules and deep-equals af's object. Claude workflows
cannot read files, so `plugin/workflows/review-engine.js` is GENERATED from these files by
`src/af-plugin/buildReviewEngine.ts` (`pnpm plugin:generate`). A test fails when the committed script differs from
generator output.

**D3 — Cross-field rules move into schemas as `if/then`/`pattern`.** Reverses the choice in
`validateOutput.ts:72–77` (cross-field rules checked in code because ajv's "must match then schema"
is not actionable; here, Claude's retry message names the failing keyword, so the rule moves into
the schema's `description`). The 8 rules from `validateOutput.ts` functions `crossFieldErrors`
(lines 78–114) and `deliveryCrossFieldErrors` (lines 156–202): findings — (1) verdict CONFIRMED ⇒
evidenceBasis ∈ {file-content, absence-of-file}; (2) remedyScope all-sites-verified ⇒ every
sites[].remedySafe === true; (3) remedyScope single-site ⇒ sites maxItems 1. Delivery — (4)
specSourcesProvided false ⇒ codeReviewDelivery maxItems 0; (5) classification silently-decided ⇒
decisionTaken required, non-blank, not "not a decision" (case-insensitive via trim + lowercase ===,
mirrors af's `isUndecided` exactly); (6) same for optionsForeclosed; (7) classification
implemented|partial ⇒ evidence matches `[\w.-]+\/[\w.-]+|[\w-]+\.[A-Za-z]\w*:\d+` unanchored; (8)
classification correctly-deferred ⇒ requirement non-blank. Codex (no subagent schema) validates via
`plugin/skills/review/scripts/check.mjs` (Node ≥ 18, node builtins only, supports exactly the
keywords the two schemas use, reports a failed rule by its `description` text for actionability,
prints errors as `path: message` lines; exit 0 valid, 1 invalid).

**D4 — Deterministic capture.** `plugin/skills/review/scripts/capture.mjs` (Node ≥ 18, node
builtins only, git via `spawnSync` argv, never shell). Trimmed port of `src/runtime/reviewMaterial.ts`:
CLI: `node capture.mjs [--base <rev>] [--spec <ref>]... [--spec-file <path>]... [--plan-file <path>]`
(--spec takes GitHub refs only; literal spec text via repeatable --spec-file; `--spec-file`/`--plan-file`
must be regular files ≤1 MB inside repo or OS temp dir, not credential-named; user text never on
command line). Refuses when repo tracks `.af-review` or it is a symlink. Creates `.af-review/` at repo
toplevel with `.gitignore` (`*`, written with wx/regular-file check), `.af-review/<runId>/` (runId =
`<yyyymmdd-hhmmss UTC>-<7-char HEAD>-<4hex>`, non-recursive mkdir with realpath containment), material.md
(sections mirror `renderReviewMaterial` order), full artifacts (diff.patch, commits.txt, changed-files.txt,
history.txt, specs/*.md), tree-before.json, meta.json with fields `{runId, runDir, baseline,
baselineRule, head, specSourcesProvided, truncated, withheld}` printed as one line to stdout. Non-zero
exit with a reason when baseline rejected or diff empty (exit 2 for empty diff — deliberate). Material.md
sections capped at 65,536 characters (src/runtime/reviewMaterial.ts:40 REVIEW_MATERIAL_CAP, `text.length`);
artifact files written in full. Control characters in names/subjects escaped in material. Baseline
validation: ≤256 chars, safe character class, no leading `-`. Derivation: merge-base with origin default
branch, else HEAD~1; rule recorded. Peel to commit OID; three-dot diff; `--text` hardening (`.gitattributes
-diff` cannot blank it); `--no-ext-diff --no-textconv --no-color` hardening; git hardened (`-c
core.fsmonitor=false`, `GIT_OPTIONAL_LOCKS=0`, `GIT_CONFIG_NOSYSTEM=1`, `GIT_PAGER=cat`, 120 s timeout);
`icase` glob pathspecs (case variants) and extended deny patterns (`**/.env.*`, `**/*.env`,
`**/.git-credentials`, `**/.pypirc`, `**/.docker/config.json`, `**/.dockercfg`) — case-folded SUPERSET of
af's, pinned as such; rename counterparts via separate unexcluded `--name-status` pass (never `-p`), fail
closed when rename detection is skipped by the limit while a credential path is in range; withheld
disclosed by path only; history probes ≤200 paths via `git log --all --diff-filter=AD --name-status`;
commit probes ≤50 via `git show --stat` on peeled OIDs in range; spec sources via `gh pr view`/`gh issue
view` argv, 20 s timeout, ≤10 fetches, non-ref text kept literal. Dropped: caller-supplied introducedCommits.
meta.`hasSpecs` is true only if ≥1 source resolved to non-empty text. `node capture.mjs check-tree <runDir>`:
compares working tree to tree-before.json (hash of `git diff HEAD --binary` + untracked files with content
hashes, `.af-review/` excluded), reports `{changed:[paths]}`.

**D5 — Claude engine.** `plugin/agents/reviewer.md`: tools Read/Grep/Glob, `omitClaudeMd: true`.
`review-engine.js` (meta.name `review-engine`) takes args `{runDir, plan?, hasSpecs}`, fails fast
without runDir. Runs with agentType `af:reviewer` throughout. Step order: brief (model haiku, scout,
fail-continue) → radius + falsifiability + delivery (all model sonnet, worker, parallel; delivery uses
delivery schema; skipped when `!hasSpecs`, renders `{"specSourcesProvided":false,"codeReviewDelivery":[]}`)
→ correctness + security (model sonnet, worker, parallel; start when radius is done) → verify (model opus,
reasoner, findings schema; after all workers) → synthesis (model opus, reasoner, given ONLY verify output;
isolated per pipelines/code-review.yaml:133–138). Failed radius ABORTS (af: radius required, verify has no
radius input). brief, falsifiability, delivery, correctness, security degrade to af's `unavailableStepMarker`
text byte-identical (src/bindings/mastra/buildSteps.ts:414–421), which verify.md:24 knows how to record;
verify failure aborts. Placeholders replaced at EVERY occurrence (like af's `renderPrompt`, src/canon/render.ts),
so pointer texts are noun phrases; the material pointer tells the agent to read the whole file with paged Read.
`{{plan}}` renders as empty string when none given (af parity). Returns `{synthesis, verify}`; step outputs
stay in journal. Upstream outputs inlined as text (JSON stringified).

**D6 — Codex engine.** `plugin/skills/review/references/codex.md` procedure: same steps via
`spawn_agent`. Schema steps (verify, delivery) read the schema file and write bare JSON with the
top-level shape; failures use the same `unavailableStepMarker`. Tier → `reasoning_effort` (scout low,
worker medium, reasoner high; omit if rejected); tier-less Codex runs every step on the session's
model (cost differs from af — note it). Subagents are told to read prompt files, read
`<runDir>/material.md` / `<runDir>/out/<step>.*` wherever prompt has a placeholder, write whole
output to `<runDir>/out/<step>.md` (or `.json` for verify/delivery), modify nothing else, reply only
DONE. JSON checked with `check.mjs` (exits 1 for any data problem: missing file, unparseable JSON,
violations, messages on stdout; exits 2 only for usage errors); on errors, one follow-up to the SAME
subagent with check.mjs error lines (failures reported by rule `description`); still invalid ⇒ stop,
never synthesize from bad data. Codex waits for every subagent of a wave (`wait_agent`) before the
next. synthesis reads only `out/verify.json`.

**D7 — Skill entry point.** `plugin/skills/review/SKILL.md` (user text never on command line —
files under $TMPDIR for --spec-file/--plan-file; refs/base single-quoted and only if they match a
safe character class): (1) run capture with user's base/spec/plan; (2) engine detection: Workflow
tool present → start `af:review-engine` with `{runDir, plan, hasSpecs}` (Claude); `spawn_agent`
capability → follow codex.md procedure (Codex); neither → stop; (3) run check-tree; (4) write
`<runDir>/report.md` = tree-check warning (if any) + synthesis + pointer to `out/verify.json`,
show synthesis. Outputs: `out/verify.json` written verbatim then checked with check.mjs;
`out/synthesis.md`. The run directory doubles as run history.

**D8 — Material protection.** Material never contains credential paths. Claude: owner's existing
`.env*`, `*.pem`, `*.key`, `**/.ssh/**` deny rules reach reviewer agents (probe confirms).
Codex: subagents inherit session sandbox, can read any file, cannot write `.git`; writes detected
by check-tree, not prevented. On Codex, synthesis isolation is instruction-only (it could read
worker outputs on disk). Known gaps, not fixed here.

**D9 — Prompt/credential-list copies pinned.** af's `code-review` pipeline untouched. Tests assert
copied prompts byte-equal to `prompts/code-review-*.md` and the plugin's case-folded credential deny
list is a SUPERSET of af's `CREDENTIAL_DENY_PATTERNS` (`src/canon/denyPatterns.ts`) and pinned as
such, so neither drifts silently.

## Functional Requirements

- **FR-1.** `/af:review [base]` in Claude Code writes `.af-review/<runId>/report.md` with the
  synthesis and a schema-valid verify JSON; no daemon involved.
- **FR-2.** `$af:review [base]` in Codex writes the same files; `out/verify.json` passes `check.mjs`.
- **FR-3.** Claude reviewer agents have only Read/Grep/Glob and no CLAUDE.md.
- **FR-4.** material.md never contains a credential path's content; withheld paths are listed.
- **FR-5.** The committed `review-engine.js` equals the generator output (gate: test fails if edited).
- **FR-6.** Rule parity: for a hand-written valid findings object and a valid delivery object, plus
  one mutation per rule (8), af's `validateCanonOutput` (src/canon/validateOutput.ts:210) and the
  plugin's checks (ajv on schemas AND `check.mjs`) agree on valid/invalid for every case. The
  unmutated fixtures pass; each mutation fails.
- **FR-7.** Prompt and credential-list copies are pinned to their af sources (D9).
- **FR-8.** check-tree reports a modified tracked file and a new untracked file, and ignores `.af-review/`.

## Tests

Under `src/af-plugin/*.test.ts` (picked by `scripts/test.sh`): workflow freshness (FR-5); rule
parity (FR-6, 8 mutations); copies pinned (FR-7); capture on temp repo — `.env` in range excluded +
withheld, renamed to `secrets.json` excluded both halves, baseline `--upload-pack=x` / `-x`
rejected, merge-base derivation, >64 KB diff truncated, check-tree (FR-8). Each gate neutered once
to show failure.

## Out of scope

Retiring `code-review` pipeline; other pipelines; Codex per-path read denial; cross-session
resume; cost aggregation; UI.

## Install and verification

Claude: `claude plugin marketplace add <repo>`; `claude plugin install af@<marketplace>`. Codex:
`codex plugin marketplace add <repo>` then install `af`. Local installs are cached copies — after
editing, update the marketplace / reinstall; for development use `claude --plugin-dir plugin`.
Live verification: one smoke run per engine on a small range in this repo. The ascent-portal
benchmark against stored af runs (retained findings, severity, verdict, time, cost) is the owner's
call afterwards.

Smoke results (2026-10-09, base `a33da86`, installed from the local marketplace):

- **Claude: passed.** `/af:review a33da86` ran 7 steps (no specs, so no delivery), all as
  `af:reviewer` with brief haiku, workers sonnet, verify and synthesis opus; 11 verify entries,
  `check.mjs findings` exit 0; 15 min 57 s, $4.39. check-tree flagged a real concurrent edit to
  `eslint.config.js` made during the run. Headless runs (`claude -p`) need
  `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0`: without it the CLI stops the background workflow 10
  minutes after the last turn (the first attempt was killed during verify).
- **Codex: partial.** `$af:review` was picked up; capture ran in the default sandbox; waves ran in
  order (brief, then radius + falsifiability, then correctness + security) with `reasoning_effort`
  accepted and no model id (every subagent ran on the session's model); skipped delivery was written
  and passed `check.mjs delivery`. The run stopped at the third wave on the account's usage limit, so
  verify, synthesis and FR-2 remain unproven live.

## Risks

- **No run bounds beyond Claude's workflow stall watchdog.** No turn cap / cost ceiling; af had a
  watchdog + cost ceiling. Accepted tradeoff for plugin portability.
- **`.af-review/` accumulates run dirs with no cleanup.** Owner's responsibility to manage.
- **check-tree flags the owner's own concurrent edits.** Cannot distinguish writer from reviewer
  writes; smoke run confirms acceptable.
- **Codex `reasoning_effort` and wait waves not yet probed.** Smoke run covers.
- **Codex subagents can read any file and write the working tree.** Writes detected by check-tree,
  not prevented (D8). Known, documented.
- **Codex follows step order from instructions, not enforced.** Subagent may skip or reorder steps.
- **Local plugin installs are cached copies.** Editing `plugin/` requires marketplace update or
  reinstall to see changes.

**Follow-up (not fixed by this spec):** The case-variant, rename-limit, `-diff` attribute, and
deny-list-gap leaks also exist in af's own `src/runtime/reviewMaterial.ts` — documented as known
gaps, not fixed there.
