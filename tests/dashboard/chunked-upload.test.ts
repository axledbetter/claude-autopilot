import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { uploadRun } from '../../src/dashboard/upload/uploader.ts';
import { makeMockServer } from './_helpers/mock-server.ts';

const KEY = `clp_${'a'.repeat(64)}`;

async function makeRun(opts: { eventsBytes: number; runId?: string }): Promise<{ runId: string; runDir: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ap-up-'));
  const runId = opts.runId ?? `run-${Math.random().toString(36).slice(2, 10)}`;
  // Each line is 1 KiB-ish JSON; we just need a known byte count.
  const contents = opts.eventsBytes === 0 ? '' : 'x'.repeat(opts.eventsBytes - 1) + '\n';
  await fs.writeFile(path.join(dir, 'events.ndjson'), contents);
  await fs.writeFile(path.join(dir, 'state.json'), JSON.stringify({ runId, status: 'success' }));
  return { runId, runDir: dir };
}

async function cleanup(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
}

describe('uploadRun', () => {
  let runs: string[] = [];

  beforeEach(() => { runs = []; });
  after(async () => { for (const d of runs) await cleanup(d); });

  it('skips upload cleanly when events.ndjson is empty', async () => {
    const { runId, runDir } = await makeRun({ eventsBytes: 0 });
    runs.push(runDir);
    const mock = makeMockServer({ apiKeys: { [KEY]: { userId: 'user1', runs: [runId] } } });
    const res = await uploadRun(runId, runDir, {
      apiKey: KEY,
      baseUrl: 'http://test.invalid',
      fetchImpl: mock.fetch,
    });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.skipped, true);
    assert.strictEqual(mock.state.finalized.size, 0);
  });

  it('uploads single chunk + finalize for sub-MiB events file', async () => {
    const { runId, runDir } = await makeRun({ eventsBytes: 1000 });
    runs.push(runDir);
    const mock = makeMockServer({ apiKeys: { [KEY]: { userId: 'user1', runs: [runId] } } });
    const res = await uploadRun(runId, runDir, {
      apiKey: KEY,
      baseUrl: 'http://test.invalid',
      fetchImpl: mock.fetch,
    });
    assert.strictEqual(res.ok, true, `error: ${res.error}`);
    assert.match(res.url ?? '', /\/runs\//);
    assert.strictEqual(mock.state.chunks.size, 1);
    assert.strictEqual(mock.state.finalized.size, 1);
  });

  it('chunks a multi-MiB events file into 1-MiB pieces', async () => {
    // 2.5 MiB → 3 chunks
    const { runId, runDir } = await makeRun({ eventsBytes: Math.floor(2.5 * 1024 * 1024) });
    runs.push(runDir);
    const mock = makeMockServer({ apiKeys: { [KEY]: { userId: 'user1', runs: [runId] } } });
    const res = await uploadRun(runId, runDir, {
      apiKey: KEY,
      baseUrl: 'http://test.invalid',
      fetchImpl: mock.fetch,
    });
    assert.strictEqual(res.ok, true, `error: ${res.error}`);
    assert.strictEqual(mock.state.chunks.size, 3);
  });

  it('retries 5xx with backoff and eventually succeeds', async () => {
    const { runId, runDir } = await makeRun({ eventsBytes: 1000 });
    runs.push(runDir);
    const mock = makeMockServer({
      apiKeys: { [KEY]: { userId: 'user1', runs: [runId] } },
      scenarios: { flakyChunkSeq: 0 },
    });
    // shrink retry delays for the test by stubbing setTimeout via fake timers.
    const res = await uploadRun(runId, runDir, {
      apiKey: KEY,
      baseUrl: 'http://test.invalid',
      fetchImpl: mock.fetch,
    });
    assert.strictEqual(res.ok, true, `error: ${res.error}`);
    assert.strictEqual(mock.state.finalized.size, 1);
  });

  it('treats 409 duplicate as success and continues', async () => {
    const { runId, runDir } = await makeRun({ eventsBytes: 1000 });
    runs.push(runDir);
    const mock = makeMockServer({
      apiKeys: { [KEY]: { userId: 'user1', runs: [runId] } },
      scenarios: { duplicateChunkSeq: 0 },
    });
    const res = await uploadRun(runId, runDir, {
      apiKey: KEY,
      baseUrl: 'http://test.invalid',
      fetchImpl: mock.fetch,
    });
    assert.strictEqual(res.ok, true, `error: ${res.error}`);
  });

  it('re-bootstraps once on 401 token-expired and retries the seq', async () => {
    const { runId, runDir } = await makeRun({ eventsBytes: Math.floor(2 * 1024 * 1024) });
    runs.push(runDir);
    const mock = makeMockServer({
      apiKeys: { [KEY]: { userId: 'user1', runs: [runId] } },
      scenarios: { expireTokenAfterSeq: 0 },
    });
    const res = await uploadRun(runId, runDir, {
      apiKey: KEY,
      baseUrl: 'http://test.invalid',
      fetchImpl: mock.fetch,
    });
    assert.strictEqual(res.ok, true, `error: ${res.error}`);
    assert.strictEqual(mock.state.finalized.size, 1);
  });

  it('aborts cleanly when AbortSignal fires', async () => {
    const { runId, runDir } = await makeRun({ eventsBytes: 1000 });
    runs.push(runDir);
    const ac = new AbortController();
    ac.abort();
    const mock = makeMockServer({ apiKeys: { [KEY]: { userId: 'user1', runs: [runId] } } });
    const res = await uploadRun(runId, runDir, {
      apiKey: KEY,
      baseUrl: 'http://test.invalid',
      fetchImpl: mock.fetch,
      signal: ac.signal,
    });
    assert.strictEqual(res.ok, false);
  });

  it('emits onProgress for snapshot, session, chunks, finalized', async () => {
    const { runId, runDir } = await makeRun({ eventsBytes: Math.floor(1.5 * 1024 * 1024) });
    runs.push(runDir);
    const events: string[] = [];
    const mock = makeMockServer({ apiKeys: { [KEY]: { userId: 'user1', runs: [runId] } } });
    const res = await uploadRun(runId, runDir, {
      apiKey: KEY,
      baseUrl: 'http://test.invalid',
      fetchImpl: mock.fetch,
      onProgress: (e) => events.push(e.kind),
    });
    assert.strictEqual(res.ok, true, `error: ${res.error}`);
    assert.ok(events.includes('snapshot'));
    assert.ok(events.includes('session'));
    assert.ok(events.includes('finalized'));
    assert.ok(events.filter((e) => e === 'chunk-uploaded').length === 2);
  });
});
