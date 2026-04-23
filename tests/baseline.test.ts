import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

function tmp(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'ap-baseline-')); }

function makeFindings(overrides: Partial<{id: string; file: string; line: number}>[] = []) {
  return overrides.map((o, i) => ({
    id: o.id ?? `rule:${i}`,
    source: 'static-rules' as const,
    severity: 'critical' as const,
    category: 'test',
    file: o.file ?? 'src/index.ts',
    line: o.line ?? i + 1,
    message: 'test finding',
    suggestion: '',
    protectedPath: false,
    createdAt: new Date().toISOString(),
  }));
}

describe('baseline persistence', () => {
  it('returns null when no baseline file exists', async () => {
    const { loadBaseline } = await import('../src/core/persist/baseline.ts');
    const dir = tmp();
    assert.equal(loadBaseline(dir), null);
    fs.rmSync(dir, { recursive: true });
  });

  it('saves and reloads a baseline', async () => {
    const { saveBaseline, loadBaseline } = await import('../src/core/persist/baseline.ts');
    const dir = tmp();
    const findings = makeFindings([{ id: 'r1', file: 'src/a.ts', line: 5 }]);
    saveBaseline(dir, findings);
    const loaded = loadBaseline(dir);
    assert.ok(loaded !== null);
    assert.equal(loaded!.entries.length, 1);
    assert.equal(loaded!.entries[0]!.id, 'r1');
    assert.equal(loaded!.entries[0]!.file, 'src/a.ts');
    assert.equal(loaded!.entries[0]!.line, 5);
    fs.rmSync(dir, { recursive: true });
  });

  it('preserves createdAt on update', async () => {
    const { saveBaseline, loadBaseline } = await import('../src/core/persist/baseline.ts');
    const dir = tmp();
    const f1 = makeFindings([{ id: 'r1' }]);
    const first = saveBaseline(dir, f1);
    const createdAt = first.createdAt;

    await new Promise(r => setTimeout(r, 10));
    const f2 = makeFindings([{ id: 'r2' }]);
    const second = saveBaseline(dir, f2);
    assert.equal(second.createdAt, createdAt, 'createdAt should not change on update');
    assert.notEqual(second.updatedAt, createdAt, 'updatedAt should change');
    fs.rmSync(dir, { recursive: true });
  });

  it('saves with a note', async () => {
    const { saveBaseline, loadBaseline } = await import('../src/core/persist/baseline.ts');
    const dir = tmp();
    saveBaseline(dir, [], { note: 'initial baseline' });
    const loaded = loadBaseline(dir);
    assert.equal(loaded!.note, 'initial baseline');
    fs.rmSync(dir, { recursive: true });
  });

  it('clears the baseline file', async () => {
    const { saveBaseline, clearBaseline, loadBaseline } = await import('../src/core/persist/baseline.ts');
    const dir = tmp();
    saveBaseline(dir, makeFindings([{ id: 'r1' }]));
    clearBaseline(dir);
    assert.equal(loadBaseline(dir), null);
    fs.rmSync(dir, { recursive: true });
  });

  it('clearBaseline is idempotent when no file exists', async () => {
    const { clearBaseline } = await import('../src/core/persist/baseline.ts');
    const dir = tmp();
    assert.doesNotThrow(() => clearBaseline(dir));
    fs.rmSync(dir, { recursive: true });
  });

  it('saves to override path', async () => {
    const { saveBaseline, loadBaseline } = await import('../src/core/persist/baseline.ts');
    const dir = tmp();
    const customPath = path.join(dir, 'custom-baseline.json');
    saveBaseline(dir, makeFindings([{ id: 'r1' }]), { overridePath: customPath });
    assert.ok(fs.existsSync(customPath), 'custom path should exist');
    const loaded = loadBaseline(dir, customPath);
    assert.ok(loaded !== null);
    fs.rmSync(dir, { recursive: true });
  });
});

describe('filterBaselined', () => {
  it('separates new from baselined findings', async () => {
    const { saveBaseline, filterBaselined } = await import('../src/core/persist/baseline.ts');
    const dir = tmp();
    const existing = makeFindings([{ id: 'rule:file:1', file: 'src/a.ts', line: 1 }]);
    const baseline = saveBaseline(dir, existing);
    const current = [
      ...existing,
      ...makeFindings([{ id: 'rule:file:2', file: 'src/a.ts', line: 2 }]),
    ];
    const result = filterBaselined(current, baseline);
    assert.equal(result.baselinedFindings.length, 1);
    assert.equal(result.newFindings.length, 1);
    assert.equal(result.baselinedCount, 1);
    assert.equal(result.newFindings[0]!.id, 'rule:file:2');
    fs.rmSync(dir, { recursive: true });
  });

  it('returns all findings as new when baseline is empty', async () => {
    const { saveBaseline, filterBaselined } = await import('../src/core/persist/baseline.ts');
    const dir = tmp();
    const baseline = saveBaseline(dir, []);
    const current = makeFindings([{ id: 'r1' }, { id: 'r2' }]);
    const result = filterBaselined(current, baseline);
    assert.equal(result.newFindings.length, 2);
    assert.equal(result.baselinedCount, 0);
    fs.rmSync(dir, { recursive: true });
  });

  it('returns all as baselined when current matches baseline exactly', async () => {
    const { saveBaseline, filterBaselined } = await import('../src/core/persist/baseline.ts');
    const dir = tmp();
    const findings = makeFindings([{ id: 'r1', file: 'src/a.ts', line: 5 }]);
    const baseline = saveBaseline(dir, findings);
    const result = filterBaselined(findings, baseline);
    assert.equal(result.baselinedCount, 1);
    assert.equal(result.newFindings.length, 0);
    fs.rmSync(dir, { recursive: true });
  });

  it('matching uses id + file + line key', async () => {
    const { saveBaseline, filterBaselined } = await import('../src/core/persist/baseline.ts');
    const dir = tmp();
    // Same id, same file, different line — should NOT match
    const baseFindings = makeFindings([{ id: 'r1', file: 'src/a.ts', line: 5 }]);
    const baseline = saveBaseline(dir, baseFindings);
    const current = makeFindings([{ id: 'r1', file: 'src/a.ts', line: 10 }]);
    const result = filterBaselined(current, baseline);
    assert.equal(result.newFindings.length, 1, 'different line = new finding');
    assert.equal(result.baselinedCount, 0);
    fs.rmSync(dir, { recursive: true });
  });
});

describe('diffAgainstBaseline', () => {
  it('identifies added, resolved, unchanged findings', async () => {
    const { saveBaseline, diffAgainstBaseline } = await import('../src/core/persist/baseline.ts');
    const dir = tmp();
    const old = makeFindings([
      { id: 'r1', file: 'src/a.ts', line: 1 },
      { id: 'r2', file: 'src/b.ts', line: 2 },
    ]);
    const baseline = saveBaseline(dir, old);
    const current = [
      old[0]!, // r1 still present
      ...makeFindings([{ id: 'r3', file: 'src/c.ts', line: 3 }]), // new
    ];
    const diff = diffAgainstBaseline(current, baseline);
    assert.equal(diff.added.length, 1, 'one new finding');
    assert.equal(diff.added[0]!.id, 'r3');
    assert.equal(diff.resolved.length, 1, 'one resolved finding');
    assert.equal(diff.resolved[0]!.id, 'r2');
    assert.equal(diff.unchanged.length, 1, 'one unchanged');
    assert.equal(diff.unchanged[0]!.id, 'r1');
    fs.rmSync(dir, { recursive: true });
  });

  it('all added when baseline is empty', async () => {
    const { saveBaseline, diffAgainstBaseline } = await import('../src/core/persist/baseline.ts');
    const dir = tmp();
    const baseline = saveBaseline(dir, []);
    const current = makeFindings([{ id: 'r1' }, { id: 'r2' }]);
    const diff = diffAgainstBaseline(current, baseline);
    assert.equal(diff.added.length, 2);
    assert.equal(diff.resolved.length, 0);
    assert.equal(diff.unchanged.length, 0);
    fs.rmSync(dir, { recursive: true });
  });

  it('all resolved when current is empty', async () => {
    const { saveBaseline, diffAgainstBaseline } = await import('../src/core/persist/baseline.ts');
    const dir = tmp();
    const findings = makeFindings([{ id: 'r1' }, { id: 'r2' }]);
    const baseline = saveBaseline(dir, findings);
    const diff = diffAgainstBaseline([], baseline);
    assert.equal(diff.added.length, 0);
    assert.equal(diff.resolved.length, 2);
    assert.equal(diff.unchanged.length, 0);
    fs.rmSync(dir, { recursive: true });
  });
});
