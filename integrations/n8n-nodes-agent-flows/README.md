# n8n-nodes-agent-flows

A community n8n node package that runs a read-only coding agent (the `claude` CLI) as a typed, sandboxed workflow step. Used as the execution primitive for Binding C's generated n8n workflows.

## Node type

`n8n-nodes-agent-flows.yokeAgent`

## Requirements

- n8n 1.0+
- The `claude` CLI on the PATH of the n8n OS user (`npm install -g @anthropic-ai/claude-code` or equivalent)
- Authentication: `ANTHROPIC_API_KEY` set in n8n's environment (preferred) or an active claude session via the OS keychain

## Install

```sh
# From the n8n user-data directory (default: ~/.n8n)
cd ~/.n8n/nodes
npm install /path/to/n8n-nodes-agent-flows

# Or, once published to npm:
cd ~/.n8n/nodes
npm install n8n-nodes-agent-flows
```

n8n auto-discovers packages whose names match `n8n-nodes-*` from `~/.n8n/nodes/node_modules/` — no database entry or UI interaction required.

## Node parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `role` | enum | yes | `reasoner` (opus) / `worker` (sonnet) / `scout` (haiku) |
| `model` | string | no | Explicit model override. Must be from the known registry; unknown values are rejected. |
| `workspaceAccess` | enum | yes | `read` or `none` |
| `workspaceDirectory` | string | when read | Absolute path to spawn the agent in. Must exist and be a directory. |
| `prompt` | string | yes | Instruction delivered to the agent. |
| `timeoutMs` | number | no | Per-execution deadline in milliseconds. Default: 600 000 (10 min). |

## Output per item

```json
{
  "role": "scout",
  "model": "claude-haiku-4-5",
  "workspaceAccess": "read",
  "output": "...",
  "exitCode": 0
}
```

## Security posture

### What this node does to protect n8n

1. **Prompt via stdin, not argv.** The prompt is written to the child process's stdin. It never appears in the host process table (`ps`) and is not subject to shell interpretation.

2. **Environment scrubbing.** The spawned process receives only `PATH`, `HOME`, `TMPDIR`/`TEMP`/`TMP`, and `ANTHROPIC_API_KEY` (when set). `N8N_ENCRYPTION_KEY`, `DB_POSTGRESDB_PASSWORD`, webhook secrets, and every other variable in n8n's environment are stripped. This is the most critical protection — without it, an agent with `Read,Glob` access could read `~/.n8n/database.sqlite` and decrypt stored credentials using the key from the environment.

3. **`--bare` mode when `ANTHROPIC_API_KEY` is present.** This flag tells the claude CLI to skip hooks, project CLAUDE.md auto-discovery, keychain reads, and background prefetches. Combined with `--strict-mcp-config`, it means only node-controlled flags are active — no project-local MCP servers or shell hooks can run.

4. **`--strict-mcp-config`.** Always set. Ignores all project-local MCP configuration. Only flags provided by the node itself are used.

5. **`--allowedTools Read,Glob`.** Always set. Restricts the agent's toolset to read-only file operations regardless of role.

6. **Argv-array spawn, `shell: false`.** `child_process.spawn` is called with an explicit args array and `shell: false`. No shell expansion, no injection path.

7. **Async spawn.** `spawn` (never `spawnSync`/`execSync`) so the n8n event loop is never blocked.

8. **Configurable timeout.** The child is killed (SIGTERM, then SIGKILL after 5 s) if it exceeds the per-execution deadline.

9. **Path validation.** `workspaceDirectory` must be absolute, must not contain `..` segments, must resolve via `realpath`, and must be a directory. Runtime-validated, not just editor-validated.

10. **Model validation.** `model` overrides are checked against a compile-time allowlist. Arbitrary strings (including flag-like values such as `--dangerously-skip-permissions`) are rejected.

11. **Output byte cap.** Stdout is capped at 4 MB. Exceeding the cap kills the child and surfaces an error. Stderr is captured but not relayed to output items (it may contain API metadata or environment details).

### What this node cannot protect against

- **`--allowedTools Read,Glob` is not a filesystem sandbox.** The claude CLI can follow absolute paths and symlinks outside `workspaceDirectory`. cwd is a default resolution base, not a confinement boundary. Operators who need true filesystem isolation must run n8n in a container.

- **`workspaceAccess: none` is not zero-access.** The node spawns in a disposable temp directory, but `Read,Glob` is still in effect. An agent can still read `/etc`, `~/.ssh`, or any other path readable by the n8n OS user. The label "none" means "no specified workspace" — not "no file access".

- **Prompt injection.** Upstream node data (webhook bodies, issue text) injected into the prompt can redirect the agent's behavior. Downstream nodes that write files, call HTTP endpoints, or post to external services should treat the agent's output as untrusted data.

- **No operator-level path allow-list.** `workspaceDirectory` is a free-text workflow parameter. Any n8n user who can edit a workflow can read any path the n8n OS user can read. This node should not be installed on shared/multi-tenant n8n instances where workflow editors are untrusted.

- **Keychain auth mode.** When `ANTHROPIC_API_KEY` is absent, `--bare` is omitted and claude falls back to keychain/OAuth auth. In this mode, project CLAUDE.md files and hooks in the spawn directory can affect the agent's behavior. Use `ANTHROPIC_API_KEY` for production deployments.

## Development

```sh
cd integrations/n8n-nodes-agent-flows
npm install
npm run build      # tsc → dist/
npm run test:ts    # unit tests (no n8n required)
```

### Running unit tests

```sh
node --experimental-strip-types --test '__tests__/**/*.test.ts'
```

Tests cover: model resolution, path validation, environment scrubbing, and argv construction. They run without n8n or a live claude session.

### Installing into the spike n8n

```sh
SPIKE=/path/to/n8n-spike
DEST="$SPIKE/n8n-data/.n8n/nodes/node_modules/n8n-nodes-agent-flows"
mkdir -p "$DEST"
cp package.json "$DEST/"
cp -r dist "$DEST/"
# Symlink n8n-workflow from the n8n installation
ln -sf /path/to/n8n/node_modules/n8n-workflow "$DEST/node_modules/n8n-workflow"
```

Then import and execute a workflow referencing `n8n-nodes-agent-flows.yokeAgent`.
