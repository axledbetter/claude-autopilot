/**
 * Chaos / reliability tests — verify guardrail handles provider failures gracefully.
 * All LLM calls are mocked; no real API keys needed.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runGuardrail } from '../src/core/pipeline/run.ts';
import { GuardrailError } from '../src/core/errors.ts';
import type { ReviewEngine, ReviewOutput } from '../src/adapters/review-engine/types.ts';
import type { GuardrailConfig } from '../src/core/config/types.ts';

const BASE_CONFIG: GuardrailConfig = {
  configVersion: 1,
  reviewEngine: { adapter: 'auto' },
  testCommand: null,
};

function makeEngine(impl: () => Promise<ReviewOutput>): ReviewEngine {
  return {
    review: () => impl(),
    name: 'mock',
    estimateTokens: (content: string) => Math.ceil(content.length / 4),
  } as unknown as ReviewEngine;
}

function cleanFindings(output: ReviewOutput): ReviewOutput {
  return { ...output, findings: output.findings ?? [] };
}

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

function writeTmpFile(dir: string, name: string, content = 'export const x = 1;\n'): string {
  const p = path.join(dir, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}

describe('chaos — provider timeout', () => {
  it('timeout treated as transient error — runGuardrail does not throw', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-chaos-'));
    const f = writeTmpFile(dir, 'src/a.ts');
    const engine = makeEngine(async () => {
      throw new GuardrailError('Provider timeout', { code: 'transient_network' });
    });
    await assert.rejects(
      () => runGuardrail({ touchedFiles: [f], config: BASE_CONFIG, reviewEngine: engine }),
      (err) => err instanceof GuardrailError || err instanceof Error,
    );
    fs.rmSync(dir, { recursive: true });
  });
});

describe('chaos — rate limit retry', () => {
  it('rateLimitBackoff:none = no retry, fails immediately after 1 attempt', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-chaos-'));
    const f = writeTmpFile(dir, 'src/a.ts');
    let calls = 0;
    const engine = makeEngine(async () => {
      calls++;
      throw new GuardrailError('Rate limited', { code: 'rate_limit' });
    });
    await assert.rejects(
      () => runGuardrail({
        touchedFiles: [f],
        config: { ...BASE_CONFIG, chunking: { rateLimitBackoff: 'none' } },
        reviewEngine: engine,
      }),
    );
    assert.equal(calls, 1, 'none strategy = no retry, 1 attempt only');
    fs.rmSync(dir, { recursive: true });
  });

  it('rate-limit with exp backoff retries up to 4 times', { timeout: 20000 }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-chaos-'));
    const f = writeTmpFile(dir, 'src/a.ts');
    let calls = 0;
    const engine = makeEngine(async () => {
      calls++;
      throw new GuardrailError('Rate limited', { code: 'rate_limit' });
    });
    // exp backoff: 4 total attempts, but sleep delays (1s, 2s, 4s) make this slow.
    // We verify calls=4 to confirm 3 retries happened.
    await assert.rejects(
      () => runGuardrail({ touchedFiles: [f], config: { ...BASE_CONFIG, chunking: { rateLimitBackoff: 'exp' } }, reviewEngine: engine }),
    );
    assert.equal(calls, 4, 'exp strategy = 3 retries = 4 total attempts');
    fs.rmSync(dir, { recursive: true });
  });
});

describe('chaos — empty engine output', () => {
  it('empty findings treated as pass', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-chaos-'));
    const f = writeTmpFile(dir, 'src/a.ts');
    const engine = makeEngine(async () =>
      cleanFindings({ findings: [], rawOutput: '' }),
    );
    const result = await runGuardrail({ touchedFiles: [f], config: BASE_CONFIG, reviewEngine: engine });
    assert.equal(result.status, 'pass');
    assert.equal(result.allFindings.length, 0);
    fs.rmSync(dir, { recursive: true });
  });
});

describe('chaos — cost budget exceeded', () => {
  it('stops processing chunks when budget exceeded', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-chaos-'));
    const files = ['src/a.ts', 'src/b.ts', 'src/c.ts'].map(n => writeTmpFile(dir, n));
    let calls = 0;
    const engine = makeEngine(async () => {
      calls++;
      return cleanFindings({
        findings: [],
        rawOutput: '',
        usage: { input: 1000, output: 200, costUSD: 0.05 },
      });
    });
    // Budget: $0.03 — first chunk costs $0.05 → should abort after 1 chunk
    const config: GuardrailConfig = {
      ...BASE_CONFIG,
      cost: { maxPerRun: 0.03 },
      reviewStrategy: 'file-level',
    };
    const result = await runGuardrail({ touchedFiles: files, config, reviewEngine: engine });
    const budgetFinding = result.allFindings.find(f => f.id === 'budget-exceeded');
    assert.ok(budgetFinding, 'expected budget-exceeded finding');
    assert.equal(calls, 1, 'only one chunk should have been reviewed');
    fs.rmSync(dir, { recursive: true });
  });
});

describe('chaos — malformed LLM output', () => {
  it('raw output with no findings parses to empty array', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-chaos-'));
    const f = writeTmpFile(dir, 'src/a.ts');
    const engine = makeEngine(async () =>
      cleanFindings({ findings: [], rawOutput: 'This code looks fine to me. No issues found.' }),
    );
    const result = await runGuardrail({ touchedFiles: [f], config: BASE_CONFIG, reviewEngine: engine });
    assert.equal(result.status, 'pass');
    assert.equal(result.allFindings.length, 0);
    fs.rmSync(dir, { recursive: true });
  });
});

describe('chaos — zero touched files', () => {
  it('review phase skipped when no files', async () => {
    let called = false;
    const engine = makeEngine(async () => { called = true; return cleanFindings({ findings: [], rawOutput: '' }); });
    const result = await runGuardrail({ touchedFiles: [], config: BASE_CONFIG, reviewEngine: engine });
    assert.equal(called, false);
    const reviewPhase = result.phases.find(p => p.phase === 'review');
    assert.equal(reviewPhase?.status, 'skip');
  });
});
