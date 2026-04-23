// tests/schema-alignment-integration.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';

const FIXTURES = path.join(import.meta.dirname, 'fixtures', 'schema-alignment');

describe('schema-alignment integration', () => {
  it('supabase-add-col: emits findings for missing type layer', async () => {
    const { schemaAlignmentRule } = await import('../src/core/static-rules/rules/schema-alignment.ts');
    const fixtureDir = path.join(FIXTURES, 'supabase-add-col');
    const migFile = path.join(fixtureDir, 'data', 'deltas', '20260423_add_status.sql');

    const origCwd = process.cwd();
    process.chdir(fixtureDir);
    try {
      const findings = await schemaAlignmentRule.check([migFile]);
      assert.ok(findings.length > 0, 'expected at least one finding');
      const typeFindings = findings.filter(f => f.message.includes('type'));
      assert.ok(typeFindings.length > 0, `expected type-layer finding, got: ${findings.map(f => f.message).join(', ')}`);
    } finally {
      process.chdir(origCwd);
    }
  });

  it('prisma-rename-col: emits error finding for stale type reference', async () => {
    const { schemaAlignmentRule } = await import('../src/core/static-rules/rules/schema-alignment.ts');
    const fixtureDir = path.join(FIXTURES, 'prisma-rename-col');
    const migFile = path.join(fixtureDir, 'prisma', 'migrations', '20260423_rename.sql');

    const origCwd = process.cwd();
    process.chdir(fixtureDir);
    try {
      const findings = await schemaAlignmentRule.check([migFile]);
      assert.ok(findings.length > 0, 'expected at least one finding for stale ref');
      assert.ok(
        findings.some(f => f.severity === 'critical'),
        `expected critical finding for rename, got: ${findings.map(f => f.severity + ':' + f.message).join('; ')}`,
      );
    } finally {
      process.chdir(origCwd);
    }
  });

  it('clean: returns [] when all layers reference the new column', async () => {
    const { schemaAlignmentRule } = await import('../src/core/static-rules/rules/schema-alignment.ts');
    const fixtureDir = path.join(FIXTURES, 'clean');
    const migFile = path.join(fixtureDir, 'data', 'deltas', '20260423_add_status.sql');

    const origCwd = process.cwd();
    process.chdir(fixtureDir);
    try {
      const findings = await schemaAlignmentRule.check([migFile]);
      assert.deepEqual(findings, [], `expected no findings, got: ${findings.map(f => f.message).join(', ')}`);
    } finally {
      process.chdir(origCwd);
    }
  });
});
