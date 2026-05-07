// Lightweight in-memory mock of the dashboard + ingest endpoints used by
// the uploader. Returned `fetchImpl` matches the global fetch signature
// closely enough for the routes the CLI hits:
//   GET  /api/dashboard/runs/:runId/upload-session  (resume)
//   POST /api/upload-session                         (mint, Phase 2.2)
//   PUT  /api/runs/:runId/events/:seq                (chunk)
//   POST /api/runs/:runId/finalize                   (finalize)

import { createHash } from 'node:crypto';

export interface MockServerOptions {
  /** API keys keyed by raw value (e.g. clp_...) → { userId, runs }. */
  apiKeys: Record<string, { userId: string; runs: string[] }>;
  /** Force certain transient behaviors. */
  scenarios?: {
    flakyChunkSeq?: number;        // first time PUT for this seq: 503
    rejectFirstFinalize?: boolean; // first POST to finalize: 503
    expireTokenAfterSeq?: number;  // after this seq, return 401 once
    duplicateChunkSeq?: number;    // PUT this seq returns 409 "duplicate" once
    /** Persistent 401 on every chunk PUT — simulates revoked API key /
     *  permanently invalid upload token. Used for the bugbot regression:
     *  the uploader must NOT loop forever; it must give up after one
     *  re-bootstrap attempt. */
    persistChunk401?: boolean;
    inflightSession?: { runId: string; token: string; jti: string; nextExpectedSeq: number };
  };
}

export interface MockServerHandle {
  fetch: typeof fetch;
  state: {
    chunks: Map<string, Buffer>; // key: `${runId}/${seq}`
    finalized: Set<string>;
    chunkPutCounts: Map<string, number>;
    finalizeCount: number;
    expireTriggered: boolean;
    duplicateTriggered: boolean;
  };
}

export function makeMockServer(opts: MockServerOptions): MockServerHandle {
  const state = {
    chunks: new Map<string, Buffer>(),
    finalized: new Set<string>(),
    chunkPutCounts: new Map<string, number>(),
    finalizeCount: 0,
    expireTriggered: false,
    duplicateTriggered: false,
  };
  const flaky = new Map<number, boolean>();
  const sc = opts.scenarios ?? {};

  function authedUser(headers: Headers): { userId: string; runs: string[] } | null {
    const auth = headers.get('authorization') ?? '';
    if (!auth.startsWith('Bearer ')) return null;
    const tok = auth.slice('Bearer '.length).trim();
    if (tok.startsWith('clp_')) {
      const entry = opts.apiKeys[tok];
      return entry ?? null;
    }
    // Upload-token JWT-style — accept any non-empty token bound to the
    // mock session we minted earlier. Tests only have one user/run so we
    // pull the first apiKey config to satisfy ownership.
    if (tok.length > 0) {
      const first = Object.values(opts.apiKeys)[0];
      return first ?? null;
    }
    return null;
  }

  function jsonResponse(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : (input as Request | URL).toString();
    const u = new URL(url);
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = new Headers(init?.headers ?? {});

    // --- GET /api/dashboard/runs/:runId/upload-session ---
    let m = u.pathname.match(/^\/api\/dashboard\/runs\/([^/]+)\/upload-session$/);
    if (m && method === 'GET') {
      const auth = authedUser(headers);
      if (!auth) return jsonResponse(401, { error: 'unauthenticated' });
      const runId = decodeURIComponent(m[1]!);
      if (!auth.runs.includes(runId)) return jsonResponse(404, { error: 'not found' });
      const inflight = sc.inflightSession;
      if (inflight && inflight.runId === runId) {
        return jsonResponse(200, {
          uploadToken: inflight.token,
          expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
          session: {
            id: 'sess1',
            runId,
            jti: inflight.jti,
            nextExpectedSeq: inflight.nextExpectedSeq,
          },
        });
      }
      return jsonResponse(404, { error: 'not found' });
    }

    // --- POST /api/upload-session (Phase 2.2) ---
    if (u.pathname === '/api/upload-session' && method === 'POST') {
      const auth = authedUser(headers);
      if (!auth) return jsonResponse(401, { error: 'unauthenticated' });
      const body = JSON.parse(String(init?.body ?? '{}')) as { runId: string; expectedChunkCount: number };
      if (!auth.runs.includes(body.runId)) return jsonResponse(404, { error: 'not found' });
      const token = `tok_${createHash('sha256').update(body.runId + ':' + Date.now() + ':' + Math.random()).digest('hex')}`;
      return jsonResponse(201, {
        uploadToken: token,
        expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
        session: { id: 'sess-fresh', runId: body.runId, jti: `jti-${body.runId}` },
      });
    }

    // --- PUT /api/runs/:runId/events/:seq ---
    m = u.pathname.match(/^\/api\/runs\/([^/]+)\/events\/(\d+)$/);
    if (m && method === 'PUT') {
      const auth = authedUser(headers);
      if (!auth) return jsonResponse(401, { error: 'unauthenticated' });
      const runId = decodeURIComponent(m[1]!);
      const seq = Number.parseInt(m[2]!, 10);

      // Persistent 401 — simulates revoked API key. Used for the bugbot
      // regression test that asserts the uploader doesn't loop forever.
      if (sc.persistChunk401) {
        return jsonResponse(401, { error: 'unauthorized' });
      }

      // Token-expire scenario.
      if (sc.expireTokenAfterSeq !== undefined && !state.expireTriggered && seq > sc.expireTokenAfterSeq) {
        state.expireTriggered = true;
        return jsonResponse(401, { error: 'token expired' });
      }

      // Flaky chunk scenario.
      if (sc.flakyChunkSeq === seq && !flaky.get(seq)) {
        flaky.set(seq, true);
        return jsonResponse(503, { error: 'transient' });
      }

      // Duplicate-chunk scenario.
      if (sc.duplicateChunkSeq === seq && !state.duplicateTriggered) {
        state.duplicateTriggered = true;
        return jsonResponse(409, { error: 'duplicate chunk' });
      }

      const key = `${runId}/${seq}`;
      // Use a permissive cast for the body — the global Response/RequestInit
      // BodyInit type isn't reliably exported across Node 22 lib variants.
      const body = init?.body ?? null;
      const buf = Buffer.from(await new Response(body as ConstructorParameters<typeof Response>[0]).arrayBuffer());
      state.chunks.set(key, buf);
      state.chunkPutCounts.set(key, (state.chunkPutCounts.get(key) ?? 0) + 1);
      return jsonResponse(200, { ok: true });
    }

    // --- POST /api/runs/:runId/finalize ---
    m = u.pathname.match(/^\/api\/runs\/([^/]+)\/finalize$/);
    if (m && method === 'POST') {
      const auth = authedUser(headers);
      if (!auth) return jsonResponse(401, { error: 'unauthenticated' });
      const runId = decodeURIComponent(m[1]!);
      state.finalizeCount += 1;
      if (sc.rejectFirstFinalize && state.finalizeCount === 1) {
        return jsonResponse(503, { error: 'transient' });
      }
      state.finalized.add(runId);
      return jsonResponse(200, {
        runId,
        sourceVerified: true,
        eventsChainRoot: 'ok',
      });
    }

    return jsonResponse(404, { error: `unhandled ${method} ${u.pathname}` });
  };

  return { fetch: fetchImpl, state };
}
