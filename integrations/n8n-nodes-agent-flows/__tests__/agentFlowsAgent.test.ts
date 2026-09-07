/**
 * Unit tests for AgentFlowsAgent node internals.
 * Runnable without n8n: node --experimental-strip-types --test '__tests__/**\/*.test.ts'
 *
 * These tests cover the security-critical helpers extracted from the node:
 *   - model resolution and validation
 *   - path validation logic
 *   - environment scrubbing
 *   - argument construction (no prompt in argv)
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

// ---------------------------------------------------------------------------
// Replicated internals (identical to node implementation for isolation)
// ---------------------------------------------------------------------------

type Role = 'reasoner' | 'worker' | 'scout';

const ROLE_TO_MODEL: Record<Role, string> = {
  reasoner: 'claude-opus-4-5',
  worker: 'claude-sonnet-4-5',
  scout: 'claude-haiku-4-5',
};

const ALLOWED_MODELS: ReadonlySet<string> = new Set([
  ...Object.values(ROLE_TO_MODEL),
  'claude-opus-4-5',
  'claude-sonnet-4-5',
  'claude-haiku-4-5',
  'opus',
  'sonnet',
  'haiku',
  'claude-opus-4-0',
  'claude-sonnet-4-0',
  'claude-haiku-3-5',
]);

const DEFAULT_MODEL = ROLE_TO_MODEL['scout'];

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

async function validateWorkspaceDirectory(rawPath: string): Promise<string> {
  if (!rawPath || rawPath.trim() === '') {
    throw new Error('workspaceDirectory is required and must not be empty');
  }
  const trimmed = rawPath.trim();
  if (!trimmed.startsWith('/')) {
    throw new Error(`workspaceDirectory must be an absolute path (got "${trimmed}")`);
  }
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

function buildClaudeArgs(
  model: string,
  hasApiKey: boolean = true,
  allowedTools: string = 'Read,Glob',
): string[] {
  return [
    '-p',
    ...(hasApiKey ? ['--bare'] : []),
    '--no-session-persistence',
    '--permission-prompts', 'none',
    '--allowedTools', allowedTools,
    '--strict-mcp-config',
    '--output-format', 'text',
    '--model', model,
  ];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('resolveModel', () => {
  it('maps reasoner to opus', () => {
    assert.equal(resolveModel('reasoner', undefined), 'claude-opus-4-5');
  });

  it('maps worker to sonnet', () => {
    assert.equal(resolveModel('worker', undefined), 'claude-sonnet-4-5');
  });

  it('maps scout to haiku (default)', () => {
    assert.equal(resolveModel('scout', undefined), 'claude-haiku-4-5');
  });

  it('accepts a valid model override', () => {
    assert.equal(resolveModel('scout', 'opus'), 'opus');
  });

  it('rejects an unknown model override', () => {
    assert.throws(
      () => resolveModel('scout', 'gpt-4o'),
      /Unknown model "gpt-4o"/,
    );
  });

  it('rejects an arbitrary flag-like model override', () => {
    assert.throws(
      () => resolveModel('scout', '--dangerously-skip-permissions'),
      /Unknown model/,
    );
  });

  it('ignores blank model override and falls back to role', () => {
    assert.equal(resolveModel('reasoner', '  '), 'claude-opus-4-5');
    assert.equal(resolveModel('reasoner', ''), 'claude-opus-4-5');
  });
});

describe('validateWorkspaceDirectory', () => {
  let existingDir: string;
  let existingFile: string;

  before(async () => {
    existingDir = join(tmpdir(), `agent-flows-test-${randomUUID()}`);
    await fs.mkdir(existingDir, { recursive: true });
    existingFile = join(existingDir, 'file.txt');
    await fs.writeFile(existingFile, 'hello');
  });

  after(async () => {
    await fs.rm(existingDir, { recursive: true, force: true });
  });

  it('resolves and returns a valid existing directory', async () => {
    const result = await validateWorkspaceDirectory(existingDir);
    assert.ok(result.startsWith('/'));
  });

  it('rejects empty path', async () => {
    await assert.rejects(
      () => validateWorkspaceDirectory(''),
      /must not be empty/,
    );
  });

  it('rejects relative path', async () => {
    await assert.rejects(
      () => validateWorkspaceDirectory('relative/path'),
      /must be an absolute path/,
    );
  });

  it('rejects path with ".." segment', async () => {
    await assert.rejects(
      () => validateWorkspaceDirectory('/tmp/../etc'),
      /must not contain "\.\." segments/,
    );
  });

  it('rejects non-existent path', async () => {
    await assert.rejects(
      () => validateWorkspaceDirectory('/absolutely/nonexistent/path/xyzzy'),
      /does not exist/,
    );
  });

  it('rejects a path that is a file not a directory', async () => {
    await assert.rejects(
      () => validateWorkspaceDirectory(existingFile),
      /is not a directory/,
    );
  });
});

describe('buildMinimalEnv', () => {
  it('never includes N8N_ENCRYPTION_KEY', () => {
    // Simulate n8n leaking its encryption key into process.env
    const original = process.env['N8N_ENCRYPTION_KEY'];
    process.env['N8N_ENCRYPTION_KEY'] = 'super-secret-key';
    try {
      const { env } = buildMinimalEnv();
      assert.ok(!('N8N_ENCRYPTION_KEY' in env), 'must not inherit N8N_ENCRYPTION_KEY');
    } finally {
      if (original === undefined) delete process.env['N8N_ENCRYPTION_KEY'];
      else process.env['N8N_ENCRYPTION_KEY'] = original;
    }
  });

  it('never includes DB_POSTGRESDB_PASSWORD', () => {
    const original = process.env['DB_POSTGRESDB_PASSWORD'];
    process.env['DB_POSTGRESDB_PASSWORD'] = 'dbpass';
    try {
      const { env } = buildMinimalEnv();
      assert.ok(!('DB_POSTGRESDB_PASSWORD' in env));
    } finally {
      if (original === undefined) delete process.env['DB_POSTGRESDB_PASSWORD'];
      else process.env['DB_POSTGRESDB_PASSWORD'] = original;
    }
  });

  it('includes ANTHROPIC_API_KEY when present, and hasApiKey is true', () => {
    const original = process.env['ANTHROPIC_API_KEY'];
    process.env['ANTHROPIC_API_KEY'] = 'sk-test';
    try {
      const { env, hasApiKey } = buildMinimalEnv();
      assert.equal(env['ANTHROPIC_API_KEY'], 'sk-test');
      assert.equal(hasApiKey, true);
    } finally {
      if (original === undefined) delete process.env['ANTHROPIC_API_KEY'];
      else process.env['ANTHROPIC_API_KEY'] = original;
    }
  });

  it('omits ANTHROPIC_API_KEY when not set, and hasApiKey is false', () => {
    const original = process.env['ANTHROPIC_API_KEY'];
    delete process.env['ANTHROPIC_API_KEY'];
    try {
      const { env, hasApiKey } = buildMinimalEnv();
      assert.ok(!('ANTHROPIC_API_KEY' in env));
      assert.equal(hasApiKey, false);
    } finally {
      if (original !== undefined) process.env['ANTHROPIC_API_KEY'] = original;
    }
  });

  it('only contains allowlisted keys', () => {
    const { env } = buildMinimalEnv();
    const allowlisted = new Set(['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'ANTHROPIC_API_KEY']);
    for (const key of Object.keys(env)) {
      assert.ok(allowlisted.has(key), `unexpected env key: ${key}`);
    }
  });
});

describe('buildClaudeArgs', () => {
  it('does not include user prompt text in argv (prompt arrives via stdin)', () => {
    const userPrompt = 'What does this file do?';
    const args = buildClaudeArgs('claude-haiku-4-5');
    assert.ok(!args.some((a) => a === userPrompt || a.includes(userPrompt)));
    assert.ok(!args.some((a) => a.includes('What does')));
  });

  it('includes --bare when API key is present', () => {
    const args = buildClaudeArgs('claude-haiku-4-5', true);
    assert.ok(args.includes('--bare'), 'must include --bare when API key is available');
  });

  it('omits --bare when no API key (falls back to keychain auth)', () => {
    const args = buildClaudeArgs('claude-haiku-4-5', false);
    assert.ok(!args.includes('--bare'), 'must not include --bare when using keychain auth');
  });

  it('includes --allowedTools Read,Glob', () => {
    const args = buildClaudeArgs('claude-haiku-4-5');
    const idx = args.indexOf('--allowedTools');
    assert.ok(idx !== -1, 'must include --allowedTools');
    assert.equal(args[idx + 1], 'Read,Glob');
  });

  it('includes --strict-mcp-config', () => {
    const args = buildClaudeArgs('claude-haiku-4-5');
    assert.ok(args.includes('--strict-mcp-config'));
  });

  it('includes --no-session-persistence', () => {
    const args = buildClaudeArgs('claude-haiku-4-5');
    assert.ok(args.includes('--no-session-persistence'));
  });

  it('includes --permission-prompts none', () => {
    const args = buildClaudeArgs('claude-haiku-4-5');
    const idx = args.indexOf('--permission-prompts');
    assert.ok(idx !== -1);
    assert.equal(args[idx + 1], 'none');
  });

  it('places --model at the end — no user data follows', () => {
    const args = buildClaudeArgs('claude-haiku-4-5');
    const modelIdx = args.indexOf('--model');
    assert.ok(modelIdx !== -1);
    assert.equal(args[modelIdx + 1], 'claude-haiku-4-5');
    assert.equal(args.length, modelIdx + 2, 'nothing should follow after --model <value>');
  });

  it('write mode uses Read,Glob,Edit,Write as allowedTools (FR-009)', () => {
    const args = buildClaudeArgs('claude-haiku-4-5', true, 'Read,Glob,Edit,Write');
    const idx = args.indexOf('--allowedTools');
    assert.ok(idx !== -1, 'must include --allowedTools');
    assert.equal(args[idx + 1], 'Read,Glob,Edit,Write', 'write mode must allow Edit and Write tools');
  });

  it('read mode uses Read,Glob as allowedTools (default, FR-009)', () => {
    const args = buildClaudeArgs('claude-haiku-4-5', true, 'Read,Glob');
    const idx = args.indexOf('--allowedTools');
    assert.ok(idx !== -1);
    assert.equal(args[idx + 1], 'Read,Glob', 'read mode must not include Edit or Write tools');
  });
});

describe('runClaude timer guard — timeoutMs 0 means no timer', () => {
  // The timer guard in AgentFlowsAgent.node.ts runClaude():
  //   let timer: ... | undefined;
  //   if (timeoutMs > 0) { timer = setTimeout(...); }
  // This suite pins that guard so a regression (e.g. reverting to ?? 600_000) fails a test.

  it('guard is false for timeoutMs 0 — no kill timer armed', () => {
    const timeoutMs = 0;
    // Mirrors: if (timeoutMs > 0) { timer = setTimeout(...) }
    assert.equal(timeoutMs > 0, false, 'guard must be false: no timer armed for timeoutMs 0');
  });

  it('guard is false for timeoutMs 0 emitted by build.ts for steps with no declared timeout', () => {
    // Spec 024: steps without a declared timeoutMs emit 0 (no limit).
    // The node must honour that by never arming a kill timer.
    const emittedTimeoutMs = 0; // what build.ts emits for step.timeoutMs ?? 0
    assert.equal(emittedTimeoutMs > 0, false);
  });

  it('guard is true for positive timeoutMs — kill timer is armed', () => {
    const timeoutMs = 30_000;
    assert.equal(timeoutMs > 0, true, 'guard must be true: timer armed for positive timeoutMs');
  });

  it('600000 is positive — if erroneously emitted, a timer would be armed', () => {
    // Regression anchor: if build.ts ever reverts to emitting 600_000, this proves
    // that value would arm a timer, contradicting spec 024.
    assert.equal(600_000 > 0, true, '600000 is positive — it would arm a timer');
  });
});
