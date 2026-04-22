import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { formatComment } from '../src/cli/pr-comment.ts';
import type { RunResult } from '../src/core/pipeline/run.ts';
import type { AutopilotConfig } from '../src/core/config/types.ts';
import type { GitContext } from '../src/core/detect/git-context.ts';

function makeResult(overrides: Partial<RunResult> = {}): RunResult {
  return {
    status: 'pass',
    phases: [],
    allFindings: [],
    durationMs: 1234,
    ...overrides,
  };
}

const baseConfig: AutopilotConfig = { configVersion: 1, stack: 'Next.js 15 + Supabase' };
const baseGitCtx: GitContext = { branch: 'feat/auth', commitMessage: 'add login', summary: 'branch: feat/auth | last commit: add login' };

describe('formatComment', () => {
  test('includes marker so existing comment can be found', () => {
    const body = formatComment(makeResult(), baseConfig, baseGitCtx, 5);
    assert.ok(body.startsWith('<!-- autopilot-review -->'));
  });

  test('shows pass status', () => {
    const body = formatComment(makeResult({ status: 'pass' }), baseConfig, baseGitCtx, 3);
    assert.ok(body.includes('✅') && body.includes('Passed'));
  });

  test('shows fail status', () => {
    const body = formatComment(makeResult({ status: 'fail' }), baseConfig, baseGitCtx, 3);
    assert.ok(body.includes('❌') && body.includes('Failed'));
  });

  test('shows warn status', () => {
    const body = formatComment(makeResult({ status: 'warn' }), baseConfig, baseGitCtx, 3);
    assert.ok(body.includes('⚠️') && body.includes('warnings'));
  });

  test('includes stack and branch from context', () => {
    const body = formatComment(makeResult(), baseConfig, baseGitCtx, 2);
    assert.ok(body.includes('Next.js 15 + Supabase'));
    assert.ok(body.includes('feat/auth'));
  });

  test('renders critical findings with file:line', () => {
    const result = makeResult({
      status: 'fail',
      allFindings: [{
        id: 'test-0', source: 'review-engine', severity: 'critical',
        category: 'review-engine', file: 'app/api/auth.ts', line: 42,
        message: 'Missing auth check', suggestion: 'Add middleware',
        protectedPath: false, createdAt: new Date().toISOString(),
      }],
    });
    const body = formatComment(result, baseConfig, baseGitCtx, 1);
    assert.ok(body.includes('🚨 Critical'));
    assert.ok(body.includes('`app/api/auth.ts:42`'));
    assert.ok(body.includes('Missing auth check'));
    assert.ok(body.includes('Add middleware'));
  });

  test('folds notes into details block', () => {
    const result = makeResult({
      status: 'pass',
      allFindings: [{
        id: 'test-0', source: 'review-engine', severity: 'note',
        category: 'review-engine', file: '<unspecified>',
        message: 'Consider extracting helper', suggestion: undefined,
        protectedPath: false, createdAt: new Date().toISOString(),
      }],
    });
    const body = formatComment(result, baseConfig, baseGitCtx, 1);
    assert.ok(body.includes('<details>'));
    assert.ok(body.includes('Consider extracting helper'));
  });

  test('shows cost when present', () => {
    const body = formatComment(makeResult({ totalCostUSD: 0.0042 }), baseConfig, baseGitCtx, 1);
    assert.ok(body.includes('$0.0042'));
  });

  test('omits cost line when totalCostUSD is undefined', () => {
    const body = formatComment(makeResult(), baseConfig, baseGitCtx, 1);
    assert.ok(!body.includes('Cost:'));
  });

  test('shows phase table rows', () => {
    const result = makeResult({
      phases: [
        { phase: 'static-rules', status: 'pass', findings: [], durationMs: 100 },
        { phase: 'tests', status: 'skip', findings: [], durationMs: 0 },
      ] as RunResult['phases'],
    });
    const body = formatComment(result, baseConfig, baseGitCtx, 2);
    assert.ok(body.includes('static-rules'));
    assert.ok(body.includes('tests'));
  });
});
