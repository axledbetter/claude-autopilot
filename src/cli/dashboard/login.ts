// `claude-autopilot dashboard login` — nonce-bound loopback OAuth-ish flow.
//
// 1. Generate 128-bit nonce.
// 2. Bind a node:http listener on the first available port in 56000-56050.
// 3. Open https://autopilot.dev/cli-auth?cb=<callback>&nonce=<nonce> in the
//    user's browser. (User signs in, web page POSTs back to the callback
//    with { apiKey, fingerprint, accountEmail, nonce }.)
// 4. Validate nonce with crypto.timingSafeEqual; reject mismatches.
// 5. Atomically write ~/.claude-autopilot/dashboard.json with mode 0600.
// 6. Respond 200 to the browser; close listener; print success.
//
// The web `/cli-auth` page is operator-deferred to Phase 4 dashboard UI;
// for now tests use a mock browser handler that simulates the full flow.

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { spawn } from 'node:child_process';
import {
  writeConfig,
  type DashboardConfig,
  getAutopilotBaseUrl,
} from '../../dashboard/config.ts';

const PORT_START = 56000;
const PORT_END = 56050;
const NONCE_BYTES = 16; // 128-bit
const TIMEOUT_MS = 5 * 60 * 1000;
const MAX_BODY_BYTES = 4096;
const KEY_RE = /^clp_[0-9a-f]{64}$/;

export interface LoginOptions {
  /** Override base URL for tests / staging. */
  baseUrl?: string;
  /** Override browser launch — useful in tests + headless CI. */
  openBrowser?: (url: string) => void | Promise<void>;
  /** Manual mode: print URL, accept paste of (apiKey, fingerprint, email) on stdin instead of loopback. */
  manual?: boolean;
  /** Test seam — let tests force a specific port range start to avoid collisions. */
  portRangeStart?: number;
  /** Test seam — abort the listener after a fixed timeout. */
  timeoutMs?: number;
  /** Test seam — silence stdout/stderr writes. */
  silent?: boolean;
  signal?: AbortSignal;
}

export interface LoginResult {
  config: DashboardConfig;
  port: number;
}

interface CallbackBody {
  apiKey?: unknown;
  fingerprint?: unknown;
  accountEmail?: unknown;
  nonce?: unknown;
}

function nonceMatch(expected: string, candidate: string): boolean {
  // timingSafeEqual requires equal-length buffers.
  const a = Buffer.from(expected, 'utf-8');
  const b = Buffer.from(candidate, 'utf-8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

async function tryListen(port: number): Promise<{ server: Server; port: number } | null> {
  return new Promise((resolve) => {
    const server = createServer();
    const onError = (): void => {
      server.removeListener('listening', onListening);
      resolve(null);
    };
    const onListening = (): void => {
      server.removeListener('error', onError);
      resolve({ server, port });
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });
}

async function bindFirstPort(start: number, end: number): Promise<{ server: Server; port: number }> {
  for (let p = start; p <= end; p++) {
    const r = await tryListen(p);
    if (r) return r;
  }
  throw new Error(`could not bind any port in ${start}-${end}`);
}

function readJsonBody(req: IncomingMessage): Promise<CallbackBody> {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      bytes += c.length;
      if (bytes > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error('body too large'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const buf = Buffer.concat(chunks);
        resolve(JSON.parse(buf.toString('utf-8')) as CallbackBody);
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function openInBrowser(url: string): void {
  // Best-effort cross-platform; ignored on test/headless paths.
  const platform = process.platform;
  let cmd: string;
  let args: string[];
  if (platform === 'darwin') {
    cmd = 'open';
    args = [url];
  } else if (platform === 'win32') {
    cmd = 'cmd';
    args = ['/c', 'start', '""', url];
  } else {
    cmd = 'xdg-open';
    args = [url];
  }
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).unref();
  } catch {
    /* noop */
  }
}

export async function runDashboardLogin(opts: LoginOptions = {}): Promise<LoginResult> {
  // Phase 4 — unified env name. AUTOPILOT_PUBLIC_BASE_URL is canonical
  // (matches apps/web). AUTOPILOT_DASHBOARD_BASE_URL is the deprecated
  // Phase 2.3 alias and triggers a one-time warning.
  const baseUrl = opts.baseUrl ?? getAutopilotBaseUrl();
  const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
  const portStart = opts.portRangeStart ?? PORT_START;
  const portEnd = portStart + (PORT_END - PORT_START);

  const nonce = randomBytes(NONCE_BYTES).toString('hex');
  const { server, port } = await bindFirstPort(portStart, portEnd);

  const cb = `http://127.0.0.1:${port}/cli-callback`;
  const authUrl = `${baseUrl}/cli-auth?cb=${encodeURIComponent(cb)}&nonce=${encodeURIComponent(nonce)}`;

  let resolved: ((v: LoginResult) => void) | null = null;
  let rejected: ((err: Error) => void) | null = null;
  const result = new Promise<LoginResult>((resolve, reject) => {
    resolved = resolve;
    rejected = reject;
  });

  let settled = false;
  const settle = (fn: () => void): void => {
    if (settled) return;
    settled = true;
    fn();
    // Force-close active connections so the event loop drains immediately
    // (matters for tests; production callers exit the process anyway).
    try { (server as Server & { closeAllConnections?: () => void }).closeAllConnections?.(); } catch { /* noop */ }
    server.close();
  };

  const timer = setTimeout(() => {
    settle(() => rejected?.(new Error(`login timed out after ${timeoutMs}ms`)));
  }, timeoutMs);
  // Don't keep the event loop alive solely for the timeout watchdog —
  // matters in tests when the suite has finished but timers linger.
  timer.unref?.();

  if (opts.signal) {
    if (opts.signal.aborted) {
      clearTimeout(timer);
      server.close();
      throw new Error('aborted');
    }
    opts.signal.addEventListener('abort', () => {
      clearTimeout(timer);
      settle(() => rejected?.(new Error('aborted')));
    }, { once: true });
  }

  // Phase 4 CORS — the /cli-auth page POSTs to this loopback with
  // mode: 'cors'. Without OPTIONS preflight + Access-Control-Allow-Origin
  // matching the configured public base URL, the browser fetch fails
  // silently (opaque response) and the user sees "loopback failed" with
  // no signal here.
  const allowedOrigin = baseUrl;

  server.on('request', (req: IncomingMessage, res: ServerResponse) => {
    void (async (): Promise<void> => {
      try {
        // OPTIONS preflight — no body, no auth, just CORS headers.
        if (req.method === 'OPTIONS') {
          res.writeHead(204, {
            'Access-Control-Allow-Origin': allowedOrigin,
            'Access-Control-Allow-Methods': 'POST, OPTIONS',
            'Access-Control-Allow-Headers': 'content-type',
            'Access-Control-Max-Age': '60',
            Vary: 'Origin',
          });
          res.end();
          return;
        }
        if (req.method !== 'POST' || req.url !== '/cli-callback') {
          res.statusCode = 404;
          res.end('not found');
          return;
        }
        const ct = (req.headers['content-type'] ?? '').toString();
        if (!ct.includes('application/json')) {
          res.statusCode = 415;
          res.end('unsupported media type');
          return;
        }
        const body = await readJsonBody(req);

        // Codex NOTE — CORS header on POST response so the browser can
        // read the JSON body under mode: 'cors'.
        const corsHeaders: Record<string, string> = {
          'Access-Control-Allow-Origin': allowedOrigin,
          Vary: 'Origin',
        };

        if (typeof body.nonce !== 'string' || !nonceMatch(nonce, body.nonce)) {
          res.writeHead(403, { ...corsHeaders, 'content-type': 'text/plain' });
          res.end('nonce mismatch');
          clearTimeout(timer);
          settle(() => rejected?.(new Error('nonce mismatch')));
          return;
        }
        if (typeof body.apiKey !== 'string' || !KEY_RE.test(body.apiKey)) {
          res.writeHead(422, { ...corsHeaders, 'content-type': 'text/plain' });
          res.end('invalid apiKey');
          clearTimeout(timer);
          settle(() => rejected?.(new Error('invalid apiKey from callback')));
          return;
        }
        if (typeof body.fingerprint !== 'string' || !/^clp_[0-9a-f]{12}$/.test(body.fingerprint)) {
          res.writeHead(422, { ...corsHeaders, 'content-type': 'text/plain' });
          res.end('invalid fingerprint');
          clearTimeout(timer);
          settle(() => rejected?.(new Error('invalid fingerprint from callback')));
          return;
        }
        if (typeof body.accountEmail !== 'string') {
          res.writeHead(422, { ...corsHeaders, 'content-type': 'text/plain' });
          res.end('invalid accountEmail');
          clearTimeout(timer);
          settle(() => rejected?.(new Error('invalid accountEmail from callback')));
          return;
        }

        const cfg: DashboardConfig = {
          schemaVersion: 1,
          apiKey: body.apiKey,
          fingerprint: body.fingerprint,
          accountEmail: body.accountEmail,
          loggedInAt: new Date().toISOString(),
          lastUploadAt: null,
        };
        await writeConfig(cfg);

        res.writeHead(200, {
          ...corsHeaders,
          'content-type': 'application/json',
        });
        res.end(JSON.stringify({ ok: true, nonce }));

        clearTimeout(timer);
        settle(() => resolved?.({ config: cfg, port }));
      } catch (err) {
        res.statusCode = 500;
        res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
        res.end((err as Error).message ?? 'error');
        clearTimeout(timer);
        settle(() => rejected?.(err instanceof Error ? err : new Error(String(err))));
      }
    })();
  });

  // Print + open after the server is listening.
  if (!opts.silent) {
    process.stdout.write(`[autopilot] sign in here: ${authUrl}\n`);
    process.stdout.write(`            (a browser window will open; loopback callback on port ${port})\n`);
  }
  if (opts.openBrowser) {
    await opts.openBrowser(authUrl);
  } else {
    openInBrowser(authUrl);
  }

  return result;
}
