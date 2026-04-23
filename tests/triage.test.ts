import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

function tmp(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'ap-triage-')); }

function makeF(id: string, file = 'src/a.ts', line = 1) {
  return {
    id,
    source: 'static-rules' as const,
    severity: 'critical' as const,
    category: 'test',
    file,
    line,
    message: `test: ${id}`,
    suggestion: '',
    protectedPath: false,
    createdAt: new Date().toISOString(),
  };
}

describe('triage persistence', () => {
  it('loads empty store when no file', async () => {
    const { loadTriage } = await import('../src/core/persist/triage.ts');
    const dir = tmp();
    const store = loadTriage(dir);
    assert.equal(store.entries.length, 0);
    fs.rmSync(dir, { recursive: true });
  });

  it('adds and persists a triage entry', async () => {
    const { addTriageEntry, loadTriage } = await import('../src/core/persist/triage.ts');
    const dir = tmp();
    addTriageEntry(dir, makeF('r1', 'src/a.ts', 5), 'false-positive');
    const store = loadTriage(dir);
    assert.equal(store.entries.length, 1);
    assert.equal(store.entries[0]!.state, 'false-positive');
    assert.equal(store.entries[0]!.id, 'r1');
    fs.rmSync(dir, { recursive: true });
  });

  it('replaces existing entry on re-triage', async () => {
    const { addTriageEntry, loadTriage } = await import('../src/core/persist/triage.ts');
    const dir = tmp();
    addTriageEntry(dir, makeF('r1'), 'false-positive');
    addTriageEntry(dir, makeF('r1'), 'accepted-risk', { reason: 'updated' });
    const store = loadTriage(dir);
    assert.equal(store.entries.length, 1);
    assert.equal(store.entries[0]!.state, 'accepted-risk');
    assert.equal(store.entries[0]!.reason, 'updated');
    fs.rmSync(dir, { recursive: true });
  });

  it('saves expiry date when expiresInDays set', async () => {
    const { addTriageEntry, loadTriage } = await import('../src/core/persist/triage.ts');
    const dir = tmp();
    addTriageEntry(dir, makeF('r1'), 'accepted-risk', { expiresInDays: 30 });
    const store = loadTriage(dir);
    assert.ok(store.entries[0]!.expiresAt, 'should have expiresAt');
    const exp = new Date(store.entries[0]!.expiresAt!);
    const now = new Date();
    assert.ok(exp > now, 'expiry should be in the future');
    fs.rmSync(dir, { recursive: true });
  });

  it('removes entry by id', async () => {
    const { addTriageEntry, removeTriageEntry, loadTriage } = await import('../src/core/persist/triage.ts');
    const dir = tmp();
    addTriageEntry(dir, makeF('r1'), 'false-positive');
    addTriageEntry(dir, makeF('r2'), 'accepted-risk');
    removeTriageEntry(dir, ['r1']);
    const store = loadTriage(dir);
    assert.equal(store.entries.length, 1);
    assert.equal(store.entries[0]!.id, 'r2');
    fs.rmSync(dir, { recursive: true });
  });

  it('clears expired entries', async () => {
    const { saveTriage, clearExpiredEntries, loadTriage } = await import('../src/core/persist/triage.ts');
    const dir = tmp();
    const past = new Date(Date.now() - 1000).toISOString();
    const future = new Date(Date.now() + 86400000).toISOString();
    saveTriage(dir, {
      version: 1,
      entries: [
        { id: 'r1', file: 'a.ts', state: 'accepted-risk', triagedAt: past, expiresAt: past },
        { id: 'r2', file: 'b.ts', state: 'false-positive', triagedAt: past, expiresAt: future },
        { id: 'r3', file: 'c.ts', state: 'accepted-risk', triagedAt: past },
      ],
    });
    const removed = clearExpiredEntries(dir);
    assert.equal(removed, 1);
    const store = loadTriage(dir);
    assert.equal(store.entries.length, 2);
    assert.ok(store.entries.every(e => e.id !== 'r1'));
    fs.rmSync(dir, { recursive: true });
  });
});

describe('filterTriaged', () => {
  it('filters active triaged findings from results', async () => {
    const { addTriageEntry, loadTriage, filterTriaged } = await import('../src/core/persist/triage.ts');
    const dir = tmp();
    const f1 = makeF('r1', 'src/a.ts', 1);
    const f2 = makeF('r2', 'src/b.ts', 2);
    addTriageEntry(dir, f1, 'false-positive');
    const store = loadTriage(dir);
    const result = filterTriaged([f1, f2], store);
    assert.equal(result.active.length, 1);
    assert.equal(result.active[0]!.id, 'r2');
    assert.equal(result.triageCount, 1);
    fs.rmSync(dir, { recursive: true });
  });

  it('does not filter expired entries', async () => {
    const { saveTriage, loadTriage, filterTriaged } = await import('../src/core/persist/triage.ts');
    const dir = tmp();
    const past = new Date(Date.now() - 1000).toISOString();
    saveTriage(dir, {
      version: 1,
      entries: [{ id: 'r1', file: 'src/a.ts', line: 1, state: 'accepted-risk', triagedAt: past, expiresAt: past }],
    });
    const f1 = makeF('r1', 'src/a.ts', 1);
    const store = loadTriage(dir);
    const result = filterTriaged([f1], store);
    assert.equal(result.active.length, 1, 'expired entry should not suppress finding');
    assert.equal(result.triageCount, 0);
    fs.rmSync(dir, { recursive: true });
  });

  it('passes all findings when store is empty', async () => {
    const { filterTriaged } = await import('../src/core/persist/triage.ts');
    const store = { version: 1 as const, entries: [] };
    const findings = [makeF('r1'), makeF('r2')];
    const result = filterTriaged(findings, store);
    assert.equal(result.active.length, 2);
    assert.equal(result.triageCount, 0);
  });
});
