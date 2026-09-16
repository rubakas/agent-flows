# 0018. One global install, harnesses hold pointers

Status: Accepted — 2026-09-16

## Context

Today `agent-flows` is reached from chat by hand-editing a per-repository `.mcp.json` whose
`command` is an absolute path into a specific `agent-flows` checkout (README.md:118-144). Every
project that wants the tool needs its own copy of that path, and the path breaks the moment the
checkout moves.

`docs/research/2026-09-16-harness-discovery-mechanisms.md` maps how four harnesses — Claude Code,
OpenAI Codex CLI, OpenCode, and T3 Code — discover a locally installed tool:

- All three native harnesses (Claude Code, Codex CLI, OpenCode) support **user-scope** MCP
  registration: `~/.claude.json` via `claude mcp add --scope user`, `~/.codex/config.toml` via
  `codex mcp add`, `~/.config/opencode/opencode.json` via `mcp.<name>` (research §1.1, §2.1, §3.1).
  A user-scope entry is live for every project, not just the one it was written from.
- All three inject the MCP server's `instructions` string into the model's context at session
  start, each with a different shape and a different size limit: Claude Code truncates at 2 KB
  (research §1.2, P1); Codex attaches it as the tool-namespace description and asks that "the first
  512 characters" be self-contained (research §2.2, P7); OpenCode wraps it in an
  `<mcp_instructions>` block (research §3.2, P21/P22). This session's own observation confirmed the
  Claude Code half of that mechanism directly: the assistant's system context carried an injected
  "MCP Server Instructions" block for two connected servers (research §6). Our own server passes no
  `instructions` today (`src/bindings/mastra/server.ts:220-232`).
- All three support symlinked skill directories (research §1.3 P2, §2.3 P11, §3.3 P23) and read a
  personal, all-projects skill directory (`~/.claude/skills/`, `~/.agents/skills/`,
  `~/.config/opencode/skills/`), and OpenCode additionally reads `~/.claude/skills/` and
  `~/.agents/skills/` directly (research §3.3, P19/P23).
- T3 Code has no MCP/skills/instruction-file configuration of its own; it runs one of the other
  three harnesses as a provider and inherits that provider's configuration verbatim (research §4,
  P32/P33/P34). Registering a tool for T3 Code is therefore the same act as registering it for
  whichever native harness backs the T3 session.

## Decision

`agent-flows` is installed once per machine as a real npm package (specs/038). Every harness reaches
that one install through a **pointer written into the harness's own user-scope configuration** —
never through files copied into a harness's dot-directory:

1. **MCP.** Each native harness's own registration command or config file points at the one
   globally-installed binary: `claude mcp add agent-flows --scope user -- agent-flows mcp`,
   `codex mcp add agent-flows -- agent-flows mcp`, an `mcp.agent-flows` entry in
   `~/.config/opencode/opencode.json`. One binary, three pointers, no copies.
2. **T3 Code** needs nothing of its own: once its selected provider (Claude Code, Codex CLI, or
   OpenCode) has the pointer, T3 sessions backed by that provider inherit it.

This is the entire footprint: `agent-flows` writes exactly one MCP registration per harness and
nothing else. It does not install a skill, an agent, a rule, or any file into a harness's
dot-directory. That boundary is deliberate, not an oversight: the owner's `agent-notes` project
already owns every harness dot-directory (skills, agents, rules, `CLAUDE.md`/`AGENTS.md`, hook and
permission entries) and manages no MCP servers of its own, so the two tools divide the machine
cleanly along the same line (specs/038 D17). Discovery from chat rests entirely on the MCP
`instructions` string (below), which is the one thing `agent-notes` does not and cannot provide for
a foreign tool.

## Consequences

- The MCP server must carry a self-contained `instructions` string, bounded by Claude Code's 2 KB
  cap, with the first 512 characters self-contained per Codex's guidance — one string serves all
  three harnesses' different injection shapes because all three cap or front-load it the same way.
- The package must run without a source checkout, without `tsx`, and without `nvm` — a user-scope
  pointer can be invoked from any working directory, with no `cd` into a checkout to make relative
  paths resolve.
- A `setup` verb owns writing each harness's pointer, and `setup --remove` reverses exactly what it
  wrote — registration stops being a manual, per-repository edit.
- Per-project `.mcp.json` files become optional: a project that wants a project-scoped override can
  still write one (Claude Code and Codex both merge project and user scope), but nothing requires it
  any more.
- A skill for `agent-flows`, if wanted later, is `agent-notes`' feature to add, not `agent-flows`'s:
  it needs a change in `agent-notes` (installing skill content that `agent-flows`' package supplies),
  and is out of scope here.

## Alternatives rejected

- **Copy pipelines into each harness's dot-directory.** N copies drift out of sync with the package
  the moment either side changes; this is the exact problem the current `.mcp.json`-per-repo setup
  already has, generalized to four harnesses.
- **Have `agent-flows` install its own skill into each harness's skill directory.** Rejected once the
  `agent-notes` boundary was confirmed: `agent-notes` already owns every harness dot-directory
  (skills, agents, rules) and would sweep a foreign skill directory placed there during an uninstall
  performed in its copy mode; a second, independent tool writing into the same directories is exactly
  the kind of drift this ADR exists to avoid (specs/038 D17).
- **Keep today's per-project checkout.** Requires an absolute path into a specific checkout per
  repository (README.md:118-144); breaks when the checkout moves; does not scale past one machine's
  worth of manual edits.
- **Publish to the public npm registry.** Out of scope for this decision; installing from a tarball
  or a git URL is sufficient for a single-machine, single-owner tool and avoids the account and
  release-process overhead of a public package.
