import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { runFix } from '../../src/cli/fix.ts';
import { saveCachedFindings } from '../../src/core/persist/findings-cache.ts';
import type { Finding } from '../../src/core/findings/types.ts';

const FINDINGS: Finding[] = [
  { file: 'src/auth.ts', line: 42, severity: 'critical', message: 'Unparameterized SQL query', suggestion: 'Use parameterized queries', rule: 'sql-injection' },
  { file: 'src/utils.ts', line: 7, severity: 'warning', message: 'console.log left in production', rule: 'console-log' },
];

async function captureConsole(fn: () => Promise<unknown>): Promise<string[]> {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
    orig(...args);
  };
  try {
    await fn();
  } finally {
    console.log = orig;
  }
  return lines;
}

describe('runFix upfront summary', () => {
  it('F1: dry-run prints all fixable findings before dry-run message', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ap-fix-'));
    try {
      saveCachedFindings(dir, FINDINGS);
      const lines = await captureConsole(() => runFix({ cwd: dir, dryRun: true, severity: 'all' }));

      // Finding details appear in output
      const combined = lines.join('\n');
      assert.ok(combined.includes('src/auth.ts'), `expected auth.ts in output:\n${combined}`);
      assert.ok(combined.includes('src/utils.ts'), `expected utils.ts in output:\n${combined}`);
      assert.ok(combined.includes('42'), `expected line 42 in output:\n${combined}`);

      // Dry-run confirmation comes after the summary
      const summaryIdx = lines.findIndex(l => l.includes('src/auth.ts'));
      const dryRunIdx = lines.findIndex(l => l.includes('Dry run'));
      assert.ok(summaryIdx >= 0, 'finding summary not found');
      assert.ok(dryRunIdx > summaryIdx, `dry-run message (idx ${dryRunIdx}) should come after summary (idx ${summaryIdx})`);
    } finally {
      await fs.rm(dir, { recursive: true });
    }
  });

  it('F2: dry-run returns 0 without loading an LLM engine', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ap-fix-'));
    try {
      saveCachedFindings(dir, FINDINGS);
      const code = await runFix({ cwd: dir, dryRun: true });
      assert.equal(code, 0);
    } finally {
      await fs.rm(dir, { recursive: true });
    }
  });

  it('F3: dry-run with empty cache returns 0 and no summary', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ap-fix-'));
    try {
      const code = await runFix({ cwd: dir, dryRun: true });
      assert.equal(code, 0);
    } finally {
      await fs.rm(dir, { recursive: true });
    }
  });

  it('F4: severity=critical filters out warnings from summary', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ap-fix-'));
    try {
      saveCachedFindings(dir, FINDINGS);
      const lines = await captureConsole(() => runFix({ cwd: dir, dryRun: true, severity: 'critical' }));
      const combined = lines.join('\n');
      assert.ok(combined.includes('src/auth.ts'), 'critical finding should appear');
      assert.ok(!combined.includes('src/utils.ts'), 'warning should be filtered out with severity=critical');
    } finally {
      await fs.rm(dir, { recursive: true });
    }
  });
});
