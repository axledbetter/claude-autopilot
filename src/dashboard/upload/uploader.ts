// CLI uploader — snapshot, chunk, retry, finalize.
//
// Flow:
//   1. Empty events.ndjson check → skip upload (Phase 2.2 returns 422 on
//      expectedChunkCount=0; never call it).
//   2. Snapshot events.ndjson + state.json to <runDir>/.upload-snapshot/.
//   3. Bootstrap session: GET dashboard upload-session for resume; if 404
//      mint fresh via POST /api/upload-session (Phase 2.2 endpoint, accepts
//      Bearer clp_<key> via resolveCaller).
//   4. PUT each chunk with x-chunk-prev-hash; retry transient 5xx.
//   5. POST /api/runs/:runId/finalize with chainRoot + state.
//   6. On success, delete the snapshot dir.

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { hashChunk, ZERO_HASH } from './chain.ts';
import { sha256OfCanonical } from './canonical.ts';
import { snapshotRun, deleteSnapshot, SnapshotMismatchError } from './snapshot.ts';

const CHUNK_BYTES = 1024 * 1024;     // 1 MiB matches server MAX_CHUNK_BYTES
const DEFAULT_RETRY_DELAYS_MS = [1000, 4000, 16000, 64000];

function resolveRetryDelays(): number[] {
  // Test seam — let CI/tests override the exponential backoff schedule
  // so transient-failure assertions don't add minutes to the suite.
  const override = process.env.CLAUDE_AUTOPILOT_UPLOAD_RETRY_MS;
  if (!override) return DEFAULT_RETRY_DELAYS_MS;
  return override
    .split(',')
    .map((s) => Number.parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n) && n >= 0);
}

export interface UploadOptions {
  signal?: AbortSignal;
  baseUrl?: string;
  apiKey: string;
  onProgress?: (event: ProgressEvent) => void;
  /** Test seam — substitute fetch impl. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export type ProgressEvent =
  | { kind: 'snapshot'; bytes: number }
  | { kind: 'session'; resumed: boolean; nextExpectedSeq: number }
  | { kind: 'chunk-uploaded'; seq: number; total: number }
  | { kind: 'finalized' };

export interface UploadResult {
  ok: boolean;
  url?: string;
  skipped?: boolean;
  error?: string;
}

interface SessionInfo {
  uploadToken: string;
  expiresAt: string;
  session: {
    id: string;
    runId: string;
    jti: string;
    nextExpectedSeq?: number;
  };
}

class UploadError extends Error {
  public readonly status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.status = status;
  }
}

function resolveBaseUrl(opts: UploadOptions): string {
  return (
    opts.baseUrl ??
    process.env.AUTOPILOT_DASHBOARD_BASE_URL ??
    'https://autopilot.dev'
  );
}

function checkAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    const reason = (signal as AbortSignal & { reason?: unknown }).reason;
    const err = reason instanceof Error
      ? reason
      : new Error('upload aborted');
    throw err;
  }
}

async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    if (signal) {
      const onAbort = (): void => {
        clearTimeout(t);
        reject(new Error('aborted'));
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

async function readChunks(filePath: string): Promise<Buffer[]> {
  const handle = await fs.open(filePath, 'r');
  try {
    const stat = await handle.stat();
    const total = stat.size;
    const out: Buffer[] = [];
    let position = 0;
    while (position < total) {
      const remaining = total - position;
      const size = remaining < CHUNK_BYTES ? remaining : CHUNK_BYTES;
      const buf = Buffer.alloc(size);
      const { bytesRead } = await handle.read(buf, 0, size, position);
      if (bytesRead !== size) {
        throw new UploadError(`short read at offset ${position}: ${bytesRead}/${size}`);
      }
      out.push(buf);
      position += size;
    }
    return out;
  } finally {
    await handle.close();
  }
}

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  fetchImpl: typeof fetch,
  signal: AbortSignal | undefined,
  is5xxRetryable: boolean,
): Promise<Response> {
  let lastErr: unknown = null;
  const delays = resolveRetryDelays();
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    checkAborted(signal);
    try {
      const res = await fetchImpl(url, init);
      if (res.status >= 500 && res.status < 600 && is5xxRetryable && attempt < delays.length) {
        const wait = delays[attempt]!;
        await delay(wait, signal);
        continue;
      }
      return res;
    } catch (err) {
      if (signal?.aborted) throw err;
      lastErr = err;
      if (attempt < delays.length) {
        const wait = delays[attempt]!;
        await delay(wait, signal);
        continue;
      }
      throw err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new UploadError('exhausted retries');
}

async function bootstrapSession(
  baseUrl: string,
  apiKey: string,
  runId: string,
  expectedChunkCount: number,
  fetchImpl: typeof fetch,
  signal: AbortSignal | undefined,
): Promise<{ session: SessionInfo; resumed: boolean }> {
  // Resume path first.
  const resumeUrl = `${baseUrl}/api/dashboard/runs/${encodeURIComponent(runId)}/upload-session`;
  const resumeRes = await fetchWithRetry(resumeUrl, {
    method: 'GET',
    headers: { authorization: `Bearer ${apiKey}` },
    signal,
  }, fetchImpl, signal, true);
  if (resumeRes.status === 200) {
    const data = await resumeRes.json() as SessionInfo;
    return { session: data, resumed: true };
  }
  if (resumeRes.status !== 404) {
    const text = await resumeRes.text().catch(() => '');
    throw new UploadError(`resume bootstrap failed: ${resumeRes.status} ${text}`, resumeRes.status);
  }

  // Mint fresh via Phase 2.2 endpoint.
  const mintUrl = `${baseUrl}/api/upload-session`;
  const mintRes = await fetchWithRetry(mintUrl, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ runId, expectedChunkCount }),
    signal,
  }, fetchImpl, signal, true);
  if (mintRes.status !== 201) {
    const text = await mintRes.text().catch(() => '');
    throw new UploadError(`mint failed: ${mintRes.status} ${text}`, mintRes.status);
  }
  const data = await mintRes.json() as SessionInfo;
  return { session: { ...data, session: { ...data.session, nextExpectedSeq: 0 } }, resumed: false };
}

export async function uploadRun(
  runId: string,
  runDir: string,
  opts: UploadOptions,
): Promise<UploadResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const baseUrl = resolveBaseUrl(opts);
  const signal = opts.signal;

  try {
    // (1) Empty events check — skip cleanly so server's 422 isn't tripped.
    const eventsPath = path.join(runDir, 'events.ndjson');
    let eventsStat;
    try {
      eventsStat = await fs.stat(eventsPath);
    } catch {
      return { ok: true, skipped: true };
    }
    if (eventsStat.size === 0) {
      return { ok: true, skipped: true };
    }

    // (2) Snapshot.
    checkAborted(signal);
    const snap = await snapshotRun(runDir);
    opts.onProgress?.({ kind: 'snapshot', bytes: snap.eventsBytes });

    const chunks = await readChunks(snap.events);
    const expectedChunkCount = chunks.length;

    // (3) Bootstrap.
    checkAborted(signal);
    const { session, resumed } = await bootstrapSession(
      baseUrl, opts.apiKey, runId, expectedChunkCount, fetchImpl, signal,
    );
    const startSeq = session.session.nextExpectedSeq ?? 0;
    opts.onProgress?.({ kind: 'session', resumed, nextExpectedSeq: startSeq });

    // (4) Stream chunks. Walk the chain forward from seq 0 even when
    // resuming so prev-hash for seq=startSeq is correct.
    let prev = ZERO_HASH;
    for (let i = 0; i < startSeq; i++) {
      const chunk = chunks[i];
      if (!chunk) throw new UploadError(`missing chunk at seq ${i} during prefix replay`);
      prev = hashChunk(prev, chunk);
    }

    let token = session.uploadToken;
    let chainRoot = prev;
    let reauthAttempts = 0;        // bugbot HIGH — bound the 401 re-bootstrap retry
    const MAX_REAUTH_ATTEMPTS = 1;
    for (let seq = startSeq; seq < chunks.length; seq++) {
      checkAborted(signal);
      const chunk = chunks[seq];
      if (!chunk) throw new UploadError(`missing chunk at seq ${seq}`);
      const thisHash = hashChunk(prev, chunk);
      const url = `${baseUrl}/api/runs/${encodeURIComponent(runId)}/events/${seq}`;
      const init: RequestInit = {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/octet-stream',
          'x-chunk-prev-hash': prev,
        },
        body: chunk,
        signal,
      };
      const res = await fetchWithRetry(url, init, fetchImpl, signal, true);
      if (res.status === 200 || res.status === 201) {
        prev = thisHash;
        chainRoot = thisHash;
        opts.onProgress?.({ kind: 'chunk-uploaded', seq, total: chunks.length });
        continue;
      }
      if (res.status === 401) {
        // bugbot HIGH — bound retries. Token might be expired, OR the API
        // key is revoked (bootstrap succeeds but minted tokens are still
        // 401). Without a counter, the loop spins forever.
        if (reauthAttempts >= MAX_REAUTH_ATTEMPTS) {
          const text = await res.text().catch(() => '');
          throw new UploadError(
            `chunk ${seq} unauthorized after ${reauthAttempts} re-bootstrap attempt(s); check API key validity. ${text}`,
            res.status,
          );
        }
        reauthAttempts++;
        const reboot = await bootstrapSession(
          baseUrl, opts.apiKey, runId, expectedChunkCount, fetchImpl, signal,
        );
        token = reboot.session.uploadToken;
        seq -= 1;
        continue;
      }
      if (res.status === 409) {
        // Duplicate chunk content with matching hash is treated as success
        // by the server (RPC path); treat as success here too if hash agrees.
        const text = await res.text().catch(() => '');
        if (/duplicate/i.test(text)) {
          prev = thisHash;
          chainRoot = thisHash;
          opts.onProgress?.({ kind: 'chunk-uploaded', seq, total: chunks.length });
          continue;
        }
        throw new UploadError(`chunk ${seq} rejected: ${res.status} ${text}`, res.status);
      }
      const text = await res.text().catch(() => '');
      throw new UploadError(`chunk ${seq} failed: ${res.status} ${text}`, res.status);
    }

    // (5) Finalize.
    checkAborted(signal);
    let stateJson: unknown = {};
    try {
      const raw = await fs.readFile(snap.state, 'utf-8');
      stateJson = JSON.parse(raw);
    } catch {
      stateJson = {};
    }
    // sha256 not strictly needed here — server recomputes — but include for parity.
    void sha256OfCanonical(stateJson);

    const finalizeUrl = `${baseUrl}/api/runs/${encodeURIComponent(runId)}/finalize`;
    const finalRes = await fetchWithRetry(finalizeUrl, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        chainRoot,
        expectedChunkCount,
        stateJson,
      }),
      signal,
    }, fetchImpl, signal, true);
    if (finalRes.status !== 200) {
      const text = await finalRes.text().catch(() => '');
      throw new UploadError(`finalize failed: ${finalRes.status} ${text}`, finalRes.status);
    }
    opts.onProgress?.({ kind: 'finalized' });

    // (6) Cleanup snapshot.
    await deleteSnapshot(runDir);

    return {
      ok: true,
      url: `${baseUrl}/runs/${encodeURIComponent(runId)}`,
    };
  } catch (err) {
    if (err instanceof SnapshotMismatchError) {
      return { ok: false, error: `snapshot mismatch: ${err.message}` };
    }
    if ((err as Error).message === 'aborted') {
      return { ok: false, error: 'aborted' };
    }
    return { ok: false, error: (err as Error).message ?? String(err) };
  }
}
