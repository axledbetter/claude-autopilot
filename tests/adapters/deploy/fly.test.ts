// tests/adapters/deploy/fly.test.ts
//
// Phase 1 of v5.6: Fly.io deploy adapter — covers `deploy()` + `status()`,
// the new HTTP-status-keyed error taxonomy (auth/not_found/invalid_config/
// transient_network), Fly-Request-Id capture, log redaction on `output`,
// and the factory's per-adapter required-fields validation.
//
// Spec: docs/specs/v5.6-fly-render-adapters.md

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { FlyDeployAdapter } from '../../../src/adapters/deploy/fly.ts';
import { createDeployAdapter } from '../../../src/adapters/deploy/index.ts';
import { GuardrailError } from '../../../src/core/errors.ts';

/**
 * Minimal Response factory. We don't pull in undici — the adapter only needs
 * `.ok`, `.status`, `.json()`, `.text()`, and (when present) `.headers.get()`.
 *
 * Pass `headers` to simulate Fly's `Fly-Request-Id` echo on error responses.
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
  token: 'fly_tok_test',
  app: 'my-app',
  image: 'registry.fly.io/my-app:deployment-01',
  fetchImpl: undefined as unknown as typeof fetch,
  sleepImpl: sleepNoop,
  nowImpl: fixedNow,
};

describe('FlyDeployAdapter.deploy', () => {
  it('returns pass + populated deployId/deployUrl/durationMs when state reaches succeeded', async () => {
    let t = 1_700_000_000_000;
    const advancingNow = () => {
      t += 100;
      return t;
    };
    const { fetch, calls } = mockFetch([
      // POST /releases — accepted
      res(201, { id: 'rel_abc', hostname: 'my-app.fly.dev' }),
      // First poll — still running
      res(200, { id: 'rel_abc', state: 'running', hostname: 'my-app.fly.dev' }),
      // Second poll — succeeded
      res(200, { id: 'rel_abc', state: 'succeeded', hostname: 'my-app.fly.dev' }),
    ]);
    const adapter = new FlyDeployAdapter({ ...baseOpts, fetchImpl: fetch, nowImpl: advancingNow });
    const result = await adapter.deploy({});
    assert.equal(result.status, 'pass');
    assert.equal(result.deployId, 'rel_abc');
    assert.equal(result.deployUrl, 'https://my-app.fly.dev');
    assert.ok(result.buildLogsUrl?.includes('rel_abc'));
    assert.ok(typeof result.durationMs === 'number' && result.durationMs > 0);
    assert.equal(calls.length, 3);
    assert.equal(calls[0]!.init?.method, 'POST');
    assert.match(calls[0]!.url, /\/v1\/apps\/my-app\/releases$/);
    // Body must include the configured image
    const body = JSON.parse(calls[0]!.init!.body as string);
    assert.equal(body.image, 'registry.fly.io/my-app:deployment-01');
  });

  it('throws GuardrailError(auth) on 401 with hint mentioning fly.io/dashboard/personal/tokens', async () => {
    const { fetch } = mockFetch([res(401, { error: 'token expired' })]);
    const adapter = new FlyDeployAdapter({ ...baseOpts, fetchImpl: fetch });
    await assert.rejects(
      adapter.deploy({}),
      (err: unknown) => {
        if (!(err instanceof GuardrailError)) return false;
        assert.equal(err.code, 'auth');
        assert.equal(err.provider, 'fly');
        // Hint mentions the token regeneration URL
        assert.match(err.message, /fly\.io\/dashboard\/personal\/tokens/);
        return true;
      },
    );
  });

  it('throws GuardrailError(auth) on 403', async () => {
    const { fetch } = mockFetch([res(403, { error: 'forbidden' })]);
    const adapter = new FlyDeployAdapter({ ...baseOpts, fetchImpl: fetch });
    await assert.rejects(
      adapter.deploy({}),
      (err: unknown) => {
        if (!(err instanceof GuardrailError)) return false;
        assert.equal(err.code, 'auth');
        assert.equal(err.provider, 'fly');
        return true;
      },
    );
  });

  it('throws GuardrailError(not_found) on 404 and captures Fly-Request-Id in details', async () => {
    const { fetch } = mockFetch([
      res(404, { error: 'app not found' }, { 'Fly-Request-Id': 'req_xyz_123' }),
    ]);
    const adapter = new FlyDeployAdapter({ ...baseOpts, app: 'ghost-app', fetchImpl: fetch });
    await assert.rejects(
      adapter.deploy({}),
      (err: unknown) => {
        if (!(err instanceof GuardrailError)) return false;
        assert.equal(err.code, 'not_found');
        assert.equal(err.provider, 'fly');
        // Request-id surfaces in both details and the human-readable message
        assert.equal(err.details.flyRequestId, 'req_xyz_123');
        assert.match(err.message, /req_xyz_123/);
        return true;
      },
    );
  });

  it('throws GuardrailError(invalid_config) on 422 (bad image)', async () => {
    const { fetch } = mockFetch([
      res(422, { error: 'image registry.fly.io/my-app:bogus not in registry' }),
    ]);
    const adapter = new FlyDeployAdapter({ ...baseOpts, fetchImpl: fetch });
    await assert.rejects(
      adapter.deploy({}),
      (err: unknown) => {
        if (!(err instanceof GuardrailError)) return false;
        assert.equal(err.code, 'invalid_config');
        assert.equal(err.provider, 'fly');
        return true;
      },
    );
  });

  it('throws GuardrailError(transient_network, retryable) when 5xx exhausts retries', async () => {
    // All three attempts return 502 → retry budget exhausted → assertOkOrThrow
    // re-classifies the final 5xx response as transient_network.
    const { fetch, calls } = mockFetch([
      res(502, 'bad gateway'),
      res(502, 'bad gateway'),
      res(502, 'bad gateway'),
    ]);
    const adapter = new FlyDeployAdapter({ ...baseOpts, fetchImpl: fetch });
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
    // Even though Phase 1 only surfaces a small status line via `output`,
    // any text leaving the adapter MUST go through the redaction primitive
    // — defense-in-depth before Phase 3 starts feeding real log lines in.
    // This test seeds an `id` value that contains an AWS-key-shape so we
    // can prove the redaction wraps the output.
    const { fetch } = mockFetch([
      res(201, { id: 'AKIAIOSFODNN7EXAMPLE', hostname: 'my-app.fly.dev' }),
      res(200, { id: 'AKIAIOSFODNN7EXAMPLE', state: 'succeeded', hostname: 'my-app.fly.dev' }),
    ]);
    const adapter = new FlyDeployAdapter({ ...baseOpts, fetchImpl: fetch });
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

describe('FlyDeployAdapter.status', () => {
  it('returns one-shot succeeded result without polling', async () => {
    const { fetch, calls } = mockFetch([
      res(200, { id: 'rel_xyz', state: 'succeeded', hostname: 'my-app.fly.dev' }),
    ]);
    const adapter = new FlyDeployAdapter({ ...baseOpts, fetchImpl: fetch });
    const r = await adapter.status({ deployId: 'rel_xyz' });
    assert.equal(r.status, 'pass');
    assert.equal(r.deployId, 'rel_xyz');
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.init?.method, 'GET');
    assert.match(calls[0]!.url, /\/v1\/apps\/my-app\/releases\/rel_xyz$/);
  });
});

describe('createDeployAdapter factory — fly required-fields validation', () => {
  it('throws invalid_config when adapter=fly is configured without app', () => {
    assert.throws(
      () => createDeployAdapter({
        adapter: 'fly',
        // app missing
        image: 'registry.fly.io/my-app:latest',
      }),
      (err: unknown) => {
        if (!(err instanceof GuardrailError)) return false;
        assert.equal(err.code, 'invalid_config');
        assert.equal(err.provider, 'fly');
        assert.match(err.message, /deploy\.app/);
        return true;
      },
    );
  });

  it('throws invalid_config when adapter=fly is configured without image', () => {
    assert.throws(
      () => createDeployAdapter({
        adapter: 'fly',
        app: 'my-app',
        // image missing
      }),
      (err: unknown) => {
        if (!(err instanceof GuardrailError)) return false;
        assert.equal(err.code, 'invalid_config');
        assert.equal(err.provider, 'fly');
        assert.match(err.message, /deploy\.image/);
        return true;
      },
    );
  });
});

describe('FlyDeployAdapter capability metadata', () => {
  it('declares streamMode=websocket and nativeRollback=true', () => {
    const adapter = new FlyDeployAdapter({ ...baseOpts, fetchImpl: (() => {}) as unknown as typeof fetch });
    assert.equal(adapter.capabilities?.streamMode, 'websocket');
    assert.equal(adapter.capabilities?.nativeRollback, true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 3 of v5.6 — streamLogs over WebSocket.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Minimal WebSocket stub that mirrors the standard surface used by the
 * adapter:
 *   - constructor(url, protocols)
 *   - addEventListener('message' | 'error' | 'close', listener)
 *   - removeEventListener(type, listener)
 *   - close()
 *
 * Tests drive it via `emit(type, event)` to deliver synthetic events to the
 * adapter's pump loop. Each new instance is captured in the shared
 * `instances[]` array so assertions can inspect what the adapter did.
 */
interface FakeWsEvent {
  data?: string | ArrayBuffer | ArrayBufferView;
}
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  readonly url: string;
  readonly protocols: string | string[] | undefined;
  readonly listeners = new Map<string, Set<(ev: FakeWsEvent) => void>>();
  closed = false;
  constructor(url: string, protocols?: string | string[]) {
    this.url = url;
    this.protocols = protocols;
    FakeWebSocket.instances.push(this);
  }
  addEventListener(type: string, listener: (ev: FakeWsEvent) => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
  }
  removeEventListener(type: string, listener: (ev: FakeWsEvent) => void): void {
    this.listeners.get(type)?.delete(listener);
  }
  emit(type: string, ev: FakeWsEvent): void {
    for (const l of this.listeners.get(type) ?? []) l(ev);
  }
  close(): void {
    this.closed = true;
    this.emit('close', {});
  }
}

function freshFakeWs(): typeof WebSocket {
  FakeWebSocket.instances = [];
  return FakeWebSocket as unknown as typeof WebSocket;
}

describe('FlyDeployAdapter.streamLogs', () => {
  it('yields lines as the WebSocket emits NDJSON messages', async () => {
    const wsImpl = freshFakeWs();
    const adapter = new FlyDeployAdapter({
      ...baseOpts,
      fetchImpl: (() => {}) as unknown as typeof fetch,
      wsImpl,
      buildLogsWsUrl: () => 'wss://test.invalid/logs',
    });
    const iter = adapter.streamLogs({ deployId: 'rel_abc' });
    // Drive the iterator forward — yield first message after a tick so the
    // generator has time to hook the listeners.
    const collected: string[] = [];
    const consumer = (async () => {
      for await (const line of iter) {
        collected.push(line.text);
        if (collected.length === 2) break;
      }
    })();
    // Wait one microtask so the generator hooks `addEventListener('message')`.
    await new Promise((r) => setImmediate(r));
    const ws = FakeWebSocket.instances[0]!;
    ws.emit('message', { data: JSON.stringify({ timestamp: 100, level: 'info', message: 'first' }) });
    ws.emit('message', { data: JSON.stringify({ timestamp: 200, level: 'info', message: 'second' }) });
    await consumer;
    assert.deepEqual(collected, ['first', 'second']);
  });

  it('honors signal.aborted and stops the iterator within one tick', async () => {
    const wsImpl = freshFakeWs();
    const adapter = new FlyDeployAdapter({
      ...baseOpts,
      fetchImpl: (() => {}) as unknown as typeof fetch,
      wsImpl,
      buildLogsWsUrl: () => 'wss://test.invalid/logs',
    });
    const ctrl = new AbortController();
    const iter = adapter.streamLogs({ deployId: 'rel_abc', signal: ctrl.signal });
    const collected: string[] = [];
    const consumer = (async () => {
      for await (const line of iter) collected.push(line.text);
    })();
    await new Promise((r) => setImmediate(r));
    const ws = FakeWebSocket.instances[0]!;
    ws.emit('message', { data: JSON.stringify({ timestamp: 1, level: 'info', message: 'one' }) });
    // Abort + give the iterator one tick to wind down.
    ctrl.abort();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    await consumer;
    // First message may or may not have been delivered depending on tick
    // ordering — what matters is the iterator stops and never yields after
    // abort.
    assert.ok(collected.length <= 1, `expected <=1 line before abort, got ${collected.length}`);
    assert.equal(ws.closed, true, 'expected socket to be closed on abort');
  });

  it('reconnects once on disconnect and ends with a warn line referencing buildLogsUrl', async () => {
    const wsImpl = freshFakeWs();
    let urlBuilds = 0;
    const adapter = new FlyDeployAdapter({
      ...baseOpts,
      fetchImpl: (() => {}) as unknown as typeof fetch,
      wsImpl,
      buildLogsWsUrl: () => {
        urlBuilds += 1;
        return 'wss://test.invalid/logs';
      },
      sleepImpl: async () => {}, // skip the 1s backoff
    });
    const iter = adapter.streamLogs({ deployId: 'rel_abc' });
    const collected: Array<{ level: string | undefined; text: string }> = [];
    const consumer = (async () => {
      for await (const line of iter) {
        collected.push({ level: line.level, text: line.text });
      }
    })();
    await new Promise((r) => setImmediate(r));
    // First socket emits one line then closes — adapter should reconnect.
    const ws1 = FakeWebSocket.instances[0]!;
    ws1.emit('message', { data: JSON.stringify({ timestamp: 1, level: 'info', message: 'before-close' }) });
    ws1.close();
    // Wait several ticks for the reconnect to fire.
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    assert.equal(FakeWebSocket.instances.length, 2, 'expected exactly one reconnect');
    const ws2 = FakeWebSocket.instances[1]!;
    ws2.emit('message', { data: JSON.stringify({ timestamp: 2, level: 'info', message: 'after-reconnect' }) });
    ws2.close();
    await consumer;
    // Lines collected: before-close, after-reconnect, then the final warn.
    assert.equal(collected.length, 3, `expected 3 lines, got ${collected.map((c) => c.text).join(' | ')}`);
    assert.equal(collected[0]!.text, 'before-close');
    assert.equal(collected[1]!.text, 'after-reconnect');
    assert.equal(collected[2]!.level, 'warn');
    assert.match(collected[2]!.text, /log stream lost/);
    assert.match(collected[2]!.text, /releases\/rel_abc/);
    assert.equal(urlBuilds, 2, 'expected url builder called once per connection attempt');
  });

  it('redacts secrets in yielded log line text', async () => {
    const wsImpl = freshFakeWs();
    const adapter = new FlyDeployAdapter({
      ...baseOpts,
      fetchImpl: (() => {}) as unknown as typeof fetch,
      wsImpl,
      buildLogsWsUrl: () => 'wss://test.invalid/logs',
    });
    const iter = adapter.streamLogs({ deployId: 'rel_abc' });
    const collected: string[] = [];
    const consumer = (async () => {
      for await (const line of iter) {
        collected.push(line.text);
        if (collected.length === 1) break;
      }
    })();
    await new Promise((r) => setImmediate(r));
    const ws = FakeWebSocket.instances[0]!;
    ws.emit('message', {
      data: JSON.stringify({
        timestamp: 1,
        level: 'info',
        // Default redaction pattern: \bAKIA[A-Z0-9]{16}\b
        message: 'starting up with key=AKIAIOSFODNN7EXAMPLE in env',
      }),
    });
    await consumer;
    assert.equal(collected.length, 1);
    assert.ok(
      !collected[0]!.includes('AKIAIOSFODNN7EXAMPLE'),
      `raw secret leaked into yielded text: ${collected[0]}`,
    );
    assert.match(collected[0]!, /\[REDACTED\]/);
  });
});
