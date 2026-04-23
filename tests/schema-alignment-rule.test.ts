// tests/schema-alignment-rule.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

describe('schema-alignment rule', () => {
  it('returns [] when no migration files are touched', async () => {
    const { schemaAlignmentRule } = await import('../src/core/static-rules/rules/schema-alignment.ts');
    const findings = await schemaAlignmentRule.check(['/project/app/api/users/route.ts']);
    assert.deepEqual(findings, []);
  });

  it('returns structural findings when migration touched and column missing from type layer', async () => {
    const { schemaAlignmentRule } = await import('../src/core/static-rules/rules/schema-alignment.ts');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-rule-'));
    fs.mkdirSync(path.join(dir, 'data', 'deltas'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'types'));
    fs.writeFileSync(
      path.join(dir, 'data', 'deltas', '20260423_add_status.sql'),
      'ALTER TABLE users ADD COLUMN status text;',
    );
    // types dir exists but no 'status' reference
    fs.writeFileSync(path.join(dir, 'types', 'user.ts'), 'export interface User { id: string; }');

    const migFile = path.join(dir, 'data', 'deltas', '20260423_add_status.sql');
    const origCwd = process.cwd();
    process.chdir(dir);
    try {
      const findings = await schemaAlignmentRule.check([migFile]);
      assert.ok(findings.length > 0, 'expected at least one finding');
      assert.ok(findings.some(f => f.category === 'schema-alignment'));
    } finally {
      process.chdir(origCwd);
      fs.rmSync(dir, { recursive: true });
    }
  });

  it('returns [] when enabled:false in config', async () => {
    const { schemaAlignmentRule } = await import('../src/core/static-rules/rules/schema-alignment.ts');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-rule-'));
    fs.mkdirSync(path.join(dir, 'data', 'deltas'), { recursive: true });
    const migFile = path.join(dir, 'data', 'deltas', '20260423_add_status.sql');
    fs.writeFileSync(migFile, 'ALTER TABLE users ADD COLUMN status text;');
    const findings = await schemaAlignmentRule.check([migFile], { 'schema-alignment': { enabled: false } });
    assert.deepEqual(findings, []);
    fs.rmSync(dir, { recursive: true });
  });

  it('is registered in the rule registry', async () => {
    const { listAvailableRules } = await import('../src/core/static-rules/registry.ts');
    assert.ok(listAvailableRules().includes('schema-alignment'), 'schema-alignment not in registry');
  });

  it('falls back to structural findings when LLM returns empty', async () => {
    const { schemaAlignmentRule } = await import('../src/core/static-rules/rules/schema-alignment.ts');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-rule-'));
    fs.mkdirSync(path.join(dir, 'data', 'deltas'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'types'));
    fs.writeFileSync(
      path.join(dir, 'data', 'deltas', '20260423_add_status.sql'),
      'ALTER TABLE users ADD COLUMN status text;',
    );
    fs.writeFileSync(path.join(dir, 'types', 'user.ts'), 'export interface User { id: string; }');

    const migFile = path.join(dir, 'data', 'deltas', '20260423_add_status.sql');
    const origCwd = process.cwd();
    process.chdir(dir);
    try {
      // Engine that returns non-JSON prose — llmFindings becomes []
      const mockEngine = {
        label: 'mock',
        review: async () => ({ findings: [], rawOutput: 'some prose, not JSON' }),
        estimateTokens: (s: string) => s.length,
      };
      const findings = await schemaAlignmentRule.check([migFile], { _engine: mockEngine });
      assert.ok(findings.length > 0, 'expected structural fallback when LLM output was unparseable');
    } finally {
      process.chdir(origCwd);
      fs.rmSync(dir, { recursive: true });
    }
  });
});
