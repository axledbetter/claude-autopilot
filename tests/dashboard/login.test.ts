import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const VALID_KEY = `clp_${'a'.repeat(64)}`;
const FINGERPRINT = `clp_${'a'.repeat(12)}`;

function getNonceFromUrl(url: string): string {
  const u = new URL(url);
  return u.searchParams.get('nonce') ?? '';
}

function getCbFromUrl(url: string): string {
  const u = new URL(url);
  return u.searchParams.get('cb') ?? '';
}

let tmpHome: string;
let mod: typeof import('../../src/cli/dashboard/login.ts');
let cfgMod: typeof import('../../src/dashboard/config.ts');

before(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'ap-login-'));
  process.env.CLAUDE_AUTOPILOT_HOME = tmpHome;
  // Phase 4 — canonical env name. The deprecated AUTOPILOT_DASHBOARD_BASE_URL
  // is still honored (with warning) but tests use the new name.
  process.env.AUTOPILOT_PUBLIC_BASE_URL = 'http://test.invalid';
  mod = await import('../../src/cli/dashboard/login.ts');
  cfgMod = await import('../../src/dashboard/config.ts');
});

after(async () => {
  delete process.env.CLAUDE_AUTOPILOT_HOME;
  delete process.env.AUTOPILOT_PUBLIC_BASE_URL;
  delete process.env.AUTOPILOT_DASHBOARD_BASE_URL;
  await fs.rm(tmpHome, { recursive: true, force: true });
});

beforeEach(async () => {
  await cfgMod.deleteConfig();
});

describe('runDashboardLogin', () => {
  it('completes when callback POSTs valid payload with matching nonce', async () => {
    let captured = '';
    const p = mod.runDashboardLogin({
      portRangeStart: 56100,
      silent: true,
      openBrowser: (url) => { captured = url; },
    });
    // Wait until openBrowser sees the URL.
    await new Promise((r) => setTimeout(r, 50));
    const nonce = getNonceFromUrl(captured);
    const cb = getCbFromUrl(captured);
    const res = await fetch(cb, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        apiKey: VALID_KEY,
        fingerprint: FINGERPRINT,
        accountEmail: 'alex@example.com',
        nonce,
      }),
    });
    assert.strictEqual(res.status, 200);
    // Phase 4 — POST response carries CORS header so the /cli-auth page
    // can read the JSON under mode: 'cors'.
    assert.strictEqual(res.headers.get('access-control-allow-origin'), 'http://test.invalid');
    const okBody = await res.json() as { ok: boolean; nonce: string };
    assert.strictEqual(okBody.ok, true);
    assert.strictEqual(okBody.nonce, nonce);
    const result = await p;
    assert.strictEqual(result.config.apiKey, VALID_KEY);
    assert.strictEqual(result.config.fingerprint, FINGERPRINT);

    const onDisk = await cfgMod.readConfig();
    assert.deepStrictEqual(onDisk?.apiKey, VALID_KEY);
  });

  it('Phase 4 — OPTIONS preflight returns 204 with CORS headers', async () => {
    let captured = '';
    const p = mod.runDashboardLogin({
      portRangeStart: 56140,
      silent: true,
      openBrowser: (url) => { captured = url; },
      timeoutMs: 2000,
    });
    // Catch the inevitable timeout — we're only testing OPTIONS.
    const settled = p.then((v) => ({ ok: true as const, v }), (err) => ({ ok: false as const, err: err as Error }));
    await new Promise((r) => setTimeout(r, 50));
    const cb = getCbFromUrl(captured);
    const res = await fetch(cb, {
      method: 'OPTIONS',
      headers: {
        origin: 'http://test.invalid',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type',
      },
    });
    assert.strictEqual(res.status, 204);
    assert.strictEqual(res.headers.get('access-control-allow-origin'), 'http://test.invalid');
    assert.match(res.headers.get('access-control-allow-methods') ?? '', /POST/);
    assert.match(res.headers.get('access-control-allow-headers') ?? '', /content-type/);
    // Drain the timeout so the test exits cleanly.
    await settled;
  });

  it('rejects callback with mismatched nonce', async () => {
    let captured = '';
    const p = mod.runDashboardLogin({
      portRangeStart: 56110,
      silent: true,
      openBrowser: (url) => { captured = url; },
    });
    // Attach catch handler immediately so the rejection isn't classified
    // as unhandled before we assert on it.
    const settled = p.then((v) => ({ ok: true as const, v }), (err) => ({ ok: false as const, err: err as Error }));
    await new Promise((r) => setTimeout(r, 50));
    const cb = getCbFromUrl(captured);
    const res = await fetch(cb, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        apiKey: VALID_KEY,
        fingerprint: FINGERPRINT,
        accountEmail: 'alex@example.com',
        nonce: 'evil-nonce-not-matching',
      }),
    });
    assert.strictEqual(res.status, 403);
    const out = await settled;
    assert.strictEqual(out.ok, false);
    assert.match((out as { ok: false; err: Error }).err.message, /nonce mismatch/);
  });

  it('rejects callback with malformed apiKey', async () => {
    let captured = '';
    const p = mod.runDashboardLogin({
      portRangeStart: 56120,
      silent: true,
      openBrowser: (url) => { captured = url; },
    });
    const settled = p.then((v) => ({ ok: true as const, v }), (err) => ({ ok: false as const, err: err as Error }));
    await new Promise((r) => setTimeout(r, 50));
    const nonce = getNonceFromUrl(captured);
    const cb = getCbFromUrl(captured);
    const res = await fetch(cb, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        apiKey: 'not-a-key',
        fingerprint: FINGERPRINT,
        accountEmail: 'a@b',
        nonce,
      }),
    });
    assert.strictEqual(res.status, 422);
    const out = await settled;
    assert.strictEqual(out.ok, false);
    assert.match((out as { ok: false; err: Error }).err.message, /invalid apiKey/);
  });

  it('times out cleanly with no callback', async () => {
    const p = mod.runDashboardLogin({
      portRangeStart: 56130,
      silent: true,
      openBrowser: () => {},
      timeoutMs: 200,
    });
    const out = await p.then((v) => ({ ok: true as const, v }), (err) => ({ ok: false as const, err: err as Error }));
    assert.strictEqual(out.ok, false);
    assert.match((out as { ok: false; err: Error }).err.message, /timed out/);
  });
});
