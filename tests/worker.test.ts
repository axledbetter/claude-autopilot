import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readLock, writeLock, deleteLock, isWorkerAlive, lockfilePath } from '../src/core/worker/lockfile.ts';
import { startWorkerServer } from '../src/core/worker/server.ts';
import { dispatchToWorker, getWorkerStatus, stopWorker } from '../src/core/worker/client.ts';

function tmp(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'gw-')); }

describe('lockfile', () => {
  it('returns null when no lockfile exists', () => {
    const dir = tmp();
    assert.equal(readLock(dir), null);
    fs.rmSync(dir, { recursive: true });
  });

  it('round-trips write and read', () => {
    const dir = tmp();
    writeLock(dir, { pid: 12345, port: 9999, startedAt: '2026-01-01T00:00:00.000Z' });
    const lock = readLock(dir);
    assert.equal(lock?.pid, 12345);
    assert.equal(lock?.port, 9999);
    fs.rmSync(dir, { recursive: true });
  });

  it('deleteLock removes the file', () => {
    const dir = tmp();
    writeLock(dir, { pid: 1, port: 1, startedAt: '' });
    deleteLock(dir);
    assert.equal(fs.existsSync(lockfilePath(dir)), false);
    fs.rmSync(dir, { recursive: true });
  });

  it('isWorkerAlive returns true for current process', () => {
    assert.equal(isWorkerAlive({ pid: process.pid, port: 0, startedAt: '' }), true);
  });

  it('isWorkerAlive returns false for dead pid', () => {
    assert.equal(isWorkerAlive({ pid: 999999999, port: 0, startedAt: '' }), false);
  });
});

describe('worker server', () => {
  it('starts, responds to status, and closes', async () => {
    const dir = tmp();
    const server = await startWorkerServer({
      cwd: dir,
      onReview: async () => ({ findings: [] }),
    });
    assert.ok(server.port > 0);

    const lock = { pid: process.pid, port: server.port, startedAt: '' };
    const status = await getWorkerStatus(lock);
    assert.equal(status.port, server.port);
    assert.equal(status.jobsProcessed, 0);

    await server.close();
    fs.rmSync(dir, { recursive: true });
  });

  it('POST /review returns findings from onReview handler', async () => {
    const dir = tmp();
    const mockFinding = {
      id: 'test:1', source: 'static-rules' as const, severity: 'warning' as const,
      category: 'test', file: 'a.ts', line: 1, message: 'test',
      suggestion: '', protectedPath: false, createdAt: new Date().toISOString(),
    };
    const server = await startWorkerServer({
      cwd: dir,
      onReview: async () => ({ findings: [mockFinding] }),
    });

    const lock = { pid: process.pid, port: server.port, startedAt: '' };
    const result = await dispatchToWorker(lock, { files: ['a.ts'], config: { configVersion: 1 } });
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0]!.id, 'test:1');

    await server.close();
    fs.rmSync(dir, { recursive: true });
  });

  it('POST /stop shuts down server', async () => {
    const dir = tmp();
    const server = await startWorkerServer({
      cwd: dir,
      onReview: async () => ({ findings: [] }),
    });
    const lock = { pid: process.pid, port: server.port, startedAt: '' };
    await stopWorker(lock);
    // Give server time to close
    await new Promise(r => setTimeout(r, 200));
    // Subsequent request should fail
    await assert.rejects(
      () => getWorkerStatus(lock),
      'should fail after stop',
    );
    fs.rmSync(dir, { recursive: true });
  });

  it('tracks jobsProcessed count', async () => {
    const dir = tmp();
    const server = await startWorkerServer({
      cwd: dir,
      onReview: async () => ({ findings: [] }),
    });
    const lock = { pid: process.pid, port: server.port, startedAt: '' };
    await dispatchToWorker(lock, { files: [], config: { configVersion: 1 } });
    await dispatchToWorker(lock, { files: [], config: { configVersion: 1 } });
    const status = await getWorkerStatus(lock);
    assert.equal(status.jobsProcessed, 2);
    await server.close();
    fs.rmSync(dir, { recursive: true });
  });
});
