// tests/adapters/deploy/vercel.test.ts
//
// Phase 5 of v5.6 — retroactive log redaction for the v5.4 Vercel adapter.
// The original `tests/deploy-vercel.test.ts` exhaustively covers
// deploy/status/rollback/streamLogs behavior; this file owns the v5.6
// parity check that brings Vercel in line with Fly/Render.
//
// Spec: docs/specs/v5.6-fly-render-adapters.md § "Log redaction"

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { VercelDeployAdapter } from '../../../src/adapters/deploy/vercel.ts';

function res(status: number, body: unknown): Response {
  const isJson = typeof body === 'object' && body !== null;
  const text = isJson ? JSON.stringify(body) : String(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => (isJson ? body : JSON.parse(text)),
    text: async () => text,
  } as unknown as Response;
}

function mockFetch(responses: Response[]): typeof fetch {
  let i = 0;
  return (async (_url: unknown, _init?: RequestInit) => {
    const r = responses[i++];
    if (!r) throw new Error(`mock fetch: no more responses (call ${i})`);
    return r;
  }) as unknown as typeof fetch;
}

const sleepNoop = async () => {};
const fixedNow = () => 1_700_000_000_000;

describe('VercelDeployAdapter — Phase 5 retroactive redaction', () => {
  it('redacts AWS-key-shaped secret in DeployResult.output', async () => {
    // The Phase-5 v5.6 work brought the Vercel adapter into parity with
    // Fly/Render: every `output` line built inside the adapter must run
    // through `redactLogLines` before leaving. We seed the deployment id
    // with a literal AWS-access-key shape so we can prove the redaction
    // wraps `output` end-to-end (deploy POST → poll → shapeResult).
    const fetchImpl = mockFetch([
      res(200, { id: 'AKIAIOSFODNN7EXAMPLE', url: 'app.vercel.app' }),
      res(200, { id: 'AKIAIOSFODNN7EXAMPLE', readyState: 'READY', url: 'app.vercel.app' }),
    ]);
    const adapter = new VercelDeployAdapter({
      token: 'tok_test',
      project: 'my-app',
      fetchImpl,
      sleepImpl: sleepNoop,
      nowImpl: fixedNow,
    });
    const result = await adapter.deploy({});
    assert.equal(result.status, 'pass');
    assert.ok(result.output, 'expected output to be populated');
    // The raw AWS key shape MUST NOT appear in `output`.
    assert.ok(
      !result.output!.includes('AKIAIOSFODNN7EXAMPLE'),
      `raw secret leaked into output: ${result.output}`,
    );
    // And the redaction sentinel SHOULD appear in its place.
    assert.match(result.output!, /\[REDACTED/);
  });
});
