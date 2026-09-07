import {
  IExecuteFunctions,
  INodeExecutionData,
  INodeType,
  INodeTypeDescription,
  NodeConnectionTypes,
  NodeOperationError,
} from 'n8n-workflow';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

// ---------------------------------------------------------------------------
// Provider registry: role -> concrete model alias (resolved by claude --model)
//
// IMPORTANT: this map must stay in sync with src/canon/registry.ts (the canon
// declares the authoritative role→model assignments). A divergence here is the
// same defect class this project has hit before: the canon declares one thing
// and a binding does another. The cross-check test at
// src/canon/n8nNodeRoleModelSync.test.ts guards against this drifting again.
// ---------------------------------------------------------------------------

type Role = 'reasoner' | 'worker' | 'scout';

const ROLE_TO_MODEL: Record<Role, string> = {
  reasoner: 'claude-opus-5',
  worker: 'claude-sonnet-5',
  scout: 'claude-haiku-4-5',
};

const ALLOWED_MODELS: ReadonlySet<string> = new Set([
  ...Object.values(ROLE_TO_MODEL),
  // Bare CLI aliases (claude resolves these to their current pinned version)
  'opus',
  'sonnet',
  'haiku',
  // Explicit versioned ids currently in use
  'claude-opus-5',
  'claude-sonnet-5',
  'claude-haiku-4-5',
  'claude-haiku-4-5-20251001',
  'claude-fable-5-1',
]);

const DEFAULT_MODEL = ROLE_TO_MODEL['scout'];
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024; // 4 MB — hard cap on buffered output

// ---------------------------------------------------------------------------
// Model resolution
// ---------------------------------------------------------------------------

/** Resolve final model, validating any explicit override against the registry. */
function resolveModel(role: Role, explicitModel: string | undefined): string {
  if (explicitModel && explicitModel.trim() !== '') {
    const trimmed = explicitModel.trim();
    if (!ALLOWED_MODELS.has(trimmed)) {
      throw new Error(
        `Unknown model "${trimmed}". Allowed values: ${[...ALLOWED_MODELS].join(', ')}`,
      );
    }
    return trimmed;
  }
  return ROLE_TO_MODEL[role] ?? DEFAULT_MODEL;
}

// ---------------------------------------------------------------------------
// Path validation
// ---------------------------------------------------------------------------

/**
 * Validate and resolve a workspace directory path.
 *
 * Security contract:
 * - Must be an absolute path
 * - Must resolve (via realpath) to a directory that exists
 * - Rejects paths containing ".." segments before resolution
 *
 * NOTE: `--allowedTools Read,Glob` does NOT confine the agent to cwd —
 * the claude CLI can still read absolute paths. cwd is therefore NOT a
 * security boundary; it only sets the default resolution base.
 */
async function validateWorkspaceDirectory(rawPath: string): Promise<string> {
  if (!rawPath || rawPath.trim() === '') {
    throw new Error('workspaceDirectory is required and must not be empty');
  }
  const trimmed = rawPath.trim();
  if (!trimmed.startsWith('/')) {
    throw new Error(`workspaceDirectory must be an absolute path (got "${trimmed}")`);
  }
  // Reject obvious traversal before realpath
  if (trimmed.split('/').some((seg) => seg === '..')) {
    throw new Error(`workspaceDirectory must not contain ".." segments (got "${trimmed}")`);
  }
  let resolved: string;
  try {
    resolved = await fs.realpath(trimmed);
  } catch {
    throw new Error(`workspaceDirectory "${trimmed}" does not exist or is not accessible`);
  }
  const stat = await fs.stat(resolved);
  if (!stat.isDirectory()) {
    throw new Error(`workspaceDirectory "${trimmed}" is not a directory`);
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// Environment scrubbing
// ---------------------------------------------------------------------------

/**
 * Build a minimal environment for the spawned claude process.
 *
 * We do NOT inherit process.env — doing so would leak N8N_ENCRYPTION_KEY,
 * database credentials, and every other secret present in n8n's environment
 * into the agent process.
 *
 * When ANTHROPIC_API_KEY is set: pass it explicitly; the caller should also
 * use --bare so keychain/OAuth are never consulted.
 *
 * When ANTHROPIC_API_KEY is absent: claude falls back to stored
 * OAuth/keychain tokens in ~/.claude/. We still pass HOME so claude can
 * locate its session state. In this case --bare is NOT used (it blocks
 * keychain reads), so the operator must ensure the n8n OS user has a
 * valid claude session.
 */
interface EnvResult {
  env: Record<string, string>;
  hasApiKey: boolean;
}

function buildMinimalEnv(): EnvResult {
  const env: Record<string, string> = {};
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP'] as const) {
    const val = process.env[key];
    if (val) env[key] = val;
  }
  const apiKey = process.env['ANTHROPIC_API_KEY'];
  if (apiKey) env['ANTHROPIC_API_KEY'] = apiKey;
  return { env, hasApiKey: Boolean(apiKey) };
}

// ---------------------------------------------------------------------------
// Claude spawn
// ---------------------------------------------------------------------------

interface ClaudeRunOptions {
  prompt: string;
  model: string;
  workspaceCwd: string; // already validated absolute real path
  timeoutMs: number;
  allowedTools: string; // comma-separated list of tools to allow
}

interface ClaudeRunResult {
  output: string;
  exitCode: number;
  timedOut: boolean;
}

async function runClaude(opts: ClaudeRunOptions): Promise<ClaudeRunResult> {
  const { prompt, model, workspaceCwd, timeoutMs } = opts;

  const { env, hasApiKey } = buildMinimalEnv();

  // Build argv — prompt is NOT included; it arrives via stdin.
  // All node-controlled flags come BEFORE any user-supplied value so they
  // cannot be overridden by a crafted prompt that begins with "--flag".
  //
  // Security note: when ANTHROPIC_API_KEY is present we use --bare for
  // maximum isolation (no keychain, no hooks, no CLAUDE.md auto-discovery).
  // When absent we omit --bare so claude can use its stored OAuth/keychain
  // session, but still scrub n8n's env vars to prevent secret leakage.
  const args: string[] = [
    '-p',                          // non-interactive / print mode
    ...(hasApiKey ? ['--bare'] : []), // maximum isolation when API key available
    '--no-session-persistence',    // no session files written to disk
    '--permission-prompts', 'none', // deny any permission prompt (fail-safe)
    '--allowedTools', opts.allowedTools, // tool allowlist derived from workspaceAccess
    '--strict-mcp-config',         // ignore project MCP config; use only --mcp-config
    '--output-format', 'text',     // plain text response
    '--model', model,              // validated model string
  ];

  return new Promise<ClaudeRunResult>((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn('claude', args, {
        cwd: workspaceCwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false, // never use shell — prevents shell injection
      });
    } catch (err: unknown) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === 'ENOENT') {
        reject(new Error('`claude` binary not found on PATH. Install the Claude CLI and ensure it is accessible in the PATH environment variable.'));
      } else {
        reject(err);
      }
      return;
    }

    let stdout = '';
    let stderr = '';
    let outputBytes = 0;
    let timedOut = false;
    let settled = false;

    // Only arm the kill timer when timeoutMs is positive.
    // timeoutMs === 0 mirrors the canon's no-declared-timeout semantics: the step runs
    // unbounded. n8n executions are visible and cancellable from the n8n UI.
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        setTimeout(() => {
          if (!settled) child.kill('SIGKILL');
        }, 5_000);
      }, timeoutMs);
    }

    child.on('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      settled = true;
      if (err.code === 'ENOENT') {
        reject(new Error('`claude` binary not found on PATH. Install the Claude CLI and ensure it is accessible in the PATH environment variable.'));
      } else {
        reject(err);
      }
    });

    child.stdout!.on('data', (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_OUTPUT_BYTES) {
        // Kill the child and surface a truncation error
        child.kill('SIGTERM');
        reject(new Error(`claude output exceeded ${MAX_OUTPUT_BYTES} byte limit; execution aborted`));
        return;
      }
      stdout += chunk.toString('utf8');
    });

    child.stderr!.on('data', (chunk: Buffer) => {
      // Capture stderr for diagnostics but do not relay it to output items
      // (it may contain environment details or API metadata).
      stderr += chunk.toString('utf8').slice(-2000); // keep last 2 KB only
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      settled = true;
      if (timedOut) {
        reject(new Error(`claude timed out after ${timeoutMs}ms`));
        return;
      }
      resolve({
        output: stdout.trim(),
        exitCode: code ?? 1,
        timedOut: false,
      });
    });

    // Send prompt via stdin — avoids it appearing in the host process table
    child.stdin!.write(prompt, 'utf8');
    child.stdin!.end();
  });
}

// ---------------------------------------------------------------------------
// Node class
// ---------------------------------------------------------------------------

export class AgentFlowsAgent implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'Agent Flows Coding Agent',
    name: 'agentFlowsAgent',
    icon: 'fa:robot',
    group: ['transform'],
    version: 1,
    description:
      'Run a sandboxed read-only coding agent (claude CLI) as a typed workflow step. ' +
      'The prompt is delivered via stdin; the agent environment is scrubbed of n8n secrets.',
    defaults: { name: 'Agent Flows Agent' },
    inputs: [NodeConnectionTypes.Main],
    outputs: [NodeConnectionTypes.Main],
    properties: [
      {
        displayName: 'Role',
        name: 'role',
        type: 'options',
        options: [
          {
            name: 'Reasoner (opus)',
            value: 'reasoner',
            description: 'Deep reasoning tasks — maps to claude-opus-5',
          },
          {
            name: 'Worker (sonnet)',
            value: 'worker',
            description: 'General implementation tasks — maps to claude-sonnet-5',
          },
          {
            name: 'Scout (haiku)',
            value: 'scout',
            description: 'Fast exploration / triage — maps to claude-haiku-4-5',
          },
        ],
        default: 'scout',
        description: 'Resolved to a concrete model via the provider registry. All roles use the read-only tool allowlist in v1.',
      },
      {
        displayName: 'Model Override',
        name: 'model',
        type: 'string',
        default: '',
        placeholder: 'e.g. claude-haiku-4-5 or claude-opus-5',
        description:
          'Optional. Overrides the role-resolved model. Must be a value from the known registry; unknown strings are rejected.',
      },
      {
        displayName: 'Workspace Access',
        name: 'workspaceAccess',
        type: 'options',
        options: [
          {
            name: 'Read',
            value: 'read',
            description: 'Allow the agent to read files from Workspace Directory using Read and Glob tools',
          },
          {
            name: 'Write',
            value: 'write',
            description:
              'Allow the agent to read and edit files in Workspace Directory using Read, Glob, Edit, and Write tools. ' +
              'Use for steps that must modify repository files (e.g. implement, fix).',
          },
          {
            name: 'None',
            value: 'none',
            description:
              'Spawn in an isolated temp directory. Note: --allowedTools Read,Glob is still in effect; ' +
              'the agent can still read absolute paths. This is NOT a full filesystem sandbox.',
          },
        ],
        default: 'read',
      },
      {
        displayName: 'Workspace Directory',
        name: 'workspaceDirectory',
        type: 'string',
        default: '',
        placeholder: '/absolute/path/to/repo',
        description:
          'Absolute path to the directory the agent is spawned in. Required when Workspace Access is "read" or "write". ' +
          'Must exist and be a directory. ".." segments are rejected.',
        displayOptions: {
          show: { workspaceAccess: ['read', 'write'] },
        },
      },
      {
        displayName: 'Prompt',
        name: 'prompt',
        type: 'string',
        typeOptions: { rows: 6 },
        default: '',
        required: true,
        description:
          'The prompt to deliver to the agent. Delivered via stdin — does not appear in the host process table. ' +
          'Treat prompt content as untrusted if built from upstream node data; agent output should likewise be treated as untrusted before passing to write-capable downstream nodes.',
      },
      {
        displayName: 'Timeout (ms)',
        name: 'timeoutMs',
        type: 'number',
        default: 0,
        description:
          'Maximum milliseconds to wait for the agent to finish. ' +
          'The child process is killed (SIGTERM then SIGKILL) on timeout. ' +
          '0 means no limit — the step runs until it completes or is cancelled from the n8n UI.',
      },
    ],
  };

  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    const items = this.getInputData();
    const outputItems: INodeExecutionData[] = [];

    for (let i = 0; i < items.length; i++) {
      const role = this.getNodeParameter('role', i) as Role;
      const modelOverride = this.getNodeParameter('model', i, '') as string;
      const workspaceAccess = this.getNodeParameter('workspaceAccess', i) as 'read' | 'write' | 'none';
      const rawWorkspaceDir = this.getNodeParameter('workspaceDirectory', i, '') as string;
      const prompt = this.getNodeParameter('prompt', i) as string;
      const timeoutMs = this.getNodeParameter('timeoutMs', i, 0) as number;

      if (!prompt || prompt.trim() === '') {
        throw new NodeOperationError(this.getNode(), 'prompt must not be empty', { itemIndex: i });
      }

      // Validate and resolve model
      let resolvedModel: string;
      try {
        resolvedModel = resolveModel(role, modelOverride || undefined);
      } catch (err) {
        throw new NodeOperationError(this.getNode(), (err as Error).message, { itemIndex: i });
      }

      // Resolve working directory
      let workspaceCwd: string;
      let tempDir: string | undefined;
      try {
        if (workspaceAccess === 'read' || workspaceAccess === 'write') {
          if (!rawWorkspaceDir || rawWorkspaceDir.trim() === '') {
            throw new Error(`workspaceDirectory is required when workspaceAccess is "${workspaceAccess}"`);
          }
          workspaceCwd = await validateWorkspaceDirectory(rawWorkspaceDir);
        } else {
          // none: spawn in a node-created temp directory to prevent inheriting n8n's cwd
          tempDir = join(tmpdir(), `agent-flows-agent-none-${randomUUID()}`);
          await fs.mkdir(tempDir, { recursive: true });
          workspaceCwd = tempDir;
        }
      } catch (err) {
        throw new NodeOperationError(this.getNode(), (err as Error).message, { itemIndex: i });
      }

      const allowedTools =
        workspaceAccess === 'write' ? 'Read,Glob,Edit,Write' : 'Read,Glob';

      // Separate the spawn try/catch from the exit-code check so that a
      // NodeOperationError thrown for a non-zero exit is not re-caught and
      // re-wrapped by the spawn error handler below.
      let result: ClaudeRunResult;
      try {
        result = await runClaude({
          prompt: prompt.trim(),
          model: resolvedModel,
          workspaceCwd,
          timeoutMs,
          allowedTools,
        });
      } catch (err) {
        throw new NodeOperationError(this.getNode(), (err as Error).message, { itemIndex: i });
      } finally {
        // Clean up the temp directory for none-access mode regardless of outcome.
        if (tempDir) {
          await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
        }
      }

      // A non-zero exit code previously became a green step — the error text
      // flowed downstream as if it were the agent's answer. Fail explicitly
      // so the workflow surface shows red and the operator sees the cause.
      if (result.exitCode !== 0) {
        const excerpt = result.output.slice(0, 500);
        throw new NodeOperationError(
          this.getNode(),
          `Agent process exited with code ${result.exitCode}: ${excerpt}`,
          { itemIndex: i },
        );
      }

      outputItems.push({
        json: {
          role,
          model: resolvedModel,
          workspaceAccess,
          output: result.output,
          exitCode: result.exitCode,
        },
        pairedItem: { item: i },
      });
    }

    return [outputItems];
  }
}
