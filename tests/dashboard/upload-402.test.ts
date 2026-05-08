// Phase 3 — CLI uploader 402 handling tests.
//
// 30. uploader receives 402 → throws UploadLimitError with parsed payload.
// 31. autopilot/auto-upload catches UploadLimitError → prints friendly
//     message, no retry, returns reason='limit-reached'.
// 32. CLI run exit code is preserved when upload is 402'd.

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { makeMockServer } from './_helpers/mock-server.ts';

const KEY = `clp_${'b'.repeat(64)}`;
const RUN_ID = 'run-cap-1';

let tmpHome: string;
let cfgMod: typeof import('../../src/dashboard/config.ts');
let autoMod: typeof import('../../src/dashboard/auto-upload.ts');
let uploaderMod: typeof import('../../src/dashboard/upload/uploader.ts');
let runDir: string;

before(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'ap-cap-'));
  process.env.CLAUDE_AUTOPILOT_HOME = tmpHome;
  process.env.CLAUDE_AUTOPILOT_UPLOAD_RETRY_MS = '5,5,5,5';
  cfgMod = await import('../../src/dashboard/config.ts');
  autoMod = await import('../../src/dashboard/auto-upload.ts');
  uploaderMod = await import('../../src/dashboard/upload/uploader.ts');

  runDir = path.join(tmpHome, 'runs', RUN_ID);
  await fs.mkdir(runDir, { recursive: true });
  await fs.writeFile(path.join(runDir, 'events.ndjson'), 'x'.repeat(500) + '\n');
  await fs.writeFile(path.join(runDir, 'state.json'), JSON.stringify({ runId: RUN_ID }));
});

after(async () => {
  delete process.env.CLAUDE_AUTOPILOT_HOME;
  delete process.env.CLAUDE_AUTOPILOT_UPLOAD;
  delete process.env.CLAUDE_AUTOPILOT_UPLOAD_RETRY_MS;
  delete process.env.AUTOPILOT_DASHBOARD_BASE_URL;
  await fs.rm(tmpHome, { recursive: true, force: true });
});

beforeEach(async () => {
  await cfgMod.deleteConfig();
});

async function seedConfig(): Promise<void> {
  await cfgMod.writeConfig({
    schemaVersion: 1,
    apiKey: KEY,
    fingerprint: `clp_${'b'.repeat(12)}`,
    accountEmail: 'a@b.com',
    loggedInAt: new Date().toISOString(),
    lastUploadAt: null,
  });
}

describe('uploader 402 handling (Phase 3)', () => {
  it('test 30: uploader receives 402 → throws UploadLimitError with parsed payload', async () => {
    const mock = makeMockServer({
      apiKeys: { [KEY]: { userId: 'user1', runs: [RUN_ID] } },
      scenarios: {
        cap402: {
          limit: 'runs_per_month',
          current: 1042,
          max: 1000,
          upgrade_url: 'https://autopilot.dev/dashboard/billing',
        },
      },
    });
    process.env.AUTOPILOT_DASHBOARD_BASE_URL = 'http://test.invalid';
    let caught: unknown = null;
    try {
      await uploaderMod.uploadRun(RUN_ID, runDir, {
        apiKey: KEY,
        fetchImpl: mock.fetch,
      });
    } catch (err) {
      caught = err;
    }
    assert.ok(caught instanceof uploaderMod.UploadLimitError, 'expected UploadLimitError');
    const e = caught as InstanceType<typeof uploaderMod.UploadLimitError>;
    assert.strictEqual(e.status, 402);
    assert.strictEqual(e.payload.limit, 'runs_per_month');
    assert.strictEqual(e.payload.current, 1042);
    assert.strictEqual(e.payload.max, 1000);
    assert.strictEqual(e.payload.upgrade_url, 'https://autopilot.dev/dashboard/billing');
    assert.match(e.message, /1042\/1000/);
    assert.match(e.message, /Upgrade at/);
  });

  it('test 31: autoUploadAtComplete catches UploadLimitError → reason=limit-reached, no throw', async () => {
    await seedConfig();
    const mock = makeMockServer({
      apiKeys: { [KEY]: { userId: 'user1', runs: [RUN_ID] } },
      scenarios: {
        cap402: {
          limit: 'storage_bytes',
          current: 6_000_000_000,
          max: 5_368_709_120,
          upgrade_url: 'https://autopilot.dev/dashboard/billing',
        },
      },
    });
    process.env.AUTOPILOT_DASHBOARD_BASE_URL = 'http://test.invalid';
    const r = await autoMod.autoUploadAtComplete(RUN_ID, runDir, {
      fetchImpl: mock.fetch,
      silent: true,
    });
    assert.strictEqual(r.attempted, true);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'limit-reached');
  });

  it('test 32: CLI run exit code preserved — autoUpload returns w/o throwing on 402', async () => {
    await seedConfig();
    const mock = makeMockServer({
      apiKeys: { [KEY]: { userId: 'user1', runs: [RUN_ID] } },
      scenarios: {
        cap402: {
          limit: 'runs_per_month',
          current: 101,
          max: 100,
          upgrade_url: 'https://autopilot.dev/dashboard/billing',
        },
      },
    });
    process.env.AUTOPILOT_DASHBOARD_BASE_URL = 'http://test.invalid';
    // The autopilot CLI calls autoUploadAtComplete inside a try/catch that
    // swallows ALL errors so the run's exit code is preserved. The
    // contract here is: autoUploadAtComplete must NOT throw on 402.
    let threw = false;
    try {
      await autoMod.autoUploadAtComplete(RUN_ID, runDir, {
        fetchImpl: mock.fetch,
        silent: true,
      });
    } catch {
      threw = true;
    }
    assert.strictEqual(threw, false, 'autoUploadAtComplete should swallow UploadLimitError');
  });
});
