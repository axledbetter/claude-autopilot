import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { makeMockServer } from './_helpers/mock-server.ts';

const KEY = `clp_${'a'.repeat(64)}`;
const RUN_ID = 'run-cli-1';

let tmpHome: string;
let cfgMod: typeof import('../../src/dashboard/config.ts');
let uploadCliMod: typeof import('../../src/cli/dashboard/upload.ts');
let runDir: string;

before(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'ap-cli-up-'));
  process.env.CLAUDE_AUTOPILOT_HOME = tmpHome;
  cfgMod = await import('../../src/dashboard/config.ts');
  uploadCliMod = await import('../../src/cli/dashboard/upload.ts');

  runDir = path.join(tmpHome, 'runs', RUN_ID);
  await fs.mkdir(runDir, { recursive: true });
  await fs.writeFile(path.join(runDir, 'events.ndjson'), 'x'.repeat(500) + '\n');
  await fs.writeFile(path.join(runDir, 'state.json'), JSON.stringify({ runId: RUN_ID }));
});

after(async () => {
  delete process.env.CLAUDE_AUTOPILOT_HOME;
  await fs.rm(tmpHome, { recursive: true, force: true });
});

beforeEach(async () => {
  await cfgMod.deleteConfig();
});

async function seedConfig(): Promise<void> {
  await cfgMod.writeConfig({
    schemaVersion: 1,
    apiKey: KEY,
    fingerprint: `clp_${'a'.repeat(12)}`,
    accountEmail: 'a@b.com',
    loggedInAt: new Date().toISOString(),
    lastUploadAt: null,
  });
}

describe('runDashboardUpload', () => {
  it('uploads a known run when logged in', async () => {
    await seedConfig();
    const mock = makeMockServer({ apiKeys: { [KEY]: { userId: 'user1', runs: [RUN_ID] } } });
    const r = await uploadCliMod.runDashboardUpload({
      runId: RUN_ID,
      baseUrl: 'http://test.invalid',
      fetchImpl: mock.fetch,
      silent: true,
    });
    assert.strictEqual(r.ok, true, `error: ${r.error}`);
    assert.strictEqual(mock.state.finalized.size, 1);
  });

  it('refuses to upload when not logged in', async () => {
    const r = await uploadCliMod.runDashboardUpload({
      runId: RUN_ID,
      baseUrl: 'http://test.invalid',
      silent: true,
    });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.notLoggedIn, true);
  });

  it('reports run-dir-missing for unknown runId', async () => {
    await seedConfig();
    const r = await uploadCliMod.runDashboardUpload({
      runId: 'no-such-run',
      baseUrl: 'http://test.invalid',
      silent: true,
    });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.runDirMissing, true);
  });
});
