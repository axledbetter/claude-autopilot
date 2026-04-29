import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { appendAuditEvent, verifyChain, readEvents, type AuditEvent } from '../../src/core/migrate/audit-log.ts';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'audit-'));
}

function makeEvent(overrides: Partial<AuditEvent> = {}): Omit<AuditEvent, 'seq' | 'prev_hash' | 'ts'> {
  return {
    invocationId: 'inv-1',
    event: 'dispatch',
    requested_skill: 'migrate@1',
    resolved_skill: 'migrate@1',
    skill_path: 'skills/migrate/',
    envelope_contract_version: '1.0',
    skill_runtime_api_version: '1.0',
    envelope_hash: 'sha256:abc',
    policy_decisions: [],
    mode: 'apply',
    actor: 'tester@example',
    ci_provider: null,
    ci_run_id: null,
    result_status: 'applied',
    duration_ms: 100,
    ...overrides,
  };
}

describe('appendAuditEvent', () => {
  it('writes a single JSONL line with seq=1 and prev_hash=null', async () => {
    const dir = tmpDir();
    const logPath = path.join(dir, 'audit.log');
    await appendAuditEvent(logPath, makeEvent());
    const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    const e = JSON.parse(lines[0]!) as AuditEvent;
    assert.equal(e.seq, 1);
    assert.equal(e.prev_hash, null);
    assert.equal(e.invocationId, 'inv-1');
    assert.ok(typeof e.ts === 'string' && e.ts.length > 0);
    fs.rmSync(dir, { recursive: true });
  });

  it('seq increments monotonically across multiple appends', async () => {
    const dir = tmpDir();
    const logPath = path.join(dir, 'audit.log');
    await appendAuditEvent(logPath, makeEvent({ invocationId: 'inv-1' }));
    await appendAuditEvent(logPath, makeEvent({ invocationId: 'inv-2' }));
    await appendAuditEvent(logPath, makeEvent({ invocationId: 'inv-3' }));
    const events = readEvents(logPath);
    assert.deepEqual(events.map(e => e.seq), [1, 2, 3]);
    fs.rmSync(dir, { recursive: true });
  });

  it('prev_hash chains to SHA-256 of previous line', async () => {
    const dir = tmpDir();
    const logPath = path.join(dir, 'audit.log');
    await appendAuditEvent(logPath, makeEvent({ invocationId: 'inv-1' }));
    await appendAuditEvent(logPath, makeEvent({ invocationId: 'inv-2' }));
    const events = readEvents(logPath);
    assert.equal(events[0]!.prev_hash, null);
    assert.match(events[1]!.prev_hash!, /^sha256:[0-9a-f]{64}$/);
    fs.rmSync(dir, { recursive: true });
  });

  it('creates parent directory if it does not exist', async () => {
    const dir = tmpDir();
    const logPath = path.join(dir, 'nested', 'deep', 'audit.log');
    await appendAuditEvent(logPath, makeEvent());
    assert.ok(fs.existsSync(logPath));
    fs.rmSync(dir, { recursive: true });
  });
});

describe('verifyChain', () => {
  it('passes for a clean log with valid chain', async () => {
    const dir = tmpDir();
    const logPath = path.join(dir, 'audit.log');
    await appendAuditEvent(logPath, makeEvent({ invocationId: 'a' }));
    await appendAuditEvent(logPath, makeEvent({ invocationId: 'b' }));
    await appendAuditEvent(logPath, makeEvent({ invocationId: 'c' }));
    const r = verifyChain(logPath);
    assert.equal(r.valid, true);
    assert.equal(r.breakAtLine, undefined);
    fs.rmSync(dir, { recursive: true });
  });

  it('detects tampered line and reports the break', async () => {
    const dir = tmpDir();
    const logPath = path.join(dir, 'audit.log');
    await appendAuditEvent(logPath, makeEvent({ invocationId: 'a' }));
    await appendAuditEvent(logPath, makeEvent({ invocationId: 'b' }));
    await appendAuditEvent(logPath, makeEvent({ invocationId: 'c' }));
    // Tamper with the second line AFTER all 3 are written. Line 3's prev_hash
    // was computed from the un-tampered line 2 — recomputing sha256 over the
    // tampered line 2 will not match what line 3 has stored.
    const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n');
    const tampered = JSON.parse(lines[1]!);
    tampered.actor = 'evil';
    lines[1] = JSON.stringify(tampered);
    fs.writeFileSync(logPath, lines.join('\n') + '\n');
    const r = verifyChain(logPath);
    // Tampering the middle line breaks the chain at line 3 (whose prev_hash
    // expects the un-tampered line 2's hash)
    assert.equal(r.valid, false);
    assert.ok(r.breakAtLine !== undefined && r.breakAtLine >= 2);
    fs.rmSync(dir, { recursive: true });
  });

  it('detects out-of-order seq', async () => {
    const dir = tmpDir();
    const logPath = path.join(dir, 'audit.log');
    await appendAuditEvent(logPath, makeEvent({ invocationId: 'a' }));
    // Manually write a line with seq=99 instead of 2
    const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n');
    const second = makeEvent({ invocationId: 'b' });
    const obj = { ...second, seq: 99, prev_hash: null, ts: new Date().toISOString() };
    fs.appendFileSync(logPath, JSON.stringify(obj) + '\n');
    const r = verifyChain(logPath);
    assert.equal(r.valid, false);
    fs.rmSync(dir, { recursive: true });
  });
});

describe('appendAuditEvent — concurrent writers (advisory lock)', () => {
  it('serializes 10 concurrent writers with no corruption and no duplicate seq', async () => {
    const dir = tmpDir();
    const logPath = path.join(dir, 'audit.log');
    const writers = [];
    for (let i = 0; i < 10; i++) {
      writers.push(appendAuditEvent(logPath, makeEvent({ invocationId: `inv-${i}` })));
    }
    await Promise.all(writers);
    const events = readEvents(logPath);
    assert.equal(events.length, 10);
    const seqs = events.map(e => e.seq).sort((a, b) => a - b);
    assert.deepEqual(seqs, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const r = verifyChain(logPath);
    assert.equal(r.valid, true);
    fs.rmSync(dir, { recursive: true });
  });
});
