import * as http from 'node:http';
import * as net from 'node:net';
import type { GuardrailConfig } from '../config/types.ts';
import type { Finding } from '../findings/types.ts';

export interface WorkerServerOptions {
  cwd: string;
  onReview: (files: string[], config: GuardrailConfig) => Promise<{ findings: Finding[]; usage?: { costUSD: number } }>;
}

export interface WorkerServer {
  port: number;
  close(): Promise<void>;
}

async function getRandomPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address() as net.AddressInfo;
      srv.close(() => resolve(addr.port));
    });
    srv.on('error', reject);
  });
}

export async function startWorkerServer(opts: WorkerServerOptions): Promise<WorkerServer> {
  const port = await getRandomPort();
  let jobsProcessed = 0;
  const startedAt = Date.now();

  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        pid: process.pid, port, jobsProcessed,
        queueDepth: 0,
        uptimeMs: Date.now() - startedAt,
      }));
      return;
    }

    if (req.method === 'POST' && req.url === '/stop') {
      res.writeHead(200);
      res.end('{"ok":true}');
      setImmediate(() => server.close());
      return;
    }

    if (req.method === 'POST' && req.url === '/review') {
      let body = '';
      req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      req.on('end', async () => {
        try {
          const { files, config } = JSON.parse(body) as { files: string[]; config: GuardrailConfig };
          const result = await opts.onReview(files, config);
          jobsProcessed++;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: String(err) }));
        }
      });
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(port, '127.0.0.1', () => resolve());
    server.on('error', reject);
  });

  return {
    port,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  };
}
