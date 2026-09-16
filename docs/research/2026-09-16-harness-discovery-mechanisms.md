# Research: how four AI coding harnesses discover a locally installed tool (MCP server + workflows + skills)

Date: 2026-09-16. Question: for a locally installed CLI (`agent-flows`: one binary, one stdio MCP
server, a set of workflow files), what user/global-scope mechanisms does each harness offer so that
(a) the harness knows about the tool at session start and (b) the user can invoke it from chat —
without copying files into each harness's dot-folder.

Harnesses: Claude Code, OpenAI Codex CLI, OpenCode, T3 Code. Everything below is cited to a primary
source (official docs page + heading, or a source file + function) unless marked UNVERIFIED. Nothing
is a recommendation.

Notation: "P" = primary source, "S" = secondary source (see the Sources block at the end).

Two host notes that affect citations:

- Every `https://developers.openai.com/codex/<page>` URL now answers `308 Permanent Redirect` to
  `https://learn.chatgpt.com/docs/<...>`. Both URLs are given below; the content was read from the
  `learn.chatgpt.com` page.
- `github.com/openai/codex/blob/main/docs/config.md` is a stub whose first paragraph points to the
  hosted docs (`/codex/config-basic`, `/codex/config-advanced`, `/codex/config-reference`); it holds
  no `mcp_servers` example itself.

---

## 1. Claude Code

### 1.1 MCP registration at user scope

- Config file: `~/.claude.json`. Table under **"## MCP installation scopes"**: `User | All your
projects | No | ~/.claude.json` (P1, https://code.claude.com/docs/en/mcp#mcp-installation-scopes).
- CLI, user scope, stdio server with env and args (P1, **"### User scope"** and **"### Option 3: Add
  a local stdio server"**):
  ```bash
  claude mcp add example --env API_KEY=your-key --scope user -- npx -y @example/mcp-server
  ```
  The `--` separator is required before the command; everything after it is the server command +
  args. `--env` goes after the name and before `--` (P1, **"### Add a server from setup instructions
  written for another client"**).
- JSON form (also accepted by `claude mcp add-json <name> '<json>'`, P1 **"## Add MCP servers from
  JSON configuration"**):
  ```json
  {
    "type": "stdio",
    "command": "/path/to/weather-cli",
    "args": ["--api-key", "abc123"],
    "env": { "CACHE_DIR": "/tmp" }
  }
  ```
  Whether `add-json` accepts `--scope user` is not shown in the doc's examples: UNVERIFIED (the
  `add` examples show `--scope`; the `add-json` examples do not).
- Project file: `.mcp.json` at project root,
  `{"mcpServers":{"<name>":{"command":..,"args":[..],"env":{..}}}}` (P1, **"### Project scope"**).
- Merge rule (P1, **"### Scope hierarchy and precedence"**): servers from all scopes are loaded;
  when the _same server name_ appears in several scopes, one definition wins in order local >
  project > user > plugin-provided > claude.ai connectors, and "The entire server entry from that
  source is used; fields are not merged across scopes."

### 1.2 Does Claude Code inject the MCP `instructions` field?

Supported, documented. P1, **"## Scale with MCP tool search"**: "Only tool names and server
instructions load at session start, so adding more MCP servers has minimal impact on your context
window." And **"### For MCP server authors"**: "Server instructions help Claude understand when to
search for your tools, similar to how skills work. [...] Claude Code truncates tool descriptions and
server instructions at 2KB each. Keep them concise to avoid truncation, and put critical details near
the start."

Corroborating observation (not a citation): the session in which this note was written shows the
harness-inserted block "# MCP Server Instructions — The following MCP servers have provided
instructions for how to use their tools and resources" for each connected server that returned
`instructions`.

Claude Code source is closed, so no source line can be cited.

### 1.3 Skills (SKILL.md)

- Locations (P2, **"Choose where skills load"**): personal `~/.claude/skills/<skill-name>/SKILL.md`
  (all projects); project `.claude/skills/<skill-name>/SKILL.md`; nested `<subdir>/.claude/skills/`;
  enterprise managed dir; `--add-dir` dirs; plugin `<plugin>/skills/<name>/SKILL.md` (as
  `/plugin-name:skill-name`).
- Invocation from chat: `/skill-name [args]`; `$ARGUMENTS`, `$0..$n`, named `$name` (P2, **"Pass
  arguments to skills"**).
- Symlinks: explicitly supported. P2, **"Skill folders also follow these rules"**: "Symlinked
  folders: a `<skill-name>` entry in the enterprise, personal, or project location can be a symlink
  to a directory elsewhere on disk. Claude Code reads `SKILL.md` from the target and loads the skill
  once even if several locations point at the same target."
- Reads other harnesses' skill dirs (`.agents/skills`, `.opencode/skills`)? Not documented on the
  skills page. `/import` (P3, **"### AGENTS.md"**) "carries over MCP servers, commands, subagents,
  and skills" from another agent's configuration as a one-time copy — a copy, not a live read.
- Name collisions (P2, **"Resolve skills that share a name"**): enterprise > personal > project;
  custom skills override bundled ones.

### 1.4 Shared instruction files

- User file `~/.claude/CLAUDE.md`; project `./CLAUDE.md` or `./.claude/CLAUDE.md`;
  `./CLAUDE.local.md`; managed policy path per OS (P3, **"### Choose where to put CLAUDE.md
  files"**).
- Imports (P3, **"### Import additional files"**): `@path/to/import`, relative or absolute, home
  paths such as `@~/.claude/my-project-instructions.md`, recursive up to four hops; imports in
  _project_ files that resolve outside the working directory trigger a one-time approval dialog;
  imports in user-scope files (`~/.claude/CLAUDE.md`, `~/.claude/rules/`) load without the dialog.
- AGENTS.md (P3, **"### AGENTS.md"**): "Claude Code reads `CLAUDE.md`, not `AGENTS.md`." The doc's
  two workarounds are `@AGENTS.md` as the first line of `CLAUDE.md`, or `ln -s AGENTS.md CLAUDE.md`.
- `~/.claude/rules/*.md` load into every session; `.claude/rules/` supports symlinks (P3,
  **"#### User-level rules"**, **"#### Share rules across projects with symlinks"**).

### 1.5 Session-start hook that injects stdout

Supported. P4 (hooks reference), **"Exit code 0"**: "The exceptions are `UserPromptSubmit`,
`UserPromptExpansion`, `SessionStart`, and `PostModelSwitch`, where Claude Code adds plain-text
stdout as context that Claude can see and act on." JSON form:
`hookSpecificOutput.additionalContext` (P4, **"JSON output"**). `SessionStart` matcher values:
`startup`, `resume`, `clear`, `compact`, `fork` (P4, **"Matcher patterns"**).

Global config file: `~/.claude/settings.json` (P5, **"### Configure hook location"**:
`~/.claude/settings.json | All your projects`). Example from P5, **"### Re-inject context after
compaction"** (matcher can be dropped to fire on every start):

```json
{
  "hooks": {
    "SessionStart": [
      { "matcher": "compact", "hooks": [{ "type": "command", "command": "echo 'Reminder: ...'" }] }
    ]
  }
}
```

P5 also says: "For injecting context on every session start, consider using CLAUDE.md instead."

### 1.6 Slash commands

- Legacy `~/.claude/commands/<name>.md` (personal) and `.claude/commands/<name>.md` (project) still
  work; "Custom commands have been merged into skills" — `.claude/commands/deploy.md` and
  `.claude/skills/deploy/SKILL.md` both create `/deploy` (P6, note at top of the custom-commands
  section; P2 **"How a skill gets its command name"**). Subdirectories namespace:
  `.claude/commands/frontend/component.md` → `/frontend:component`.
- Markdown + YAML frontmatter; `$ARGUMENTS`; `!` bash injection; `@file` references (P6).
- MCP prompts as commands (P1, **"## Use MCP prompts as commands"** → **"### Execute MCP
  prompts"**): "Claude Code lists each MCP prompt as `/servername:promptname (MCP)`. Typing
  `/mcp__servername__promptname` also runs it." Arguments are whitespace-split positional tokens;
  "Prompt results are injected directly into the conversation."

---

## 2. OpenAI Codex CLI

### 2.1 MCP registration at user scope

- Config file: `~/.codex/config.toml` (i.e. `$CODEX_HOME/config.toml`; `CODEX_HOME` defaults to
  `~/.codex`) (P9, **"Config and state locations"**; P8).
- TOML (P7, MCP page, config example):
  ```toml
  [mcp_servers.context7]
  command = "npx"
  args = ["-y", "@upstash/context7-mcp"]
  env_vars = ["LOCAL_TOKEN"]

  [mcp_servers.context7.env]
  MY_ENV_VAR = "MY_ENV_VALUE"
  ```
  Fields documented in P8, **`mcp_servers.<id>`**: `command`, `args`, `env`, `env_vars` (whitelist of
  host env vars to forward), `cwd`, `enabled`, `startup_timeout_sec` (default 10 s),
  `tool_timeout_sec` (default 60 s).
- CLI (P7): `codex mcp add <server-name> --env VAR1=VALUE1 --env VAR2=VALUE2 -- <stdio
server-command>`; example `codex mcp add context7 -- npx -y @upstash/context7-mcp`. This writes to
  the user-level config; there is no `--scope` flag documented.
- Project-level file: `.codex/config.toml`. P9, **"Project config files (.codex/config.toml)"**:
  "Codex walks from the project root to your current working directory and loads every
  `.codex/config.toml` it finds. If multiple files define the same key, the closest file to your
  working directory wins." and "For security, Codex loads project-scoped config files only when the
  project is trusted." P7 confirms project-scoped `mcp_servers` are honored "only in trusted
  projects". Layer order (P9): user `~/.codex/config.toml` < profile
  `~/.codex/<profile>.config.toml` < project `.codex/config.toml` layers < CLI flags /
  `--config`. So user and project layers are merged key-by-key; a whole `[mcp_servers.<id>]` table
  is a key.

### 2.2 Does Codex inject the MCP `instructions` field?

Supported, documented, with a specific shape. P7 (MCP page): "Codex reads the MCP `instructions`
field during initialization and applies it as server-wide guidance alongside available tools. [...]
If you build or maintain an MCP server for Codex, use `instructions` for cross-tool workflows,
constraints, and rate limits that apply across the server. Keep the first 512 characters
self-contained so the most important guidance is available when Codex is deciding how to use the
server."

Source (P10, `codex-rs/codex-mcp/src/rmcp_client.rs`):
`regular_mcp_tool_info_from_listed_tool(server_name, server_instructions, tool)` — doc comment
"using the MCP server name and instructions for the model-visible namespace" — sets
`callable_namespace: server_name` and `namespace_description: server_instructions.map(str::to_string)`
on every `ToolInfo`. `server_instructions` is stored on the managed client (`pub(crate)
server_instructions: Option<String>`, line 124) and passed through `tool_catalog.rs` at refresh time
(`managed_client.server_instructions.as_deref()`). I.e. the instructions surface to the model as the
_description of the server's tool namespace_, attached to the tool listing, not as a standalone
system-prompt block. Whether instructions surface for a server that exposes zero tools: UNVERIFIED
(not found in the code read).

### 2.3 Skills

- Locations and precedence (P11, highest to lowest): `$CWD/.agents/skills` and every parent up to
  `$REPO_ROOT/.agents/skills`; `$HOME/.agents/skills`; `/etc/codex/skills`; bundled system skills.
  "Codex scans `.agents/skills` in every directory from your current working directory up to the
  repository root."
- `SKILL.md` frontmatter: `name`, `description` (P11). Optional `agents/openai.yaml` with
  `allow_implicit_invocation` (default `true`).
- Invocation: explicit `$skill-name` in Codex CLI (`@skill-name` in ChatGPT); implicit selection by
  the model. The skills listing "uses at most 2% of the model's context window, or 8,000 characters
  when the context window is unknown" (P11).
- Symlinks: P11: Codex "supports symlinked skill folders and follows the symlink target when
  scanning these locations."
- Reads `.claude/skills` or `.opencode/skills`? Not mentioned anywhere in P11 — treat as not
  supported (no doc claim; UNVERIFIED against source).

### 2.4 Shared instruction files

P12 (AGENTS.md page): global `~/.codex/AGENTS.override.md` if present, otherwise
`~/.codex/AGENTS.md`; then, from the Git root down to the current directory, at each level
`AGENTS.override.md`, then `AGENTS.md`, then `project_doc_fallback_filenames`. Files are concatenated
root-down with blank-line separators; "Files closer to your current directory override earlier
guidance because they appear later in the combined prompt." Combined size cap
`project_doc_max_bytes`, "32 KiB by default" (P12; field also in P8). No `@file` import syntax is
documented for AGENTS.md.

### 2.5 Session-start hook that injects stdout

Supported. P13 (Hooks page):

- Discovery locations: `~/.codex/hooks.json`, inline `[hooks]` tables in `~/.codex/config.toml`,
  `<repo>/.codex/hooks.json`, `<repo>/.codex/config.toml` (project layers only in trusted projects,
  per P9).
- Events: `SessionStart, PreToolUse, PermissionRequest, PostToolUse, PreCompact, PostCompact,
UserPromptSubmit, SubagentStart, SubagentStop, Stop, Interrupt, SessionEnd`.
- `SessionStart`: "Plain text on `stdout` is added as extra developer context." JSON
  `additionalContext`: "That `additionalContext` text is added as extra developer context."
- Example (P13):
  ```json
  {
    "hooks": {
      "SessionStart": [
        {
          "matcher": "startup|resume",
          "hooks": [
            {
              "type": "command",
              "command": "python3 ~/.codex/hooks/session_start.py",
              "statusMessage": "Loading session notes"
            }
          ]
        }
      ]
    }
  }
  ```
- Feature flag: `[features] hooks = false` disables; "`codex_hooks` still works as a deprecated
  alias." The page documents _disabling_, which implies on-by-default; the default value itself is
  UNVERIFIED from the pages read. `docs/config.md` in the repo (P14) adds
  `allow_managed_hooks_only = true` in `requirements.toml` for admins.

### 2.6 Slash commands / custom prompts

P15 (Custom prompts): files in `~/.codex/prompts/<name>.md` (top-level only; subdirectories ignored;
restart required after edits); frontmatter `description`, `argument-hint`; invoked as
`/prompts:<name>` with `KEY=value` args; placeholders `$1..$9`, `$ARGUMENTS`, `$NAMED`, `$$` escape.
The page states custom prompts are **deprecated in favor of skills** (`$skill-name`). MCP server
prompts exposed as slash commands: not documented → UNVERIFIED.

---

## 3. OpenCode

### 3.1 MCP registration at user scope

- Global config: `~/.config/opencode/opencode.json` (P16, **"Locations"**; source P20 `config.ts`
  lines 272–274 also load `config.json` and `opencode.jsonc` from `Global.Path.config`). Project:
  `opencode.json[c]` at root and `.opencode/opencode.json[c]` (P16; P20 line 439).
- Merge: P16, **"Precedence order"**: "Configuration files are merged together, not replaced. [...]
  Later configs override earlier ones only for conflicting keys." Order: remote
  `.well-known/opencode` < global < `OPENCODE_CONFIG` < project < `.opencode` dirs <
  `OPENCODE_CONFIG_CONTENT` < managed. So an `mcp` block in the global file is live in every project.
- Syntax (P17):
  ```json
  {
    "mcp": {
      "server-name": {
        "type": "local",
        "command": ["npx", "-y", "my-mcp-command"],
        "environment": { "MY_ENV_VAR": "value" },
        "enabled": true
      }
    }
  }
  ```
  Source (P21 `mcp/index.ts`): `StdioClientTransport({command: cmd, args, cwd, env: {...process.env,
...mcp.environment}})` where `command[0]` is the executable and the rest are args; optional
  `timeout`.
- CLI: `opencode mcp add` exists ("Add an MCP server to your configuration.", P18, **"### mcp"** →
  **add**); its flags/non-interactive form are not documented → UNVERIFIED. Also `opencode mcp
list|auth|logout|debug`.

### 3.2 Does OpenCode inject the MCP `instructions` field?

Supported, by source (not documented on the MCP page):

- P21 `packages/opencode/src/mcp/index.ts`: `instructions: mcpClient.getInstructions()?.trim()`
  captured at connect; stored per server (`s.instructions[key]`); exposed by `MCP.instructions()`.
- P22 `packages/opencode/src/session/system.ts`: `const instructions = (yield*
mcp.instructions()).filter(item => item.tools.length === 0 || Permission.disabled(item.tools,
ruleset).size < item.tools.length)` then returns `["<mcp_instructions>", ...]` — i.e. the
  instructions are appended to the system prompt inside an `<mcp_instructions>` block, for servers
  that have no tools or at least one permitted tool.

### 3.3 Skills

- Documented paths (P19): `.opencode/skills/<name>/SKILL.md`;
  `~/.config/opencode/skills/<name>/SKILL.md`; Claude-compatible `.claude/skills/` and
  `~/.claude/skills/`; agent-compatible `.agents/skills/` and `~/.agents/skills/`.
- Source (P23 `packages/opencode/src/skill/index.ts`, `discoverSkills`): external dirs `.claude`
  (skipped when `disableClaudeCodeSkills`) and `.agents` scanned under `$HOME` with pattern
  `skills/**/SKILL.md`, then walked up from cwd to the worktree; then every config directory (global
  `~/.config/opencode`, each `.opencode`, `~/.opencode`, `OPENCODE_CONFIG_DIR` — P24
  `config/paths.ts`) with pattern `{skill,skills}/**/SKILL.md`; then `skills.paths` from config
  (supports `~/` prefix and absolute paths); then `skills.urls`.
- Symlinks: `Glob.scan(pattern, {cwd: root, absolute: true, include: "file", symlink: true, ...})`
  (P23, `scan`). Not mentioned in docs; supported per source.
- Frontmatter: `name`, `description` required; `license`, `compatibility`, `metadata` optional (P19).
- Invocation: model-side `skill({ name })` tool (P19). Also user-side: every skill is registered as a
  command (`source: "skill"`) unless a command of the same name already exists (P25
  `command/index.ts`), so `/skill-name` works in the TUI — source only; the commands doc page does
  not say this.
- Env toggle: `OPENCODE_DISABLE_CLAUDE_CODE=1` disables Claude-compat file reading (P26 rules page).
  The exact env names behind `disableExternalSkills` / `disableClaudeCodeSkills` in P23 were not
  traced: UNVERIFIED.

### 3.4 Shared instruction files

P26 (Rules): project `AGENTS.md` (walk-up from cwd); global `~/.config/opencode/AGENTS.md`; fallback
`CLAUDE.md` in project then `~/.claude/CLAUDE.md` unless `OPENCODE_DISABLE_CLAUDE_CODE=1`; "if you
have both `AGENTS.md` and `CLAUDE.md`, only `AGENTS.md` is used." `instructions` array in config
accepts local globs (`"packages/*/AGENTS.md"`) and remote URLs (5 s timeout); "All instruction files
are combined with your `AGENTS.md` files." No `@file` import syntax.

### 3.5 Session-start hook / plugin that injects context

No command-stdout hook. Mechanism is a JS/TS plugin:

- Locations: `.opencode/plugins/` and `~/.config/opencode/plugins/` (P27; source comment in P20 line
  476 says `.opencode/plugin(s)`), plus npm packages via the `plugin` array.
- Hooks that can inject context (P28 `packages/plugin/src/index.ts`, `Hooks` interface):
  `"experimental.chat.system.transform": (input: {sessionID?, model}, output: {system: string[]}) =>
Promise<void>` (mutate the system prompt array); `"experimental.session.compacting"` (add `context:
string[]` before compaction summary); `event` receives `session.created` etc. (P27). Also
  `"chat.message"`, `"experimental.chat.messages.transform"`, `"tool.definition"`.
- Command templates support `` !`cmd` `` shell injection at invocation time, not at session start
  (P29).

### 3.6 Slash commands

- Files: `.opencode/command/` or `.opencode/commands/` and the same under `~/.config/opencode/`
  (docs P29 say `commands/`; source P30 `config/command.ts` globs `{command,commands}/**/*.md` with
  `symlink: true`, and P20 runs that loader on every config directory).
- Format (P29): markdown with frontmatter `description`, `agent`, `model`, `subtask`; body is the
  template; `$ARGUMENTS`, `$1..$n`; `` !`cmd` ``; `@file`. JSON alternative:
  `"command": {"<name>": {"template": "..."}}` in `opencode.json`.
- MCP prompts become commands automatically (P25: `for (const [name, prompt] of
Object.entries(yield* mcp.prompts())) commands[name] = {source: "mcp", ...}`); prompt arguments map
  to `$1..$n`.
- Reads `.claude/commands/`? Not in P29 and not in P30's glob → not supported (per source at the
  `dev` branch on 2026-09-16).

---

## 4. T3 Code

Repo: https://github.com/pingdotgg/t3code. Docs: `docs/` in the repo (`docs/user/`,
`docs/internals/`, `docs/operations/`); the root README's **"Documentation"** section says the docs
live in `docs/` and there is no docs site yet (P31; the exact sentence was seen in a search snippet
of the README — wording UNVERIFIED verbatim).

T3 Code is an "agent harness control surface" (P31) that runs other harnesses — Codex, Claude Code,
Cursor, Grok Build, OpenCode, Google Antigravity — as providers. It has **no user-facing
MCP-registration, skills, instruction-file, or command-file format of its own**; each of those comes
from the wrapped harness's normal configuration:

1. MCP registration: inherited from the provider. P32 (`docs/internals/providers.md`, **"## Process
   and account isolation"**): "T3-managed OpenCode chat uses one server per thread. Its MCP
   registrations are directory-scoped, while T3's MCP connection is thread-scoped." and **"## Setup
   must not happen as a health-check side effect"**: "Opening a provider session can start MCP
   servers, run hooks, or launch a login browser." P33 (`docs/user/providers-claude.md`, opening
   line): "T3 Code uses Claude Code's login and configuration." Per-instance settings are **Binary
   path** and `CLAUDE_CONFIG_DIR` (P33, **"## Separate accounts or configurations"**); an empty
   config-directory setting "uses Claude Code's normal configuration." P34
   (`docs/user/providers-opencode.md`, **"## Refresh models, commands, and skills"**): "Native
   OpenCode configuration can remain cached while the local helper is running [...] refresh again to
   reload the files." No `project-settings.md` key for MCP/skills/commands exists (P35).
2. MCP `instructions` injection: whatever the underlying harness does (Sections 1.2, 2.2, 3.2).
   Whether T3's transport (Claude Agent SDK vs. CLI; Codex app-server) changes that: UNVERIFIED — the
   user docs do not state the launch mechanism.
3. Skills: read from the provider's own directories. P33, **"## Skills"**: "Claude skills come from
   the config directory's `skills` folder and the project's `.claude/skills` folder. If both define
   the same name, the config-directory copy wins. Skills disabled in Claude's settings do not appear
   in the composer. Use `$` in the composer to select a skill." For OpenCode, skills/commands are
   listed from the OpenCode catalog and refreshed via **Refresh provider status** (P34). Symlinks:
   not addressed by T3 docs (governed by the provider; see 1.3/2.3/3.3).
4. Instruction files: not mentioned in T3 user docs; governed by the provider (CLAUDE.md /
   AGENTS.md). The repo-root `AGENTS.md` is contributor guidance for the T3 codebase itself, not a
   user feature.
5. Hooks: not a T3 feature; P32 notes provider sessions "run hooks" (provider-native).
6. Slash commands: P36 (`docs/user/composer.md`, **"## Commands and skills"**): "Type `/` for
   commands or `$` to add a skill from the selected environment [...] The slash menu also includes
   skills unless you turn off Settings → General → Show skills in slash menu. Only skills enabled
   for the provider are listed. Provider commands must start the message to run. T3 Code commands
   such as `/model` and `/plan`, and skill mentions, work on any line." So provider-defined commands
   (Claude Code skills/commands, Codex `/prompts:`, OpenCode commands) are surfaced; T3 adds its own
   built-ins (`/model`, `/plan`, `/compact`).
7. T3 mounts its own `t3-code` MCP server into every provider session (PR #11864, S1, OPEN at fetch
   time: "the `t3-code` MCP server that is already mounted on every provider session"). Whether
   user-registered MCP servers' prompts/instructions are surfaced in the T3 UI: UNVERIFIED; issue
   #11398 (S2) reports the OpenCode provider does not surface the MCP server list in Settings.

---

## 5. Cross-harness synthesis

| Mechanism                                    | Claude Code                                                                                                              | Codex CLI                                                                                                                        | OpenCode                                                                                                                                | T3 Code                                                                              |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Global MCP stdio registration                | Supported — `~/.claude.json`; `claude mcp add <n> --env K=V --scope user -- <cmd> <args>` (P1)                           | Supported — `~/.codex/config.toml` `[mcp_servers.<n>] command/args/env`; `codex mcp add <n> --env K=V -- <cmd>` (P7, P8)         | Supported — `~/.config/opencode/opencode.json` `mcp.<n> {type:"local", command:[...], environment}`; `opencode mcp add` (P16, P17, P18) | Inherited from the selected provider's own config (P32, P33); no T3-level MCP config |
| Project MCP file merged with global          | Yes, per server name; local > project > user, whole entry wins (P1)                                                      | Yes; `.codex/config.toml` layers merge key-by-key, trusted projects only (P9, P7)                                                | Yes; configs "merged together, not replaced" (P16)                                                                                      | n/a (provider)                                                                       |
| MCP `instructions` injected at session start | Supported; "tool names and server instructions load at session start"; 2 KB cap (P1)                                     | Supported; as the tool-namespace description; "first 512 characters" guidance (P7, P10)                                          | Supported by source; `<mcp_instructions>` block in system prompt (P21, P22); not in docs                                                | Per provider; UNVERIFIED whether T3's transport preserves it                         |
| Skills — global dir                          | `~/.claude/skills/<n>/SKILL.md` (P2)                                                                                     | `~/.agents/skills/<n>/SKILL.md`, also `/etc/codex/skills` (P11)                                                                  | `~/.config/opencode/skills/`, plus `~/.claude/skills/`, `~/.agents/skills/` (P19, P23)                                                  | Provider's dirs; Claude: config dir `skills/` + `.claude/skills` (P33)               |
| Skills — project dir                         | `.claude/skills/` (P2)                                                                                                   | `.agents/skills/` walking up to repo root (P11)                                                                                  | `.opencode/skill(s)/`, `.claude/skills/`, `.agents/skills/` walking up (P23)                                                            | Provider's                                                                           |
| Reads other harnesses' skill dirs            | Not documented (no)                                                                                                      | Not documented (no)                                                                                                              | Yes: `.claude` and `.agents` (P19, P23)                                                                                                 | n/a                                                                                  |
| Symlinked skill dirs followed                | Supported, documented (P2)                                                                                               | Supported, documented (P11)                                                                                                      | Supported per source `symlink: true` (P23); not documented                                                                              | n/a                                                                                  |
| Global instruction file                      | `~/.claude/CLAUDE.md` + `~/.claude/rules/`; `@path` imports incl. `@~/…` (P3)                                            | `~/.codex/AGENTS.md` (`AGENTS.override.md` wins) (P12)                                                                           | `~/.config/opencode/AGENTS.md`; fallback `~/.claude/CLAUDE.md`; `instructions` globs/URLs (P26)                                         | n/a (provider)                                                                       |
| AGENTS.md read natively                      | No — "reads CLAUDE.md, not AGENTS.md"; use `@AGENTS.md` import or symlink (P3)                                           | Yes (P12)                                                                                                                        | Yes (P26)                                                                                                                               | n/a                                                                                  |
| Session-start command hook injecting stdout  | Supported — `SessionStart` in `~/.claude/settings.json`; plain stdout or `hookSpecificOutput.additionalContext` (P4, P5) | Supported — `SessionStart` in `~/.codex/hooks.json` or `[hooks]` in config.toml; stdout "added as extra developer context" (P13) | Not a command hook; JS plugin `experimental.chat.system.transform` / `event` (P27, P28)                                                 | Not a T3 feature; provider hooks run (P32)                                           |
| Custom slash commands — global               | `~/.claude/commands/*.md` (legacy) or `~/.claude/skills/<n>/SKILL.md` → `/n` (P6, P2)                                    | `~/.codex/prompts/*.md` → `/prompts:n` (deprecated for skills `$n`) (P15)                                                        | `~/.config/opencode/command(s)/*.md` → `/n` (P29, P30)                                                                                  | Surfaces provider commands via `/`, skills via `$` (P36)                             |
| MCP prompts exposed as slash commands        | Supported — `/servername:promptname (MCP)` and `/mcp__server__prompt` (P1)                                               | UNVERIFIED (not documented)                                                                                                      | Supported per source — prompts registered as commands (P25)                                                                             | UNVERIFIED                                                                           |

---

## 6. This session's own finding — our MCP server carries no `instructions` today

**Finding (verdict: PROVEN, probe: direct observation).** Claude Code injects an MCP server's
`instructions` string into the assistant's context at session start. Evidence: in the session that
produced this note, the assistant's own system context contained a "MCP Server Instructions" section
carrying the instructions of the `claude-in-chrome` and `context7` MCP servers. This confirms the
documented "tool names and server instructions load at session start" behaviour from the Claude Code
MCP docs (§1.2, P1).

Our own MCP server passes no `instructions`, so it contributes nothing to that block today: the
`MCPServer` construction in `src/bindings/mastra/server.ts:220-232` sets only `id`, `name`,
`version` and `tools` — there is no `instructions` field.

---

## 7. Sources consulted

Primary (official docs pages, headings as cited, or source files at the named branch; all fetched
2026-09-16):

- P1 https://code.claude.com/docs/en/mcp — "## MCP installation scopes", "### User scope", "### Scope
  hierarchy and precedence", "### Option 3: Add a local stdio server", "## Add MCP servers from JSON
  configuration", "## Scale with MCP tool search", "### For MCP server authors", "## Use MCP prompts
  as commands"
- P2 https://code.claude.com/docs/en/skills — "Choose where skills load", "Skill folders also follow
  these rules", "Resolve skills that share a name", "Pass arguments to skills", "How a skill gets its
  command name"
- P3 https://code.claude.com/docs/en/memory — "### Choose where to put CLAUDE.md files", "### Import
  additional files", "### AGENTS.md", "#### User-level rules", "#### Share rules across projects with
  symlinks"
- P4 https://code.claude.com/docs/en/hooks — "Exit code 0", "JSON output", "Matcher patterns"
- P5 https://code.claude.com/docs/en/hooks-guide — "### Configure hook location", "### Re-inject
  context after compaction"
- P6 https://code.claude.com/docs/en/slash-commands (and
  https://code.claude.com/docs/en/commands "## MCP prompts") — custom commands merged-into-skills
  note
- P7 https://developers.openai.com/codex/mcp → https://learn.chatgpt.com/docs/extend/mcp?surface=cli
  — `codex mcp add`, config example, instructions paragraph
- P8 https://developers.openai.com/codex/config-reference →
  https://learn.chatgpt.com/docs/config-file/config-reference — `mcp_servers.<id>` fields,
  `project_doc_max_bytes`, `project_doc_fallback_filenames`
- P9 https://developers.openai.com/codex/config-advanced →
  https://learn.chatgpt.com/docs/config-file/config-advanced — "Config and state locations",
  "Project config files (.codex/config.toml)", "Profiles"
- P10 https://github.com/openai/codex/blob/main/codex-rs/codex-mcp/src/rmcp_client.rs —
  `regular_mcp_tool_info_from_listed_tool`, `codex_apps_tool_info_from_listed_tool`; and
  codex-rs/codex-mcp/src/connection_manager/tool_catalog.rs (refresh call passing
  `server_instructions`)
- P11 https://developers.openai.com/codex/skills → https://learn.chatgpt.com/docs/build-skills —
  locations/precedence, invocation, symlink sentence, 2 % / 8,000-char listing cap
- P12 https://developers.openai.com/codex/guides/agents-md →
  https://learn.chatgpt.com/docs/agent-configuration/agents-md — discovery order, override files,
  concatenation, size cap
- P13 https://developers.openai.com/codex/hooks → https://learn.chatgpt.com/docs/hooks — locations,
  event list, SessionStart stdout/additionalContext, `[features] hooks`
- P14 https://github.com/openai/codex/blob/main/docs/config.md — stub pointing to hosted docs; "##
  Lifecycle hooks" (`allow_managed_hooks_only`)
- P15 https://developers.openai.com/codex/custom-prompts →
  https://learn.chatgpt.com/docs/custom-prompts — `~/.codex/prompts/`, `/prompts:name`, deprecation
  note
- P16 https://opencode.ai/docs/config — "Locations", "Precedence order"
- P17 https://opencode.ai/docs/mcp-servers — local server JSON, `opencode mcp` commands
- P18 https://opencode.ai/docs/cli — "### mcp" → add/list/auth/logout/debug
- P19 https://opencode.ai/docs/skills — six search paths, frontmatter, skill tool, permissions
- P20 https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/config/config.ts — global
  file names (lines 272–274), per-directory loading incl. `ConfigCommand.load(dir)` (lines 438–478)
- P21 https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/mcp/index.ts —
  `getInstructions()`, `StdioClientTransport` spawn
- P22 https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/session/system.ts —
  `<mcp_instructions>` block
- P23 https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/skill/index.ts —
  `CLAUDE_EXTERNAL_DIR`, `AGENTS_EXTERNAL_DIR`, patterns, `scan` with `symlink: true`,
  `discoverSkills`
- P24 https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/config/paths.ts —
  `directories()`
- P25 https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/command/index.ts —
  commands from config, MCP prompts (`source: "mcp"`), skills (`source: "skill"`)
- P26 https://opencode.ai/docs/rules — AGENTS.md locations, CLAUDE.md fallback, `instructions`
  array, `OPENCODE_DISABLE_CLAUDE_CODE`
- P27 https://opencode.ai/docs/plugins — plugin locations, `plugin` array, event list
- P28 https://github.com/anomalyco/opencode/blob/dev/packages/plugin/src/index.ts — `Hooks`
  interface (`experimental.chat.system.transform`, `experimental.session.compacting`, `event`, …)
- P29 https://opencode.ai/docs/commands — command locations, frontmatter, `$ARGUMENTS`, `` !`cmd` ``,
  `@file`, JSON `command` block
- P30 https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/config/command.ts —
  `{command,commands}/**/*.md`, `symlink: true`
- P31 https://github.com/pingdotgg/t3code (README: description, provider list, "Documentation")
- P32 https://github.com/pingdotgg/t3code/blob/main/docs/internals/providers.md — "## Process and
  account isolation", "## Setup must not happen as a health-check side effect"
- P33 https://github.com/pingdotgg/t3code/blob/main/docs/user/providers-claude.md — intro line, "##
  Separate accounts or configurations", "## Skills"
- P34 https://github.com/pingdotgg/t3code/blob/main/docs/user/providers-opencode.md — "## Refresh
  models, commands, and skills"
- P35 https://github.com/pingdotgg/t3code/blob/main/docs/user/project-settings.md — no
  MCP/skills/commands keys
- P36 https://github.com/pingdotgg/t3code/blob/main/docs/user/composer.md — "## Commands and skills"
- P37 `src/bindings/mastra/server.ts:220-232` (this repo) — `MCPServer` construction with `id`,
  `name`, `version`, `tools`, no `instructions` field

Secondary (used only for context or flagged claims; not relied on for any "supported" cell):

- S1 https://github.com/pingdotgg/t3code/pull/11864 — "feat(server): agents list and create threads
  via the t3-code MCP toolkit" (OPEN; states the `t3-code` MCP server is mounted on every provider
  session)
- S2 https://github.com/pingdotgg/t3code/issues/11398 — OpenCode provider does not surface
  MCP/LSP/plugins in the T3 UI
- S3 https://github.com/anthropics/claude-code/issues/43749 — about Claude _Desktop_ not consuming
  `instructions`; confirms by contrast that the field exists in `InitializeResult`; not evidence
  about Claude Code
- S4 WebSearch snippets (Codex hooks guides, matagi.ai/verdent.ai MCP guides) — only used to locate
  the primary pages above
