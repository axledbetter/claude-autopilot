import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const KEY = `clp_${'a'.repeat(64)}`;

let tmpHome: string;
let cfgMod: typeof import('../../src/dashboard/config.ts');
let statusMod: typeof import('../../src/cli/dashboard/status.ts');

before(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'ap-status-'));
  process.env.CLAUDE_AUTOPILOT_HOME = tmpHome;
  cfgMod = await import('../../src/dashboard/config.ts');
  statusMod = await import('../../src/cli/dashboard/status.ts');
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

describe('runDashboardStatus', () => {
  it('reports not logged in when no config', async () => {
    const r = await statusMod.runDashboardStatus({ silent: true });
    assert.strictEqual(r.loggedIn, false);
    assert.strictEqual(r.fingerprint, null);
  });

  it('returns logged-in summary plus server data', async () => {
    await seedConfig();
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      const headers = new Headers(init?.headers ?? {});
      if (url.endsWith('/api/dashboard/me')) {
        assert.match(headers.get('authorization') ?? '', /^Bearer clp_/);
        return new Response(JSON.stringify({
          email: 'a@b.com',
          fingerprint: `clp_${'a'.repeat(12)}`,
          organizations: [{ id: 'org1', name: 'Acme', role: 'admin' }],
          lastUploadAt: '2026-05-07T12:00:00Z',
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response('', { status: 404 });
    };
    const r = await statusMod.runDashboardStatus({
      fetchImpl,
      baseUrl: 'http://test.invalid',
      silent: true,
    });
    assert.strictEqual(r.loggedIn, true);
    assert.strictEqual(r.serverOk, true);
    assert.strictEqual(r.organizations.length, 1);
    assert.strictEqual(r.lastUploadAt, '2026-05-07T12:00:00Z');
  });

  it('falls back gracefully when server unreachable', async () => {
    await seedConfig();
    const fetchImpl: typeof fetch = async () => {
      throw new Error('network down');
    };
    const r = await statusMod.runDashboardStatus({
      fetchImpl,
      baseUrl: 'http://test.invalid',
      silent: true,
    });
    assert.strictEqual(r.loggedIn, true);
    assert.strictEqual(r.serverOk, false);
    assert.strictEqual(r.organizations.length, 0);
  });
});
