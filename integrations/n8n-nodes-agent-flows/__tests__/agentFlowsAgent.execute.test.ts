/**
 * Integration tests for AgentFlowsAgent.execute() — exit-code handling.
 *
 * Why a separate file instead of replicating logic like the sibling test:
 * n8n-workflow's ESM distribution has missing extensions that prevent a
 * static `import` of AgentFlowsAgent.node.ts in an ESM test context.
 * We load the compiled CJS output via createRequire() instead, which
 * resolves n8n-workflow through the CJS path (dist/cjs/) correctly.
 *
 * REQUIRES: `pnpm build` (or `tsc`) must have been run first so that
 * dist/nodes/AgentFlowsAgent/AgentFlowsAgent.node.js exists.
 *
 * The real node:child_process.spawn is used; a fake `claude` shell script
 * is installed in a temporary directory prepended to PATH for each test.
 * This exercises the complete execute() path without any module mocking.
 *
 * Runnable: node --experimental-strip-types --test '__tests__/**\/*.test.ts'
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

// ---------------------------------------------------------------------------
// Load AgentFlowsAgent from the compiled CJS dist (avoids ESM resolution
// issues in the n8n-workflow package during testing).
// ---------------------------------------------------------------------------

const req = createRequire(import.meta.url);
// This require resolves `n8n-workflow` via CJS, which works correctly.
const { AgentFlowsAgent } = req('../dist/nodes/AgentFlowsAgent/AgentFlowsAgent.node.js') as {
  AgentFlowsAgent: new () => { execute(this: unknown): Promise<{ json: Record<string, unknown> }[][]> };
};

// ---------------------------------------------------------------------------
// Fake claude binary factory
// ---------------------------------------------------------------------------

/**
 * Creates a temporary directory containing a `claude` shell script that
 * prints the given output to stdout and exits with the given code.
 * Returns the directory path; the caller must clean it up.
 */
async function makeFakeClaude(exitCode: number, output: string): Promise<string> {
  const dir = join(tmpdir(), `fake-claude-${randomUUID()}`);
  await fs.mkdir(dir, { recursive: true });
  // Single-quote the output for shell safety; escape any embedded single quotes.
  const escaped = output.replace(/'/g, "'\"'\"'");
  const script = `#!/bin/sh\nprintf '%s' '${escaped}'\nexit ${exitCode}\n`;
  await fs.writeFile(join(dir, 'claude'), script, { mode: 0o755 });
  return dir;
}

// ---------------------------------------------------------------------------
// Minimal n8n IExecuteFunctions stub
// ---------------------------------------------------------------------------

function makeContext(overrides: Partial<{
  role: string;
  model: string;
  workspaceAccess: string;
  prompt: string;
  timeoutMs: number;
}> = {}) {
  const params: Record<string, unknown> = {
    role: 'scout',
    model: '',
    workspaceAccess: 'none', // avoids real workspace directory validation
    workspaceDirectory: '',
    prompt: 'test prompt',
    timeoutMs: 0,
    ...overrides,
  };

  return {
    getInputData: () => [{ json: {}, pairedItem: { item: 0 } }],
    getNodeParameter: (name: string, _i: number, defaultVal?: unknown) =>
      name in params ? params[name] : defaultVal,
    getNode: () => ({
      id: 'test-node-id',
      name: 'Test Agent Node',
      type: 'agentFlowsAgent',
      typeVersion: 1,
      position: [0, 0] as [number, number],
      parameters: {},
    }),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AgentFlowsAgent.execute — exit-code handling', () => {
  // Each test sets up its own fake claude dir and temporarily prepends it
  // to PATH so runClaude()'s buildMinimalEnv() picks up the fake binary.

  it('returns an output item with output and exitCode 0 when the process exits 0', async () => {
    const fakeDir = await makeFakeClaude(0, 'survey findings here');
    const origPath = process.env.PATH;
    process.env.PATH = `${fakeDir}:${origPath}`;

    try {
      const node = new AgentFlowsAgent();
      const result = await (node as unknown as {
        execute(this: unknown): Promise<{ json: Record<string, unknown> }[][]>;
      }).execute.call(makeContext());

      assert.equal(result.length, 1, 'must return exactly one output channel');
      assert.equal(result[0].length, 1, 'must return exactly one item');
      assert.equal(result[0][0].json.exitCode, 0, 'exitCode must be 0 in the output item');
      assert.equal(result[0][0].json.output, 'survey findings here', 'output must carry the stdout');
    } finally {
      process.env.PATH = origPath;
      await fs.rm(fakeDir, { recursive: true, force: true });
    }
  });

  it('throws NodeOperationError (not a green item) when the process exits non-zero', async () => {
    const fakeDir = await makeFakeClaude(1, 'Not logged in · Please run /login');
    const origPath = process.env.PATH;
    process.env.PATH = `${fakeDir}:${origPath}`;

    try {
      const node = new AgentFlowsAgent();

      await assert.rejects(
        () => (node as unknown as {
          execute(this: unknown): Promise<unknown>;
        }).execute.call(makeContext()),
        (err: Error) => {
          // Must be NodeOperationError — not a plain success item.
          assert.match(
            err.constructor.name,
            /NodeOperationError/,
            `expected NodeOperationError, got ${err.constructor.name}: ${err.message}`,
          );
          // Error message must identify the exit code so the operator sees the cause.
          assert.match(err.message, /exit.*code.*1|code.*1/i,
            `message must name exit code 1, got: ${err.message}`);
          // Error message must include an excerpt of the process output.
          assert.match(err.message, /Not logged in/,
            `message must include output excerpt, got: ${err.message}`);
          return true;
        },
      );
    } finally {
      process.env.PATH = origPath;
      await fs.rm(fakeDir, { recursive: true, force: true });
    }
  });
});
