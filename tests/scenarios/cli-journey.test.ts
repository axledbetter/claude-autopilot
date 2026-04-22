/**
 * CLI-level integration tests for the scan → cache → fix / report / explain journey.
 * Uses saveCachedFindings to seed the cache (bypassing LLM) and verifies each CLI
 * command reads and presents the data correctly.
 *
 * Covers the wiring between commands that unit tests can't catch:
 *  - cache population → fix dry-run finding list
 *  - cache population → report markdown structure
 *  - cache population → explain listing mode
 *  - runCommand with static rules → cache populated with real findings
 *  - runScan dry-run → file collection without LLM
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import { runFix } from '../../src/cli/fix.ts';
import { runReport } from '../../src/cli/report.ts';
import { runExplain } from '../../src/cli/explain.ts';
import { runScan } from '../../src/cli/scan.ts';
import { runCommand } from '../../src/cli/run.ts';
import { saveCachedFindings, loadCachedFindings } from '../../src/core/persist/findings-cache.ts';
import type { Finding } from '../../src/core/findings/types.ts';

// ── helpers ─────────────────────────────────────────────────────────────────

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: crypto.randomUUID(),
    source: 'review-engine',
    severity: 'critical',
    category: 'security',
    file: 'src/auth.ts',
    line: 42,
    message: 'Unparameterized SQL query allows injection',
    suggestion: 'Use parameterized queries or an ORM',
    protectedPath: false,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

async function captureConsole(fn: () => Promise<unknown>): Promise<{ lines: string[]; combined: string }> {
  const lines: string[] = [];
  const orig = console.log;
  const origErr = console.error;
  const capture = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); orig(...args); };
  console.log = capture;
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); origErr(...args); };
  try {
    await fn();
  } finally {
    console.log = orig;
    console.error = origErr;
  }
  // Strip ANSI codes for assertion readability
  const combined = lines.join('\n').replace(/\x1b\[[0-9;]*m/g, '');
  return { lines, combined };
}

// ── journey tests ────────────────────────────────────────────────────────────

describe('CLI journey — scan → fix', () => {
  it('SJ1: cached critical finding appears in fix dry-run summary', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ap-journey-'));
    try {
      const finding = makeFinding();
      saveCachedFindings(dir, [finding]);

      const { combined } = await captureConsole(() => runFix({ cwd: dir, dryRun: true }));
      assert.ok(combined.includes('src/auth.ts'), `file missing from summary:\n${combined}`);
      assert.ok(combined.includes('42'), `line number missing:\n${combined}`);
      assert.ok(combined.includes('SQL'), `message missing:\n${combined}`);
    } finally {
      await fs.rm(dir, { recursive: true });
    }
  });

  it('SJ2: fix dry-run returns 0 and lists all severities when severity=all', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ap-journey-'));
    try {
      saveCachedFindings(dir, [
        makeFinding({ severity: 'critical', file: 'a.ts', line: 1 }),
        makeFinding({ severity: 'warning',  file: 'b.ts', line: 2 }),
      ]);
      const { combined } = await captureConsole(async () => {
        const code = await runFix({ cwd: dir, dryRun: true, severity: 'all' });
        assert.equal(code, 0);
      });
      assert.ok(combined.includes('a.ts'), combined);
      assert.ok(combined.includes('b.ts'), combined);
    } finally {
      await fs.rm(dir, { recursive: true });
    }
  });

  it('SJ3: default severity=critical omits warnings from fix list', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ap-journey-'));
    try {
      saveCachedFindings(dir, [
        makeFinding({ severity: 'critical', file: 'crit.ts', line: 10 }),
        makeFinding({ severity: 'warning',  file: 'warn.ts', line: 20 }),
      ]);
      const { combined } = await captureConsole(() => runFix({ cwd: dir, dryRun: true }));
      assert.ok(combined.includes('crit.ts'),  `critical finding missing:\n${combined}`);
      assert.ok(!combined.includes('warn.ts'), `warning should be excluded:\n${combined}`);
    } finally {
      await fs.rm(dir, { recursive: true });
    }
  });
});

describe('CLI journey — cache → report', () => {
  it('SJ4: report renders critical findings in markdown', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ap-journey-'));
    try {
      saveCachedFindings(dir, [makeFinding()]);
      const outFile = path.join(dir, 'report.md');
      await runReport({ cwd: dir, output: outFile });
      const md = await fs.readFile(outFile, 'utf8');
      assert.ok(md.includes('# Guardrail Report'),  `missing title:\n${md}`);
      assert.ok(md.includes('Critical'),             `missing critical section:\n${md}`);
      assert.ok(md.includes('src/auth.ts'),          `missing file ref:\n${md}`);
    } finally {
      await fs.rm(dir, { recursive: true });
    }
  });

  it('SJ5: report returns 1 when critical findings present', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ap-journey-'));
    try {
      saveCachedFindings(dir, [makeFinding({ severity: 'critical' })]);
      const code = await runReport({ cwd: dir, output: path.join(dir, 'r.md') });
      assert.equal(code, 1);
    } finally {
      await fs.rm(dir, { recursive: true });
    }
  });

  it('SJ6: report returns 0 when only warnings/notes', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ap-journey-'));
    try {
      saveCachedFindings(dir, [makeFinding({ severity: 'warning' })]);
      const code = await runReport({ cwd: dir, output: path.join(dir, 'r.md') });
      assert.equal(code, 0);
    } finally {
      await fs.rm(dir, { recursive: true });
    }
  });

  it('SJ7: report includes file breakdown table when multiple files', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ap-journey-'));
    try {
      saveCachedFindings(dir, [
        makeFinding({ file: 'a.ts', severity: 'critical' }),
        makeFinding({ file: 'a.ts', severity: 'warning' }),
        makeFinding({ file: 'b.ts', severity: 'critical' }),
      ]);
      const outFile = path.join(dir, 'r.md');
      await runReport({ cwd: dir, output: outFile });
      const md = await fs.readFile(outFile, 'utf8');
      assert.ok(md.includes('a.ts'), md);
      assert.ok(md.includes('b.ts'), md);
    } finally {
      await fs.rm(dir, { recursive: true });
    }
  });
});

describe('CLI journey — cache → explain listing', () => {
  it('SJ8: explain with no target lists findings with indices', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ap-journey-'));
    try {
      saveCachedFindings(dir, [
        makeFinding({ message: 'First finding' }),
        makeFinding({ message: 'Second finding' }),
      ]);
      const { combined } = await captureConsole(() => runExplain({ cwd: dir }));
      assert.ok(combined.includes('First finding'),  `first finding missing:\n${combined}`);
      assert.ok(combined.includes('Second finding'), `second finding missing:\n${combined}`);
      assert.ok(combined.includes('1.'),             `index 1 missing:\n${combined}`);
      assert.ok(combined.includes('2.'),             `index 2 missing:\n${combined}`);
    } finally {
      await fs.rm(dir, { recursive: true });
    }
  });

  it('SJ9: explain returns 0 with no cached findings', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ap-journey-'));
    try {
      const code = await runExplain({ cwd: dir });
      assert.equal(code, 0);
    } finally {
      await fs.rm(dir, { recursive: true });
    }
  });
});

describe('CLI journey — runScan dry-run (no LLM)', () => {
  it('SJ10: scan dry-run with explicit target returns 0 and lists files', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ap-journey-'));
    try {
      await fs.writeFile(path.join(dir, 'foo.ts'), 'const x = 1;\n', 'utf8');
      const { combined } = await captureConsole(async () => {
        const code = await runScan({ cwd: dir, targets: [dir], dryRun: true });
        assert.equal(code, 0);
      });
      assert.ok(combined.includes('foo.ts'), `expected foo.ts in dry-run output:\n${combined}`);
    } finally {
      await fs.rm(dir, { recursive: true });
    }
  });

  it('SJ11: scan dry-run with no targets returns 1 (usage error)', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ap-journey-'));
    try {
      const code = await runScan({ cwd: dir, dryRun: true });
      assert.equal(code, 1);
    } finally {
      await fs.rm(dir, { recursive: true });
    }
  });
});

describe('CLI journey — runCommand → cache populated by static rules', () => {
  it('SJ12: runCommand with static-rule finding → cache written', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ap-journey-'));
    try {
      // Write a file the static rule will flag (a .ts file with console.log)
      await fs.writeFile(path.join(dir, 'index.ts'), 'console.log("debug");\n', 'utf8');
      await fs.writeFile(
        path.join(dir, 'guardrail.config.yaml'),
        'configVersion: 1\ntestCommand: null\nstaticRules:\n  - console-log\n',
        'utf8',
      );

      // Pass absolute path — static rules resolve files via readFileSync relative to process.cwd()
      const absFile = path.join(dir, 'index.ts');
      await runCommand({ cwd: dir, files: [absFile] });

      const cached = loadCachedFindings(dir);
      assert.ok(cached.length > 0, 'expected findings in cache after run');
      assert.ok(cached.some(f => f.id.includes('console')),
        `expected console-log finding, got: ${JSON.stringify(cached.map(f => f.id))}`);
    } finally {
      await fs.rm(dir, { recursive: true });
    }
  });

  it('SJ13: runCommand with no files and no config → returns 0 (zero-config + no changes)', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ap-journey-'));
    try {
      const code = await runCommand({ cwd: dir, files: [] });
      assert.equal(code, 0);
    } finally {
      await fs.rm(dir, { recursive: true });
    }
  });
});
