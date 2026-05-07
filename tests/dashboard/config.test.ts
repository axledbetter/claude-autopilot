import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const KEY = `clp_${'a'.repeat(64)}`;

describe('dashboard config', () => {
  let tmpHome: string;
  let configPath: string;
  let mod: typeof import('../../src/dashboard/config.ts');

  before(async () => {
    tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'ap-cfg-'));
    process.env.CLAUDE_AUTOPILOT_HOME = tmpHome;
    // Re-import after env is set so resolveHome() picks it up.
    mod = await import('../../src/dashboard/config.ts');
    configPath = mod.getConfigPath();
  });

  after(async () => {
    delete process.env.CLAUDE_AUTOPILOT_HOME;
    await fs.rm(tmpHome, { recursive: true, force: true });
  });

  it('returns null when no config exists', async () => {
    const r = await mod.readConfig();
    assert.strictEqual(r, null);
  });

  it('writes atomically with mode 0600 and 0700 dir', async () => {
    const cfg: import('../../src/dashboard/config.ts').DashboardConfig = {
      schemaVersion: 1,
      apiKey: KEY,
      fingerprint: `clp_${'a'.repeat(12)}`,
      accountEmail: 'test@example.com',
      loggedInAt: new Date().toISOString(),
      lastUploadAt: null,
    };
    await mod.writeConfig(cfg);

    const stat = await fs.stat(configPath);
    assert.strictEqual(stat.mode & 0o777, 0o600);

    const dirStat = await fs.stat(path.dirname(configPath));
    // Compare the user-mode triplet — group/other should be 0.
    assert.strictEqual((dirStat.mode & 0o077), 0o000, 'dir group/world bits should be 0');

    const r = await mod.readConfig();
    assert.deepStrictEqual(r, cfg);
  });

  it('rejects writeConfig with malformed apiKey', async () => {
    await assert.rejects(() => mod.writeConfig({
      schemaVersion: 1,
      apiKey: 'not-valid',
      fingerprint: 'clp_xx',
      accountEmail: 'a@b',
      loggedInAt: new Date().toISOString(),
      lastUploadAt: null,
    }), /invalid apiKey/);
  });

  it('returns null on schemaVersion mismatch', async () => {
    await fs.writeFile(configPath, JSON.stringify({ schemaVersion: 99, apiKey: KEY }));
    const r = await mod.readConfig();
    assert.strictEqual(r, null);
  });

  it('returns null on bad apiKey shape in stored config', async () => {
    await fs.writeFile(configPath, JSON.stringify({
      schemaVersion: 1,
      apiKey: 'short',
    }));
    const r = await mod.readConfig();
    assert.strictEqual(r, null);
  });

  it('deleteConfig is idempotent', async () => {
    await mod.deleteConfig();
    await mod.deleteConfig();
    const r = await mod.readConfig();
    assert.strictEqual(r, null);
  });

  it('warnIfPermissive returns null for 0600 and warns on permissive bits', async () => {
    const cfg: import('../../src/dashboard/config.ts').DashboardConfig = {
      schemaVersion: 1,
      apiKey: KEY,
      fingerprint: `clp_${'a'.repeat(12)}`,
      accountEmail: 'test@example.com',
      loggedInAt: new Date().toISOString(),
      lastUploadAt: null,
    };
    await mod.writeConfig(cfg);
    let w = await mod.warnIfPermissive();
    assert.strictEqual(w, null);

    if (process.platform !== 'win32') {
      await fs.chmod(configPath, 0o644);
      w = await mod.warnIfPermissive();
      assert.match(w!, /group\/world readable/);
    }
  });
});
