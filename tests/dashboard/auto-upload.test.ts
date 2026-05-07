import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { makeMockServer } from './_helpers/mock-server.ts';

const KEY = `clp_${'a'.repeat(64)}`;
const RUN_ID = 'run-auto-1';

let tmpHome: string;
let cfgMod: typeof import('../../src/dashboard/config.ts');
let autoMod: typeof import('../../src/dashboard/auto-upload.ts');
let runDir: string;

before(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'ap-auto-'));
  process.env.CLAUDE_AUTOPILOT_HOME = tmpHome;
  process.env.CLAUDE_AUTOPILOT_UPLOAD_RETRY_MS = '5,5,5,5';
  cfgMod = await import('../../src/dashboard/config.ts');
  autoMod = await import('../../src/dashboard/auto-upload.ts');

  runDir = path.join(tmpHome, 'runs', RUN_ID);
  await fs.mkdir(runDir, { recursive: true });
  await fs.writeFile(path.join(runDir, 'events.ndjson'), 'x'.repeat(500) + '\n');
  await fs.writeFile(path.join(runDir, 'state.json'), JSON.stringify({ runId: RUN_ID }));
});

after(async () => {
  delete process.env.CLAUDE_AUTOPILOT_HOME;
  delete process.env.CLAUDE_AUTOPILOT_UPLOAD;
  delete process.env.CLAUDE_AUTOPILOT_UPLOAD_RETRY_MS;
  await fs.rm(tmpHome, { recursive: true, force: true });
});

beforeEach(async () => {
  await cfgMod.deleteConfig();
  delete process.env.CLAUDE_AUTOPILOT_UPLOAD;
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

describe('autoUploadAtComplete', () => {
  it('uploads when logged in + events present', async () => {
    await seedConfig();
    const mock = makeMockServer({ apiKeys: { [KEY]: { userId: 'user1', runs: [RUN_ID] } } });
    process.env.AUTOPILOT_DASHBOARD_BASE_URL = 'http://test.invalid';
    const r = await autoMod.autoUploadAtComplete(RUN_ID, runDir, {
      fetchImpl: mock.fetch,
      silent: true,
    });
    assert.strictEqual(r.attempted, true);
    assert.strictEqual(r.ok, true);
    assert.match(r.url ?? '', /\/runs\//);
  });

  it('skips silently when not logged in', async () => {
    const r = await autoMod.autoUploadAtComplete(RUN_ID, runDir, { silent: true });
    assert.strictEqual(r.attempted, false);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.reason, 'not-logged-in');
  });

  it('skips when CLAUDE_AUTOPILOT_UPLOAD=off', async () => {
    await seedConfig();
    process.env.CLAUDE_AUTOPILOT_UPLOAD = 'off';
    const r = await autoMod.autoUploadAtComplete(RUN_ID, runDir, { silent: true });
    assert.strictEqual(r.attempted, false);
    assert.strictEqual(r.reason, 'env-off');
  });

  it('skips when --no-upload flag (disabled=true)', async () => {
    await seedConfig();
    const r = await autoMod.autoUploadAtComplete(RUN_ID, runDir, {
      disabled: true,
      silent: true,
    });
    assert.strictEqual(r.attempted, false);
    assert.strictEqual(r.reason, 'opt-out-flag');
  });

  it('skips cleanly when events.ndjson is missing', async () => {
    await seedConfig();
    const otherRun = path.join(tmpHome, 'runs', 'no-events-run');
    await fs.mkdir(otherRun, { recursive: true });
    const r = await autoMod.autoUploadAtComplete('no-events-run', otherRun, { silent: true });
    assert.strictEqual(r.attempted, false);
    assert.strictEqual(r.reason, 'no-events');
  });

  it('returns ok:false (never throws) when upload fails', async () => {
    await seedConfig();
    const fetchImpl: typeof fetch = async () => new Response('boom', { status: 500 });
    const r = await autoMod.autoUploadAtComplete(RUN_ID, runDir, {
      fetchImpl,
      silent: true,
    });
    assert.strictEqual(r.attempted, true);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'error');
  });
});

describe('shouldAutoUpload', () => {
  it('returns ok:true by default', () => {
    const r = autoMod.shouldAutoUpload({});
    assert.strictEqual(r.ok, true);
  });
  it('returns ok:false on disabled flag', () => {
    const r = autoMod.shouldAutoUpload({ disabled: true });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'opt-out-flag');
  });
  it('returns ok:false when env=off variants', () => {
    process.env.CLAUDE_AUTOPILOT_UPLOAD = 'off';
    assert.strictEqual(autoMod.shouldAutoUpload({}).ok, false);
    process.env.CLAUDE_AUTOPILOT_UPLOAD = 'NO';
    assert.strictEqual(autoMod.shouldAutoUpload({}).ok, false);
    process.env.CLAUDE_AUTOPILOT_UPLOAD = '0';
    assert.strictEqual(autoMod.shouldAutoUpload({}).ok, false);
    delete process.env.CLAUDE_AUTOPILOT_UPLOAD;
  });
});
