// tests/schema-alignment-llm-check.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ReviewEngine, ReviewInput, ReviewOutput } from '../src/adapters/review-engine/types.ts';

function makeMockEngine(jsonResponse: string): ReviewEngine {
  return {
    label: 'mock',
    review: async (_input: ReviewInput): Promise<ReviewOutput> => ({
      findings: [],
      rawOutput: jsonResponse,
    }),
    estimateTokens: (s: string) => Math.ceil(s.length / 4),
  } as unknown as ReviewEngine;
}

describe('runLlmCheck', () => {
  it('returns findings from engine JSON response', async () => {
    const { runLlmCheck } = await import('../src/core/schema-alignment/llm-check.ts');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-llm-'));
    const migFile = path.join(dir, 'migration.sql');
    fs.writeFileSync(migFile, 'ALTER TABLE users ADD COLUMN status text;');

    const gapResults = [{
      entity: { table: 'users', column: 'status', operation: 'add_column' as const },
      typeLayer: null,
      apiLayer: null,
      uiLayer: null,
    }];

    const mockJson = JSON.stringify([{
      table: 'users',
      column: 'status',
      operation: 'add_column',
      layer: 'type',
      message: 'status field missing from User type',
      severity: 'warning',
      confidence: 'high',
    }]);

    const engine = makeMockEngine(mockJson);
    const findings = await runLlmCheck([migFile], gapResults, engine);

    assert.equal(findings.length, 1);
    assert.equal(findings[0]!.layer, 'type');
    assert.equal(findings[0]!.entity.column, 'status');
    fs.rmSync(dir, { recursive: true });
  });

  it('returns [] when engine returns non-JSON output', async () => {
    const { runLlmCheck } = await import('../src/core/schema-alignment/llm-check.ts');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-llm-'));
    const migFile = path.join(dir, 'migration.sql');
    fs.writeFileSync(migFile, 'ALTER TABLE users ADD COLUMN x text;');
    const engine = makeMockEngine('No issues found.');
    const findings = await runLlmCheck([migFile], [], engine);
    assert.deepEqual(findings, []);
    fs.rmSync(dir, { recursive: true });
  });

  it('returns [] when engine throws', async () => {
    const { runLlmCheck } = await import('../src/core/schema-alignment/llm-check.ts');
    const engine = {
      label: 'mock',
      review: async () => { throw new Error('network error'); },
      estimateTokens: () => 0,
    } as unknown as ReviewEngine;
    const findings = await runLlmCheck([], [], engine);
    assert.deepEqual(findings, []);
  });

  it('truncates migration content to respect 6000 char budget', async () => {
    const { runLlmCheck } = await import('../src/core/schema-alignment/llm-check.ts');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-llm-'));
    const migFile = path.join(dir, 'big.sql');
    // Write a migration larger than the budget
    fs.writeFileSync(migFile, 'x'.repeat(10000));
    let capturedContent = '';
    const engine = {
      label: 'mock',
      review: async (input: ReviewInput): Promise<ReviewOutput> => {
        capturedContent = input.content;
        return { findings: [], rawOutput: '[]' };
      },
      estimateTokens: (s: string) => Math.ceil(s.length / 4),
    } as unknown as ReviewEngine;
    await runLlmCheck([migFile], [], engine);
    assert.ok(capturedContent.length <= 7000, `content too large: ${capturedContent.length}`);
    fs.rmSync(dir, { recursive: true });
  });
});
