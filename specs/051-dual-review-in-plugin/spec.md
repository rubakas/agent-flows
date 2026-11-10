# 051. dual-review ships in the af plugin

| Field        | Value                                                               |
| ------------ | ------------------------------------------------------------------- |
| Feature Name | Move the `dual-review` skill into the af plugin as `af:dual-review` |
| Branch       | `main`                                                              |
| Status       | Implemented 2026-11-11                                              |
| Created      | 2026-11-11                                                          |

## Why

The `dual-review` skill lived only at `~/.claude/skills/dual-review/SKILL.md`, outside any
repository. It started the agent-flows half of a review on the daemon
(`mcp__agent-flows__start_run`), which Claude Code cannot see, so the owner got no workflow
progress (ascent-portal PR #1563, 2026-11-10). On 2026-11-11 the skill was changed to run that
half through `/af:review` (the `af:review-engine` workflow). It now moves into the af plugin so
the fix is under version control.

## Requirements

| ID   | Requirement                                                                                                                    | Check                                                                                                                                                                                                                      |
| ---- | ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FR-1 | `plugin/skills/dual-review/SKILL.md` holds the skill, identical to the fixed personal copy except FR-2 and Prettier formatting | `diff <(grep -v '^group: process$' ~/.claude/skills/dual-review/SKILL.md \| pnpm exec prettier --stdin-filepath SKILL.md) plugin/skills/dual-review/SKILL.md` prints nothing; run it before FR-5 removes the personal copy |
| FR-2 | Its frontmatter is `name` and `description` only, as in `plugin/skills/review/SKILL.md` (`group: process` is dropped)          | lines 1-4 are `---`, `name: dual-review`, `description: ...`, `---`                                                                                                                                                        |
| FR-3 | It starts the agent-flows half only through `af:review`, never through the daemon's MCP tools                                  | `grep -nE 'start_run\|get_run\|mastra\|7411\|gateMode'` matches only the "Never start it through the agent-flows MCP tools" sentence; the pre-fix copy matches on 7 lines                                                  |
| FR-4 | Plugin version 0.2.2 to 0.2.3                                                                                                  | `plugin/.claude-plugin/plugin.json`                                                                                                                                                                                        |
| FR-5 | The personal copy `~/.claude/skills/dual-review/` is removed after FR-6 passes, so only `af:dual-review` exists                | the directory is absent                                                                                                                                                                                                    |
| FR-6 | Claude Code's installed af plugin is 0.2.3 and contains the skill                                                              | `~/.claude/plugins/installed_plugins.json` shows `af@agent-flows` at 0.2.3, and its install path contains `skills/dual-review/SKILL.md`                                                                                    |

Claude Code runs the plugin from a cache keyed by version
(`~/.claude/plugins/cache/agent-flows/af/0.2.2`), so the version must go up (precedent: spec 049
FR-6, 0.2.1 to 0.2.2).

## Out of scope

- The agent-notes half of the review: it needs agent-notes' `code-review` skill and agents, and
  fails without them.
- Codex loads plugin skills too, and there the skill stops at its step 3 because Codex has no
  workflow tool.
- Refreshing Codex's plugin cache.
- Daemon code.

## Test plan

- `bash scripts/test.sh` passes.
- The FR-1, FR-2 and FR-3 checks above.
- FR-6 after `claude plugin update af@agent-flows`.
- The owner sees `af:dual-review` in the skill list in a new session.
