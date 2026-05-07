import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const KEY = `clp_${'a'.repeat(64)}`;

let tmpHome: string;
let cfgMod: typeof import('../../src/dashboard/config.ts');
let logoutMod: typeof import('../../src/cli/dashboard/logout.ts');

before(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'ap-logout-'));
  process.env.CLAUDE_AUTOPILOT_HOME = tmpHome;
  cfgMod = await import('../../src/dashboard/config.ts');
  logoutMod = await import('../../src/cli/dashboard/logout.ts');
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

describe('runDashboardLogout', () => {
  it('revokes server-side and deletes local config', async () => {
    await seedConfig();
    let revokeCalls = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/api/dashboard/api-keys/revoke') && init?.method === 'POST') {
        revokeCalls += 1;
        return new Response(JSON.stringify({ ok: true, keyId: 'key1' }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('not found', { status: 404 });
    };
    const r = await logoutMod.runDashboardLogout({
      fetchImpl,
      baseUrl: 'http://test.invalid',
      silent: true,
    });
    assert.strictEqual(r.hadConfig, true);
    assert.strictEqual(r.serverRevoked, true);
    assert.strictEqual(revokeCalls, 1);
    const after = await cfgMod.readConfig();
    assert.strictEqual(after, null);
  });

  it('is idempotent when not logged in (no config)', async () => {
    let revokeCalls = 0;
    const fetchImpl: typeof fetch = async () => {
      revokeCalls += 1;
      return new Response('', { status: 200 });
    };
    const r = await logoutMod.runDashboardLogout({
      fetchImpl,
      silent: true,
    });
    assert.strictEqual(r.hadConfig, false);
    assert.strictEqual(revokeCalls, 0);
  });

  it('still deletes local config even if server revoke fails', async () => {
    await seedConfig();
    const fetchImpl: typeof fetch = async () => {
      throw new Error('network down');
    };
    const r = await logoutMod.runDashboardLogout({
      fetchImpl,
      baseUrl: 'http://test.invalid',
      silent: true,
    });
    assert.strictEqual(r.hadConfig, true);
    assert.strictEqual(r.serverRevoked, false);
    const after = await cfgMod.readConfig();
    assert.strictEqual(after, null);
  });
});
