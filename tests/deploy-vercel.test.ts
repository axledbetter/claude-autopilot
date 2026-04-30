import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { VercelDeployAdapter } from '../src/adapters/deploy/vercel.ts';
import { GuardrailError } from '../src/core/errors.ts';

/**
 * Minimal Response factory for stubbed fetch. We don't pull in undici/fetch
 * machinery — the real fetch only needs `.ok`, `.status`, `.json()`, `.text()`.
 */
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

interface MockCall {
  url: string;
  init?: RequestInit;
}

/** Returns a fetch stub that walks `responses` in order; each can be a Response or a thrown error. */
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

/**
 * Build a minimal Response whose `body` is a web ReadableStream that yields
 * the given chunks (UTF-8 encoded). When `error` is set, the stream rejects
 * the next read with that error.
 */
function streamingRes(status: number, chunks: Array<string>, error?: Error): Response {
  let i = 0;
  const reader = {
    async read(): Promise<{ done: boolean; value?: Uint8Array }> {
      if (error && i === chunks.length) throw error;
      if (i >= chunks.length) return { done: true };
      const chunk = chunks[i++]!;
      return { done: false, value: new TextEncoder().encode(chunk) };
    },
    cancel() { return Promise.resolve(); },
    releaseLock() {},
  };
  const body = { getReader: () => reader } as unknown as ReadableStream<Uint8Array>;
  return {
    ok: status >= 200 && status < 300,
    status,
    body,
    text: async () => chunks.join(''),
    json: async () => JSON.parse(chunks.join('')),
  } as unknown as Response;
}

const sleepNoop = async () => {};
const fixedNow = () => 1_700_000_000_000;

describe('VercelDeployAdapter', () => {
  it('deploys successfully when state reaches READY', async () => {
    const { fetch, calls } = mockFetch([
      res(200, { id: 'dpl_abc', url: 'app-abc.vercel.app' }),
      res(200, { id: 'dpl_abc', readyState: 'READY', url: 'app-abc.vercel.app' }),
    ]);
    const adapter = new VercelDeployAdapter({
      token: 'tok_test',
      project: 'my-app',
      fetchImpl: fetch,
      sleepImpl: sleepNoop,
      nowImpl: fixedNow,
    });
    const result = await adapter.deploy({});
    assert.equal(result.status, 'pass');
    assert.equal(result.deployId, 'dpl_abc');
    assert.equal(result.deployUrl, 'https://app-abc.vercel.app');
    assert.ok(result.buildLogsUrl?.includes('dpl_abc'));
    assert.equal(calls.length, 2);
    assert.equal(calls[0]!.init?.method, 'POST');
    assert.match(calls[0]!.url, /\/v13\/deployments$/);
  });

  it('returns fail when build state is ERROR', async () => {
    const { fetch } = mockFetch([
      res(200, { id: 'dpl_err', url: 'fail-x.vercel.app' }),
      res(200, { id: 'dpl_err', readyState: 'ERROR', url: 'fail-x.vercel.app' }),
    ]);
    const adapter = new VercelDeployAdapter({
      token: 'tok_test',
      project: 'my-app',
      fetchImpl: fetch,
      sleepImpl: sleepNoop,
      nowImpl: fixedNow,
    });
    const result = await adapter.deploy({});
    assert.equal(result.status, 'fail');
    assert.equal(result.deployId, 'dpl_err');
  });

  it('throws GuardrailError(auth) on 401', async () => {
    const { fetch } = mockFetch([res(401, { error: { message: 'token expired' } })]);
    const adapter = new VercelDeployAdapter({
      token: 'bad_tok',
      project: 'my-app',
      fetchImpl: fetch,
      sleepImpl: sleepNoop,
      nowImpl: fixedNow,
    });
    await assert.rejects(
      adapter.deploy({}),
      (err: unknown) => {
        if (!(err instanceof GuardrailError)) return false;
        assert.equal(err.code, 'auth');
        assert.equal(err.provider, 'vercel');
        return true;
      },
    );
  });

  it('throws GuardrailError(invalid_config) on 404 project not found', async () => {
    const { fetch } = mockFetch([res(404, { error: { message: 'no such project' } })]);
    const adapter = new VercelDeployAdapter({
      token: 'tok_test',
      project: 'ghost',
      fetchImpl: fetch,
      sleepImpl: sleepNoop,
      nowImpl: fixedNow,
    });
    await assert.rejects(
      adapter.deploy({}),
      (err: unknown) => {
        if (!(err instanceof GuardrailError)) return false;
        assert.equal(err.code, 'invalid_config');
        assert.equal(err.provider, 'vercel');
        return true;
      },
    );
  });

  it('throws GuardrailError(auth) at construction when token is missing', () => {
    const previous = process.env.VERCEL_TOKEN;
    delete process.env.VERCEL_TOKEN;
    try {
      assert.throws(
        () => new VercelDeployAdapter({ project: 'my-app' }),
        (err: unknown) => err instanceof GuardrailError && err.code === 'auth',
      );
    } finally {
      if (previous !== undefined) process.env.VERCEL_TOKEN = previous;
    }
  });

  it('retries on transient network blip then succeeds', async () => {
    const { fetch, calls } = mockFetch([
      new Error('ECONNRESET'),
      res(200, { id: 'dpl_retry', url: 'r.vercel.app' }),
      res(200, { id: 'dpl_retry', readyState: 'READY', url: 'r.vercel.app' }),
    ]);
    const adapter = new VercelDeployAdapter({
      token: 'tok_test',
      project: 'my-app',
      fetchImpl: fetch,
      sleepImpl: sleepNoop,
      nowImpl: fixedNow,
    });
    const result = await adapter.deploy({});
    assert.equal(result.status, 'pass');
    assert.equal(calls.length, 3, 'expected POST retry + status poll');
  });

  it('status() returns one-shot READY result', async () => {
    const { fetch, calls } = mockFetch([
      res(200, { id: 'dpl_xyz', readyState: 'READY', url: 'xyz.vercel.app' }),
    ]);
    const adapter = new VercelDeployAdapter({
      token: 'tok_test',
      project: 'my-app',
      fetchImpl: fetch,
      sleepImpl: sleepNoop,
      nowImpl: fixedNow,
    });
    const r = await adapter.status({ deployId: 'dpl_xyz' });
    assert.equal(r.status, 'pass');
    assert.equal(r.deployId, 'dpl_xyz');
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.init?.method, 'GET');
    assert.match(calls[0]!.url, /dpl_xyz/);
  });

  it('polls through BUILDING then READY', async () => {
    const { fetch, calls } = mockFetch([
      res(200, { id: 'dpl_p', url: 'p.vercel.app' }),
      res(200, { id: 'dpl_p', readyState: 'BUILDING', url: 'p.vercel.app' }),
      res(200, { id: 'dpl_p', readyState: 'BUILDING', url: 'p.vercel.app' }),
      res(200, { id: 'dpl_p', readyState: 'READY', url: 'p.vercel.app' }),
    ]);
    const adapter = new VercelDeployAdapter({
      token: 'tok_test',
      project: 'my-app',
      fetchImpl: fetch,
      sleepImpl: sleepNoop,
      nowImpl: fixedNow,
    });
    const result = await adapter.deploy({});
    assert.equal(result.status, 'pass');
    assert.equal(calls.length, 4);
  });

  it('returns in-progress when poll budget is exceeded', async () => {
    let t = 1_700_000_000_000;
    const advancingNow = () => {
      t += 1_000_000; // advance 1000 seconds per call
      return t;
    };
    const { fetch } = mockFetch([
      res(200, { id: 'dpl_slow', url: 's.vercel.app' }),
      res(200, { id: 'dpl_slow', readyState: 'BUILDING', url: 's.vercel.app' }),
      res(200, { id: 'dpl_slow', readyState: 'BUILDING', url: 's.vercel.app' }),
    ]);
    const adapter = new VercelDeployAdapter({
      token: 'tok_test',
      project: 'my-app',
      maxPollMs: 100, // tiny budget — virtual clock blows past it on first check
      fetchImpl: fetch,
      sleepImpl: sleepNoop,
      nowImpl: advancingNow,
    });
    const result = await adapter.deploy({});
    assert.equal(result.status, 'in-progress');
    assert.equal(result.deployId, 'dpl_slow');
  });

  it('appends teamId to API URLs when team is configured', async () => {
    const { fetch, calls } = mockFetch([
      res(200, { id: 'dpl_team', url: 't.vercel.app' }),
      res(200, { id: 'dpl_team', readyState: 'READY', url: 't.vercel.app' }),
    ]);
    const adapter = new VercelDeployAdapter({
      token: 'tok_test',
      project: 'my-app',
      team: 'team_xyz',
      fetchImpl: fetch,
      sleepImpl: sleepNoop,
      nowImpl: fixedNow,
    });
    const r = await adapter.deploy({});
    assert.equal(r.status, 'pass');
    assert.match(calls[0]!.url, /teamId=team_xyz/);
    assert.match(calls[1]!.url, /teamId=team_xyz/);
  });

  it('fires onDeployStart with the new deployment id immediately after POST', async () => {
    const { fetch } = mockFetch([
      res(200, { id: 'dpl_start', url: 'app.vercel.app' }),
      res(200, { id: 'dpl_start', readyState: 'READY', url: 'app.vercel.app' }),
    ]);
    const adapter = new VercelDeployAdapter({
      token: 'tok_test',
      project: 'my-app',
      fetchImpl: fetch,
      sleepImpl: sleepNoop,
      nowImpl: fixedNow,
    });
    const seen: string[] = [];
    const result = await adapter.deploy({
      onDeployStart: (id) => { seen.push(id); },
    });
    assert.deepEqual(seen, ['dpl_start']);
    assert.equal(result.status, 'pass');
  });

  it('does not fire onDeployStart when create POST returns no id', async () => {
    const { fetch } = mockFetch([res(200, { url: 'no-id.vercel.app' })]);
    const adapter = new VercelDeployAdapter({
      token: 'tok_test',
      project: 'my-app',
      fetchImpl: fetch,
      sleepImpl: sleepNoop,
      nowImpl: fixedNow,
    });
    const seen: string[] = [];
    await assert.rejects(
      adapter.deploy({ onDeployStart: (id) => { seen.push(id); } }),
      /no deployment id/,
    );
    assert.deepEqual(seen, []);
  });
});

describe('VercelDeployAdapter.streamLogs', () => {
  it('yields DeployLogLines parsed from a mocked NDJSON stream', async () => {
    const events = [
      JSON.stringify({ type: 'stdout', payload: { text: 'hello' }, created: 1700000000000 }) + '\n',
      JSON.stringify({ type: 'stderr', payload: { text: 'warn x' }, created: 1700000000001 }) + '\n',
      JSON.stringify({ type: 'state', payload: { state: 'BUILDING' }, created: 1700000000002 }) + '\n',
      JSON.stringify({ type: 'stdout', payload: { text: 'done' }, created: 1700000000003 }) + '\n',
    ];
    const { fetch } = mockFetch([streamingRes(200, [events.join('')])]);
    const adapter = new VercelDeployAdapter({
      token: 'tok_test',
      project: 'my-app',
      fetchImpl: fetch,
      sleepImpl: sleepNoop,
      nowImpl: fixedNow,
    });
    const lines: Array<{ text: string; level?: string }> = [];
    for await (const line of adapter.streamLogs!({ deployId: 'dpl_x' })) {
      lines.push({ text: line.text, level: line.level });
    }
    assert.deepEqual(lines, [
      { text: 'hello', level: 'stdout' },
      { text: 'warn x', level: 'stderr' },
      { text: 'done', level: 'stdout' },
    ]);
  });
});
