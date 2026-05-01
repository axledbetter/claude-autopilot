// tests/adapters/deploy/render.test.ts
//
// Phase 2 of v5.6: Render deploy adapter — covers `deploy()` + `status()`,
// the HTTP-status-keyed error taxonomy (auth/not_found/invalid_config/
// transient_network), x-request-id capture, log redaction on `output`,
// the `streamMode='polling' / nativeRollback=false` capability surface,
// and the factory's per-adapter required-fields validation.
//
// Spec: docs/specs/v5.6-fly-render-adapters.md

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { RenderDeployAdapter } from '../../../src/adapters/deploy/render.ts';
import { createDeployAdapter } from '../../../src/adapters/deploy/index.ts';
import { GuardrailError } from '../../../src/core/errors.ts';

/**
 * Minimal Response factory. We don't pull in undici — the adapter only
 * needs `.ok`, `.status`, `.json()`, `.text()`, and (when present)
 * `.headers.get()`.
 *
 * Pass `headers` to simulate Render's `x-request-id` echo on responses.
 */
function res(status: number, body: unknown, headers?: Record<string, string>): Response {
  const isJson = typeof body === 'object' && body !== null;
  const text = isJson ? JSON.stringify(body) : String(body);
  const hmap = new Map<string, string>();
  if (headers) {
    for (const [k, v] of Object.entries(headers)) hmap.set(k.toLowerCase(), v);
  }
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(key: string): string | null {
        return hmap.get(key.toLowerCase()) ?? null;
      },
    },
    json: async () => (isJson ? body : JSON.parse(text)),
    text: async () => text,
  } as unknown as Response;
}

interface MockCall {
  url: string;
  init?: RequestInit;
}

function mockFetch(responses: Array<Response | Error>): { fetch: typeof fetch; calls: MockCall[] } {
  const calls: MockCall[] = [];
  let i = 0;
  const fetchStub = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const r = responses[i++];
    if (!r) throw new Error(`mock fetch: no more responses (call ${i})`);
    if (r instanceof Error) throw r;
    return r;
  }) as unknown as typeof fetch;
  return { fetch: fetchStub, calls };
}

const sleepNoop = async () => {};
const fixedNow = () => 1_700_000_000_000;

const baseOpts = {
  token: 'rnd_tok_test',
  serviceId: 'srv-abc123',
  fetchImpl: undefined as unknown as typeof fetch,
  sleepImpl: sleepNoop,
  nowImpl: fixedNow,
};

describe('RenderDeployAdapter.deploy', () => {
  it('returns pass + populated deployId/durationMs when status reaches live', async () => {
    let t = 1_700_000_000_000;
    const advancingNow = () => {
      t += 100;
      return t;
    };
    const { fetch, calls } = mockFetch([
      // POST /deploys — accepted
      res(201, { id: 'dep_abc', commit: { id: 'sha_111' }, status: 'created' }),
      // First poll — still building
      res(200, { id: 'dep_abc', commit: { id: 'sha_111' }, status: 'build_in_progress' }),
      // Second poll — live
      res(200, { id: 'dep_abc', commit: { id: 'sha_111' }, status: 'live' }),
    ]);
    const adapter = new RenderDeployAdapter({ ...baseOpts, fetchImpl: fetch, nowImpl: advancingNow });
    const result = await adapter.deploy({});
    assert.equal(result.status, 'pass');
    assert.equal(result.deployId, 'dep_abc');
    assert.ok(result.buildLogsUrl?.includes('dep_abc'));
    assert.ok(result.buildLogsUrl?.includes('srv-abc123'));
    assert.ok(typeof result.durationMs === 'number' && result.durationMs > 0);
    assert.equal(calls.length, 3);
    assert.equal(calls[0]!.init?.method, 'POST');
    assert.match(calls[0]!.url, /\/v1\/services\/srv-abc123\/deploys$/);
    // Body must include the default clearCache value
    const body = JSON.parse(calls[0]!.init!.body as string);
    assert.equal(body.clearCache, 'do_not_clear');
    // Polling targets the deploy-by-id endpoint, not the service-deploys list
    assert.match(calls[1]!.url, /\/v1\/deploys\/dep_abc$/);
    assert.equal(calls[1]!.init?.method, 'GET');
  });

  it('throws GuardrailError(auth) on 401 with hint mentioning dashboard.render.com/u/settings#api-keys', async () => {
    const { fetch } = mockFetch([res(401, { message: 'token expired' })]);
    const adapter = new RenderDeployAdapter({ ...baseOpts, fetchImpl: fetch });
    await assert.rejects(
      adapter.deploy({}),
      (err: unknown) => {
        if (!(err instanceof GuardrailError)) return false;
        assert.equal(err.code, 'auth');
        assert.equal(err.provider, 'render');
        // Hint mentions the API-key dashboard URL
        assert.match(err.message, /dashboard\.render\.com\/u\/settings#api-keys/);
        return true;
      },
    );
  });

  it('throws GuardrailError(auth) on 403', async () => {
    const { fetch } = mockFetch([res(403, { message: 'forbidden' })]);
    const adapter = new RenderDeployAdapter({ ...baseOpts, fetchImpl: fetch });
    await assert.rejects(
      adapter.deploy({}),
      (err: unknown) => {
        if (!(err instanceof GuardrailError)) return false;
        assert.equal(err.code, 'auth');
        assert.equal(err.provider, 'render');
        return true;
      },
    );
  });

  it('throws GuardrailError(not_found) on 404 and captures x-request-id in details', async () => {
    const { fetch } = mockFetch([
      res(404, { message: 'service not found' }, { 'x-request-id': 'req_render_456' }),
    ]);
    const adapter = new RenderDeployAdapter({ ...baseOpts, serviceId: 'srv-ghost', fetchImpl: fetch });
    await assert.rejects(
      adapter.deploy({}),
      (err: unknown) => {
        if (!(err instanceof GuardrailError)) return false;
        assert.equal(err.code, 'not_found');
        assert.equal(err.provider, 'render');
        // Request-id surfaces in both details and the human-readable message
        assert.equal(err.details.renderRequestId, 'req_render_456');
        assert.match(err.message, /req_render_456/);
        return true;
      },
    );
  });

  it('throws GuardrailError(invalid_config) on 422 (bad clearCache or serviceId)', async () => {
    const { fetch } = mockFetch([
      res(422, { message: 'invalid clearCache value' }),
    ]);
    const adapter = new RenderDeployAdapter({ ...baseOpts, fetchImpl: fetch });
    await assert.rejects(
      adapter.deploy({}),
      (err: unknown) => {
        if (!(err instanceof GuardrailError)) return false;
        assert.equal(err.code, 'invalid_config');
        assert.equal(err.provider, 'render');
        return true;
      },
    );
  });

  it('throws GuardrailError(transient_network, retryable) when 5xx exhausts retries', async () => {
    // All three attempts return 503 → retry budget exhausted →
    // assertOkOrThrow re-classifies the final 5xx as transient_network.
    const { fetch, calls } = mockFetch([
      res(503, 'service unavailable'),
      res(503, 'service unavailable'),
      res(503, 'service unavailable'),
    ]);
    const adapter = new RenderDeployAdapter({ ...baseOpts, fetchImpl: fetch });
    await assert.rejects(
      adapter.deploy({}),
      (err: unknown) => {
        if (!(err instanceof GuardrailError)) return false;
        assert.equal(err.code, 'transient_network');
        assert.equal(err.retryable, true);
        return true;
      },
    );
    // 3 fetch attempts: initial + 2 retries
    assert.equal(calls.length, 3);
  });

  it('redacts AWS-key-shaped secret in DeployResult.output', async () => {
    // Phase 2 only surfaces a small status line via `output`, but any text
    // leaving the adapter MUST go through the redaction primitive — defense
    // in depth before Phase 3 starts feeding real log lines in. We seed an
    // `id` value containing an AWS-key-shape so we can prove the redaction
    // wraps `output`.
    const { fetch } = mockFetch([
      res(201, { id: 'AKIAIOSFODNN7EXAMPLE', commit: { id: 'sha_222' }, status: 'created' }),
      res(200, { id: 'AKIAIOSFODNN7EXAMPLE', commit: { id: 'sha_222' }, status: 'live' }),
    ]);
    const adapter = new RenderDeployAdapter({ ...baseOpts, fetchImpl: fetch });
    const result = await adapter.deploy({});
    assert.equal(result.status, 'pass');
    assert.ok(result.output, 'expected output to be populated');
    // The raw AWS key shape MUST NOT appear in `output`
    assert.ok(
      !result.output!.includes('AKIAIOSFODNN7EXAMPLE'),
      `raw secret leaked into output: ${result.output}`,
    );
    // And the redaction sentinel SHOULD appear in its place
    assert.match(result.output!, /\[REDACTED/);
  });
});

describe('RenderDeployAdapter.status', () => {
  it('returns one-shot live result without polling', async () => {
    const { fetch, calls } = mockFetch([
      res(200, { id: 'dep_xyz', commit: { id: 'sha_333' }, status: 'live' }),
    ]);
    const adapter = new RenderDeployAdapter({ ...baseOpts, fetchImpl: fetch });
    const r = await adapter.status({ deployId: 'dep_xyz' });
    assert.equal(r.status, 'pass');
    assert.equal(r.deployId, 'dep_xyz');
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.init?.method, 'GET');
    assert.match(calls[0]!.url, /\/v1\/deploys\/dep_xyz$/);
  });

  it('maps build_failed terminal status to fail', async () => {
    const { fetch } = mockFetch([
      res(200, { id: 'dep_fail', commit: { id: 'sha_444' }, status: 'build_failed' }),
    ]);
    const adapter = new RenderDeployAdapter({ ...baseOpts, fetchImpl: fetch });
    const r = await adapter.status({ deployId: 'dep_fail' });
    assert.equal(r.status, 'fail');
    assert.equal(r.deployId, 'dep_fail');
  });
});

describe('createDeployAdapter factory — render required-fields validation', () => {
  it('throws invalid_config when adapter=render is configured without serviceId', () => {
    assert.throws(
      () => createDeployAdapter({
        adapter: 'render',
        // serviceId missing
      }),
      (err: unknown) => {
        if (!(err instanceof GuardrailError)) return false;
        assert.equal(err.code, 'invalid_config');
        assert.equal(err.provider, 'render');
        assert.match(err.message, /deploy\.serviceId/);
        return true;
      },
    );
  });
});

describe('RenderDeployAdapter capability metadata', () => {
  it('declares streamMode=polling and nativeRollback=false', () => {
    const adapter = new RenderDeployAdapter({ ...baseOpts, fetchImpl: (() => {}) as unknown as typeof fetch });
    assert.equal(adapter.capabilities?.streamMode, 'polling');
    assert.equal(adapter.capabilities?.nativeRollback, false);
  });
});
