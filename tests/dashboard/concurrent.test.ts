import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { uploadRun } from '../../src/dashboard/upload/uploader.ts';
import { makeMockServer } from './_helpers/mock-server.ts';

process.env.CLAUDE_AUTOPILOT_UPLOAD_RETRY_MS = '5,5,5,5';

const KEY = `clp_${'a'.repeat(64)}`;

let tmp: string;

before(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ap-conc-'));
});

after(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

async function makeRun(runId: string, bytes: number): Promise<string> {
  const dir = path.join(tmp, runId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'events.ndjson'), 'x'.repeat(bytes - 1) + '\n');
  await fs.writeFile(path.join(dir, 'state.json'), JSON.stringify({ runId }));
  return dir;
}

describe('concurrent uploads', () => {
  it('two distinct runIds upload independently in parallel', async () => {
    const runA = 'run-A';
    const runB = 'run-B';
    const dirA = await makeRun(runA, 1000);
    const dirB = await makeRun(runB, Math.floor(1.5 * 1024 * 1024));
    const mock = makeMockServer({
      apiKeys: { [KEY]: { userId: 'user1', runs: [runA, runB] } },
    });
    const [resA, resB] = await Promise.all([
      uploadRun(runA, dirA, { apiKey: KEY, baseUrl: 'http://test.invalid', fetchImpl: mock.fetch }),
      uploadRun(runB, dirB, { apiKey: KEY, baseUrl: 'http://test.invalid', fetchImpl: mock.fetch }),
    ]);
    assert.strictEqual(resA.ok, true, `A error: ${resA.error}`);
    assert.strictEqual(resB.ok, true, `B error: ${resB.error}`);
    assert.strictEqual(mock.state.finalized.size, 2);
    assert.ok(mock.state.finalized.has(runA));
    assert.ok(mock.state.finalized.has(runB));
  });
});
