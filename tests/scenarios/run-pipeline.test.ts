import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { runGuardrail } from '../../src/core/pipeline/run.ts';
import type { RunInput } from '../../src/core/pipeline/run.ts';
import type { StaticRule } from '../../src/core/phases/static-rules.ts';
import type { ReviewEngine, ReviewInput, ReviewOutput } from '../../src/adapters/review-engine/types.ts';
import type { Finding } from '../../src/core/findings/types.ts';
import type { Capabilities } from '../../src/adapters/base.ts';

// ── helpers ─────────────────────────────────────────────────────────────────

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: 'test-finding',
    source: 'static-rules',
    severity: 'warning',
    category: 'test',
    file: 'test.ts',
    message: 'test finding',
    protectedPath: false,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeEngine(findings: Finding[] = [], costUSD?: number): ReviewEngine {
  return {
    name: 'mock',
    apiVersion: '1.0.0',
    getCapabilities(): Capabilities { return { maxContextTokens: 100000 }; },
    estimateTokens(content: string): number { return Math.ceil(content.length / 4); },
    async review(_input: ReviewInput): Promise<ReviewOutput> {
      return {
        findings,
        rawOutput: 'mock output',
        usage: { input: 100, output: 50, costUSD },
      };
    },
  };
}

function makeRule(findings: Finding[], name = 'mock-rule'): StaticRule {
  return {
    name,
    severity: 'critical',
    async check(_files: string[]): Promise<Finding[]> { return findings; },
  };
}

async function makeTempFile(dir: string, name: string, content: string): Promise<string> {
  const p = path.join(dir, name);
  await fs.writeFile(p, content, 'utf8');
  return p;
}

// ── scenario tests ───────────────────────────────────────────────────────────

describe('run pipeline — scenarios', () => {

  it('S1: clean run with no rules, no test command, no engine → pass', async () => {
    const result = await runGuardrail({
      touchedFiles: [],
      config: { configVersion: 1, testCommand: null },
    });
    assert.equal(result.status, 'pass');
    assert.equal(result.phases.length, 1); // only tests phase (skip)
    assert.equal(result.allFindings.length, 0);
  });

  it('S2: static-rule warning does not fail-fast', async () => {
    const rule = makeRule([makeFinding({ severity: 'warning' })]);
    const result = await runGuardrail({
      touchedFiles: ['foo.ts'],
      config: { configVersion: 1, testCommand: null },
      staticRules: [rule],
    });
    assert.equal(result.status, 'warn');
    assert.ok(result.phases.find(p => p.phase === 'static-rules'));
    assert.ok(result.phases.find(p => p.phase === 'tests'));
  });

  it('S3a: static-rule critical keeps running by default (runReviewOnStaticFail true)', async () => {
    const rule = makeRule([makeFinding({ id: 'r1', severity: 'critical' })]);
    const result = await runGuardrail({
      touchedFiles: ['foo.ts'],
      config: { configVersion: 1, testCommand: null },
      staticRules: [rule],
    });
    assert.equal(result.status, 'fail');
    // Both static-rules and tests phases ran — the v4.0 short-circuit is off by default
    // because users who wire up later phases expect them to run.
    assert.equal(result.phases.length, 2);
    assert.equal(result.phases[0]!.phase, 'static-rules');
    assert.equal(result.phases[1]!.phase, 'tests');
  });

  it('S3b: static-rule critical fails fast when runReviewOnStaticFail=false', async () => {
    const rule = makeRule([makeFinding({ id: 'r1', severity: 'critical' })]);
    const result = await runGuardrail({
      touchedFiles: ['foo.ts'],
      config: {
        configVersion: 1,
        testCommand: 'this-command-does-not-exist',
        pipeline: { runReviewOnStaticFail: false },
      },
      staticRules: [rule],
    });
    assert.equal(result.status, 'fail');
    // Opt-in legacy fail-fast: only static-rules ran
    assert.equal(result.phases.length, 1);
    assert.equal(result.phases[0]!.phase, 'static-rules');
  });

  it('S4: tests fail → review phase not run', async () => {
    const engine = makeEngine([makeFinding()]);
    const result = await runGuardrail({
      touchedFiles: [],
      config: { configVersion: 1, testCommand: 'this-command-does-not-exist-999' },
      reviewEngine: engine,
    });
    assert.equal(result.status, 'fail');
    assert.ok(!result.phases.find(p => p.phase === 'review'));
  });

  it('S5: review engine returns criticals → status fail', async () => {
    const engine = makeEngine([makeFinding({ severity: 'critical', source: 'review-engine' })]);
    const result = await runGuardrail({
      touchedFiles: ['__mock_file_s5__.ts'], // nonexistent but non-empty so review runs
      config: { configVersion: 1, testCommand: null },
      reviewEngine: engine,
    });
    assert.equal(result.status, 'fail');
    assert.ok(result.phases.find(p => p.phase === 'review'));
  });

  it('S6: review engine returns warnings → status warn', async () => {
    const engine = makeEngine([makeFinding({ severity: 'warning', source: 'review-engine' })]);
    const result = await runGuardrail({
      touchedFiles: ['__mock_file_s6__.ts'],
      config: { configVersion: 1, testCommand: null },
      reviewEngine: engine,
    });
    assert.equal(result.status, 'warn');
  });

  it('S7: review engine clean → status pass', async () => {
    const engine = makeEngine([]);
    const result = await runGuardrail({
      touchedFiles: [],
      config: { configVersion: 1, testCommand: null },
      reviewEngine: engine,
    });
    assert.equal(result.status, 'pass');
  });

  it('S8: costUSD accumulated in RunResult', async () => {
    const engine = makeEngine([], 0.05);
    const result = await runGuardrail({
      touchedFiles: ['__mock_file_s8__.ts'],
      config: { configVersion: 1, testCommand: null },
      reviewEngine: engine,
    });
    assert.equal(result.totalCostUSD, 0.05);
  });

  it('S9: no cost when engine returns no costUSD', async () => {
    const engine = makeEngine([]);
    const result = await runGuardrail({
      touchedFiles: [],
      config: { configVersion: 1, testCommand: null },
      reviewEngine: engine,
    });
    assert.equal(result.totalCostUSD, undefined);
  });

  it('S10: allFindings aggregated across phases', async () => {
    const ruleWarning = makeFinding({ id: 'rule-w', severity: 'warning' });
    const reviewNote = makeFinding({ id: 'review-n', severity: 'note', source: 'review-engine' });
    const rule = makeRule([ruleWarning]);
    const engine = makeEngine([reviewNote]);
    const result = await runGuardrail({
      touchedFiles: ['x.ts'],
      config: { configVersion: 1, testCommand: null },
      staticRules: [rule],
      reviewEngine: engine,
    });
    assert.equal(result.allFindings.length, 2);
  });

  it('S11: durationMs is positive', async () => {
    const result = await runGuardrail({
      touchedFiles: [],
      config: { configVersion: 1, testCommand: null },
    });
    assert.ok(result.durationMs >= 0);
  });

  it('S12: budget 0 → budget-exceeded warning emitted', async () => {
    const engine = makeEngine([], 0.01);
    const result = await runGuardrail({
      touchedFiles: ['__mock_file_s12__.ts'],
      config: { configVersion: 1, testCommand: null, cost: { maxPerRun: 0 } },
      reviewEngine: engine,
    });
    const budgetFinding = result.allFindings.find(f => f.id === 'budget-exceeded');
    assert.ok(budgetFinding, 'expected budget-exceeded finding');
    assert.equal(budgetFinding!.severity, 'warning');
  });

  it('S13: autofix rule — fixed finding does not prevent pass', async () => {
    let fixed = false;
    const rule: StaticRule = {
      name: 'fixable',
      severity: 'critical',
      async check(_files: string[]): Promise<Finding[]> {
        if (fixed) return [];
        // category must match rule.name so findRuleForFinding can locate the autofix handler
        return [makeFinding({ id: 'fixable-1', severity: 'critical', category: 'fixable' })];
      },
      async autofix(_finding: Finding) {
        fixed = true;
        return 'fixed' as const;
      },
    };
    const result = await runGuardrail({
      touchedFiles: ['foo.ts'],
      config: { configVersion: 1, testCommand: null },
      staticRules: [rule],
    });
    assert.equal(result.status, 'pass');
  });

  it('S14: review phase skipped when no touched files (empty list)', async () => {
    let reviewCalled = false;
    const engine: ReviewEngine = {
      ...makeEngine([]),
      async review(_input: ReviewInput): Promise<ReviewOutput> {
        reviewCalled = true;
        return { findings: [], rawOutput: '' };
      },
    };
    await runGuardrail({
      touchedFiles: [],
      config: { configVersion: 1, testCommand: null },
      reviewEngine: engine,
    });
    assert.equal(reviewCalled, false);
  });

  it('S15: multiple static rules — all findings collected', async () => {
    // Different file paths ensure dedup does not collapse them to one
    const r1 = makeRule([makeFinding({ id: 'r1', file: 'a.ts' })], 'rule-1');
    const r2 = makeRule([makeFinding({ id: 'r2', file: 'b.ts' })], 'rule-2');
    const result = await runGuardrail({
      touchedFiles: ['a.ts'],
      config: { configVersion: 1, testCommand: null },
      staticRules: [r1, r2],
    });
    assert.equal(result.allFindings.length, 2);
  });
});

describe('chunking — scenarios', () => {
  it('S16: single-pass — all files in one chunk', async () => {
    let callCount = 0;
    const engine: ReviewEngine = {
      ...makeEngine([]),
      async review(_input: ReviewInput): Promise<ReviewOutput> {
        callCount++;
        return { findings: [], rawOutput: '' };
      },
    };
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ap-test-'));
    try {
      await makeTempFile(dir, 'a.ts', 'const a = 1;');
      await makeTempFile(dir, 'b.ts', 'const b = 2;');
      await runGuardrail({
        touchedFiles: ['a.ts', 'b.ts'],
        config: { configVersion: 1, testCommand: null, reviewStrategy: 'single-pass' },
        reviewEngine: engine,
        cwd: dir,
      });
      assert.equal(callCount, 1);
    } finally {
      await fs.rm(dir, { recursive: true });
    }
  });

  it('S17: file-level — one call per file', async () => {
    let callCount = 0;
    const engine: ReviewEngine = {
      ...makeEngine([]),
      async review(_input: ReviewInput): Promise<ReviewOutput> {
        callCount++;
        return { findings: [], rawOutput: '' };
      },
    };
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ap-test-'));
    try {
      await makeTempFile(dir, 'a.ts', 'const a = 1;');
      await makeTempFile(dir, 'b.ts', 'const b = 2;');
      await runGuardrail({
        touchedFiles: ['a.ts', 'b.ts'],
        config: { configVersion: 1, testCommand: null, reviewStrategy: 'file-level' },
        reviewEngine: engine,
        cwd: dir,
      });
      assert.equal(callCount, 2);
    } finally {
      await fs.rm(dir, { recursive: true });
    }
  });

  it('S18: auto strategy — small files → single-pass (1 call)', async () => {
    let callCount = 0;
    const engine: ReviewEngine = {
      ...makeEngine([]),
      estimateTokens(_c: string): number { return 10; }, // always tiny
      async review(_input: ReviewInput): Promise<ReviewOutput> {
        callCount++;
        return { findings: [], rawOutput: '' };
      },
    };
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ap-test-'));
    try {
      await makeTempFile(dir, 'tiny.ts', 'x');
      await runGuardrail({
        touchedFiles: ['tiny.ts'],
        config: { configVersion: 1, testCommand: null, reviewStrategy: 'auto' },
        reviewEngine: engine,
        cwd: dir,
      });
      assert.equal(callCount, 1);
    } finally {
      await fs.rm(dir, { recursive: true });
    }
  });

  it('S19: auto strategy — large content → file-level (multiple calls)', async () => {
    let callCount = 0;
    const engine: ReviewEngine = {
      ...makeEngine([]),
      estimateTokens(_c: string): number { return 100000; }, // always huge
      async review(_input: ReviewInput): Promise<ReviewOutput> {
        callCount++;
        return { findings: [], rawOutput: '' };
      },
    };
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ap-test-'));
    try {
      await makeTempFile(dir, 'big1.ts', 'const big1 = true;');
      await makeTempFile(dir, 'big2.ts', 'const big2 = true;');
      await runGuardrail({
        touchedFiles: ['big1.ts', 'big2.ts'],
        config: { configVersion: 1, testCommand: null, reviewStrategy: 'auto' },
        reviewEngine: engine,
        cwd: dir,
      });
      assert.equal(callCount, 2);
    } finally {
      await fs.rm(dir, { recursive: true });
    }
  });
});

describe('presets — load scenarios', () => {
  it('S20: all 5 presets have valid YAML and stack.md', async () => {
    const { resolvePreset } = await import('../../src/core/config/preset-resolver.ts');
    const presets = ['nextjs-supabase', 't3', 'rails-postgres', 'python-fastapi', 'go'];
    for (const name of presets) {
      const resolved = await resolvePreset(name);
      assert.equal(resolved.config.configVersion, 1);
      assert.ok(resolved.stack.length > 0, `${name} stack.md should not be empty`);
      assert.ok(resolved.name === name);
    }
  });
});
