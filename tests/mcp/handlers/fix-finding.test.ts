// tests/mcp/handlers/fix-finding.test.ts
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { handleFixFinding } from '../../../src/core/mcp/handlers/fix-finding.ts';
import { saveRun, checksumFile } from '../../../src/core/mcp/run-store.ts';
import type { ReviewEngine, ReviewInput, ReviewOutput } from '../../../src/adapters/review-engine/types.ts';
import type { GuardrailConfig } from '../../../src/core/config/types.ts';
import type { Finding } from '../../../src/core/findings/types.ts';

function makeEngine(patch = 'const x = 2;'): ReviewEngine {
  return {
    name: 'mock', apiVersion: '1.0.0',
    getCapabilities: () => ({ structuredOutput: false, streaming: false, maxContextTokens: 128000, inlineComments: false }),
    estimateTokens: (c: string) => c.length,
    review: async (_: ReviewInput): Promise<ReviewOutput> => ({ findings: [], rawOutput: patch, usage: undefined }),
  };
}

const BASE_CONFIG: GuardrailConfig = { configVersion: 1 };

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: 'f1', source: 'review-engine', severity: 'critical', category: 'security',
    file: 'foo.ts', line: 1, message: 'bad code', protectedPath: false,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('handleFixFinding', () => {
  let tmp: string;

  it('returns skipped for dry_run:true', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fix-finding-test-'));
    const file = path.join(tmp, 'foo.ts');
    fs.writeFileSync(file, 'const x = 1;\n');
    const finding = makeFinding();
    saveRun(tmp, 'run1', [finding], { 'foo.ts': checksumFile(file) });
    const result = await handleFixFinding(
      { run_id: 'run1', finding_id: 'f1', cwd: tmp, dry_run: true },
      BASE_CONFIG,
      makeEngine(),
    );
    assert.equal(result.status, 'skipped');
    assert.ok(typeof result.patch === 'string');
    // MCP responses must be ANSI-free so machine clients (Claude Code, Cursor)
    // can parse the diff cleanly.
    assert.ok(!/\x1b\[/.test(result.patch ?? ''), 'patch must not contain ANSI escapes');
    assert.deepEqual(result.appliedFiles, []);
    fs.rmSync(tmp, { recursive: true });
  });

  it('returns human_required when file checksum drifted', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fix-finding-test-'));
    const file = path.join(tmp, 'foo.ts');
    fs.writeFileSync(file, 'const x = 1;\n');
    const finding = makeFinding();
    // Save with stale checksum
    saveRun(tmp, 'run2', [finding], { 'foo.ts': 'stale_checksum_value' });
    const result = await handleFixFinding(
      { run_id: 'run2', finding_id: 'f1', cwd: tmp },
      BASE_CONFIG,
      makeEngine(),
    );
    assert.equal(result.status, 'human_required');
    assert.equal(result.reason, 'file_changed');
    fs.rmSync(tmp, { recursive: true });
  });

  it('returns human_required for protected path', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fix-finding-test-'));
    const file = path.join(tmp, 'foo.ts');
    fs.writeFileSync(file, 'const x = 1;\n');
    const finding = makeFinding({ protectedPath: true });
    saveRun(tmp, 'run3', [finding], { 'foo.ts': checksumFile(file) });
    const result = await handleFixFinding(
      { run_id: 'run3', finding_id: 'f1', cwd: tmp },
      BASE_CONFIG,
      makeEngine(),
    );
    assert.equal(result.status, 'human_required');
    assert.equal(result.reason, 'protected_path');
    fs.rmSync(tmp, { recursive: true });
  });

  it('throws for missing run_id', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fix-finding-test-'));
    await assert.rejects(
      () => handleFixFinding({ run_id: 'nonexistent', finding_id: 'f1', cwd: tmp }, BASE_CONFIG, makeEngine()),
      /run_not_found/,
    );
    fs.rmSync(tmp, { recursive: true });
  });

  it('throws for missing finding_id', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fix-finding-test-'));
    saveRun(tmp, 'run4', [], {});
    await assert.rejects(
      () => handleFixFinding({ run_id: 'run4', finding_id: 'nonexistent', cwd: tmp }, BASE_CONFIG, makeEngine()),
      /finding_not_found/,
    );
    fs.rmSync(tmp, { recursive: true });
  });
});
